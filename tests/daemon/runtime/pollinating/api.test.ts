/**
 * PRD-024 "Pollinate now" trigger seam suite — AC-6 (backend half).
 *
 * Verification posture (mirrors the dashboard/logs seam suites): the seam is mounted on a
 * REAL daemon (`createDaemon` with a `local`-mode config so the `/api/diagnostics` group's
 * permission middleware is open) and exercised in-process via `daemon.app.request(...)` —
 * no socket, no live DeepLake, no live model. A FAKE {@link PollinateTriggerSeam} records the
 * call and scripts the decision, so each test proves the wiring + the ack contract without
 * touching the real pollinating subsystem.
 *
 * The cases prove:
 *  - AC-6 enqueue: `POST /api/diagnostics/pollinate` → 202 + `{triggered:true,status:"enqueued"}`
 *    and the fake trigger fired EXACTLY ONCE.
 *  - AC-6 disabled guard: the pollinating-disabled path → `{triggered:false,status:"skipped"}`
 *    WITHOUT invoking the loop a second time (the trigger reports `disabled`, no enqueue).
 *  - AC-6 already-running guard: a pending pass → `{triggered:true,status:"running"}`.
 *  - AC-6 fail-closed edge: a request with NO resolvable org (team mode, no default org) is
 *    400'd at the edge, consistent with the other diagnostics handlers.
 *  - D-4 no-secret: the ack body carries no token/secret/header value.
 *  - Fail-soft: when the pollinating subsystem is unavailable (no real queue) the handler
 *    returns a clean `{triggered:false,...,reason:"unavailable"}` — never a 500.
 *  - Non-blocking: the handler resolves promptly (it awaits only the enqueue, not the pass).
 */

import { describe, expect, it } from "vitest";

import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import {
	type PollinateAck,
	type PollinateTriggerSeam,
	mountPollinateApi,
} from "../../../../src/daemon/runtime/pollinating/api.js";
import type { PollinatingScope, PollinatingTickResult } from "../../../../src/daemon/runtime/pollinating/trigger.js";
import type { QueryScope } from "../../../../src/daemon/storage/client.js";

/** A resolved config for the daemon under test (local mode → open diagnostics middleware). */
function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false, ...over };
}

/** A minimal fake storage client — the pollinate seam's trigger override never touches it. */
const fakeStorage = { async query() { return { kind: "ok", rows: [], durationMs: 0 }; } } as never;

/** The daemon's default tenancy scope (the single local tenant). */
const DEFAULT_SCOPE: QueryScope = { org: "local", workspace: "default" };

/**
 * A recording fake trigger seam: counts the calls + records the scope, and returns the
 * scripted {@link PollinatingTickResult}. Lets a test assert "fired exactly once with the
 * default agent scope" and drive each decision branch deterministically.
 */
function recordingTrigger(result: PollinatingTickResult): {
	trigger: PollinateTriggerSeam;
	calls: { count: number; scopes: PollinatingScope[] };
} {
	const calls = { count: 0, scopes: [] as PollinatingScope[] };
	const trigger: PollinateTriggerSeam = {
		async checkAndEnqueuePollinating(scope: PollinatingScope): Promise<PollinatingTickResult> {
			calls.count += 1;
			calls.scopes.push(scope);
			return result;
		},
	};
	return { trigger, calls };
}

/** Mount the pollinate seam on a fresh local-mode daemon with the supplied fake trigger. */
function daemonWithTrigger(trigger: PollinateTriggerSeam, over: Partial<RuntimeConfig> = {}): Daemon {
	const daemon = createDaemon({ config: cfg(over), storage: fakeStorage, logger: createRequestLogger({ silent: true }) });
	mountPollinateApi(daemon, { storage: fakeStorage, defaultScope: DEFAULT_SCOPE, trigger, available: true });
	return daemon;
}

/** POST to the pollinate endpoint and return the parsed ack + status. */
async function postPollinate(daemon: Daemon): Promise<{ status: number; ack: PollinateAck }> {
	const res = await daemon.app.request("/api/diagnostics/pollinate", { method: "POST" });
	const ack = (await res.json()) as PollinateAck;
	return { status: res.status, ack };
}

describe("AC-6 the Pollinate-now trigger kicks the real pollinating loop seam (non-blocking, 202 ack)", () => {
	it("AC-6 POST /api/diagnostics/pollinate returns 202 + {triggered:true,status:'enqueued'} and fires the trigger EXACTLY ONCE", async () => {
		const { trigger, calls } = recordingTrigger({ decision: "enqueued", reason: "threshold-met", tokens: 0, jobId: "job-1" });
		const daemon = daemonWithTrigger(trigger);

		const { status, ack } = await postPollinate(daemon);

		expect(status).toBe(202);
		expect(ack).toEqual({ triggered: true, status: "enqueued" });
		// The real pollinating loop seam was kicked exactly once, keyed by the default agent scope.
		expect(calls.count).toBe(1);
		expect(calls.scopes[0]).toEqual({ agentId: "default" });
	});

	it("AC-6 the pollinating-DISABLED guard returns {triggered:false,status:'skipped'} (no second enqueue path)", async () => {
		// The trigger reports `disabled` (the config master switch is off): it enqueues NOTHING.
		const { trigger, calls } = recordingTrigger({ decision: "disabled", reason: "disabled", tokens: 0 });
		const daemon = daemonWithTrigger(trigger);

		const { status, ack } = await postPollinate(daemon);

		expect(status).toBe(202);
		expect(ack).toEqual({ triggered: false, status: "skipped", reason: "disabled" });
		// The guard path still consults the trigger once (to learn it is disabled) but the
		// trigger never enqueues — the ack reflects "skipped", not "enqueued".
		expect(calls.count).toBe(1);
	});

	it("AC-6 an already-running pass (single-pending guard) returns {triggered:true,status:'running'}", async () => {
		const { trigger } = recordingTrigger({ decision: "skipped", reason: "pending", tokens: 42 });
		const daemon = daemonWithTrigger(trigger);

		const { status, ack } = await postPollinate(daemon);

		expect(status).toBe(202);
		expect(ack).toEqual({ triggered: true, status: "running", reason: "pending" });
	});

	it("ISS-013 below-threshold surfaces its OWN status (never 'running' — nothing is in flight) + the token count", async () => {
		const { trigger } = recordingTrigger({ decision: "below_threshold", reason: "below-threshold", tokens: 10 });
		const daemon = daemonWithTrigger(trigger);

		const { status, ack } = await postPollinate(daemon);
		expect(status).toBe(202);
		// An injected fake trigger has no known config, so the ack omits `threshold`.
		expect(ack).toEqual({ triggered: true, status: "below-threshold", reason: "below-threshold", tokens: 10 });
		// The pre-fix lie — the hive UI rendered "already running" when nothing was running.
		expect(ack.status).not.toBe("running");
	});

	it("ISS-013 the ack shape stays ADDITIVE: a genuinely-running pass still acks {status:'running'} without the new fields", async () => {
		const { trigger } = recordingTrigger({ decision: "skipped", reason: "pending", tokens: 42 });
		const daemon = daemonWithTrigger(trigger);

		const { ack } = await postPollinate(daemon);
		expect(ack).toEqual({ triggered: true, status: "running", reason: "pending" });
		expect(ack).not.toHaveProperty("tokens");
		expect(ack).not.toHaveProperty("threshold");
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
		mountPollinateApi(daemon, { storage: fakeStorage, defaultScope: { org: "" }, trigger, available: true });

		// In team mode the protected group's permission middleware also gates this; either way the
		// request never reaches the loop and is never 202-enqueued.
		const res = await daemon.app.request("/api/diagnostics/pollinate", { method: "POST" });
		expect([400, 401, 403]).toContain(res.status);
		expect(res.status).not.toBe(202);
		// The pollinating loop was NOT kicked on a fail-closed request.
		expect(calls.count).toBe(0);
	});

	it("D-4 the ack body carries NO token/secret/header value (grep-proven)", async () => {
		const { trigger } = recordingTrigger({ decision: "enqueued", reason: "threshold-met", tokens: 0, jobId: "job-secret-shaped" });
		const daemon = daemonWithTrigger(trigger);

		const res = await daemon.app.request("/api/diagnostics/pollinate", { method: "POST" });
		const raw = await res.text();

		// The ack is just the decision + a short machine reason — no token, key, bearer, or
		// header value, and not even the internal job id leaks into the body.
		expect(raw).not.toMatch(/token|secret|bearer|authorization|x-honeycomb|job-secret-shaped/i);
		const ack = JSON.parse(raw) as PollinateAck;
		expect(Object.keys(ack).sort()).toEqual(["status", "triggered"]);
	});

	it("fail-soft: when the pollinating subsystem is UNAVAILABLE the handler returns a clean {triggered:false,reason:'unavailable'} — never a 500", async () => {
		// No trigger, no enqueuer, available:false → the pollinating subsystem is not wired.
		const daemon = createDaemon({ config: cfg(), storage: fakeStorage, logger: createRequestLogger({ silent: true }) });
		mountPollinateApi(daemon, { storage: fakeStorage, defaultScope: DEFAULT_SCOPE, available: false });

		const { status, ack } = await postPollinate(daemon);
		// A clean ack, NOT a 500: the button can show "pollinating unavailable" honestly.
		expect(status).toBe(202);
		expect(ack).toEqual({ triggered: false, status: "skipped", reason: "unavailable" });
	});

	it("NON-BLOCKING: the handler resolves promptly (it awaits the enqueue seam, never the consolidation pass)", async () => {
		// The fake trigger resolves immediately (it models the enqueue, not the model call). A real
		// runner pass would take seconds; the seam never awaits it, so the response is prompt.
		const { trigger } = recordingTrigger({ decision: "enqueued", reason: "threshold-met", tokens: 0 });
		const daemon = daemonWithTrigger(trigger);

		const start = Date.now();
		const { status } = await postPollinate(daemon);
		expect(status).toBe(202);
		// Generous bound — proves the handler did not block on a long-running pass.
		expect(Date.now() - start).toBeLessThan(1_000);
	});
});

describe("PRD-026 AC-1 — the ENABLEMENT config gate drives the ack (real trigger, env-resolved config)", () => {
	/**
	 * These cases drive the REAL {@link PollinatingTrigger} the handler builds from
	 * `resolvePollinatingConfig()` (no injected fake decision) against the empty `fakeStorage`,
	 * proving the `HONEYCOMB_POLLINATING_ENABLED` master switch flows end-to-end into the ack:
	 *   - enabled:false → the trigger's enabled gate fires → `{triggered:false,status:"skipped",reason:"disabled"}`.
	 *   - enabled:true  → an empty counter is below threshold → `{triggered:true,status:"running"}` (the loop is
	 *                     healthy, nothing to consolidate yet); the master switch is ON so it is NOT skipped.
	 * The env is saved + restored so the toggle never leaks across tests.
	 */
	function withPollinatingEnv<T>(value: string | undefined, fn: () => T): T {
		const prev = process.env.HONEYCOMB_POLLINATING_ENABLED;
		if (value === undefined) delete process.env.HONEYCOMB_POLLINATING_ENABLED;
		else process.env.HONEYCOMB_POLLINATING_ENABLED = value;
		try {
			return fn();
		} finally {
			if (prev === undefined) delete process.env.HONEYCOMB_POLLINATING_ENABLED;
			else process.env.HONEYCOMB_POLLINATING_ENABLED = prev;
		}
	}

	/** Mount the pollinate seam with the REAL trigger (no `trigger` override) + a real enqueuer. */
	function daemonWithRealTrigger(): Daemon {
		const daemon = createDaemon({ config: cfg(), storage: fakeStorage, logger: createRequestLogger({ silent: true }) });
		// A real enqueuer so `available` is true and the handler builds the REAL trigger from
		// the env-resolved pollinating config (the path under test). The fake storage returns an
		// empty counter, so an enabled trigger reads "below threshold" and never enqueues.
		const enqueuer = { async enqueue() { return "job-real"; } };
		mountPollinateApi(daemon, { storage: fakeStorage, defaultScope: DEFAULT_SCOPE, enqueuer });
		return daemon;
	}

	it("AC-1 enabled:false → the config gate returns {triggered:false,status:'skipped',reason:'disabled'}", async () => {
		const daemon = withPollinatingEnv("false", () => daemonWithRealTrigger());
		const { status, ack } = await postPollinate(daemon);
		expect(status).toBe(202);
		expect(ack).toEqual({ triggered: false, status: "skipped", reason: "disabled" });
	});

	it("AC-1 / ISS-013 enabled:true (below threshold) → {status:'below-threshold'} with tokens + the REAL config threshold", async () => {
		const daemon = withPollinatingEnv("true", () => daemonWithRealTrigger());
		const { status, ack } = await postPollinate(daemon);
		expect(status).toBe(202);
		expect(ack.triggered).toBe(true);
		// ISS-013: an empty counter is below the bar — the ack says so, it does NOT claim "running".
		expect(ack.status).toBe("below-threshold");
		expect(ack.tokens).toBe(0);
		// The REAL trigger path resolves the config at mount, so the ack reports its threshold.
		expect(typeof ack.threshold).toBe("number");
		expect(ack.threshold).toBeGreaterThan(0);
		// The master switch is ON, so the ack is NOT the disabled `skipped` shape.
		expect(ack.status).not.toBe("skipped");
	});

	it("AC-1 / AC-6 the enablement ack carries NO token/secret in ANY config state", async () => {
		for (const value of ["true", "false"]) {
			const daemon = withPollinatingEnv(value, () => daemonWithRealTrigger());
			const res = await daemon.app.request("/api/diagnostics/pollinate", { method: "POST" });
			const raw = await res.text();
			// No secret material — ISS-013 added the NUMERIC `tokens`/`threshold` counters (documented
			// non-secret), so the guard excludes the bare field name `"tokens":<number>` while still
			// rejecting any token-VALUE-shaped field (e.g. "token":"...", access_token, x-honeycomb-*).
			expect(raw).not.toMatch(/secret|bearer|authorization|x-honeycomb/i);
			expect(raw).not.toMatch(/"(?:access_|refresh_|api_)?token"\s*:/i);
			expect(raw.replace(/"tokens":\d+/g, "").replace(/"threshold":\d+/g, "")).not.toMatch(/token/i);
			// Only the decision + a short machine reason — never the internal job id.
			expect(raw).not.toMatch(/job-real/);
		}
	});
});

describe("AC-6 mounting is fail-safe", () => {
	it("mountPollinateApi is a no-op when the /api/diagnostics group is not mounted (unknown daemon shape)", () => {
		// A daemon-shaped object whose group() always returns undefined: the mount must not throw.
		const stub = {
			group: () => undefined,
			config: cfg(),
		} as unknown as Daemon;
		const { trigger } = recordingTrigger({ decision: "enqueued", reason: "threshold-met", tokens: 0 });
		expect(() => mountPollinateApi(stub, { storage: fakeStorage, defaultScope: DEFAULT_SCOPE, trigger, available: true })).not.toThrow();
	});

	it("the endpoint is reachable on the protected diagnostics group in LOCAL mode (middleware open by design)", async () => {
		// A bare GET to the same path is NOT the trigger (POST only) — prove the POST route exists by
		// the 202 path above; here assert a GET falls through (not a 202), so we did not over-mount.
		const { trigger } = recordingTrigger({ decision: "enqueued", reason: "threshold-met", tokens: 0 });
		const daemon = daemonWithTrigger(trigger);
		const res = await daemon.app.request("/api/diagnostics/pollinate", { method: "GET" });
		expect(res.status).not.toBe(202);
	});
});
