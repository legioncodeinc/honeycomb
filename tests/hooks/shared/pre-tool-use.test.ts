/**
 * PRD-019b pre-tool-use VFS-intercept suite — b-AC-4 (FR-5).
 *
 * Driven against `createFakeVfsIntercept` — a recording double that answers from a
 * fixed body and RECORDS every op. There is NO `node:fs` path in the fake or the
 * core, so a passing test proves nothing reached the real filesystem (b-AC-4): the
 * ONLY route to memory content is the seam.
 */

import { describe, expect, it } from "vitest";

import {
	createFakeContextRenderer,
	createFakeCredentialReader,
	createFakeDaemonHookClient,
	createFakeVfsIntercept,
	type HookCoreDeps,
	type HookInput,
} from "../../../src/hooks/shared/contracts.js";
import { runPreToolUse } from "../../../src/hooks/shared/pre-tool-use.js";

const CORE: HookCoreDeps = {
	daemon: createFakeDaemonHookClient(),
	credentials: createFakeCredentialReader(),
	context: createFakeContextRenderer(),
};

function preTool(data: unknown): HookInput {
	return { event: "pre-tool-use", meta: { sessionId: "s", path: "p" }, data, runtimePath: "plugin" };
}

describe("PRD-019b pre-tool-use VFS intercept", () => {
	it("b-AC-4: a Bash grep on the memory path → daemon hybrid search, nothing hits the real FS", async () => {
		const vfs = createFakeVfsIntercept({ content: "hybrid-search-result" });
		const { result, decision } = await runPreToolUse(
			preTool({
				tool: "Bash",
				command: "grep -r needle ~/.honeycomb/memory/",
				query: "needle",
				path: "~/.honeycomb/memory/",
			}),
			CORE,
			vfs,
		);

		// The output is the daemon's resolved content (the hybrid search), not the FS.
		expect(decision).toEqual({ kind: "replace", output: "hybrid-search-result" });
		expect(result.additionalContext).toBe("hybrid-search-result");
		// It was lowered to a `search` op against the mount — the ONLY route to content.
		expect(vfs.ops).toHaveLength(1);
		expect(vfs.ops[0].verb).toBe("search");
	});

	it("b-AC-4: a Grep tool on the mount lowers to a search op", async () => {
		const vfs = createFakeVfsIntercept({ content: "rows" });
		const { decision } = await runPreToolUse(
			preTool({ tool: "Grep", path: "goal/u/opened/g1.md", query: "x" }),
			CORE,
			vfs,
		);
		expect(decision).toEqual({ kind: "replace", output: "rows" });
		expect(vfs.ops[0].verb).toBe("search");
	});

	it("b-AC-4: a Read/cat on the mount lowers to a read op", async () => {
		const vfs = createFakeVfsIntercept({ content: "summary text" });
		const { decision } = await runPreToolUse(preTool({ tool: "Read", path: "memory/notes.md" }), CORE, vfs);
		expect(decision).toEqual({ kind: "replace", output: "summary text" });
		expect(vfs.ops[0].verb).toBe("read");
	});

	it("FR-5: a Write/Edit on the mount is DENIED with guidance — never resolved", async () => {
		const vfs = createFakeVfsIntercept();
		const { result, decision } = await runPreToolUse(preTool({ tool: "Write", path: "memory/x.md" }), CORE, vfs);
		expect(decision.kind).toBe("deny");
		expect((decision as { guidance: string }).guidance).toMatch(/read-through|denied/i);
		expect(result.ok).toBe(false);
		// A denied write never reaches the VFS seam (and never the FS).
		expect(vfs.ops).toEqual([]);
	});

	it("FR-5: an unmodelable Bash command on the mount is rewritten to a harmless echo", async () => {
		const vfs = createFakeVfsIntercept();
		const { decision } = await runPreToolUse(
			preTool({ tool: "Bash", command: "chmod 777 ~/.honeycomb/memory/x.md", path: "~/.honeycomb/memory/x.md" }),
			CORE,
			vfs,
		);
		expect(decision.kind).toBe("rewrite");
		expect((decision as { command: string }).command).toMatch(/^echo /);
		expect(vfs.ops).toEqual([]);
	});

	it("FR-5: a tool NOT on the memory mount passes through untouched (allow)", async () => {
		const vfs = createFakeVfsIntercept({ content: "should-not-appear" });
		const { result, decision } = await runPreToolUse(
			preTool({ tool: "Bash", command: "cat /etc/hosts", path: "/etc/hosts" }),
			CORE,
			vfs,
		);
		expect(decision).toEqual({ kind: "allow" });
		expect(result.ok).toBe(true);
		// An off-mount op never touches the VFS seam.
		expect(vfs.ops).toEqual([]);
	});

	it("FR-5: ls on the mount lowers to a list op; find lowers to a find op", async () => {
		const ls = createFakeVfsIntercept({ content: "a\nb" });
		await runPreToolUse(preTool({ tool: "Bash", command: "ls memory/", path: "memory/" }), CORE, ls);
		expect(ls.ops[0].verb).toBe("list");

		const find = createFakeVfsIntercept({ content: "match" });
		await runPreToolUse(
			preTool({ tool: "Bash", command: "find memory/ -name '*.md'", path: "memory/", query: "*.md" }),
			CORE,
			find,
		);
		expect(find.ops[0].verb).toBe("find");
	});

	it("an unparseable payload passes through as allow (never an FS touch)", async () => {
		const vfs = createFakeVfsIntercept();
		const { decision } = await runPreToolUse(preTool(undefined), CORE, vfs);
		expect(decision).toEqual({ kind: "allow" });
		expect(vfs.ops).toEqual([]);
	});

	// ── PRD-075c: the `honeycomb recall` / `honeycomb search` Bash sentinel (c-AC-4..c-AC-6) ──

	it('c-AC-4: `honeycomb recall "<query>"` maps to the search verb, extracts the quoted query, and resolves the path to the mount root', async () => {
		const vfs = createFakeVfsIntercept({ content: "recall-hit" });
		const { result, decision } = await runPreToolUse(
			preTool({ tool: "Bash", command: 'honeycomb recall "what did we decide about auth"' }),
			CORE,
			vfs,
		);

		expect(decision).toEqual({ kind: "replace", output: "recall-hit" });
		expect(result.additionalContext).toBe("recall-hit");
		expect(vfs.ops).toHaveLength(1);
		expect(vfs.ops[0]).toEqual({
			verb: "search",
			path: "~/.apiary/honeycomb/memory/",
			query: "what did we decide about auth",
		});
	});

	it('c-AC-4: `honeycomb search "<query>"` (the alias spelling) maps to the search verb the same way', async () => {
		const vfs = createFakeVfsIntercept({ content: "search-hit" });
		const { decision } = await runPreToolUse(
			preTool({ tool: "Bash", command: 'honeycomb search "onboarding flow"' }),
			CORE,
			vfs,
		);

		expect(decision).toEqual({ kind: "replace", output: "search-hit" });
		expect(vfs.ops[0]).toMatchObject({ verb: "search", query: "onboarding flow" });
	});

	it("c-AC-4: the sentinel also recognizes a single-quoted query argument", async () => {
		const vfs = createFakeVfsIntercept({ content: "hit" });
		const { decision } = await runPreToolUse(
			preTool({ tool: "Bash", command: "honeycomb recall 'prior decision'" }),
			CORE,
			vfs,
		);

		expect(decision).toEqual({ kind: "replace", output: "hit" });
		expect(vfs.ops[0]).toMatchObject({ verb: "search", query: "prior decision" });
	});

	it("c-AC-5: the sentinel resolves through the SAME VFS intercept as a mount Grep and blocks the real command, no real execution", async () => {
		// `createFakeVfsIntercept` is a pure recording double with NO `node:fs`/`node:child_process`
		// path (see this module's own header comment); the ONLY way `decision` becomes `replace`
		// with THIS fake's `content` is via `resolvedVfs.resolve`, so a passing assertion proves the
		// literal `honeycomb recall "needle"` shell command was intercepted, never actually spawned.
		const vfs = createFakeVfsIntercept({ content: "faked-daemon-output" });

		const { decision, result } = await runPreToolUse(
			preTool({ tool: "Bash", command: 'honeycomb recall "needle"' }),
			CORE,
			vfs,
		);

		expect(decision).toEqual({ kind: "replace", output: "faked-daemon-output" });
		expect(result.ok).toBe(true);
		// Resolved exactly once, through the intercept: the same seam a mount `Grep` uses (075a).
		expect(vfs.ops).toEqual([{ verb: "search", path: "~/.apiary/honeycomb/memory/", query: "needle" }]);
	});

	it("c-AC-6 (regression): the raw mount `Grep` fallback still works unchanged", async () => {
		const vfs = createFakeVfsIntercept({ content: "raw-grep-hit" });
		const { decision } = await runPreToolUse(
			preTool({ tool: "Grep", path: "goal/u/opened/g1.md", query: "x" }),
			CORE,
			vfs,
		);
		expect(decision).toEqual({ kind: "replace", output: "raw-grep-hit" });
		expect(vfs.ops[0].verb).toBe("search");
	});

	it("c-AC-6 (regression): the raw mount Bash `cat` fallback still works unchanged", async () => {
		const vfs = createFakeVfsIntercept({ content: "raw-cat-hit" });
		const { decision } = await runPreToolUse(
			preTool({ tool: "Bash", command: "cat ~/.honeycomb/memory/notes.md", path: "~/.honeycomb/memory/notes.md" }),
			CORE,
			vfs,
		);
		expect(decision).toEqual({ kind: "replace", output: "raw-cat-hit" });
		expect(vfs.ops[0].verb).toBe("read");
	});

	it("c-AC-6 (regression): an unrelated `honeycomb <subcommand>` Bash line is NOT captured by the sentinel (off-mount allow)", async () => {
		const vfs = createFakeVfsIntercept({ content: "should-not-appear" });
		const { decision } = await runPreToolUse(preTool({ tool: "Bash", command: "honeycomb project bind" }), CORE, vfs);
		expect(decision).toEqual({ kind: "allow" });
		expect(vfs.ops).toEqual([]);
	});
});
