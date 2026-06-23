/**
 * Harness-identity stamping — the capture-attribution seam (fix/dashboard harness turns).
 *
 * The Harnesses page reads `turnsCaptured`/`active`/`lastSeen` from ONE GROUP BY over
 * `sessions.agent` (`harness-api.buildHarnessActivitySql`), indexed by the canonical
 * harness id. So a captured turn is attributed to its harness ONLY if the normalized
 * `HookInput.meta.agent` carries that harness's CANONICAL token — the same string the
 * shim's `.harness` field declares and `harness-registry.CANONICAL_SHIMS` derives the
 * six from. Before this fix every shim left `meta.agent` empty, so every captured turn
 * landed with `agent=""` and every harness read 0.
 *
 * This suite proves, ACROSS ALL SIX shims (parameterized so a seventh shim is covered
 * the moment it ships), that the normalized capture metadata stamps the harness's own
 * canonical token into `meta.agent`. It drives the REAL `create<Harness>Shim()` factories
 * over a native event each shim actually maps — the same engine the capture pipeline runs
 * — and asserts the stamp on the normalized output, which `buildCaptureBody` forwards
 * verbatim into the daemon's `metadata.agent` → the `sessions.agent` column. The stamp is
 * event-kind-independent (it rides every capture event a shim emits), so each shim is
 * driven with whatever event it maps (a `user_message` where it has one, else its
 * `session-end`) — what matters is `meta.agent`, not the event kind.
 *
 * It also pins the OpenClaw `agent` vs `agentId` separation: OpenClaw routes the per-USER
 * agent (`agent:alice:...` → `alice`) onto the ENGINE scope `agentId`, while `agent` stays
 * the canonical harness token `openclaw`. Conflating them (the prior bug) mis-attributed
 * OpenClaw's turns to a phantom `alice` harness and left `openclaw` reading 0.
 */

import { describe, expect, it } from "vitest";

import type { HarnessShim, NativeEvent } from "../../src/hooks/contracts.js";
import type { HookInput, HookSessionMeta } from "../../src/hooks/shared/contracts.js";
import {
	createClaudeCodeShim,
	createCodexShim,
	createCursorShim,
	createHermesShim,
	createOpenClawShim,
	createPiShim,
	openclawExpandBatch,
	OPENCLAW_HARNESS,
	type OpenClawMessage,
} from "../../src/hooks/index.js";

/** The canonical six tokens the Harnesses page GROUPs BY — the contract the stamp must hit. */
const THE_SIX = ["claude-code", "codex", "cursor", "hermes", "pi", "openclaw"] as const;

/** A base session metadata with NO `agent` set, so the assertion proves the SHIM stamped it. */
function baseMeta(over: Partial<HookSessionMeta> = {}): HookSessionMeta {
	return { sessionId: "sess-1", path: "conversations/sess-1", cwd: "/repo", ...over };
}

/**
 * One representative native event each shim ACTUALLY maps, with a superset payload that
 * satisfies its extractor. The event kind differs per harness (pi only fires session-end);
 * the stamp under test (`meta.agent`) is independent of the kind.
 */
const REPRESENTATIVE_EVENT: Readonly<Record<string, NativeEvent>> = {
	"claude-code": { name: "UserPromptSubmit", payload: { prompt: "find the bug" } },
	codex: { name: "UserPromptSubmit", payload: { prompt: "find the bug" } },
	cursor: { name: "beforeSubmitPrompt", payload: { prompt: "find the bug" } },
	hermes: { name: "on_user_message", payload: { prompt: "find the bug", text: "find the bug" } },
	pi: { name: "agent_end", payload: { reason: "session_shutdown" } },
};

/** The five hook-driven shims by canonical id (OpenClaw's capture path is batch-only, below). */
function hookShims(): Readonly<Record<string, HarnessShim>> {
	return {
		"claude-code": createClaudeCodeShim(),
		codex: createCodexShim(),
		cursor: createCursorShim(),
		hermes: createHermesShim(),
		pi: createPiShim(),
	};
}

describe("harness identity → sessions.agent: every shim stamps its OWN canonical token", () => {
	const shims = hookShims();

	it.each(Object.keys(REPRESENTATIVE_EVENT))(
		"%s normalizes a captured turn with meta.agent = its canonical token",
		(harness) => {
			const shim = shims[harness];
			expect(shim.harness, "the shim's declared id is the canonical token").toBe(harness);
			const input: HookInput | undefined = shim.normalize(REPRESENTATIVE_EVENT[harness], baseMeta());
			expect(input, `${harness} maps its representative event → a capture event`).toBeDefined();
			// THE FIX: the normalized capture metadata carries the harness's OWN canonical token,
			// not the empty string — so `buildCaptureBody` forwards it into `sessions.agent`.
			expect(input?.meta.agent).toBe(harness);
		},
	);

	it("OpenClaw's batch path stamps agent = 'openclaw' on every expanded message", () => {
		const messages: readonly OpenClawMessage[] = [
			{ role: "user", text: "find the bug" },
			{ role: "assistant", text: "on it" },
			{ role: "tool", tool: "Bash", input: { command: "ls" }, response: "ok" },
		];
		// A namespaced session key routes the per-USER agent → `agentId` (engine scope), NOT `agent`.
		const inputs = openclawExpandBatch(messages, baseMeta({ sessionId: "agent:alice:sess-9" }));
		expect(inputs).toHaveLength(3);
		for (const input of inputs) {
			// `agent` is the canonical HARNESS token (what the page counts) …
			expect(input.meta.agent).toBe(OPENCLAW_HARNESS);
			expect(input.meta.agent).toBe("openclaw");
			// … and the per-USER agent lives in `agentId`, the distinct engine-scope column.
			expect(input.meta.agentId).toBe("alice");
		}
	});

	it("OpenClaw's single-event path also stamps the canonical token (createShim engine)", () => {
		const shim = createOpenClawShim();
		expect(shim.harness).toBe("openclaw");
		const input = shim.normalize(
			{ name: "before_agent_start", payload: { source: "agent_start" } },
			baseMeta({ sessionId: "agent:alice:sess-9" }),
		);
		expect(input?.meta.agent).toBe("openclaw");
		// The engine-scope per-user agent is preserved distinctly (NOT clobbered onto `agent`).
		expect(input?.meta.agentId).toBe("alice");
	});

	it("the stamped token matches the canonical six EXACTLY (no drift, every harness covered)", () => {
		const stamped = new Set<string>();
		for (const harness of Object.keys(REPRESENTATIVE_EVENT)) {
			const input = shims[harness].normalize(REPRESENTATIVE_EVENT[harness], baseMeta());
			if (input?.meta.agent !== undefined) stamped.add(input.meta.agent);
		}
		stamped.add(OPENCLAW_HARNESS);
		expect([...stamped].sort()).toEqual([...THE_SIX].sort());
	});
});
