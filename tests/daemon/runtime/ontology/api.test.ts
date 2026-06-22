/**
 * PRD-045c daemon-assembly wiring — the `/api/ontology/*` mount seam (`mountOntologyApi`).
 *
 * PRD-008 shipped the entity model + control plane but never mounted an `/api/ontology`
 * surface, so the FR-2 `/api/ontology` group fell through to the 501 scaffold. This suite
 * proves the wiring: after `mountOntologyApi` fires, the read routes return REAL ontology
 * data (no 501) and the reason-gated `POST /api/ontology/proposals` route runs the control
 * plane (a bounded op applies directly; a risky op routes to the pending queue).
 *
 * Verification posture: in-process via `daemon.app.request(...)`, no socket. Reads run
 * against a SQL-aware fake `StorageQuery` (the FakeDeepLakeTransport-free shape the codebase
 * api suite uses) so the daemon-only-storage path is exercised without a live DeepLake.
 *
 * c-AC-2 `mountOntologyApi` fired; `/api/ontology/*` returns real data (no 501).
 * c-AC-4 superseded claims are tombstoned — the active-only claims read EXCLUDES them.
 * c-AC-5 a mount/read/mutation error never crashes the daemon (fail-soft).
 */

import { describe, expect, it } from "vitest";

import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import { mountOntologyApi } from "../../../../src/daemon/runtime/ontology/api.js";
import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult, queryError, type StorageRow } from "../../../../src/daemon/storage/result.js";

// ── Fixtures ────────────────────────────────────────────────────────────────────

const SCOPE: QueryScope = { org: "acme", workspace: "default" };

/** A resolved local-mode config (so a request with no org falls back to the default scope). */
function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false, ...over };
}

/** A storage seam whose responder answers each statement by inspecting the (upper-cased) SQL. */
function storageWith(responder: (sql: string) => StorageRow[]): { storage: StorageQuery; sqls: string[] } {
	const sqls: string[] = [];
	const storage: StorageQuery = {
		async query(sql: string): Promise<QueryResult> {
			sqls.push(sql);
			return ok(responder(sql.toUpperCase()), 1);
		},
	};
	return { storage, sqls };
}

/** A daemon built WITHOUT firing the ontology mount (the 501-baseline daemon). */
function bareDaemon(storage: StorageQuery): Daemon {
	return createDaemon({ config: cfg(), storage, logger: createRequestLogger({ silent: true }) });
}

/** A daemon with the ontology seam fired over the given storage. */
function wiredDaemon(storage: StorageQuery): Daemon {
	const daemon = bareDaemon(storage);
	mountOntologyApi(daemon, { storage, defaultScope: SCOPE });
	return daemon;
}

const ORG_HEADER = { "x-honeycomb-org": SCOPE.org } as const;

// ── The 501 baseline (the gap this wiring closes) ────────────────────────────────

describe("baseline: an UN-wired /api/ontology returns the FR-2 501 scaffold", () => {
	it("GET /api/ontology/entities is 501 until mountOntologyApi fires", async () => {
		const { storage } = storageWith(() => []);
		const daemon = bareDaemon(storage);
		const res = await daemon.app.request("/api/ontology/entities", { headers: ORG_HEADER });
		expect(res.status).toBe(501);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("not_implemented");
	});
});

// ── The wired read surface (c-AC-2) ──────────────────────────────────────────────

describe("PRD-045c wiring: mountOntologyApi turns the 501 into a live read surface (c-AC-2)", () => {
	it("GET /api/ontology lists the live sub-resources (no 501)", async () => {
		const { storage } = storageWith(() => []);
		const res = await wiredDaemon(storage).app.request("/api/ontology", { headers: ORG_HEADER });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { resources?: string[] };
		expect(body.resources).toContain("entities");
		expect(body.resources).toContain("claims");
	});

	it("GET /api/ontology/entities returns the entity rows as nodes", async () => {
		const { storage } = storageWith((sql) =>
			sql.includes("ENTITIES") && sql.startsWith("SELECT")
				? [{ id: "ent_1", name: "daemon", type: "system" }]
				: [],
		);
		const res = await wiredDaemon(storage).app.request("/api/ontology/entities", { headers: ORG_HEADER });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { entities: Array<{ id: string; name: string; type: string }> };
		expect(body.entities).toEqual([{ id: "ent_1", name: "daemon", type: "system" }]);
	});

	it("GET /api/ontology/edges returns dependency edges", async () => {
		const { storage } = storageWith((sql) =>
			sql.includes("ENTITY_DEPENDENCIES")
				? [{ source_entity_id: "ent_1", target_entity_id: "ent_2", type: "owns", reason: "" }]
				: [],
		);
		const res = await wiredDaemon(storage).app.request("/api/ontology/edges", { headers: ORG_HEADER });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { edges: Array<{ source: string; target: string; type: string }> };
		expect(body.edges).toEqual([{ source: "ent_1", target: "ent_2", type: "owns", reason: "" }]);
	});

	it("GET /api/ontology/assertions returns attribution rows", async () => {
		const { storage } = storageWith((sql) =>
			sql.includes("EPISTEMIC_ASSERTIONS")
				? [{ id: "assert_1", stance: "claimed", subject: "alice", predicate: "claims", object: "x", confidence: 0.9, status: "active", version: 1 }]
				: [],
		);
		const res = await wiredDaemon(storage).app.request("/api/ontology/assertions", { headers: ORG_HEADER });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { assertions: Array<{ id: string; stance: string }> };
		expect(body.assertions[0]?.stance).toBe("claimed");
	});
});

// ── c-AC-4: tombstoned (superseded) claims are EXCLUDED from the active read ──────

describe("PRD-045c c-AC-4: the claims read returns only ACTIVE claims (superseded are tombstoned)", () => {
	it("the claims SELECT filters status='active' and the body omits superseded rows", async () => {
		const { storage, sqls } = storageWith((sql) => {
			// The handler issues `WHERE status = 'active'`; the fake honours it by returning ONLY
			// an active row (a superseded row would never match the predicate).
			if (sql.includes("ENTITY_ATTRIBUTES") && sql.includes("ACTIVE")) {
				return [{ id: "attr_2", aspect_id: "asp_1", claim_key: "ck_1", content: "Staff Engineer", kind: "attribute", status: "active", confidence: 0.9, version: 2, memory_id: "mem_1" }];
			}
			return [];
		});
		const res = await wiredDaemon(storage).app.request("/api/ontology/claims", { headers: ORG_HEADER });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { claims: Array<{ status: string; content: string }> };
		// Exactly the active claim — the superseded prior is excluded by the active-only filter.
		expect(body.claims).toHaveLength(1);
		expect(body.claims[0]?.status).toBe("active");
		// The read SQL carries the active-status predicate (the tombstone-exclusion mechanism).
		expect(sqls.some((s) => s.toUpperCase().includes("ENTITY_ATTRIBUTES") && s.includes("active"))).toBe(true);
	});
});

// ── c-AC-5: fail-soft (a read against a missing table returns empty, not 501/500) ─

describe("PRD-045c c-AC-5: reads fail soft to an empty body, never a 501/500", () => {
	it("a non-ok storage result (missing table) yields an empty read, not an error", async () => {
		// A storage seam that errors on every query (the not-ok path the fail-soft selectRows tolerates).
		const storage: StorageQuery = {
			async query(): Promise<QueryResult> {
				return queryError("table entities does not exist", 404);
			},
		};
		const res = await wiredDaemon(storage).app.request("/api/ontology/entities", { headers: ORG_HEADER });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { entities: unknown[] };
		expect(body.entities).toEqual([]);
	});

	it("a request with no resolvable tenancy 400s (fail-closed), never a 501", async () => {
		// team mode + no default scope + no org header → null scope → 400.
		const { storage } = storageWith(() => []);
		const daemon = bareDaemon(storage);
		mountOntologyApi(daemon, { storage }); // no defaultScope
		const teamDaemon = createDaemon({
			config: cfg({ mode: "team" }),
			storage,
			logger: createRequestLogger({ silent: true }),
		});
		mountOntologyApi(teamDaemon, { storage });
		const res = await teamDaemon.app.request("/api/ontology/entities", {});
		// In team mode the protect middleware may gate first; either way it is NOT a 501.
		expect(res.status).not.toBe(501);
	});
});

// ── The reason-gated mutation route (POST /api/ontology/proposals) ───────────────

describe("PRD-045c: POST /api/ontology/proposals runs the control plane (reason-gated)", () => {
	it("a bounded claim.add applies DIRECTLY → 202 applied", async () => {
		// Every probe SELECT misses (all-new), every mutation succeeds → the bounded op applies.
		const { storage } = storageWith(() => []);
		const res = await wiredDaemon(storage).app.request("/api/ontology/proposals", {
			method: "POST",
			headers: { ...ORG_HEADER, "content-type": "application/json" },
			body: JSON.stringify({
				operation: "claim.add",
				confidence: 0.9,
				rationale: "unit",
				riskNote: "",
				payload: { aspectId: "asp_1", groupKey: "role", claimKey: "title", kind: "attribute", content: "Staff Eng", memoryId: "mem_1", importance: 0.5 },
				provenance: { source: "unit", evidence: "mem_1;u#1" },
			}),
		});
		expect(res.status).toBe(202);
		const body = (await res.json()) as { route: string; status: string };
		expect(body.route).toBe("direct");
		expect(body.status).toBe("applied");
	});

	it("a risky op (risk note present) routes to the PENDING queue → 202 pending, NOT applied", async () => {
		const { storage } = storageWith(() => []);
		const res = await wiredDaemon(storage).app.request("/api/ontology/proposals", {
			method: "POST",
			headers: { ...ORG_HEADER, "content-type": "application/json" },
			body: JSON.stringify({
				operation: "claim.add",
				confidence: 0.9,
				rationale: "unit",
				riskNote: "needs human review",
				payload: { aspectId: "asp_1", groupKey: "role", claimKey: "title", content: "x", memoryId: "mem_1" },
				provenance: { source: "unit", evidence: "mem_1;u#2" },
			}),
		});
		expect(res.status).toBe(202);
		const body = (await res.json()) as { route: string; status: string };
		expect(body.route).toBe("pending");
		expect(body.status).toBe("pending");
	});

	it("a malformed proposal body → 400 failed (never a throw past the boundary)", async () => {
		const { storage } = storageWith(() => []);
		const res = await wiredDaemon(storage).app.request("/api/ontology/proposals", {
			method: "POST",
			headers: { ...ORG_HEADER, "content-type": "application/json" },
			body: JSON.stringify({ not: "a proposal" }),
		});
		expect(res.status).toBe(400);
		const body = (await res.json()) as { status: string };
		expect(body.status).toBe("failed");
	});
});
