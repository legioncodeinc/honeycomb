/**
 * PRD-072b (QA Warning 1) — legacy-fallback reads for the skillify CONFIG store and the pull
 * MANIFEST adapter (072b scope table: every family gets "a new-path-first legacy-second read while
 * the window is open").
 *
 * Config: an unmigrated `~/.honeycomb/state/skillify/config.json` must not silently revert the
 * publish scope to defaults. Manifest: an unmigrated `~/.honeycomb/registry.json` must keep pulled
 * skill records visible. Production defaults (no-arg constructions) run against the per-file
 * isolated home; the injected-seam variant proves the mechanism directly.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	createSkillifyConfigStore,
	DEFAULT_CONFIG,
	defaultConfigBaseDir,
	legacyConfigBaseDir,
} from "../../../src/daemon-client/skillify/config.js";
import { createPullManifestStore, defaultManifestBaseDir } from "../../../src/daemon-client/skillify/manifest.js";

function write(path: string, content: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

describe("PRD-072b Warning 1 — skillify config reads fall back to the legacy state root", () => {
	afterEach(() => {
		// The production-default tests write under the per-file isolated home; clear between tests.
		rmSync(join(homedir(), ".honeycomb"), { recursive: true, force: true });
		rmSync(join(homedir(), ".apiary"), { recursive: true, force: true });
	});

	it("AC-072b.1.2 the PRODUCTION default reads an unmigrated legacy config (never silently defaults)", () => {
		write(
			join(legacyConfigBaseDir(), "config.json"),
			JSON.stringify({ scope: "team", team: ["ada"], install: "global" }),
		);
		const store = createSkillifyConfigStore(); // the no-arg production default
		expect(store.read()).toEqual({ scope: "team", team: ["ada"], install: "global" });
	});

	it("AC-072b.1.2 the new path wins over the legacy one when both exist", () => {
		write(join(legacyConfigBaseDir(), "config.json"), JSON.stringify({ scope: "team", team: ["old"] }));
		write(join(defaultConfigBaseDir(), "config.json"), JSON.stringify({ scope: "me", team: [] }));
		expect(createSkillifyConfigStore().read().scope).toBe("me");
	});

	it("writes always land at the NEW path (the legacy file is read-only during the window)", () => {
		write(join(legacyConfigBaseDir(), "config.json"), JSON.stringify({ scope: "team", team: ["old"] }));
		const store = createSkillifyConfigStore();
		store.write({ scope: "me", team: [], install: "project" });
		expect(existsSync(join(defaultConfigBaseDir(), "config.json"))).toBe(true);
		// After the write the new path exists and wins the read.
		expect(store.read().scope).toBe("me");
		// The legacy file was never rewritten.
		expect(JSON.parse(readFileSync(join(legacyConfigBaseDir(), "config.json"), "utf8")).scope).toBe("team");
	});

	it("neither path present resolves the canonical default (unchanged fail-soft)", () => {
		expect(createSkillifyConfigStore().read()).toEqual(DEFAULT_CONFIG);
	});

	it("the injected seam drives the same fallback deterministically (temp dirs)", () => {
		const base = mkdtempSync(join(tmpdir(), "hc-cfg-new-"));
		const legacyBase = mkdtempSync(join(tmpdir(), "hc-cfg-legacy-"));
		try {
			write(join(legacyBase, "config.json"), JSON.stringify({ scope: "team", team: ["bee"] }));
			expect(createSkillifyConfigStore(base, legacyBase).read().team).toEqual(["bee"]);
		} finally {
			rmSync(base, { recursive: true, force: true });
			rmSync(legacyBase, { recursive: true, force: true });
		}
	});
});

describe("PRD-072b Warning 1 — the pull-manifest adapter reads the legacy unified registry", () => {
	beforeEach(() => {
		rmSync(join(homedir(), ".honeycomb"), { recursive: true, force: true });
		rmSync(join(homedir(), ".apiary"), { recursive: true, force: true });
	});
	afterEach(() => {
		rmSync(join(homedir(), ".honeycomb"), { recursive: true, force: true });
		rmSync(join(homedir(), ".apiary"), { recursive: true, force: true });
	});

	/** A minimal pulled-skill registry row (the R-2 unified shape the adapter reads). */
	const PULLED_ROW = {
		honeycombId: "my-skill--ada",
		assetType: "skill",
		tier: "Local",
		style: "Repository",
		harness: "ada",
		version: 0,
		lastSyncedHash: "",
		localHash: "",
		remoteHash: "",
		org: "",
		workspace: "",
		deviceSet: [],
		pulledManifest: {
			install: "project",
			installRoot: "/tmp/proj",
			symlinks: [],
			name: "my-skill",
			author: "ada",
			projectKey: "proj",
			pulledAt: "2026-07-04T00:00:00.000Z",
			remoteVersion: 3,
		},
	};

	it("AC-072b.1.2 an unmigrated legacy ~/.honeycomb/registry.json keeps pulled records visible", () => {
		write(join(homedir(), ".honeycomb", "registry.json"), JSON.stringify([PULLED_ROW]));
		const store = createPullManifestStore(); // the no-arg production default
		const entries = store.read();
		expect(entries).toHaveLength(1);
		expect(entries[0]?.dirName).toBe("my-skill--ada");
		expect(entries[0]?.remoteVersion).toBe(3);
	});

	it("the new registry wins over the legacy one when both exist", () => {
		write(join(homedir(), ".honeycomb", "registry.json"), JSON.stringify([PULLED_ROW]));
		write(join(defaultManifestBaseDir(), "registry.json"), JSON.stringify([]));
		expect(createPullManifestStore().read()).toEqual([]);
	});

	it("a legacy pull-manifest under the legacy STATE root is folded in by the migration probe", () => {
		write(
			join(homedir(), ".honeycomb", "state", "skillify", "pull-manifest.json"),
			JSON.stringify([
				{
					dirName: "old-skill--bee",
					name: "old-skill",
					author: "bee",
					projectKey: "p",
					remoteVersion: 1,
					install: "project",
					installRoot: "/tmp/p",
					pulledAt: "t",
					symlinks: [],
				},
			]),
		);
		const entries = createPullManifestStore().read();
		expect(entries.map((e) => e.dirName)).toContain("old-skill--bee");
	});
});
