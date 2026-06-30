/**
 * PRD-039a a-AC-3 — the install-presence detector (`detectInstalledHarnesses`).
 *
 * Proves the cheap, fail-soft, root-injectable disk probe that answers "which of the canonical seven
 * harnesses has Honeycomb wired on this box?" — the set the production daemon feeds into the 039a
 * telemetry endpoint so the live `installed` flag reflects REAL wiring (not the starved empty set the
 * QA flagged). Every fixture is built under a temp dir; the real home is NEVER touched.
 *
 * The markers are the install pipeline's own authoritative signals (grounded in `src/connectors/*` and
 * `hivemind-v1/src/cli/install-*.ts`): a harness reads INSTALLED iff at least one of its markers exists.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { detectInstalledHarnesses } from "../../../../src/daemon/runtime/dashboard/harness-detect.js";
import { CANONICAL_HARNESS_IDS } from "../../../../src/daemon/runtime/dashboard/harness-registry.js";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "honeycomb-detect-"));
});

afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

/** Create a marker file under the temp home (parents made as needed). */
function touchFile(...segments: string[]): void {
	const full = join(home, ...segments);
	mkdirSync(join(full, ".."), { recursive: true });
	writeFileSync(full, "");
}

/** Create a marker directory under the temp home. */
function touchDir(...segments: string[]): void {
	mkdirSync(join(home, ...segments), { recursive: true });
}

describe("PRD-039a a-AC-3: detectInstalledHarnesses — markers present → in the set", () => {
	it("an empty home → NO harness is installed (the honest 'wired nothing yet' picture)", () => {
		const set = detectInstalledHarnesses(home, home);
		expect(set.size).toBe(0);
	});

	it("claude-code marker present (~/.claude/settings.json) → claude-code in the set", () => {
		touchFile(".claude", "settings.json");
		const set = detectInstalledHarnesses(home, home);
		expect(set.has("claude-code")).toBe(true);
		// No other harness is wired — exactly one.
		expect([...set]).toEqual(["claude-code"]);
	});

	it("the claude-code plugin dir alone (~/.claude/plugins/honeycomb) also reads installed", () => {
		touchDir(".claude", "plugins", "honeycomb");
		expect(detectInstalledHarnesses(home, home).has("claude-code")).toBe(true);
	});

	it("cursor marker present (~/.cursor/hooks.json) → cursor in the set", () => {
		touchFile(".cursor", "hooks.json");
		expect(detectInstalledHarnesses(home, home).has("cursor")).toBe(true);
	});

	it("codex markers (~/.codex/hooks.json, ~/.codex/hivemind) → codex in the set", () => {
		touchFile(".codex", "hooks.json");
		touchDir(".codex", "hivemind");
		expect(detectInstalledHarnesses(home, home).has("codex")).toBe(true);
	});

	it("hermes markers (~/.hermes/config.yaml) → hermes in the set", () => {
		touchFile(".hermes", "config.yaml");
		expect(detectInstalledHarnesses(home, home).has("hermes")).toBe(true);
	});

	it("pi marker (~/.pi/agent/extensions/hivemind.ts) → pi in the set", () => {
		touchFile(".pi", "agent", "extensions", "hivemind.ts");
		expect(detectInstalledHarnesses(home, home).has("pi")).toBe(true);
	});

	it("grok markers (~/.grok/hooks/honeycomb.json) → grok in the set", () => {
		touchFile(".grok", "hooks", "honeycomb.json");
		expect(detectInstalledHarnesses(home, home).has("grok")).toBe(true);
	});

	it("openclaw marker (~/.openclaw/extensions/hivemind) → openclaw in the set", () => {
		touchDir(".openclaw", "extensions", "hivemind");
		expect(detectInstalledHarnesses(home, home).has("openclaw")).toBe(true);
	});
});

describe("PRD-039a a-AC-3: detectInstalledHarnesses — a present/absent MIX is faithful", () => {
	it("wires claude-code + codex + openclaw, leaves cursor/hermes/pi absent", () => {
		touchFile(".claude", "settings.json");
		touchDir(".codex", "hivemind");
		touchDir(".openclaw", "extensions", "hivemind");
		const set = detectInstalledHarnesses(home, home);
		expect(set.has("claude-code")).toBe(true);
		expect(set.has("codex")).toBe(true);
		expect(set.has("openclaw")).toBe(true);
		// The three unwired harnesses are absent — not in the set.
		expect(set.has("cursor")).toBe(false);
		expect(set.has("hermes")).toBe(false);
		expect(set.has("pi")).toBe(false);
	});

	it("ALL SEVEN wired → the set equals the canonical seven exactly (no extras, no drift)", () => {
		touchFile(".claude", "settings.json");
		touchFile(".cursor", "hooks.json");
		touchFile(".codex", "hooks.json");
		touchFile(".grok", "hooks", "honeycomb.json");
		touchFile(".hermes", "config.yaml");
		touchFile(".pi", "agent", "AGENTS.md");
		touchDir(".openclaw", "extensions", "hivemind");
		const set = detectInstalledHarnesses(home, home);
		expect([...set].sort()).toEqual([...CANONICAL_HARNESS_IDS].sort());
	});

	it("only ever records CANONICAL ids — a stray non-canonical marker dir never inflates the set", () => {
		// A sibling tool's dir under home is not one of the seven markers → ignored.
		touchDir(".some-other-agent", "settings.json");
		expect(detectInstalledHarnesses(home, home).size).toBe(0);
	});
});

describe("PRD-039a a-AC-3: detectInstalledHarnesses — fail-soft (never throws)", () => {
	it("a non-existent home root → empty set, NO throw", () => {
		const missing = join(home, "does", "not", "exist");
		expect(() => detectInstalledHarnesses(missing, missing)).not.toThrow();
		expect(detectInstalledHarnesses(missing, missing).size).toBe(0);
	});

	it("defaults are injectable — passing no args resolves os.homedir()/process.cwd() without throwing", () => {
		// We don't assert WHICH harnesses are wired on the dev/CI box (that is environment-dependent);
		// we assert the call is total: it returns a Set and never throws, and only canonical ids appear.
		const set = detectInstalledHarnesses();
		expect(set).toBeInstanceOf(Set);
		const canonical = new Set(CANONICAL_HARNESS_IDS);
		for (const id of set) expect(canonical.has(id)).toBe(true);
	});
});
