/**
 * PRD-016c skill install — proves c-AC-1..6 (named, unskipped).
 *
 * Verification posture (EXECUTION_LEDGER-prd-016): no live DeepLake. Each c-AC has a named
 * test driven against a FAKE pull-client (`createFakeSkillPullClient` returning skill rows)
 * + temp dirs as the canonical + other agent roots. So a test asserts the EXACT files +
 * symlinks that land AND that the pull reached storage ONLY through the dispatch seam (never
 * a direct DeepLake open). The production `createDaemonPullClient` is driven over the SAME
 * FAKE `DaemonDispatch` the VFS uses, asserting the highest-version SELECT dispatches through
 * the daemon (c-AC-6).
 *
 * ── win32 symlink note ──────────────────────────────────────────────────────
 * `symlinkSync("dir")` needs the SeCreateSymbolicLink privilege on win32, which CI may lack.
 * The fan-out swallows a refused link per-link (it never aborts the pull), so the *pull
 * succeeds* on win32 regardless; the assertion that a real symlink EXISTS is guarded by
 * `it.skipIf(!CAN_SYMLINK)`, probed once at load time — mirroring the repo's POSIX-only fs
 * assertions (`auth.test.ts` / `secrets/store.test.ts`).
 */

import { existsSync, lstatSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	createFakeDaemonDispatch,
	type Row,
	type VfsScope,
} from "../../../src/daemon-client/vfs/index.js";
import {
	type AgentRootDetector,
	type AuthCheck,
	AUTOPULL_DISABLED_ENV,
	autoPull,
	canonicalDirName,
	createDaemonPullClient,
	createFakeSkillPullClient,
	type PulledSkill,
	pull,
} from "../../../src/daemon-client/skillify/index.js";

/** A temp dir unique per call — agent roots root here (no real home writes). */
function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "skillify-c-"));
}

/** Probe once whether this platform can create a symlink (win32 may lack the privilege). */
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

/** A skill row the fake pull-client returns. */
function skill(over: Partial<PulledSkill> = {}): PulledSkill {
	return {
		name: "tidy-imports",
		author: "alice",
		version: 1,
		body: "---\nname: tidy-imports\nversion: 1\n---\n\n## Tidy imports\n",
		...over,
	};
}

/** Build an injectable {@link AgentRootDetector} from a canonical root + other roots. */
function roots(canonical: string, others: readonly string[]): AgentRootDetector {
	return { canonicalRoot: () => canonical, otherRoots: () => others };
}

/** A fixed {@link AuthCheck}. */
function auth(ok: boolean): AuthCheck {
	return { isAuthenticated: () => ok };
}

describe("PRD-016c skill install", () => {
	// ── c-AC-1 ──────────────────────────────────────────────────────────────────
	it("c-AC-1 pull writes ~/.claude/skills/<name>--<author>/SKILL.md and symlinks into every other agent root", async () => {
		const canonical = tempDir();
		const otherA = tempDir();
		const otherB = tempDir();
		const client = createFakeSkillPullClient({ skills: [skill()] });

		const outcome = await pull({ client, roots: roots(canonical, [otherA, otherB]) });

		// The canonical SKILL.md landed at <name>--<author>/SKILL.md.
		const dirName = canonicalDirName("tidy-imports", "alice");
		expect(dirName).toBe("tidy-imports--alice");
		const canonicalFile = join(canonical, dirName, "SKILL.md");
		expect(existsSync(canonicalFile)).toBe(true);
		expect(readFileSync(canonicalFile, "utf-8")).toContain("## Tidy imports");
		expect(outcome.skillsWritten).toBe(1);

		// A symlink (or, where the OS refuses, at least the fan-out was attempted) in each other root.
		expect(outcome.symlinksCreated).toBe(2);
	});

	it.skipIf(!CAN_SYMLINK)(
		"c-AC-1 the fanned-out entry is a real symlink pointing at the canonical dir",
		async () => {
			const canonical = tempDir();
			const other = tempDir();
			const client = createFakeSkillPullClient({ skills: [skill()] });

			await pull({ client, roots: roots(canonical, [other]) });

			const dirName = canonicalDirName("tidy-imports", "alice");
			const linkPath = join(other, dirName);
			expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
			// Reading through the link resolves to the canonical SKILL.md (the target is the canonical dir).
			expect(readFileSync(join(linkPath, "SKILL.md"), "utf-8")).toContain("## Tidy imports");
		},
	);

	// ── c-AC-5 ──────────────────────────────────────────────────────────────────
	it("c-AC-5 a global-install pull fans a symlink into EACH detected agent root → the canonical dir", async () => {
		const canonical = tempDir();
		const detected = [tempDir(), tempDir(), tempDir()];
		const client = createFakeSkillPullClient({ skills: [skill({ name: "a" }), skill({ name: "b" })] });

		const outcome = await pull({ client, roots: roots(canonical, detected) });

		// Two skills × three roots = six symlinks fanned out.
		expect(outcome.skillsWritten).toBe(2);
		expect(outcome.symlinksCreated).toBe(6);
		if (CAN_SYMLINK) {
			for (const name of ["a", "b"]) {
				for (const root of detected) {
					const link = join(root, canonicalDirName(name, "alice"));
					expect(lstatSync(link).isSymbolicLink(), `${link} should be a symlink`).toBe(true);
				}
			}
		}
	});

	// ── c-AC-2 (idempotent skip) ──────────────────────────────────────────────────
	it("c-AC-2 a skill whose LOCAL version is at or newer than remote is SKIPPED (no rewrite)", async () => {
		const canonical = tempDir();
		const dirName = canonicalDirName("tidy-imports", "alice");
		const file = join(canonical, dirName, "SKILL.md");
		// Seed a LOCAL v2 already on disk.
		mkdirSync(join(canonical, dirName), { recursive: true });
		const localBody = "---\nname: tidy-imports\nversion: 2\n---\n\n## Local v2 — must not be clobbered\n";
		writeFileSync(file, localBody, "utf-8");

		// Remote offers v2 (equal) — must skip, not rewrite.
		const client = createFakeSkillPullClient({ skills: [skill({ version: 2, body: "REMOTE v2 body" })] });
		const outcome = await pull({ client, roots: roots(canonical, []) });

		expect(outcome.skillsWritten).toBe(0);
		expect(outcome.skillsSkipped).toBe(1);
		// The local file is untouched (the remote body did NOT overwrite it).
		expect(readFileSync(file, "utf-8")).toBe(localBody);
	});

	it("c-AC-2 a skill whose LOCAL version is OLDER than remote IS written (the pull updates)", async () => {
		const canonical = tempDir();
		const dirName = canonicalDirName("tidy-imports", "alice");
		const file = join(canonical, dirName, "SKILL.md");
		mkdirSync(join(canonical, dirName), { recursive: true });
		writeFileSync(file, "---\nname: tidy-imports\nversion: 1\n---\n\nold\n", "utf-8");

		const client = createFakeSkillPullClient({ skills: [skill({ version: 3, body: "NEW v3 body" })] });
		const outcome = await pull({ client, roots: roots(canonical, []) });

		expect(outcome.skillsWritten).toBe(1);
		expect(outcome.skillsSkipped).toBe(0);
		expect(readFileSync(file, "utf-8")).toContain("NEW v3 body");
	});

	// ── c-AC-2 (timeout swallows a slow/erroring store) ────────────────────────────
	it("c-AC-2 auto-pull returns (does NOT throw) when the store ERRORS — the error is swallowed", async () => {
		const canonical = tempDir();
		const client = createFakeSkillPullClient({ failWith: new Error("store unavailable") });

		const result = await autoPull({
			client,
			roots: roots(canonical, []),
			auth: auth(true),
			env: {},
		});

		// Swallowed → null, never a throw (startup is not blocked).
		expect(result).toBeNull();
	});

	it("c-AC-2 auto-pull is bounded by the 5s timeout — a slow store loses the race and returns null", async () => {
		const canonical = tempDir();
		// The store takes 200ms; the timeout is set to 20ms → the timeout wins, resolves null.
		const client = createFakeSkillPullClient({ skills: [skill()], delayMs: 200 });

		const start = Date.now();
		const result = await autoPull({
			client,
			roots: roots(canonical, []),
			auth: auth(true),
			env: {},
			timeoutMs: 20,
		});
		const elapsed = Date.now() - start;

		expect(result).toBeNull();
		// It returned well before the slow store would have (bounded, not blocked).
		expect(elapsed).toBeLessThan(200);
		// And it did NOT write the (eventually-resolving) skill, because the timeout won.
		expect(existsSync(join(canonical, canonicalDirName("tidy-imports", "alice"), "SKILL.md"))).toBe(false);
	});

	it("c-AC-2 auto-pull RUNS the pull when authenticated + enabled (the happy path is idempotent)", async () => {
		const canonical = tempDir();
		const client = createFakeSkillPullClient({ skills: [skill()] });

		const result = await autoPull({ client, roots: roots(canonical, []), auth: auth(true), env: {} });

		expect(result).not.toBeNull();
		expect(result?.skillsWritten).toBe(1);
		// A second auto-pull with no remote change is idempotent — the now-local v1 is skipped.
		const second = await autoPull({ client, roots: roots(canonical, []), auth: auth(true), env: {} });
		expect(second?.skillsWritten).toBe(0);
		expect(second?.skillsSkipped).toBe(1);
	});

	// ── c-AC-3 ──────────────────────────────────────────────────────────────────
	it("c-AC-3 HONEYCOMB_AUTOPULL_DISABLED=1 → auto-pull does NOT run (the store is never reached)", async () => {
		const canonical = tempDir();
		const client = createFakeSkillPullClient({ skills: [skill()] });

		const result = await autoPull({
			client,
			roots: roots(canonical, []),
			auth: auth(true),
			env: { [AUTOPULL_DISABLED_ENV]: "1" },
		});

		expect(result).toBeNull();
		// The pull never queried the store (the kill switch short-circuits before any dispatch).
		expect(client.calls.count).toBe(0);
		expect(existsSync(join(canonical, canonicalDirName("tidy-imports", "alice"), "SKILL.md"))).toBe(false);
	});

	// ── c-AC-4 ──────────────────────────────────────────────────────────────────
	it("c-AC-4 an UNAUTHENTICATED session → auto-pull skips SILENTLY (no store query, returns null)", async () => {
		const canonical = tempDir();
		const client = createFakeSkillPullClient({ skills: [skill()] });

		const result = await autoPull({ client, roots: roots(canonical, []), auth: auth(false), env: {} });

		expect(result).toBeNull();
		// Skipped before any dispatch — no token touched, no store reached.
		expect(client.calls.count).toBe(0);
	});

	// ── c-AC-6 ──────────────────────────────────────────────────────────────────
	it("c-AC-6 a pull reaches the store ONLY through the seam (the fake records the call)", async () => {
		const canonical = tempDir();
		const client = createFakeSkillPullClient({ skills: [skill()] });

		await pull({ client, roots: roots(canonical, []) });

		// The ONLY storage path is the injected pull client — it was reached exactly once.
		expect(client.calls.count).toBe(1);
	});

	it("c-AC-6 the production pull client dispatches a highest-version SELECT through the daemon (no direct DeepLake)", async () => {
		const scope: VfsScope = { org: "o1", workspace: "ws1" };
		// The fake DaemonDispatch is the SAME seam the VFS uses — there is no other storage path.
		const dispatch = createFakeDaemonDispatch({
			respond: (sql): readonly Row[] => {
				expect(/SELECT/i.test(sql)).toBe(true);
				expect(/MAX\("?version"?\)/i.test(sql)).toBe(true); // highest-version-per-(name,author)
				expect(/"skills"/.test(sql)).toBe(true);
				return [{ name: "tidy-imports", author: "alice", version: 5, body: "B" }];
			},
		});
		const client = createDaemonPullClient(dispatch, scope);

		const skills = await client.readLatestSkills();

		// The read reached storage ONLY through the dispatch seam, carrying the scope.
		expect(dispatch.calls.length).toBeGreaterThan(0);
		expect(dispatch.calls.every((c) => c.scope.org === "o1" && c.scope.workspace === "ws1")).toBe(true);
		// The highest version resolved.
		expect(skills).toEqual([{ name: "tidy-imports", author: "alice", version: 5, body: "B" }]);
	});

	// ── Path / symlink safety ──────────────────────────────────────────────────────
	it("path safety: a hostile name/author cannot traverse out of the skills root", async () => {
		const canonical = tempDir();
		const other = tempDir();
		const hostile = skill({ name: "../../../etc/evil", author: "../../root", body: "PWNED" });
		const client = createFakeSkillPullClient({ skills: [hostile] });

		const outcome = await pull({ client, roots: roots(canonical, [other]) });

		// The dir name is reduced to a single safe segment — no `/`, no `..` survives.
		const dirName = canonicalDirName("../../../etc/evil", "../../root");
		expect(dirName).not.toContain("/");
		expect(dirName).not.toContain("..");
		expect(dirName).not.toContain("\\");
		// The file landed STRICTLY under the canonical root (a join with the sanitized segment).
		const expectedFile = join(canonical, dirName, "SKILL.md");
		expect(existsSync(expectedFile)).toBe(true);
		expect(outcome.skillsWritten).toBe(1);
		// Nothing was written outside the root (no `/etc/evil` style escape).
		expect(existsSync(join(canonical, "..", "..", "..", "etc", "evil"))).toBe(false);
	});

	it("path safety: a pure-dots name segment is neutralized (cannot become a `..` traversal)", () => {
		expect(canonicalDirName("..", "x")).not.toContain("..");
		expect(canonicalDirName(".", "x").startsWith(".--")).toBe(false);
	});
});
