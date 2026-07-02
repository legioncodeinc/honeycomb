/**
 * PRD-018b/c pull hardening — proves the 018 ACs (named, unskipped) on top of the 016c pull.
 *
 * Drives the real `pull` / `autoPull` / `decideAction` / `backfillSymlinks` / `unpullSkill`
 * against FAKE seams (a fake pull client, a fake trusted-table list) + temp dirs as the
 * canonical + other agent roots + a temp manifest. So a test asserts the EXACT files,
 * backups, symlinks, manifest records, and skips that land — WITHOUT a daemon or a real `~`.
 *
 * ── win32 symlink note ──────────────────────────────────────────────────────
 * `symlinkSync("dir")` needs the SeCreateSymbolicLink privilege on win32, which CI may lack.
 * The fan-out swallows a refused link per-link, so the PULL succeeds on win32 regardless; the
 * assertions that a real symlink EXISTS / is stale / is healed are guarded by
 * `it.skipIf(!CAN_SYMLINK)` (probed once at load), mirroring `install.test.ts`.
 */

import {
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	type AgentRootDetector,
	type AuthCheck,
	autoPull,
	backfillSymlinks,
	canonicalDirName,
	createFakeSkillPullClient,
	createFakeTrustedTableList,
	createPullManifestStore,
	decideAction,
	type PulledSkill,
	pull,
	type PullManifestStore,
	unpullSkill,
} from "../../../src/daemon-client/skillify/index.js";

// Every mkdtemp'd dir minted by a test is tracked here and reclaimed in `afterEach` — see
// `tests/setup/isolate-home.ts` for the incident (100k+ stray dirs under `%TEMP%`) that made
// this discipline mandatory across every skillify test helper.
const tempDirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "skillify-018-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const CAN_SYMLINK = (() => {
	try {
		const dir = tempDir();
		const target = join(dir, "t");
		mkdirSync(target);
		symlinkSync(target, join(dir, "link"), "dir");
		return true;
	} catch {
		return false;
	}
})();

function skill(over: Partial<PulledSkill> = {}): PulledSkill {
	return {
		name: "tidy-imports",
		author: "alice",
		version: 1,
		body: "---\nname: tidy-imports\nversion: 1\n---\n\n## Tidy imports\n",
		...over,
	};
}

/** A SKILL.md body rendered at a given version (the version: line is what readLocalVersion scans). */
function bodyAt(version: number, marker = "body"): string {
	return `---\nname: tidy-imports\nversion: ${version}\n---\n\n## ${marker}\n`;
}

function roots(canonical: string, others: readonly string[]): AgentRootDetector {
	return { canonicalRoot: () => canonical, otherRoots: () => others };
}

function auth(ok: boolean): AuthCheck {
	return { isAuthenticated: () => ok };
}

function manifestStore(): PullManifestStore {
	return createPullManifestStore(tempDir());
}

describe("PRD-018b decideAction policy", () => {
	it("b-AC-1 remote at-or-older than local → skip (no write)", () => {
		expect(decideAction({ localExists: true, localVersion: 3, remoteVersion: 2, force: false })).toBe("skip");
		expect(decideAction({ localExists: true, localVersion: 3, remoteVersion: 3, force: false })).toBe("skip");
	});

	it("local absent → write (nothing to back up)", () => {
		expect(decideAction({ localExists: false, localVersion: null, remoteVersion: 1, force: false })).toBe("write");
	});

	it("b-AC-3 remote newer than local → backup-write", () => {
		expect(decideAction({ localExists: true, localVersion: 1, remoteVersion: 2, force: false })).toBe(
			"backup-write",
		);
	});

	it("--force → backup-write even when remote is not newer", () => {
		expect(decideAction({ localExists: true, localVersion: 5, remoteVersion: 2, force: true })).toBe("backup-write");
	});

	it("an unreadable local version (null) with a present file → backup-write (remote wins)", () => {
		expect(decideAction({ localExists: true, localVersion: null, remoteVersion: 1, force: false })).toBe(
			"backup-write",
		);
	});
});

describe("PRD-018b idempotent auto-pull", () => {
	it("b-AC-1 a remote at-or-older than local is skipped and no file is written", async () => {
		const canonical = tempDir();
		const dirName = canonicalDirName("tidy-imports", "alice");
		mkdirSync(join(canonical, dirName), { recursive: true });
		const localBody = bodyAt(2, "local-v2-must-survive");
		writeFileSync(join(canonical, dirName, "SKILL.md"), localBody, "utf-8");

		const client = createFakeSkillPullClient({ skills: [skill({ version: 2, body: "REMOTE v2" })] });
		const outcome = await pull({ client, roots: roots(canonical, []), install: "global", manifest: manifestStore() });

		expect(outcome.skillsWritten).toBe(0);
		expect(outcome.skillsSkipped).toBe(1);
		expect(readFileSync(join(canonical, dirName, "SKILL.md"), "utf-8")).toBe(localBody);
	});

	it("b-AC-2 the `skills` table absent → SELECT skipped, no error, no store query", async () => {
		const canonical = tempDir();
		const client = createFakeSkillPullClient({ skills: [skill()] });
		const trustedTables = createFakeTrustedTableList(["memory", "sessions"]); // no `skills`

		const outcome = await pull({ client, roots: roots(canonical, []), install: "global", trustedTables });

		expect(outcome.tableAbsent).toBe(true);
		expect(outcome.skillsWritten).toBe(0);
		// The SELECT was never dispatched — the early-exit fired before readLatestSkills.
		expect(client.calls.count).toBe(0);
	});

	it("b-AC-2 when `skills` IS in the trusted list the SELECT runs normally", async () => {
		const canonical = tempDir();
		const client = createFakeSkillPullClient({ skills: [skill()] });
		const trustedTables = createFakeTrustedTableList(["memory", "skills"]);

		const outcome = await pull({ client, roots: roots(canonical, []), install: "global", trustedTables });

		expect(outcome.tableAbsent).toBe(false);
		expect(outcome.skillsWritten).toBe(1);
		expect(client.calls.count).toBe(1);
	});

	it("b-AC-2 a null trusted-table list is fail-open (the pull proceeds)", async () => {
		const canonical = tempDir();
		const client = createFakeSkillPullClient({ skills: [skill()] });
		const trustedTables = createFakeTrustedTableList(null);

		const outcome = await pull({ client, roots: roots(canonical, []), install: "global", trustedTables });

		expect(outcome.tableAbsent).toBe(false);
		expect(outcome.skillsWritten).toBe(1);
	});

	it("b-AC-3 a remote newer than local → the existing SKILL.md is backed up to SKILL.md.bak, the newer is written", async () => {
		const canonical = tempDir();
		const dirName = canonicalDirName("tidy-imports", "alice");
		const dir = join(canonical, dirName);
		mkdirSync(dir, { recursive: true });
		const oldBody = bodyAt(1, "old-v1");
		writeFileSync(join(dir, "SKILL.md"), oldBody, "utf-8");

		const client = createFakeSkillPullClient({ skills: [skill({ version: 3, body: bodyAt(3, "new-v3") })] });
		const outcome = await pull({ client, roots: roots(canonical, []), install: "global", manifest: manifestStore() });

		expect(outcome.skillsWritten).toBe(1);
		expect(outcome.skillsBackedUp).toBe(1);
		// The new body landed; the prior was preserved at SKILL.md.bak.
		expect(readFileSync(join(dir, "SKILL.md"), "utf-8")).toContain("new-v3");
		expect(readFileSync(join(dir, "SKILL.md.bak"), "utf-8")).toBe(oldBody);
	});

	it("b-AC-5 a remote skill with an empty author is skipped (protect the local-mined slot)", async () => {
		const canonical = tempDir();
		const client = createFakeSkillPullClient({ skills: [skill({ author: "" }), skill({ name: "ok", author: "bob" })] });

		const outcome = await pull({ client, roots: roots(canonical, []), install: "global", manifest: manifestStore() });

		// The empty-author skill skipped; the valid one wrote.
		expect(outcome.skillsSkipped).toBe(1);
		expect(outcome.skillsWritten).toBe(1);
		expect(existsSync(join(canonical, canonicalDirName("ok", "bob"), "SKILL.md"))).toBe(true);
	});

	it("b-AC-4 HONEYCOMB_AUTOPULL_DISABLED=1 → auto-pull does not run and logs no warning", async () => {
		const client = createFakeSkillPullClient({ skills: [skill()] });
		const result = await autoPull({
			client,
			roots: roots(tempDir(), []),
			install: "global",
			auth: auth(true),
			env: { HONEYCOMB_AUTOPULL_DISABLED: "1" },
		});
		expect(result).toBeNull();
		expect(client.calls.count).toBe(0);
	});

	it("b-AC-4 an unauthenticated session → auto-pull skips silently (no store query)", async () => {
		const client = createFakeSkillPullClient({ skills: [skill()] });
		const result = await autoPull({ client, roots: roots(tempDir(), []), install: "global", auth: auth(false), env: {} });
		expect(result).toBeNull();
		expect(client.calls.count).toBe(0);
	});

	it("b-AC-6 the daemon unreachable → 5s timeout, swallow, the call still resolves (session starts)", async () => {
		const client = createFakeSkillPullClient({ failWith: new Error("daemon unreachable") });
		const result = await autoPull({ client, roots: roots(tempDir(), []), install: "global", auth: auth(true), env: {} });
		expect(result).toBeNull(); // swallowed → null, never a throw.
	});

	it("b-AC-6 a slow store loses the race to the timeout bound and returns null", async () => {
		const client = createFakeSkillPullClient({ skills: [skill()], delayMs: 200 });
		const start = Date.now();
		const result = await autoPull({
			client,
			roots: roots(tempDir(), []),
			install: "global",
			auth: auth(true),
			env: {},
			timeoutMs: 20,
		});
		expect(result).toBeNull();
		expect(Date.now() - start).toBeLessThan(200);
	});

	it("b-AC manifest: a global pull records an entry; unpull round-trips (removes it)", async () => {
		const canonical = tempDir();
		const manifest = manifestStore();
		const client = createFakeSkillPullClient({ skills: [skill()] });

		const outcome = await pull({ client, roots: roots(canonical, []), install: "global", manifest });

		expect(outcome.manifestError).toBeNull();
		const dirName = canonicalDirName("tidy-imports", "alice");
		const recorded = manifest.read();
		expect(recorded).toHaveLength(1);
		expect(recorded[0]?.dirName).toBe(dirName);
		expect(recorded[0]?.install).toBe("global");
		expect(recorded[0]?.remoteVersion).toBe(1);

		// unpull reverses the pull-managed entry: removes the canonical dir + the record.
		const un = unpullSkill(manifest, dirName);
		expect(un.removed).toBe(true);
		expect(existsSync(join(canonical, dirName))).toBe(false);
		expect(manifest.read()).toHaveLength(0);
	});

	it("unpull leaves an UNMANAGED dir untouched (reverses pull-managed entries only)", () => {
		const manifest = manifestStore();
		const un = unpullSkill(manifest, "never-pulled--me");
		expect(un.removed).toBe(false);
	});

	// ── SECURITY (PRD-018 audit): the manifest is an on-disk file an attacker (or a corrupt
	// write) could rewrite. A traversal `dirName`/`installRoot` must NEVER make unpull delete a
	// real directory outside the canonical install root.
	it("SECURITY unpull REFUSES a traversal dirName and deletes nothing outside the root", () => {
		const installRoot = tempDir();
		// A real, user-owned directory the poisoned record would try to recursively delete:
		// `<installRoot>/../important-user-data`.
		const victim = resolve(join(installRoot, "..", "important-user-data"));
		mkdirSync(victim, { recursive: true });
		writeFileSync(join(victim, "keep.txt"), "do not delete me", "utf-8");

		const manifest = manifestStore();
		const relToVictim = relative(installRoot, victim); // `../important-user-data` (has `..` + sep)
		manifest.record({
			dirName: relToVictim, // contains separators / `..` → must be rejected
			name: "x",
			author: "y",
			projectKey: "k",
			remoteVersion: 1,
			install: "global",
			installRoot,
			pulledAt: new Date().toISOString(),
			symlinks: [],
		});

		const un = unpullSkill(manifest, relToVictim);
		expect(un.removed).toBe(false); // refused — no canonical dir resolved
		expect(existsSync(victim)).toBe(true); // the victim dir SURVIVES
		expect(existsSync(join(victim, "keep.txt"))).toBe(true);
	});

	it("SECURITY unpull REFUSES an installRoot-itself delete (dirName resolving to the root)", () => {
		const installRoot = tempDir();
		writeFileSync(join(installRoot, "sentinel.txt"), "root must survive", "utf-8");
		const manifest = manifestStore();
		// `.` joins back to installRoot — the containment floor must reject the root itself.
		manifest.record({
			dirName: ".",
			name: "x",
			author: "y",
			projectKey: "k",
			remoteVersion: 1,
			install: "global",
			installRoot,
			pulledAt: new Date().toISOString(),
			symlinks: [],
		});
		const un = unpullSkill(manifest, ".");
		expect(un.removed).toBe(false);
		expect(existsSync(join(installRoot, "sentinel.txt"))).toBe(true);
	});

	it("SECURITY backfill SKIPS a traversal manifest entry (no symlink planted outside roots)", () => {
		const installRoot = tempDir();
		const other = tempDir();
		const manifest = manifestStore();
		manifest.record({
			dirName: "../../../../tmp/evil",
			name: "x",
			author: "y",
			projectKey: "k",
			remoteVersion: 1,
			install: "global",
			installRoot,
			pulledAt: new Date().toISOString(),
			symlinks: [],
		});

		const created = backfillSymlinks(manifest, roots(installRoot, [other]));
		expect(created).toBe(0); // the unsafe entry was skipped, nothing fanned out
	});

	it("a legit dirName still round-trips through unpull after the safety guard", async () => {
		const canonical = tempDir();
		const manifest = manifestStore();
		const client = createFakeSkillPullClient({ skills: [skill()] });
		await pull({ client, roots: roots(canonical, []), install: "global", manifest });

		const dirName = canonicalDirName("tidy-imports", "alice");
		expect(existsSync(join(canonical, dirName))).toBe(true);
		const un = unpullSkill(manifest, dirName);
		expect(un.removed).toBe(true); // a legitimate, sanitized entry is still reversible
		expect(existsSync(join(canonical, dirName))).toBe(false);
	});

	it("a manifest record failure is surfaced as manifestError, not thrown", async () => {
		const canonical = tempDir();
		const throwing: PullManifestStore = {
			read: () => [],
			record: () => {
				throw new Error("disk full");
			},
			remove: () => null,
		};
		const client = createFakeSkillPullClient({ skills: [skill()] });

		const outcome = await pull({ client, roots: roots(canonical, []), install: "global", manifest: throwing });

		// The skill still wrote; the manifest failure surfaced (did not abort the pull).
		expect(outcome.skillsWritten).toBe(1);
		expect(outcome.manifestError).toContain("disk full");
	});
});

describe("PRD-018b dry-run", () => {
	it("c-AC-5 a dry-run reports the would-write but touches NOTHING on disk", async () => {
		const canonical = tempDir();
		const other = tempDir();
		const manifest = manifestStore();
		const client = createFakeSkillPullClient({ skills: [skill()] });

		const outcome = await pull({
			client,
			roots: roots(canonical, [other]),
			install: "global",
			manifest,
			dryRun: true,
		});

		expect(outcome.dryRun).toBe(true);
		expect(outcome.skillsWritten).toBe(1); // reported
		// Neither the canonical file, nor a symlink, nor a manifest record was created.
		expect(existsSync(join(canonical, canonicalDirName("tidy-imports", "alice"), "SKILL.md"))).toBe(false);
		expect(existsSync(join(other, canonicalDirName("tidy-imports", "alice")))).toBe(false);
		expect(manifest.read()).toHaveLength(0);
	});
});

describe("PRD-018c symlink fan-out + backfill", () => {
	it("c-AC-3 a project-local pull never fans out (no symlinks)", async () => {
		const canonical = tempDir();
		const other = tempDir();
		const client = createFakeSkillPullClient({ skills: [skill()] });

		const outcome = await pull({ client, roots: roots(canonical, [other]), install: "project" });

		expect(outcome.skillsWritten).toBe(1);
		expect(outcome.symlinksCreated).toBe(0);
		expect(existsSync(join(other, canonicalDirName("tidy-imports", "alice")))).toBe(false);
	});

	it("c-AC-3 a project-local pull records NOTHING in the manifest (no fan-out, no backfill)", async () => {
		const canonical = tempDir();
		const manifest = manifestStore();
		const client = createFakeSkillPullClient({ skills: [skill()] });

		await pull({ client, roots: roots(canonical, [tempDir()]), install: "project", manifest });

		expect(manifest.read()).toHaveLength(0);
	});

	it("c-AC-1 a global pull fans a symlink into each other root → the canonical dir", async () => {
		const canonical = tempDir();
		const others = [tempDir(), tempDir()];
		const client = createFakeSkillPullClient({ skills: [skill()] });

		const outcome = await pull({ client, roots: roots(canonical, others), install: "global", manifest: manifestStore() });

		expect(outcome.symlinksCreated).toBe(2);
	});

	it.skipIf(!CAN_SYMLINK)("c-AC-1 the fanned-out entry is a real symlink to the canonical dir", async () => {
		const canonical = tempDir();
		const other = tempDir();
		const client = createFakeSkillPullClient({ skills: [skill()] });

		await pull({ client, roots: roots(canonical, [other]), install: "global", manifest: manifestStore() });

		const link = join(other, canonicalDirName("tidy-imports", "alice"));
		expect(lstatSync(link).isSymbolicLink()).toBe(true);
		expect(readFileSync(join(link, "SKILL.md"), "utf-8")).toContain("Tidy imports");
	});

	it.skipIf(!CAN_SYMLINK)("c-AC-6 a re-run leaves a correct link untouched (idempotent no-op)", async () => {
		const canonical = tempDir();
		const other = tempDir();
		const client = createFakeSkillPullClient({ skills: [skill()] });
		const manifest = manifestStore();

		await pull({ client, roots: roots(canonical, [other]), install: "global", manifest });
		const link = join(other, canonicalDirName("tidy-imports", "alice"));
		const before = lstatSync(link).mtimeMs;

		// Second pull: local now equals remote → skip the write; backfill sees the correct link.
		const second = await pull({ client, roots: roots(canonical, [other]), install: "global", manifest });
		expect(second.skillsSkipped).toBe(1);
		expect(lstatSync(link).mtimeMs).toBe(before); // the correct link was not recreated.
	});

	it.skipIf(!CAN_SYMLINK)("c-AC-4 a stale symlink (different canonical path) is unlinked + recreated", async () => {
		const canonical = tempDir();
		const other = tempDir();
		const dirName = canonicalDirName("tidy-imports", "alice");

		// Seed a STALE link pointing at a DIFFERENT (old) canonical path.
		const oldCanonical = tempDir();
		mkdirSync(join(oldCanonical, dirName), { recursive: true });
		writeFileSync(join(oldCanonical, dirName, "SKILL.md"), bodyAt(1, "OLD-target"), "utf-8");
		mkdirSync(other, { recursive: true });
		symlinkSync(join(oldCanonical, dirName), join(other, dirName), "dir");

		const client = createFakeSkillPullClient({ skills: [skill({ body: bodyAt(1, "Tidy imports") })] });
		await pull({ client, roots: roots(canonical, [other]), install: "global", manifest: manifestStore() });

		// The link now resolves to the NEW canonical dir, not the old one (self-healed).
		const link = join(other, dirName);
		expect(resolve(readlinkSync(link))).toBe(resolve(join(canonical, dirName)));
	});

	it.skipIf(!CAN_SYMLINK)(
		"c-AC-2 a newly-installed agent inherits prior pulls via backfill (the skipped-path gap)",
		async () => {
			const canonical = tempDir();
			const manifest = manifestStore();
			const client = createFakeSkillPullClient({ skills: [skill()] });

			// First pull: only ONE agent root detected. The skill writes + fans into it.
			const rootA = tempDir();
			await pull({ client, roots: roots(canonical, [rootA]), install: "global", manifest });

			// A NEW agent appears (rootB). The next pull SKIPS the up-to-date skill (no per-row
			// fan-out), but backfill ensures the prior pull lands in rootB anyway.
			const rootB = tempDir();
			const second = await pull({ client, roots: roots(canonical, [rootA, rootB]), install: "global", manifest });

			expect(second.skillsWritten).toBe(0); // skipped (local == remote)
			expect(existsSync(join(rootB, canonicalDirName("tidy-imports", "alice")))).toBe(true);
		},
	);

	it("backfillSymlinks only re-fans GLOBAL manifest entries (project entries are skipped)", () => {
		const canonical = tempDir();
		const dirName = canonicalDirName("p", "me");
		mkdirSync(join(canonical, dirName), { recursive: true });
		writeFileSync(join(canonical, dirName, "SKILL.md"), bodyAt(1), "utf-8");

		const manifest = manifestStore();
		// A project-install entry must NOT be backfilled.
		manifest.record({
			dirName,
			name: "p",
			author: "me",
			projectKey: "k",
			remoteVersion: 1,
			install: "project",
			installRoot: canonical,
			pulledAt: new Date().toISOString(),
			symlinks: [],
		});

		const created = backfillSymlinks(manifest, roots(canonical, [tempDir()]));
		expect(created).toBe(0);
	});
});

describe("PRD-018 index ACs (the parent-level criteria)", () => {
	it("index-AC-3 a global pull symlinks into every detected non-Claude root → the canonical dir", async () => {
		const canonical = tempDir();
		const others = [tempDir(), tempDir(), tempDir()];
		const client = createFakeSkillPullClient({ skills: [skill()] });

		const outcome = await pull({ client, roots: roots(canonical, others), install: "global", manifest: manifestStore() });

		expect(outcome.symlinksCreated).toBe(3);
	});

	it("index-AC-2 a teammate's newer skill is written within a pull; a no-change re-run touches no files", async () => {
		const canonical = tempDir();
		const manifest = manifestStore();
		const client = createFakeSkillPullClient({ skills: [skill({ version: 2, body: bodyAt(2) })] });

		const first = await pull({ client, roots: roots(canonical, []), install: "global", manifest });
		expect(first.skillsWritten).toBe(1);

		const second = await pull({ client, roots: roots(canonical, []), install: "global", manifest });
		expect(second.skillsWritten).toBe(0);
		expect(second.skillsSkipped).toBe(1);
	});
});
