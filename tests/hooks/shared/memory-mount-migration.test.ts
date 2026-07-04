/**
 * PRD-072b US-072b.3 — the agent-facing memory-mount path convention across the ADR-0003 move.
 *
 * Dual recognition: BOTH the new `~/.apiary/honeycomb/memory/...` shape and the legacy
 * `~/.honeycomb/memory/...` shape resolve to the mount (AC-072b.3.1), while the generated index
 * overview emits the NEW path so fresh reads point agents at the new location (AC-072b.3.2).
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
import { classifyPath } from "../../../src/daemon-client/vfs/classify.js";
import type { DaemonDispatch, Row, VfsScope } from "../../../src/daemon-client/vfs/contracts.js";
import { generateVirtualIndex, MEMORY_MOUNT_DISPLAY_PATH } from "../../../src/daemon-client/vfs/index-gen.js";

const CORE: HookCoreDeps = {
	daemon: createFakeDaemonHookClient(),
	credentials: createFakeCredentialReader(),
	context: createFakeContextRenderer(),
};

function preTool(data: unknown): HookInput {
	return { event: "pre-tool-use", meta: { sessionId: "s", path: "p" }, data, runtimePath: "plugin" };
}

describe("PRD-072b AC-072b.3.1 — dual recognition of the new and legacy mount shapes", () => {
	it("AC-072b.3.1 classifyPath maps BOTH host-absolute shapes to the same mount kind", () => {
		expect(classifyPath("/home/ada/.honeycomb/memory/goal/ada/opened/g1.md")).toBe("goal");
		expect(classifyPath("/home/ada/.apiary/honeycomb/memory/goal/ada/opened/g1.md")).toBe("goal");
		expect(classifyPath("/home/ada/.honeycomb/memory/notes.md")).toBe("memory");
		expect(classifyPath("/home/ada/.apiary/honeycomb/memory/notes.md")).toBe("memory");
	});

	it("AC-072b.3.1 the pre-tool-use hook still intercepts a legacy `.honeycomb/memory` path", async () => {
		const vfs = createFakeVfsIntercept({ content: "summary text" });
		const { decision } = await runPreToolUse(
			preTool({ tool: "Read", path: "/home/ada/.honeycomb/memory/notes.md" }),
			CORE,
			vfs,
		);
		expect(decision).toEqual({ kind: "replace", output: "summary text" });
		expect(vfs.ops[0]?.verb).toBe("read");
	});

	it("AC-072b.3.1 the pre-tool-use hook intercepts the new `.apiary/honeycomb/memory` path shape", async () => {
		const vfs = createFakeVfsIntercept({ content: "summary text" });
		const { decision } = await runPreToolUse(
			preTool({ tool: "Read", path: "/home/ada/.apiary/honeycomb/memory/notes.md" }),
			CORE,
			vfs,
		);
		expect(decision).toEqual({ kind: "replace", output: "summary text" });
		expect(vfs.ops[0]?.verb).toBe("read");
	});

	it("a Windows backslash-separated mount path cannot bypass the gate (both shapes)", async () => {
		const vfs = createFakeVfsIntercept({ content: "summary text" });
		for (const path of [
			"C:\\Users\\ada\\.apiary\\honeycomb\\memory\\notes.md",
			"C:\\Users\\ada\\.honeycomb\\memory\\notes.md",
		]) {
			const { decision } = await runPreToolUse(preTool({ tool: "Read", path }), CORE, vfs);
			expect(decision.kind).toBe("replace");
		}
	});

	it("a case-varied Windows mount path cannot bypass the Write/Edit deny", async () => {
		// Windows paths are case-insensitive: `.APIARY\HONEYCOMB\MEMORY` names the same real directory,
		// so a case trick must still hit the deny (never fall through to the real filesystem).
		const { decision } = await runPreToolUse(
			preTool({ tool: "Write", path: "C:\\Users\\ada\\.APIARY\\Honeycomb\\MEMORY\\notes.md" }),
			CORE,
			createFakeVfsIntercept(),
		);
		expect(decision.kind).toBe("deny");
	});
});

describe("PRD-072b AC-072b.3.2 — the generated index overview emits the new mount path", () => {
	it("AC-072b.3.2 the virtual index body references `~/.apiary/honeycomb/memory/`", async () => {
		const dispatch: DaemonDispatch = {
			query: async (): Promise<Row[]> => [],
		};
		const body = await generateVirtualIndex(dispatch, {} as VfsScope);
		expect(MEMORY_MOUNT_DISPLAY_PATH).toBe("~/.apiary/honeycomb/memory/");
		expect(body).toContain(MEMORY_MOUNT_DISPLAY_PATH);
		// It does NOT steer agents at the legacy path in the fresh overview.
		expect(body).not.toContain("~/.honeycomb/memory/");
	});
});
