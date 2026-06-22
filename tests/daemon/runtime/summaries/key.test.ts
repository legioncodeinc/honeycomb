/**
 * PRD-046b Tier-1 KEY derivation — proves b-AC-2 (shape + sharpness) + b-AC-3 (grounded),
 * named + unskipped. No live DeepLake, no host CLI: the gate output is a fixture string the
 * real `parseSummaryGate` / `buildStructuredSummaryPrompt` are driven against.
 *
 *   - b-AC-2 — every distilled summary has a ≤1-sentence keyworded key, keyword-forward,
 *     self-contained, carrying its id/path. A SHARPNESS golden-sample assertion checks the
 *     key carries SUBSYSTEM + OUTCOME, not just a topic.
 *   - b-AC-3 — a key/summary contains no fact absent from the structured extraction. A
 *     CONFABULATION fixture (raw turns tempt an un-extracted noun) proves the key is
 *     rejected back to a grounded one.
 */

import { describe, expect, it } from "vitest";

import {
	buildStructuredSummaryPrompt,
	deriveDurableKey,
	deriveKeyFromExtraction,
	type Extraction,
	isKeyGrounded,
	isKeyGroundedInText,
	MAX_KEY_CHARS,
	parseSummaryGate,
	SUMMARY_GATE_INSTRUCTIONS,
} from "../../../../src/daemon/runtime/summaries/index.js";

/** A full extraction object (every list defaulted) for the grounding helpers. */
function extraction(partial: Partial<Extraction>): Extraction {
	return { goals: [], decisions: [], changes: [], blockers: [], next: [], ...partial };
}

describe("PRD-046b b-AC-2 — the Tier-1 key exists, is ≤1 sentence, keyword-forward, self-contained", () => {
	it("the gate object parses into a grounded { summary, key }, and the key is one line within the cap", () => {
		const gate = JSON.stringify({
			extraction: {
				changes: ["CI pack-step timeout fixed via a retry-on-429 wrapper"],
				goals: ["make the npm pack step reliable"],
			},
			summary: "## CI\nThe pack step was timing out; added a retry-on-429 wrapper around the pack call.",
			key: "CI pack-step timeout — fixed via a retry-on-429 wrapper",
		});

		const grounded = parseSummaryGate(gate);
		expect(grounded).not.toBeNull();
		const key = grounded!.key;
		// One sentence (no embedded newline; at most one terminal period).
		expect(key).not.toContain("\n");
		expect(key.length).toBeLessThanOrEqual(MAX_KEY_CHARS);
		// Keyword-forward + self-contained: it carries the subsystem (CI / pack-step) and the
		// operative detail (retry-on-429), not a bland topic.
		expect(key).toMatch(/CI/);
		expect(key).toMatch(/retry-on-429/);
	});

	it("sharpness golden sample: a GOOD key carries subsystem + OUTCOME, beating a bland topic key", () => {
		// The good-vs-bad bar from distillation-and-tier1-keys.md: the good column is
		// "subsystem + what happened + the operative detail/outcome". A derived key built from
		// outcome-bearing extraction facts must front-load the subsystem AND the outcome.
		const ex = extraction({
			changes: ["switched recall fusion to RRF because deeplake_hybrid_record returns all-zero scores"],
			goals: ["fix recall ranking"],
		});
		const key = deriveKeyFromExtraction(ex);
		// SUBSYSTEM token (recall) AND an OUTCOME/operative detail (RRF / the all-zero cause),
		// not just the topic word.
		expect(key.toLowerCase()).toContain("recall");
		expect(key).toMatch(/RRF|deeplake_hybrid_record/);
		// A bland topic ("Looked at recall") would carry the subsystem but NO outcome — assert
		// the derived key is strictly richer than the topic alone.
		expect(key.length).toBeGreaterThan("recall".length + 5);
	});

	it("the structured prompt instructs the two-step grounded order (extraction → summary → key)", () => {
		const prompt = buildStructuredSummaryPrompt("sess-1", "[user_message] fix the build");
		expect(prompt).toContain(SUMMARY_GATE_INSTRUCTIONS);
		// The three grounded steps appear in order in the instruction block.
		const iExtract = prompt.indexOf("extraction —");
		const iSummary = prompt.indexOf("summary —");
		const iKey = prompt.indexOf("key —");
		expect(iExtract).toBeGreaterThanOrEqual(0);
		expect(iSummary).toBeGreaterThan(iExtract);
		expect(iKey).toBeGreaterThan(iSummary);
		// The session events are carried for the gate to read.
		expect(prompt).toContain("Session: sess-1");
		expect(prompt).toContain("fix the build");
	});

	it("a key is never blank: an empty gate key falls back to a key derived from the extraction", () => {
		const gate = JSON.stringify({
			extraction: { changes: ["dashboard nav-shell shipped: left nav + hash router + route registry"] },
			summary: "## Dashboard\nShipped the nav-shell: a left nav, a hash router, and a route registry.",
			key: "",
		});
		const grounded = parseSummaryGate(gate)!;
		expect(grounded.key.length).toBeGreaterThan(0);
		expect(grounded.key.toLowerCase()).toContain("nav-shell");
	});
});

describe("PRD-046b b-AC-3 — keys are grounded: no fact absent from the structured extraction", () => {
	it("CONFABULATION fixture: a gate key inventing an un-extracted noun is REJECTED to a grounded key", () => {
		// The extraction only mentions the recall ranking. The gate's key smuggles in
		// "Kubernetes" — a noun the extraction never established (the raw turns tempted it).
		// The grounding guard must reject that key and derive a grounded one from the extraction.
		const gate = JSON.stringify({
			extraction: {
				changes: ["tuned the recall ranking weights"],
				goals: ["improve recall precision"],
			},
			summary: "## Recall\nTuned the recall ranking weights to improve precision.",
			key: "Kubernetes autoscaler rollout fixed the recall ranking",
		});
		const grounded = parseSummaryGate(gate)!;
		// The confabulated noun never reaches the stored key.
		expect(grounded.key.toLowerCase()).not.toContain("kubernetes");
		expect(grounded.key.toLowerCase()).not.toContain("autoscaler");
		// The grounded key is built purely from the extraction facts (recall / ranking).
		expect(grounded.key.toLowerCase()).toMatch(/recall|ranking/);
	});

	it("isKeyGrounded: a key whose substantive tokens are all in the extraction is grounded; an extra noun is not", () => {
		const ex = extraction({ changes: ["fixed the SQL audit by routing values through sqlLike"] });
		// Grounded: every significant token is in the extraction (or an allowed connective).
		expect(isKeyGrounded("SQL audit fixed via sqlLike", ex)).toBe(true);
		// NOT grounded: "Terraform" is a noun absent from the extraction.
		expect(isKeyGrounded("Terraform module fixed the SQL audit", ex)).toBe(false);
	});

	it("deriveKeyFromExtraction is always grounded (built only from extracted facts)", () => {
		const ex = extraction({
			decisions: ["adopt RRF fusion for recall"],
			blockers: ["deeplake_hybrid_record returns all-zero scores"],
		});
		const key = deriveKeyFromExtraction(ex);
		expect(key).not.toBe("");
		// A key derived from the extraction is grounded in it by construction.
		expect(isKeyGrounded(key, ex)).toBe(true);
	});

	it("an unusable gate body (no JSON / empty summary) returns null so the worker writes nothing", () => {
		expect(parseSummaryGate("not json at all")).toBeNull();
		expect(parseSummaryGate(JSON.stringify({ extraction: {}, summary: "   ", key: "x" }))).toBeNull();
	});

	it("tolerates a fenced/prefixed JSON body (the host CLI may wrap the object)", () => {
		const fenced =
			"Here is the result:\n```json\n" +
			JSON.stringify({
				extraction: { changes: ["healed the missing key column"] },
				summary: "## Heal\nHealed the missing key column additively.",
				key: "missing key column — healed additively",
			}) +
			"\n```\n";
		const grounded = parseSummaryGate(fenced);
		expect(grounded).not.toBeNull();
		expect(grounded!.key).toContain("key column");
	});
});

describe("PRD-046 deferred durable-key generator — deriveDurableKey (memories.key on the write path)", () => {
	it("derives a non-empty, ≤1-sentence, keyword-forward key from a distilled fact", () => {
		const content =
			"All SQL values must route through sqlStr/sqlLike/sqlIdent; raw interpolation fails audit:sql.";
		const key = deriveDurableKey(content);
		expect(key.length).toBeGreaterThan(0);
		// One line, within the cap.
		expect(key).not.toContain("\n");
		expect(key.length).toBeLessThanOrEqual(MAX_KEY_CHARS);
		// Keyword-forward: it carries the operative identifiers, not a bland topic.
		expect(key).toMatch(/sqlStr|sqlLike|sqlIdent/);
	});

	it("takes the FIRST sentence of a multi-sentence fact (a headline, not the whole body)", () => {
		const content =
			"DeepLake reads are eventually consistent — always poll to convergence. Never do a single read. There is more detail after.";
		const key = deriveDurableKey(content);
		// Only the lead clause survives; the trailing sentences are dropped.
		expect(key).toContain("eventually consistent");
		expect(key).not.toContain("single read");
		expect(key).not.toContain("more detail");
		expect(key).not.toContain("\n");
	});

	it("is GROUNDED by construction: it invents no token absent from the fact content (b-AC-3)", () => {
		const content = "Switched recall fusion to RRF; native deeplake_hybrid_record returns all-zero scores.";
		const key = deriveDurableKey(content);
		// A durable key derived from the content can never confabulate — every token is in it.
		expect(isKeyGroundedInText(key, content)).toBe(true);
	});

	it("isKeyGroundedInText REJECTS a confabulated token absent from the fact content", () => {
		const content = "Tuned the recall ranking weights to improve precision.";
		// A key that smuggles in an un-asserted noun ("Kubernetes") is NOT grounded in the fact.
		expect(isKeyGroundedInText("Kubernetes autoscaler tuned the recall ranking", content)).toBe(false);
		// A key built only from the fact's own nouns IS grounded.
		expect(isKeyGroundedInText("recall ranking precision tuned", content)).toBe(true);
	});

	it("caps an over-long fact body to MAX_KEY_CHARS with an ellipsis", () => {
		const longFact = `${"a".repeat(MAX_KEY_CHARS + 50)} trailing`;
		const key = deriveDurableKey(longFact);
		expect(key.length).toBeLessThanOrEqual(MAX_KEY_CHARS + 1); // +1 for the ellipsis glyph
		expect(key.endsWith("…")).toBe(true);
	});

	it("REDACTION: a secret in the fact content never reaches the durable key (b-AC-5 floor)", () => {
		const content = "Configured the client with api_key=sk_live_ABCDEF0123456789XYZ for the daemon.";
		const key = deriveDurableKey(content);
		// The credential value is scrubbed before it can land in a key.
		expect(key).not.toContain("sk_live_ABCDEF0123456789XYZ");
		expect(key).toContain("[REDACTED]");
	});

	it("a blank / whitespace-only fact yields an empty key (the prime keeps its content fallback)", () => {
		expect(deriveDurableKey("")).toBe("");
		expect(deriveDurableKey("   \n  ")).toBe("");
	});
});
