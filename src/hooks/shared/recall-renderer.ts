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
 * The default fetch timeout (ms). Tighter than {@link import("./prime-renderer.js").DEFAULT_PRIME_TIMEOUT_MS}
 * (5s) because this recall rides EVERY qualifying turn, not once per session: a slow daemon
 * must not stall the turn, so the bound degrades to "no injection" quickly (a-AC-3).
 *
 * PRD-077b (L-B4): raised 2_500 → 4_000 to give the ~1.5s single-round-trip fast recall real
 * headroom — the client budget now sits COMFORTABLY above the fast-lane server-side deadline
 * (`recallFastDeadlineMs`, default 3000ms) so the daemon's own deadline fires first (freeing its
 * slot) while the client still fails soft to `""` past 4s. In-family with the prime path's 5s.
 */
export const DEFAULT_RECALL_TIMEOUT_MS = 4_000;

/** The default per-turn hit `limit` - small, because this injects on every turn (recall cadence open question). */
export const DEFAULT_RECALL_LIMIT = 5;

/** The default per-turn `tokenBudget` - small, to protect the turn's token budget + prompt-cache stability. */
export const DEFAULT_RECALL_TOKEN_BUDGET = 600;

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
				return coerceHits(await readJsonSoft(res));
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
 */
function coerceHits(body: unknown): readonly RecallHit[] {
	if (body === null || typeof body !== "object") return [];
	const rawHits = (body as { hits?: unknown }).hits;
	if (!Array.isArray(rawHits)) return [];
	const out: RecallHit[] = [];
	for (const item of rawHits) {
		if (item === null || typeof item !== "object") continue;
		const rec = item as { id?: unknown; source?: unknown; text?: unknown };
		const text = typeof rec.text === "string" ? rec.text : "";
		if (text.trim().length === 0) continue;
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
