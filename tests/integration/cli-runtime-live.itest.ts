/**
 * GATED live itest — PRD-021b: the real loopback DaemonClient round-trips against a REAL assembled
 * daemon on live DeepLake, end-to-end, with NO fakes.
 *
 * Boots a REAL assembled daemon via 021a's `bootTestDaemon()` on an EPHEMERAL port (never 3850)
 * against live DeepLake, points the production loopback {@link DaemonClient} at that port, and
 * proves a real storage-touching request round-trips: `/health` reports the live storage
 * reachability, `/api/status` returns the daemon's real status, and the client `ping()` (the same
 * probe ensure-running + the D2 health dim use) answers true. Every code path is the production one.
 *
 * Gating + safety (per the smoker contract):
 *   - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` — skips clean with no token (exit 0).
 *   - `.itest.ts` — excluded from `npm run ci`'s `vitest run`; the orchestrator runs it.
 *   - EPHEMERAL port (the harness default, port 0) — never clobbers a real daemon on 3850.
 *   - 120s cap. The harness writes its PID/lock to a per-boot temp dir, not `~/.honeycomb`.
 *   - Do NOT run locally — the orchestrator runs it with the token set.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createLoopbackDaemonClient, type DaemonClient } from "../../src/commands/index.js";
import { type BootedTestDaemon, bootTestDaemon } from "./_daemon-harness.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

describe.skipIf(!HAS_TOKEN)("PRD-021b live — loopback DaemonClient round-trips a real daemon", () => {
	let booted: BootedTestDaemon;
	let client: DaemonClient;

	beforeAll(async () => {
		// Boot a REAL assembled daemon on an ephemeral port against live DeepLake (local mode, D-3).
		booted = await bootTestDaemon();
		// Point the PRODUCTION loopback client at the ephemeral port (no fakes — real HTTP transport).
		client = createLoopbackDaemonClient({ baseUrl: booted.baseUrl });
	}, 120_000);

	afterAll(async () => {
		if (booted !== undefined) await booted.stop();
	});

	it("b-AC-1 the loopback client `ping()` answers true against the real daemon /health", async () => {
		const alive = await client.ping();
		expect(alive).toBe(true);
	});

	it("b-AC-1 a real GET /health round-trips and reports live storage reachability", async () => {
		const res = await client.send({ method: "GET", path: "/health" });
		expect(res.status).toBe(200);
		// /health reports the cached pipeline bit primed by a real `SELECT 1` against live DeepLake.
		const body = res.body as { status?: string } | undefined;
		expect(body?.status === "ok" || body?.status === "degraded").toBe(true);
	}, 120_000);

	it("b-AC-1 a real GET /api/status round-trips real daemon status (no fakes)", async () => {
		const res = await client.send({ method: "GET", path: "/api/status" });
		expect(res.status).toBe(200);
		expect(res.body).toBeTypeOf("object");
	}, 120_000);
});
