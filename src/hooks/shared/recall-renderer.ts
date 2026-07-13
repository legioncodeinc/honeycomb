/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

/**
 * Production per-turn query-aware recall renderer - PRD-076a (a-AC-1..3).
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────
 * A query-parameterized sibling of the session-start prime renderer
 * (`prime-renderer.ts`). Where the prime GETs the blind session digest ONCE per
 * session, this POSTs the turn's PROMPT to the daemon's hybrid recall
 * (`POST /api/memories/recall`) on EVERY qualifying `UserPromptSubmit` and returns
 * the daemon-bounded hits, so a Claude Code session gets per-turn, query-aware
 * recall whether or not the model reaches for a tool.
 *
 * ── THIN CLIENT (D-2) ───────────────────────────────────────────────────────
 * `src/hooks` is a NON_DAEMON_ROOT - it imports NOTHING from `daemon/storage` and
 * builds NO SQL. The only outbound path is a `fetch` over loopback to the daemon.
 * The hook does NO ranking or re-assembly (the daemon already bounds the hits and
 * honours `tokenBudget`); it coerces the response `hits[]` into {@link RecallHit}s
 * and hands them back.
 *
 * ── THE SESSION-GROUP HEADERS (why a bare POST 400s) ────────────────────────
 * `/api/memories/recall` lives under the `/api/memories` SESSION group behind the
 * runtime-path middleware: the request MUST carry `x-honeycomb-runtime-path` AND a
 * non-empty `x-honeycomb-session`, plus tenancy (`x-honeycomb-org` (+ workspace /
 * actor)) or it is rejected 400 BEFORE the handler runs. This client stamps ALL of
 * them from the resolved credential, IDENTICALLY to `prime-renderer.ts:96-104`. A
 * signed-out credential is sent unscoped and the daemon fail-closes it (a-AC-2).
 *
 * ── FAIL-SOFT, NEVER A THROW (a-AC-3) ───────────────────────────────────────
 * ANY failure resolves to `[]` (no injection), never a throw: an unreachable /
 * timed-out daemon, a non-200 status, or a malformed body. The fetch is bounded by
 * a TIGHT `AbortController` budget (tighter than the 5s prime budget, because this
 * rides EVERY qualifying turn, not once per session) and aborted on expiry.
 */

import { DAEMON_HOST, DAEMON_PORT } from "../../shared/constants.js";
import type { HookCredential, RecallHit, RecallRenderer, RecallRenderRequest } from "./contracts.js";

/** The daemon route the renderer POSTs (022a recall). */
export const RECALL_PATH = "/api/memories/recall" as const;

/**
 * The default fetch timeout (ms). This recall rides EVERY qualifying turn, not once per session:
 * a slow daemon must not stall the turn indefinitely, so the bound degrades to "no injection"
 * (a-AC-3) — but the bound must sit ABOVE what a real successful recall costs, or the client
 * silently discards work the daemon completed.
 *
 * PRD-077b, revised (ISS-022): raised 4_000 → 6_000. Live end-to-end per-turn recall measures
 * 3.0–4.6s on Windows: the daemon fast-lane's own server-side deadline (`recallFastDeadlineMs`,
 * default 3000ms) PLUS embed, loopback transport, and Node hook-binary startup overhead. At the
 * old 4s budget the client aborted mid-flight at p95 and threw away REAL daemon successes —
 * recall looked "empty" on turns where the daemon had hits in hand. 6s clears the observed max
 * with margin while still bounding a genuinely stalled turn, and the server-side fast deadline
 * (3s) still fires first, freeing the daemon slot well inside the client budget.
 */
export const DEFAULT_RECALL_TIMEOUT_MS = 6_000;

/** The default per-turn hit `limit` - small, because this injects on every turn (recall cadence open question). */
export const DEFAULT_RECALL_LIMIT = 5;

/** The default per-turn `tokenBudget` - small, to protect the turn's token budget + prompt-cache stability. */
export const DEFAULT_RECALL_TOKEN_BUDGET = 600;

/**
 * ISS-024: the minimum fused RRF score a hit must carry to be INJECTED per-turn.
 *
 * PRD-045b removed the daemon-side confidence gate on the doctrine that every surface wants raw
 * ranked recall — which left the per-turn injector with NO relevance floor: the top-`limit` hits
 * ride into the model's context however weak they are (live-observed: hits scoring < 0.005 —
 * displayed as 0.00 — injected on every turn of a session). The inject-or-not decision belongs to
 * the INJECTOR, so the floor lives here, not in the daemon (dashboard/CLI/MCP still get raw recall).
 *
 * WHY 0.005: with RRF `k=60`, a rank-1 single-arm distilled hit scores `1/61 ≈ 0.016` fresh, and
 * `≈ 0.008` at one recency half-life (180 days for `memories`, exponent 1.0). 0.005 admits a
 * rank-1..5 fresh hit AND a half-life-aged fact, while cutting the deep-conjunct-rank noise tier
 * (scores an order of magnitude below a real match). Tunable via {@link RecallRendererOptions.minScore}.
 */
export const MIN_INJECTION_SCORE = 0.005;

/** The `default` workspace sentinel when the credential carries no workspace (mirrors the daemon-client). */
const DEFAULT_WORKSPACE = "default" as const;

/** Options for {@link createRecallRenderer}. All optional with production defaults. */
export interface RecallRendererOptions {
	/**
	 * The credential reader is NOT needed here (the credential rides the request), but the
	 * loopback target + fetch + bounds are configurable. The renderer resolves tenancy from
	 * {@link RecallRenderRequest.credential} directly, so a signed-out request degrades to `[]`.
	 */
	/** The daemon host. Defaults to the loopback constant (`127.0.0.1`). */
	readonly host?: string;
	/** The daemon port. Defaults to the loopback constant (`3850`). */
	readonly port?: number;
	/** The `fetch` implementation. Defaults to the global `fetch`. Injected for tests. */
	readonly fetch?: typeof fetch;
	/** The fetch timeout in ms. Defaults to {@link DEFAULT_RECALL_TIMEOUT_MS}. */
	readonly timeoutMs?: number;
	/** The per-turn hit limit. Defaults to {@link DEFAULT_RECALL_LIMIT}. */
	readonly limit?: number;
	/** The per-turn token budget. Defaults to {@link DEFAULT_RECALL_TOKEN_BUDGET}. */
	readonly tokenBudget?: number;
	/** The minimum fused score a hit needs to inject (ISS-024). Defaults to {@link MIN_INJECTION_SCORE}. */
	readonly minScore?: number;
}

/**
 * Build the production {@link RecallRenderer} (a-AC-1..3). POSTs `{ query, limit, tokenBudget,
 * cwd }` to `/api/memories/recall` over loopback, stamping the runtime-path + session + tenancy
 * headers, and returns the coerced {@link RecallHit}s. READ-ONLY + FAIL-SOFT: any error / non-200
 * / malformed body resolves to `[]` (no injection), never a throw (a-AC-3). The fetch is bounded
 * by `timeoutMs` and aborted on expiry so a slow daemon never stalls the turn.
 */
export function createRecallRenderer(options: RecallRendererOptions = {}): RecallRenderer {
	const host = options.host ?? DAEMON_HOST;
	const port = options.port ?? DAEMON_PORT;
	const doFetch = options.fetch ?? fetch;
	const timeoutMs = options.timeoutMs ?? DEFAULT_RECALL_TIMEOUT_MS;
	const limit = options.limit ?? DEFAULT_RECALL_LIMIT;
	const tokenBudget = options.tokenBudget ?? DEFAULT_RECALL_TOKEN_BUDGET;
	const minScore = options.minScore ?? MIN_INJECTION_SCORE;
	const url = `http://${host}:${port}${RECALL_PATH}`;

	return {
		async render(req: RecallRenderRequest): Promise<readonly RecallHit[]> {
			const query = req.query.trim();
			if (query.length === 0) return []; // nothing to recall on an empty prompt.

			const headers: Record<string, string> = {
				"content-type": "application/json",
				// The session group requires BOTH of these (runtime-path middleware), or 400.
				"x-honeycomb-runtime-path": req.runtimePath ?? "plugin",
				"x-honeycomb-session": req.meta.sessionId,
				...recallTenancyHeaders(req.credential),
			};
			// The body matches RecallBodySchema (api.ts:303-323). `cwd` scopes recall to the project
			// (49b-AC-2) so a recall in project A never returns a project-B row.
			const body = JSON.stringify({
				query,
				limit,
				tokenBudget,
				// PRD-077a (D-1): route the daemon to the single-round-trip `recallFast` so this
				// per-turn recall fits its budget - the SAME arms/RRF/recency, minus the hydrate hop,
				// dedup, rerank, and lifecycle. Headers, AbortController, fail-soft `[]` are unchanged.
				fast: true,
				...(req.meta.cwd !== undefined ? { cwd: req.meta.cwd } : {}),
			});

			// Bound the fetch: a slow daemon must not stall the turn (a-AC-3). The signal is aborted
			// on timeout so the await rejects and the catch degrades to [].
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), timeoutMs);
			try {
				const res = await doFetch(url, { method: "POST", headers, body, signal: controller.signal });
				if (res.status !== 200) return []; // non-200 (incl. the signed-out 400) → no injection.
				return coerceHits(await readJsonSoft(res), minScore);
			} catch {
				// Unreachable / refused / timed-out / aborted → no injection, no throw (a-AC-3).
				return [];
			} finally {
				clearTimeout(timer);
			}
		},
	};
}

/**
 * Resolve the tenancy request headers from the credential (mirrors `prime-renderer.ts:96-104`).
 * A signed-out (`undefined`) or org-less credential yields NO tenancy headers - the daemon
 * fail-closes an org-less recall (a-AC-2), and the renderer degrades to `[]` on the resulting 400.
 */
function recallTenancyHeaders(cred: HookCredential | undefined): Record<string, string> {
	if (cred?.org === undefined) return {};
	const headers: Record<string, string> = {
		"x-honeycomb-org": cred.org,
		"x-honeycomb-workspace": cred.workspace ?? DEFAULT_WORKSPACE,
	};
	if (cred.actor !== undefined) headers["x-honeycomb-actor"] = cred.actor;
	return headers;
}

/**
 * Coerce a recall response body to bounded {@link RecallHit}s. The 022a contract is
 * `{ hits: { source, id, text, ... }[], ... }`. Each hit keeps its `text` (skipping empties)
 * and a stable `ref` for dedupe: `source:id` when an id is present, else a `text:` content
 * prefix (so a re-scored duplicate of the same content still dedupes - the PRD's preferred
 * key with the documented text fallback). A non-array `hits` or unknown shape yields `[]`.
 *
 * ── ISS-024: the injection gate ─────────────────────────────────────────────
 * Two classes of hit are excluded from PER-TURN injection (they stay reachable via
 * `honeycomb recall`, the dashboard, and the MCP tools — the daemon still returns them):
 *   - RAW SESSION DUMPS: a hit the daemon classed `session` (`secondary: true` /
 *     `kind: "session"`) is a captured-turn blob — for legacy rows, the full escaped
 *     `message::text` JSON. The daemon tags them for drill-down; injecting them verbatim
 *     is how a raw tool-call trace ends up in the model's context.
 *   - BELOW-FLOOR SCORES: a hit whose fused RRF score is below `minScore` (see
 *     {@link MIN_INJECTION_SCORE}). A MISSING/non-numeric score is KEPT (fail-open): the
 *     thin client never blanks recall because an older daemon omitted a field.
 */
function coerceHits(body: unknown, minScore: number): readonly RecallHit[] {
	if (body === null || typeof body !== "object") return [];
	const rawHits = (body as { hits?: unknown }).hits;
	if (!Array.isArray(rawHits)) return [];
	const out: RecallHit[] = [];
	for (const item of rawHits) {
		if (item === null || typeof item !== "object") continue;
		const rec = item as {
			id?: unknown;
			source?: unknown;
			text?: unknown;
			score?: unknown;
			kind?: unknown;
			secondary?: unknown;
		};
		const text = typeof rec.text === "string" ? rec.text : "";
		if (text.trim().length === 0) continue;
		// ISS-024: raw session dumps never inject per-turn (either provenance signal suffices).
		if (rec.secondary === true || rec.kind === "session") continue;
		// ISS-024: below-floor hits never inject; a missing/non-numeric score is kept (fail-open).
		if (typeof rec.score === "number" && rec.score < minScore) continue;
		const id = typeof rec.id === "string" ? rec.id : "";
		const source = typeof rec.source === "string" ? rec.source : "";
		out.push({ ref: id.length > 0 ? `${source}:${id}` : `text:${text.trim().slice(0, 120)}`, text });
	}
	return out;
}

/** Parse a `fetch` `Response` body as JSON, tolerating an empty/non-JSON body (→ undefined). */
async function readJsonSoft(res: Response): Promise<unknown> {
	try {
		const text = await res.text();
		return text.length === 0 ? undefined : JSON.parse(text);
	} catch {
		return undefined;
	}
}
