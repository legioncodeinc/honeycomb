/**
 * The `/api/memories/*` mount seam — PRD-022a.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * `mountMemoriesApi(daemon, { storage, ... })` is the single named step the
 * composition root (022d) calls AFTER `createDaemon(...)` to attach the memory
 * read + write handlers onto the already-mounted `/api/memories` route group —
 * mirroring `mountDashboardApi` (`dashboard/api.ts`) and `attachHooksHandlers`
 * (`capture/attach.ts`). ZERO edits to `server.ts`: the `/api/memories` group is
 * ALREADY scaffolded there as a SESSION group behind the runtime-path +
 * permission middleware (`ROUTE_GROUPS`: `protect: true, session: true`), so
 * attaching via `daemon.group("/api/memories")` inherits auth/RBAC + the
 * runtime-path session gate with no re-wiring.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── What it wires (replacing the PRD-004 501 scaffold) ──────────────────────
 *   POST   /api/memories/recall   → recall engine (a-AC-2) — per-arm lexical
 *                                    recall over memories+memory+sessions (each a
 *                                    guarded query, a missing sibling arm degrades
 *                                    to empty), BM25/ILIKE fallback (embeddings off,
 *                                    ledger D-4).
 *   POST   /api/memories          → controlled-writes ADD (a-AC-3) — lands a real
 *                                    row that is then recallable.
 *   GET    /api/memories          → list the scoped tenant's memories (FR-4).
 *   GET    /api/memories/:id       → get one memory by id (FR-4).
 *   POST   /api/memories/:id/modify → version-bumped UPDATE, reason-gated + audited (a-AC-4).
 *   POST   /api/memories/:id/forget → version-bumped soft-DELETE, reason-gated + audited (a-AC-4).
 *
 * ── Session group (a-AC-6 / FR-8) ────────────────────────────────────────────
 * `/api/memories` is a SESSION group: the runtime-path middleware in front of it
 * REQUIRES the `x-honeycomb-session` header. A request without it is rejected by
 * the middleware BEFORE any handler here runs. This requirement is documented in
 * `CONVENTIONS.md` + the ledger so the 022d clients (`honeycomb recall`, the SDK
 * `recall()`, the MCP `memory_search`) stamp the header. The unit tests + the live
 * itest stamp it.
 *
 * ── Zod at the boundary (a-AC-5 / FR-6) ──────────────────────────────────────
 * Every request body is zod-validated; a malformed body is a 400 BEFORE the engine
 * is reached. The modify/forget bodies require a `reason` (a-AC-4) — a body without
 * one fails zod and never reaches the mutation.
 *
 * ── Tenancy (a-AC / FR-7) ────────────────────────────────────────────────────
 * Every read + write resolves the {@link QueryScope} from the `x-honeycomb-*`
 * headers (fail-closed: no org → 400). A request reads + writes only within its
 * resolved tenant; the org/workspace partition rides every storage call.
 */

import type { Context } from "hono";
import { z } from "zod";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import type { Daemon } from "../server.js";
import type { EmbedClient } from "../services/embed-client.js";
import { resolveScopeFromHeaders, resolveScopeOrLocalDefault } from "../scope.js";
import { recallMemories, type MemoryRecallResult } from "./recall.js";
import { getMemory, listMemories, resolveListLimit } from "./reads.js";
import {
	forgetMemory,
	modifyMemory,
	storeMemory,
	type MemoryWriteDeps,
} from "./store.js";

/** The route group the memories API attaches to (already mounted in `server.ts`). */
export const MEMORIES_GROUP = "/api/memories" as const;

/** Options for {@link mountMemoriesApi}. Mirrors {@link import("../dashboard/api.js").MountDashboardOptions}. */
export interface MountMemoriesOptions {
	/** The storage client every read + write runs through (never a raw fetch). */
	readonly storage: StorageQuery;
	/**
	 * The embed seam for the store path (005b). Defaults to the no-op so a stored
	 * row lands with `content_embedding` NULL and stays lexically recallable
	 * (embeddings off, ledger D-4). 022d/embeddings-on passes a real client.
	 */
	readonly embed?: EmbedClient;
	/**
	 * The daemon's configured default tenancy scope, threaded from the composition root
	 * (PRD-022). In LOCAL mode a request with no `x-honeycomb-org` header falls back to
	 * this single configured tenant (a loopback thin client — SDK/MCP — need not know the
	 * org GUID). ABSENT (a unit-constructed daemon) → pure header-only resolution (the prior
	 * fail-closed behaviour). NEVER consulted outside local mode.
	 */
	readonly defaultScope?: QueryScope;
}

// ── Zod request schemas (a-AC-5 / FR-6) ──────────────────────────────────────

/** `POST /api/memories/recall` body: a query string + optional limit. */
const RecallBodySchema = z.object({
	query: z.string().min(1, "query is required"),
	limit: z.number().int().positive().optional(),
});

/** `POST /api/memories` (store) body: content + optional type/normalized/agent. */
const StoreBodySchema = z.object({
	content: z.string().min(1, "content is required"),
	normalizedContent: z.string().optional(),
	type: z.string().min(1).optional(),
	agentId: z.string().min(1).optional(),
});

/** `POST /api/memories/:id/modify` body: a new content + a REQUIRED reason (a-AC-4). */
const ModifyBodySchema = z.object({
	content: z.string().min(1, "content is required"),
	reason: z.string().min(1, "reason is required"),
	agentId: z.string().min(1).optional(),
});

/** `POST /api/memories/:id/forget` body: a REQUIRED reason (a-AC-4). */
const ForgetBodySchema = z.object({
	reason: z.string().min(1, "reason is required"),
	agentId: z.string().min(1).optional(),
});

// ── Scope resolution (fail-closed) ───────────────────────────────────────────

/**
 * Resolve the per-request {@link QueryScope} from the `x-honeycomb-*` headers (the
 * same tenancy the rest of the daemon reads). Returns `null` when no org is present
 * → the handler 400s (fail-closed; an unscoped request never falls back to a broad
 * read/write). This is the pure HEADER step; the local-mode default-scope fallback is
 * layered on at the handler via {@link resolveScopeOrLocalDefault} (PRD-022).
 */
export function resolveMemoryScope(c: Context): QueryScope | null {
	return resolveScopeFromHeaders(c);
}

/** The 400 body for a request with no resolvable tenancy. */
const NO_ORG_BODY = { error: "bad_request", reason: "x-honeycomb-org header is required" } as const;

/** Read + JSON-parse the request body, tolerating an empty/invalid body (returns `{}`). */
async function readJsonBody(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		// An absent or non-JSON body parses to `{}` so zod produces the field errors
		// (e.g. "query is required") rather than a generic parse failure.
		return {};
	}
}

/** Build a 400 response from zod issues (a-AC-5). */
function zodError(c: Context, error: z.ZodError): Response {
	return c.json(
		{
			error: "bad_request",
			reason: "request body failed validation",
			issues: error.issues.map((i) => ({ path: i.path.join("."), message: i.message })),
		},
		400,
	);
}

/**
 * Serialize a recall result for the HTTP response. The hits are forwarded VERBATIM —
 * including the PRD-027 fused `score`, provenance `kind` (distilled `memory` vs raw
 * `session`), and the `secondary` drill-down flag — so the dashboard/CLI render the
 * ENGINE's relevance score + order (D-4 repoints the client off its `1 - i*0.06` fake).
 */
function recallResponse(result: MemoryRecallResult): {
	hits: MemoryRecallResult["hits"];
	sources: string[];
	degraded: boolean;
} {
	return { hits: result.hits, sources: result.sources, degraded: result.degraded };
}

/**
 * Attach the `/api/memories/*` handlers onto the daemon's already-mounted
 * `/api/memories` route group (the 022a mount seam). Mirrors `mountDashboardApi`:
 * every handler resolves the request scope (fail-closed 400), zod-validates the
 * body (400 before the engine), and delegates to the existing recall / write /
 * read adapters. The group's runtime-path middleware already enforced the
 * `x-honeycomb-session` requirement (a-AC-6) before any of these run. Call ONCE
 * after `createDaemon(...)`. If the group is not mounted (unknown daemon shape)
 * the attach is a no-op.
 */
export function mountMemoriesApi(daemon: Daemon, options: MountMemoriesOptions): void {
	const group = daemon.group(MEMORIES_GROUP);
	if (group === undefined) return;

	const storage = options.storage;
	const writeDeps: MemoryWriteDeps = {
		storage,
		...(options.embed !== undefined ? { embed: options.embed } : {}),
	};
	// Scope precedence (PRD-022): header → (local-mode) injected default → null/400. The
	// fallback fires ONLY in local mode with a `defaultScope`; team/hybrid stay fail-closed.
	const resolveScope = (c: Context): QueryScope | null =>
		resolveScopeOrLocalDefault(c, daemon.config.mode, options.defaultScope);

	// ── a-AC-2 + PRD-025 AC-3: POST /api/memories/recall → recall engine (no 501). ─
	// The embed seam is threaded so recall can reach the `<#>` cosine path: when
	// present + the query embeds to a 768-dim vector, recall runs the semantic arm and
	// reports `degraded: false`; otherwise it degrades to the lexical arms (`degraded:
	// true`). The daemon defaults `embed` to the real client (D-1 default-on).
	group.post("/recall", async (c) => {
		const scope = resolveScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		const parsed = RecallBodySchema.safeParse(await readJsonBody(c));
		if (!parsed.success) return zodError(c, parsed.error);
		const result = await recallMemories(
			{ query: parsed.data.query, scope, ...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}) },
			{ storage, ...(options.embed !== undefined ? { embed: options.embed } : {}) },
		);
		return c.json(recallResponse(result));
	});

	// ── a-AC-3: POST /api/memories (store/remember) → controlled-writes (no 501). ─
	group.post("/", async (c) => {
		const scope = resolveScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		const parsed = StoreBodySchema.safeParse(await readJsonBody(c));
		if (!parsed.success) return zodError(c, parsed.error);
		const result = await storeMemory(
			{
				content: parsed.data.content,
				scope,
				...(parsed.data.normalizedContent !== undefined ? { normalizedContent: parsed.data.normalizedContent } : {}),
				...(parsed.data.type !== undefined ? { type: parsed.data.type } : {}),
				...(parsed.data.agentId !== undefined ? { agentId: parsed.data.agentId } : {}),
			},
			writeDeps,
		);
		return c.json({ id: result.outcome.memoryId ?? null, action: result.outcome.action }, 201);
	});

	// ── FR-4: GET /api/memories → list the scoped tenant's memories. ────────────
	group.get("/", async (c) => {
		const scope = resolveScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		const limit = resolveListLimit(parseQueryInt(c.req.query("limit")));
		const memories = await listMemories(limit, scope, { storage });
		return c.json({ memories });
	});

	// ── FR-4: GET /api/memories/:id → get one memory by id. ─────────────────────
	group.get("/:id", async (c) => {
		const scope = resolveScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		const id = c.req.param("id");
		const memory = await getMemory(id, scope, { storage });
		if (memory === null) return c.json({ error: "not_found", id }, 404);
		return c.json({ memory });
	});

	// ── a-AC-4: POST /api/memories/:id/modify → reason-gated + audited UPDATE. ───
	group.post("/:id/modify", async (c) => {
		const scope = resolveScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		const parsed = ModifyBodySchema.safeParse(await readJsonBody(c));
		if (!parsed.success) return zodError(c, parsed.error);
		const result = await modifyMemory(
			{
				id: c.req.param("id"),
				reason: parsed.data.reason,
				content: parsed.data.content,
				scope,
				...(parsed.data.agentId !== undefined ? { agentId: parsed.data.agentId } : {}),
			},
			writeDeps,
		);
		return c.json({ id: result.outcome.memoryId ?? null, action: result.outcome.action, audited: result.audited });
	});

	// ── a-AC-4: POST /api/memories/:id/forget → reason-gated + audited DELETE. ───
	group.post("/:id/forget", async (c) => {
		const scope = resolveScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		const parsed = ForgetBodySchema.safeParse(await readJsonBody(c));
		if (!parsed.success) return zodError(c, parsed.error);
		const result = await forgetMemory(
			{
				id: c.req.param("id"),
				reason: parsed.data.reason,
				scope,
				...(parsed.data.agentId !== undefined ? { agentId: parsed.data.agentId } : {}),
			},
			writeDeps,
		);
		return c.json({ id: result.outcome.memoryId ?? null, action: result.outcome.action, audited: result.audited });
	});
}

/** Parse a `?limit=` query param into a number, or `undefined` when absent/non-numeric. */
function parseQueryInt(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const n = Number(raw);
	return Number.isFinite(n) ? n : undefined;
}
