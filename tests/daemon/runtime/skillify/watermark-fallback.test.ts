/**
 * PRD-072b (QA Warning 1) — legacy-fallback reads for the skillify WATERMARK store, so an
 * unmigrated legacy watermark never forces a full re-mine while the window is open.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	createWatermarkStore,
	defaultWatermarkBaseDir,
	legacyWatermarkBaseDir,
} from "../../../../src/daemon/runtime/skillify/watermark.js";

function writeWatermark(baseDir: string, projectKey: string, watermark: string): void {
	const dir = join(baseDir, projectKey);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "watermark.json"), JSON.stringify({ watermark, updatedAt: "t" }));
}

describe("PRD-072b Warning 1 — watermark reads fall back to the legacy state root", () => {
	afterEach(() => {
		rmSync(join(homedir(), ".honeycomb"), { recursive: true, force: true });
		rmSync(join(homedir(), ".apiary"), { recursive: true, force: true });
	});

	it("AC-072b.1.2 the PRODUCTION default reads an unmigrated legacy watermark (no forced re-mine)", () => {
		writeWatermark(legacyWatermarkBaseDir(), "proj", "2026-06-01T00:00:00.000Z");
		expect(createWatermarkStore().read("proj")).toBe("2026-06-01T00:00:00.000Z");
	});

	it("AC-072b.1.2 the new path wins over the legacy one when both exist", () => {
		writeWatermark(legacyWatermarkBaseDir(), "proj", "2026-01-01T00:00:00.000Z");
		writeWatermark(defaultWatermarkBaseDir(), "proj", "2026-06-15T00:00:00.000Z");
		expect(createWatermarkStore().read("proj")).toBe("2026-06-15T00:00:00.000Z");
	});

	it("advance writes to the NEW path only (the legacy file is read-only during the window)", () => {
		writeWatermark(legacyWatermarkBaseDir(), "proj", "2026-06-01T00:00:00.000Z");
		const store = createWatermarkStore();
		// Advance-to-oldest against the legacy-read current value.
		const next = store.advance("proj", ["2026-05-01T00:00:00.000Z"]);
		expect(next).toBe("2026-05-01T00:00:00.000Z");
		expect(existsSync(join(defaultWatermarkBaseDir(), "proj", "watermark.json"))).toBe(true);
		// The new path now wins the read.
		expect(store.read("proj")).toBe("2026-05-01T00:00:00.000Z");
	});

	it("the injected seam drives the same fallback deterministically (temp dirs)", () => {
		const base = mkdtempSync(join(tmpdir(), "hc-wm-new-"));
		const legacyBase = mkdtempSync(join(tmpdir(), "hc-wm-legacy-"));
		try {
			writeWatermark(legacyBase, "proj", "2026-03-01T00:00:00.000Z");
			expect(createWatermarkStore(base, legacyBase).read("proj")).toBe("2026-03-01T00:00:00.000Z");
		} finally {
			rmSync(base, { recursive: true, force: true });
			rmSync(legacyBase, { recursive: true, force: true });
		}
	});
});
