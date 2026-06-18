/**
 * PRD-019c — direct coverage for the shared `normalize.ts` payload extractors.
 *
 * `normalize.ts` is the ONE engine that makes "every harness → the SAME HookInput as the
 * Claude Code reference" a STRUCTURAL guarantee (c-AC-1). The shim suites exercise the engine
 * end-to-end, but the small reusable accessors (`asRecord`/`pickString`/`nested`/`nestedString`)
 * carry the null/non-object/missing-key defenses every shim relies on. This suite pins those
 * accessors directly so a flipped guard, a swapped boundary, or a wrong fallback literal cannot
 * pass unnoticed — the difference between "the equivalence holds by test" and "by coincidence".
 */

import { describe, expect, it } from "vitest";

import { asRecord, nested, nestedString, pickString } from "../../src/hooks/normalize.js";

describe("normalize.ts extractors — the structural-equivalence accessors", () => {
	it("asRecord returns the object for a record and {} for every non-object input", () => {
		const obj = { a: 1 };
		expect(asRecord(obj)).toBe(obj); // same reference for a real object.
		// Every non-object coerces to an EMPTY record (kills the `&&`→`||` and `? :` flips).
		expect(asRecord(null)).toEqual({});
		expect(asRecord(undefined)).toEqual({});
		expect(asRecord("str")).toEqual({});
		expect(asRecord(42)).toEqual({});
		expect(asRecord(true)).toEqual({});
	});

	it("pickString returns the FIRST present string by key order, else the empty string", () => {
		// First candidate wins even when a later candidate is also present (order matters).
		expect(pickString({ b: "second", a: "first" }, "a", "b")).toBe("first");
		// Falls through a missing/non-string key to the next candidate.
		expect(pickString({ a: 7, b: "ok" }, "a", "b")).toBe("ok");
		// No candidate present → the empty-string fallback (kills the `return ""` literal mutant).
		expect(pickString({ a: "x" }, "missing")).toBe("");
		expect(pickString(null, "a")).toBe("");
		// A non-string value at the key is NOT returned (kills the typeof-guard flip).
		expect(pickString({ a: 123 }, "a")).toBe("");
	});

	it("nested reads obj[key] for an object and undefined for a non-object", () => {
		expect(nested({ tool_input: { x: 1 } }, "tool_input")).toEqual({ x: 1 });
		expect(nested({ a: "v" }, "missing")).toBeUndefined();
		expect(nested(null, "a")).toBeUndefined();
		expect(nested("str", "a")).toBeUndefined();
	});

	it("nestedString reads obj[a][b] as a string, else undefined (the tool_input field reader)", () => {
		// Present nested string is read through.
		expect(nestedString({ tool_input: { command: "ls" } }, "tool_input", "command")).toBe("ls");
		// Outer missing / non-object → undefined (kills the outer-guard flip).
		expect(nestedString({}, "tool_input", "command")).toBeUndefined();
		expect(nestedString({ tool_input: "nope" }, "tool_input", "command")).toBeUndefined();
		expect(nestedString(null, "tool_input", "command")).toBeUndefined();
		// Inner value present but NOT a string → undefined (kills the inner typeof-guard flip).
		expect(nestedString({ tool_input: { command: 7 } }, "tool_input", "command")).toBeUndefined();
		// Inner key absent → undefined.
		expect(nestedString({ tool_input: { other: "x" } }, "tool_input", "command")).toBeUndefined();
	});
});
