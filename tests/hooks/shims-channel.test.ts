/**
 * PRD-019c c-AC-5 — the SAME logical block lands through the correct channel for
 * each harness (model-only vs user-visible) (FR-10).
 *
 * The shared core renders ONE context block; each shim's `renderContext` routes it
 * into a `ContextEnvelope`. This suite asserts each harness's channel and that the
 * SAME block lands through that channel — model-only carries the verbatim block,
 * user-visible carries the (possibly condensed) text — so context lands correctly
 * everywhere.
 */

import { describe, expect, it } from "vitest";

import type { ContextEnvelope, HarnessShim } from "../../src/hooks/index.js";
import {
	createClaudeCodeShim,
	createCodexShim,
	createCursorShim,
	createHermesShim,
	createOpenClawShim,
	createPiShim,
	HERMES_MCP_MENTION,
} from "../../src/hooks/index.js";

const BLOCK = "## Goals\n- ship v2\n## Rules\n- prefer small PRs";

/** Extract the landed text from either channel envelope. */
function landed(env: ContextEnvelope): string {
	return env.channel === "model-only" ? env.additionalContext : env.text;
}

describe("PRD-019c c-AC-5: context channel routing", () => {
	it("c-AC-5 model-only harnesses carry the VERBATIM block in additionalContext", () => {
		const modelOnly: readonly HarnessShim[] = [createClaudeCodeShim(), createCursorShim(), createOpenClawShim()];
		for (const shim of modelOnly) {
			const env = shim.renderContext(BLOCK);
			expect(env.channel, shim.harness).toBe("model-only");
			if (env.channel === "model-only") {
				// The SAME logical block lands verbatim, model-only (not shown to the user).
				expect(env.additionalContext, shim.harness).toBe(BLOCK);
			}
		}
	});

	it("c-AC-5 user-visible harnesses carry the block as transcript text", () => {
		const userVisible: readonly HarnessShim[] = [createCodexShim(), createHermesShim(), createPiShim()];
		for (const shim of userVisible) {
			const env = shim.renderContext(BLOCK);
			expect(env.channel, shim.harness).toBe("user-visible");
			// The block lands as user-visible text (non-empty for a non-empty block).
			expect(landed(env), shim.harness).not.toBe("");
		}
	});

	it("c-AC-5 Codex condenses the block to a brief user-visible login line", () => {
		const env = createCodexShim().renderContext(BLOCK);
		expect(landed(env)).toBe("honeycomb: signed in — memory recall active");
	});

	it("c-AC-5 Hermes lands the FULL block plus an MCP-tools mention (user-visible)", () => {
		const env = createHermesShim().renderContext(BLOCK);
		const text = landed(env);
		expect(text).toContain(BLOCK); // the full logical block.
		expect(text).toContain(HERMES_MCP_MENTION.trim());
	});

	it("c-AC-5 pi lands the block as a static AGENTS.md fenced section (user-visible)", () => {
		const env = createPiShim().renderContext(BLOCK);
		const text = landed(env);
		expect(text).toContain("<!-- honeycomb:start -->");
		expect(text).toContain(BLOCK);
		expect(text).toContain("<!-- honeycomb:end -->");
	});

	it("c-AC-5 the SAME block routes to BOTH a model-only and a user-visible harness", () => {
		// One logical block; correct channel for each harness — the c-AC-5 property.
		const modelOnly = createClaudeCodeShim().renderContext(BLOCK);
		const userVisible = createHermesShim().renderContext(BLOCK);
		expect(modelOnly.channel).toBe("model-only");
		expect(userVisible.channel).toBe("user-visible");
		// Both carry the same logical content (Hermes appends only the MCP mention).
		expect(landed(modelOnly)).toBe(BLOCK);
		expect(landed(userVisible)).toContain(BLOCK);
	});
});
