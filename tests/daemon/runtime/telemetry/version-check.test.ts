/**
 * The `honeycomb_updated` version-change checkpoint (`recordVersionAndEmitUpdated`).
 *
 * Verification posture mirrors emit.test.ts: a TEMP onboarding dir per-test + `dir?` injection so
 * NO test touches the real `~/.deeplake`; an injected `fetch` RECORDER so NO real PostHog is hit;
 * `posthogKey`/`version` overrides so the keyed branch and the version compare are exercised
 * without a rebuild. Proves: baseline-record-without-emit on first sighting, the no-change no-op,
 * the emit + baseline advance on a real change, the per-event+version dedupe, and fail-soft.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type TelemetryFetchRequestInit,
	recordVersionAndEmitUpdated,
} from "../../../../src/daemon/runtime/telemetry/index.js";
import { loadOnboarding, saveOnboarding } from "../../../../src/daemon/runtime/onboarding/index.js";

const KEY = "phc_test_write_only_key";

/** A recording fetch: captures every (url, init) and returns a scriptable response. */
function recordingFetch(result: { ok?: boolean; throws?: boolean } = {}) {
	const calls: { url: string; init: TelemetryFetchRequestInit }[] = [];
	return {
		calls,
		fetch: (url: string, init: TelemetryFetchRequestInit) => {
			calls.push({ url, init });
			if (result.throws === true) return Promise.reject(new Error("network down"));
			return Promise.resolve({ ok: result.ok ?? true, status: result.ok === false ? 500 : 200 });
		},
	};
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-version-check-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("first sighting records the baseline WITHOUT emitting (a fresh install is not an update)", () => {
	it("persists lastVersion, makes zero network calls", async () => {
		const rec = recordingFetch();
		const out = await recordVersionAndEmitUpdated("mario", { dir, fetch: rec.fetch, posthogKey: KEY, version: "1.0.0" });
		expect(out.changed).toBe(false);
		expect(rec.calls).toHaveLength(0);
		expect(loadOnboarding(dir).lastVersion).toBe("1.0.0");
	});
});

describe("the unchanged-version path is a no-op (one string compare, no emit, no write)", () => {
	it("same version → changed=false, zero network calls", async () => {
		const rec = recordingFetch();
		await recordVersionAndEmitUpdated("mario", { dir, fetch: rec.fetch, posthogKey: KEY, version: "1.0.0" });
		const out = await recordVersionAndEmitUpdated("mario", { dir, fetch: rec.fetch, posthogKey: KEY, version: "1.0.0" });
		expect(out.changed).toBe(false);
		expect(rec.calls).toHaveLength(0);
	});
});

describe("a version CHANGE emits honeycomb_updated and advances the baseline", () => {
	it("emits the plain event name with the version in the allow-listed honeycomb_version property", async () => {
		const rec = recordingFetch();
		await recordVersionAndEmitUpdated("mario", { dir, fetch: rec.fetch, posthogKey: KEY, version: "1.0.0" });
		const out = await recordVersionAndEmitUpdated("mario", { dir, fetch: rec.fetch, posthogKey: KEY, version: "1.0.1" });
		expect(out.changed).toBe(true);
		expect(out.emit?.sent).toBe(true);
		expect(rec.calls).toHaveLength(1);
		const body = JSON.parse(rec.calls[0]!.init.body) as Record<string, unknown>;
		expect(body.event).toBe("honeycomb_updated");
		expect((body.properties as Record<string, unknown>).honeycomb_version).toBe("1.0.1");
		expect((body.properties as Record<string, unknown>).ref).toBe("mario");
		// The baseline advanced AND the emit's ledger bookkeeping survived (no clobber).
		const state = loadOnboarding(dir);
		expect(state.lastVersion).toBe("1.0.1");
		expect(state.telemetry.reported["honeycomb_updated@1.0.1"]).toBeDefined();
		expect(state.telemetry.sent.map((s) => s.event)).toContain("honeycomb_updated");
	});

	it("dedupe is per event+version: the SAME change re-detected never double-sends; the NEXT version fires again", async () => {
		const rec = recordingFetch();
		await recordVersionAndEmitUpdated("mario", { dir, fetch: rec.fetch, posthogKey: KEY, version: "1.0.0" });
		await recordVersionAndEmitUpdated("mario", { dir, fetch: rec.fetch, posthogKey: KEY, version: "1.0.1" });
		// Simulate a failed baseline persist by rewinding lastVersion: the next pass re-detects the
		// same 1.0.0 → 1.0.1 change, and the version-qualified dedupe key must block a duplicate send.
		saveOnboarding({ ...loadOnboarding(dir), lastVersion: "1.0.0" }, dir);
		const rerun = await recordVersionAndEmitUpdated("mario", { dir, fetch: rec.fetch, posthogKey: KEY, version: "1.0.1" });
		expect(rerun.changed).toBe(true);
		expect(rerun.emit?.skipped).toBe("already_reported");
		expect(rec.calls).toHaveLength(1);
		// A genuinely NEW version fires again under the same event name.
		const next = await recordVersionAndEmitUpdated("mario", { dir, fetch: rec.fetch, posthogKey: KEY, version: "1.0.2" });
		expect(next.changed).toBe(true);
		expect(next.emit?.sent).toBe(true);
		expect(rec.calls).toHaveLength(2);
	});
});

describe("fail-soft: gates and failures never throw and never lose the baseline advance", () => {
	it("an empty build key skips the send but still advances the baseline (no re-prompt loop)", async () => {
		const rec = recordingFetch();
		await recordVersionAndEmitUpdated("mario", { dir, fetch: rec.fetch, posthogKey: KEY, version: "1.0.0" });
		const out = await recordVersionAndEmitUpdated("mario", { dir, fetch: rec.fetch, posthogKey: "", version: "1.0.1" });
		expect(out.changed).toBe(true);
		expect(out.emit?.skipped).toBe("disabled");
		expect(rec.calls).toHaveLength(0);
		expect(loadOnboarding(dir).lastVersion).toBe("1.0.1");
	});

	it("a throwing fetch resolves quietly (send_failed) and still advances the baseline", async () => {
		const ok = recordingFetch();
		await recordVersionAndEmitUpdated("mario", { dir, fetch: ok.fetch, posthogKey: KEY, version: "1.0.0" });
		const bad = recordingFetch({ throws: true });
		const out = await recordVersionAndEmitUpdated("mario", { dir, fetch: bad.fetch, posthogKey: KEY, version: "1.0.1" });
		expect(out.changed).toBe(true);
		expect(out.emit?.sent).toBe(false);
		expect(out.emit?.skipped).toBe("send_failed");
		expect(loadOnboarding(dir).lastVersion).toBe("1.0.1");
	});

	it("the opt-out env silences the send but never throws", async () => {
		const rec = recordingFetch();
		await recordVersionAndEmitUpdated("mario", { dir, fetch: rec.fetch, posthogKey: KEY, version: "1.0.0" });
		const out = await recordVersionAndEmitUpdated("mario", {
			dir,
			fetch: rec.fetch,
			posthogKey: KEY,
			version: "1.0.1",
			env: { DO_NOT_TRACK: "1" },
		});
		expect(out.changed).toBe(true);
		expect(out.emit?.skipped).toBe("opted_out");
		expect(rec.calls).toHaveLength(0);
	});
});
