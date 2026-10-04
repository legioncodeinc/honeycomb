/**
 * PRD-039a a-AC-3 — the install-presence detector (`detectInstalledHarnesses`).
 *
 * Proves the cheap, fail-soft, root-injectable disk probe that answers "which of the canonical six
 * harnesses has Honeycomb wired on this box?" — the set the production daemon feeds into the 039a
 * telemetry endpoint so the live `installed` flag reflects REAL wiring (not the starved empty set the
 * QA flagged). Every fixture is built under a temp dir; the real home is NEVER touched.
 *
 * The markers are HONEYCOMB's own install artifacts (grounded in `src/connectors/*`, or — for a harness
 * with no connector yet — the honeycomb-namespaced dir honeycomb would write). A harness reads INSTALLED
 * iff at least one of its markers exists. Dead hivemind-v1 leftovers (`~/.hermes/config.yaml`,
 * `~/.codex/hivemind`, `~/.pi/agent/…`, `~/.openclaw/extensions/hivemind`) must NEVER read installed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

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

	it("codex marker (~/.codex/hooks.json) → codex in the set", () => {
		touchFile(".codex", "hooks.json");
		expect(detectInstalledHarnesses(home, home).has("codex")).toBe(true);
	});

	it("the codex honeycomb plugin dir alone (~/.codex/plugins/honeycomb) also reads installed", () => {
		touchDir(".codex", "plugins", "honeycomb");
		expect(detectInstalledHarnesses(home, home).has("codex")).toBe(true);
	});

	it("Hermes installed hook bundle marker → hermes in the set", () => {
		touchFile(".hermes", "honeycomb", "bundle", "capture.mjs");
		expect(detectInstalledHarnesses(home, home)).toContain("hermes");
	});

	it("a directory named capture.mjs does not count as an installed Hermes hook", () => {
		touchDir(".hermes", "honeycomb", "bundle", "capture.mjs");
		expect(detectInstalledHarnesses(home, home)).not.toContain("hermes");
	});

	it("Hermes detection honors an explicit HERMES_HOME profile root", () => {
		const previous = process.env.HERMES_HOME;
		process.env.HERMES_HOME = join(home, ".hermes", "profiles", "work");
		try {
			touchFile(".hermes", "profiles", "work", "honeycomb", "bundle", "capture.mjs");
			expect(detectInstalledHarnesses(home, home)).toContain("hermes");
		} finally {
			if (previous === undefined) delete process.env.HERMES_HOME;
			else process.env.HERMES_HOME = previous;
		}
	});

	it("pi honeycomb marker (~/.pi/honeycomb) → pi in the set", () => {
		touchDir(".pi", "honeycomb");
		expect(detectInstalledHarnesses(home, home).has("pi")).toBe(true);
	});

	it("openclaw honeycomb marker (~/.openclaw/honeycomb) → openclaw in the set", () => {
		touchDir(".openclaw", "honeycomb");
		expect(detectInstalledHarnesses(home, home).has("openclaw")).toBe(true);
	});
});

describe("W2-FIX-2: dead hivemind-v1 leftovers alone do NOT read installed", () => {
	it("a stale ~/.hermes/config.yaml (hivemind-v1) does NOT make hermes read installed", () => {
		touchFile(".hermes", "config.yaml");
		touchDir(".hermes", "hivemind");
		expect(detectInstalledHarnesses(home, home).has("hermes")).toBe(false);
	});

	it("a stale ~/.codex/hivemind (hivemind-v1) alone does NOT make codex read installed", () => {
		touchDir(".codex", "hivemind");
		expect(detectInstalledHarnesses(home, home).has("codex")).toBe(false);
	});

	it("stale ~/.pi/agent/* + ~/.openclaw/extensions/hivemind (hivemind-v1) do NOT read installed", () => {
		touchFile(".pi", "agent", "AGENTS.md");
		touchFile(".pi", "agent", "extensions", "hivemind.ts");
		touchDir(".openclaw", "extensions", "hivemind");
		const set = detectInstalledHarnesses(home, home);
		expect(set.has("pi")).toBe(false);
		expect(set.has("openclaw")).toBe(false);
	});
});

describe("PRD-039a a-AC-3: detectInstalledHarnesses — a present/absent MIX is faithful", () => {
	it("wires claude-code + codex + openclaw, leaves cursor/hermes/pi absent", () => {
		touchFile(".claude", "settings.json");
		touchFile(".codex", "hooks.json");
		touchDir(".openclaw", "honeycomb");
		const set = detectInstalledHarnesses(home, home);
		expect(set.has("claude-code")).toBe(true);
		expect(set.has("codex")).toBe(true);
		expect(set.has("openclaw")).toBe(true);
		// The three unwired harnesses are absent — not in the set.
		expect(set.has("cursor")).toBe(false);
		expect(set.has("hermes")).toBe(false);
		expect(set.has("pi")).toBe(false);
	});

	it("ALL SIX wired → the set equals the canonical six exactly (no extras, no drift)", () => {
		touchFile(".claude", "settings.json");
		touchFile(".cursor", "hooks.json");
		touchFile(".codex", "hooks.json");
		touchFile(".hermes", "honeycomb", "bundle", "capture.mjs");
		touchDir(".pi", "honeycomb");
		touchDir(".openclaw", "honeycomb");
		const set = detectInstalledHarnesses(home, home);
		expect([...set].sort()).toEqual([...CANONICAL_HARNESS_IDS].sort());
	});

	it("only ever records CANONICAL ids — a stray non-canonical marker dir never inflates the set", () => {
		// A sibling tool's dir under home is not one of the six markers → ignored.
		touchDir(".some-other-agent", "settings.json");
		expect(detectInstalledHarnesses(home, home).size).toBe(0);
	});
});

describe("PRD-039a a-AC-3: detectInstalledHarnesses — fail-soft (never throws)", () => {
	it("rejects a relative home root instead of probing outside a trusted absolute root", () => {
		const absoluteHome = mkdtempSync(join(process.cwd(), ".honeycomb-relative-home-"));
		const relativeHome = relative(process.cwd(), absoluteHome);
		try {
			const markerDir = join(absoluteHome, ".hermes", "honeycomb", "bundle");
			mkdirSync(markerDir, { recursive: true });
			writeFileSync(join(markerDir, "capture.mjs"), "fixture\n", "utf8");
			expect(detectInstalledHarnesses(relativeHome, relativeHome).size).toBe(0);
		} finally {
			rmSync(absoluteHome, { recursive: true, force: true });
		}
	});

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
