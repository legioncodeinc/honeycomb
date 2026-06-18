/**
 * PRD-016c `honeycomb skillify pull` CLI — proves the c-AC-1 / c-AC-6 command surface.
 *
 * Drives `runSkillifyCommand` / `skillifyMain` against a FAKE pull-client + temp agent
 * roots + a capturing output sink — so the test asserts the command writes the canonical
 * SKILL.md + fans out symlinks and prints the outcome, WITHOUT a daemon or a real `~/.claude`.
 * The CLI imports no storage path (the thin-client invariant covers `src/cli`).
 */

import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
	type AgentRootDetector,
	canonicalDirName,
	createFakeSkillPullClient,
	type PulledSkill,
} from "../../src/daemon-client/skillify/index.js";
import { parseSkillifyArgs, runSkillifyCommand, skillifyMain } from "../../src/cli/skillify.js";

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "skillify-cli-"));
}

function skill(over: Partial<PulledSkill> = {}): PulledSkill {
	return {
		name: "tidy-imports",
		author: "alice",
		version: 1,
		body: "---\nname: tidy-imports\nversion: 1\n---\n\n## Tidy imports\n",
		...over,
	};
}

function roots(canonical: string, others: readonly string[]): AgentRootDetector {
	return { canonicalRoot: () => canonical, otherRoots: () => others };
}

describe("PRD-016c skillify CLI", () => {
	it("parseSkillifyArgs extracts the verb", () => {
		expect(parseSkillifyArgs(["pull"]).verb).toBe("pull");
		expect(parseSkillifyArgs(["--flag", "pull"]).verb).toBe("pull");
		expect(parseSkillifyArgs([]).verb).toBe("");
	});

	it("c-AC-1 `skillify pull` writes the canonical SKILL.md, fans out symlinks, and reports the outcome", async () => {
		const canonical = tempDir();
		const other = tempDir();
		const lines: string[] = [];
		const client = createFakeSkillPullClient({ skills: [skill()] });

		const result = await skillifyMain(["pull"], {
			client,
			roots: roots(canonical, [other]),
			out: (l) => lines.push(l),
		});

		expect(result.exitCode).toBe(0);
		expect(result.outcome?.skillsWritten).toBe(1);
		expect(result.outcome?.symlinksCreated).toBe(1);
		expect(existsSync(join(canonical, canonicalDirName("tidy-imports", "alice"), "SKILL.md"))).toBe(true);
		expect(readFileSync(join(canonical, canonicalDirName("tidy-imports", "alice"), "SKILL.md"), "utf-8")).toContain(
			"## Tidy imports",
		);
		expect(lines.join("\n")).toMatch(/Pulled 1 skill/);
	});

	it("c-AC-6 the pull reaches the store ONLY through the injected client seam", async () => {
		const lines: string[] = [];
		const client = createFakeSkillPullClient({ skills: [skill()] });

		await runSkillifyCommand({ verb: "pull" }, { client, roots: roots(tempDir(), []), out: (l) => lines.push(l) });

		// The CLI's only storage path is the injected pull client.
		expect(client.calls.count).toBe(1);
	});

	it("an unknown verb prints usage and exits non-zero", async () => {
		const lines: string[] = [];
		const client = createFakeSkillPullClient({ skills: [] });

		const result = await runSkillifyCommand(
			{ verb: "frobnicate" },
			{ client, roots: roots(tempDir(), []), out: (l) => lines.push(l) },
		);

		expect(result.exitCode).toBe(1);
		expect(result.outcome).toBeNull();
		expect(lines.join("\n")).toMatch(/usage: honeycomb skillify pull/);
		// Usage path never queried the store.
		expect(client.calls.count).toBe(0);
	});

	it("no verb (bare `skillify`) prints usage and exits 0", async () => {
		const lines: string[] = [];
		const client = createFakeSkillPullClient({ skills: [] });

		const result = await runSkillifyCommand(
			{ verb: "" },
			{ client, roots: roots(tempDir(), []), out: (l) => lines.push(l) },
		);

		expect(result.exitCode).toBe(0);
		expect(lines.join("\n")).toMatch(/usage/);
	});
});
