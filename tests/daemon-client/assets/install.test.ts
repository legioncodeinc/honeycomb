/**
 * PRD-033c — the asset-sync THIN-CLIENT install/retract engine (the consume half).
 *
 * These tests drive {@link pullAndInstall} / {@link autoPull} / {@link decideInstall}
 * against a FAKE {@link AssetSyncApi} + temp install roots (no daemon, no real `~`/cwd):
 *
 *   c-AC-2  remote-newer vs hash-divergent local → `.bak` + overwrite (last-writer-wins).
 *   c-AC-3  an artifact installs ONLY on a MATCHING harness (a `(skill,claude_code)` row
 *           does NOT install into a different harness root).
 *   c-AC-4  the identity adapter round-trips (`parse(render(x)) === x`).
 *   c-AC-5  a tombstone for a locally-present artifact retracts it (`.bak` then remove, D-4).
 *   c-AC-6  a no-change pull is a no-op; a slow/absent table → within budget, errors swallowed.
 *   path-safety: a malicious `honeycomb_id` can never escape the install root.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	ASSET_AUTOPULL_DISABLED_ENV,
	autoPull,
	createDefaultHarnessRoots,
	decideInstall,
	pullAndInstall,
	resolveContainedDir,
} from "../../../src/daemon-client/assets/install.js";
import {
	type AssetScope,
	type AssetSyncApi,
	IDENTITY_ADAPTER,
	type PulledAsset,
} from "../../../src/daemon-client/assets/contracts.js";

const ID = "hc_aaaa0000aaaa0000aaaa0000aaaa0000";
const SCOPE: AssetScope = { org: "acme", workspace: "backend", author: "alice", deviceId: "dev-1" };

/** A fake pull-only {@link AssetSyncApi} that returns a fixed asset set (publish/tombstone unused). */
function fakeApi(assets: readonly PulledAsset[], opts: { tableAbsent?: boolean; failWith?: Error; delayMs?: number } = {}): AssetSyncApi {
	return {
		async publish() {
			return { honeycombId: "", version: 0, published: false };
		},
		async pull() {
			if (opts.delayMs !== undefined) await new Promise((r) => setTimeout(r, opts.delayMs));
			if (opts.failWith !== undefined) throw opts.failWith;
			return { assets, tableAbsent: opts.tableAbsent ?? false };
		},
		async tombstone() {
			return { honeycombId: "", version: 0, tombstoned: false };
		},
	};
}

/** Build a {@link PulledAsset} with sensible defaults. */
function asset(over: Partial<PulledAsset> = {}): PulledAsset {
	return {
		honeycombId: ID,
		assetType: "skill",
		harness: "claude_code",
		native: "---\nname: x\n---\nbody v1",
		canonical: "",
		contentHash: "h1",
		version: 1,
		tombstone: false,
		cell: { tier: "Team", style: "Repository" },
		deviceSet: [],
		author: "alice",
		org: "acme",
		workspace: "backend",
		...over,
	};
}

let projectDir: string;
let home: string;

beforeEach(() => {
	projectDir = mkdtempSync(join(tmpdir(), "hc-assets-proj-"));
	home = mkdtempSync(join(tmpdir(), "hc-assets-home-"));
});
afterEach(() => {
	rmSync(projectDir, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
});

/** The skill file path for `ID` on the Claude Code project-local (Repository) root. */
function claudeSkillFile(): string {
	return join(projectDir, ".claude", "skills", ID, "SKILL.md");
}

describe("PRD-033c thin-client install/retract (c-AC-2..6)", () => {
	it("c-AC-4 identity adapter round-trips parse(render(x)) === x", () => {
		for (const x of ["", "plain", "---\nk: v\n---\n'q' \\b", "🐝"]) {
			expect(IDENTITY_ADAPTER.parse(IDENTITY_ADAPTER.render(x))).toBe(x);
		}
	});

	it("installs a fresh artifact verbatim onto the matching harness root (c-AC-3/4)", async () => {
		const roots = createDefaultHarnessRoots({ home, projectDir });
		const out = await pullAndInstall({ api: fakeApi([asset()]), roots, scope: SCOPE });
		expect(out.installed).toBe(1);
		const file = claudeSkillFile();
		expect(existsSync(file)).toBe(true);
		expect(readFileSync(file, "utf-8")).toBe("---\nname: x\n---\nbody v1");
	});

	it("c-AC-3 a (skill,claude_code) row does NOT install onto a different harness root", async () => {
		const roots = createDefaultHarnessRoots({ home, projectDir });
		await pullAndInstall({ api: fakeApi([asset({ harness: "claude_code" })]), roots, scope: SCOPE });
		// The Claude Code root has it; the codex/cursor/hermes roots do NOT.
		expect(existsSync(claudeSkillFile())).toBe(true);
		for (const h of [".codex", ".cursor", ".hermes"]) {
			expect(existsSync(join(projectDir, h, "skills", ID, "SKILL.md"))).toBe(false);
		}
	});

	it("c-AC-3 a row for an UNKNOWN harness is skipped (no root → no write)", async () => {
		const roots = createDefaultHarnessRoots({ home, projectDir });
		const out = await pullAndInstall({ api: fakeApi([asset({ harness: "nonexistent_harness" })]), roots, scope: SCOPE });
		expect(out.installed).toBe(0);
		expect(out.skipped).toBe(1);
	});

	it("c-AC-2 remote-newer + hash-divergent local → .bak + overwrite (last-writer-wins)", async () => {
		const roots = createDefaultHarnessRoots({ home, projectDir });
		// First install v1.
		await pullAndInstall({ api: fakeApi([asset({ version: 1, native: "v1", contentHash: "h1" })]), roots, scope: SCOPE });
		const file = claudeSkillFile();
		// Simulate a LOCAL EDIT (hash-divergent): the user changed the installed file.
		writeFileSync(file, "v1-locally-edited", "utf-8");
		// Pull a NEWER version with a DIFFERENT hash.
		const out = await pullAndInstall({ api: fakeApi([asset({ version: 2, native: "v2", contentHash: "h2" })]), roots, scope: SCOPE });
		expect(out.backedUp).toBe(1);
		expect(out.installed).toBe(1);
		// The edit is preserved at .bak; the newer remote won.
		expect(readFileSync(`${file}.bak`, "utf-8")).toBe("v1-locally-edited");
		expect(readFileSync(file, "utf-8")).toBe("v2");
	});

	it("c-AC-6 a no-change pull (same version) is a no-op (skip, never re-write)", async () => {
		const roots = createDefaultHarnessRoots({ home, projectDir });
		await pullAndInstall({ api: fakeApi([asset({ version: 3, native: "v3", contentHash: "h3" })]), roots, scope: SCOPE });
		const file = claudeSkillFile();
		// Re-pull the SAME version → skip. No .bak created, file unchanged.
		const out = await pullAndInstall({ api: fakeApi([asset({ version: 3, native: "v3", contentHash: "h3" })]), roots, scope: SCOPE });
		expect(out.installed).toBe(0);
		expect(out.skipped).toBe(1);
		expect(out.backedUp).toBe(0);
		expect(existsSync(`${file}.bak`)).toBe(false);
	});

	it("c-AC-5 a tombstone for a locally-present artifact retracts it (.bak then remove, D-4)", async () => {
		const roots = createDefaultHarnessRoots({ home, projectDir });
		await pullAndInstall({ api: fakeApi([asset({ version: 1, native: "live", contentHash: "h1" })]), roots, scope: SCOPE });
		const file = claudeSkillFile();
		expect(existsSync(file)).toBe(true);
		// Pull a TOMBSTONE for the same artifact.
		const out = await pullAndInstall({
			api: fakeApi([asset({ version: 2, tombstone: true, native: "", contentHash: "" })]),
			roots,
			scope: SCOPE,
		});
		expect(out.retracted).toBe(1);
		// The live file is gone; the user's content is preserved at .bak.
		expect(existsSync(file)).toBe(false);
		expect(readFileSync(`${file}.bak`, "utf-8")).toBe("live");
		// The marker is removed too (the artifact is no longer managed).
		expect(existsSync(join(projectDir, ".claude", "skills", ID, ".honeycomb-asset.json"))).toBe(false);
	});

	it("c-AC-6 table-absent → no-op within budget (no install, no throw)", async () => {
		const roots = createDefaultHarnessRoots({ home, projectDir });
		const out = await pullAndInstall({ api: fakeApi([asset()], { tableAbsent: true }), roots, scope: SCOPE });
		expect(out.tableAbsent).toBe(true);
		expect(out.installed).toBe(0);
		expect(existsSync(claudeSkillFile())).toBe(false);
	});

	it("c-AC-6 autoPull swallows ALL errors → null, never throws (fail-soft)", async () => {
		const roots = createDefaultHarnessRoots({ home, projectDir });
		const out = await autoPull({ api: fakeApi([], { failWith: new Error("boom") }), roots, scope: SCOPE });
		expect(out).toBeNull();
	});

	it("c-AC-6 autoPull stays within the budget when the pull is slow (timeout → null)", async () => {
		const roots = createDefaultHarnessRoots({ home, projectDir });
		const started = Date.now();
		const out = await autoPull({ api: fakeApi([asset()], { delayMs: 5_000 }), roots, scope: SCOPE, timeoutMs: 50 });
		expect(out).toBeNull();
		expect(Date.now() - started).toBeLessThan(2_000); // bounded, never the full 5s
	});

	it("c-AC-6 autoPull disabled by env runs nothing → null", async () => {
		const roots = createDefaultHarnessRoots({ home, projectDir });
		const out = await autoPull({
			api: fakeApi([asset()]),
			roots,
			scope: SCOPE,
			env: { [ASSET_AUTOPULL_DISABLED_ENV]: "1" },
		});
		expect(out).toBeNull();
		expect(existsSync(claudeSkillFile())).toBe(false);
	});

	it("dryRun reports decisions but touches NOTHING on disk", async () => {
		const roots = createDefaultHarnessRoots({ home, projectDir });
		const out = await pullAndInstall({ api: fakeApi([asset()]), roots, scope: SCOPE, dryRun: true });
		expect(out.installed).toBe(1);
		expect(out.dryRun).toBe(true);
		expect(existsSync(claudeSkillFile())).toBe(false);
	});

	it("User-style installs onto the GLOBAL (home) root, not the project root", async () => {
		const roots = createDefaultHarnessRoots({ home, projectDir });
		await pullAndInstall({
			api: fakeApi([asset({ cell: { tier: "Team", style: "User" } })]),
			roots,
			scope: SCOPE,
		});
		expect(existsSync(join(home, ".claude", "skills", ID, "SKILL.md"))).toBe(true);
		expect(existsSync(join(projectDir, ".claude", "skills", ID, "SKILL.md"))).toBe(false);
	});

	it("an agent installs to the agents root as AGENT.md", async () => {
		const roots = createDefaultHarnessRoots({ home, projectDir });
		await pullAndInstall({ api: fakeApi([asset({ assetType: "agent", native: "agent body" })]), roots, scope: SCOPE });
		expect(readFileSync(join(projectDir, ".claude", "agents", ID, "AGENT.md"), "utf-8")).toBe("agent body");
	});
});

describe("PRD-033c decideInstall (last-writer-wins policy)", () => {
	it("local absent → write", () => {
		expect(decideInstall({ localExists: false, localVersion: null, localHash: null, remoteVersion: 1, remoteHash: "h", force: false })).toBe("write");
	});
	it("remote newer + hash-divergent → backup-write", () => {
		expect(decideInstall({ localExists: true, localVersion: 1, localHash: "ha", remoteVersion: 2, remoteHash: "hb", force: false })).toBe("backup-write");
	});
	it("remote newer + SAME hash → skip (nothing to write)", () => {
		expect(decideInstall({ localExists: true, localVersion: 1, localHash: "h", remoteVersion: 2, remoteHash: "h", force: false })).toBe("skip");
	});
	it("remote <= local → skip (idempotent no-op)", () => {
		expect(decideInstall({ localExists: true, localVersion: 3, localHash: "ha", remoteVersion: 2, remoteHash: "hb", force: false })).toBe("skip");
	});
	it("force → backup-write regardless", () => {
		expect(decideInstall({ localExists: true, localVersion: 5, localHash: "ha", remoteVersion: 2, remoteHash: "ha", force: true })).toBe("backup-write");
	});
});

describe("PRD-033c path-safety: resolveContainedDir (the install jail)", () => {
	it("a clean honeycomb_id resolves to a direct child of the root", () => {
		const dir = resolveContainedDir("/roots/skills", "hc_abc");
		expect(dir).not.toBeNull();
		expect(dir).toContain("hc_abc");
	});
	it("a traversal id is rejected (null — never escapes the root)", () => {
		for (const bad of ["../etc", "..", ".", "a/b", "a\\b", "..\\..\\x", "/abs", ""]) {
			expect(resolveContainedDir("/roots/skills", bad)).toBeNull();
		}
	});
	it("a malicious id never writes outside the root (pullAndInstall skips it)", async () => {
		const roots = createDefaultHarnessRoots({ home, projectDir });
		const evil = asset({ honeycombId: "../../../escape" });
		const out = await pullAndInstall({ api: fakeApi([evil]), roots, scope: SCOPE });
		expect(out.installed).toBe(0);
		expect(out.skipped).toBe(1);
		// Nothing was written anywhere near an escape path.
		expect(existsSync(join(projectDir, "..", "escape"))).toBe(false);
	});
});
