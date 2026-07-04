/**
 * PRD-072b US-072b.4 — honeycomb reads nectar's config following nectar's move.
 *
 * `readNectarRrfMultiplier` resolves the new `~/.apiary/nectar/nectar.json` first, the legacy
 * `~/.honeycomb/nectar.json` second, and the fail-soft default when neither exists (AC-072b.4.1).
 * Honeycomb never MOVES this file (nectar owns it); it only follows the precedence.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	DEFAULT_NECTAR_RRF_MULTIPLIER,
	readNectarRrfMultiplier,
} from "../../../../src/daemon/runtime/memories/nectar-recall-config.js";

let home: string;
const ENV = {} as NodeJS.ProcessEnv;
const PLATFORM: NodeJS.Platform = "linux";

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "hc-nectar-cfg-"));
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function writeConfig(dir: string, multiplier: number): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "nectar.json"), JSON.stringify({ recall: { nectar_rrf_multiplier: multiplier } }));
}

const loc = () => ({ home, env: ENV, platform: PLATFORM });

describe("PRD-072b AC-072b.4.1 — new-first, legacy-second, else default", () => {
	it("AC-072b.4.1 the new `~/.apiary/nectar/nectar.json` wins when present", () => {
		writeConfig(join(home, ".apiary", "nectar"), 2.5);
		writeConfig(join(home, ".honeycomb"), 0.5);
		expect(readNectarRrfMultiplier(loc())).toBe(2.5);
	});

	it("AC-072b.4.1 falls back to the legacy `~/.honeycomb/nectar.json` when only it exists", () => {
		writeConfig(join(home, ".honeycomb"), 0.5);
		expect(readNectarRrfMultiplier(loc())).toBe(0.5);
	});

	it("AC-072b.4.1 resolves the fail-soft default when NEITHER path exists", () => {
		expect(readNectarRrfMultiplier(loc())).toBe(DEFAULT_NECTAR_RRF_MULTIPLIER);
	});
});
