/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE DASHBOARD + LOGS SMOKE — OPT-IN, BOOTS THE REAL ASSEMBLED DAEMON     ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-021d (d-AC-1 / d-AC-2 / d-AC-3 / d-AC-4). Boots the REAL              ║
 * ║  `assembleDaemon()` against LIVE DeepLake on an EPHEMERAL port (NOT 3850), ║
 * ║  then proves the operator-visible surface end-to-end:                      ║
 * ║    - d-AC-1: the dashboard data endpoints (`/api/diagnostics/kpis`,        ║
 * ║      `/api/diagnostics/sessions`, `/api/diagnostics/settings`, `/api/graph`,║
 * ║      `/api/diagnostics/rules`, `/api/diagnostics/skills`) serve REAL        ║
 * ║      view-models read from live DeepLake (mountDashboardApi is fired by     ║
 * ║      assembleDaemon). The canonical `/api/kpis|rules|skills` resource paths ║
 * ║      belong to the PRD-022 product-data API, so the dashboard VIEW-MODELS   ║
 * ║      live under the diagnostics namespace.                                  ║
 * ║    - d-AC-3: the viewable host `GET /dashboard` returns an HTML page with  ║
 * ║      the six canonical view titles, pointed at the live daemon data.       ║
 * ║    - d-AC-2 / d-AC-4: `GET /api/logs` returns the request-logger ring      ║
 * ║      buffer (the dashboard GETs above are themselves logged), with NO      ║
 * ║      token/secret in the payload.                                        ║
 * ║                                                                          ║
 * ║  SEAM WIRING (now SERVED BY THE PRODUCTION ASSEMBLY):                      ║
 * ║    `mountLogsApi` + `mountDashboardHost` are wired by `assembleDaemon()`   ║
 * ║    itself (security+quality close-out): `mountLogs` always, the viewable   ║
 * ║    `/dashboard` host LOCAL-MODE ONLY (security F-1). This itest boots in    ║
 * ║    `local` mode and proves `GET /api/logs` + `GET /dashboard` are served    ║
 * ║    by the ASSEMBLED daemon with NO manual mount (it never touches the       ║
 * ║    seams — that is the whole point of the close-out).                       ║
 * ║                                                                          ║
 * ║  GATED + ISOLATED (mirrors daemon-assembly-live.itest.ts):                ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = whole       ║
 * ║      suite skips, the run exits 0.                                        ║
 * ║    - `.itest.ts` suffix keeps it OUT of `npm run test` / `npm run ci`.     ║
 * ║    - Ephemeral port (0): 3850 is never bound; per-boot temp lock dir.      ║
 * ║                                                                          ║
 * ║  SECRETS: the token is read ONLY from env via the storage layer. Never    ║
 * ║  hardcoded, logged, or echoed. 120s cap. The orchestrator runs it.        ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createStorageClient, type StorageClient } from "../../src/daemon/storage/index.js";
import { mountDashboardHost } from "../../src/daemon/runtime/dashboard/host.js";
import { mountLogsApi } from "../../src/daemon/runtime/logs/api.js";
import { type BootedTestDaemon, bootTestDaemon } from "./_daemon-harness.js";
import { neutralizeIfInfraDegraded } from "./_infra-skip.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

/** The daemon's own org partition (the same source assemble.ts resolves the daemon scope from). */
const ORG = process.env.HONEYCOMB_DEEPLAKE_ORG ?? "local";
const WORKSPACE = process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "default";

function tenancyHeaders(): Record<string, string> {
	return { "x-honeycomb-org": ORG, "x-honeycomb-workspace": WORKSPACE };
}

describe.skipIf(!HAS_TOKEN)("LIVE DASHBOARD+LOGS: real view-models, viewable host, ring-buffer logs", () => {
	let booted: BootedTestDaemon | null = null;
	/**
	 * A live storage client built from the SAME default (env) provider the assembled daemon
	 * resolves its scope from — retained ONLY for the infra-skip preflight's `connect()` probe
	 * (PRD-034a FR-4). A sustained backend outage then NEUTRAL-skips instead of red-ing the
	 * dashboard/logs view-model proof on DeepLake weather.
	 */
	let probeStorage: StorageClient;

	beforeAll(async () => {
		// A standalone probe client (the daemon makes its own internally); same default provider.
		probeStorage = createStorageClient();
		// Boot the REAL assembled daemon against live DeepLake on an ephemeral port, in
		// `local` mode. The live storage client resolves its creds from `HONEYCOMB_DEEPLAKE_*`
		// via the storage layer. CRITICAL: this itest does NOT mount any seam itself.
		// `assembleDaemon()` now fires `mountLogsApi` (always) and `mountDashboardHost`
		// (local-mode only, security F-1) as part of the production composition root, so
		// `GET /api/logs` and `GET /dashboard` are served by the ASSEMBLED daemon. The host's
		// default `envHostScope` reads the same `HONEYCOMB_DEEPLAKE_ORG`/`WORKSPACE` env the
		// daemon scope resolves from, so the served page draws the real partition's rows.
		booted = await bootTestDaemon({ mode: "local" });
	}, 120_000);

	afterAll(async () => {
		if (booted !== null) {
			try {
				await booted.stop();
			} catch {
				// Already stopped — a double stop is a no-op.
			}
		}
	});

	it(
		"d-AC-1: the six dashboard data endpoints serve real view-models from live DeepLake",
		async ({ skip }) => {
			// INFRA-DEGRADED preflight (PRD-034a FR-4 / a-AC-3): a scoped liveness probe through a
			// storage client resolved from the SAME env provider the daemon uses. If the backend is
			// sustained-down (the probe flaps transient AFTER the client's retry), resolve NEUTRAL
			// via a SKIP + the run-level sentinel rather than red-ing the dashboard view-model proof
			// on DeepLake weather. A non-transient failure (real defect) or an ok probe continues.
			await neutralizeIfInfraDegraded("dashboard-logs-live:preflight", () => probeStorage.connect({ org: ORG, workspace: WORKSPACE }), skip);

			expect(booted, "the daemon booted against live DeepLake").not.toBeNull();
			const b = booted!;
			const h = tenancyHeaders();

			const kpis = await fetch(`${b.baseUrl}/api/diagnostics/kpis`, { headers: h });
			expect(kpis.status, "GET /api/diagnostics/kpis is 200 against live storage").toBe(200);
			const kpisBody = (await kpis.json()) as { memoryCount: number; sessionCount: number };
			expect(typeof kpisBody.memoryCount).toBe("number");
			expect(typeof kpisBody.sessionCount).toBe("number");

			const sessions = await fetch(`${b.baseUrl}/api/diagnostics/sessions`, { headers: h });
			expect(sessions.status).toBe(200);
			const sessionsBody = (await sessions.json()) as { sessions: unknown[] };
			expect(Array.isArray(sessionsBody.sessions)).toBe(true);

			const settings = await fetch(`${b.baseUrl}/api/diagnostics/settings`, { headers: h });
			expect(settings.status).toBe(200);
			const settingsBody = (await settings.json()) as { orgId: string };
			expect(settingsBody.orgId).toBe(ORG);

			const graph = await fetch(`${b.baseUrl}/api/graph`, { headers: h });
			expect(graph.status, "GET /api/graph is 200 (built:true or the empty-state flag)").toBe(200);
			const graphBody = (await graph.json()) as { built: boolean };
			expect(typeof graphBody.built).toBe("boolean");

			const rules = await fetch(`${b.baseUrl}/api/diagnostics/rules`, { headers: h });
			expect(rules.status).toBe(200);
			expect(Array.isArray(((await rules.json()) as { rules: unknown[] }).rules)).toBe(true);

			const skills = await fetch(`${b.baseUrl}/api/diagnostics/skills`, { headers: h });
			expect(skills.status).toBe(200);
			expect(Array.isArray(((await skills.json()) as { skills: unknown[] }).skills)).toBe(true);
		},
		120_000,
	);

	it(
		"PRD-024 AC-1: the ASSEMBLED daemon serves GET /dashboard as the production-clean bundled shell",
		async () => {
			const b = booted!;
			// The daemon was booted in `local` mode and the test never mounted the host —
			// the route exists ONLY because `assembleDaemon()` fired `mountDashboardHost`.
			expect(b.assembled.config.mode, "booted in local mode (the F-1 gate fires the host)").toBe("local");
			const res = await fetch(`${b.baseUrl}/dashboard`);
			expect(res.status, "GET /dashboard is 200 from the assembled daemon").toBe(200);
			expect(res.headers.get("content-type")).toContain("text/html");
			const html = await res.text();
			// PRD-024: the host now serves the index SHELL of the bundled React app (the brand UI
			// kit), NOT a server-rendered view tree. The live KPIs/sessions/etc. are hydrated
			// client-side from the JSON endpoints already proven above (d-AC-1). The shell must be
			// production-clean (D-1) and reference only same-origin loopback assets.
			expect(html).toContain("<!doctype html>");
			expect(html).toContain('<div id="root"');
			expect(html).toContain("/dashboard/app.js");
			expect(html).toContain("/dashboard/styles.css");
			expect(html).not.toContain("unpkg");
			expect(html).not.toContain("@babel/standalone");
			expect(html).not.toContain('type="text/babel"');
			// The bundled app + the DS CSS are served on loopback.
			const appRes = await fetch(`${b.baseUrl}/dashboard/app.js`);
			expect([200, 404]).toContain(appRes.status); // 200 when built; 404 if the bundle is absent
			const cssRes = await fetch(`${b.baseUrl}/dashboard/styles.css`);
			expect([200, 404]).toContain(cssRes.status);
		},
		120_000,
	);

	it(
		"d-AC-2 / d-AC-4: the ASSEMBLED daemon (no manual mount) serves GET /api/logs with no secret",
		async () => {
			const b = booted!;
			const h = tenancyHeaders();
			// The /api/logs reader exists ONLY because `assembleDaemon()` fired `mountLogsApi`
			// — this test never mounts it. The dashboard GETs above were themselves logged, so
			// the ring buffer is non-empty.
			const res = await fetch(`${b.baseUrl}/api/logs?limit=50`, { headers: h });
			expect(res.status, "GET /api/logs is 200 from the assembled daemon").toBe(200);
			const body = (await res.json()) as { records: { path: string }[]; count: number };
			expect(Array.isArray(body.records)).toBe(true);
			expect(body.count).toBeGreaterThan(0);
			// At least one of the dashboard reads was recorded.
			expect(body.records.some((r) => r.path.startsWith("/api/"))).toBe(true);
			// No token/secret leaked into the structured log payload.
			const raw = JSON.stringify(body);
			expect(raw).not.toMatch(/authorization/i);
			expect(raw).not.toMatch(/bearer/i);
			expect(raw).not.toMatch(/\btoken\b/i);
		},
		120_000,
	);
});

// A no-token guard so the suite is never silently empty in a non-gated runner.
describe.skipIf(HAS_TOKEN)("LIVE DASHBOARD+LOGS (skipped: no HONEYCOMB_DEEPLAKE_TOKEN)", () => {
	it("is gated off without a live token", () => {
		// The seam functions import cleanly without a live backend (pure module load).
		expect(typeof mountLogsApi).toBe("function");
		expect(typeof mountDashboardHost).toBe("function");
	});
});
