/**
 * PRD-018a/b `honeycomb skill` CLI — proves the a-AC-2 scope surface + the 018b unpull verb.
 *
 * Drives `runSkillCommand` / `skillMain` against a temp config store + a temp manifest store
 * + a capturing output sink — so the test asserts the config persisted + the manifest reversed,
 * WITHOUT a real `~`. The CLI imports no storage path (the thin-client invariant covers `src/cli`).
 */

import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	canonicalDirName,
	createPullManifestStore,
	createSkillifyConfigStore,
	type PullManifestStore,
	type SkillifyConfigStore,
} from "../../src/daemon-client/skillify/index.js";
import { parseSkillArgs, runSkillCommand, skillMain } from "../../src/cli/skill.js";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "skill-cli-"));
}

function deps(): { config: SkillifyConfigStore; manifest: PullManifestStore; out: (l: string) => void; lines: string[] } {
	const lines: string[] = [];
	return {
		config: createSkillifyConfigStore(tempDir()),
		manifest: createPullManifestStore(tempDir()),
		out: (l: string) => lines.push(l),
		lines,
	};
}

describe("PRD-018a/b skill CLI", () => {
	it("parseSkillArgs extracts the verb, arg, --users, and --install", () => {
		const inv = parseSkillArgs(["scope", "team", "--users", "alice,bob", "--install", "global"]);
		expect(inv.verb).toBe("scope");
		expect(inv.arg).toBe("team");
		expect(inv.users).toEqual(["alice", "bob"]);
		expect(inv.install).toBe("global");
	});

	it("parseSkillArgs supports --users=… / --install=… equals form", () => {
		const inv = parseSkillArgs(["scope", "team", "--users=alice,bob", "--install=project"]);
		expect(inv.users).toEqual(["alice", "bob"]);
		expect(inv.install).toBe("project");
	});

	it("a-AC-2 `skill scope team --users alice,bob` persists team scope + the contributor list", () => {
		const d = deps();
		const result = skillMain(["scope", "team", "--users", "alice,bob"], d);

		expect(result.exitCode).toBe(0);
		expect(result.wrote).toBe(true);
		const cfg = d.config.read();
		expect(cfg.scope).toBe("team");
		expect(cfg.team).toEqual(["alice", "bob"]);
		expect(d.lines.join("\n")).toMatch(/Scope set to team/);
	});

	it("a-AC-2 `--install global` is persisted (drives 018c global-only fan-out)", () => {
		const d = deps();
		skillMain(["scope", "me", "--install", "global"], d);
		expect(d.config.read().install).toBe("global");
	});

	it("a-AC-3 the CLI scope write migrates a legacy `org` config to `team` on disk", () => {
		const dir = tempDir();
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "config.json"), JSON.stringify({ scope: "org", team: ["x"], install: "project" }), "utf-8");
		const config = createSkillifyConfigStore(dir);
		const lines: string[] = [];

		// A plain `scope team` (no --users) re-reads the coerced prior (team: ["x"]) and persists it.
		const result = runSkillCommand({ verb: "scope", arg: "team" }, { config, manifest: createPullManifestStore(tempDir()), out: (l) => lines.push(l) });

		expect(result.exitCode).toBe(0);
		expect(config.read().scope).toBe("team");
		expect(config.read().team).toEqual(["x"]);
	});

	it("scope with an invalid value prints usage and exits non-zero", () => {
		const d = deps();
		const result = runSkillCommand({ verb: "scope", arg: "frobnicate" }, d);
		expect(result.exitCode).toBe(1);
		expect(d.lines.join("\n")).toMatch(/usage: honeycomb skill scope/);
	});

	it("unpull reverses a pull-managed manifest entry (removes the canonical dir + record)", () => {
		const canonical = tempDir();
		const dirName = canonicalDirName("tidy", "alice");
		mkdirSync(join(canonical, dirName), { recursive: true });
		writeFileSync(join(canonical, dirName, "SKILL.md"), "---\nversion: 1\n---\n\nx\n", "utf-8");

		const manifest = createPullManifestStore(tempDir());
		manifest.record({
			dirName,
			name: "tidy",
			author: "alice",
			projectKey: "k",
			remoteVersion: 1,
			install: "global",
			installRoot: canonical,
			pulledAt: new Date().toISOString(),
			symlinks: [],
		});

		const lines: string[] = [];
		const result = runSkillCommand({ verb: "unpull", arg: dirName }, { config: createSkillifyConfigStore(tempDir()), manifest, out: (l) => lines.push(l) });

		expect(result.exitCode).toBe(0);
		expect(result.wrote).toBe(true);
		expect(existsSync(join(canonical, dirName))).toBe(false);
		expect(manifest.read()).toHaveLength(0);
		expect(lines.join("\n")).toMatch(/Unpulled/);
	});

	it("unpull of an unmanaged dir prints a clear message + exits 0 (reverses pulled only)", () => {
		const d = deps();
		const result = runSkillCommand({ verb: "unpull", arg: "never--pulled" }, d);
		expect(result.exitCode).toBe(0);
		expect(result.wrote).toBe(false);
		expect(d.lines.join("\n")).toMatch(/No pull-managed skill/);
	});

	it("an unknown verb prints usage and exits non-zero", () => {
		const d = deps();
		const result = runSkillCommand({ verb: "frobnicate" }, d);
		expect(result.exitCode).toBe(1);
		expect(d.lines.join("\n")).toMatch(/usage: honeycomb skill/);
	});
});
