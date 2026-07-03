/**
 * PRD-019b per-turn capture suite — b-AC-1, b-AC-2, index AC-2 (FR-4 / FR-7).
 *
 * The whole core is driven against the RECORDING FAKES (`createFakeDaemonHookClient`,
 * `createFakeCredentialReader`, `createFakeContextRenderer`) — no daemon, no DeepLake,
 * no real home directory. Each test is named after the AC it proves so the ledger maps
 * one-to-one to a passing test.
 *
 * Thin-client invariant (b-AC-2): the only outbound path is the daemon seam. A test
 * asserts the daemon was reached ONLY through `fake.calls`, that the body is the
 * normalized `{ event, metadata }` envelope, and that the runtime-path header rode
 * along — and that NO module here built SQL or held a DeepLake handle (enforced
 * structurally by `tests/daemon/storage/invariant.test.ts`).
 */

import { describe, expect, it } from "vitest";

import {
	createFakeContextRenderer,
	createFakeCredentialReader,
	createFakeDaemonHookClient,
	type HookCoreDeps,
	type HookInput,
} from "../../../src/hooks/shared/contracts.js";
import { buildCaptureBody, runCapture, runCaptureBatch } from "../../../src/hooks/shared/capture.js";

/** Build a core-deps bundle wired to a recording daemon fake. */
function deps(daemon = createFakeDaemonHookClient()): {
	deps: HookCoreDeps;
	daemon: ReturnType<typeof createFakeDaemonHookClient>;
} {
	const fake = daemon;
	return {
		daemon: fake,
		deps: {
			daemon: fake,
			credentials: createFakeCredentialReader({ token: "tok", org: "acme", actor: "u1" }),
			context: createFakeContextRenderer(""),
		},
	};
}

/** A normalized `user_message` capture input. */
function userMessage(text: string, over: Partial<HookInput> = {}): HookInput {
	return {
		event: "user_message",
		meta: { sessionId: "sess-1", path: "conv-1", agent: "claude-code" },
		data: { kind: "user_message", text },
		runtimePath: "legacy",
		...over,
	};
}

describe("PRD-019b capture core", () => {
	it("b-AC-2: reads creds + normalizes + makes a local daemon request, no DeepLake/SQL", async () => {
		const { deps: d, daemon } = deps();
		const result = await runCapture(userMessage("hello"), d, {});

		expect(result.ok).toBe(true);
		// Reached the daemon EXACTLY once, through the seam (the only outbound path).
		expect(daemon.calls).toHaveLength(1);
		const call = daemon.calls[0];
		expect(call.endpoint).toBe("capture");
		// Normalized `{ event, metadata }` envelope — the daemon's CaptureRequest shape.
		expect(call.body).toEqual({
			event: { kind: "user_message", text: "hello" },
			metadata: { sessionId: "sess-1", path: "conv-1", agent: "claude-code" },
		});
		// Runtime-path header rides along (FR-8).
		expect(call.runtimePath).toBe("legacy");
	});

	it("b-AC-2: the capture gate short-circuits — when disabled, NO daemon call is made", async () => {
		const { deps: d, daemon } = deps();
		const result = await runCapture(userMessage("hello"), d, { captureFlag: "false" });

		expect(result.ok).toBe(true);
		expect(result.reason).toBe("bypass");
		// c-AC-6: gate skip → no daemon request, no sessions row.
		expect(daemon.calls).toEqual([]);
	});

	it("index AC-2: native event → normalized shape → /api/hooks/capture with runtime-path", async () => {
		const { deps: d, daemon } = deps();
		const toolCall: HookInput = {
			event: "tool_call",
			meta: { sessionId: "s", path: "p", hookEventName: "PostToolUse", agentId: "a" },
			data: { kind: "tool_call", tool: "Bash", input: { command: "ls" }, response: "out" },
			messageEmbedding: [0.1, 0.2, 0.3],
			runtimePath: "plugin",
		};
		await runCapture(toolCall, d, {});

		expect(daemon.calls).toHaveLength(1);
		const body = daemon.calls[0].body as { event: unknown; metadata: Record<string, unknown> };
		expect(body.event).toEqual({ kind: "tool_call", tool: "Bash", input: { command: "ls" }, response: "out" });
		// The optional embedding rides on the metadata (FR-4).
		expect(body.metadata.messageEmbedding).toEqual([0.1, 0.2, 0.3]);
		expect(daemon.calls[0].runtimePath).toBe("plugin");
	});

	it("b-AC-1: batched-at-end produces the SAME daemon rows as incremental", async () => {
		// Incremental: three separate captures.
		const inc = deps();
		await runCapture(userMessage("one"), inc.deps, {});
		await runCapture(
			{ ...userMessage("two"), event: "tool_call", data: { kind: "tool_call", tool: "Read" } },
			inc.deps,
			{},
		);
		await runCapture(
			{ ...userMessage("three"), event: "assistant_message", data: { kind: "assistant_message", text: "three" } },
			inc.deps,
			{},
		);

		// Batched: one flush of the same three events at session end.
		const batch = deps();
		const slice: HookInput[] = [
			userMessage("one"),
			{ ...userMessage("two"), event: "tool_call", data: { kind: "tool_call", tool: "Read" } },
			{ ...userMessage("three"), event: "assistant_message", data: { kind: "assistant_message", text: "three" } },
		];
		const results = await runCaptureBatch(slice, batch.deps, {});

		// Same number of daemon writes, same endpoint, same bodies, same order.
		expect(batch.daemon.calls).toHaveLength(3);
		expect(batch.daemon.calls.map((c) => c.endpoint)).toEqual(["capture", "capture", "capture"]);
		expect(batch.daemon.calls.map((c) => c.body)).toEqual(inc.daemon.calls.map((c) => c.body));
		expect(results.every((r) => r.ok)).toBe(true);
	});

	it("b-AC-1: a partial-vocabulary batch still skips entirely when the gate is off", async () => {
		const batch = deps();
		const results = await runCaptureBatch([userMessage("a"), userMessage("b")], batch.deps, { captureFlag: "false" });
		expect(batch.daemon.calls).toEqual([]);
		expect(results.map((r) => r.reason)).toEqual(["bypass", "bypass"]);
	});

	it("buildCaptureBody forwards data verbatim and only includes embedding when present", () => {
		const without = buildCaptureBody(userMessage("x"));
		expect(without).toEqual({
			event: { kind: "user_message", text: "x" },
			metadata: { sessionId: "sess-1", path: "conv-1", agent: "claude-code" },
		});
		const withEmbed = buildCaptureBody({ ...userMessage("x"), messageEmbedding: [1, 2] });
		expect((withEmbed as { metadata: Record<string, unknown> }).metadata.messageEmbedding).toEqual([1, 2]);
	});

	it("fail-soft: a rejecting daemon never throws out of capture (turn proceeds)", async () => {
		const throwing = {
			calls: [] as unknown[],
			async send(): Promise<never> {
				throw new Error("daemon down");
			},
		};
		const d: HookCoreDeps = {
			daemon: throwing as unknown as HookCoreDeps["daemon"],
			credentials: createFakeCredentialReader(),
			context: createFakeContextRenderer(),
		};
		// The gate wrapper swallows the throw; capture resolves (never rejects).
		const result = await runCapture(userMessage("hi"), d, {});
		expect(result.ok).toBe(true);
	});

	it("C-4: transport failure is observable (ok: false) but never throws out of capture", async () => {
		const transportDown = {
			calls: [] as unknown[],
			async send() {
				return { status: 0 as const };
			},
		};
		const d: HookCoreDeps = {
			daemon: transportDown as unknown as HookCoreDeps["daemon"],
			credentials: createFakeCredentialReader(),
			context: createFakeContextRenderer(),
		};
		const result = await runCapture(userMessage("hi"), d, {});
		expect(result.ok).toBe(false);
		expect(result.reason).toBe("transport-failure");
	});
});
