/**
 * Trace miner — PRD-016a (Wave 2, IMPLEMENTED). The LOCAL half of the skillify loop.
 *
 * 016a owns mining + gating; 016b writes; 016c propagates. This module:
 *   - TRIGGERS a mine from the per-project stop-counter (reuse `turn-counters.ts`'s
 *     `TurnCounters` / `tryStopCounterTrigger`: the counter reaching
 *     `HONEYCOMB_SKILLIFY_EVERY_N_TURNS` resets + runs the worker) AND unconditionally
 *     at session-end (a-AC-3 / D-1 / FR-2);
 *   - takes a per-project WORKER LOCK so two concurrent runs for the same project never
 *     both spawn — the second is SUPPRESSED (a-AC-5 / D-4 / FR-3) — and ALWAYS releases
 *     it in a `finally`, even on a gate timeout (a-AC-6 / FR-3);
 *   - FETCHES the last 10 in-scope sessions PAST the watermark, EXCLUDING the triggering
 *     session (not yet fully captured), through the daemon's `StorageQuery` — the team
 *     filter (`author IN (<team>)`) escaped via `sqlStr`/`sLiteral` because DeepLake has
 *     no parameterized queries (a-AC-1 / a-AC-4 / D-2 / FR-4 / FR-5 / FR-6);
 *   - EXTRACTS `MinedPair`s, dropping tool-calls + thinking, capping each pair at 2000
 *     chars and the batch at 40000 (a-AC-1 / D-2 / FR-7 / FR-8);
 *   - runs the GATE behind the {@link GateCli} seam — a host-CLI shell-out, NO API key,
 *     a `spawn` with an args ARRAY (never a shell string, so a mined transcript can't
 *     command-inject), a 120s timeout → abort-no-verdict (a-AC-2 / a-AC-6 / D-3 / FR-9 /
 *     FR-10). It returns EXACTLY one of KEEP / MERGE / SKIP; KEEP fires only for a
 *     non-obvious pattern recurring across ≥3 exchanges, not already covered.
 *
 * 016a PRODUCES a {@link GateVerdict} over the mined {@link MinedPair}s and CONSUMES
 * 016b's write/read path: the daemon worker hands the verdict + mined session ids to
 * `writeSkill` and the oldest mined date to the watermark store. 016a does NOT
 * re-implement the append-only row (CONVENTIONS §8).
 *
 * ── Daemon-only storage (CONVENTIONS §4) ─────────────────────────────────────
 * This module lives under `src/daemon/`, so it reaches `sessions` through the daemon's
 * own `StorageQuery` ({@link createSessionFetcher}) — never a re-opened DeepLake
 * connection. The hook half (the stop-counter signal) is a thin client that signals the
 * daemon over port 3850; the worker that calls {@link mine} runs INSIDE the daemon.
 *
 * ── SQL safety (CONVENTIONS §6) ──────────────────────────────────────────────
 * Every identifier routes through `sqlIdent`; every value through `sLiteral` (→ `sqlStr`).
 * The team filter builds `author IN ('a', 'b')` from values each escaped by `sLiteral`,
 * so a hostile author string can never break out of the literal. `npm run audit:sql`
 * scans `src/daemon`.
 */

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";

import { honeycombStateDir, legacyHoneycombDir } from "../../../shared/fleet-root.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { sqlIdent, sLiteral } from "../../storage/sql.js";
import { type GateCli, type GateDecision, type GateVerdict, GATE_VERDICTS, type MinedPair } from "./contracts.js";
import { DEFAULT_SKILLIFY_EVERY_TURNS, type TurnCounters, tryStopCounterTrigger } from "../capture/turn-counters.js";

// ════════════════════════════════════════════════════════════════════════════
// Constants — the extraction caps + the gate timeout (D-2 / D-3 / FR-8 / FR-10).
// ════════════════════════════════════════════════════════════════════════════

/** How many in-scope sessions a mine fetches (the last N, most-recent first — FR-4). */
export const FETCH_SESSION_LIMIT = 10;
/** Max characters per extracted pair (D-2 / FR-8). A longer pair is truncated. */
export const MAX_PAIR_CHARS = 2_000;
/** Max characters across the whole rendered batch (D-2 / FR-8). Extra pairs are dropped. */
export const MAX_BATCH_CHARS = 40_000;
/** The gate-CLI timeout in ms (a-AC-6 / D-3 / FR-10). Exceeding it ABORTS with no verdict. */
export const GATE_TIMEOUT_MS = 120_000;
/** KEEP requires the pattern to recur across at least this many exchanges (a-AC-2 / FR-9). */
export const KEEP_MIN_EXCHANGES = 3;

/**
 * The env var that tunes the stop-counter cadence (FR-2 / D-1). Read at trigger time so
 * a deploy can change it without a rebuild. Falls back to {@link DEFAULT_SKILLIFY_EVERY_TURNS}.
 */
export const SKILLIFY_EVERY_N_TURNS_ENV = "HONEYCOMB_SKILLIFY_EVERY_N_TURNS" as const;

/** The `sessions` table the miner reads (catalog name). */
export const SESSIONS_TABLE = "sessions" as const;

// ════════════════════════════════════════════════════════════════════════════
// MineScope / MineOutcome — the inputs + the result the worker hands to 016b.
// ════════════════════════════════════════════════════════════════════════════

/** The scope a mine runs under (the project + the team author list for the filter). */
export interface MineScope {
	/** The project key whose sessions are mined + whose watermark advances. */
	readonly projectKey: string;
	/** The trigger session id to EXCLUDE from the pool (a-AC-1 / FR-6). */
	readonly triggerSessionId: string;
	/** The team author list for the `author IN (<team>)` filter (a-AC-4 / FR-5). */
	readonly teamAuthors?: readonly string[];
}

/** The outcome of a mine: the verdict + the mined session ids + the oldest date. */
export interface MineOutcome {
	/** The gate's verdict over the mined batch (KEEP | MERGE | SKIP). */
	readonly verdict: GateVerdict;
	/** The mined pairs the verdict was computed over. */
	readonly pairs: readonly MinedPair[];
	/** The session ids mined (→ `source_sessions` provenance + watermark advance). */
	readonly minedSessionIds: readonly string[];
}

// ════════════════════════════════════════════════════════════════════════════
// SessionFetcher SEAM — the scoped read of `sessions` (a test injects fake rows).
// ════════════════════════════════════════════════════════════════════════════

/** One fetched session row's raw fields the miner needs (a subset of `sessions`). */
export interface SessionRow {
	/** The conversation grouping key (`path`) — one logical session. */
	readonly path: string;
	/** The harness session id (provenance). */
	readonly sessionId: string;
	/** The JSONB `message` envelope `{ event, metadata }`, raw (string or parsed). */
	readonly message: unknown;
	/** The author (engine `author`/`agent_id`) — the team filter matches on this. */
	readonly author: string;
	/** The row's ISO creation date — pairs order by this; the watermark advances to oldest. */
	readonly creationDate: string;
}

/**
 * The session-fetch seam (FR-4 / a-AC-1 / a-AC-4 / a-AC-6). Fetches the last
 * {@link FETCH_SESSION_LIMIT} in-scope session rows PAST the watermark, EXCLUDING the
 * triggering session, ordered most-recent first. The real impl
 * ({@link createSessionFetcher}) builds the scoped, team-filtered, watermark-bounded
 * SELECT and dispatches through the daemon's `StorageQuery`; a test injects fake rows.
 */
export interface SessionFetcher {
	/** Fetch candidate session rows for a mine (most-recent first, trigger excluded). */
	fetch(scope: MineScope, watermark: string | null): Promise<readonly SessionRow[]>;
}

/**
 * Build the production {@link SessionFetcher} over the daemon's `StorageQuery` (CONVENTIONS
 * §4). Every identifier routes through `sqlIdent` and every value through `sLiteral`
 * (→ `sqlStr`), so the team filter `author IN ('a', 'b')` and the watermark/exclusion
 * predicates can never be injected. Reads are scoped (org/workspace) so a mine stays
 * inside its tenant.
 *
 * The query:
 *   - `WHERE creation_date > '<watermark>'`  — past the watermark (FR-6). Omitted when
 *     the watermark is null (a first run sees everything).
 *   - `AND id NOT LIKE 'sess-<triggerSessionId>-%'` — exclude the in-flight session
 *     (FR-6). The capture handler ids rows `sess-<sessionId>-<ts>-<rand>`, so the
 *     triggering session's rows share that id prefix; we exclude by the prefix the
 *     session id produces. We ALSO post-filter by the parsed metadata session id so a
 *     differently-shaped id never leaks the trigger session through.
 *   - `AND author IN (<team>)` — the team filter, each value via `sLiteral` (FR-5). Only
 *     applied when a non-empty team list is given (scope `team`); scope `me` passes no
 *     team list and the filter is omitted (the caller restricts by author elsewhere).
 *   - `ORDER BY creation_date DESC LIMIT <10 * a fan-out>` — most-recent first. We over-
 *     fetch rows (a session is many rows) then group to {@link FETCH_SESSION_LIMIT}
 *     distinct sessions in {@link extractPairs}.
 */
export function createSessionFetcher(storage: StorageQuery, scope: QueryScope, rowFanout = 200): SessionFetcher {
	return {
		async fetch(mine: MineScope, watermark: string | null): Promise<readonly SessionRow[]> {
			const tbl = sqlIdent(SESSIONS_TABLE);
			const dateCol = sqlIdent("creation_date");
			const idCol = sqlIdent("id");
			const authorCol = sqlIdent("author");

			// Each predicate is built from already-escaped fragments (identifiers via
			// `sqlIdent`, values via `sLiteral`), so the joined clause is itself
			// pre-escaped. The variable is suffixed `Clauses` so the audit gate recognizes
			// it as a built fragment, not a raw value.
			const conjuncts: string[] = [];
			if (watermark !== null && watermark !== "") {
				conjuncts.push(`${dateCol} > ${sLiteral(watermark)}`);
			}
			// Exclude the in-flight triggering session by its row-id prefix (FR-6). The
			// capture handler ids rows `sess-<sessionId>-<ts>-<rand>`; `NOT LIKE` on the
			// prefix drops them. The value is escaped via sLiteral; the `%` is a literal
			// wildcard we add intentionally (not user data).
			const triggerPrefix = `sess-${mine.triggerSessionId}-%`;
			conjuncts.push(`${idCol} NOT LIKE ${sLiteral(triggerPrefix)}`);

			const team = (mine.teamAuthors ?? []).filter((a) => a !== "");
			if (team.length > 0) {
				// Each author escaped via `sLiteral` (→ `sqlStr`) — a hostile author string
				// can never break out of the literal (a-AC-4 / FR-5).
				const inListSql = team.map((a) => sLiteral(a)).join(", ");
				conjuncts.push(`${authorCol} IN (${inListSql})`);
			}

			const whereClauses = conjuncts.join(" AND ");
			const whereSql = conjuncts.length > 0 ? `WHERE ${whereClauses} ` : "";
			const limit = Math.max(1, Math.trunc(rowFanout));
			const sql = `SELECT * FROM "${tbl}" ` + whereSql + `ORDER BY ${dateCol} DESC ` + `LIMIT ${limit}`;

			const res = await storage.query(sql, scope);
			if (!isOk(res)) return [];
			return res.rows.map(rowToSessionRow).filter((r): r is SessionRow => r !== null);
		},
	};
}

/** Map a raw `sessions` storage row to the {@link SessionRow} the miner needs. */
function rowToSessionRow(row: StorageRow): SessionRow | null {
	const str = (k: string): string => (typeof row[k] === "string" ? (row[k] as string) : "");
	const path = str("path");
	if (path === "") return null;
	return {
		path,
		sessionId: parseSessionId(row.message) ?? path,
		message: row.message,
		author: str("author"),
		creationDate: str("creation_date"),
	};
}

// ════════════════════════════════════════════════════════════════════════════
// extractPairs — fetch → group → pair → drop tool/thinking → cap (a-AC-1 / FR-7/8).
// ════════════════════════════════════════════════════════════════════════════

/** The verbatim capture envelope shape (`{ event, metadata }`) the miner decodes. */
interface CaptureEnvelope {
	readonly event?: {
		readonly kind?: string;
		readonly text?: string;
	};
	readonly metadata?: {
		readonly sessionId?: string;
		readonly path?: string;
	};
}

/** Parse a raw JSONB `message` (string or already-parsed object) into the envelope. */
function parseEnvelope(message: unknown): CaptureEnvelope | null {
	if (message === null || message === undefined) return null;
	if (typeof message === "string") {
		try {
			return JSON.parse(message) as CaptureEnvelope;
		} catch {
			return null;
		}
	}
	if (typeof message === "object") return message as CaptureEnvelope;
	return null;
}

/** The harness session id from a row's envelope, or null when undecodable. */
function parseSessionId(message: unknown): string | null {
	const env = parseEnvelope(message);
	const sid = env?.metadata?.sessionId;
	return typeof sid === "string" && sid !== "" ? sid : null;
}

/**
 * Strip thinking blocks from a prompt/answer body (FR-7). The captured event text is
 * already free of tool calls (those are their own `tool_call` events we drop), but an
 * assistant message can embed `<thinking>…</thinking>` reasoning that must not become
 * skill material. Remove every such block (case-insensitive, across newlines).
 */
function stripThinking(text: string): string {
	return text
		.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
}

/** The token a redacted secret is replaced with (mirrors `secrets/exec.ts`'s `REDACTED`). */
export const REDACTED = "[REDACTED]" as const;

/**
 * High-confidence secret/credential shapes scrubbed from mined text at the mine boundary
 * (SECURITY — security-worker-bee, PRD-016). Skillify mines RAW session transcripts, which
 * routinely contain a token, key, or password the user pasted. The gate model is asked for
 * precision-over-recall, but its omission of a secret is a SOFT, non-deterministic guarantee:
 * a KEEP/MERGE body the model echoes back is written VERBATIM into the SKILL.md + the
 * append-only `skills` row, and a cross-author merge promotes scope `me`→`team` so a pull
 * PROPAGATES that body to every teammate. A pattern scrub here is the DETERMINISTIC floor that
 * keeps a leaked credential from ever reaching the gate prompt, the persisted body, or the
 * team. Each pattern is deliberately specific (provider-prefixed keys, JWTs, bearer headers,
 * PEM blocks, `key=value` secret assignments) to keep false positives low — it scrubs what is
 * unambiguously a secret, not every long string.
 */
const SECRET_PATTERNS: readonly RegExp[] = [
	// PEM private-key / certificate blocks (multi-line) — the whole block becomes one token.
	/-----BEGIN[ A-Z]*PRIVATE KEY-----[\s\S]*?-----END[ A-Z]*PRIVATE KEY-----/g,
	// JWTs (three base64url segments) — Activeloop sends the auth token as a Bearer JWT.
	/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
	// Provider-prefixed API keys: OpenAI/Anthropic (sk-/sk-ant-), GitHub (ghp_/gho_/ghs_/
	// ghr_/github_pat_), Slack (xox[abprs]-), Google (AIza…), AWS access-key ids (AKIA…),
	// Activeloop (apdl_/hivemind_/hm_).
	/\bsk-(?:ant-)?[A-Za-z0-9_-]{16,}\b/g,
	/\b(?:ghp|gho|ghs|ghr)_[A-Za-z0-9]{20,}\b/g,
	/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
	/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g,
	/\bAIza[A-Za-z0-9_-]{20,}\b/g,
	/\bAKIA[A-Z0-9]{16}\b/g,
	/\b(?:apdl|hivemind|hm)_[A-Za-z0-9_-]{16,}\b/g,
	// `Authorization: Bearer <token>` / `Authorization: Basic <token>` headers.
	/\b(Authorization\s*:\s*)(?:Bearer|Basic)\s+[A-Za-z0-9._\-+/=]{8,}/gi,
	// `secret`/`token`/`password`/`api_key` = "<value>" style assignments (the value only).
	/\b((?:api[_-]?key|secret|token|password|passwd|access[_-]?token|client[_-]?secret)\s*[=:]\s*)["']?[A-Za-z0-9._\-+/=:@]{8,}["']?/gi,
];

/**
 * Scrub high-confidence secrets from a mined body BEFORE it can reach the gate, the
 * SKILL.md, or the team (SECURITY — PRD-016). Defense-in-depth: the gate model is supposed
 * to skip secrets, but this is the deterministic floor that does not depend on the model.
 * Patterns with a captured label group (`Authorization:` / `token=`) preserve the label and
 * replace only the credential; the rest replace the whole match with {@link REDACTED}.
 */
export function redactSecrets(text: string): string {
	let out = text;
	for (const re of SECRET_PATTERNS) {
		out = out.replace(re, (_match, label?: string) => (typeof label === "string" ? `${label}${REDACTED}` : REDACTED));
	}
	return out;
}

/** Strip thinking blocks AND scrub secrets (the single funnel every mined body passes). */
function sanitizeBody(text: string): string {
	return redactSecrets(stripThinking(text));
}

/** Truncate a body to {@link MAX_PAIR_CHARS}, marking the cut so the gate sees it (FR-8). */
function capPair(text: string): string {
	if (text.length <= MAX_PAIR_CHARS) return text;
	return `${text.slice(0, MAX_PAIR_CHARS)}…[truncated]`;
}

/**
 * Extract {@link MinedPair}s from fetched session rows (a-AC-1 / FR-7 / FR-8). For each of
 * the last {@link FETCH_SESSION_LIMIT} distinct sessions (most-recent first), order its
 * rows by `creation_date`, pair each `user_message` with the agent's NEXT
 * `assistant_message`, DROP `tool_call` events + thinking, cap each pair at
 * {@link MAX_PAIR_CHARS}, and stop once the batch reaches {@link MAX_BATCH_CHARS}.
 *
 * Pure over the fetched rows — the fetch (scope / team filter / watermark / trigger
 * exclusion) is the {@link SessionFetcher}'s job, so this function is deterministic and
 * fully unit-testable with fake rows.
 */
export function extractPairsFromRows(rows: readonly SessionRow[]): readonly MinedPair[] {
	// Group rows by session path, preserving most-recent-first session order.
	const bySession = new Map<string, SessionRow[]>();
	for (const row of rows) {
		const key = row.path;
		const list = bySession.get(key);
		if (list === undefined) bySession.set(key, [row]);
		else list.push(row);
	}

	const pairs: MinedPair[] = [];
	let budget = MAX_BATCH_CHARS;
	let sessionsSeen = 0;

	for (const [, sessionRows] of bySession) {
		if (sessionsSeen >= FETCH_SESSION_LIMIT) break;
		sessionsSeen += 1;

		// Order this session's rows oldest-first so a prompt pairs with the answer AFTER it.
		const ordered = [...sessionRows].sort((a, b) => a.creationDate.localeCompare(b.creationDate));

		let pendingPrompt: string | null = null;
		let promptSessionId = "";
		let promptDate = "";

		for (const row of ordered) {
			const env = parseEnvelope(row.message);
			const kind = env?.event?.kind;
			const text = typeof env?.event?.text === "string" ? env.event.text : "";

			if (kind === "user_message") {
				// A new prompt starts a fresh pending pair (a prompt with no answer is dropped).
				// sanitizeBody strips thinking AND scrubs secrets at the mine boundary so a pasted
				// credential never reaches the gate / SKILL.md / team (SECURITY, PRD-016).
				pendingPrompt = sanitizeBody(text);
				promptSessionId = row.sessionId;
				promptDate = row.creationDate;
				continue;
			}
			if (kind === "assistant_message") {
				if (pendingPrompt === null) continue; // an answer with no preceding prompt → skip.
				const prompt = capPair(pendingPrompt);
				const answer = capPair(sanitizeBody(text));
				pendingPrompt = null;
				if (prompt === "" && answer === "") continue;

				const cost = prompt.length + answer.length;
				if (cost > budget) return pairs; // the batch cap is reached (FR-8) — stop.
				budget -= cost;
				pairs.push({
					sessionId: promptSessionId,
					sessionDate: promptDate,
					prompt,
					answer,
				});
				continue;
			}
			// kind === "tool_call" (or anything else) → DROPPED (FR-7).
		}
	}

	return pairs;
}

/**
 * Fetch + extract in one step (a-AC-1). Reads the candidate rows through the
 * {@link SessionFetcher} (scope / team filter / watermark / trigger exclusion all live
 * there) and extracts the bounded pair batch. Async because the fetch is a daemon
 * storage round-trip; the extraction itself is pure ({@link extractPairsFromRows}).
 */
export async function extractPairs(
	fetcher: SessionFetcher,
	scope: MineScope,
	watermark: string | null,
): Promise<readonly MinedPair[]> {
	const rows = await fetcher.fetch(scope, watermark);
	return extractPairsFromRows(rows);
}

// ════════════════════════════════════════════════════════════════════════════
// runGate — assemble the prompt, shell out, enforce the 120s timeout (a-AC-2/6).
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build the gate prompt from the mined pairs (FR-9). Renders each pair as a labelled
 * PROMPT/ANSWER block (already capped by {@link extractPairs}) and instructs the model to
 * return EXACTLY one of `KEEP`, `MERGE`, or `SKIP` with a precision-over-recall stance: a
 * KEEP only for a NON-OBVIOUS pattern recurring across ≥{@link KEEP_MIN_EXCHANGES}
 * exchanges that is NOT already covered. The render is deterministic so the gate prompt
 * is reproducible in tests.
 */
export function buildGatePrompt(pairs: readonly MinedPair[]): string {
	const header =
		"You are a skill-mining gate. Decide whether the exchanges below contain a reusable, " +
		"non-obvious workflow worth crystallizing into a SKILL.md. Precision over recall: a " +
		"false skill erodes trust. Return EXACTLY one verdict on the first line:\n" +
		"  KEEP <name> <body>      — a NON-OBVIOUS pattern recurring across ≥3 exchanges, not already covered\n" +
		"  MERGE <existing-name> <merged-body> — it refines an existing skill\n" +
		"  SKIP <reason>           — nothing worth crystallizing\n\n" +
		"Exchanges:\n";
	const body = pairs
		.map((p, i) => `--- exchange ${i + 1} (session ${p.sessionId}) ---\nPROMPT:\n${p.prompt}\nANSWER:\n${p.answer}`)
		.join("\n\n");
	return `${header}${body}\n`;
}

/**
 * Run the gate over a mined batch and return EXACTLY one of KEEP | MERGE | SKIP
 * (a-AC-2 / a-AC-6 / D-3 / FR-9 / FR-10).
 *
 *   - Assembles the gate prompt ({@link buildGatePrompt}).
 *   - Shells out via the {@link GateCli} seam (no API key — the real impl
 *     {@link createHostCliGate} spawns the host CLI with an args array, shell:false).
 *   - Enforces the timeout: if the gate does not resolve within `timeoutMs`, the run is
 *     ABORTED — `runGate` rejects, so {@link mine} writes NO verdict and the caller's
 *     `finally` releases the lock (a-AC-6).
 *   - VALIDATES the returned decision is one of {@link GATE_VERDICTS}; an unparseable /
 *     out-of-set verdict is treated CONSERVATIVELY as SKIP (never mine on garbage).
 *   - Enforces the KEEP floor: a KEEP whose batch does NOT recur across
 *     ≥{@link KEEP_MIN_EXCHANGES} exchanges is DOWNGRADED to SKIP (a-AC-2 / FR-9). The
 *     gate model is asked to honour this, but the floor is also enforced here so a
 *     too-eager KEEP can never slip a thin pattern through.
 *
 * `timeoutMs` is injectable so a test drives the 120s-timeout path fast; production uses
 * {@link GATE_TIMEOUT_MS}.
 */
export async function runGate(
	gate: GateCli,
	pairs: readonly MinedPair[],
	timeoutMs: number = GATE_TIMEOUT_MS,
): Promise<GateVerdict> {
	const prompt = buildGatePrompt(pairs);
	const raw = await withTimeout(gate.run(prompt), timeoutMs, "skillify gate CLI exceeded the timeout");
	return normalizeVerdict(raw, pairs);
}

/**
 * Coerce a gate result into a valid {@link GateVerdict} (a-AC-2). An out-of-set decision
 * → SKIP (conservative). A KEEP that does not clear the ≥3-exchange recurrence floor →
 * SKIP. KEEP / MERGE keep their skill payload; SKIP drops it.
 */
export function normalizeVerdict(verdict: GateVerdict, pairs: readonly MinedPair[]): GateVerdict {
	const decision: GateDecision = (GATE_VERDICTS as readonly string[]).includes(verdict.decision)
		? verdict.decision
		: "SKIP";

	if (decision === "SKIP") return { decision: "SKIP" };

	if (decision === "KEEP" && !recursEnough(pairs)) {
		// The KEEP floor (FR-9): a non-recurring pattern is not skill-worthy → SKIP.
		return { decision: "SKIP" };
	}
	return { ...verdict, decision };
}

/**
 * Whether the batch recurs across at least {@link KEEP_MIN_EXCHANGES} exchanges (FR-9).
 * The gate's qualitative "non-obvious + not-already-covered" judgement stays with the
 * model; the QUANTITATIVE recurrence floor (a pattern seen in ≥3 exchanges) is enforced
 * here so a KEEP backed by fewer than three exchanges is never honoured.
 */
export function recursEnough(pairs: readonly MinedPair[]): boolean {
	return pairs.length >= KEEP_MIN_EXCHANGES;
}

// ════════════════════════════════════════════════════════════════════════════
// createHostCliGate — the real GateCli: spawn the host CLI, no shell, no API key.
// ════════════════════════════════════════════════════════════════════════════

/** The host-CLI invocation matrix (FR-10 / impl-note). Command + args ARRAY — no shell. */
export interface HostCliSpec {
	/** The executable to spawn (e.g. `claude`, `codex`, `cursor-agent`). */
	readonly command: string;
	/** The argument array passed verbatim — NEVER a shell string (no-injection). */
	readonly args: readonly string[];
}

/** The spawn seam so a test asserts the args array + that no shell metachar executes. */
export interface GateSpawner {
	/**
	 * Spawn the host CLI WITHOUT a shell, feed `prompt` on stdin, resolve with stdout.
	 * Rejects on a non-zero exit / spawn error. `shell:false` + an args array is the
	 * no-injection guarantee (CONVENTIONS §7).
	 */
	run(spec: HostCliSpec, prompt: string, timeoutMs: number): Promise<string>;
}

/**
 * The default spawner: `child_process.spawn` with `shell:false` (CONVENTIONS §7),
 * mirroring `secrets/exec.ts`'s no-shell rule. The prompt is written to the child's
 * stdin (never interpolated into the args), so a mined transcript can never become a
 * command — it is inert input. The timeout kills a runaway (SIGTERM) so the gate can
 * never outlive its deadline.
 */
export const systemGateSpawner: GateSpawner = {
	run(spec: HostCliSpec, prompt: string, timeoutMs: number): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			// CRITICAL (no-shell): command + args ARRAY, `shell:false`. Each arg is passed
			// verbatim and is NEVER re-parsed by `/bin/sh`, so a hostile arg is inert.
			const child = spawn(spec.command, [...spec.args], { shell: false, windowsHide: true });
			let stdout = "";
			let settled = false;
			const finish = (fn: () => void): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				fn();
			};
			const timer = setTimeout(() => {
				try {
					child.kill("SIGTERM");
				} catch {
					/* already dead */
				}
				finish(() => reject(new Error("skillify gate CLI exceeded the timeout")));
			}, timeoutMs);

			child.stdout?.on("data", (d: Buffer) => {
				stdout += d.toString("utf8");
			});
			child.on("error", (err: Error) => finish(() => reject(err)));
			child.on("close", (code: number | null) => {
				if (code === 0) finish(() => resolve(stdout));
				else finish(() => reject(new Error(`skillify gate CLI exited with code ${code ?? "null"}`)));
			});

			// Feed the prompt as inert stdin — never an arg, never a shell token.
			try {
				child.stdin?.write(prompt);
				child.stdin?.end();
			} catch {
				/* the child may have died; the close/error handler resolves */
			}
		});
	},
};

/**
 * Build the real {@link GateCli} (a-AC-2 / FR-10). It spawns the host agent's own CLI
 * (which already holds the user's auth — NO API key is held here) with an args array and
 * `shell:false` via the {@link GateSpawner} seam, then parses the verdict from stdout. The
 * spawner + parser are injectable so a test drives the no-shell + parse path
 * deterministically without a real CLI.
 */
export function createHostCliGate(
	spec: HostCliSpec,
	spawner: GateSpawner = systemGateSpawner,
	timeoutMs: number = GATE_TIMEOUT_MS,
): GateCli {
	return {
		async run(prompt: string): Promise<GateVerdict> {
			const stdout = await spawner.run(spec, prompt, timeoutMs);
			return parseVerdictStdout(stdout);
		},
	};
}

/**
 * Parse a host-CLI stdout into a {@link GateVerdict} (FR-10). The gate is instructed to
 * emit `KEEP <name> <body>` / `MERGE <existing-name> <merged-body>` / `SKIP <reason>` on
 * the first line. We read the FIRST recognised verdict token; an unrecognised output is a
 * conservative SKIP (never mine on garbage). The rest of the line/body is the skill body.
 */
export function parseVerdictStdout(stdout: string): GateVerdict {
	const trimmed = stdout.trim();
	const firstSpace = trimmed.search(/\s/);
	const token = (firstSpace === -1 ? trimmed : trimmed.slice(0, firstSpace)).toUpperCase();
	const rest = firstSpace === -1 ? "" : trimmed.slice(firstSpace + 1).trim();

	if (token === "KEEP") {
		const { name, body } = splitNameBody(rest);
		return { decision: "KEEP", name, body };
	}
	if (token === "MERGE") {
		const { name, body } = splitNameBody(rest);
		return { decision: "MERGE", target: name, name, body };
	}
	return { decision: "SKIP" };
}

/** Split `<name> <body>` — the first whitespace-delimited token is the name. */
function splitNameBody(rest: string): { name: string; body: string } {
	const sp = rest.search(/\s/);
	if (sp === -1) return { name: rest, body: "" };
	return { name: rest.slice(0, sp), body: rest.slice(sp + 1).trim() };
}

// ════════════════════════════════════════════════════════════════════════════
// WorkerLock SEAM — the per-project lock (a-AC-5 / D-4 / FR-3).
// ════════════════════════════════════════════════════════════════════════════

/** The result of trying to take the per-project worker lock. */
export interface LockHandle {
	/** Release the lock. Idempotent — safe to call in a `finally` even if already released. */
	release(): void;
}

/**
 * The per-project worker-lock seam (a-AC-5 / FR-3). `acquire` returns a handle on success
 * or `null` when a run is ALREADY in flight for the project — the second trigger is
 * SUPPRESSED. The real impl ({@link createFileWorkerLock}) is an atomic `O_EXCL` lock
 * file; a test injects an in-memory lock.
 */
export interface WorkerLock {
	/** Try to take the lock for a project; `null` when already held (suppress the run). */
	acquire(projectKey: string): LockHandle | null;
}

/** The default per-project lock root in production (`~/.apiary/honeycomb/state/skillify`, PRD-072b). */
export function defaultLockBaseDir(): string {
	return join(honeycombStateDir(), "state", "skillify");
}

/** The legacy lock root (`~/.honeycomb/state/skillify`) checked as a fallback during the window. */
export function legacyLockBaseDir(): string {
	return join(legacyHoneycombDir(), "state", "skillify");
}

/**
 * Build a filesystem {@link WorkerLock} rooted at `baseDir` (D-4 / FR-3). The lock is an
 * atomic `O_EXCL` create of `<baseDir>/<projectKey>/worker.lock`: a SECOND concurrent
 * `acquire` for the same project fails the exclusive create → `null` → the run is
 * SUPPRESSED. `release` removes the lock file (idempotent — a double release is a no-op,
 * which is exactly what the `finally` needs even after a gate timeout). `projectKey` is
 * sanitized into a single path segment so it can never traverse out of the base dir.
 *
 * PRD-072b window fallback: when `legacyBaseDir` is given (production passes the legacy
 * `~/.honeycomb/state/skillify`), a PRE-EXISTING lock file at the legacy path also suppresses the
 * run, so a run left in flight by a not-yet-upgraded daemon is still respected mid-window. New
 * locks are only ever created at `baseDir`; the legacy path is read-only here.
 */
export function createFileWorkerLock(baseDir: string = defaultLockBaseDir(), legacyBaseDir?: string): WorkerLock {
	const fileFor = (projectKey: string): string => join(baseDir, sanitizeSegment(projectKey), "worker.lock");
	return {
		acquire(projectKey: string): LockHandle | null {
			const path = fileFor(projectKey);
			// Legacy-fallback read (PRD-072b): a lock held at the legacy path means a run is in flight
			// under an old daemon — suppress, never double-run. Read-only probe; never created here.
			if (legacyBaseDir !== undefined && existsSync(join(legacyBaseDir, sanitizeSegment(projectKey), "worker.lock"))) {
				return null;
			}
			try {
				mkdirSync(dirname(path), { recursive: true });
				// `wx` = O_CREAT | O_EXCL: fails if the file exists → a run is in flight.
				const fd = openSync(path, "wx");
				closeSync(fd);
			} catch {
				// EEXIST (or any failure to take the lock) → the run is already in flight.
				return null;
			}
			let released = false;
			return {
				release(): void {
					if (released) return;
					released = true;
					try {
						rmSync(path, { force: true });
					} catch {
						/* best-effort — a missing lock file is fine */
					}
				},
			};
		},
	};
}

/**
 * Reduce a project key to a SINGLE safe path segment — only `[A-Za-z0-9._-]`, every other
 * char (including `/`, `\`, `..`) becomes `_`. A crafted projectKey can never traverse out
 * of the lock base dir (mirrors `watermark.ts`'s `sanitizeSegment`).
 */
function sanitizeSegment(projectKey: string): string {
	const cleaned = projectKey.replace(/[^A-Za-z0-9._-]/g, "_");
	return cleaned === "" ? "default" : cleaned;
}

// ════════════════════════════════════════════════════════════════════════════
// The trigger — reuse TurnCounters / tryStopCounterTrigger (a-AC-3 / D-1 / FR-2).
// ════════════════════════════════════════════════════════════════════════════

/** Read the configured stop-counter cadence (FR-2). Falls back to the D-1 default. */
export function skillifyEveryNTurns(env: NodeJS.ProcessEnv = process.env): number {
	const raw = env[SKILLIFY_EVERY_N_TURNS_ENV];
	const n = raw === undefined ? NaN : Number(raw);
	return Number.isFinite(n) && n >= 1 ? Math.trunc(n) : DEFAULT_SKILLIFY_EVERY_TURNS;
}

/** What a trigger evaluation decided (a-AC-3). `run` true → the worker should mine. */
export interface TriggerDecision {
	/** Whether the worker should run a mine now. */
	readonly run: boolean;
	/** Why it should (or should not) run — for the worker's diagnostics. */
	readonly reason: "stop_counter" | "session_end" | "below_threshold";
}

/**
 * Evaluate a `Stop`/`SessionEnd` event into a trigger decision (a-AC-3 / D-1 / FR-2),
 * REUSING the existing `TurnCounters` / `tryStopCounterTrigger`:
 *
 *   - On a turn-terminating `Stop`: bump the per-turn counter via
 *     `tryStopCounterTrigger`. When it crosses `HONEYCOMB_SKILLIFY_EVERY_N_TURNS`
 *     (the `TurnCounters` skillify threshold) it returns a cue — the counter has just
 *     RESET (the modulo crossing) and the worker runs (`reason: "stop_counter"`).
 *   - On `SessionEnd` (`sessionEnd: true`): the worker runs UNCONDITIONALLY regardless of
 *     the counter (`reason: "session_end"`).
 *   - Otherwise: below the threshold, no run.
 *
 * The `TurnCounters` MUST be constructed with `skillifyEveryTurns: skillifyEveryNTurns()`
 * so its internal threshold matches the env-configured cadence; this function does not
 * re-implement the counting — it consumes the existing seam verbatim (CONVENTIONS §8).
 */
export function evaluateTrigger(
	counters: TurnCounters,
	sessionId: string,
	path: string,
	opts: { readonly sessionEnd?: boolean } = {},
): TriggerDecision {
	if (opts.sessionEnd === true) {
		return { run: true, reason: "session_end" };
	}
	const cue = tryStopCounterTrigger(counters, sessionId, path);
	if (cue !== null) {
		// The crossing reset the counter (modulo) and signalled skillify → run.
		return { run: true, reason: "stop_counter" };
	}
	return { run: false, reason: "below_threshold" };
}

// ════════════════════════════════════════════════════════════════════════════
// mine — trigger → lock → fetch → extract → gate (lock released in finally).
// ════════════════════════════════════════════════════════════════════════════

/** Construction deps for {@link mine} (everything IO-touching is injected — testable). */
export interface MineDeps {
	/** The scoped session fetcher (real impl over `StorageQuery`; a test fakes it). */
	readonly fetcher: SessionFetcher;
	/** The gate seam (host-CLI shell-out; a test uses `createFakeGateCli`). */
	readonly gate: GateCli;
	/** The per-project worker lock (a-AC-5). Default: the filesystem `O_EXCL` lock. */
	readonly lock: WorkerLock;
	/** The current watermark for the project (null on a first run). */
	readonly watermark: string | null;
	/** The gate timeout (a-AC-6). Injectable so a test drives the abort fast. */
	readonly gateTimeoutMs?: number;
}

/** Why a mine did not produce a verdict (the lock was held, or no pairs to gate). */
export type MineSkippedReason = "lock_held" | "no_pairs";

/** The result of a {@link mine}: either a verdict outcome, or a skip with a reason. */
export type MineResult =
	| { readonly ran: true; readonly outcome: MineOutcome }
	| { readonly ran: false; readonly reason: MineSkippedReason };

/**
 * Run a full mine: LOCK → fetch → extract → gate, releasing the lock in `finally`
 * (a-AC-1 / a-AC-2 / a-AC-5 / a-AC-6).
 *
 *   - Takes the per-project worker lock. If a run is ALREADY in flight, `acquire` returns
 *     `null` and this mine is SUPPRESSED (`{ ran: false, reason: "lock_held" }`) — no
 *     double run (a-AC-5).
 *   - Fetches + extracts the bounded pair batch (a-AC-1). An empty batch needs no gate →
 *     `{ ran: false, reason: "no_pairs" }` (the lock is still released).
 *   - Runs the gate with the 120s timeout (a-AC-2). If the gate TIMES OUT, `runGate`
 *     rejects → this mine throws, NO verdict is produced, and the lock is released in the
 *     `finally` (a-AC-6). The caller (the daemon worker) treats a throw as "no verdict,
 *     do not write."
 *
 * The lock is ALWAYS released in the `finally` — on success, on an empty batch, AND on a
 * gate timeout/throw (a-AC-6).
 */
export async function mine(scope: MineScope, deps: MineDeps): Promise<MineResult> {
	const handle = deps.lock.acquire(scope.projectKey);
	if (handle === null) {
		// A concurrent run is already in flight for this project → suppress (a-AC-5).
		return { ran: false, reason: "lock_held" };
	}
	try {
		const pairs = await extractPairs(deps.fetcher, scope, deps.watermark);
		if (pairs.length === 0) {
			return { ran: false, reason: "no_pairs" };
		}
		// The gate timeout aborts the run (a-AC-6): a reject propagates out of `mine`, no
		// verdict is written, and the lock is released by the `finally` below.
		const verdict = await runGate(deps.gate, pairs, deps.gateTimeoutMs ?? GATE_TIMEOUT_MS);
		const minedSessionIds = uniqueSessionIds(pairs);
		return { ran: true, outcome: { verdict, pairs, minedSessionIds } };
	} finally {
		// ALWAYS release — on success, on an empty batch, AND on a gate timeout/throw (a-AC-6).
		handle.release();
	}
}

/** The distinct mined session ids in order of first appearance (→ provenance + watermark). */
function uniqueSessionIds(pairs: readonly MinedPair[]): readonly string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const p of pairs) {
		if (p.sessionId !== "" && !seen.has(p.sessionId)) {
			seen.add(p.sessionId);
			out.push(p.sessionId);
		}
	}
	return out;
}

// ════════════════════════════════════════════════════════════════════════════
// withTimeout — the injectable abort used by the gate (a-AC-6).
// ════════════════════════════════════════════════════════════════════════════

/**
 * Race a promise against a timeout (a-AC-6). On the deadline the returned promise REJECTS
 * with `message` — the gate run is aborted and NO verdict is produced. The timer is
 * cleared on settle so a resolved gate never leaves a dangling timer. Used by
 * {@link runGate}; injectable `timeoutMs` lets a test drive the abort in milliseconds.
 */
export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		let settled = false;
		const timer = setTimeout(() => {
			if (settled) return;
			settled = true;
			reject(new Error(message));
		}, timeoutMs);
		promise.then(
			(v) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				resolve(v);
			},
			(e: unknown) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				reject(e instanceof Error ? e : new Error(String(e)));
			},
		);
	});
}
