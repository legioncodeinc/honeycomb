/**
 * Cross-stage contracts — the `FactSchema.type` taxonomy binding (PRD: extraction-type binding).
 *
 * The autonomous extraction pipeline is now BOUND to the closed six-token memory
 * taxonomy single-sourced in `src/shared/memory-types.ts`. The binding lives in
 * `FactSchema.type`: a non-empty model string is NORMALIZED (synonym fold, else the
 * `fact` floor) so the parsed `Fact.type` is ALWAYS one of the six — and a stray
 * token NEVER drops the otherwise-valid fact (the resilient-floor rule).
 *
 * This suite drives the REAL contract (`FactSchema` / `parseFact` / the exported
 * `normalizeMemoryType`), not a reconstruction, so a future loosening (e.g. dropping
 * the transform, or hardcoding a token list) fails HERE.
 *
 * No `.skip` / `.only`; `vitest run` is CI.
 */

import { describe, expect, it } from "vitest";

import {
	DEFAULT_MEMORY_TYPE,
	MEMORY_TYPES,
	isMemoryType,
} from "../../../../src/shared/memory-types.js";
import {
	FactSchema,
	normalizeMemoryType,
	parseFact,
} from "../../../../src/daemon/runtime/pipeline/contracts.js";

describe("FactSchema.type — each of the six parses UNCHANGED", () => {
	for (const token of MEMORY_TYPES) {
		it(`keeps "${token}" verbatim`, () => {
			const fact = parseFact({ content: "a claim", type: token, confidence: 0.9 });
			expect(fact).not.toBeNull();
			expect(fact?.type).toBe(token);
		});
	}
});

describe("FactSchema.type — an off-enum token NORMALIZES and the fact is KEPT (never dropped)", () => {
	it('"rule" folds to its synonym target "convention", fact kept', () => {
		const fact = parseFact({ content: "always run the linter", type: "rule", confidence: 0.8 });
		expect(fact).not.toBeNull(); // KEPT, not dropped.
		expect(fact?.type).toBe("convention");
		expect(isMemoryType(fact?.type ?? "")).toBe(true);
	});

	it('"insight" (no synonym) defaults to "fact", fact kept', () => {
		const fact = parseFact({ content: "the build is slow", type: "insight", confidence: 0.7 });
		expect(fact).not.toBeNull();
		expect(fact?.type).toBe(DEFAULT_MEMORY_TYPE);
		expect(fact?.type).toBe("fact");
	});

	it('"banana" (garbage) defaults to "fact", fact kept', () => {
		const fact = parseFact({ content: "kept anyway", type: "banana", confidence: 0.5 });
		expect(fact).not.toBeNull();
		expect(fact?.type).toBe("fact");
	});

	it("a synonym is case-insensitive (e.g. 'WARNING' → 'gotcha')", () => {
		const fact = parseFact({ content: "watch the off-by-one", type: "WARNING", confidence: 0.6 });
		expect(fact?.type).toBe("gotcha");
	});

	it("the original six are preserved over the synonym fold (case-sensitive canon first)", () => {
		// 'reference' is a token, not a synonym key — it must stay itself, never re-map.
		expect(normalizeMemoryType("reference")).toBe("reference");
	});

	it("a canonical token in non-canonical casing/whitespace maps to its canon, NOT the 'fact' floor", () => {
		// The model's classification was correct — only the casing differed; don't lose it to the floor.
		expect(normalizeMemoryType("Decision")).toBe("decision");
		expect(normalizeMemoryType("GOTCHA")).toBe("gotcha");
		expect(normalizeMemoryType("  Convention ")).toBe("convention");
		const fact = parseFact({ content: "we chose node:sqlite", type: "Decision", confidence: 0.9 });
		expect(fact?.type).toBe("decision");
	});
});

describe("FactSchema.type — empty / missing type is STILL handled (min(1) before normalize)", () => {
	it("empty string fails the fact (min(1) guard, not coerced to 'fact')", () => {
		expect(parseFact({ content: "x", type: "", confidence: 0.5 })).toBeNull();
	});

	it("missing type fails the fact", () => {
		expect(parseFact({ content: "x", confidence: 0.5 })).toBeNull();
	});

	it("non-string type fails the fact", () => {
		expect(parseFact({ content: "x", type: 42, confidence: 0.5 })).toBeNull();
	});
});

describe("FactSchema.type — normalization is IDEMPOTENT (the decision re-parse is stable)", () => {
	it("re-parsing an already-coerced fact yields the same token", () => {
		const once = parseFact({ content: "c", type: "rule", confidence: 0.9 });
		expect(once?.type).toBe("convention");
		// fan-out.ts forwards f.type into the decision payload, where readFacts → parseFact
		// re-validates it; the second pass must not move the token again.
		const twice = parseFact({ content: once?.content, type: once?.type, confidence: once?.confidence });
		expect(twice?.type).toBe("convention");
	});

	it("normalizeMemoryType applied twice equals applied once, for every token + a stray", () => {
		for (const t of [...MEMORY_TYPES, "rule", "banana", ""]) {
			if (t === "") continue; // the empty case is the schema's job, not the normalizer's domain.
			expect(normalizeMemoryType(normalizeMemoryType(t))).toBe(normalizeMemoryType(t));
		}
	});
});

describe("parity — the pipeline's normalized type set == MEMORY_TYPES (single source)", () => {
	it("every normalized output is a member of the closed six", () => {
		const inputs = [
			...MEMORY_TYPES,
			"rule",
			"standard",
			"pattern",
			"idiom",
			"lesson",
			"pitfall",
			"warning",
			"trap",
			"link",
			"url",
			"pref",
			"insight",
			"banana",
			"FACT",
		];
		const produced = new Set(inputs.map((t) => normalizeMemoryType(t)));
		for (const token of produced) {
			expect(isMemoryType(token)).toBe(true);
		}
		// And the full taxonomy is reachable (every one of the six appears as some output).
		const reachable = new Set(MEMORY_TYPES.map((t) => normalizeMemoryType(t)));
		expect([...reachable].sort()).toEqual([...MEMORY_TYPES].sort());
	});

	it("FactSchema only ever emits a taxonomy token for any non-empty type", () => {
		for (const t of ["fact", "convention", "rule", "lesson", "url", "zzz", "Decision"]) {
			const parsed = FactSchema.safeParse({ content: "c", type: t, confidence: 0.5 });
			expect(parsed.success).toBe(true);
			if (parsed.success) expect(isMemoryType(parsed.data.type)).toBe(true);
		}
	});
});
