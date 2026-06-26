/**
 * PRD-060b — the cost & savings calculation engine (`roi-savings.ts`).
 *
 * b-AC-2 measured cache savings = Σ cache_read_tokens × (input_rate − cache_read_rate) / 1e6, summed
 *        over turns, returned TAGGED `measured`; asserted against fixed token inputs (arithmetic).
 * b-AC-3 modeled memory-injection savings is TAGGED `modeled` and carries its assumption as a data
 *        field — the single source the disclosure copy reads.
 * b-AC-4 no `measured` value is derived from a `modeled` input (type-enforced); any aggregate folding
 *        the modeled term is itself `modeled`/`est.`.
 * b-AC-5 blendedCentsPerMtok from the actual mix; `null` when capture is absent.
 * b-AC-6 integer cents within the layer — no float-cents crosses the module boundary.
 * b-AC-7 capture absent/partial → status `absent`/`partial`, NOT `0`-as-measured.
 */

import { describe, expect, it } from "vitest";

import * as honestyContract from "../../../../src/daemon/runtime/dashboard/roi-honesty-contract.js";
import { resolveRate } from "../../../../src/daemon/runtime/dashboard/roi-rates.js";
import {
	type CapturedTurn,
	MEMORY_INJECTION_ASSUMPTION,
	blendedCentsPerMtok,
	isIntegerCents,
	measuredCacheSavings,
	modeledMemoryInjectionSavings,
	netRoi,
} from "../../../../src/daemon/runtime/dashboard/roi-savings.js";

/** A Sonnet turn (provider+model resolve to the 300/30 input/cache-read rate, delta 270 c/Mtok). */
function sonnetTurn(over: Partial<CapturedTurn>): CapturedTurn {
	return {
		input_tokens: null,
		output_tokens: null,
		cache_read_input_tokens: null,
		cache_creation_input_tokens: null,
		provider: "anthropic",
		model: "claude-sonnet-4-6",
		sourceTool: "claude-code",
		...over,
	};
}

describe("roi-savings — measured cache savings (b-AC-2)", () => {
	it("b-AC-2: sums cache_read_tokens × (input_rate − cache_read_rate) / 1e6 over turns, tagged measured", () => {
		// Sonnet: input 300 c/Mtok, cache_read 30 c/Mtok → delta 270 c/Mtok.
		// turn A: 1_000_000 read → round(1e6 × 270 / 1e6) = 270 cents.
		// turn B:   500_000 read → round(5e5 × 270 / 1e6) = round(135) = 135 cents.
		const turns = [
			sonnetTurn({ cache_read_input_tokens: 1_000_000 }),
			sonnetTurn({ cache_read_input_tokens: 500_000 }),
		];
		const result = measuredCacheSavings(turns);

		expect(result.tag).toBe("measured");
		expect(result.value.savingsCents).toBe(405);
		expect(result.value.measuredTurns).toBe(2);
		expect(result.value.totalTurns).toBe(2);
		expect(result.value.status).toBe("measured");
	});

	it("b-AC-2: a measured zero (cache_read = 0) contributes 0 honestly and counts as measured", () => {
		const result = measuredCacheSavings([sonnetTurn({ cache_read_input_tokens: 0 })]);
		expect(result.tag).toBe("measured");
		expect(result.value.savingsCents).toBe(0);
		expect(result.value.measuredTurns).toBe(1);
		expect(result.value.status).toBe("measured");
	});

	it("b-AC-6: the measured savings figure is an integer cent", () => {
		const result = measuredCacheSavings([sonnetTurn({ cache_read_input_tokens: 333_333 })]);
		expect(isIntegerCents(result.value.savingsCents)).toBe(true);
	});
});

describe("roi-savings — capture-absent honesty (b-AC-7)", () => {
	it("b-AC-7: no turns → status absent, NOT 0-as-measured", () => {
		const result = measuredCacheSavings([]);
		expect(result.value.status).toBe("absent");
		expect(result.value.measuredTurns).toBe(0);
	});

	it("b-AC-7: all NULL cache_read (token data absent) → status absent, savings 0 but flagged absent", () => {
		const result = measuredCacheSavings([sonnetTurn({ cache_read_input_tokens: null }), sonnetTurn({})]);
		expect(result.value.status).toBe("absent");
		expect(result.value.measuredTurns).toBe(0);
		// The 0 here is "absent", reported via status — never presented as a measured zero.
		expect(result.value.savingsCents).toBe(0);
	});

	it("b-AC-7: some turns measured, some NULL → status partial (the read-model maps to partial)", () => {
		const result = measuredCacheSavings([
			sonnetTurn({ cache_read_input_tokens: 1_000_000 }),
			sonnetTurn({ cache_read_input_tokens: null }),
		]);
		expect(result.value.status).toBe("partial");
		expect(result.value.measuredTurns).toBe(1);
		expect(result.value.totalTurns).toBe(2);
		expect(result.value.savingsCents).toBe(270);
	});
});

describe("roi-savings — blended $/Mtok (b-AC-5)", () => {
	it("b-AC-5: null when token capture is absent (no priced tokens)", () => {
		expect(blendedCentsPerMtok([])).toBeNull();
		expect(blendedCentsPerMtok([sonnetTurn({})])).toBeNull();
	});

	it("b-AC-5: blends the actual mix to an integer cents-per-Mtok", () => {
		// One turn: 1_000_000 input @300 = 300c over 1_000_000 tokens → blended 300 c/Mtok.
		const blended = blendedCentsPerMtok([sonnetTurn({ input_tokens: 1_000_000 })]);
		expect(blended).toBe(300);
		expect(Number.isInteger(blended as number)).toBe(true);
	});

	it("b-AC-5: a mix of input + cache-read blends below the pure input rate", () => {
		// 1_000_000 input @300c = 300c, 1_000_000 cache_read @30c = 30c → 330c over 2_000_000 → 165 c/Mtok.
		const blended = blendedCentsPerMtok([
			sonnetTurn({ input_tokens: 1_000_000, cache_read_input_tokens: 1_000_000 }),
		]);
		expect(blended).toBe(165);
	});
});

describe("roi-savings — modeled memory-injection savings (b-AC-3)", () => {
	it("b-AC-3: returns tagged modeled and carries the assumption as a data field", () => {
		const result = modeledMemoryInjectionSavings(10);
		expect(result.tag).toBe("modeled");
		expect(result.assumption).toBeDefined();
		// The assumption IS the single shared source the disclosure copy reads.
		expect(result.assumption).toBe(MEMORY_INJECTION_ASSUMPTION);
		expect(typeof result.assumption.assumptionText).toBe("string");
		expect(result.assumption.assumptionText.length).toBeGreaterThan(0);
		expect(result.assumption.signedOff).toBe(false); // placeholder until operator sign-off
	});

	it("b-AC-3: the estimate is integer cents derived from the assumption constants", () => {
		// 10 sessions × 2 turns × 4000 tokens = 80_000 tokens @ Sonnet input 300 c/Mtok
		// → round(80_000 × 300 / 1e6) = round(24) = 24 cents.
		const rate = resolveRate("anthropic", "claude-sonnet-4-6");
		const result = modeledMemoryInjectionSavings(10, rate);
		expect(result.value.estimatedCents).toBe(24);
		expect(result.value.sessions).toBe(10);
		expect(isIntegerCents(result.value.estimatedCents)).toBe(true);
	});
});

describe("roi-savings — the honesty contract, structurally enforced (b-AC-4)", () => {
	it("b-AC-4: the measured path takes raw counts, so no modeled input can flow into a measured result", () => {
		// STRUCTURAL (compile-time): `measuredCacheSavings` accepts `readonly CapturedTurn[]` — primitives +
		// a rate, NOT a `Modeled<…>`. That guarantee is enforced by `tsc` via the witness module
		// `roi-honesty-contract.ts` (its `@ts-expect-error` lines FAIL `npm run typecheck` if the types ever
		// loosen to permit a measured-from-modeled derivation). vitest's esbuild transform strips type
		// directives, so the structural proof lives in the typecheck gate, not here.
		//
		// `honestyContract` is imported purely so the witness participates in the build graph; touching it
		// keeps the structural assertion load-bearing. At RUNTIME we assert the measured tag stands alone.
		expect(honestyContract.HONESTY_CONTRACT_WITNESSED).toBe(true);
		const ok = measuredCacheSavings([sonnetTurn({ cache_read_input_tokens: 1_000_000 })]);
		expect(ok.tag).toBe("measured");
		// A measured result is never a modeled one — distinct tag literals, distinct kinds of number.
		expect(ok.tag).not.toBe("modeled");
	});

	it("b-AC-4: netRoi folds a modeled term, so the net is itself tagged modeled (est.) and inherits the assumption", () => {
		const measuredHalf = measuredCacheSavings([sonnetTurn({ cache_read_input_tokens: 1_000_000 })]);
		const modeledHalf = modeledMemoryInjectionSavings(10);
		const net = netRoi(measuredHalf, modeledHalf, 50);

		// The aggregate that includes the modeled term is itself MODELED — the est. taint propagated.
		expect(net.tag).toBe("modeled");
		expect(net.assumption).toBe(modeledHalf.assumption);
		// 270 measured + 24 modeled − 50 infra = 244.
		expect(net.value.measuredSavingsCents).toBe(270);
		expect(net.value.modeledSavingsCents).toBe(24);
		expect(net.value.infraCostCents).toBe(50);
		expect(net.value.netCents).toBe(244);
		expect(isIntegerCents(net.value.netCents)).toBe(true);
	});

	it("b-AC-4: the measured and modeled values carry DISTINCT tag literals (separately tagged)", () => {
		const measuredHalf = measuredCacheSavings([sonnetTurn({ cache_read_input_tokens: 1_000_000 })]);
		const modeledHalf = modeledMemoryInjectionSavings(10);
		expect(measuredHalf.tag).toBe("measured");
		expect(modeledHalf.tag).toBe("modeled");
		expect(measuredHalf.tag).not.toBe(modeledHalf.tag);
	});
});

describe("roi-savings — integer-cents boundary guard (b-AC-6)", () => {
	it("b-AC-6: no float-cents value crosses the module boundary across a fractional fixture", () => {
		// Deliberately fractional token counts so a non-rounding impl would leak a float.
		const turns = [
			sonnetTurn({ input_tokens: 123_457, output_tokens: 7_777, cache_read_input_tokens: 333_333 }),
			sonnetTurn({ cache_read_input_tokens: 12_345, model: "claude-opus-4-8" }),
		];
		const measuredResult = measuredCacheSavings(turns);
		const modeledResult = modeledMemoryInjectionSavings(7);
		const net = netRoi(measuredResult, modeledResult);
		const blended = blendedCentsPerMtok(turns);

		expect(isIntegerCents(measuredResult.value.savingsCents)).toBe(true);
		expect(isIntegerCents(modeledResult.value.estimatedCents)).toBe(true);
		expect(isIntegerCents(net.value.netCents)).toBe(true);
		expect(isIntegerCents(net.value.measuredSavingsCents)).toBe(true);
		expect(isIntegerCents(net.value.modeledSavingsCents)).toBe(true);
		if (blended !== null) expect(isIntegerCents(blended)).toBe(true);
	});
});
