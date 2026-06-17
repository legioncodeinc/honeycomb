/**
 * PRD-006 pipeline config — the zod boundary (flags, defaults, gates, clamping).
 *
 * Config is the one module every stage reads; these tests pin the false-safe
 * defaults, the extraction gate (a-AC-5 / FR-9), and the coerce/clamp posture so a
 * Wave-2 Bee can rely on the resolved shape. Verified against an injected
 * `PipelineConfigProvider` (no env reads); `vitest run` is CI, no `.skip`/`.only`.
 */

import { describe, expect, it } from "vitest";

import {
	DEFAULT_INPUT_CHAR_CAP,
	DEFAULT_MIN_FACT_CONFIDENCE,
	EXTRACTION_PROVIDER_NONE,
	isExtractionEnabled,
	type PipelineConfigProvider,
	type RawPipelineConfig,
	resolvePipelineConfig,
} from "../../../../src/daemon/runtime/pipeline/config.js";

function provider(raw: RawPipelineConfig): PipelineConfigProvider {
	return { read: () => raw };
}

describe("pipeline config defaults are false-safe (a missing flag is OFF)", () => {
	it("an empty record resolves with every gate off and the documented defaults", () => {
		const c = resolvePipelineConfig(provider({}));
		expect(c.enabled).toBe(false);
		expect(c.extractionProvider).toBe(EXTRACTION_PROVIDER_NONE);
		expect(c.shadowMode).toBe(false);
		expect(c.mutationsFrozen).toBe(false);
		expect(c.minFactConfidenceForWrite).toBe(DEFAULT_MIN_FACT_CONFIDENCE);
		expect(c.autonomous).toEqual({ enabled: false, frozen: false, allowUpdateDelete: false });
		expect(c.graph).toEqual({ enabled: false, extractionWritesEnabled: false });
		expect(c.extraction.inputCharCap).toBe(DEFAULT_INPUT_CHAR_CAP);
		expect(c.extraction.maxFacts).toBe(20);
		expect(c.extraction.maxEntities).toBe(50);
		expect(c.extraction.maxFactChars).toBe(500);
		expect(c.retention.batchLimit).toBe(500);
	});
});

describe("env-string flags coerce 'true'/'1' → true, anything else → false", () => {
	it("string booleans from the environment resolve correctly", () => {
		const c = resolvePipelineConfig(
			provider({
				enabled: "true",
				shadowMode: "1",
				mutationsFrozen: "no",
				autonomous: { enabled: "true", frozen: "0", allowUpdateDelete: "1" },
				graph: { enabled: "true", extractionWritesEnabled: "false" },
			}),
		);
		expect(c.enabled).toBe(true);
		expect(c.shadowMode).toBe(true);
		expect(c.mutationsFrozen).toBe(false);
		expect(c.autonomous.enabled).toBe(true);
		expect(c.autonomous.frozen).toBe(false);
		expect(c.autonomous.allowUpdateDelete).toBe(true);
		expect(c.graph.enabled).toBe(true);
		expect(c.graph.extractionWritesEnabled).toBe(false);
	});
});

describe("numeric knobs coerce + clamp (a typo is tuning noise, not a config failure)", () => {
	it("a non-numeric cap falls back to the default; confidence clamps into [0,1]", () => {
		const c = resolvePipelineConfig(
			provider({
				minFactConfidenceForWrite: "1.8", // out of range → clamp to 1
				extraction: { inputCharCap: "not-a-number", maxFacts: "0" }, // garbage → default; below min → clamp to 1
			}),
		);
		expect(c.minFactConfidenceForWrite).toBe(1);
		expect(c.extraction.inputCharCap).toBe(DEFAULT_INPUT_CHAR_CAP);
		expect(c.extraction.maxFacts).toBe(1);
	});

	it("a negative confidence clamps to 0", () => {
		const c = resolvePipelineConfig(provider({ minFactConfidenceForWrite: "-0.5" }));
		expect(c.minFactConfidenceForWrite).toBe(0);
	});
});

describe("a-AC-5 / FR-9 the extraction gate", () => {
	it("isExtractionEnabled is true only when enabled AND provider !== 'none'", () => {
		expect(isExtractionEnabled(resolvePipelineConfig(provider({ enabled: true, extractionProvider: "router" })))).toBe(true);
		expect(isExtractionEnabled(resolvePipelineConfig(provider({ enabled: false, extractionProvider: "router" })))).toBe(false);
		expect(isExtractionEnabled(resolvePipelineConfig(provider({ enabled: true, extractionProvider: "none" })))).toBe(false);
		// default (empty) → disabled.
		expect(isExtractionEnabled(resolvePipelineConfig(provider({})))).toBe(false);
	});
});
