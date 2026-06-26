/**
 * PRD-060b — the provider→model rate table (`roi-rates.ts`).
 *
 * b-AC-1 a rate table exists with input/output/cache_read/cache_write cents-per-Mtok columns + a
 *        "rates as of" date; the Anthropic cache-read rate is 0.1× input and cache-write 1.25× input.
 * b-AC-6 every rate column is an INTEGER cent (no float column crosses the boundary).
 */

import { describe, expect, it } from "vitest";

import {
	ANTHROPIC_CACHE_READ_MULTIPLIER,
	ANTHROPIC_CACHE_WRITE_MULTIPLIER,
	DEFAULT_RATE_MODEL,
	DEFAULT_RATE_PROVIDER,
	RATES_AS_OF,
	RATE_TABLE,
	anthropicCacheRate,
	defaultRateRow,
	rateRowFor,
	resolveRate,
} from "../../../../src/daemon/runtime/dashboard/roi-rates.js";

describe("roi-rates — the provider→model rate table (b-AC-1)", () => {
	it("b-AC-1: exposes the four cents-per-Mtok columns + a 'rates as of' date stamp", () => {
		expect(RATES_AS_OF).toMatch(/^\d{4}-\d{2}-\d{2}$/);
		expect(RATE_TABLE.length).toBeGreaterThan(0);
		for (const row of RATE_TABLE) {
			expect(typeof row.provider).toBe("string");
			expect(typeof row.model).toBe("string");
			expect(row).toHaveProperty("input_cents_per_mtok");
			expect(row).toHaveProperty("output_cents_per_mtok");
			expect(row).toHaveProperty("cache_read_cents_per_mtok");
			expect(row).toHaveProperty("cache_write_cents_per_mtok");
		}
	});

	it("b-AC-1: encodes Anthropic cache-read at 0.1× input and cache-write at 1.25× input", () => {
		expect(ANTHROPIC_CACHE_READ_MULTIPLIER).toBe(0.1);
		expect(ANTHROPIC_CACHE_WRITE_MULTIPLIER).toBe(1.25);

		const anthropicRows = RATE_TABLE.filter((r) => r.provider === "anthropic");
		expect(anthropicRows.length).toBeGreaterThan(0);
		for (const row of anthropicRows) {
			// The encoded columns honor the documented multipliers (rounded to integer cents).
			expect(row.cache_read_cents_per_mtok).toBe(Math.round(row.input_cents_per_mtok * 0.1));
			expect(row.cache_write_cents_per_mtok).toBe(Math.round(row.input_cents_per_mtok * 1.25));
		}
	});

	it("b-AC-1: the exact Sonnet row matches the documented multiplier arithmetic", () => {
		const sonnet = rateRowFor("anthropic", "claude-sonnet-4-6");
		expect(sonnet).toBeDefined();
		// $3/Mtok in → 300 cents; cache-read 0.1× = 30 cents; cache-write 1.25× = 375 cents.
		expect(sonnet?.input_cents_per_mtok).toBe(300);
		expect(sonnet?.cache_read_cents_per_mtok).toBe(30);
		expect(sonnet?.cache_write_cents_per_mtok).toBe(375);
	});

	// Finding (haiku-rate): the skillify gate runs `claude-haiku-4-5`. It MUST resolve to its OWN row
	// (not fall back to the Sonnet default) priced at $1 in / $5 out, with the cache columns derived from
	// input via the same 0.1x / 1.25x multipliers.
	it("prices claude-haiku-4-5 at its OWN row (not the Sonnet fallback)", () => {
		const haiku = rateRowFor("anthropic", "claude-haiku-4-5");
		expect(haiku).toBeDefined();
		expect(haiku?.input_cents_per_mtok).toBe(100);
		expect(haiku?.output_cents_per_mtok).toBe(500);
		expect(haiku?.cache_read_cents_per_mtok).toBe(10); // 0.1x input
		expect(haiku?.cache_write_cents_per_mtok).toBe(125); // 1.25x input
		// resolveRate returns the Haiku row itself, NOT the Sonnet default.
		const resolved = resolveRate("anthropic", "claude-haiku-4-5");
		expect(resolved.model).toBe("claude-haiku-4-5");
		expect(resolved).not.toBe(defaultRateRow()); // distinct object => not the Sonnet fallback.
	});

	it("b-AC-6: every rate column is an INTEGER cent (no float column)", () => {
		for (const row of RATE_TABLE) {
			expect(Number.isInteger(row.input_cents_per_mtok)).toBe(true);
			expect(Number.isInteger(row.output_cents_per_mtok)).toBe(true);
			expect(Number.isInteger(row.cache_read_cents_per_mtok)).toBe(true);
			expect(Number.isInteger(row.cache_write_cents_per_mtok)).toBe(true);
		}
	});

	it("anthropicCacheRate rounds to integer cents", () => {
		expect(anthropicCacheRate(300, 0.1)).toBe(30);
		expect(anthropicCacheRate(1500, 1.25)).toBe(1875);
		// A fractional product rounds (e.g. 305 × 0.1 = 30.5 → 31).
		expect(anthropicCacheRate(305, 0.1)).toBe(31);
		expect(Number.isInteger(anthropicCacheRate(305, 0.1))).toBe(true);
	});

	it("defaultRateRow is present and resolveRate falls back to it for unknown/absent pairs", () => {
		const def = defaultRateRow();
		expect(def.provider).toBe(DEFAULT_RATE_PROVIDER);
		expect(def.model).toBe(DEFAULT_RATE_MODEL);

		expect(resolveRate(undefined, undefined)).toBe(def);
		expect(resolveRate("", "")).toBe(def);
		expect(resolveRate("unknown-provider", "unknown-model")).toBe(def);
		// A known pair resolves to its own row, not the default.
		expect(resolveRate("anthropic", "claude-opus-4-8").model).toBe("claude-opus-4-8");
	});
});
