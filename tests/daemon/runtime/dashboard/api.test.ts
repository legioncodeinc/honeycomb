/**
 * PRD-020b daemon-side dashboard API suite — the `mountDashboardApi` attach step.
 *
 * `mountDashboardApi` is the single named seam the daemon assembly calls after
 * `createDaemon(...)` to wire the dashboard read handlers onto the already-mounted route
 * groups (`/api/diagnostics`). This suite proves: BEFORE the attach the
 * diagnostics group answers the 501 scaffold; AFTER the attach each endpoint is LIVE and returns
 * the matching 020b view-model shape, read through the injected storage client (storage-correct —
 * never a raw fetch).
 *
 * ── `GET /api/graph` is owned ELSEWHERE (route-collision resolution) ──────────
 * The codebase-graph view (`GET /api/graph`) is served by `mountGraphApi` (codebase/api.ts), the
 * SINGLE owner of the `/api/graph` group — it returns the full `{ built, nodes, edges }` view from
 * the freshest LOCAL snapshot. This seam's former DeepLake-read graph handler was retired to clear
 * the latent double-registration; this suite asserts the dashboard seam no longer claims it (a 501
 * with only this seam fired). The full-view + single-owner proofs live in the codebase api suite.
 *
 * ── Route-collision contract (PRD-022) ───────────────────────────────────────
 * The kpis/rules/skills VIEW-MODELS are served UNDER the diagnostics namespace
 * (`/api/diagnostics/{kpis,rules,skills}`), NOT on the canonical `/api/kpis|rules|skills`
 * resource paths — those belong to the PRD-022 product-data data-access API. This suite asserts
 * the views answer at the diagnostics paths AND that the dashboard no longer claims `/api/kpis`
 * (so product-data owns it; see the regression test below).
 */

import { describe, expect, it } from "vitest";

import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import {
	buildSettingsView,
	fetchEstimatedSavings,
	fetchKpiCounts,
	fetchKpisView,
	fetchMemoryGraphView,
	fetchSkillSyncView,
	mountDashboardApi,
} from "../../../../src/daemon/runtime/dashboard/api.js";
import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import type { QueryResult, StorageRow } from "../../../../src/daemon/storage/result.js";
import type { LocalAssetInventory } from "../../../../src/dashboard/contracts.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const ORG = "fake-org";
const WORKSPACE = "fake-ws";

function cfg(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
}

/** A team-mode config — proves the local-default fallback NEVER fires outside local (Wave 3). */
function cfgTeam(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "team", widened: false };
}

/** The daemon's configured default tenant (the single LOCAL tenant) injected via defaultScope. */
const DEFAULT_SCOPE = { org: "daemon-default-org", workspace: "daemon-default-ws" } as const;

function headers(): Record<string, string> {
	return { "x-honeycomb-org": ORG, "x-honeycomb-workspace": WORKSPACE };
}

/** Make a daemon at an explicit mode/config (Wave 3 fallback proofs). */
function makeDaemonMode(graphBuilt: boolean, config: RuntimeConfig) {
	const fake = new FakeDeepLakeTransport(responder(graphBuilt));
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const daemon = createDaemon({ config, storage, logger: createRequestLogger({ silent: true }) });
	return { daemon, storage };
}

/** A SQL-aware responder routing each dashboard read to a canned row set. `graphBuilt` toggles b-AC-3/6. */
function responder(graphBuilt: boolean) {
	return (req: TransportRequest): Record<string, unknown>[] => {
		const sql = req.sql;
		// PRD-035b: the estimated-savings aggregate (SUM(LENGTH(content)) FROM "memories"). Seed a
		// non-zero character total so the KPI computes a real non-zero token estimate.
		if (/SUM\(LENGTH/i.test(sql) && /FROM\s+"memories"/i.test(sql)) return [{ chars: 4000 }];
		// PRD-036c: the team-shared skill count (COUNT(DISTINCT honeycomb_id) FROM "synced_assets").
		if (/FROM\s+"synced_assets"/i.test(sql)) return [{ n: 3 }];
		// The Memories KPI count (COUNT(*) FROM "memories" — the real table name, not "memory").
		if (/COUNT\(\*\).*FROM\s+"memories"/i.test(sql)) return [{ n: 42 }];
		if (/COUNT\(\*\).*FROM\s+"sessions"/i.test(sql)) return [{ n: 7 }];
		if (/FROM\s+"sessions"/i.test(sql))
			return [{ id: "sess-1", project: "honeycomb", creation_date: "2026-06-18", path: "conversations/sess-1" }];
		// NOTE: the `codebase` table is NO LONGER read by this seam — `GET /api/graph` is owned by
		// `mountGraphApi` (codebase/api.ts), which reads the freshest LOCAL snapshot, not DeepLake.
		// `graphBuilt` below still toggles the MEMORY-graph ontology rows (this seam's own view).
		if (/FROM\s+"rules"/i.test(sql)) return [{ id: "r1", name: "Use ESM", status: "active" }];
		if (/FROM\s+"skills"/i.test(sql)) return [{ name: "deeplake-recall", scope: "team", visibility: "global" }];
		// PRD-041b: the memory-graph reads. `graphBuilt` reuses the flag to toggle a populated vs empty
		// ontology — built → two entities + one dependency edge between them; empty → no rows (built:false).
		if (/FROM\s+"entities"/i.test(sql)) {
			if (!graphBuilt) return [];
			return [
				{ id: "e1", name: "Alex", type: "entity" },
				{ id: "e2", name: "Honeycomb", type: "entity" },
			];
		}
		if (/FROM\s+"entity_dependencies"/i.test(sql)) {
			if (!graphBuilt) return [];
			return [{ source_entity_id: "e1", target_entity_id: "e2", type: "depends_on" }];
		}
		return [];
	};
}

function makeDaemon(graphBuilt: boolean) {
	const fake = new FakeDeepLakeTransport(responder(graphBuilt));
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const daemon = createDaemon({ config: cfg(), storage, logger: createRequestLogger({ silent: true }) });
	return { daemon, storage };
}

describe("PRD-020b mountDashboardApi wires the six dashboard read handlers", () => {
	it("BEFORE attach: /api/diagnostics/kpis answers the 501 scaffold", async () => {
		const { daemon } = makeDaemon(true);
		const res = await daemon.app.request("/api/diagnostics/kpis", { headers: headers() });
		expect(res.status).toBe(501);
	});

	it("b-AC-1: AFTER attach: /api/diagnostics/kpis returns the KpisView read through storage", async () => {
		const { daemon, storage } = makeDaemon(true);
		mountDashboardApi(daemon, { storage });
		const res = await daemon.app.request("/api/diagnostics/kpis", { headers: headers() });
		expect(res.status).toBe(200);
		const json = (await res.json()) as Record<string, number>;
		expect(json.memoryCount).toBe(42);
		expect(json.sessionCount).toBe(7);
		// PRD-035a: turnCount mirrors the session-row count under the honest name.
		expect(json.turnCount).toBe(7);
		// PRD-035b: 4000 chars / 4 chars-per-token = 1000 estimated tokens saved (real, non-zero).
		expect(json.estimatedSavings).toBe(1000);
		// PRD-036c: the team-shared skill count from the synced_assets substrate.
		expect(json.teamSkillCount).toBe(3);
	});

	it("C-4: /api/diagnostics/kpis exposes captureDroppedEvents when the seam is wired", async () => {
		const { daemon, storage } = makeDaemon(true);
		let dropped = 2;
		mountDashboardApi(daemon, { storage, captureDroppedEvents: () => dropped });
		const res = await daemon.app.request("/api/diagnostics/kpis", { headers: headers() });
		expect(res.status).toBe(200);
		const json = (await res.json()) as { extra?: { captureDroppedEvents: number } };
		expect(json.extra?.captureDroppedEvents).toBe(2);
		dropped = 5;
		const again = await daemon.app.request("/api/diagnostics/kpis", { headers: headers() });
		const body = (await again.json()) as { extra?: { captureDroppedEvents: number } };
		expect(body.extra?.captureDroppedEvents).toBe(5);
	});

	it("PRD-022 collision: the dashboard does NOT claim /api/kpis (left to product-data)", async () => {
		const { daemon, storage } = makeDaemon(true);
		mountDashboardApi(daemon, { storage });
		// mountDashboardApi attaches NOTHING to the canonical `/api/kpis` resource group, so it
		// still answers the scaffold 501 — product-data's GET handler is what fills it. This is the
		// regression for the live dogfood collision where the dashboard view-model shadowed the
		// product-data rows on `/api/kpis` (Hono first-match wins).
		const res = await daemon.app.request("/api/kpis", { headers: headers() });
		expect(res.status).toBe(501);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("not_implemented");
		// The same regression holds for the other two collided resource paths.
		expect((await daemon.app.request("/api/rules", { headers: headers() })).status).toBe(501);
		expect((await daemon.app.request("/api/skills", { headers: headers() })).status).toBe(501);
	});

	it("b-AC-1: /api/sessions returns the SessionsView with project/date metadata", async () => {
		const { daemon, storage } = makeDaemon(true);
		mountDashboardApi(daemon, { storage });
		const res = await daemon.app.request("/api/diagnostics/sessions", { headers: headers() });
		const json = (await res.json()) as { sessions: { sessionId: string; project: string }[] };
		expect(json.sessions[0].sessionId).toBe("sess-1");
		expect(json.sessions[0].project).toBe("honeycomb");
	});

	it("b-AC-1: /api/diagnostics/settings returns the active org + workspace config", async () => {
		const { daemon, storage } = makeDaemon(true);
		mountDashboardApi(daemon, { storage });
		const res = await daemon.app.request("/api/diagnostics/settings", { headers: headers() });
		const json = (await res.json()) as { orgId: string; workspace: string };
		expect(json.orgId).toBe(ORG);
		expect(json.workspace).toBe(WORKSPACE);
	});

	it("route-collision resolution: mountDashboardApi does NOT claim GET /api/graph (owned by mountGraphApi)", async () => {
		// The codebase-graph view (`GET /api/graph`) is owned SOLELY by `mountGraphApi`
		// (codebase/api.ts), which serves the full `{ built, nodes, edges }` view from the freshest
		// LOCAL snapshot. The dashboard seam's former DeepLake-read graph handler was RETIRED to clear
		// the latent `/api/graph` double-registration (two handlers on one method+path flapped
		// `built:false` in live probes). So with ONLY mountDashboardApi fired, `/api/graph` answers the
		// scaffold (501) — there is no dashboard handler on it. (See tests/daemon/runtime/codebase/api.test.ts
		// for the live full-view + single-owner proofs.)
		const { daemon, storage } = makeDaemon(true);
		mountDashboardApi(daemon, { storage });
		const res = await daemon.app.request("/api/graph", { headers: headers() });
		expect(res.status).toBe(501);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("not_implemented");
	});

	it("b-AC-4: /api/diagnostics/rules lists the active rules through storage", async () => {
		const { daemon, storage } = makeDaemon(true);
		mountDashboardApi(daemon, { storage });
		const res = await daemon.app.request("/api/diagnostics/rules", { headers: headers() });
		const json = (await res.json()) as { rules: { title: string; active: boolean }[] };
		expect(json.rules[0].title).toBe("Use ESM");
		expect(json.rules[0].active).toBe(true);
	});

	it("b-AC-1: /api/diagnostics/skills returns the skill-sync view", async () => {
		const { daemon, storage } = makeDaemon(true);
		mountDashboardApi(daemon, { storage });
		const res = await daemon.app.request("/api/diagnostics/skills", { headers: headers() });
		const json = (await res.json()) as { skills: { name: string; syncState: string }[] };
		expect(json.skills[0].name).toBe("deeplake-recall");
		expect(json.skills[0].syncState).toBe("shared");
	});

	it("fail-closed: a request with no org header 400s rather than reading a broad scope", async () => {
		const { daemon, storage } = makeDaemon(true);
		mountDashboardApi(daemon, { storage });
		const res = await daemon.app.request("/api/diagnostics/kpis", {});
		expect(res.status).toBe(400);
	});

	it("PRD-036a: /api/diagnostics/installed-assets returns the LocalAssetInventory (no org header required)", async () => {
		// BEFORE the attach, the diagnostics group answers the 501 scaffold for this path.
		const before = makeDaemon(true);
		const pre = await before.daemon.app.request("/api/diagnostics/installed-assets", { headers: headers() });
		expect(pre.status).toBe(501);

		// AFTER the attach the scan endpoint is LIVE. It is tenancy-INDEPENDENT (a filesystem walk,
		// not a storage read), so it returns 200 even with NO org header — unlike the storage views.
		const { daemon, storage } = makeDaemon(true);
		mountDashboardApi(daemon, { storage });
		const res = await daemon.app.request("/api/diagnostics/installed-assets", {}); // NO x-honeycomb-org
		expect(res.status).toBe(200);
		const json = (await res.json()) as { skills: unknown[]; agents: unknown[] };
		expect(Array.isArray(json.skills)).toBe(true);
		expect(Array.isArray(json.agents)).toBe(true);
	});
});

describe("PRD-024 Wave 3 local-mode default-scope fallback (the dashboard-panel 400 regression fix)", () => {
	// The dashboard web app is a loopback thin client (like the SDK/MCP): it sends the
	// runtime-path + session headers but NOT x-honeycomb-org. BEFORE Wave 3 every diagnostics
	// view 400'd on that, blanking every panel. AFTER Wave 3, in LOCAL mode with a configured
	// default tenant, the view falls back to it (200), exactly like the memories API. (`/api/graph`
	// is owned by `mountGraphApi`, not this seam, so it is proven in the codebase api suite — its
	// own local-default fallback is exercised there.)

	/** The diagnostics view paths the browser client GETs from THIS seam (the panels that blanked). */
	const VIEW_PATHS = [
		"/api/diagnostics/kpis",
		"/api/diagnostics/sessions",
		"/api/diagnostics/settings",
		"/api/diagnostics/rules",
		"/api/diagnostics/skills",
	] as const;

	it("local mode + NO org header + defaultScope injected → each view returns 200 (not 400)", async () => {
		// The live dogfood regression: the dashboard sends no org GUID; in local mode with a
		// configured default tenant, every diagnostics view + the graph must serve real data.
		const { daemon, storage } = makeDaemonMode(true, cfg());
		mountDashboardApi(daemon, { storage, defaultScope: DEFAULT_SCOPE });
		for (const path of VIEW_PATHS) {
			const res = await daemon.app.request(path, {}); // NO x-honeycomb-org
			expect(res.status, `${path} should fall back to the local default, not 400`).toBe(200);
		}
		// And the settings view reflects the injected default tenant (proves the default scope
		// is what fed the read, not some broad/empty scope).
		const settings = (await (await daemon.app.request("/api/diagnostics/settings", {})).json()) as {
			orgId: string;
			workspace: string;
		};
		expect(settings.orgId).toBe(DEFAULT_SCOPE.org);
		expect(settings.workspace).toBe(DEFAULT_SCOPE.workspace);
	});

	it("local mode + NO org header + NO defaultScope → still 400 (defensive, unchanged)", async () => {
		// A bare unit mount (no injected default) keeps the prior fail-closed header-only behaviour.
		const { daemon, storage } = makeDaemonMode(true, cfg());
		mountDashboardApi(daemon, { storage });
		for (const path of VIEW_PATHS) {
			const res = await daemon.app.request(path, {});
			expect(res.status, `${path} with no default must stay fail-closed`).toBe(400);
		}
	});

	it("TEAM mode + NO org header → REJECTED, never the local fallback (fallback is local-only)", async () => {
		// Even with a defaultScope injected, team mode must NOT fall back — tenancy is still
		// required outside local. In team mode the PRD-011 permission middleware rejects an
		// unauthenticated request with 401 BEFORE the handler (an even stronger guard than the
		// handler's 400); either way the request is REJECTED (never 200) and the fallback never
		// fires. The security posture (cross-tenant guard) is unchanged.
		const { daemon, storage } = makeDaemonMode(true, cfgTeam());
		mountDashboardApi(daemon, { storage, defaultScope: DEFAULT_SCOPE });
		for (const path of VIEW_PATHS) {
			const res = await daemon.app.request(path, {});
			expect(res.status, `${path} in team mode must reject (401/400), never 200`).not.toBe(200);
			expect(res.status, `${path} in team mode must be a client-reject status`).toBeGreaterThanOrEqual(400);
		}
	});

	it("org header present (local, with defaultScope) → the HEADER scope WINS, not the default", async () => {
		// A request WITH the org header (the CLI shape) must use the header tenant, never the
		// default — the header always wins, in every mode.
		const { daemon, storage } = makeDaemonMode(true, cfg());
		mountDashboardApi(daemon, { storage, defaultScope: DEFAULT_SCOPE });
		const res = await daemon.app.request("/api/diagnostics/settings", { headers: headers() });
		expect(res.status).toBe(200);
		const settings = (await res.json()) as { orgId: string; workspace: string };
		expect(settings.orgId).toBe(ORG); // header org, NOT the default
		expect(settings.workspace).toBe(WORKSPACE);
	});
});

describe("fix/daemon-scope-from-credentials: the settings view exposes the friendly orgName", () => {
	const SCOPE = { org: "71f2566d-OSPRY", workspace: "default" } as const;
	const SETTINGS_CONFIG = { mode: "local", port: 3850 } as const;

	it("buildSettingsView returns the friendly orgName when the daemon resolved one from creds", () => {
		const view = buildSettingsView(SCOPE, SETTINGS_CONFIG, "OSPRY");
		// orgId stays the (GUID) scope org; orgName is the human name so the header shows "OSPRY".
		expect(view.orgId).toBe(SCOPE.org);
		expect(view.orgName).toBe("OSPRY");
		expect(view.workspace).toBe("default");
	});

	it("buildSettingsView falls back to the scope org when no orgName is provided (tests / no creds)", () => {
		// Unchanged behaviour for a unit-constructed daemon / a login with no orgName on disk.
		const view = buildSettingsView(SCOPE, SETTINGS_CONFIG);
		expect(view.orgName).toBe(SCOPE.org);
		const blank = buildSettingsView(SCOPE, SETTINGS_CONFIG, "");
		expect(blank.orgName).toBe(SCOPE.org);
	});

	it("the /api/diagnostics/settings handler threads the mount's orgName into the view", async () => {
		// End-to-end through the mount: a request resolving to the local default tenant shows the
		// friendly orgName the composition root threaded in, NOT the org id.
		const { daemon, storage } = makeDaemonMode(true, cfg());
		mountDashboardApi(daemon, { storage, defaultScope: SCOPE, orgName: "OSPRY" });
		const res = await daemon.app.request("/api/diagnostics/settings", {}); // no org header → local default
		expect(res.status).toBe(200);
		const settings = (await res.json()) as { orgId: string; orgName: string };
		expect(settings.orgId).toBe(SCOPE.org);
		expect(settings.orgName).toBe("OSPRY");
	});

	it("without an injected orgName the handler still falls back to the scope org (unchanged)", async () => {
		const { daemon, storage } = makeDaemonMode(true, cfg());
		mountDashboardApi(daemon, { storage, defaultScope: SCOPE });
		const res = await daemon.app.request("/api/diagnostics/settings", {});
		const settings = (await res.json()) as { orgId: string; orgName: string };
		expect(settings.orgName).toBe(SCOPE.org);
	});
});

// ── Shared fakes for the focused fetcher suites (PRD-035b / PRD-036b) ──────────

const SCOPE_OK = { org: "fake-org", workspace: "fake-ws" } as const satisfies QueryScope;

/** A fake StorageQuery that maps a SQL predicate → canned rows (an ok result); `[]` if no match. */
function fakeStorage(route: (sql: string) => StorageRow[] | "error"): StorageQuery {
	return {
		async query(sql: string): Promise<QueryResult> {
			const out = route(sql);
			if (out === "error") return { kind: "query_error", message: "forced storage error", status: 500 };
			return { kind: "ok", rows: out, durationMs: 1 };
		},
	};
}

/** Build a `LocalAssetInventory` of skill names (each a `local` disk skill) for the union tests. */
function localInventory(...names: string[]): LocalAssetInventory {
	return {
		skills: names.map((name) => ({
			name,
			description: "",
			assetType: "skill" as const,
			scope: "repository",
			sourceHarnesses: ["claude-code"],
			paths: [`/repo/.claude/skills/${name}/SKILL.md`],
		})),
		agents: [],
	};
}

describe("PRD-035b: estimated-savings is a real, explainable, fail-soft metric", () => {
	it("b-AC-1: seeded memory corpus → a real non-zero token estimate (chars / 4)", async () => {
		// 4000 chars of distilled `content` → 1000 estimated tokens saved.
		const storage = fakeStorage((sql) => {
			if (/FROM\s+"memories"/i.test(sql)) return [{ chars: 4000 }];
			return [];
		});
		const view = await fetchKpisView(storage, SCOPE_OK);
		expect(view.estimatedSavings).toBe(1000);
	});

	it("b-AC-2: a genuinely-empty corpus → 0 via the empty path (SUM is NULL), not a hardcode", async () => {
		// An empty `memories` table makes SUM(LENGTH(content)) return NULL → toNum → 0.
		const storage = fakeStorage((sql) => {
			if (/FROM\s+"memories"/i.test(sql)) return [{ chars: null }];
			return [];
		});
		const view = await fetchKpisView(storage, SCOPE_OK);
		expect(view.estimatedSavings).toBe(0);
	});

	it("b-AC-5: a forced storage error on the savings query → 0 (fail-soft), no throw", async () => {
		const storage = fakeStorage((sql) => {
			if (/FROM\s+"memories"/i.test(sql)) return "error";
			return [];
		});
		// The whole fetcher must resolve (never reject) and the savings degrade to 0.
		const view = await fetchKpisView(storage, SCOPE_OK);
		expect(view.estimatedSavings).toBe(0);
	});
});

describe("PRD-049e: the KPI band is project-scoped (project-bearing counts only)", () => {
	// A SQL-capturing daemon: each dashboard read routes through one responder; the transport records
	// every request so a test can assert which counts carried the `project_id` filter.
	function makeCapturingDaemon() {
		const fake = new FakeDeepLakeTransport((req: TransportRequest): Record<string, unknown>[] => {
			const sql = req.sql;
			if (/SUM\(LENGTH/i.test(sql)) return [{ chars: 4000 }];
			if (/FROM\s+"synced_assets"/i.test(sql)) return [{ n: 3 }];
			if (/COUNT\(\*\).*FROM\s+"memories"/i.test(sql)) return [{ n: 42 }];
			if (/COUNT\(\*\).*FROM\s+"sessions"/i.test(sql)) return [{ n: 7 }];
			return [];
		});
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const daemon = createDaemon({ config: cfg(), storage, logger: createRequestLogger({ silent: true }) });
		mountDashboardApi(daemon, { storage });
		return { daemon, fake };
	}

	const proj = (id: string): Record<string, string> => ({ ...headers(), "x-honeycomb-project": id });

	it("fetchKpisView(projectId): memories + sessions counts AND the savings SUM carry WHERE project_id; synced_assets does NOT", async () => {
		const seen: string[] = [];
		const storage = fakeStorage((sql) => {
			seen.push(sql);
			return /SUM\(LENGTH/i.test(sql) ? [{ chars: 4000 }] : [{ n: 1 }];
		});
		await fetchKpisView(storage, SCOPE_OK, "proj-web");
		const find = (re: RegExp): string => seen.find((s) => re.test(s)) ?? "";
		expect(find(/COUNT\(\*\).*FROM\s+"memories"/i)).toMatch(/project_id = 'proj-web'/);
		expect(find(/COUNT\(\*\).*FROM\s+"sessions"/i)).toMatch(/project_id = 'proj-web'/);
		expect(find(/SUM\(LENGTH/i)).toMatch(/project_id = 'proj-web'/);
		// Team skills is shared with the TEAM (synced_assets has no project segment) → never narrowed.
		expect(find(/FROM\s+"synced_assets"/i)).not.toMatch(/project_id/);
	});

	it("fetchKpisView with NO project → no project filter anywhere (workspace-wide, back-compat)", async () => {
		const seen: string[] = [];
		const storage = fakeStorage((sql) => {
			seen.push(sql);
			return /SUM\(LENGTH/i.test(sql) ? [{ chars: 0 }] : [{ n: 1 }];
		});
		await fetchKpisView(storage, SCOPE_OK);
		expect(seen.every((s) => !/project_id/.test(s))).toBe(true);
	});

	it("the route narrows the band when the dashboard stamps x-honeycomb-project", async () => {
		const { daemon, fake } = makeCapturingDaemon();
		const res = await daemon.app.request("/api/diagnostics/kpis", { headers: proj("proj-web") });
		expect(res.status).toBe(200);
		const find = (re: RegExp): string => fake.requests.find((r) => re.test(r.sql))?.sql ?? "";
		expect(find(/COUNT\(\*\).*FROM\s+"memories"/i)).toMatch(/project_id = 'proj-web'/);
		expect(find(/COUNT\(\*\).*FROM\s+"sessions"/i)).toMatch(/project_id = 'proj-web'/);
		expect(find(/FROM\s+"synced_assets"/i)).not.toMatch(/project_id/);
	});

	it("the band is cached per (scope, project) within the TTL — a re-load does NOT re-query, a new project DOES", async () => {
		const { daemon, fake } = makeCapturingDaemon();
		await daemon.app.request("/api/diagnostics/kpis", { headers: proj("proj-web") });
		const afterFirst = fake.requests.length;
		// A second identical load is served from the cache → zero additional storage reads.
		await daemon.app.request("/api/diagnostics/kpis", { headers: proj("proj-web") });
		expect(fake.requests.length).toBe(afterFirst);
		// A DIFFERENT project is a different cache key → it re-queries.
		await daemon.app.request("/api/diagnostics/kpis", { headers: proj("proj-other") });
		expect(fake.requests.length).toBeGreaterThan(afterFirst);
	});
});

describe("PRD-049e perf: the KPI read is split into cached counts + a separately-cached savings SUM", () => {
	it("fetchKpiCounts runs the COUNTS only (no savings SUM); fetchEstimatedSavings runs the SUM only", async () => {
		const seenCounts: string[] = [];
		const counts = await fetchKpiCounts(
			fakeStorage((sql) => {
				seenCounts.push(sql);
				return [{ n: 7 }];
			}),
			SCOPE_OK,
		);
		// The counts read must NOT carry the heavy corpus SUM (that is the separately-cached path).
		expect(seenCounts.some((s) => /SUM\(LENGTH/i.test(s))).toBe(false);
		expect(seenCounts.some((s) => /COUNT\(\*\).*FROM\s+"memories"/i.test(s))).toBe(true);
		expect(counts.turnCount).toBe(7);

		const seenSavings: string[] = [];
		const savings = await fetchEstimatedSavings(
			fakeStorage((sql) => {
				seenSavings.push(sql);
				return [{ chars: 4000 }];
			}),
			SCOPE_OK,
		);
		// The savings path is exactly ONE query — the SUM — and divides by the documented divisor.
		expect(seenSavings).toHaveLength(1);
		expect(seenSavings[0]).toMatch(/SUM\(LENGTH/i);
		expect(savings).toBe(1000);
	});
});

describe("PRD-049e perf: the sessions/rules/skills diagnostics reads are short-TTL cached", () => {
	function makeCachingDaemon() {
		const fake = new FakeDeepLakeTransport((req: TransportRequest): Record<string, unknown>[] => {
			const sql = req.sql;
			if (/FROM\s+"sessions"/i.test(sql)) return [{ id: "s1", project: "p", creation_date: "2026-06-20", path: "x" }];
			if (/FROM\s+"rules"/i.test(sql)) return [{ id: "r1", name: "Rule", status: "active" }];
			if (/FROM\s+"skills"/i.test(sql)) return [{ name: "sk", scope: "team", visibility: "global" }];
			return [];
		});
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const daemon = createDaemon({ config: cfg(), storage, logger: createRequestLogger({ silent: true }) });
		mountDashboardApi(daemon, { storage });
		return { daemon, fake };
	}

	for (const ep of ["sessions", "rules", "skills"] as const) {
		it(`/${ep}: a re-load within the TTL is served from cache (no new storage read)`, async () => {
			const { daemon, fake } = makeCachingDaemon();
			expect((await daemon.app.request(`/api/diagnostics/${ep}`, { headers: headers() })).status).toBe(200);
			const afterFirst = fake.requests.length;
			expect(afterFirst).toBeGreaterThan(0);
			// Identical second request → cache hit → ZERO additional storage reads.
			expect((await daemon.app.request(`/api/diagnostics/${ep}`, { headers: headers() })).status).toBe(200);
			expect(fake.requests.length).toBe(afterFirst);
		});
	}
});

describe("PRD-036b: skill-sync view is the union (installed ∪ synced) with honest state", () => {
	it("b-AC-1/b-AC-3: local disk skills render as `local`; synced rows keep their state", async () => {
		const storage = fakeStorage((sql) => {
			if (/FROM\s+"skills"/i.test(sql)) return [{ name: "deeplake-recall", scope: "team", visibility: "global" }];
			return [];
		});
		const view = await fetchSkillSyncView(storage, SCOPE_OK, async () => localInventory("local-only-skill"));
		const byName = new Map(view.skills.map((s) => [s.name, s.syncState]));
		expect(byName.get("deeplake-recall")).toBe("shared"); // substrate state preserved
		expect(byName.get("local-only-skill")).toBe("local"); // disk-only → local
	});

	it("b-AC-2: a skill both on disk AND in the substrate appears once, with the substrate state", async () => {
		const storage = fakeStorage((sql) => {
			if (/FROM\s+"skills"/i.test(sql)) return [{ name: "shared-skill", scope: "team", visibility: "global" }];
			return [];
		});
		// The disk inventory includes the same name (case-insensitive) — it must NOT double-count.
		const view = await fetchSkillSyncView(storage, SCOPE_OK, async () => localInventory("Shared-Skill"));
		const matches = view.skills.filter((s) => s.name.toLowerCase() === "shared-skill");
		expect(matches).toHaveLength(1);
		expect(matches[0]?.syncState).toBe("shared"); // substrate wins, never `local`
	});

	it("b-AC-3: empty substrate + disk skills → the union shows the local skills (not '0 / No skills synced')", async () => {
		const storage = fakeStorage(() => []); // empty `skills` table
		const view = await fetchSkillSyncView(storage, SCOPE_OK, async () => localInventory("alpha", "beta", "gamma"));
		expect(view.skills).toHaveLength(3);
		expect(view.skills.every((s) => s.syncState === "local")).toBe(true);
	});

	it("b-AC-4: a synced-only workspace (no extra local skills) renders exactly as before", async () => {
		const storage = fakeStorage((sql) => {
			if (/FROM\s+"skills"/i.test(sql))
				return [
					{ name: "s-shared", scope: "team", visibility: "global" },
					{ name: "s-pulled", scope: "personal", visibility: "local" },
				];
			return [];
		});
		const view = await fetchSkillSyncView(storage, SCOPE_OK, async () => ({ skills: [], agents: [] }));
		expect(view.skills).toEqual([
			{ name: "s-shared", scope: "team", syncState: "shared" },
			{ name: "s-pulled", scope: "personal", syncState: "pulled" },
		]);
	});

	it("b-AC-6: a discovery error degrades to the substrate-only view (no crash)", async () => {
		const storage = fakeStorage((sql) => {
			if (/FROM\s+"skills"/i.test(sql)) return [{ name: "deeplake-recall", scope: "team", visibility: "global" }];
			return [];
		});
		// The injected scanner throws — the fetcher must still resolve to the substrate-only view.
		const view = await fetchSkillSyncView(storage, SCOPE_OK, async () => {
			throw new Error("scanner blew up");
		});
		expect(view.skills).toEqual([{ name: "deeplake-recall", scope: "team", syncState: "shared" }]);
	});
});

describe("PRD-041b: fetchMemoryGraphView serves the memory-graph view-model (GraphView-shaped, fail-soft)", () => {
	it("AC-1: a populated ontology → built:true with entities→nodes (ontology kind) + dependency edges", async () => {
		const storage = fakeStorage((sql) => {
			if (/FROM\s+"entities"/i.test(sql))
				return [
					{ id: "e1", name: "Alex", type: "entity" },
					{ id: "e2", name: "Honeycomb", type: "entity" },
				];
			if (/FROM\s+"entity_dependencies"/i.test(sql))
				return [{ source_entity_id: "e1", target_entity_id: "e2", type: "depends_on" }];
			return [];
		});
		const view = await fetchMemoryGraphView(storage, SCOPE_OK);
		expect(view.built).toBe(true);
		expect(view.nodes).toEqual([
			{ id: "e1", label: "Alex", kind: "entity" },
			{ id: "e2", label: "Honeycomb", kind: "entity" },
		]);
		// The dependency relation rides the edge `kind` (depends_on) — no special-casing.
		expect(view.edges).toEqual([{ from: "e1", to: "e2", kind: "depends_on" }]);
	});

	it("AC-4: an EMPTY ontology → the honest built:false empty state (not an error, not a faked graph)", async () => {
		const storage = fakeStorage(() => []); // no entities, no dependencies
		const view = await fetchMemoryGraphView(storage, SCOPE_OK);
		expect(view.built).toBe(false);
		expect(view.nodes).toHaveLength(0);
		expect(view.edges).toHaveLength(0);
	});

	it("AC-2: a forced storage error fails soft to built:false (never a throw)", async () => {
		const storage = fakeStorage((sql) => {
			if (/FROM\s+"entities"/i.test(sql)) return "error";
			return [];
		});
		const view = await fetchMemoryGraphView(storage, SCOPE_OK);
		expect(view.built).toBe(false);
		expect(view.nodes).toHaveLength(0);
	});

	it("a dependency edge with a missing endpoint is dropped (no half-edge)", async () => {
		const storage = fakeStorage((sql) => {
			if (/FROM\s+"entities"/i.test(sql)) return [{ id: "e1", name: "Alex", type: "entity" }];
			// e2 is not in the entity set → this edge must be filtered out.
			if (/FROM\s+"entity_dependencies"/i.test(sql))
				return [{ source_entity_id: "e1", target_entity_id: "e2", type: "depends_on" }];
			return [];
		});
		const view = await fetchMemoryGraphView(storage, SCOPE_OK);
		expect(view.built).toBe(true);
		expect(view.nodes).toHaveLength(1);
		expect(view.edges).toHaveLength(0);
	});

	it("AC-2: the read uses guarded SQL (sqlIdent identifiers) and carries NO org_id predicate (engine table)", async () => {
		const seen: string[] = [];
		const storage = fakeStorage((sql) => {
			seen.push(sql);
			if (/FROM\s+"entities"/i.test(sql)) return [{ id: "e1", name: "Alex", type: "entity" }];
			return [];
		});
		await fetchMemoryGraphView(storage, SCOPE_OK);
		const entitiesSql = seen.find((s) => /FROM\s+"entities"/i.test(s)) ?? "";
		// Identifiers are double-quoted (sqlIdent floor); the engine tables have no org_id column, so
		// the read must NOT filter by org_id (scope isolation rides storage.query(sql, scope)).
		expect(entitiesSql).toContain('FROM "entities"');
		expect(entitiesSql.toLowerCase()).not.toContain("org_id");
	});
});

describe("PRD-041b: GET /api/diagnostics/memory-graph endpoint (mirrors /api/graph)", () => {
	it("AC-1/AC-3: AFTER attach returns the memory-graph view-model (built:true) for a populated ontology", async () => {
		const { daemon, storage } = makeDaemon(true);
		mountDashboardApi(daemon, { storage });
		const res = await daemon.app.request("/api/diagnostics/memory-graph", { headers: headers() });
		expect(res.status).toBe(200);
		const json = (await res.json()) as { built: boolean; nodes: unknown[]; edges: unknown[] };
		expect(json.built).toBe(true);
		expect(json.nodes).toHaveLength(2);
		expect(json.edges).toHaveLength(1);
	});

	it("AC-4: returns the honest built:false empty state (200) when the ontology is empty", async () => {
		const { daemon, storage } = makeDaemon(false);
		mountDashboardApi(daemon, { storage });
		const res = await daemon.app.request("/api/diagnostics/memory-graph", { headers: headers() });
		expect(res.status).toBe(200); // NOT an error
		const json = (await res.json()) as { built: boolean; nodes: unknown[] };
		expect(json.built).toBe(false);
		expect(json.nodes).toHaveLength(0);
	});

	it("BEFORE attach: the diagnostics group answers the 501 scaffold for the memory-graph path", async () => {
		const { daemon } = makeDaemon(true);
		const res = await daemon.app.request("/api/diagnostics/memory-graph", { headers: headers() });
		expect(res.status).toBe(501);
	});

	it("AC-6: no secret rides the response — only entity/edge graph text (grep the body)", async () => {
		const { daemon, storage } = makeDaemon(true);
		mountDashboardApi(daemon, { storage });
		const body = await (await daemon.app.request("/api/diagnostics/memory-graph", { headers: headers() })).text();
		// The body is graph text only (ids/labels/kinds). No token/secret/credential field by construction.
		expect(body.toLowerCase()).not.toContain("token");
		expect(body.toLowerCase()).not.toContain("secret");
		expect(body.toLowerCase()).not.toContain("api_key");
	});

	it("fail-closed: a request with no resolvable org 400s (mirrors /api/graph)", async () => {
		const { daemon, storage } = makeDaemon(true);
		mountDashboardApi(daemon, { storage });
		const res = await daemon.app.request("/api/diagnostics/memory-graph", {});
		expect(res.status).toBe(400);
	});
});

describe("PRD-036c: the Team-skills KPI counts only team-shared substrate skills", () => {
	it("c-AC-1/c-AC-3: teamSkillCount comes from the synced_assets count; local/pulled do not inflate it", async () => {
		// The substrate count query returns 2 shared skills; the local disk skills (via the union, a
		// SEPARATE concern) must NOT change this KPI — it reads the defined count, not an array length.
		const storage = fakeStorage((sql) => {
			if (/FROM\s+"synced_assets"/i.test(sql)) return [{ n: 2 }];
			if (/FROM\s+"memories"/i.test(sql)) return [{ chars: 0 }];
			return [];
		});
		const view = await fetchKpisView(storage, SCOPE_OK);
		expect(view.teamSkillCount).toBe(2);
	});

	it("c-AC-2: nothing shared → the KPI is 0 (honest), independent of any local disk skills", async () => {
		const storage = fakeStorage((sql) => {
			if (/FROM\s+"synced_assets"/i.test(sql)) return [{ n: 0 }];
			return [];
		});
		const view = await fetchKpisView(storage, SCOPE_OK);
		expect(view.teamSkillCount).toBe(0);
	});
});
