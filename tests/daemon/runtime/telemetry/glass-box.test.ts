/**
 * PRD-050e e-AC-8 — the glass-box telemetry view (`buildGlassBoxView` / `renderGlassBoxText`).
 *
 * Proves the DECISIVE property: the displayed set IS the egress set. The "would be sent next" rows are
 * built through the SAME {@link buildAllowedProperties} the chokepoint uses, and the "already sent" rows
 * are the verbatim `telemetry.sent` log the chokepoint writes — so a field that would not egress cannot
 * be displayed, and a field that has egressed cannot be hidden. Temp dir + `dir?` injection: no real
 * `~/.deeplake` touched.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	BANNED_PROPERTY_KEYS,
	buildGlassBoxView,
	emitTelemetry,
	renderGlassBoxText,
} from "../../../../src/daemon/runtime/telemetry/index.js";

const KEY = "phc_test_write_only_key";

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-glassbox-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("e-AC-8 buildGlassBoxView shows what HAS been sent + what WOULD be sent next", () => {
	it("a fresh machine: nothing sent, the three Tier-1 lifecycle events pending", () => {
		const view = buildGlassBoxView({ ref: "mario", version: "1.2.3" }, { dir });
		expect(view.sent).toHaveLength(0);
		expect(view.pending.map((p) => p.event).sort()).toEqual([
			"honeycomb_first_link",
			"honeycomb_hivemind_upgrade",
			"honeycomb_installed",
		]);
		// Every pending payload carries the SAME ref + is allow-listed only.
		for (const row of view.pending) {
			expect(row.properties.ref).toBe("mario");
			const serialized = JSON.stringify(row.properties).toLowerCase();
			for (const banned of BANNED_PROPERTY_KEYS) expect(serialized).not.toContain(banned.toLowerCase());
		}
	});

	it("after an event is sent it MOVES from pending to sent (displayed ≡ egress)", async () => {
		const rec = (url: string, init: { body: string }) => {
			void url;
			void init;
			return Promise.resolve({ ok: true, status: 200 });
		};
		await emitTelemetry("honeycomb_installed", { ref: "mario", tier: "tier1" }, { dir, fetch: rec, posthogKey: KEY });
		const view = buildGlassBoxView({ ref: "mario", version: "1.2.3" }, { dir });
		// honeycomb_installed is now SENT, not pending.
		expect(view.sent.map((s) => s.event)).toContain("honeycomb_installed");
		expect(view.pending.map((p) => p.event)).not.toContain("honeycomb_installed");
		// The sent record's payload is the EXACT egress payload.
		expect(view.sent[0]!.properties.ref).toBe("mario");
	});

	it("under opt-out, NOTHING is pending (nothing would be sent)", () => {
		const view = buildGlassBoxView({ ref: "mario", version: "1.2.3" }, { dir, env: { DO_NOT_TRACK: "1" } });
		expect(view.optedOut).toBe(true);
		expect(view.pending).toHaveLength(0);
	});
});

describe("e-AC-8 renderGlassBoxText prints the plaintext glass box", () => {
	it("renders the distinct_id, the sent section, and the would-send-next section", () => {
		const view = buildGlassBoxView({ ref: "mario", version: "1.2.3" }, { dir });
		const text = renderGlassBoxText(view);
		expect(text).toContain("ALREADY SENT");
		expect(text).toContain("WOULD SEND NEXT");
		expect(text).toContain(view.distinctId);
		expect(text).toContain("honeycomb_installed");
		// The opt-out instructions are surfaced.
		expect(text).toContain("HONEYCOMB_TELEMETRY=0");
		// No banned field leaks into the rendered text either.
		for (const banned of BANNED_PROPERTY_KEYS) expect(text.toLowerCase()).not.toContain(banned.toLowerCase());
	});
});
