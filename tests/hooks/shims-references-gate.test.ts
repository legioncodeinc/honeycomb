/**
 * PRD-019c c-AC-6 — every shim cites the sibling `references/<harness>/` repo for
 * the protocol it implements (FR-11 / D-3).
 *
 * No sibling repos exist under `references/` in THIS repo, so the gate is a
 * documented contribution rule + a machine-readable citation on each shim
 * (`HarnessShim.references`) AND a cited protocol in each shim's module header. This
 * suite asserts (1) each shim's `references` points at `references/<harness>/`, and
 * (2) each shim source file names its protocol in a comment.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

import type { HarnessShim } from "../../src/hooks/index.js";
import {
	createClaudeCodeShim,
	createCodexShim,
	createCursorShim,
	createHermesShim,
	createOpenClawShim,
	createPiShim,
} from "../../src/hooks/index.js";

const SRC = fileURLToPath(new URL("../../src/hooks/", import.meta.url));

const shims: readonly { readonly shim: HarnessShim; readonly file: string }[] = [
	{ shim: createClaudeCodeShim(), file: "claude-code/shim.ts" },
	{ shim: createCodexShim(), file: "codex/shim.ts" },
	{ shim: createCursorShim(), file: "cursor/shim.ts" },
	{ shim: createOpenClawShim(), file: "openclaw/shim.ts" },
	{ shim: createHermesShim(), file: "hermes/shim.ts" },
	{ shim: createPiShim(), file: "pi/shim.ts" },
];

describe("PRD-019c c-AC-6: references gate", () => {
	it("c-AC-6 every shim cites references/<harness>/", () => {
		for (const { shim } of shims) {
			expect(shim.references, shim.harness).toBe(`references/${shim.harness}/`);
		}
	});

	it("c-AC-6 the citation matches the shim's own harness id (no cross-wired reference)", () => {
		for (const { shim } of shims) {
			expect(shim.references.includes(shim.harness), shim.harness).toBe(true);
		}
	});

	it("c-AC-6 every shim source file cites its protocol in a comment", () => {
		for (const { shim, file } of shims) {
			const src = readFileSync(SRC + file, "utf-8");
			// The references gate is cited in the module header.
			expect(src, file).toMatch(/References gate/i);
			expect(src, file).toContain(`references/${shim.harness}/`);
		}
	});
});
