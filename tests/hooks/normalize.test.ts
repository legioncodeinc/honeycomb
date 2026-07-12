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
 * ISS-022 — the `renderChannel` systemMessage gating matrix in the ONE shared engine.
 *
 * `HookResult.systemMessage` (the user-visible "N memories injected" notice) is applied by
 * `renderContext(block, extras)` per channel arm, with ZERO per-shim edits:
 *
 *   | arm                                        | extras.systemMessage        |
 *   |--------------------------------------------|-----------------------------|
 *   | model-only WITH `contextHookEvent` (recall)| spread top-level on envelope|
 *   | model-only WITHOUT (session-start prime)   | IGNORED — byte-identical    |
 *   | user-visible                               | appended as `"\n" + msg`    |
 *
 * The a-AC-8 byte-identical-prime-envelope guard keeps passing UNMODIFIED: the prime arm's
 * envelope is asserted deep-equal (and JSON-byte-equal) with and without extras.
 */

import { describe, expect, it } from "vitest";

import { createShim, type ShimSpec } from "../../src/hooks/normalize.js";
import { assertClaudeCodeUserPromptResponse } from "../../references/claude-code/userprompt-response-schema.js";

const BLOCK = "Relevant Honeycomb memory for this prompt:\n\n- Token TTL dropped to 1h.";
const NOTICE = "🐝 Honeycomb: 1 memories injected (~19 tokens)";

/** A minimal spec builder — only the channel-routing fields matter here. */
function spec(overrides: Partial<ShimSpec>): ShimSpec {
	return {
		harness: "test-harness",
		runtimePath: "plugin",
		contextChannel: "model-only",
		hostCli: { bin: "claude", args: ["-p"] },
		references: "references/claude-code/",
		eventMap: {},
		extractData: () => undefined,
		...overrides,
	};
}

describe("ISS-022: model-only WITH contextHookEvent (the per-turn recall arm) spreads systemMessage top-level", () => {
	const recallShim = createShim(spec({ contextHookEvent: "UserPromptSubmit" }));

	it("carries the top-level systemMessage alongside the unchanged hookSpecificOutput wrapper", () => {
		const env = recallShim.renderContext(BLOCK, { systemMessage: NOTICE });
		expect(env).toEqual({
			channel: "model-only",
			additionalContext: BLOCK,
			hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: BLOCK },
			systemMessage: NOTICE,
		});
	});

	it("still validates against the pinned Claude Code UserPromptSubmit oracle (systemMessage passes through)", () => {
		const env = recallShim.renderContext(BLOCK, { systemMessage: NOTICE });
		const response = assertClaudeCodeUserPromptResponse(JSON.parse(JSON.stringify(env)));
		expect(response.hookSpecificOutput?.hookEventName).toBe("UserPromptSubmit");
		expect((response as { systemMessage?: string }).systemMessage).toBe(NOTICE);
	});

	it("omits the systemMessage key entirely when extras are absent (no `undefined` churn)", () => {
		const env = recallShim.renderContext(BLOCK);
		expect(env).toEqual({
			channel: "model-only",
			additionalContext: BLOCK,
			hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: BLOCK },
		});
		expect("systemMessage" in env).toBe(false);
	});
});

describe("ISS-022 / a-AC-8: model-only WITHOUT contextHookEvent (the session-start prime) IGNORES extras", () => {
	const primeShim = createShim(spec({}));

	it("the prime envelope is byte-identical with and without extras (the a-AC-8 guard, unmodified)", () => {
		const bare = primeShim.renderContext(BLOCK);
		const withExtras = primeShim.renderContext(BLOCK, { systemMessage: NOTICE });
		expect(withExtras).toEqual(bare);
		expect(JSON.stringify(withExtras)).toBe(JSON.stringify(bare));
		expect(bare).toEqual({ channel: "model-only", additionalContext: BLOCK });
	});
});

describe("ISS-022: the user-visible channel appends the notice after the rendered block", () => {
	it("appends '\\n' + systemMessage to the verbatim block (no renderUserVisible)", () => {
		const shim = createShim(spec({ contextChannel: "user-visible" }));
		const env = shim.renderContext(BLOCK, { systemMessage: NOTICE });
		expect(env).toEqual({ channel: "user-visible", text: `${BLOCK}\n${NOTICE}` });
	});

	it("appends AFTER the condensed text when the spec condenses (the Codex future-proofing path)", () => {
		const shim = createShim(
			spec({ contextChannel: "user-visible", renderUserVisible: () => "honeycomb: memory recall active" }),
		);
		const env = shim.renderContext(BLOCK, { systemMessage: NOTICE });
		expect(env).toEqual({ channel: "user-visible", text: `honeycomb: memory recall active\n${NOTICE}` });
	});

	it("is unchanged when extras are absent (the existing single-argument call sites)", () => {
		const shim = createShim(spec({ contextChannel: "user-visible" }));
		expect(shim.renderContext(BLOCK)).toEqual({ channel: "user-visible", text: BLOCK });
	});
});
