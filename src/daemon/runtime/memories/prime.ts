/**
 * The `GET /api/memories/prime` endpoint — PRD-046c (the prime-digest service).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * `mountMemoriesPrimeApi(daemon, { storage, defaultScope })` attaches ONE read handler onto the
 * already-mounted `/api/memories` SESSION route group (the same 022a seam `mountMemoriesApi`
 * uses) — mirroring that mount exactly: resolve the per-request {@link QueryScope} from the
 * `x-honeycomb-*` headers (fail-closed 400), then assemble the digest. ZERO edits to
 * `server.ts`: `/api/memories` is already scaffolded there behind the runtime-path + permission
 * middleware (`protect: true, session: true`), so attaching via `daemon.group("/api/memories")`
 * inherits auth/RBAC + the session gate. Call ONCE after `createDaemon(...)`.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── The read path is a single SQL skim — NO generation (c-AC-5) ──────────────
 * The handler issues ONE `skimPrimeKeys` call (the 046b pure-SQL reader: two guarded SELECTs,
 * no INSERT/UPDATE, no gate/vector/embed seam) and hands the result to the pure
 * {@link assemblePrimeDigest} transform. There is NO `EmbedClient`, NO gate CLI, NO vector
 * engine on this path by construction — the prime is the cheap, push-every-session index.
 *
 * ── Cold-repo degradation (c-AC-5) ───────────────────────────────────────────
 * `skimPrimeKeys` fails SOFT (a missing table on a fresh partition yields an empty skim, never a
 * throw), and the assembler renders an honest empty digest for an empty key set. So a cold scope
 * answers 200 with the "no memory yet" marker — never a 500, never a fabricated entry.
 *
 * ── Tenancy (c-AC-4) ─────────────────────────────────────────────────────────
 * The scope is resolved from the `x-honeycomb-*` headers (with the local-mode default-scope
 * fallback, exactly as `mountMemoriesApi`); the skim runs under that partition, so the prime
 * only ever surfaces keys within the requested org/workspace/agent.
 *
 * ── Response shape (zod-validated boundary) ──────────────────────────────────
 * The response body is validated against {@link PrimeResponseSchema} before it is sent, so the
 * contract the hook (046d) consumes is enforced at the boundary, not merely asserted.
 */

import type { Context } from "hono";
import { z } from "zod";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import type { Daemon } from "../server.js";
import { resolveScopeOrLocalDefault } from "../scope.js";
import {
	DEFAULT_KEY_SKIM_LIMIT,
	resolveKeySkimLimit,
	skimPrimeKeys,
} from "../summaries/prime-keys.js";
import {
	assemblePrimeDigest,
	type PrimeDigestBudget,
} from "../summaries/prime-digest.js";
// ISS-010: the injected-token meter. Fire-and-forget after the digest is assembled —
// `recordInjection` is fail-soft by contract (never throws), so the prime response is unchanged.
import { recordInjection } from "../telemetry/injection-log.js";
import { MEMORIES_GROUP } from "./api.js";

// Re-exported so `mountMemoriesApi` (api.ts) can register /prime before /:id using the SAME
// testable core + budget type this module owns, without re-importing from prime-digest directly.
export type { PrimeDigestBudget };

/** Options for {@link mountMemoriesPrimeApi}. Mirrors the storage/defaultScope half of {@link import("./api.js").MountMemoriesOptions}. */
export interface MountMemoriesPrimeOptions {
	/** The storage client the prime skim runs through (never a raw fetch). */
	readonly storage: StorageQuery;
	/**
	 * The daemon's configured default tenancy scope (PRD-022), threaded from the composition
	 * root. In LOCAL mode a request with no `x-honeycomb-org` falls back to this single tenant.
	 * ABSENT → pure header-only resolution (fail-closed). NEVER consulted outside local mode.
	 */
	readonly defaultScope?: QueryScope;
	/**
	 * The default budget knobs (token ceiling + per-list caps + the PRD-047c/d seams). Optional —
	 * the assembler defaults each. A per-request `?maxTokens` / `?limit` override is layered on
	 * top of these at the handler.
	 */
	readonly budget?: PrimeDigestBudget;
}

/** One prime entry in the response: the headline `key` + its opaque `ref` id (046e's resolve input). */
const PrimeEntrySchema = z.object({
	key: z.string(),
	ref: z.string(),
});

/**
 * The `GET /api/memories/prime` response contract (the boundary the 046d hook consumes). Validated
 * before send: the rendered `digest` block, the structured `recent` + `durable` lists, the token
 * estimate, and the honest `empty` cold-repo flag.
 */
export const PrimeResponseSchema = z.object({
	/** The rendered digest block (header + recent + durable + footer) — what the hook injects. */
	digest: z.string(),
	/** The recent-timestream entries that made the budget (newest-first). */
	recent: z.array(PrimeEntrySchema),
	/** The durable-fact entries that made the budget. */
	durable: z.array(PrimeEntrySchema),
	/** The estimated token cost of the digest block (the 4-chars/token heuristic). */
	tokens: z.number().int().nonnegative(),
	/** `true` when the scope had no memory yet (the honest empty digest). */
	empty: z.boolean(),
});

/** The validated response type the handler returns. */
export type PrimeResponse = z.infer<typeof PrimeResponseSchema>;

/** The 400 body for a request with no resolvable tenancy (mirrors `api.ts`'s `NO_ORG_BODY`). */
const NO_ORG_BODY = { error: "bad_request", reason: "x-honeycomb-org header is required" } as const;

/** Parse a `?limit=` / `?maxTokens=` query param into a positive integer, or `undefined` when absent/bad. */
export function parsePositiveInt(raw: string | undefined): number | undefined {
	if (raw === undefined) return undefined;
	const n = Number(raw);
	return Number.isFinite(n) && n > 0 ? Math.trunc(n) : undefined;
}

/**
 * Assemble the prime for a resolved scope (the testable core, factored out of the handler so a
 * unit test drives it directly without a daemon). Issues the SINGLE `skimPrimeKeys` call (the only
 * read seam — c-AC-5) then runs the pure {@link assemblePrimeDigest} transform. The per-source skim
 * `limit` is clamped by `resolveKeySkimLimit`; the budget overrides (token ceiling) ride
 * `budget`. Never throws for the expected failure modes — the skim fails soft to an empty digest.
 */
export async function buildPrimeForScope(
	storage: StorageQuery,
	scope: QueryScope,
	limit: number | undefined,
	budget: PrimeDigestBudget | undefined,
): Promise<PrimeResponse> {
	const skimLimit = resolveKeySkimLimit(limit ?? DEFAULT_KEY_SKIM_LIMIT);
	const keys = await skimPrimeKeys({ storage, scope }, skimLimit);
	const digest = assemblePrimeDigest(keys, budget ?? {});
	/**
	 * ISS-010 injected-token metering — HONESTY NOTE: this meters tokens SERVED in the prime
	 * digest, not tokens the harness ultimately injected into the model context. The hook
	 * dedupes across turns before injecting, so served >= injected; the KPI is an upper bound.
	 * Recorded ONLY for a non-empty digest with a positive token estimate; fire-and-forget
	 * (`void`) because `recordInjection` is fail-soft by contract (never throws), so the
	 * response contract below is byte-identical whether or not the telemetry append lands.
	 */
	if (!digest.empty && digest.tokens > 0) {
		void recordInjection(
			{
				source: "prime",
				hits: digest.recent.length + digest.durable.length,
				tokens: digest.tokens,
				sessionId: "",
				projectId: "",
			},
			{ storage },
			scope,
		);
	}
	return {
		digest: digest.text,
		recent: digest.recent.map((e) => ({ key: e.key, ref: e.ref })),
		durable: digest.durable.map((e) => ({ key: e.key, ref: e.ref })),
		tokens: digest.tokens,
		empty: digest.empty,
	};
}

/**
 * Attach `GET /api/memories/prime` onto the daemon's already-mounted `/api/memories` SESSION
 * group. The handler resolves the request scope (fail-closed 400), assembles the digest over
 * the single `skimPrimeKeys` read, validates the response against {@link PrimeResponseSchema},
 * and returns it. Call ONCE after `createDaemon(...)`. If the group is not mounted (unknown
 * daemon shape) the attach is a no-op.
 *
 * The group's runtime-path middleware already enforced the `x-honeycomb-session` requirement
 * before this handler runs (the same session-group posture as the rest of `/api/memories/*`).
 *
 * ── The route-shadow bug (why production ALSO mounts /prime inside mountMemoriesApi) ────────
 * Hono's RegExpRouter matches a literal segment vs a parametric segment (`/prime` vs `/:id`)
 * by REGISTRATION ORDER within the group. When this standalone mount runs AFTER
 * {@link mountMemoriesApi} (which registers `/:id`), the parametric route wins and `/prime`
 * 404s with `{error:"not_found", id:"prime"}` — the hook's fail-soft prime renderer swallows
 * the 404, so Claude Code SessionStart always received `{}` and never injected memories.
 *
 * The fix: {@link mountMemoriesApi} now registers `/prime` ITSELF, BEFORE `/:id`, via the
 * same {@link buildPrimeForScope} core. THIS standalone mount remains for callers/tests that
 * mount ONLY the prime route on a fresh daemon (no `/:id` to shadow — the unit-test path).
 * When BOTH are mounted (production), the earlier registration inside mountMemoriesApi wins
 * and this call harmlessly adds a duplicate handler that is never reached.
 */
export function mountMemoriesPrimeApi(daemon: Daemon, options: MountMemoriesPrimeOptions): void {
	const group = daemon.group(MEMORIES_GROUP);
	if (group === undefined) return;

	const storage = options.storage;
	const resolveScope = (c: Context): QueryScope | null =>
		resolveScopeOrLocalDefault(c, daemon.config.mode, options.defaultScope);

	// ── c-AC-1..5: GET /api/memories/prime → the assembled, token-bounded, deduped digest. ─
	group.get("/prime", async (c) => {
		const scope = resolveScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);

		// Optional per-request overrides: `?limit=` (per-source skim cap) + `?maxTokens=` (budget).
		const limit = parsePositiveInt(c.req.query("limit"));
		const maxTokens = parsePositiveInt(c.req.query("maxTokens"));
		const budget: PrimeDigestBudget = {
			...(options.budget ?? {}),
			...(maxTokens !== undefined ? { maxTokens } : {}),
		};

		const response = await buildPrimeForScope(storage, scope, limit, budget);
		// Validate the response shape at the boundary (the 046d hook's contract) before send.
		return c.json(PrimeResponseSchema.parse(response));
	});
}
