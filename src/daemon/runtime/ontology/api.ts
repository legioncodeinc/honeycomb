/**
 * The `/api/ontology/*` mount seam — PRD-045c (closes the PRD-008 daemon-wiring gap).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * `mountOntologyApi(daemon, { storage, ... })` is the single named step the composition
 * root (`assemble.ts`) calls AFTER `createDaemon(...)` to attach the knowledge-graph /
 * ontology READ + reason-gated MUTATION handlers onto the already-mounted `/api/ontology`
 * route group — mirroring `mountGraphApi` (`codebase/api.ts`) and `mountDashboardApi`.
 * ZERO edits to `server.ts`: the `/api/ontology` group is ALREADY scaffolded there behind
 * the permission middleware (`ROUTE_GROUPS`: `{ path: "/api/ontology", protect: true,
 * session: false }`, server.ts:88), so attaching via `daemon.group("/api/ontology")`
 * inherits auth/RBAC with NO re-wiring.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── No route collision (audit: `/api/graph` is double-registered) ────────────
 * The audit flagged that BOTH `mountDashboardApi` and `mountGraphApi` register
 * `GET /api/graph`. This module is the ONLY mount that owns `/api/ontology` — no other
 * seam (dashboard / product-data / graph) registers any `/api/ontology/*` path — so the
 * surface has a single owner and there is no shadowing. The dashboard's memory-graph view
 * lives at `/api/diagnostics/memory-graph` (a different group), not under `/api/ontology`.
 *
 * ── What it wires (replacing the PRD-008 501 scaffold) ───────────────────────
 *   GET  /api/ontology              → a small index of the available sub-resources.
 *   GET  /api/ontology/entities     → the canonical entity nodes (id/name/type), bounded.
 *   GET  /api/ontology/edges        → the audited dependency edges
 *                                     (source/target/type/reason), bounded.
 *   GET  /api/ontology/claims       → the CURRENT (highest-version, status='active')
 *                                     claim attributes per claim_key — superseded claims
 *                                     are NOT returned (they are tombstoned, c-AC-4).
 *   GET  /api/ontology/assertions   → the epistemic-assertion attribution rows, bounded.
 *   POST /api/ontology/proposals    → submit a control-plane proposal (reason-gated):
 *                                     a bounded explicit op applies DIRECTLY; a broad /
 *                                     risky / generated-batch op enters the PENDING review
 *                                     queue (NOT applied) — exactly `submitProposal`'s
 *                                     risk routing (008c D-6). Live supersession runs here
 *                                     via a `claim.supersede` op, independent of pollinating.
 *
 * ── built:false / empty is the honest state, never a 501 ─────────────────────
 * PRD-008 tables may be empty (a cold scope) or, on an older schema, absent. Every read
 * fails SOFT to `[]` on ANY non-ok result (a missing table → an empty read, never a
 * throw), so a cold ontology answers `{ entities: [] }` etc. — an honest empty body, NOT
 * a 501. The read surface is ALWAYS live.
 *
 * ── Engine-scoped tables (knowledge-graph.ts D-2) ────────────────────────────
 * `entities` / `entity_dependencies` / `entity_attributes` / `epistemic_assertions` are
 * ENGINE tables: they carry `agent_id` + `visibility`, NOT explicit org/workspace columns.
 * Org/workspace isolation rides `storage.query(sql, scope)` (the storage partition). The
 * reads carry no `org_id` predicate by construction; identifiers route through `sqlIdent`
 * and there is no interpolated value in the static projections (a-AC-7 SQL-safety floor).
 *
 * No secret rides any response by construction: entity name/type, edge type/reason, claim
 * content, and assertion subject/object are graph text, never a token/credential.
 */

import type { Context } from "hono";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import type { Daemon } from "../server.js";
import { resolveScopeOrLocalDefault } from "../scope.js";
import { submitProposal } from "./control-plane.js";

/** The route group the ontology API attaches to (already mounted in `server.ts`). */
export const ONTOLOGY_GROUP = "/api/ontology" as const;

/**
 * A defensive cap on the rows a single ontology read returns. A populated graph must never
 * ship an unbounded payload to the page (mirrors the dashboard memory-graph's
 * `MEMORY_GRAPH_LIMIT`). The page renders whatever the endpoint returns.
 */
const ONTOLOGY_READ_LIMIT = 500;

/** Options for {@link mountOntologyApi}. Mirrors {@link import("../codebase/api.js").MountGraphOptions}. */
export interface MountOntologyOptions {
	/** The storage client every read/mutation runs through (never a raw fetch). */
	readonly storage: StorageQuery;
	/**
	 * The daemon's configured default tenancy scope, threaded from the composition root
	 * (PRD-022). In LOCAL mode a request with no `x-honeycomb-org` header falls back to this
	 * single configured tenant. ABSENT → pure header-only resolution (fail-closed 400).
	 */
	readonly defaultScope?: QueryScope;
}

/** The 400 body for a request with no resolvable tenancy (fail-closed). */
const NO_ORG_BODY = { error: "bad_request", reason: "x-honeycomb-org header is required" } as const;

/** Stringify a storage cell defensively (null/undefined → ""). */
function toStr(value: unknown): string {
	return value === undefined || value === null ? "" : String(value);
}

/** Coerce a storage cell to a finite number (fallback when absent / non-numeric). */
function toNum(value: unknown, fallback: number): number {
	const n = typeof value === "number" ? value : Number(value);
	return Number.isFinite(n) ? n : fallback;
}

/**
 * Run a SELECT through the storage seam, returning rows or `[]` on any non-ok result
 * (fail-soft). A THROW from `storage.query` (a dropped socket, an SDK exception, a rejected
 * promise) is ALSO degraded to `[]` here — a read route never bubbles a 500 for a transport
 * fault; the module's read contract is "an honest empty body, never a crash" (c-AC-5).
 */
async function selectRows(storage: StorageQuery, sql: string, scope: QueryScope): Promise<StorageRow[]> {
	try {
		const result = await storage.query(sql, scope);
		return isOk(result) ? result.rows : [];
	} catch {
		// A thrown storage error is treated identically to a non-ok result: the cold/absent/
		// unreachable read degrades to empty rather than failing the route (fail-soft read).
		return [];
	}
}

// ── Read builders (identifiers via `sqlIdent`; no interpolated value) ──────────

/** The `entities` read → nodes (id/name/type). Newest-first by `updated_at`. */
function buildEntitiesSql(): string {
	const tbl = sqlIdent("entities");
	return (
		`SELECT ${sqlIdent("id")}, ${sqlIdent("name")}, ${sqlIdent("type")} ` +
		`FROM "${tbl}" ORDER BY ${sqlIdent("updated_at")} DESC LIMIT ${ONTOLOGY_READ_LIMIT}`
	);
}

/** The `entity_dependencies` read → edges (source/target/type/reason). Newest-first by `created_at`. */
function buildEdgesSql(): string {
	const tbl = sqlIdent("entity_dependencies");
	return (
		`SELECT ${sqlIdent("source_entity_id")}, ${sqlIdent("target_entity_id")}, ${sqlIdent("type")}, ` +
		`${sqlIdent("reason")} FROM "${tbl}" ORDER BY ${sqlIdent("created_at")} DESC LIMIT ${ONTOLOGY_READ_LIMIT}`
	);
}

/**
 * The CURRENT-claims read: the highest-`version` row per `claim_key` with `status='active'`.
 * A superseded claim's prior id reads as `status='superseded'` at its highest version, so
 * filtering to `status='active'` returns ONLY live claims — a tombstoned claim is observably
 * EXCLUDED here while it still sits on disk (c-AC-4). The status value routes through
 * `sLiteral`; identifiers through `sqlIdent`.
 */
function buildClaimsSql(): string {
	const tbl = sqlIdent("entity_attributes");
	return (
		`SELECT ${sqlIdent("id")}, ${sqlIdent("aspect_id")}, ${sqlIdent("claim_key")}, ${sqlIdent("content")}, ` +
		`${sqlIdent("kind")}, ${sqlIdent("status")}, ${sqlIdent("confidence")}, ${sqlIdent("version")}, ` +
		`${sqlIdent("memory_id")} FROM "${tbl}" ` +
		`WHERE ${sqlIdent("status")} = ${sLiteral("active")} ` +
		`ORDER BY ${sqlIdent("version")} DESC LIMIT ${ONTOLOGY_READ_LIMIT}`
	);
}

/** The `epistemic_assertions` read → attribution rows. Newest-first by `created_at`. */
function buildAssertionsSql(): string {
	const tbl = sqlIdent("epistemic_assertions");
	return (
		`SELECT ${sqlIdent("id")}, ${sqlIdent("stance")}, ${sqlIdent("subject")}, ${sqlIdent("predicate")}, ` +
		`${sqlIdent("object")}, ${sqlIdent("confidence")}, ${sqlIdent("status")}, ${sqlIdent("version")} ` +
		`FROM "${tbl}" ORDER BY ${sqlIdent("created_at")} DESC LIMIT ${ONTOLOGY_READ_LIMIT}`
	);
}

/** Read a JSON body defensively; a non-JSON / empty body → `{}` (the handler validates). */
async function readJson(c: Context): Promise<Record<string, unknown>> {
	try {
		const body: unknown = await c.req.json();
		if (body && typeof body === "object" && !Array.isArray(body)) {
			return body as Record<string, unknown>;
		}
	} catch {
		// A non-JSON body is not a crash — the handler treats it as missing fields.
		return {};
	}
	return {};
}

/** Resolve the agent id for a request from the optional `x-honeycomb-agent` header (default `default`). */
function resolveAgentId(c: Context): string {
	const agent = c.req.header("x-honeycomb-agent");
	return agent !== undefined && agent.length > 0 ? agent : "default";
}

/**
 * Attach the `/api/ontology/*` handlers onto the daemon's already-mounted `/api/ontology`
 * route group (the PRD-045c assembly seam). Mirrors `mountGraphApi`: every handler resolves
 * the request scope (fail-closed 400 outside local), then reads/mutates through the injected
 * storage client with guarded SQL. Call ONCE after `createDaemon(...)`. If the group is not
 * mounted (unknown daemon shape) the attach is a no-op. Reads fail SOFT to an empty body
 * (never a 501); a mutation error is reported as a 500 data body — never an unhandled throw
 * that crashes the request pipeline or the daemon.
 */
export function mountOntologyApi(daemon: Daemon, options: MountOntologyOptions): void {
	const group = daemon.group(ONTOLOGY_GROUP);
	if (group === undefined) return;

	const storage = options.storage;
	const resolveScope = (c: Context): QueryScope | null =>
		resolveScopeOrLocalDefault(c, daemon.config.mode, options.defaultScope);

	// GET /api/ontology — a small index of the live sub-resources (never a 501).
	group.get("/", (c) => {
		const scope = resolveScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		return c.json({
			resources: ["entities", "edges", "claims", "assertions"],
			mutations: ["proposals"],
		});
	});

	// GET /api/ontology/entities — the canonical entity nodes (c-AC-2 / c-AC-3).
	group.get("/entities", async (c) => {
		const scope = resolveScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		const rows = await selectRows(storage, buildEntitiesSql(), scope);
		const entities = rows.map((r) => ({ id: toStr(r.id), name: toStr(r.name), type: toStr(r.type) }));
		return c.json({ entities });
	});

	// GET /api/ontology/edges — the audited dependency edges.
	group.get("/edges", async (c) => {
		const scope = resolveScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		const rows = await selectRows(storage, buildEdgesSql(), scope);
		const edges = rows.map((r) => ({
			source: toStr(r.source_entity_id),
			target: toStr(r.target_entity_id),
			type: toStr(r.type),
			reason: toStr(r.reason),
		}));
		return c.json({ edges });
	});

	// GET /api/ontology/claims — the CURRENT (active, highest-version) claims; superseded
	// claims are tombstoned and EXCLUDED here while still on disk (c-AC-4).
	group.get("/claims", async (c) => {
		const scope = resolveScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		const rows = await selectRows(storage, buildClaimsSql(), scope);
		const claims = rows.map((r) => ({
			id: toStr(r.id),
			aspectId: toStr(r.aspect_id),
			claimKey: toStr(r.claim_key),
			content: toStr(r.content),
			kind: toStr(r.kind),
			status: toStr(r.status),
			confidence: toNum(r.confidence, 0),
			version: toNum(r.version, 1),
			memoryId: toStr(r.memory_id),
		}));
		return c.json({ claims });
	});

	// GET /api/ontology/assertions — the epistemic-assertion attribution rows.
	group.get("/assertions", async (c) => {
		const scope = resolveScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		const rows = await selectRows(storage, buildAssertionsSql(), scope);
		const assertions = rows.map((r) => ({
			id: toStr(r.id),
			stance: toStr(r.stance),
			subject: toStr(r.subject),
			predicate: toStr(r.predicate),
			object: toStr(r.object),
			confidence: toNum(r.confidence, 0),
			status: toStr(r.status),
			version: toNum(r.version, 1),
		}));
		return c.json({ assertions });
	});

	// POST /api/ontology/proposals — submit a control-plane proposal (reason-gated). A bounded
	// explicit op applies DIRECTLY; a broad/risky/generated-batch op enters the PENDING review
	// queue and is NOT applied (008c D-6 risk routing). A `claim.supersede` op runs the live,
	// append-only supersession path INDEPENDENT of pollinating (c-AC-4). A malformed body is a
	// `failed` outcome — never a throw past the boundary. Reported as data, never a crash.
	group.post("/proposals", async (c) => {
		const scope = resolveScope(c);
		if (scope === null) return c.json(NO_ORG_BODY, 400);
		const candidate = await readJson(c);
		try {
			const outcome = await submitProposal(storage, scope, candidate, { agentId: resolveAgentId(c) });
			// A malformed proposal yields `status:"failed"` with an empty id — surface it as a 400
			// (the caller sent an invalid body), and a routed/applied proposal as 202 (accepted).
			if (outcome.status === "failed") {
				return c.json({ error: "bad_request", reason: "invalid proposal", ...outcome }, 400);
			}
			return c.json(outcome, 202);
		} catch (err: unknown) {
			// A storage error during apply is surfaced as data (never an unhandled throw).
			const reason = err instanceof Error ? err.message : String(err);
			return c.json({ error: "apply_failed", reason }, 500);
		}
	});
}
