/**
 * PRD-045d d-AC-3 — the "Dream now" trigger acks cleanly on the FULLY-ASSEMBLED daemon when
 * dreaming is OFF, in PLAIN CI (fake storage, no token, no network, no model).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE WHOLE POINT (mirrors `ontology-surface-assembled.test.ts` / PRD-031 Wave A).
 * A green UNIT test mounts `mountDreamApi` in isolation (see `dreaming/api.test.ts`) and
 * cannot see whether the COMPOSITION ROOT actually fired the seam in real order behind the
 * real middleware. d-AC-3 demands the live posture: with dreaming in its DEFAULT-OFF state
 * (D-045d-1), `POST /api/diagnostics/dream` on the assembled daemon must still ACK CLEANLY
 * — `{ triggered: false, status: "skipped", reason: "disabled" }`, HTTP 202 — and NEVER
 * crash, even though no dreaming worker is running to lease the job. This boots the REAL
 * daemon through `assembleDaemon` → `assembleSeams` (every seam, real order, real
 * middleware) backed by a FAKE storage client and drives the endpoint via `app.request`.
 *
 * Deterministic by construction (d-AC-3 needs NO token):
 *   - The dream endpoint is mounted UNCONDITIONALLY (gated on queue availability, NOT on
 *     dreaming-enabled): `assembleSeams` fires `mountDream(daemon, { …, enqueuer:
 *     daemon.services.queue })`, and the assembled daemon's queue is the REAL
 *     `createJobQueueService` over the fake storage — so `available` is true and the handler
 *     builds the REAL `DreamingTrigger` from the env-resolved config.
 *   - With `HONEYCOMB_DREAMING_ENABLED` unset/false, the trigger's enabled gate fires →
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
import type { DreamAck } from "../../../../src/daemon/runtime/dreaming/api.js";

/** local-mode loopback tenancy headers (the dream handler falls back to the default tenant). */
const HEADERS = { "x-honeycomb-org": "local", "x-honeycomb-workspace": "default" } as const;

/** POST to the assembled dream endpoint and return the parsed ack + status. */
async function postDream(net: AssembledTestDaemonApp, headers: Record<string, string> = HEADERS): Promise<{ status: number; ack: DreamAck }> {
	const res = await net.app.request("/api/diagnostics/dream", { method: "POST", headers });
	const ack = (await res.json()) as DreamAck;
	return { status: res.status, ack };
}

describe("PRD-045d d-AC-3 — Dream-now acks cleanly with dreaming OFF on the assembled daemon (plain CI)", () => {
	// Save + restore the master switch so the OFF posture is asserted deterministically and
	// never leaks to / from a sibling test that toggles it.
	let prevEnabled: string | undefined;
	beforeEach(() => {
		prevEnabled = process.env.HONEYCOMB_DREAMING_ENABLED;
		delete process.env.HONEYCOMB_DREAMING_ENABLED; // DEFAULT-OFF (D-045d-1).
	});
	afterEach(() => {
		if (prevEnabled === undefined) delete process.env.HONEYCOMB_DREAMING_ENABLED;
		else process.env.HONEYCOMB_DREAMING_ENABLED = prevEnabled;
	});

	it("POST /api/diagnostics/dream → 202 { triggered:false, status:'skipped', reason:'disabled' } (no crash)", async () => {
		const net = assembleTestDaemonApp({ mode: "local" });

		const { status, ack } = await postDream(net);

		// A clean ack on the assembled daemon — NOT a 500, NOT a 501 scaffold, NOT a hang.
		expect(status, "the dream trigger acks 202 even with dreaming OFF").toBe(202);
		expect(ack).toEqual({ triggered: false, status: "skipped", reason: "disabled" });
	});

	it("the OFF ack is queued-safe: nothing is enqueued and the request resolves promptly", async () => {
		const net = assembleTestDaemonApp({ mode: "local" });

		const start = Date.now();
		const { status, ack } = await postDream(net);
		const elapsed = Date.now() - start;

		expect(status).toBe(202);
		expect(ack.triggered, "dreaming OFF → nothing triggered").toBe(false);
		// The handler awaits only the cheap trigger evaluation (which short-circuits on the
		// disabled gate), never a consolidation pass — so it returns promptly.
		expect(elapsed, "the disabled trigger short-circuits — no blocking on a pass").toBeLessThan(2_000);

		// No `INSERT INTO "<jobs>"` reached the wire: a disabled trigger enqueues nothing
		// (FR-7 / a-AC-4 — the counter may be touched, but no dreaming job is queued).
		const enqueued = net.storage.requests.some(
			(r) => /^\s*INSERT\s+INTO/i.test(r.sql) && /job|queue|dreaming/i.test(r.sql),
		);
		expect(enqueued, "a disabled dreaming trigger queues NO job").toBe(false);
	});

	it("the assembled dream endpoint is reachable (mounted by the composition root, not 501)", async () => {
		// If `assembleSeams` had not fired `mountDream`, the POST would fall through to the
		// scaffold (404/501) instead of the 202 ack — this is the wiring proof d-AC-3 anchors.
		const net = assembleTestDaemonApp({ mode: "local" });
		const res = await net.app.request("/api/diagnostics/dream", { method: "POST", headers: HEADERS });
		expect(res.status, "the dream route is live on the assembled daemon").toBe(202);
		expect(res.status).not.toBe(501);
	});

	it("the OFF ack carries NO token/secret/header value (D-4 — grep-proven on the assembled path)", async () => {
		const net = assembleTestDaemonApp({ mode: "local" });
		const res = await net.app.request("/api/diagnostics/dream", { method: "POST", headers: HEADERS });
		const raw = await res.text();
		expect(raw).not.toMatch(/token|secret|bearer|authorization|x-honeycomb/i);
	});
});
