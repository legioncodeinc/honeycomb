/**
 * PRD-045c — the Ontology surface, proven LIVE on the FULLY-ASSEMBLED daemon in PLAIN CI
 * (fake storage, no token, no network). The deterministic sibling of
 * `ontology-surface-live.itest.ts` (mirrors PRD-031 Wave A / the 045e assembled proof).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE WHOLE POINT. A green UNIT test mounts one handler in isolation and cannot see
 * that the COMPOSITION ROOT failed to wire the seam — which is exactly the PRD-008
 * daemon-wiring gap: `/api/ontology` fell through to 501 because `assemble.ts` never
 * fired `mountOntologyApi`. This suite boots the REAL daemon through `assembleDaemon`
 * → `assembleSeams` (every seam in real order, behind the real middleware) backed by
 * a FAKE storage client, and drives `/api/ontology/*` via `app.request(...)`. If the
 * composition root had NOT fired the seam, these routes would 501 — the deterministic
 * proof of c-AC-2.
 *
 * c-AC-3 (a captured/processed memory yields a linked entity readable via /api/ontology)
 * is proven here against an IN-MEMORY entities store: the live graph-persist stage core
 * (`persistGraphEntities`, the same path the assembled pipeline worker runs) processes a
 * memory through the SAME storage the assembled daemon serves reads from, then
 * `GET /api/ontology/entities` surfaces the entity that processing created. The live
 * end-to-end run against real DeepLake lives in the gated itest.
 * ════════════════════════════════════════════════════════════════════════════
 */

import { beforeAll, describe, expect, it } from "vitest";

import {
	type AssembledTestDaemonApp,
	assembleTestDaemonApp,
	createFakeStorage,
	type FakeStorage,
} from "../../integration/_daemon-harness.js";
import { PipelineConfigSchema } from "../../../src/daemon/runtime/pipeline/config.js";
import { persistGraphEntities } from "../../../src/daemon/runtime/pipeline/graph-persist.js";
import type { QueryScope } from "../../../src/daemon/storage/client.js";
import { ok, type QueryResult, type StorageRow } from "../../../src/daemon/storage/result.js";

/** local-mode loopback tenancy headers the ontology header resolver requires. */
const HEADERS = { "x-honeycomb-org": "local", "x-honeycomb-workspace": "default" } as const;

/**
 * A FakeStorage that models the `entities` table as an in-memory set: an
 * `INSERT INTO "entities"` records the row; a `SELECT … FROM "entities"` (the
 * `/api/ontology/entities` read OR the linker's by-name resolve) answers from the set.
 * Every other statement answers `ok([])`. This is the minimum needed to prove the
 * process→read round-trip deterministically — a memory processed into an entity is then
 * readable via the assembled `/api/ontology/entities` surface.
 */
function entitiesBackedStorage(): FakeStorage {
	const entities: StorageRow[] = [];
	const idCol = (sql: string, col: string): string => {
		// Pull a single-quoted value following `<col> = '…'` (the linker's by-name probe shape).
		const m = new RegExp(`${col}"?\\s*=\\s*'([^']*)'`, "i").exec(sql);
		return m ? m[1] : "";
	};
	return createFakeStorage((sql: string): QueryResult => {
		const upper = sql.toUpperCase();
		if (upper.startsWith("INSERT") && upper.includes('"ENTITIES"')) {
			// Parse the columns + values of the INSERT to record a row (id, name, type).
			const colsMatch = /\(([^)]*)\)\s*VALUES\s*\(/i.exec(sql);
			const valsMatch = /VALUES\s*\((.*)\)\s*$/is.exec(sql);
			if (colsMatch && valsMatch) {
				const cols = colsMatch[1].split(",").map((c) => c.trim().replace(/"/g, ""));
				const vals = valsMatch[1].split(",").map((v) => v.trim().replace(/^'/, "").replace(/'$/, ""));
				const row: StorageRow = {};
				cols.forEach((c, i) => {
					row[c] = vals[i];
				});
				entities.push(row);
			}
			return ok([], 1);
		}
		if (upper.startsWith("SELECT") && upper.includes('"ENTITIES"')) {
			// The linker's by-name resolve: `WHERE name = '<canonical>'` → the matching id.
			const wantName = idCol(sql, "name");
			if (wantName !== "") {
				const hit = entities.find((e) => String(e.name) === wantName);
				return ok(hit ? [{ id: hit.id }] : [], 1);
			}
			// A by-id presence probe: `WHERE id = '<id>'`.
			const wantId = idCol(sql, "id");
			if (wantId !== "") {
				const hit = entities.find((e) => String(e.id) === wantId);
				return ok(hit ? [{ id: hit.id }] : [], 1);
			}
			// The `/api/ontology/entities` list read (no WHERE id/name) → all recorded entities.
			return ok(entities.map((e) => ({ id: e.id, name: e.name, type: e.type })), 1);
		}
		return ok([], 1);
	});
}

const SCOPE: QueryScope = { org: "local", workspace: "default" };

function enabledGraphConfig() {
	return PipelineConfigSchema.parse({
		enabled: true,
		extractionProvider: "fake",
		graph: { enabled: true, extractionWritesEnabled: true },
	});
}

describe("PRD-045c — Ontology surface is LIVE on the assembled daemon (plain CI, fake storage)", () => {
	// ── c-AC-2: /api/ontology read routes answer real data (no 501). ──
	describe("c-AC-2 — /api/ontology/* answers real data (no 501)", () => {
		let net: AssembledTestDaemonApp;
		beforeAll(() => {
			net = assembleTestDaemonApp({ mode: "local" });
		});

		it("GET /api/ontology lists the live sub-resources (NOT the 501 scaffold)", async () => {
			const res = await net.app.request("/api/ontology", { headers: HEADERS });
			expect(res.status, "the ontology index route reaches its handler, not 501").toBe(200);
			const body = (await res.json()) as { resources?: string[]; error?: string };
			expect(body.error, "did NOT fall through to the not_implemented scaffold").toBeUndefined();
			expect(body.resources).toContain("entities");
		});

		it("GET /api/ontology/entities returns a 200 entities envelope (NOT 501)", async () => {
			const res = await net.app.request("/api/ontology/entities", { headers: HEADERS });
			expect(res.status).toBe(200);
			const body = (await res.json()) as { entities?: unknown };
			expect(Array.isArray(body.entities)).toBe(true);
		});

		it("GET /api/ontology/edges, /claims, /assertions all answer 200 (no 501)", async () => {
			for (const path of ["/api/ontology/edges", "/api/ontology/claims", "/api/ontology/assertions"]) {
				const res = await net.app.request(path, { headers: HEADERS });
				expect(res.status, `${path} reaches its handler`).toBe(200);
			}
		});

		it("a request with no tenancy in team mode is NOT a 501 (fail-closed, surface is live)", async () => {
			const team = assembleTestDaemonApp({ mode: "team" });
			const res = await team.app.request("/api/ontology/entities", {});
			expect(res.status).not.toBe(501);
		});
	});

	// ── c-AC-3: a processed memory yields a linked entity readable via /api/ontology. ──
	describe("c-AC-3 — a processed memory yields an entity readable via /api/ontology", () => {
		it("graph-persist (the live stage) creates an entity that /api/ontology/entities surfaces", async () => {
			// One in-memory-entities storage shared by the processing stage AND the assembled
			// daemon's read surface — so a write by processing is visible to the HTTP read.
			const storage = entitiesBackedStorage();
			const net = assembleTestDaemonApp({ mode: "local", storage });

			// Before processing → no entities on the surface.
			const before = await net.app.request("/api/ontology/entities", { headers: HEADERS });
			expect(((await before.json()) as { entities: unknown[] }).entities).toHaveLength(0);

			// Process a memory through the LIVE graph-persist stage core (the same path the
			// assembled pipeline worker runs): it creates the entities AND invokes the inline
			// linker over the memory content (c-AC-1) — all through the shared storage.
			await persistGraphEntities(
				storage,
				SCOPE,
				enabledGraphConfig(),
				"mem-assembled",
				[{ source: "Hivemind", relationship: "owns", target: "Daemon" }],
				{ warn() {}, info() {} },
				"Hivemind owns the Daemon subsystem.",
			);

			// After processing → the created entities are readable via the assembled surface.
			const after = await net.app.request("/api/ontology/entities", { headers: HEADERS });
			expect(after.status).toBe(200);
			const body = (await after.json()) as { entities: Array<{ name: string }> };
			const names = body.entities.map((e) => e.name);
			expect(names, "the processed memory's entities are readable via /api/ontology").toEqual(
				expect.arrayContaining(["hivemind", "daemon"]),
			);
		});
	});
});
