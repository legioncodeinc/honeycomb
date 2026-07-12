/**
 * SP-1 / ISS-001/ISS-005 — the pipeline live-reload seams (`pipeline/reload.ts`).
 *
 * Verification posture: pure unit drive with injected schedulers/clocks — no daemon, no
 * filesystem, no timers slept. Proves:
 *   - the seam is a clean NO-OP before `bind` (no target → nothing runs, nothing throws);
 *   - a burst of `requestReload` calls inside the debounce window COALESCES into ONE run;
 *   - a request arriving AFTER a run fires schedules a fresh run (nothing is lost);
 *   - a rejecting reload is routed to `onError` (fail-soft) — never thrown into the caller;
 *   - `LiveModelClient` delegates both `complete` shapes and `swap` redirects the NEXT call;
 *   - the live extraction gate: `enabled` flips via the setter; `providerConfigured` is a
 *     TTL-debounced names-only probe (a newly added key is seen on the first probe AFTER the
 *     window — the fake-clock proof), `invalidate()` forces an immediate re-probe, and a
 *     listing throw fails CLOSED to `false`.
 */

import { describe, expect, it } from "vitest";

import {
	createLiveExtractionGate,
	createPipelineReloadSeam,
	LiveModelClient,
	PIPELINE_RELOAD_DEBOUNCE_MS,
} from "../../../../src/daemon/runtime/pipeline/reload.js";
import { createFakeModelClient } from "../../../../src/daemon/runtime/pipeline/model-client.js";

/** A hand-cranked scheduler: callbacks queue up and run only when the test says so. */
function manualScheduler(): { schedule: (fn: () => void, ms: number) => void; fire: () => void; pending: () => number; delays: number[] } {
	const queue: Array<() => void> = [];
	const delays: number[] = [];
	return {
		schedule(fn: () => void, ms: number): void {
			queue.push(fn);
			delays.push(ms);
		},
		fire(): void {
			const fn = queue.shift();
			if (fn !== undefined) fn();
		},
		pending: () => queue.length,
		delays,
	};
}

/** Flush the microtask queue so a fire-and-forget `void promise` settles deterministically. */
async function settled(): Promise<void> {
	await new Promise<void>((resolve) => setImmediate(resolve));
}

describe("createPipelineReloadSeam — debounce + late bind (SP-1)", () => {
	it("is a clean no-op before bind: the scheduled run fires and nothing happens", () => {
		const timer = manualScheduler();
		const seam = createPipelineReloadSeam({ schedule: timer.schedule });
		seam.requestReload("setting:activeModel");
		expect(timer.pending()).toBe(1);
		expect(() => timer.fire()).not.toThrow();
	});

	it("coalesces a burst into ONE reload run, at the default ~1s debounce", async () => {
		const timer = manualScheduler();
		let runs = 0;
		const seam = createPipelineReloadSeam({ schedule: timer.schedule });
		seam.bind(async () => {
			runs += 1;
		});
		// A dashboard "save settings" burst: provider, model, portkey.* written back-to-back.
		seam.requestReload("setting:activeProvider");
		seam.requestReload("setting:activeModel");
		seam.requestReload("setting:portkey.enabled");
		seam.requestReload("secret:set");
		expect(timer.pending()).toBe(1); // ONE scheduled run absorbs the whole burst.
		expect(timer.delays[0]).toBe(PIPELINE_RELOAD_DEBOUNCE_MS);
		timer.fire();
		await settled();
		expect(runs).toBe(1);
	});

	it("a request AFTER the run fired schedules a fresh run (nothing lost)", async () => {
		const timer = manualScheduler();
		let runs = 0;
		const seam = createPipelineReloadSeam({ schedule: timer.schedule });
		seam.bind(async () => {
			runs += 1;
		});
		seam.requestReload("secret:set");
		timer.fire();
		await settled();
		seam.requestReload("secret:set");
		expect(timer.pending()).toBe(1);
		timer.fire();
		await settled();
		expect(runs).toBe(2);
	});

	it("routes a rejecting reload to onError instead of throwing (fail-soft)", async () => {
		const timer = manualScheduler();
		const errors: string[] = [];
		const seam = createPipelineReloadSeam({ schedule: timer.schedule, onError: (r) => errors.push(r) });
		seam.bind(async () => {
			throw new Error("vault unreadable");
		});
		seam.requestReload("setting:memory.enabled");
		expect(() => timer.fire()).not.toThrow();
		await settled();
		expect(errors).toEqual(["vault unreadable"]);
	});

	it("the LAST bind wins (a rebuilt worker re-binds over the old closure)", async () => {
		const timer = manualScheduler();
		const ran: string[] = [];
		const seam = createPipelineReloadSeam({ schedule: timer.schedule });
		seam.bind(async () => {
			ran.push("old");
		});
		seam.bind(async () => {
			ran.push("new");
		});
		seam.requestReload("secret:set");
		timer.fire();
		await settled();
		expect(ran).toEqual(["new"]);
	});
});

describe("LiveModelClient — the in-place-swappable ModelClient proxy", () => {
	it("delegates BOTH complete call shapes to the current inner client", async () => {
		const inner = createFakeModelClient({ memory_extraction: "from-inner" });
		const live = new LiveModelClient(inner);
		await expect(live.complete("memory_extraction", "p1")).resolves.toBe("from-inner");
		await expect(live.complete({ workload: "memory_extraction", prompt: "p2" })).resolves.toBe("from-inner");
		expect(inner.calls.map((c) => c.prompt)).toEqual(["p1", "p2"]);
	});

	it("swap() redirects the very NEXT call to the rebuilt client", async () => {
		const boot = createFakeModelClient({ memory_extraction: "boot" });
		const rebuilt = createFakeModelClient({ memory_extraction: "rebuilt" });
		const live = new LiveModelClient(boot);
		await expect(live.complete("memory_extraction", "a")).resolves.toBe("boot");
		live.swap(rebuilt);
		await expect(live.complete("memory_extraction", "b")).resolves.toBe("rebuilt");
		expect(boot.calls).toHaveLength(1);
		expect(rebuilt.calls).toHaveLength(1);
		expect(live.current()).toBe(rebuilt);
	});
});

describe("createLiveExtractionGate — the per-job TTL-debounced provider probe (ISS-001)", () => {
	it("picks up a NEWLY ADDED provider key on the first probe after the TTL window (fake clock)", () => {
		let nowMs = 0;
		let names: readonly string[] = [];
		let listings = 0;
		const gate = createLiveExtractionGate({
			enabled: true,
			credentialNames: ["ANTHROPIC_API_KEY"],
			listSecretNames: () => {
				listings += 1;
				return names;
			},
			now: () => nowMs,
		});
		// Boot: no key present → not configured.
		expect(gate.providerConfigured()).toBe(false);
		// The key is saved OUT-OF-BAND (no reload seam fired) …
		names = ["ANTHROPIC_API_KEY"];
		// … inside the TTL window the cached answer stands (ONE listing so far — no stampede) …
		nowMs += PIPELINE_RELOAD_DEBOUNCE_MS - 1;
		expect(gate.providerConfigured()).toBe(false);
		expect(listings).toBe(1);
		// … and the first probe AFTER the window sees it: the gate flips within ~1s, no restart.
		nowMs += 2;
		expect(gate.providerConfigured()).toBe(true);
		expect(listings).toBe(2);
	});

	it("costs at most one listing per window on a hot job loop", () => {
		let listings = 0;
		let nowMs = 0;
		const gate = createLiveExtractionGate({
			enabled: true,
			credentialNames: ["PORTKEY_API_KEY"],
			listSecretNames: () => {
				listings += 1;
				return ["PORTKEY_API_KEY"];
			},
			now: () => nowMs,
		});
		for (let i = 0; i < 50; i += 1) expect(gate.providerConfigured()).toBe(true);
		expect(listings).toBe(1);
		nowMs += PIPELINE_RELOAD_DEBOUNCE_MS + 1;
		expect(gate.providerConfigured()).toBe(true);
		expect(listings).toBe(2);
	});

	it("invalidate() forces the NEXT probe immediately (the post-reload fast path)", () => {
		let nowMs = 0;
		let names: readonly string[] = [];
		const gate = createLiveExtractionGate({
			enabled: true,
			credentialNames: ["ANTHROPIC_API_KEY"],
			listSecretNames: () => names,
			now: () => nowMs,
		});
		expect(gate.providerConfigured()).toBe(false);
		names = ["ANTHROPIC_API_KEY"];
		gate.invalidate();
		// Same instant — no TTL wait needed after an explicit invalidation.
		expect(gate.providerConfigured()).toBe(true);
	});

	it("setCredentialNames swaps the watched set (portkey toggle changes WHICH key matters)", () => {
		let nowMs = 0;
		const gate = createLiveExtractionGate({
			enabled: true,
			credentialNames: ["ANTHROPIC_API_KEY"],
			listSecretNames: () => ["PORTKEY_API_KEY"],
			now: () => nowMs,
		});
		expect(gate.providerConfigured()).toBe(false); // provider path: ANTHROPIC key absent.
		gate.setCredentialNames(["PORTKEY_API_KEY"]); // reload flipped the gateway on.
		gate.invalidate();
		expect(gate.providerConfigured()).toBe(true);
	});

	it("fails CLOSED: an empty credential set never lists; a throwing listing reads false", () => {
		let listings = 0;
		const empty = createLiveExtractionGate({
			enabled: true,
			credentialNames: [],
			listSecretNames: () => {
				listings += 1;
				return ["ANTHROPIC_API_KEY"];
			},
			now: () => 0,
		});
		expect(empty.providerConfigured()).toBe(false);
		expect(listings).toBe(0); // no routable selection → no listing at all.

		const throwing = createLiveExtractionGate({
			enabled: true,
			credentialNames: ["ANTHROPIC_API_KEY"],
			listSecretNames: () => {
				throw new Error("store down");
			},
			now: () => 0,
		});
		expect(throwing.providerConfigured()).toBe(false);
	});

	it("enabled() reflects the live master-gate cell (the memory-toggle path)", () => {
		const gate = createLiveExtractionGate({
			enabled: false,
			credentialNames: [],
			listSecretNames: () => [],
			now: () => 0,
		});
		expect(gate.enabled()).toBe(false);
		gate.setEnabled(true);
		expect(gate.enabled()).toBe(true);
	});
});
