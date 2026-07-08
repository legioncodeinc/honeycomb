/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

/**
 * PRD-075a — live the PreToolUse recall path (a-AC-1..a-AC-6).
 *
 * Connects the two runtime breakpoints that kept the `PreToolUse` recall surface
 * inert: (1) the runtime used to resolve mount ops through the FAKE VFS regardless
 * of `deps`, and (2) it DISCARDED the `PreToolDecision`. This suite proves both are
 * fixed:
 *   - a-AC-1: `HookCoreDeps` carries a real, non-fake `vfs` seam, constructed at the
 *     runtime's dependency-construction site (`createHookRuntime`), reaching the
 *     daemon over a REAL loopback `fetch`.
 *   - a-AC-2: `runPreToolUse` resolves mount ops through `deps.vfs` (no longer
 *     `void _deps`) — a recording double observes the exact `VfsToolOp`.
 *   - a-AC-3: the `pre-tool-use` dispatch branch propagates the `PreToolDecision`
 *     onto the runtime's `HookEventOutcome`.
 *   - a-AC-4: an off-mount op makes NO `deps.vfs` call (a throwing double proves it).
 *   - a-AC-5: a throwing/rejecting `vfs.resolve` is absorbed fail-soft — no throw
 *     escapes `dispatchLifecycle`, and the outcome carries no `replace` decision.
 *   - a-AC-6: session-start / session-end / capture outcomes never carry a `decision`.
 */

import { describe, expect, it } from "vitest";

import { createClaudeCodeShim } from "../../../../src/hooks/claude-code/shim.js";
import { createHookRuntime } from "../../../../src/hooks/runtime.js";
import {
	createFakeContextRenderer,
	createFakeCredentialReader,
	createFakeDaemonHookClient,
	createFakePrimeRenderer,
	createFakeVfsIntercept,
	type HookCoreDeps,
	type HookInput,
	type HookSessionMeta,
	type RecordedVfsOp,
	type VfsIntercept,
	type VfsToolOp,
} from "../../../../src/hooks/shared/contracts.js";
import { runPreToolUse } from "../../../../src/hooks/shared/pre-tool-use.js";
import type { NotificationsPipeline } from "../../../../src/notifications/index.js";

const META: HookSessionMeta = { sessionId: "sess-075a", cwd: "/repo/honeycomb", agent: "claude-code" };

/** A CORE `HookCoreDeps` with no `vfs` field — the isolated-unit-test baseline (a-AC-2/4/5). */
function coreDeps(vfs?: VfsIntercept): HookCoreDeps {
	return {
		daemon: createFakeDaemonHookClient(),
		credentials: createFakeCredentialReader(),
		context: createFakeContextRenderer(),
		...(vfs !== undefined ? { vfs } : {}),
	};
}

function preTool(data: unknown): HookInput {
	return { event: "pre-tool-use", meta: META, data, runtimePath: "plugin" };
}

/** A no-op notifications pipeline so runtime-level tests never touch a real daemon drain. */
const NOOP_NOTIFICATIONS: NotificationsPipeline = {
	async drain() {
		return { banner: null, suppressed: [] };
	},
};

describe("a-AC-1: HookCoreDeps gains a real vfs seam, wired at the runtime's dependency-construction site", () => {
	it("runtime.deps.vfs is defined and is NOT the isolated-test fake shape", () => {
		const runtime = createHookRuntime({ daemon: createFakeDaemonHookClient() });
		expect(runtime.deps.vfs).toBeDefined();
		// The fake exposes `.ops` (its audit trail); the real seam never does.
		expect(runtime.deps.vfs !== undefined && "ops" in runtime.deps.vfs).toBe(false);
	});

	it("the real vfs resolves through an ACTUAL loopback fetch against the daemon's /memory routes", async () => {
		const requests: { url: string; headers: Record<string, string> } = { url: "", headers: {} };
		const fakeFetch = (async (url: unknown, init?: RequestInit) => {
			requests.url = String(url);
			requests.headers = (init?.headers ?? {}) as Record<string, string>;
			return new Response(JSON.stringify({ path: "memory/x.md", found: true, content: "resolved-by-daemon" }), {
				status: 200,
			});
		}) as unknown as typeof fetch;
		const runtime = createHookRuntime({
			daemon: createFakeDaemonHookClient(),
			fetch: fakeFetch,
			host: "127.0.0.1",
			port: 3850,
		});

		const output = await runtime.deps.vfs?.resolve({ verb: "read", path: "memory/x.md" });

		expect(output).toBe("resolved-by-daemon");
		expect(requests.url).toContain("http://127.0.0.1:3850/memory/cat?path=");
		expect(requests.headers["x-honeycomb-runtime-path"]).toBe("plugin");
		expect(requests.headers["x-honeycomb-session"]).toBeTruthy();
	});
});

describe("a-AC-2: runPreToolUse resolves mount ops through deps.vfs (no longer void _deps)", () => {
	it("a-AC-2: a recording vfs injected through deps observes the exact VfsToolOp, and its output becomes the replace decision's output", async () => {
		const ops: RecordedVfsOp[] = [];
		const recording: VfsIntercept = {
			async resolve(op: VfsToolOp): Promise<string> {
				ops.push({ verb: op.verb, path: op.path, query: op.query });
				return "via-deps-vfs";
			},
		};

		const { result, decision } = await runPreToolUse(
			preTool({ tool: "Grep", path: "memory/notes.md", query: "needle" }),
			coreDeps(recording),
		);

		expect(ops).toEqual([{ verb: "search", path: "memory/notes.md", query: "needle" }]);
		expect(decision).toEqual({ kind: "replace", output: "via-deps-vfs" });
		expect(result.additionalContext).toBe("via-deps-vfs");
	});

	it("a-AC-2: deps.vfs wins over the function-parameter fallback when BOTH are supplied", async () => {
		const viaDeps: VfsIntercept = {
			async resolve() {
				return "from-deps";
			},
		};
		const viaParam = createFakeVfsIntercept({ content: "from-param" });

		const { decision } = await runPreToolUse(
			preTool({ tool: "Read", path: "memory/x.md" }),
			coreDeps(viaDeps),
			viaParam,
		);

		expect(decision).toEqual({ kind: "replace", output: "from-deps" });
		// The parameter fallback was never touched — deps.vfs took precedence.
		expect(viaParam.ops).toEqual([]);
	});

	it("a-AC-2: with NO deps.vfs at all, the isolated-test parameter default still resolves the op", async () => {
		const viaParam = createFakeVfsIntercept({ content: "from-param-only" });

		const { decision } = await runPreToolUse(preTool({ tool: "Read", path: "memory/x.md" }), coreDeps(), viaParam);

		expect(decision).toEqual({ kind: "replace", output: "from-param-only" });
		expect(viaParam.ops).toHaveLength(1);
	});
});

describe("a-AC-3: the pre-tool-use dispatch branch returns { result, decision } on the runtime outcome", () => {
	it("a-AC-3: a mount Grep yields a replace decision on the runtime outcome", async () => {
		const vfs = createFakeVfsIntercept({ content: "hit" });
		const runtime = createHookRuntime({ daemon: createFakeDaemonHookClient(), notifications: NOOP_NOTIFICATIONS, vfs });

		const outcome = await runtime.runEvent(
			createClaudeCodeShim(),
			{ name: "PreToolUse", payload: { tool_name: "Grep", tool_input: { path: "memory/x.md", pattern: "y" } } },
			META,
		);

		expect(outcome.decision).toEqual({ kind: "replace", output: "hit" });
		expect(outcome.result.additionalContext).toBe("hit");
	});

	it("a-AC-3: an off-mount op yields an allow decision on the runtime outcome", async () => {
		const vfs = createFakeVfsIntercept({ content: "should-not-appear" });
		const runtime = createHookRuntime({ daemon: createFakeDaemonHookClient(), notifications: NOOP_NOTIFICATIONS, vfs });

		const outcome = await runtime.runEvent(
			createClaudeCodeShim(),
			{ name: "PreToolUse", payload: { tool_name: "Bash", tool_input: { command: "cat /etc/hosts" } } },
			META,
		);

		expect(outcome.decision).toEqual({ kind: "allow" });
	});
});

describe("a-AC-4: off-mount pass-through is unchanged — no deps.vfs call for a non-mount op", () => {
	it("a-AC-4: a throwing vfs double is never invoked for `cat /etc/hosts`", async () => {
		const throwing: VfsIntercept = {
			async resolve(): Promise<string> {
				throw new Error("must never be called for an off-mount op");
			},
		};

		const { result, decision } = await runPreToolUse(
			preTool({ tool: "Bash", command: "cat /etc/hosts", path: "/etc/hosts" }),
			coreDeps(throwing),
		);

		expect(decision).toEqual({ kind: "allow" });
		expect(result.ok).toBe(true);
	});

	it("a-AC-4: the SAME throwing double never fires at the runtime level either", async () => {
		const throwing: VfsIntercept = {
			async resolve(): Promise<string> {
				throw new Error("must never be called for an off-mount op");
			},
		};
		const runtime = createHookRuntime({
			daemon: createFakeDaemonHookClient(),
			notifications: NOOP_NOTIFICATIONS,
			vfs: throwing,
		});

		const outcome = await runtime.runEvent(
			createClaudeCodeShim(),
			{ name: "PreToolUse", payload: { tool_name: "Bash", tool_input: { command: "cat /etc/hosts" } } },
			META,
		);

		expect(outcome.decision).toEqual({ kind: "allow" });
	});
});

describe("a-AC-5: fail-soft holds — a throwing/rejecting vfs.resolve never escapes as a throw", () => {
	it("a-AC-5: runPreToolUse itself propagates the rejection (the ABSORB happens one level up, in dispatchLifecycle)", async () => {
		const rejecting: VfsIntercept = {
			async resolve(): Promise<string> {
				throw new Error("daemon unreachable");
			},
		};

		await expect(runPreToolUse(preTool({ tool: "Read", path: "memory/x.md" }), coreDeps(rejecting))).rejects.toThrow(
			"daemon unreachable",
		);
	});

	it("a-AC-5: the runtime absorbs the rejection fail-soft — no throw escapes, no replace decision, the turn proceeds", async () => {
		const rejecting: VfsIntercept = {
			async resolve(): Promise<string> {
				throw new Error("daemon unreachable");
			},
		};
		const runtime = createHookRuntime({
			daemon: createFakeDaemonHookClient(),
			notifications: NOOP_NOTIFICATIONS,
			vfs: rejecting,
		});

		const outcome = await runtime.runEvent(
			createClaudeCodeShim(),
			{ name: "PreToolUse", payload: { tool_name: "Grep", tool_input: { path: "memory/x.md", pattern: "y" } } },
			META,
		);

		expect(outcome.result.ok).toBe(false);
		expect(outcome.result.reason).toBe("daemon unreachable");
		expect(outcome.decision).toBeUndefined();
	});

	it("a-AC-5: a TIMED-OUT (never-resolving-in-time) vfs is absorbed the same way, via an AbortError rejection", async () => {
		const timingOut: VfsIntercept = {
			resolve(): Promise<string> {
				return new Promise((_resolve, reject) => {
					// Simulate the AbortController-driven timeout the production seam applies —
					// a hung daemon rejects rather than hanging the turn.
					reject(new DOMException("The operation was aborted.", "AbortError"));
				});
			},
		};
		const runtime = createHookRuntime({
			daemon: createFakeDaemonHookClient(),
			notifications: NOOP_NOTIFICATIONS,
			vfs: timingOut,
		});

		const outcome = await runtime.runEvent(
			createClaudeCodeShim(),
			{ name: "PreToolUse", payload: { tool_name: "Read", tool_input: { file_path: "memory/x.md" } } },
			META,
		);

		expect(outcome.result.ok).toBe(false);
		expect(outcome.decision).toBeUndefined();
	});
});

describe("a-AC-6: no behavioral change to session-start / session-end / capture — their outcomes never carry a decision", () => {
	it("a-AC-6: session-start's outcome has no decision field", async () => {
		const runtime = createHookRuntime({
			daemon: createFakeDaemonHookClient({ status: 200, body: { additionalContext: "" } }),
			notifications: NOOP_NOTIFICATIONS,
			prime: createFakePrimeRenderer(""),
		});

		const outcome = await runtime.runEvent(
			createClaudeCodeShim(),
			{ name: "SessionStart", payload: { source: "startup" } },
			META,
		);

		expect(outcome.decision).toBeUndefined();
	});

	it("a-AC-6: a capture (UserPromptSubmit) outcome has no decision field", async () => {
		const runtime = createHookRuntime({ daemon: createFakeDaemonHookClient(), notifications: NOOP_NOTIFICATIONS });

		const outcome = await runtime.runEvent(
			createClaudeCodeShim(),
			{ name: "UserPromptSubmit", payload: { prompt: "hi" } },
			META,
		);

		expect(outcome.decision).toBeUndefined();
	});

	it("a-AC-6: a session-end outcome has no decision field", async () => {
		const runtime = createHookRuntime({ daemon: createFakeDaemonHookClient(), notifications: NOOP_NOTIFICATIONS });

		const outcome = await runtime.runEvent(
			createClaudeCodeShim(),
			{ name: "SessionEnd", payload: { reason: "exit" } },
			META,
		);

		expect(outcome.decision).toBeUndefined();
	});
});
