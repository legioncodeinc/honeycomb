/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  PRD-022d — the ASSEMBLED-daemon store→recall-over-HTTP proof (live).      ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  The 022d headline: with the three data seams FIRED BY `assembleDaemon`    ║
 * ║  (mountMemoriesApi / mountVfsApi / mountProductDataApi — d-AC-1), and the  ║
 * ║  CLI loopback client stamping the session-group headers (d-AC-2 / d-AC-3), ║
 * ║  a memory STORED through `POST /api/memories` is RECALLED through          ║
 * ║  `POST /api/memories/recall` — over real loopback HTTP, against LIVE        ║
 * ║  DeepLake, via the assembled daemon (no 501, no 400, no manual mount).     ║
 * ║                                                                          ║
 * ║  WHY THIS IS THE 022d PROOF (and not 022a's): the seams are fired by       ║
 * ║  `assembleDaemon` itself — this itest does NOT call `mountMemoriesApi`.    ║
 * ║  `bootTestDaemon({mode:"local"})` assembles the daemon, which now wires    ║
 * ║  the data surface (the whole point of d-AC-1). And the requests go through ║
 * ║  the REAL CLI loopback `DaemonClient`, so the d-AC-2/3 header-stamping path ║
 * ║  (`x-honeycomb-runtime-path` + synthetic `x-honeycomb-session`) is the     ║
 * ║  thing under test — the dogfood 400 fix proven end-to-end.                ║
 * ║                                                                          ║
 * ║    d-AC-2/3  the CLI client stamps the session headers → recall/remember   ║
 * ║              reach the handler (no 400 at the runtime-path middleware).     ║
 * ║    d-AC-1    the assembled daemon serves /api/memories (no 501).            ║
 * ║    d-AC-5    a no-session request is STILL 400'd at the edge after wiring.  ║
 * ║                                                                          ║
 * ║  GATED + ISOLATED (same posture as memories-api-live.itest.ts):           ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = skip,exit 0.║
 * ║    - `.itest.ts` + `tests/integration/**` exclusion keep it OUT of         ║
 * ║      `npm run ci`; only `npm run test:integration` runs it.              ║
 * ║    - Per-run UNIQUE term so the proof reads only THIS run's row.           ║
 * ║    - Ephemeral port (bootTestDaemon binds port 0 — never 3850).            ║
 * ║                                                                          ║
 * ║  120s CAP. SECRETS via env only (the storage layer's provider). Do NOT     ║
 * ║  run locally; the orchestrator runs it with creds. 022e dogfood builds     ║
 * ║  on this assembled-daemon proof.                                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createStorageClient,
	envCredentialProvider,
	type QueryScope,
	resolveStorageConfig,
} from "../../src/daemon/storage/index.js";
import { createLoopbackDaemonClient, type DaemonClient } from "../../src/commands/index.js";
import { bootTestDaemon, type BootedTestDaemon } from "./_daemon-harness.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

/** A per-run unique id so the proof reads only THIS run's rows (never real data). */
function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
/** The deterministic, per-run-unique recall term seeded into the stored memory. */
const RECALL_TERM = `assembled${RUN_ID}`;

describe.skipIf(!HAS_TOKEN)("PRD-022d assembled-daemon store→recall over HTTP via the CLI client (live)", () => {
	let booted: BootedTestDaemon;
	let client: DaemonClient;
	let scope: QueryScope;
	/** The tenancy headers the CLI client carries; the session/runtime-path headers it stamps itself. */
	let tenancyHeaders: Record<string, string>;

	beforeAll(async () => {
		// Resolve the token's authorized tenancy from the env provider — the SAME scope the
		// assembled daemon's storage client resolves — so the stored row lands in-scope.
		const raw = envCredentialProvider().read();
		const provider = {
			read: () => ({
				...raw,
				workspace: process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "honeycomb_ci",
				queryTimeoutMs: 120_000,
			}),
		};
		const config = resolveStorageConfig(provider);
		scope = { org: config.org, workspace: config.workspace };

		// Boot the REAL assembled daemon against live DeepLake on an ephemeral port. The
		// assembly FIRES the three data seams (d-AC-1) — we do NOT mount anything manually.
		// That is the whole point of 022d: the seams are wired into assembleDaemon.
		booted = await bootTestDaemon({ mode: "local", storage: createStorageClient({ provider }) });

		// Drive the requests through the REAL CLI loopback client (d-AC-2/3): it stamps the
		// session-group headers (runtime-path + synthetic session) automatically for /api/memories.
		tenancyHeaders = {
			"x-honeycomb-org": scope.org,
			"x-honeycomb-workspace": scope.workspace ?? "honeycomb_ci",
		};
		client = createLoopbackDaemonClient({ baseUrl: booted.baseUrl, headers: tenancyHeaders });
	}, 120_000);

	afterAll(async () => {
		if (booted) await booted.stop();
	});

	it(
		"d-AC-1 + d-AC-2/3: the assembled daemon stores then recalls a memory over HTTP via the CLI client",
		async () => {
			// ── d-AC-5: a request with NO session header is STILL 400'd at the edge after wiring.
			// (Drive a raw fetch WITHOUT the client so the session header is absent.)
			const noSession = await fetch(`${booted.baseUrl}/api/memories/recall`, {
				method: "POST",
				headers: {
					"x-honeycomb-org": scope.org,
					"x-honeycomb-workspace": scope.workspace ?? "honeycomb_ci",
					"x-honeycomb-runtime-path": "legacy",
					"content-type": "application/json",
				},
				body: JSON.stringify({ query: RECALL_TERM }),
			});
			expect(noSession.status, "d-AC-5: no session header → 400 before the handler").toBe(400);

			// ── d-AC-1 + d-AC-3: STORE through the CLI client (it stamps the session headers). ──
			const stored = await client.send({
				method: "POST",
				path: "/api/memories",
				body: { content: `the ${RECALL_TERM} subsystem proves assembled recall over HTTP` },
			});
			expect(stored.status, "d-AC-1: store landed a row (201, not 501/400)").toBe(201);
			const storedBody = stored.body as { id: string | null; action: string };
			expect(storedBody.action, "the controlled-writes engine inserted (or deduped) a row").toMatch(
				/inserted|deduped/,
			);

			// ── d-AC-1 + d-AC-3: RECALL through the CLI client (poll-convergent — eventual consistency). ──
			let recalled = false;
			let lastStatus = 0;
			for (let poll = 0; poll < 40 && !recalled; poll++) {
				const recall = await client.send({ method: "POST", path: "/api/memories/recall", body: { query: RECALL_TERM } });
				lastStatus = recall.status;
				expect(recall.status, "d-AC-3: recall reaches the handler (no 400/501)").toBe(200);
				const body = recall.body as { hits: { source: string; id: string; text: string }[]; degraded: boolean };
				if (body.hits.some((h) => h.text.includes(RECALL_TERM))) recalled = true;
				if (!recalled) await new Promise((r) => setTimeout(r, 350));
			}
			expect(recalled, "d-AC-1/3: the stored memory recalls over HTTP through the assembled daemon").toBe(true);

			// eslint-disable-next-line no-console
			console.log(
				`[022d receipt] assembled store→recall via CLI client: term=${RECALL_TERM} recalled=${recalled} lastStatus=${lastStatus}`,
			);
		},
		120_000,
	);
});
