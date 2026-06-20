/**
 * PRD-021d daemon-side dashboard HOST suite — the `mountDashboardHost` attach step (d-AC-3).
 *
 * `mountDashboardHost` attaches `GET /dashboard` onto the daemon's root group, builds a
 * daemon-side data source from the live storage (the shared view fetchers), runs the 020b
 * `renderDashboard`, and serves the serialized HTML page. This suite proves: BEFORE the attach
 * the route is unmounted (404/501 scaffold); AFTER the attach `GET /dashboard` returns an HTML
 * page carrying the SIX canonical 020b view titles, and the not-built graph renders the 020b
 * empty-state prompt (d-AC-6) rather than an error.
 */

import { describe, expect, it } from "vitest";

import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import { mountDashboardHost } from "../../../../src/daemon/runtime/dashboard/host.js";
import { GRAPH_BUILD_PROMPT } from "../../../../src/dashboard/views.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const ORG = "fake-org";
const WORKSPACE = "fake-ws";

function cfg(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
}

const fixedScope = { resolve: () => ({ org: ORG, workspace: WORKSPACE }) };

/** A SQL-aware responder routing each dashboard read to canned rows. `graphBuilt` toggles d-AC-6. */
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

describe("PRD-021d mountDashboardHost serves the viewable dashboard page", () => {
	it("BEFORE attach: GET /dashboard is not served", async () => {
		const { daemon } = makeDaemon(true);
		const res = await daemon.app.request("/dashboard");
		// Root group is unprotected; with no handler the request falls through to 404.
		expect(res.status).toBe(404);
	});

	it("d-AC-3: AFTER attach: GET /dashboard returns an HTML page with the six view titles", async () => {
		const { daemon, storage } = makeDaemon(true);
		mountDashboardHost(daemon, { storage, scope: fixedScope });
		const res = await daemon.app.request("/dashboard");
		expect(res.status).toBe(200);
		expect(res.headers.get("content-type")).toContain("text/html");
		const html = await res.text();
		// The six canonical 020b view titles, in the rendered page.
		for (const title of ["KPIs", "Sessions", "Settings", "Codebase graph", "Rules", "Skill-sync"]) {
			expect(html).toContain(title);
		}
		// It is a real, standalone page (doctype + body), not a fragment.
		expect(html).toContain("<!doctype html>");
		expect(html).toContain('data-connectivity="reachable"');
		// Real data flowed through (memory count + the session id).
		expect(html).toContain("Memories: 42");
		expect(html).toContain("sess-1");
	});

	it("d-AC-6: a not-built graph renders the 020b empty-state prompt, not an error", async () => {
		const { daemon, storage } = makeDaemon(false);
		mountDashboardHost(daemon, { storage, scope: fixedScope });
		const res = await daemon.app.request("/dashboard");
		expect(res.status).toBe(200);
		const html = await res.text();
		expect(html).toContain(GRAPH_BUILD_PROMPT);
	});

	it("d-AC-4: the served page exposes the live-log panel slot", async () => {
		const { daemon, storage } = makeDaemon(true);
		mountDashboardHost(daemon, { storage, scope: fixedScope });
		const res = await daemon.app.request("/dashboard");
		const html = await res.text();
		expect(html).toContain('id="hc-live-log"');
	});
});
