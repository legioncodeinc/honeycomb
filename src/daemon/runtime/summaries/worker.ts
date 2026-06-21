/**
 * Summary worker — PRD-017a Wave 1 (FULL), proving a-AC-1..6.
 *
 * The daemon-owned background worker that collapses a session's raw `sessions`
 * events into an AI-written wiki summary and writes it to the `memory` table at
 * `/summaries/<userName>/<sessionId>.md`, so recall ranks DOCUMENTS not thousands
 * of raw rows. Hooks SIGNAL the daemon on the final (`Stop`/`SessionEnd`/
 * `session_shutdown`) + periodic (turn-counter threshold) triggers; the daemon
 * runs THIS worker. The worker, in order:
 *
 *   - a-AC-4 acquires a PER-SESSION lock (atomic `O_EXCL`, key = sessionId) so at
 *     most ONE summary runs per session — a second trigger while one is in flight is
 *     SUPPRESSED. The lock is ALWAYS released in the `finally`.
 *   - a-AC-3 fetches the session's events from `sessions`; if NONE come back
 *     (DeepLake read lag), retries with LINEAR backoff up to `config.retryLimit`. On
 *     the final give-up it REMOVES the in-progress placeholder (never strands it) and
 *     returns.
 *   - a-AC-1 / a-AC-2 with events present, SCRUBS them with `redactSecrets` (reused
 *     from skillify so a transcript secret never lands in a summary) and runs the
 *     {@link SummaryGenCli} gate — the host harness CLI, no-shell args array, bounded
 *     timeout, subprocess env `HONEYCOMB_WIKI_WORKER=1` + `HONEYCOMB_CAPTURE=false`
 *     (so the gate call doesn't trigger its OWN capture loop).
 *   - a-AC-5 embeds the markdown via {@link EmbedClient.embed} → the 768-dim
 *     `summary_embedding`; a THROW is NON-FATAL → store NULL, the write STILL succeeds.
 *   - a-AC-1 / a-AC-6 writes the summary row to `memory` via SELECT-before-INSERT
 *     keyed on `path` (exactly once; NEVER an in-place UPDATE) with a `description`
 *     excerpt.
 *
 * ── Daemon-only storage (CONVENTIONS §2) ─────────────────────────────────────
 * This module lives under `src/daemon/`, so it reaches `sessions` + `memory`
 * through the daemon's own `StorageQuery` — never a re-opened DeepLake connection.
 * The hook half (the trigger signal) is a thin client that signals the daemon over
 * port 3850; the worker that calls {@link runSummaryWorker} runs INSIDE the daemon.
 *
 * ── SELECT-before-INSERT, never UPDATE (CONVENTIONS §3 / a-AC-6) ──────────────
 * The `memory` write is SELECT-before-INSERT keyed on `path`: insert iff absent. The
 * DeepLake backend coalesces a rapid in-place UPDATE against a freshly-written row
 * and silently drops one, so an in-place `SET` can never converge — the summary is
 * written EXACTLY ONCE per session. A live read of a just-written row UNDER-reports,
 * so the live itest reads poll-convergently. {@link SummaryStore} has NO `update`.
 *
 * ── SQL safety (CONVENTIONS §4) ──────────────────────────────────────────────
 * Every identifier routes through `sqlIdent`; every value through the `val.*`
 * constructors (→ `sLiteral`/`eLiteral`). The embedding literal is the output of
 * `serializeFloat4Array` (a pre-validated numeric fragment). `npm run audit:sql`
 * scans `src/daemon`.
 */

import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { healTargetFor } from "../../storage/catalog/index.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { type HealTarget, withHeal } from "../../storage/heal.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import { serializeFloat4Array } from "../../storage/vector.js";
import { buildInsert, selectBeforeInsert, val, type RowValues } from "../../storage/writes.js";
// REUSE skillify's redaction at the mine boundary so a transcript secret never lands
// in a summary (SECURITY — security-worker-bee, PRD-017 Wave 3). Imported, not forked.
import { redactSecrets } from "../skillify/miner.js";
import type { EmbedClient } from "../services/embed-client.js";
import {
	DEFAULT_WORKER_CONFIG,
	type SessionEvent,
	type SessionEventFetcher,
	type SummaryGenCli,
	type SummaryLock,
	type SummaryLockHandle,
	type SummaryRow,
	type SummarySession,
	type SummaryStore,
	type SummaryTrigger,
	type SummaryWriteOutcome,
	type WorkerConfig,
} from "./contracts.js";

// ════════════════════════════════════════════════════════════════════════════
// Constants — the table names, the path convention, the placeholder sentinel.
// ════════════════════════════════════════════════════════════════════════════

/** The `sessions` table the worker reads events from (catalog name). */
export const SESSIONS_TABLE = "sessions" as const;
/** The `memory` table the worker writes the summary row to (catalog name). */
export const MEMORY_TABLE = "memory" as const;
/** The root prefix the per-session summary path lives under (D-6 / FR-10). */
export const SUMMARY_PATH_PREFIX = "/summaries/" as const;
/** The `description` sentinel marking an in-progress placeholder row (a-AC-3 / FR-6). */
export const IN_PROGRESS_MARKER = "in progress" as const;
/** Max chars of the `description` excerpt stored alongside the summary (FR-10). */
export const DESCRIPTION_EXCERPT_CHARS = 280;

/** The subprocess env that marks a gate-CLI call so it does NOT capture-loop (a-AC-2 / FR-9). */
export const WIKI_WORKER_ENV = "HONEYCOMB_WIKI_WORKER" as const;
/** The subprocess env that disables capture in the gate-CLI subprocess (a-AC-2 / FR-9). */
export const CAPTURE_ENV = "HONEYCOMB_CAPTURE" as const;
/**
 * The canonical recursion-guard marker the capture gate reads (`capture-gate.ts`'s
 * `workerMarker`, sourced from `HONEYCOMB_WORKER`). Set in the gate subprocess as
 * defense-in-depth: `HONEYCOMB_CAPTURE=false` already disables capture (the gate's
 * priority-1 bypass), and this independently trips the gate's recursion guard so any
 * nested shim that loses the capture flag still cannot capture-loop (a-AC-2 / FR-9).
 */
export const WORKER_MARKER_ENV = "HONEYCOMB_WORKER" as const;

// ════════════════════════════════════════════════════════════════════════════
// The canonical summary path — `/summaries/<userName>/<sessionId>.md` (D-6 / FR-10).
// ════════════════════════════════════════════════════════════════════════════

/**
 * Reduce one path component to a SINGLE safe segment — only `[A-Za-z0-9._-]`, every
 * other char (including `/`, `\`, `..`) becomes `_`. A crafted userName / sessionId
 * can never traverse the summary path convention (mirrors skillify's
 * `sanitizeSegment`). An empty component falls back to `unknown`.
 */
function sanitizePathSegment(component: string): string {
	const cleaned = component.replace(/[^A-Za-z0-9._-]/g, "_");
	return cleaned === "" ? "unknown" : cleaned;
}

/**
 * The canonical `memory` path a per-session summary persists at (a-AC-1 / D-6 /
 * FR-10): `/summaries/<userName>/<sessionId>.md`. Both components are sanitized into
 * single path segments so the convention stays canonical and traversal-safe. Pure +
 * deterministic so the path is reproducible in tests.
 */
export function summaryPath(session: SummarySession): string {
	const user = sanitizePathSegment(session.userName);
	const sid = sanitizePathSegment(session.sessionId);
	return `${SUMMARY_PATH_PREFIX}${user}/${sid}.md`;
}

/** A short single-line excerpt of the markdown for the `description` column (FR-10). */
export function excerptOf(markdown: string): string {
	const oneLine = markdown.replace(/\s+/g, " ").trim();
	return oneLine.length <= DESCRIPTION_EXCERPT_CHARS
		? oneLine
		: `${oneLine.slice(0, DESCRIPTION_EXCERPT_CHARS)}…`;
}

// ════════════════════════════════════════════════════════════════════════════
// createSessionEventFetcher — the real scoped read of `sessions` (a-AC-3 / FR-5).
// ════════════════════════════════════════════════════════════════════════════

/** A subset of a `sessions` row the fetcher maps into a {@link SessionEvent}. */
function rowToSessionEvent(row: StorageRow): SessionEvent {
	const str = (k: string): string => (typeof row[k] === "string" ? (row[k] as string) : "");
	return {
		message: row.message,
		author: str("author"),
		creationDate: str("creation_date"),
	};
}

/**
 * Build the production {@link SessionEventFetcher} over the daemon's `StorageQuery`
 * (CONVENTIONS §2 / FR-5). ONE attempt: SELECT all of a session's rows for its
 * `path`, ordered by `creation_date` ascending, scoped to the run's tenant. The
 * `path` value routes through `sLiteral` (DeepLake has no bind params); the worker
 * drives the retry-on-empty LINEAR backoff loop on top of this seam.
 */
export function createSessionEventFetcher(storage: StorageQuery, scope: QueryScope): SessionEventFetcher {
	return {
		async fetch(session: SummarySession): Promise<readonly SessionEvent[]> {
			const tbl = sqlIdent(SESSIONS_TABLE);
			const pathCol = sqlIdent("path");
			const dateCol = sqlIdent("creation_date");
			const sql =
				`SELECT * FROM "${tbl}" ` +
				`WHERE ${pathCol} = ${sLiteral(session.path)} ` +
				`ORDER BY ${dateCol} ASC`;
			const res = await storage.query(sql, scope);
			if (!isOk(res)) return [];
			return (res.rows as StorageRow[]).map(rowToSessionEvent);
		},
	};
}

// ════════════════════════════════════════════════════════════════════════════
// createSummaryStore — the real `memory` SELECT-before-INSERT store (a-AC-1/3/6).
// ════════════════════════════════════════════════════════════════════════════

/** ISO timestamp for `creation_date` / `last_update_date`. */
function nowIso(): string {
	return new Date().toISOString();
}

/**
 * Build the production {@link SummaryStore} over the daemon's `StorageQuery`
 * (a-AC-1 / a-AC-3 / a-AC-6 / FR-1 / FR-6). The summary write is SELECT-before-INSERT
 * keyed on `path` — never an in-place UPDATE. There is NO `update` method.
 *
 * `resolveTable` maps the canonical `memory` name to the PHYSICAL table. Identity in
 * production. A live itest injects a per-run prefix so it reads/writes a real
 * throwaway table NATIVELY (the heal CREATEs the physical name) instead of rewriting
 * SQL strings after the fact (a SQL-string proxy races the heal's CREATE/introspect/
 * ALTER and corrupts a fresh table) — the proven `SkillStore` / `SourceArtifactStore`
 * isolation technique, copied verbatim.
 */
export function createSummaryStore(
	storage: StorageQuery,
	scope: QueryScope,
	resolveTable: (canonical: string) => string = (t) => t,
): SummaryStore {
	const physical = (): string => resolveTable(MEMORY_TABLE);

	const target = (): HealTarget => {
		const canonical = healTargetFor(MEMORY_TABLE);
		const phys = physical();
		return phys === MEMORY_TABLE ? canonical : { ...canonical, table: phys };
	};

	/** Build the `RowValues` for a `memory` row from a path + body + excerpt + embedding. */
	const rowValuesFor = (args: {
		path: string;
		summary: string;
		description: string;
		embedding: readonly number[] | null;
		author: string;
	}): RowValues => {
		const now = nowIso();
		// The embedding column is either a pre-validated FLOAT4[] literal (a numeric
		// fragment from serializeFloat4Array) or a raw NULL — both are `val.raw`, never
		// hand-quoted. A non-768 vector is rejected to NULL so the write still succeeds.
		const embeddingLit =
			args.embedding !== null && args.embedding.length === 768
				? serializeFloat4Array(args.embedding)
				: "NULL";
		return [
			["path", val.str(args.path)],
			["filename", val.str(filenameOf(args.path))],
			["summary", val.text(args.summary)],
			["summary_embedding", val.raw(embeddingLit)],
			["author", val.str(args.author)],
			["agent", val.str(args.author)],
			["description", val.text(args.description)],
			["creation_date", val.str(now)],
			["last_update_date", val.str(now)],
		];
	};

	return {
		async writePlaceholder(path: string, author: string): Promise<void> {
			// The placeholder is itself a SELECT-before-INSERT keyed on `path` (a-AC-3 /
			// a-AC-6): insert iff absent, never an in-place UPDATE. Its `description` is the
			// IN_PROGRESS_MARKER so removePlaceholder can target ONLY the placeholder.
			await selectBeforeInsert(storage, target(), scope, {
				keyColumn: "path",
				keyValue: path,
				row: rowValuesFor({
					path,
					summary: "",
					description: IN_PROGRESS_MARKER,
					embedding: null,
					author,
				}),
			});
		},

		async removePlaceholder(path: string): Promise<void> {
			// Delete ONLY the in-progress placeholder (a-AC-3 / FR-6), guarded by
			// `description = 'in progress'` so a concurrent REAL summary is never clobbered.
			// A DELETE that removes the just-inserted placeholder row is safe (no
			// read-modify-write of a live value); idempotent when already gone.
			const tbl = sqlIdent(physical());
			const pathCol = sqlIdent("path");
			const descCol = sqlIdent("description");
			const sql =
				`DELETE FROM "${tbl}" ` +
				`WHERE ${pathCol} = ${sLiteral(path)} ` +
				`AND ${descCol} = ${sLiteral(IN_PROGRESS_MARKER)}`;
			await withHeal(storage, target(), scope, () => storage.query(sql, scope));
		},

		async writeSummary(row: SummaryRow): Promise<SummaryWriteOutcome> {
			// SELECT-before-INSERT keyed on `path` (a-AC-1 / a-AC-6 / D-6): insert iff no
			// REAL summary already landed (exactly-once), NEVER an in-place UPDATE.
			//
			// The existence probe EXCLUDES the in-progress PLACEHOLDER (description = the
			// marker). removePlaceholder uses DELETE, which this eventually-consistent
			// backend does NOT reliably honor, so a stranded placeholder can still sit at
			// `path` when this runs — a plain SBI-by-path would see it, report
			// `alreadyPresent`, and SILENTLY DROP the real summary. Keying the probe on a
			// real (non-placeholder) summary makes the write robust to that.
			const tbl = sqlIdent(physical());
			const pathCol = sqlIdent("path");
			const descCol = sqlIdent("description");
			const probeSql =
				`SELECT ${pathCol} FROM "${tbl}" ` +
				`WHERE ${pathCol} = ${sLiteral(row.path)} ` +
				`AND ${descCol} != ${sLiteral(IN_PROGRESS_MARKER)} LIMIT 1`;
			const probe = await withHeal(storage, target(), scope, () => storage.query(probeSql, scope));
			if (isOk(probe) && probe.rows.length > 0) {
				// A real summary already landed → exactly-once; never re-write, never UPDATE.
				return { written: false, raceDetected: false };
			}
			const insertSql = buildInsert(
				physical(),
				rowValuesFor({
					path: row.path,
					summary: row.summary,
					description: row.description,
					embedding: row.embedding,
					author: row.author,
				}),
			);
			const inserted = await withHeal(storage, target(), scope, () => storage.query(insertSql, scope));
			// `written` reflects the ACTUAL write — a fresh INSERT that genuinely landed.
			// Returning `true` without checking the result would mask a failed INSERT (e.g.
			// the missing-`description`-column bug) as success.
			return { written: isOk(inserted), raceDetected: false };
		},
	};
}

/** The trailing `<sessionId>.md` filename of a summary path (the `filename` column). */
function filenameOf(path: string): string {
	const idx = path.lastIndexOf("/");
	return idx === -1 ? path : path.slice(idx + 1);
}

// ════════════════════════════════════════════════════════════════════════════
// createFileSessionLock — the real PER-SESSION O_EXCL lock (a-AC-4 / D-2 / FR-3).
// ════════════════════════════════════════════════════════════════════════════

/** The default per-session summary-lock root (`~/.claude/hooks/summary-state`, FR-3). */
export function defaultSummaryLockBaseDir(): string {
	return join(homedir(), ".claude", "hooks", "summary-state");
}

/**
 * Reduce a session id to a SINGLE safe path segment (lock-file name) — only
 * `[A-Za-z0-9._-]`, every other char becomes `_`, so a crafted id can never traverse
 * out of the lock base dir (mirrors skillify's `sanitizeSegment`).
 */
function sanitizeLockSegment(sessionId: string): string {
	const cleaned = sessionId.replace(/[^A-Za-z0-9._-]/g, "_");
	return cleaned === "" ? "default" : cleaned;
}

/**
 * Build a filesystem {@link SummaryLock} rooted at `baseDir`, keyed PER-SESSION
 * (a-AC-4 / D-2 / FR-3). The lock is an atomic `O_EXCL` create of
 * `<baseDir>/<sessionId>.lock`: a SECOND concurrent `acquire` for the same session
 * fails the exclusive create → `null` → the run is SUPPRESSED (at most one summary
 * per session). `release` removes the lock file (idempotent — a double release is a
 * no-op, exactly what the worker's `finally` needs). Adapted verbatim from skillify's
 * `createFileWorkerLock`, but the key is the SESSION id, not the project key.
 */
export function createFileSessionLock(baseDir: string = defaultSummaryLockBaseDir()): SummaryLock {
	const fileFor = (sessionId: string): string => join(baseDir, `${sanitizeLockSegment(sessionId)}.lock`);
	return {
		acquire(sessionId: string): SummaryLockHandle | null {
			const path = fileFor(sessionId);
			try {
				mkdirSync(dirname(path), { recursive: true });
				// `wx` = O_CREAT | O_EXCL: fails if the file exists → a summary is in flight.
				const fd = openSync(path, "wx");
				closeSync(fd);
			} catch {
				// EEXIST (or any failure to take the lock) → already in flight → suppress.
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

// ════════════════════════════════════════════════════════════════════════════
// The gate prompt + the host-CLI shell-out (a-AC-1 / a-AC-2 / FR-8 / FR-9).
// ════════════════════════════════════════════════════════════════════════════

/** The verbatim capture envelope shape (`{ event, metadata }`) the worker decodes. */
interface CaptureEnvelope {
	readonly event?: { readonly kind?: string; readonly text?: string };
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

/**
 * Build the gate prompt from the fetched events (a-AC-1 / a-AC-2). Renders each event
 * as a labelled `[<kind>] <text>` line in `creation_date` order, SCRUBBING each text
 * with `redactSecrets` so a pasted credential never reaches the gate prompt or the
 * generated summary (SECURITY, PRD-017). The render is deterministic so the gate
 * prompt is reproducible in tests.
 */
export function buildSummaryPrompt(session: SummarySession, events: readonly SessionEvent[]): string {
	const header =
		"You are a session-summary writer. Collapse the conversation below into a concise " +
		"wiki-style markdown summary: what the user wanted, what was decided, what changed, " +
		"and any follow-ups. Write ONLY the markdown summary — no preamble.\n\n" +
		`Session: ${session.sessionId}\nEvents:\n`;
	const body = events
		.map((e) => {
			const env = parseEnvelope(e.message);
			const kind = env?.event?.kind ?? "event";
			const text = typeof env?.event?.text === "string" ? env.event.text : "";
			// Scrub at the boundary — the deterministic floor that does not depend on the
			// gate model omitting the secret.
			return `[${kind}] ${redactSecrets(text)}`;
		})
		.join("\n");
	return `${header}${body}\n`;
}

/** The host-CLI invocation matrix (FR-8). Command + args ARRAY — no shell. */
export interface SummaryCliSpec {
	/** The executable to spawn (e.g. `claude`, `codex`, `cursor-agent`). */
	readonly command: string;
	/** The argument array passed verbatim — NEVER a shell string (no-injection). */
	readonly args: readonly string[];
}

/** The spawn seam so a test asserts the args array + the capture-loop-guard env (a-AC-2). */
export interface SummarySpawner {
	/**
	 * Spawn the host CLI WITHOUT a shell, feed `prompt` on stdin, resolve with stdout.
	 * Rejects on a non-zero exit / spawn error / timeout. `shell:false` + an args array
	 * is the no-injection guarantee; the subprocess env sets `HONEYCOMB_WIKI_WORKER=1`
	 * + `HONEYCOMB_CAPTURE=false` so the gate call does not capture-loop (a-AC-2 / FR-9).
	 */
	run(spec: SummaryCliSpec, prompt: string, timeoutMs: number): Promise<string>;
}

/**
 * The default spawner: `child_process.spawn` with `shell:false` (CONVENTIONS §4),
 * mirroring skillify's `systemGateSpawner`. The prompt is written to the child's
 * stdin (never interpolated into the args), so a session transcript can never become
 * a command. The subprocess env layers `HONEYCOMB_WIKI_WORKER=1` +
 * `HONEYCOMB_CAPTURE=false` over the parent env so the gate call does not trigger its
 * OWN capture loop (a-AC-2 / FR-9). The timeout kills a runaway (SIGTERM).
 */
export const systemSummarySpawner: SummarySpawner = {
	run(spec: SummaryCliSpec, prompt: string, timeoutMs: number): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			// CRITICAL (no-shell): command + args ARRAY, `shell:false`. The capture-loop
			// guard env is layered over the parent env so the gate subprocess never starts
			// its own capture (a-AC-2 / FR-9).
			const child = spawn(spec.command, [...spec.args], {
				shell: false,
				windowsHide: true,
				env: {
					...process.env,
					[WIKI_WORKER_ENV]: "1",
					[CAPTURE_ENV]: "false",
					// Defense-in-depth: trip the capture gate's recursion guard too
					// (capture-gate.ts reads HONEYCOMB_WORKER), so a nested shim that loses
					// CAPTURE=false still cannot capture-loop (a-AC-2 / FR-9).
					[WORKER_MARKER_ENV]: "1",
				},
			});
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
				finish(() => reject(new Error("summary gate CLI exceeded the timeout")));
			}, timeoutMs);

			child.stdout?.on("data", (d: Buffer) => {
				stdout += d.toString("utf8");
			});
			child.on("error", (err: Error) => finish(() => reject(err)));
			child.on("close", (code: number | null) => {
				if (code === 0) finish(() => resolve(stdout));
				else finish(() => reject(new Error(`summary gate CLI exited with code ${code ?? "null"}`)));
			});

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
 * Build the real {@link SummaryGenCli} (a-AC-1 / a-AC-2 / FR-8 / FR-9). It spawns the
 * host agent's own CLI (which already holds the operator's auth — NO API key) with an
 * args array + `shell:false` + the capture-loop-guard env via the {@link SummarySpawner}
 * seam, then returns the markdown from stdout. The spawner is injectable so a test
 * drives the no-shell + env path deterministically without a real CLI.
 */
export function createHostSummaryGenCli(
	spec: SummaryCliSpec,
	spawner: SummarySpawner = systemSummarySpawner,
	timeoutMs: number = DEFAULT_WORKER_CONFIG.gateTimeoutMs,
): SummaryGenCli {
	return {
		async run(prompt: string): Promise<string> {
			return spawner.run(spec, prompt, timeoutMs);
		},
	};
}

// ════════════════════════════════════════════════════════════════════════════
// runSummaryWorker — lock → fetch-with-retry → gate → embed → SBI write.
// ════════════════════════════════════════════════════════════════════════════

/** A sleeper seam so a test drives the retry backoff with a fake clock (a-AC-3). */
export interface Sleeper {
	/** Resolve after `ms`. */
	sleep(ms: number): Promise<void>;
}

/** The default real sleeper (`setTimeout`). */
export const systemSleeper: Sleeper = {
	sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	},
};

/** Construction deps for {@link runSummaryWorker} (everything IO-touching injected). */
export interface SummaryWorkerDeps {
	/** The per-session lock (a-AC-4). Default: the filesystem `O_EXCL` lock. */
	readonly lock: SummaryLock;
	/** The scoped session-event fetcher (a-AC-3). Real impl over `StorageQuery`. */
	readonly fetcher: SessionEventFetcher;
	/** The host-CLI summary-generation gate (a-AC-1 / a-AC-2). Faked in tests. */
	readonly gate: SummaryGenCli;
	/** The 768-dim embed client (a-AC-5). A throw is non-fatal. */
	readonly embed: EmbedClient;
	/** The daemon-side `memory` store (a-AC-1 / a-AC-6). SELECT-before-INSERT, no UPDATE. */
	readonly store: SummaryStore;
	/** The retry/backoff/gate-timeout tuning (a-AC-3). Defaults to {@link DEFAULT_WORKER_CONFIG}. */
	readonly config?: WorkerConfig;
	/** The backoff sleeper (a-AC-3). Injectable so a test drives the retry loop fast. */
	readonly sleeper?: Sleeper;
}

/** Why a summary run did not write a row (the lock was held, or it gave up on no events). */
export type SummarySkippedReason = "lock_held" | "no_events" | "gate_failed";

/** The result of a {@link runSummaryWorker}: it ran + wrote, or skipped with a reason. */
export type SummaryWorkerResult =
	| { readonly ran: true; readonly path: string; readonly wrote: boolean; readonly embedded: boolean }
	| { readonly ran: false; readonly reason: SummarySkippedReason };

/**
 * Run a full summary: LOCK → write placeholder → fetch-with-retry → gate → embed →
 * SELECT-before-INSERT write, releasing the lock in `finally` (a-AC-1..6).
 *
 *   - a-AC-4 takes the PER-SESSION lock. If a summary is ALREADY in flight for the
 *     session, `acquire` returns `null` and this run is SUPPRESSED
 *     (`{ ran: false, reason: "lock_held" }`).
 *   - a-AC-3 writes an in-progress placeholder, then fetches the session's events,
 *     retrying with LINEAR backoff up to `config.retryLimit` on an empty result. On
 *     the final give-up it REMOVES the placeholder (never strands it) and returns
 *     `{ ran: false, reason: "no_events" }`.
 *   - a-AC-1 / a-AC-2 builds the scrubbed gate prompt and runs the gate (the host CLI,
 *     no-shell, capture-guard env). A gate throw / empty markdown → remove the
 *     placeholder + `{ ran: false, reason: "gate_failed" }`.
 *   - a-AC-5 embeds the markdown; a THROW is NON-FATAL → NULL embedding, the write
 *     still succeeds.
 *   - a-AC-1 / a-AC-6 removes the placeholder, then writes the summary row via
 *     SELECT-before-INSERT keyed on `path` (exactly once, never an in-place UPDATE).
 *
 * The lock is ALWAYS released in the `finally` — on every path above.
 */
export async function runSummaryWorker(
	trigger: SummaryTrigger,
	session: SummarySession,
	deps: SummaryWorkerDeps,
): Promise<SummaryWorkerResult> {
	void trigger; // the trigger is recorded by the caller's diagnostics; the run is identical for both classes.
	const config = deps.config ?? DEFAULT_WORKER_CONFIG;
	const sleeper = deps.sleeper ?? systemSleeper;
	const path = summaryPath(session);
	const author = session.userName;

	const handle = deps.lock.acquire(session.sessionId);
	if (handle === null) {
		// A concurrent summary is already in flight for this session → suppress (a-AC-4).
		return { ran: false, reason: "lock_held" };
	}

	try {
		// Stake the in-progress placeholder so a reader sees the summary is being written
		// (a-AC-3). SELECT-before-INSERT keyed on `path` — never an in-place UPDATE.
		await deps.store.writePlaceholder(path, author);

		// a-AC-3: fetch events, retrying with LINEAR backoff on an empty result. The
		// FIRST attempt is immediate; each subsequent attempt waits `backoffMs` (linear,
		// constant interval). After `retryLimit` empty attempts, give up.
		const events = await fetchWithRetry(deps.fetcher, session, config, sleeper);
		if (events.length === 0) {
			// Final give-up → REMOVE the placeholder (never strand it) and return (a-AC-3).
			await deps.store.removePlaceholder(path);
			return { ran: false, reason: "no_events" };
		}

		// a-AC-1 / a-AC-2: run the host-CLI gate over the scrubbed, ordered events. A
		// throw (timeout / crash) or empty markdown → remove the placeholder, write
		// nothing. The gate's own subprocess sets WIKI_WORKER=1 + CAPTURE=false.
		let markdown: string;
		try {
			markdown = (await deps.gate.run(buildSummaryPrompt(session, events))).trim();
		} catch {
			await deps.store.removePlaceholder(path);
			return { ran: false, reason: "gate_failed" };
		}
		if (markdown === "") {
			await deps.store.removePlaceholder(path);
			return { ran: false, reason: "gate_failed" };
		}

		// a-AC-5: embed the markdown → the 768-dim summary_embedding. A THROW is
		// NON-FATAL: store NULL, the write STILL succeeds.
		const embedding = await embedNonFatal(deps.embed, markdown);

		// a-AC-1 / a-AC-6: clear the placeholder, then write the summary row via
		// SELECT-before-INSERT keyed on `path` (exactly once, NEVER an in-place UPDATE).
		await deps.store.removePlaceholder(path);
		const row: SummaryRow = {
			path,
			summary: markdown,
			description: excerptOf(markdown),
			embedding,
			author,
		};
		const outcome = await deps.store.writeSummary(row);
		return { ran: true, path, wrote: outcome.written, embedded: embedding !== null };
	} finally {
		// ALWAYS release — on success, on a no-events give-up, on a gate failure, on a throw.
		handle.release();
	}
}

/**
 * Fetch a session's events, retrying with LINEAR backoff on an empty result (a-AC-3 /
 * FR-5). The first attempt is immediate; up to `retryLimit` retries each wait
 * `backoffMs` (constant interval = linear). Returns the first non-empty batch, or an
 * empty array if every attempt came back empty (the caller gives up + removes the
 * placeholder). A retryLimit of 0 means a single attempt with no retry.
 */
export async function fetchWithRetry(
	fetcher: SessionEventFetcher,
	session: SummarySession,
	config: WorkerConfig,
	sleeper: Sleeper,
): Promise<readonly SessionEvent[]> {
	const retries = Math.max(0, Math.trunc(config.retryLimit));
	for (let attempt = 0; attempt <= retries; attempt++) {
		const events = await fetcher.fetch(session);
		if (events.length > 0) return events;
		if (attempt < retries) {
			await sleeper.sleep(Math.max(0, Math.trunc(config.backoffMs)));
		}
	}
	return [];
}

/**
 * Embed the markdown, treating EVERY failure as NON-FATAL (a-AC-5 / D-5). Returns the
 * 768-dim vector on success, or NULL when embedding is disabled, returns the wrong
 * dim, OR THROWS — in every non-vector case the summary row keeps `summary_embedding`
 * NULL and the write still succeeds. The {@link EmbedClient} contract says it should
 * not throw for expected failures, but this wrapper additionally guards an unexpected
 * throw so a hung/erroring embed never aborts the summary write.
 */
export async function embedNonFatal(embed: EmbedClient, markdown: string): Promise<readonly number[] | null> {
	try {
		const vector = await embed.embed(markdown);
		if (vector === null) return null;
		// Defensive: only a 768-dim vector is stored; anything else → NULL (the write
		// still succeeds). The store also rejects non-768 to NULL as a final guard.
		return vector.length === 768 ? vector : null;
	} catch {
		// a-AC-5: a THROW is non-fatal — NULL embedding, the write proceeds.
		return null;
	}
}
