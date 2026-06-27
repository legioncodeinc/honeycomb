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

import { MEMORY_TYPES } from "../../../shared/memory-types.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import type { Daemon } from "../server.js";
import type { EmbedClient } from "../services/embed-client.js";
import type { RequestLogger } from "../logger.js";
import {
	resolveScopeFromHeaders,
	resolveScopeOrLocalDefault,
	resolveRequestProject,
	type RequestProjectScope,
} from "../scope.js";
import { recallMemories, type MemoryRecallResult } from "./recall.js";
import { RecencyConfigSchema, type RecencyConfig } from "../recall/config.js";
import { isValidRecallMode, type RecallMode } from "../vault/api.js";
import type { VaultStore } from "../vault/store.js";
import type { SecretScope } from "../secrets/contracts.js";
import { getMemory, listMemories, resolveListLimit } from "./reads.js";
import { readCalibrationIntrospection } from "./calibration-store.js";
import {
	forgetMemory,
	modifyMemory,
	storeMemory,
	type MemoryWriteDeps,
} from "./store.js";
import {
	DEFAULT_RESOLVE_TURNS,
	MAX_RESOLVE_TURNS,
	resolveRef,
	type ResolveResult,
} from "./resolve.js";
import type { KeySource } from "../summaries/prime-keys.js";

/** The route group the memories API attaches to (already mounted in `server.ts`). */
export const MEMORIES_GROUP = "/api/memories" as const;

/**
 * The structured event name emitted when a recall runs DEGRADED (PRD-029 / AC-4). A fixed,
 * greppable identifier — distinct from the pipeline's `decision.recall_degraded` — so the
 * dashboard live-log panel (Wave 2) and a test can filter on exactly this line.
 */
export const RECALL_DEGRADED_EVENT = "recall.degraded" as const;

/**
 * PRD-049b (D8): the structured event emitted when a recall could NOT resolve its session
 * project (no cwd available) and fell back to the workspace `__unsorted__` inbox + workspace-
 * global rows. A fixed, greppable identifier so the dashboard + a test can filter on exactly
 * this line. Carries NO query text/org/cwd — only the coarse degraded fact (D-5 secret-free).
 */
export const PROJECT_SCOPE_DEGRADED_EVENT = "recall.project_scope_degraded" as const;

/** The visible warning string a project-scope-degraded recall response carries (D8). */
export const PROJECT_SCOPE_DEGRADED_WARNING: string =
	"project scoping degraded: no working directory was resolvable for this session, so recall " +
	"was narrowed to the workspace inbox + workspace-global rows only (no project could be resolved).";

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
	/**
	 * The daemon's ring-buffer logger (PRD-029 / AC-4). When supplied, a recall that runs
	 * DEGRADED (embeddings off/unreachable → BM25/ILIKE lexical fallback) emits ONE structured
	 * `recall.degraded` event capturing the degraded MODE + the arm coverage — subsystem state
	 * ONLY, never the query text/token/org/header (D-5). ABSENT (a unit-constructed mount) → no
	 * event (the prior behaviour). The composition root threads `daemon.logger`.
	 */
	readonly logger?: RequestLogger;
	/**
	 * The vault `setting`-class READER (PRD-044c). When present, the `/api/memories/recall` handler
	 * reads the user-selected `recallMode` setting AT RECALL TIME — under the SAME per-request scope
	 * the recall runs (so read tenancy matches the settings-API write) — and threads it into
	 * {@link recallMemories} to gate the semantic arm (`keyword` → lexical-only, not degraded). The
	 * read is FAIL-SOFT: an absent reader, a missing/unset key, an undecryptable record, or any throw
	 * is treated as UNSET → today's PRD-025 behavior is preserved EXACTLY. The composition root threads
	 * the same real {@link VaultStore} the `/api/settings` surface writes through; a unit-constructed
	 * mount omits it (the deterministic suite is unchanged). Narrowed to the single `getSetting` method.
	 */
	readonly vault?: VaultSettingsReader;
	/**
	 * PRD-058b: the conflict-suppression seam (the `κ(m,t)` gate). When supplied, the recall handler threads
	 * it into {@link recallMemories} so the LAST currentness filter drops the `κ = ρ` open-conflict loser
	 * (the `κ = 0` hard-superseded losers are already excluded by supersession). ABSENT → no κ gate (the
	 * dormant pre-058b path). FAIL-SOFT inside the engine: a missing/unreadable `memory_conflicts` table
	 * degrades to returning BOTH sides, never a 500. The composition root threads
	 * `createConflictSuppressionSource(storage)`.
	 */
	readonly conflictSuppression?: import("./recall.js").ConflictSuppressionSource;
	/**
	 * PRD-063c: the resolved reranker config (strategy + timeouts + window + cohere model). When
	 * supplied, the recall handler threads it into {@link recallMemories} so the operator-selected
	 * strategy (`HONEYCOMB_RECALL_RERANKER`, e.g. `cohere`) is honored. ABSENT → the engine applies its
	 * DEFAULT (`none`, RRF-only) — byte-identical to today (c-AC-4). The composition root resolves it
	 * via `resolveRecallConfig().reranker`.
	 */
	readonly reranker?: import("../recall/config.js").RerankerConfig;
	/**
	 * PRD-063c: the Cohere-via-Portkey rerank seam (c-D-2). Supplied by the composition root ONLY when
	 * the Portkey gateway is ON (`portkey.enabled`); it closes over the resolved `${SECRET_REF}` key +
	 * the Portkey config + the unreachable health signal, so the recall engine never sees the key
	 * (c-AC-2). Threaded into {@link recallMemories} as `cohereRerank`. ABSENT → the `cohere` strategy
	 * has no transport and degrades to the RRF order (c-AC-4 / c-AC-3). The seam is consumed by SHAPE
	 * (structurally satisfies the engine's `CohereRerankSeam`).
	 */
	readonly cohereRerank?: import("./recall.js").CohereRerankSeam;
}

/**
 * The narrow vault READ surface the recall handler needs (PRD-044c) — the single `getSetting`
 * method, structurally satisfied by the real {@link VaultStore}. Mirrors `assemble.ts`'s
 * `VaultSettingsReader` (kept local to avoid an `api → assemble` import cycle, since `assemble`
 * imports this module). A test injects a three-line `getSetting`-shaped stub.
 */
export type VaultSettingsReader = Pick<VaultStore, "getSetting">;

/** The vault `setting` key the recall mode is persisted under (PRD-044c). Matches `vault/api.ts`. */
export const RECALL_MODE_SETTING_KEY = "recallMode" as const;

// ── Zod request schemas (a-AC-5 / FR-6) ──────────────────────────────────────

/**
 * The boundary ceiling for the recall `tokenBudget` (PRD-047e). The MMR/budget stage only ever
 * iterates the fused candidate pool (capped at `MAX_RECALL_LIMIT`, ≤200) — the budget value
 * NEVER scales an allocation or a loop, so a huge budget cannot drive O(n) blowup. This cap is
 * DEFENSE-IN-DEPTH and contract hygiene: it makes the documented "sane cap" real at the zod
 * boundary, rejects an absurd/garbage budget with a 400 (never a silent coerce), and is set far
 * above any realistic model context window (10M tokens) so no legitimate request is affected.
 */
export const MAX_RECALL_TOKEN_BUDGET = 10_000_000;

/**
 * `POST /api/memories/recall` body: a query string + optional limit + optional token budget.
 *
 * `tokenBudget` (PRD-047e / e-AC-1) is ADDITIVE + OPTIONAL: when supplied, recall returns the
 * token-budgeted, diversity-aware (MMR) selection that FITS the budget instead of a fixed count;
 * when ABSENT, the row-`limit` path runs byte-for-byte as before (e-AC-4 back-compat). Validated
 * as a positive int BOUNDED at {@link MAX_RECALL_TOKEN_BUDGET} at the boundary; a non-positive,
 * out-of-range, or garbage value is rejected (zod 400) rather than silently coerced, and the
 * engine ALSO guards it (defense in depth).
 */
/**
 * The OPTIONAL per-request recency override (PRD-058a API spec). A caller may override the per-class
 * half-lives (AC-55a.2.2) and/or the activation exponent `a` in `A^a` for THIS recall; an absent field
 * (or an absent `recency` object) falls back to the engine default, the DOCUMENTED per-class half-life
 * and `activationExponent = 1.0`, so recency stays LIVE, never the 100-year neutral (AC-55a.2.3). Each
 * half-life is a positive number in DAYS; `activationExponent` is `≥ 0` (`0` = neutral). Validated at the
 * boundary (zod 400 on a structurally-bad value); the engine ALSO clamps (defense in depth).
 */
const RecencyOverrideSchema = z
	.object({
		halfLifeDaysByClass: z
			.object({
				memories: z.number().positive().optional(),
				memory: z.number().positive().optional(),
				sessions: z.number().positive().optional(),
			})
			.optional(),
		activationExponent: z.number().min(0).optional(), // the `a` in A^a; 0 = neutral.
	})
	.optional();

const RecallBodySchema = z.object({
	query: z.string().min(1, "query is required"),
	limit: z.number().int().positive().optional(),
	tokenBudget: z.number().int().positive().max(MAX_RECALL_TOKEN_BUDGET).optional(),
	/**
	 * PRD-058a: the OPTIONAL per-request recency override ({@link RecencyOverrideSchema}). ABSENT → the
	 * engine's per-class defaults + `activationExponent = 1.0` (recency live by default). Threaded into
	 * the engine deps as the `recency` config so the override is honored over the defaults (AC-55a.2.2).
	 */
	recency: RecencyOverrideSchema,
	/**
	 * PRD-049b (49b-AC-2): the session working directory the recall ran in. The daemon resolves
	 * the project from it (049a `resolveScope(cwd)`) and ANDs the project-segment predicate into
	 * every recall arm, so a recall in project A never returns a project-B row. ABSENT (a harness
	 * that does not pass cwd, or the `x-honeycomb-cwd` header instead) → the daemon falls to the
	 * cwd header, then to the workspace `__unsorted__` inbox + workspace-global with a visible
	 * degraded-scoping warning (D8 / 49b-AC-3). Optional + back-compat: an omitted cwd is the
	 * unbound inbox session, never an error.
	 */
	cwd: z.string().optional(),
});

/**
 * `POST /api/memories` (store) body: content + optional type/normalized/agent.
 *
 * `type` is the CLOSED taxonomy gate (the user-facing write surface): it validates
 * against the single-sourced {@link MEMORY_TYPES} set, so an unknown type is REJECTED
 * with a 400 that NAMES the valid set (never silently coerced). Unset → the column
 * default `fact` is applied downstream (`controlled-writes.ts` `factType ?? "fact"`),
 * so the column DDL `TEXT NOT NULL DEFAULT 'fact'` is unchanged (no schema migration).
 * This gate constrains ONLY this user-facing path; the autonomous capture pipeline
 * (`fan-out.ts` → controlled-writes) enqueues its model-assigned `fact_type` directly
 * and never passes through here, so a free-form internal type is not broken.
 */
// Exported so the taxonomy parity suite asserts the REAL gate's `type` enum (not a
// reconstruction) — a future hardcode of the daemon enum then fails parity directly.
export const StoreBodySchema = z.object({
	content: z.string().min(1, "content is required"),
	normalizedContent: z.string().optional(),
	type: z
		.enum(MEMORY_TYPES, {
			error: () => `type must be one of: ${MEMORY_TYPES.join(", ")}`,
		})
		.optional(),
	agentId: z.string().min(1).optional(),
	/**
	 * PRD-049b (49b-AC-1): the session cwd the store ran in. The daemon resolves the `project_id`
	 * from it (049a) so the stored memory is segmented by the SAME project a recall in that folder
	 * narrows to. ABSENT → the `__unsorted__` inbox (never dropped, never mis-attributed). Optional
	 * + back-compat: an omitted cwd stores to the inbox, never an error.
	 */
	cwd: z.string().optional(),
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
function recallResponse(
	result: MemoryRecallResult,
	project?: RequestProjectScope,
): {
	hits: MemoryRecallResult["hits"];
	sources: string[];
	degraded: boolean;
	projectScopeDegraded?: boolean;
	warning?: string;
} {
	const base = { hits: result.hits, sources: result.sources, degraded: result.degraded };
	// PRD-049b (D8): when the project could not be resolved (no cwd), surface a VISIBLE warning
	// + a boolean flag so the caller knows recall was not project-narrowed. Omitted when the
	// project resolved (a bound or inbox session WITH a cwd) — the field is additive, back-compat.
	if (project !== undefined && project.degraded) {
		return { ...base, projectScopeDegraded: true, warning: PROJECT_SCOPE_DEGRADED_WARNING };
	}
	return base;
}

/**
 * Emit the structured `recall.project_scope_degraded` event (PRD-049b / D8) when — and ONLY
 * when — a recall could not resolve its session project (no cwd available) and fell back to the
 * inbox + workspace-global rows. Subsystem state ONLY: a fixed `mode` tag, no query/org/cwd.
 * A project-resolved recall (bound OR inbox-with-cwd) logs NOTHING.
 */
function logProjectScopeDegraded(logger: RequestLogger | undefined, project: RequestProjectScope): void {
	if (logger === undefined || !project.degraded) return;
	logger.event(PROJECT_SCOPE_DEGRADED_EVENT, { mode: "inbox_global_fallback" });
}

/**
 * Emit the structured `recall.degraded` event (PRD-029 / AC-4) when — and ONLY when — a
 * recall ran DEGRADED (the lexical BM25/ILIKE fallback, embeddings off/unreachable). The
 * fields are SUBSYSTEM STATE ONLY (D-5): a fixed `mode: "lexical_fallback"` tag plus the arm
 * coverage (`sources` — the distinct table/arm NAMES like `memories`/`sessions`). It carries
 * NO query text, token, org GUID, or header value — the recall result exposes none of those,
 * and we forward only the two coarse fields. A non-degraded recall logs NOTHING.
 */
function logDegradedRecall(logger: RequestLogger | undefined, result: MemoryRecallResult): void {
	if (logger === undefined || !result.degraded) return;
	logger.event(RECALL_DEGRADED_EVENT, {
		// The degraded MODE: recall fell back to the lexical arms (no semantic `<#>` cosine).
		mode: "lexical_fallback",
		// The arm coverage — the distinct arm names that surfaced a hit (`memories`/`memory`/
		// `sessions`). Plain subsystem names; never row content or a secret.
		sources: result.sources,
	});
}

/** Map a recall {@link QueryScope} to the {@link SecretScope} the vault `setting` is partitioned under. */
function secretScopeOf(scope: QueryScope): SecretScope {
	// The settings-API write resolves `workspace` defaulting to "default" (`headerScopeResolver`);
	// mirror that here so a recall under the same headers reads the SAME partition it was written to.
	return { org: scope.org, workspace: scope.workspace ?? "default" };
}

/**
 * READ the user-selected `recallMode` vault setting (PRD-044c) for `scope`, FAIL-SOFT. Returns a
 * validated {@link RecallMode} ONLY when the reader is present, the key is set + readable, and the
 * value passes the SAME closed-enum gate the settings API applied on write (`isValidRecallMode`,
 * defense in depth). An ABSENT reader, a missing/unset key, an undecryptable record, an out-of-enum
 * value, or ANY throw → `undefined` (UNSET) — preserving today's PRD-025 behavior EXACTLY. NEVER
 * throws: a vault hiccup must never fail a recall, only fall back to the behavior-neutral default.
 */
async function readRecallMode(
	vault: VaultSettingsReader | undefined,
	scope: QueryScope,
): Promise<RecallMode | undefined> {
	if (vault === undefined) return undefined;
	try {
		const res = await vault.getSetting(RECALL_MODE_SETTING_KEY, secretScopeOf(scope));
		if (!res.ok) return undefined;
		const value = String(res.value);
		return isValidRecallMode(value) ? value : undefined;
	} catch {
		// A malformed/undecryptable/missing vault setting must never fail recall — treat as UNSET.
		return undefined;
	}
}

/**
 * Resolve the optional per-request recency override (PRD-058a) into the engine's {@link RecencyConfig},
 * or `undefined` when no override is supplied (→ the engine applies its per-class defaults +
 * activationExponent 1.0). The override's `halfLifeDaysByClass` / `activationExponent` are parsed
 * through {@link RecencyConfigSchema} so they clamp + default identically to a config-sourced recency
 * config (the zod boundary already rejected a structurally-bad value with a 400). An empty override
 * object (`{}`) is treated as "no override" → `undefined`, so the defaults stand.
 */
function resolveRecencyOverride(
	override: { halfLifeDaysByClass?: { memories?: number; memory?: number; sessions?: number }; activationExponent?: number } | undefined,
): RecencyConfig | undefined {
	if (override === undefined) return undefined;
	const hasClass = override.halfLifeDaysByClass !== undefined;
	const hasExponent = override.activationExponent !== undefined;
	if (!hasClass && !hasExponent) return undefined; // an empty `{}` override → keep the engine defaults.
	return RecencyConfigSchema.parse({
		...(hasClass ? { halfLifeDaysByClass: override.halfLifeDaysByClass } : {}),
		...(hasExponent ? { activationExponent: override.activationExponent } : {}),
	});
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
		// PRD-044c: read the user-selected `recallMode` setting AT RECALL TIME, under this request's
		// scope, FAIL-SOFT (an unreadable/unset setting → undefined → today's behavior). Threaded into
		// the engine deps to gate the semantic arm (`keyword` → lexical-only, NOT degraded).
		const recallMode = await readRecallMode(options.vault, scope);
		// PRD-049b (49b-AC-2): resolve the session's project from the cwd (body or the
		// `x-honeycomb-cwd` header) so the project-segment predicate is ANDed into every arm.
		// No resolvable cwd falls to inbox + workspace-global with the D8 warning.
		const project = resolveRequestProject(c, scope, parsed.data.cwd);
		// PRD-058a: build the per-request recency config from the optional override. ABSENT → undefined
		// so the engine applies its per-class defaults + activationExponent 1.0 (recency live by default,
		// AC-55a.2.3). A present override is honored over the defaults (AC-55a.2.2).
		const recency = resolveRecencyOverride(parsed.data.recency);
		const result = await recallMemories(
			{
				query: parsed.data.query,
				scope,
				// PRD-049b (49b-AC-2): the resolved project segment threaded into recall.
				projectId: project.projectId,
				projectBound: project.bound,
				...(parsed.data.limit !== undefined ? { limit: parsed.data.limit } : {}),
				// PRD-047e: thread the optional token budget through. ABSENT → the engine skips the
				// MMR/budget stage and runs the unchanged fixed top-`limit` path (e-AC-4).
				...(parsed.data.tokenBudget !== undefined ? { tokenBudget: parsed.data.tokenBudget } : {}),
			},
			{
				storage,
				...(options.embed !== undefined ? { embed: options.embed } : {}),
				...(recallMode !== undefined ? { recallMode } : {}),
				// PRD-058a: the per-request recency override (per-class half-lives + activation exponent).
				...(recency !== undefined ? { recency } : {}),
				// PRD-058b: the κ gate's conflict-suppression seam (drops the κ = ρ open-conflict loser).
				...(options.conflictSuppression !== undefined ? { conflictSuppression: options.conflictSuppression } : {}),
				// PRD-063c: the operator-selected reranker config + the Cohere-via-Portkey seam. The
				// `cohere` strategy activates ONLY when BOTH are present (the strategy is `cohere` AND the
				// gateway-on seam is wired); otherwise the engine keeps the RRF order / runs the local
				// cosine path — byte-identical to today (c-AC-4).
				...(options.reranker !== undefined ? { reranker: options.reranker } : {}),
				...(options.cohereRerank !== undefined ? { cohereRerank: options.cohereRerank } : {}),
			},
		);
		// PRD-029 (AC-4): when this recall ran DEGRADED (lexical fallback), emit one
		// structured `recall.degraded` event with the mode + arm coverage. No-op otherwise
		// and when no logger is wired. Secret-free by construction (see logDegradedRecall).
		logDegradedRecall(options.logger, result);
		// PRD-049b (D8): when no cwd was resolvable, project scoping degraded to inbox+global;
		// emit a structured warning so the degrade is visible (silent-when-surprising guard).
		logProjectScopeDegraded(options.logger, project);
		return c.json(recallResponse(result, project));
	});

	// ── a-AC-3: POST /api/memories (store/remember) → controlled-writes (no 501). ─
	group.post("/", async (c) => {
		const scope = resolveScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		const parsed = StoreBodySchema.safeParse(await readJsonBody(c));
		if (!parsed.success) return zodError(c, parsed.error);
		// PRD-049b (49b-AC-1): resolve the store's project from the cwd so the memory is segmented
		// by the SAME project a recall in that folder narrows to (no cwd → the `__unsorted__` inbox).
		const storeProject = resolveRequestProject(c, scope, parsed.data.cwd);
		const result = await storeMemory(
			{
				content: parsed.data.content,
				scope,
				projectId: storeProject.projectId,
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
		// PRD-049e (49e-AC-2): when the dashboard stamps a SELECTED project (the `x-honeycomb-project`
		// header), narrow the list to that project's rows via the SHARED project-segment predicate — the
		// SAME clause recall ANDs. With NO selection AND no cwd, `resolveRequestProject` returns the
		// degraded inbox fallback; we treat THAT as "no project filter" (the list stays project-agnostic,
		// back-compat) so a non-dashboard caller (the CLI/SDK list) is unchanged. A real selection (bound,
		// or the explicit inbox) narrows the list.
		const project = resolveRequestProject(c, scope);
		const memories = await listMemories(
			limit,
			scope,
			{ storage },
			project.degraded ? undefined : { projectId: project.projectId, bound: project.bound },
		);
		return c.json({ memories });
	});

	// ── e-AC-1: GET /api/memories/resolve → depth-zoom by ref (PRD-046e). ─────────
	// MUST be registered BEFORE GET /:id — Hono matches routes in order and "resolve"
	// is a literal segment that would otherwise be captured as the :id parameter.
	group.get("/resolve", async (c) => {
		const scope = resolveScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);

		const ref = c.req.query("ref") ?? "";
		if (ref.trim() === "") return c.json({ error: "bad_request", reason: "ref is required" }, 400);

		const rawDepth = parseQueryInt(c.req.query("depth"));
		const depth: 1 | 2 = rawDepth === 2 ? 2 : 1;

		const rawSource = c.req.query("source");
		const source: KeySource = rawSource === "durable" ? "durable" : "episodic";

		const rawTurns = parseQueryInt(c.req.query("turns"));
		const turnLimit = rawTurns !== undefined
			? Math.max(1, Math.min(Math.trunc(rawTurns), MAX_RESOLVE_TURNS))
			: DEFAULT_RESOLVE_TURNS;

		const result: ResolveResult = await resolveRef(ref, depth, source, scope, { storage }, turnLimit);
		if (!result.found) {
			return c.json({ found: false, ref, depth, source }, 200);
		}
		// Shape result as a plain serializable object (ResolveResult is a discriminated union).
		if (result.depth === 1) {
			return c.json({ found: true, ref, depth: 1, source: result.source, row: result.row }, 200);
		}
		if (result.source === "episodic") {
			return c.json({ found: true, ref, depth: 2, source: "episodic", turns: result.turns, turnLimit }, 200);
		}
		return c.json({ found: true, ref, depth: 2, source: "durable", row: result.row }, 200);
	});

	// ── PRD-058e: GET /api/memories/calibration → calibration introspection. ────
	// MUST be registered BEFORE GET /:id — "calibration" is a literal segment that
	// would otherwise be captured as the :id parameter (same ordering rule as /resolve).
	// Scope-enforced (fail-closed 400 with no resolvable tenancy); FAIL-SOFT read (no
	// curve yet → the cold-start identity shape, never a 500). NO write surface here:
	// `recordAccess` is daemon-internal so reinforcement cannot be spoofed (PRD-058e).
	group.get("/calibration", async (c) => {
		const scope = resolveScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		// PRD-058e D-2: `memory_calibration` is agent-scoped, so the introspection read narrows to the
		// owning agent's slice (an `?agent_id=` query selects it; absent → the schema default agent).
		// Without this an operator could read another agent's calibration curve in a shared workspace.
		const agentId = c.req.query("agent_id");
		const agent = agentId !== undefined && agentId !== "" ? { agentId } : undefined;
		const introspection = await readCalibrationIntrospection(storage, scope, undefined, agent);
		return c.json(introspection);
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
