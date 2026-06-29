/**
 * The update/rollback telemetry seam (PRD-064e AC-064e.5). The default seam adapts onto
 * the 064d chokepoint; this test injects a fake fetch (no network) and asserts the
 * from/to/outcome triple reaches the OTLP body through the existing allow-list.
 */

import { describe, expect, it } from "vitest";

import type { TelemetryFetchInit, TelemetryFetchResponse } from "../../src/telemetry/emit.js";
import { createDefaultUpdateEmit } from "../../src/update/update-telemetry.js";

/** A fake telemetry fetch recording the POST body so we can assert what left the box. */
function recordingFetch(): {
	fetch: (url: string, init: TelemetryFetchInit) => Promise<TelemetryFetchResponse>;
	bodies: string[];
} {
	const bodies: string[] = [];
	return {
		bodies,
		fetch: async (_url, init) => {
			bodies.push(init.body);
			return { ok: true, status: 200 };
		},
	};
}

describe("createDefaultUpdateEmit (AC-064e.5)", () => {
	it("routes an update event through the 064d chokepoint with from/to/outcome encoded", async () => {
		const rec = recordingFetch();
		// Inject a fake key + host + fetch so the chokepoint's gates pass and no network is hit.
		const emit = createDefaultUpdateEmit({
			fetch: rec.fetch,
			posthogKey: "test-key",
			posthogHost: "https://telemetry.test",
			env: {}, // no opt-out env
		});

		await emit({
			kind: "update",
			fromVersion: "0.1.7",
			toVersion: "0.1.9",
			outcome: "updated",
			deviceId: "device-abc",
			timestampMs: 1_700_000_000_000,
		});

		expect(rec.bodies).toHaveLength(1);
		const body = rec.bodies[0] ?? "";
		// The from/to/outcome fact string survived into the OTLP payload.
		expect(body).toContain("from=0.1.7;to=0.1.9;outcome=updated");
		expect(body).toContain("auto_update_updated");
	});

	it("is fail-soft: an opted-out env drops the event without throwing", async () => {
		const rec = recordingFetch();
		const emit = createDefaultUpdateEmit({
			fetch: rec.fetch,
			posthogKey: "test-key",
			env: { HONEYCOMB_TELEMETRY: "0" }, // opted out
		});
		await expect(
			emit({
				kind: "rollback",
				fromVersion: "0.1.9",
				toVersion: "0.1.7",
				outcome: "rolled_back",
				deviceId: "device-abc",
				timestampMs: 1,
			}),
		).resolves.toBeUndefined();
		// Nothing left the box.
		expect(rec.bodies).toHaveLength(0);
	});
});
