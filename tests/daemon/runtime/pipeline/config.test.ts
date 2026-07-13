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
	EXTRACTION_PROVIDER_AUTO,
	EXTRACTION_PROVIDER_AUTO_RESOLVED,
	EXTRACTION_PROVIDER_NONE,
	isExtractionEnabled,
	type PipelineConfigProvider,
	type RawPipelineConfig,
	readGraphEnvDecision,
	resolveEffectiveExtractionProvider,
	resolveGraphEnabledVaultFirst,
	resolveMemoryEnabledVaultFirst,
	resolvePipelineConfig,
} from "../../../../src/daemon/runtime/pipeline/config.js";

function provider(raw: RawPipelineConfig): PipelineConfigProvider {
	return { read: () => raw };
}

describe("pipeline config defaults are false-safe (a missing flag is OFF)", () => {
	it("an empty record resolves with every gate off and the documented defaults", () => {
		const c = resolvePipelineConfig(provider({}));
		expect(c.enabled).toBe(false);
		// PRD (memory as a discoverable feature): the UNSET default is now `'auto'` (derive from a
		// configured provider), NOT `'none'`. Absence of the env var no longer means "disabled".
		expect(c.extractionProvider).toBe(EXTRACTION_PROVIDER_AUTO);
		expect(c.shadowMode).toBe(false);
		expect(c.mutationsFrozen).toBe(false);
		expect(c.minFactConfidenceForWrite).toBe(DEFAULT_MIN_FACT_CONFIDENCE);
		expect(c.autonomous).toEqual({ enabled: false, frozen: false, allowUpdateDelete: false });
		expect(c.graph).toEqual({ enabled: false, extractionWritesEnabled: false });
		expect(c.extraction.inputCharCap).toBe(DEFAULT_INPUT_CHAR_CAP);
		// ISS-025 richer-memory defaults: few consolidated memories per event, longer
		// content ceiling, a substance floor under which fragments never write.
		expect(c.extraction.maxFacts).toBe(4);
		expect(c.extraction.maxEntities).toBe(50);
		expect(c.extraction.maxFactChars).toBe(2_000);
		expect(c.extraction.minFactChars).toBe(80);
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
	it("an explicit override provider enables when the pipeline is enabled; disabled/none off", () => {
		expect(isExtractionEnabled(resolvePipelineConfig(provider({ enabled: true, extractionProvider: "router" })))).toBe(true);
		expect(isExtractionEnabled(resolvePipelineConfig(provider({ enabled: false, extractionProvider: "router" })))).toBe(false);
		// Explicit `'none'` is the deliberate opt-out — always off, even when enabled + provider configured.
		expect(isExtractionEnabled(resolvePipelineConfig(provider({ enabled: true, extractionProvider: "none" })), true)).toBe(false);
	});

	it("the UNSET default ('auto') derives from providerConfigured, not from a second flag", () => {
		const autoEnabled = resolvePipelineConfig(provider({ enabled: true }));
		expect(autoEnabled.extractionProvider).toBe(EXTRACTION_PROVIDER_AUTO);
		// enabled + a real provider configured → extraction runs (no second token needed).
		expect(isExtractionEnabled(autoEnabled, true)).toBe(true);
		// enabled but NO provider configured → nothing to extract with → off.
		expect(isExtractionEnabled(autoEnabled, false)).toBe(false);
		// the default (empty) provider signal is conservative: `'auto'` with no signal → off.
		expect(isExtractionEnabled(autoEnabled)).toBe(false);
		// master switch off → always off regardless of the provider.
		expect(isExtractionEnabled(resolvePipelineConfig(provider({ enabled: false })), true)).toBe(false);
	});
});

describe("resolveMemoryEnabledVaultFirst — the vault-first master `enabled` precedence", () => {
	it("a PRESENT vault value WINS over the env (true enables without env editing)", () => {
		expect(resolveMemoryEnabledVaultFirst({ decidedByVault: true, enabled: true }, false)).toBe(true);
	});

	it("a PRESENT vault `false` disables even when the env says enabled", () => {
		expect(resolveMemoryEnabledVaultFirst({ decidedByVault: true, enabled: false }, true)).toBe(false);
	});

	it("an ABSENT vault falls back to the env (HONEYCOMB_PIPELINE_ENABLED)", () => {
		expect(resolveMemoryEnabledVaultFirst({ decidedByVault: false, enabled: false }, true)).toBe(true);
		expect(resolveMemoryEnabledVaultFirst({ decidedByVault: false, enabled: false }, false)).toBe(false);
	});

	it("both absent/off → off (the false-safe default)", () => {
		expect(resolveMemoryEnabledVaultFirst({ decidedByVault: false, enabled: false }, false)).toBe(false);
	});
});

describe("resolveEffectiveExtractionProvider collapses the 'auto' sentinel", () => {
	it("'auto' + providerConfigured → a non-sentinel token the pure gate treats as enabled", () => {
		const base = resolvePipelineConfig(provider({ enabled: true }));
		const resolved = resolveEffectiveExtractionProvider(base, true);
		expect(resolved.extractionProvider).toBe(EXTRACTION_PROVIDER_AUTO_RESOLVED);
		// The stage reads the RESOLVED config with NO provider knowledge and still sees "enabled".
		expect(isExtractionEnabled(resolved)).toBe(true);
	});

	it("'auto' + NOT providerConfigured → 'none' (the honest disabled state)", () => {
		const base = resolvePipelineConfig(provider({ enabled: true }));
		const resolved = resolveEffectiveExtractionProvider(base, false);
		expect(resolved.extractionProvider).toBe(EXTRACTION_PROVIDER_NONE);
		expect(isExtractionEnabled(resolved)).toBe(false);
	});

	it("an explicit 'none' or override is returned unchanged (idempotent for non-'auto')", () => {
		const none = resolvePipelineConfig(provider({ enabled: true, extractionProvider: "none" }));
		expect(resolveEffectiveExtractionProvider(none, true).extractionProvider).toBe(EXTRACTION_PROVIDER_NONE);
		const override = resolvePipelineConfig(provider({ enabled: true, extractionProvider: "router" }));
		expect(resolveEffectiveExtractionProvider(override, false).extractionProvider).toBe("router");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// ISS-002 — the UNIFIED graph gate: env override > vault `graph.enabled` >
// default-follows-memory. `readGraphEnvDecision` reads the two LEGACY env flags
// as an explicit back-compat/opt-out; `resolveGraphEnabledVaultFirst` is the
// pure precedence every resolution site (boot + live reload) runs.
// ─────────────────────────────────────────────────────────────────────────────

describe("ISS-002 readGraphEnvDecision — the legacy env flags as an explicit override", () => {
	it("neither flag set (or blank) → NOT explicit (the env abstains)", () => {
		expect(readGraphEnvDecision({})).toEqual({ explicit: false, enabled: false });
		expect(
			readGraphEnvDecision({
				HONEYCOMB_PIPELINE_GRAPH_ENABLED: "",
				HONEYCOMB_PIPELINE_GRAPH_EXTRACTION_WRITES: "   ",
			}),
		).toEqual({ explicit: false, enabled: false });
	});

	it("a single explicit `true` opts IN without the second legacy flag (the two-flag trap is gone)", () => {
		expect(readGraphEnvDecision({ HONEYCOMB_PIPELINE_GRAPH_ENABLED: "true" })).toEqual({
			explicit: true,
			enabled: true,
		});
		expect(readGraphEnvDecision({ HONEYCOMB_PIPELINE_GRAPH_EXTRACTION_WRITES: "1" })).toEqual({
			explicit: true,
			enabled: true,
		});
	});

	it("a single explicit `false` on EITHER flag opts OUT (the operator kill switch)", () => {
		expect(readGraphEnvDecision({ HONEYCOMB_PIPELINE_GRAPH_ENABLED: "false" })).toEqual({
			explicit: true,
			enabled: false,
		});
		expect(readGraphEnvDecision({ HONEYCOMB_PIPELINE_GRAPH_EXTRACTION_WRITES: "0" })).toEqual({
			explicit: true,
			enabled: false,
		});
	});

	it("both set AND together (pre-ISS-002 both-true installs keep working; a false wins)", () => {
		expect(
			readGraphEnvDecision({
				HONEYCOMB_PIPELINE_GRAPH_ENABLED: "true",
				HONEYCOMB_PIPELINE_GRAPH_EXTRACTION_WRITES: "true",
			}),
		).toEqual({ explicit: true, enabled: true });
		expect(
			readGraphEnvDecision({
				HONEYCOMB_PIPELINE_GRAPH_ENABLED: "true",
				HONEYCOMB_PIPELINE_GRAPH_EXTRACTION_WRITES: "false",
			}),
		).toEqual({ explicit: true, enabled: false });
	});

	it("values coerce through the BoolFlag tokens with trimming (the trailing-space class)", () => {
		expect(readGraphEnvDecision({ HONEYCOMB_PIPELINE_GRAPH_ENABLED: "true " })).toEqual({
			explicit: true,
			enabled: true,
		});
		// A non-token value is an explicit-but-off decision (BoolFlag: only true/1 enable).
		expect(readGraphEnvDecision({ HONEYCOMB_PIPELINE_GRAPH_ENABLED: "yes" })).toEqual({
			explicit: true,
			enabled: false,
		});
	});
});

describe("ISS-002 resolveGraphEnabledVaultFirst — env > vault > default-follows-memory", () => {
	const envAbstains = { explicit: false, enabled: false } as const;
	const vaultAbsent = { decidedByVault: false, enabled: false } as const;

	it("DEFAULT-FOLLOWS-MEMORY: no env, no vault → the resolved memory master switch decides", () => {
		expect(resolveGraphEnabledVaultFirst(envAbstains, vaultAbsent, true)).toBe(true);
		expect(resolveGraphEnabledVaultFirst(envAbstains, vaultAbsent, false)).toBe(false);
	});

	it("a PRESENT vault value decides (true enables; false disables even under a running pipeline)", () => {
		expect(resolveGraphEnabledVaultFirst(envAbstains, { decidedByVault: true, enabled: true }, false)).toBe(true);
		expect(resolveGraphEnabledVaultFirst(envAbstains, { decidedByVault: true, enabled: false }, true)).toBe(false);
	});

	it("an EXPLICIT env decision beats BOTH the vault and the memory default (back-compat / opt-out)", () => {
		expect(
			resolveGraphEnabledVaultFirst({ explicit: true, enabled: false }, { decidedByVault: true, enabled: true }, true),
		).toBe(false);
		expect(
			resolveGraphEnabledVaultFirst({ explicit: true, enabled: true }, { decidedByVault: true, enabled: false }, false),
		).toBe(true);
	});
});
