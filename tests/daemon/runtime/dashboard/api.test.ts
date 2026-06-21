/**
 * PRD-020b daemon-side dashboard API suite — the `mountDashboardApi` attach step.
 *
 * `mountDashboardApi` is the single named seam the daemon assembly calls after
 * `createDaemon(...)` to wire the six dashboard read handlers onto the already-mounted route
 * groups (`/api/diagnostics`, `/api/graph`). This suite proves: BEFORE the attach the
 * diagnostics group answers the 501 scaffold; AFTER the attach each endpoint is LIVE and returns
 * the matching 020b view-model shape, read through the injected storage client (storage-correct —
 * never a raw fetch). It also proves the graph empty-state (b-AC-6) and the built-graph canvas
 * (b-AC-3) come from the daemon's graph endpoint.
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
import { buildSettingsView, mountDashboardApi } from "../../../../src/daemon/runtime/dashboard/api.js";
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
		if (/FROM\s+"memory"/i.test(sql)) return [{ n: 42 }];
		if (/COUNT\(\*\).*FROM\s+"sessions"/i.test(sql)) return [{ n: 7 }];
		if (/FROM\s+"sessions"/i.test(sql))
			return [{ id: "sess-1", project: "honeycomb", creation_date: "2026-06-18", path: "conversations/sess-1" }];
		if (/FROM\s+"codebase"/i.test(sql)) {
			if (!graphBuilt) return [];
			return [
				{
					snapshot_jsonb: JSON.stringify({
						nodes: [{ id: "n1", label: "index.ts", kind: "file" }],
						edges: [{ from: "n1", to: "n1", kind: "self" }],
					}),
					node_count: 1,
					edge_count: 1,
				},
			];
		}
		if (/FROM\s+"rules"/i.test(sql)) return [{ id: "r1", name: "Use ESM", status: "active" }];
		if (/FROM\s+"skills"/i.test(sql)) return [{ name: "deeplake-recall", scope: "team", visibility: "global" }];
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
		expect(json.estimatedSavings).toBe(0);
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

	it("b-AC-3: /api/graph returns built:true with the canvas nodes/edges from the snapshot", async () => {
		const { daemon, storage } = makeDaemon(true);
		mountDashboardApi(daemon, { storage });
		const res = await daemon.app.request("/api/graph", { headers: headers() });
		const json = (await res.json()) as { built: boolean; nodes: unknown[]; edges: unknown[] };
		expect(json.built).toBe(true);
		expect(json.nodes).toHaveLength(1);
		expect(json.edges).toHaveLength(1);
	});

	it("b-AC-6: /api/graph returns built:false (empty-state flag) when no snapshot exists", async () => {
		const { daemon, storage } = makeDaemon(false);
		mountDashboardApi(daemon, { storage });
		const res = await daemon.app.request("/api/graph", { headers: headers() });
		expect(res.status).toBe(200); // NOT an error
		const json = (await res.json()) as { built: boolean; nodes: unknown[] };
		expect(json.built).toBe(false);
		expect(json.nodes).toHaveLength(0);
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
});

describe("PRD-024 Wave 3 local-mode default-scope fallback (the dashboard-panel 400 regression fix)", () => {
	// The dashboard web app is a loopback thin client (like the SDK/MCP): it sends the
	// runtime-path + session headers but NOT x-honeycomb-org. BEFORE Wave 3 every diagnostics
	// view + /api/graph 400'd on that, blanking every panel. AFTER Wave 3, in LOCAL mode with a
	// configured default tenant, the view falls back to it (200), exactly like the memories API.

	/** The six diagnostics/graph view paths the browser client GETs (the panels that blanked). */
	const VIEW_PATHS = [
		"/api/diagnostics/kpis",
		"/api/diagnostics/sessions",
		"/api/diagnostics/settings",
		"/api/diagnostics/rules",
		"/api/diagnostics/skills",
		"/api/graph",
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
