/**
 * PRD-024 "Dream now" trigger seam suite — AC-6 (backend half).
 *
 * Verification posture (mirrors the dashboard/logs seam suites): the seam is mounted on a
 * REAL daemon (`createDaemon` with a `local`-mode config so the `/api/diagnostics` group's
 * permission middleware is open) and exercised in-process via `daemon.app.request(...)` —
 * no socket, no live DeepLake, no live model. A FAKE {@link DreamTriggerSeam} records the
 * call and scripts the decision, so each test proves the wiring + the ack contract without
 * touching the real dreaming subsystem.
 *
 * The cases prove:
 *  - AC-6 enqueue: `POST /api/diagnostics/dream` → 202 + `{triggered:true,status:"enqueued"}`
 *    and the fake trigger fired EXACTLY ONCE.
 *  - AC-6 disabled guard: the dreaming-disabled path → `{triggered:false,status:"skipped"}`
 *    WITHOUT invoking the loop a second time (the trigger reports `disabled`, no enqueue).
 *  - AC-6 already-running guard: a pending pass → `{triggered:true,status:"running"}`.
 *  - AC-6 fail-closed edge: a request with NO resolvable org (team mode, no default org) is
 *    400'd at the edge, consistent with the other diagnostics handlers.
 *  - D-4 no-secret: the ack body carries no token/secret/header value.
 *  - Fail-soft: when the dreaming subsystem is unavailable (no real queue) the handler
 *    returns a clean `{triggered:false,...,reason:"unavailable"}` — never a 500.
 *  - Non-blocking: the handler resolves promptly (it awaits only the enqueue, not the pass).
 */

import { describe, expect, it } from "vitest";

import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import {
	type DreamAck,
	type DreamTriggerSeam,
	mountDreamApi,
} from "../../../../src/daemon/runtime/dreaming/api.js";
import type { DreamingScope, DreamingTickResult } from "../../../../src/daemon/runtime/dreaming/trigger.js";
import type { QueryScope } from "../../../../src/daemon/storage/client.js";

/** A resolved config for the daemon under test (local mode → open diagnostics middleware). */
function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false, ...over };
}

/** A minimal fake storage client — the dream seam's trigger override never touches it. */
const fakeStorage = { async query() { return { kind: "ok", rows: [], durationMs: 0 }; } } as never;

/** The daemon's default tenancy scope (the single local tenant). */
const DEFAULT_SCOPE: QueryScope = { org: "local", workspace: "default" };

/**
 * A recording fake trigger seam: counts the calls + records the scope, and returns the
 * scripted {@link DreamingTickResult}. Lets a test assert "fired exactly once with the
 * default agent scope" and drive each decision branch deterministically.
 */
function recordingTrigger(result: DreamingTickResult): {
	trigger: DreamTriggerSeam;
	calls: { count: number; scopes: DreamingScope[] };
} {
	const calls = { count: 0, scopes: [] as DreamingScope[] };
	const trigger: DreamTriggerSeam = {
		async checkAndEnqueueDreaming(scope: DreamingScope): Promise<DreamingTickResult> {
			calls.count += 1;
			calls.scopes.push(scope);
			return result;
		},
	};
	return { trigger, calls };
}

/** Mount the dream seam on a fresh local-mode daemon with the supplied fake trigger. */
function daemonWithTrigger(trigger: DreamTriggerSeam, over: Partial<RuntimeConfig> = {}): Daemon {
	const daemon = createDaemon({ config: cfg(over), storage: fakeStorage, logger: createRequestLogger({ silent: true }) });
	mountDreamApi(daemon, { storage: fakeStorage, defaultScope: DEFAULT_SCOPE, trigger, available: true });
	return daemon;
}

/** POST to the dream endpoint and return the parsed ack + status. */
async function postDream(daemon: Daemon): Promise<{ status: number; ack: DreamAck }> {
	const res = await daemon.app.request("/api/diagnostics/dream", { method: "POST" });
	const ack = (await res.json()) as DreamAck;
	return { status: res.status, ack };
}

describe("AC-6 the Dream-now trigger kicks the real dreaming loop seam (non-blocking, 202 ack)", () => {
	it("AC-6 POST /api/diagnostics/dream returns 202 + {triggered:true,status:'enqueued'} and fires the trigger EXACTLY ONCE", async () => {
		const { trigger, calls } = recordingTrigger({ decision: "enqueued", reason: "threshold-met", tokens: 0, jobId: "job-1" });
		const daemon = daemonWithTrigger(trigger);

		const { status, ack } = await postDream(daemon);

		expect(status).toBe(202);
		expect(ack).toEqual({ triggered: true, status: "enqueued" });
		// The real dreaming loop seam was kicked exactly once, keyed by the default agent scope.
		expect(calls.count).toBe(1);
		expect(calls.scopes[0]).toEqual({ agentId: "default" });
	});

	it("AC-6 the dreaming-DISABLED guard returns {triggered:false,status:'skipped'} (no second enqueue path)", async () => {
		// The trigger reports `disabled` (the config master switch is off): it enqueues NOTHING.
		const { trigger, calls } = recordingTrigger({ decision: "disabled", reason: "disabled", tokens: 0 });
		const daemon = daemonWithTrigger(trigger);

		const { status, ack } = await postDream(daemon);

		expect(status).toBe(202);
		expect(ack).toEqual({ triggered: false, status: "skipped", reason: "disabled" });
		// The guard path still consults the trigger once (to learn it is disabled) but the
		// trigger never enqueues — the ack reflects "skipped", not "enqueued".
		expect(calls.count).toBe(1);
	});

	it("AC-6 an already-running pass (single-pending guard) returns {triggered:true,status:'running'}", async () => {
		const { trigger } = recordingTrigger({ decision: "skipped", reason: "pending", tokens: 42 });
		const daemon = daemonWithTrigger(trigger);

		const { status, ack } = await postDream(daemon);

		expect(status).toBe(202);
		expect(ack).toEqual({ triggered: true, status: "running", reason: "pending" });
	});

	it("AC-6 below-threshold (nothing to consolidate yet) also surfaces as {status:'running'} (the loop is healthy)", async () => {
		const { trigger } = recordingTrigger({ decision: "below_threshold", reason: "below-threshold", tokens: 10 });
		const daemon = daemonWithTrigger(trigger);

		const { ack } = await postDream(daemon);
		expect(ack).toEqual({ triggered: true, status: "running", reason: "below-threshold" });
	});
});

describe("AC-6 / D-4 security: fail-closed edge, no secret in the ack, fail-soft (never 500)", () => {
	it("a request with NO resolvable org fails closed at the edge (400) — consistent with the other diagnostics handlers", async () => {
		const { trigger, calls } = recordingTrigger({ decision: "enqueued", reason: "threshold-met", tokens: 0 });
		// Team mode + a malformed default scope (empty org) → no tenant resolvable → 400 at the edge.
		const daemon = createDaemon({
			config: cfg({ mode: "team" }),
			storage: fakeStorage,
			logger: createRequestLogger({ silent: true }),
		});
		mountDreamApi(daemon, { storage: fakeStorage, defaultScope: { org: "" }, trigger, available: true });

		// In team mode the protected group's permission middleware also gates this; either way the
		// request never reaches the loop and is never 202-enqueued.
		const res = await daemon.app.request("/api/diagnostics/dream", { method: "POST" });
		expect([400, 401, 403]).toContain(res.status);
		expect(res.status).not.toBe(202);
		// The dreaming loop was NOT kicked on a fail-closed request.
		expect(calls.count).toBe(0);
	});

	it("D-4 the ack body carries NO token/secret/header value (grep-proven)", async () => {
		const { trigger } = recordingTrigger({ decision: "enqueued", reason: "threshold-met", tokens: 0, jobId: "job-secret-shaped" });
		const daemon = daemonWithTrigger(trigger);

		const res = await daemon.app.request("/api/diagnostics/dream", { method: "POST" });
		const raw = await res.text();

		// The ack is just the decision + a short machine reason — no token, key, bearer, or
		// header value, and not even the internal job id leaks into the body.
		expect(raw).not.toMatch(/token|secret|bearer|authorization|x-honeycomb|job-secret-shaped/i);
		const ack = JSON.parse(raw) as DreamAck;
		expect(Object.keys(ack).sort()).toEqual(["status", "triggered"]);
	});

	it("fail-soft: when the dreaming subsystem is UNAVAILABLE the handler returns a clean {triggered:false,reason:'unavailable'} — never a 500", async () => {
		// No trigger, no enqueuer, available:false → the dreaming subsystem is not wired.
		const daemon = createDaemon({ config: cfg(), storage: fakeStorage, logger: createRequestLogger({ silent: true }) });
		mountDreamApi(daemon, { storage: fakeStorage, defaultScope: DEFAULT_SCOPE, available: false });

		const { status, ack } = await postDream(daemon);
		// A clean ack, NOT a 500: the button can show "dreaming unavailable" honestly.
		expect(status).toBe(202);
		expect(ack).toEqual({ triggered: false, status: "skipped", reason: "unavailable" });
	});

	it("NON-BLOCKING: the handler resolves promptly (it awaits the enqueue seam, never the consolidation pass)", async () => {
		// The fake trigger resolves immediately (it models the enqueue, not the model call). A real
		// runner pass would take seconds; the seam never awaits it, so the response is prompt.
		const { trigger } = recordingTrigger({ decision: "enqueued", reason: "threshold-met", tokens: 0 });
		const daemon = daemonWithTrigger(trigger);

		const start = Date.now();
		const { status } = await postDream(daemon);
		expect(status).toBe(202);
		// Generous bound — proves the handler did not block on a long-running pass.
		expect(Date.now() - start).toBeLessThan(1_000);
	});
});

describe("AC-6 mounting is fail-safe", () => {
	it("mountDreamApi is a no-op when the /api/diagnostics group is not mounted (unknown daemon shape)", () => {
		// A daemon-shaped object whose group() always returns undefined: the mount must not throw.
		const stub = {
			group: () => undefined,
			config: cfg(),
		} as unknown as Daemon;
		const { trigger } = recordingTrigger({ decision: "enqueued", reason: "threshold-met", tokens: 0 });
		expect(() => mountDreamApi(stub, { storage: fakeStorage, defaultScope: DEFAULT_SCOPE, trigger, available: true })).not.toThrow();
	});

	it("the endpoint is reachable on the protected diagnostics group in LOCAL mode (middleware open by design)", async () => {
		// A bare GET to the same path is NOT the trigger (POST only) — prove the POST route exists by
		// the 202 path above; here assert a GET falls through (not a 202), so we did not over-mount.
		const { trigger } = recordingTrigger({ decision: "enqueued", reason: "threshold-met", tokens: 0 });
		const daemon = daemonWithTrigger(trigger);
		const res = await daemon.app.request("/api/diagnostics/dream", { method: "GET" });
		expect(res.status).not.toBe(202);
	});
});
