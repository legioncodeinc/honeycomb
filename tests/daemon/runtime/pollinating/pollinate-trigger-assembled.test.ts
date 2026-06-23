/**
 * PRD-045d d-AC-3 — the "Pollinate now" trigger acks cleanly on the FULLY-ASSEMBLED daemon when
 * pollinating is OFF, in PLAIN CI (fake storage, no token, no network, no model).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE WHOLE POINT (mirrors `ontology-surface-assembled.test.ts` / PRD-031 Wave A).
 * A green UNIT test mounts `mountPollinateApi` in isolation (see `pollinating/api.test.ts`) and
 * cannot see whether the COMPOSITION ROOT actually fired the seam in real order behind the
 * real middleware. d-AC-3 demands the live posture: with pollinating in its DEFAULT-OFF state
 * (D-045d-1), `POST /api/diagnostics/pollinate` on the assembled daemon must still ACK CLEANLY
 * — `{ triggered: false, status: "skipped", reason: "disabled" }`, HTTP 202 — and NEVER
 * crash, even though no pollinating worker is running to lease the job. This boots the REAL
 * daemon through `assembleDaemon` → `assembleSeams` (every seam, real order, real
 * middleware) backed by a FAKE storage client and drives the endpoint via `app.request`.
 *
 * Deterministic by construction (d-AC-3 needs NO token):
 *   - The pollinate endpoint is mounted UNCONDITIONALLY (gated on queue availability, NOT on
 *     pollinating-enabled): `assembleSeams` fires `mountPollinate(daemon, { …, enqueuer:
 *     daemon.services.queue })`, and the assembled daemon's queue is the REAL
 *     `createJobQueueService` over the fake storage — so `available` is true and the handler
 *     builds the REAL `PollinatingTrigger` from the env-resolved config.
 *   - With `HONEYCOMB_POLLINATING_ENABLED` unset/false, the trigger's enabled gate fires →
 *     `{ decision: "disabled" }` → the `{ triggered:false, status:"skipped" }` ack. The
 *     fake storage answers every counter read/append `ok([])`, so the path is hermetic.
 *
 * The env is saved + restored so the master switch never leaks across tests.
 * ════════════════════════════════════════════════════════════════════════════
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type AssembledTestDaemonApp,
	assembleTestDaemonApp,
} from "../../../integration/_daemon-harness.js";
import type { PollinateAck } from "../../../../src/daemon/runtime/pollinating/api.js";

/** local-mode loopback tenancy headers (the pollinate handler falls back to the default tenant). */
const HEADERS = { "x-honeycomb-org": "local", "x-honeycomb-workspace": "default" } as const;

/** POST to the assembled pollinate endpoint and return the parsed ack + status. */
async function postPollinate(net: AssembledTestDaemonApp, headers: Record<string, string> = HEADERS): Promise<{ status: number; ack: PollinateAck }> {
	const res = await net.app.request("/api/diagnostics/pollinate", { method: "POST", headers });
	const ack = (await res.json()) as PollinateAck;
	return { status: res.status, ack };
}

describe("PRD-045d d-AC-3 — Pollinate-now acks cleanly with pollinating OFF on the assembled daemon (plain CI)", () => {
	// Save + restore the master switch so the OFF posture is asserted deterministically and
	// never leaks to / from a sibling test that toggles it.
	let prevEnabled: string | undefined;
	beforeEach(() => {
		prevEnabled = process.env.HONEYCOMB_POLLINATING_ENABLED;
		delete process.env.HONEYCOMB_POLLINATING_ENABLED; // DEFAULT-OFF (D-045d-1).
	});
	afterEach(() => {
		if (prevEnabled === undefined) delete process.env.HONEYCOMB_POLLINATING_ENABLED;
		else process.env.HONEYCOMB_POLLINATING_ENABLED = prevEnabled;
	});

	it("POST /api/diagnostics/pollinate → 202 { triggered:false, status:'skipped', reason:'disabled' } (no crash)", async () => {
		const net = assembleTestDaemonApp({ mode: "local" });

		const { status, ack } = await postPollinate(net);

		// A clean ack on the assembled daemon — NOT a 500, NOT a 501 scaffold, NOT a hang.
		expect(status, "the pollinate trigger acks 202 even with pollinating OFF").toBe(202);
		expect(ack).toEqual({ triggered: false, status: "skipped", reason: "disabled" });
	});

	it("the OFF ack is queued-safe: nothing is enqueued and the request resolves promptly", async () => {
		const net = assembleTestDaemonApp({ mode: "local" });

		const start = Date.now();
		const { status, ack } = await postPollinate(net);
		const elapsed = Date.now() - start;

		expect(status).toBe(202);
		expect(ack.triggered, "pollinating OFF → nothing triggered").toBe(false);
		// The handler awaits only the cheap trigger evaluation (which short-circuits on the
		// disabled gate), never a consolidation pass — so it returns promptly.
		// A generous wall-clock ceiling: the behavioral asserts above already prove the
		// short-circuit (nothing enqueued, triggered:false). A tight 2s bound flaked under CI
		// load; 10s still catches a real "blocks on a consolidation pass" regression.
		expect(elapsed, "the disabled trigger short-circuits — no blocking on a pass").toBeLessThan(10_000);

		// No `INSERT INTO "<jobs>"` reached the wire: a disabled trigger enqueues nothing
		// (FR-7 / a-AC-4 — the counter may be touched, but no pollinating job is queued).
		const enqueued = net.storage.requests.some(
			(r) => /^\s*INSERT\s+INTO/i.test(r.sql) && /job|queue|pollinating/i.test(r.sql),
		);
		expect(enqueued, "a disabled pollinating trigger queues NO job").toBe(false);
	});

	it("the assembled pollinate endpoint is reachable (mounted by the composition root, not 501)", async () => {
		// If `assembleSeams` had not fired `mountPollinate`, the POST would fall through to the
		// scaffold (404/501) instead of the 202 ack — this is the wiring proof d-AC-3 anchors.
		const net = assembleTestDaemonApp({ mode: "local" });
		const res = await net.app.request("/api/diagnostics/pollinate", { method: "POST", headers: HEADERS });
		expect(res.status, "the pollinate route is live on the assembled daemon").toBe(202);
		expect(res.status).not.toBe(501);
	});

	it("the OFF ack carries NO token/secret/header value (D-4 — grep-proven on the assembled path)", async () => {
		const net = assembleTestDaemonApp({ mode: "local" });
		const res = await net.app.request("/api/diagnostics/pollinate", { method: "POST", headers: HEADERS });
		const raw = await res.text();
		expect(raw).not.toMatch(/token|secret|bearer|authorization|x-honeycomb/i);
	});
});
