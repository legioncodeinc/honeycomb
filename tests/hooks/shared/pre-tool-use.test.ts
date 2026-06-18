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
			preTool({ tool: "Bash", command: "grep -r needle ~/.honeycomb/memory/", query: "needle", path: "~/.honeycomb/memory/" }),
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
		const { decision } = await runPreToolUse(preTool({ tool: "Grep", path: "goal/u/opened/g1.md", query: "x" }), CORE, vfs);
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
		const { decision } = await runPreToolUse(preTool({ tool: "Bash", command: "chmod 777 ~/.honeycomb/memory/x.md", path: "~/.honeycomb/memory/x.md" }), CORE, vfs);
		expect(decision.kind).toBe("rewrite");
		expect((decision as { command: string }).command).toMatch(/^echo /);
		expect(vfs.ops).toEqual([]);
	});

	it("FR-5: a tool NOT on the memory mount passes through untouched (allow)", async () => {
		const vfs = createFakeVfsIntercept({ content: "should-not-appear" });
		const { result, decision } = await runPreToolUse(preTool({ tool: "Bash", command: "cat /etc/hosts", path: "/etc/hosts" }), CORE, vfs);
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
		await runPreToolUse(preTool({ tool: "Bash", command: "find memory/ -name '*.md'", path: "memory/", query: "*.md" }), CORE, find);
		expect(find.ops[0].verb).toBe("find");
	});

	it("an unparseable payload passes through as allow (never an FS touch)", async () => {
		const vfs = createFakeVfsIntercept();
		const { decision } = await runPreToolUse(preTool(undefined), CORE, vfs);
		expect(decision).toEqual({ kind: "allow" });
		expect(vfs.ops).toEqual([]);
	});
});
