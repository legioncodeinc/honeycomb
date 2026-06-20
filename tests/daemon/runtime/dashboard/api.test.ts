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
import { mountDashboardApi } from "../../../../src/daemon/runtime/dashboard/api.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const ORG = "fake-org";
const WORKSPACE = "fake-ws";

function cfg(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
}

function headers(): Record<string, string> {
	return { "x-honeycomb-org": ORG, "x-honeycomb-workspace": WORKSPACE };
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
