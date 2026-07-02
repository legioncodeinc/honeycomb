/**
 * PRD-018a scope config persistence — proves a-AC-3 (legacy `org`→`team` coercion) +
 * the config plumbing a-AC-2 builds on. Drives `createSkillifyConfigStore` against a temp
 * dir (no real `~`), plus the pure `coerceScope` / `normalizeConfig` / `parseUsersList`.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	coerceScope,
	createSkillifyConfigStore,
	DEFAULT_CONFIG,
	normalizeConfig,
	parseUsersList,
} from "../../../src/daemon-client/skillify/index.js";

// Every mkdtemp'd dir minted by a test is tracked here and reclaimed in `afterEach` — see
// `tests/setup/isolate-home.ts` for the incident (100k+ stray dirs under `%TEMP%`) that made
// this discipline mandatory across every skillify test helper.
const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "skillify-config-"));
	tempDirs.push(dir);
	return dir;
}

/** Seed a raw config.json at the store's base dir. */
function seedConfig(baseDir: string, raw: unknown): void {
	mkdirSync(baseDir, { recursive: true });
	writeFileSync(join(baseDir, "config.json"), JSON.stringify(raw), "utf-8");
}

describe("PRD-018a skillify config", () => {
	it("a-AC-3 a config with the legacy `org` scope is coerced to `team` on read", () => {
		const dir = tempDir();
		seedConfig(dir, { scope: "org", team: ["alice"], install: "global" });
		const store = createSkillifyConfigStore(dir);

		const cfg = store.read();

		expect(cfg.scope).toBe("team");
		expect(cfg.team).toEqual(["alice"]);
		expect(cfg.install).toBe("global");
	});

	it("a-AC-3 the legacy `org` file is NOT rewritten on read (D-5: coerce in memory only)", () => {
		const dir = tempDir();
		seedConfig(dir, { scope: "org", team: [], install: "project" });
		const store = createSkillifyConfigStore(dir);

		store.read();

		// The on-disk file still carries the legacy value — only an explicit write migrates it.
		const onDisk = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8")) as { scope: string };
		expect(onDisk.scope).toBe("org");
	});

	it("a-AC-3 an explicit write migrates the legacy `org` to `team` on disk", () => {
		const dir = tempDir();
		seedConfig(dir, { scope: "org", team: ["bob"], install: "project" });
		const store = createSkillifyConfigStore(dir);

		const written = store.write(store.read());

		expect(written.scope).toBe("team");
		const onDisk = JSON.parse(readFileSync(join(dir, "config.json"), "utf-8")) as { scope: string };
		expect(onDisk.scope).toBe("team");
	});

	it("a missing config file resolves to the canonical default (me / [] / project)", () => {
		const store = createSkillifyConfigStore(tempDir());
		expect(store.read()).toEqual(DEFAULT_CONFIG);
	});

	it("a garbled config file resolves to the default without throwing", () => {
		const dir = tempDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.json"), "{ not json", "utf-8");
		expect(createSkillifyConfigStore(dir).read()).toEqual(DEFAULT_CONFIG);
	});

	it("write persists the normalized config and read round-trips it", () => {
		const dir = tempDir();
		const store = createSkillifyConfigStore(dir);
		store.write({ scope: "team", team: ["alice", "bob"], install: "global" });
		expect(existsSync(join(dir, "config.json"))).toBe(true);
		expect(store.read()).toEqual({ scope: "team", team: ["alice", "bob"], install: "global" });
	});

	it("coerceScope: org→team, team→team, anything-else→me", () => {
		expect(coerceScope("org")).toBe("team");
		expect(coerceScope("team")).toBe("team");
		expect(coerceScope("me")).toBe("me");
		expect(coerceScope("garbage")).toBe("me");
		expect(coerceScope(undefined)).toBe("me");
	});

	it("normalizeConfig dedupes + trims the team list and defaults install to project", () => {
		const cfg = normalizeConfig({ scope: "team", team: [" alice ", "bob", "alice", "", 7], install: "weird" });
		expect(cfg.team).toEqual(["alice", "bob"]);
		expect(cfg.install).toBe("project");
	});

	it("parseUsersList splits, trims, drops empties, and dedupes", () => {
		expect(parseUsersList("alice, bob,,alice")).toEqual(["alice", "bob"]);
		expect(parseUsersList("")).toEqual([]);
	});
});
