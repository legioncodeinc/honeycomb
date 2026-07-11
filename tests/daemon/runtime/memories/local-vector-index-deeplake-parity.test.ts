/**
 * PRD-078a D-3 — LIVE-GROUNDED `<#>` score parity for the local ANN index.
 *
 * The sibling `local-vector-index.test.ts` cross-checks the index against a JS `((1+cos)/2)`
 * reference. This suite adds the parity that was MISSING: a live oracle. The `<#>` operator's
 * ACTUAL semantics were measured against the production Deep Lake store (2026-07-09):
 *
 *   - `<#>` is TRUE COSINE SIMILARITY — it normalizes BOTH operands. Scaling the query vector by 2
 *     left `content_embedding <#> q` byte-unchanged (ratio 1.0), and `emb <#> q` reproduced
 *     `dot(emb,q)/(|emb|·|q|)` to ~2e-8. It is NOT a raw or negative inner product.
 *   - The stored `content_embedding` and the nomic-q8 query are unit-normalized (|v| ∈ [0.9999994,
 *     1.0000003]), so `<#>` here also equals the raw dot — but the operator itself is the cosine.
 *   - Therefore `((1 + (emb <#> q)) / 2)` == `((1 + cosine)/2)` == `deeplakeCosineScore(q, emb)`,
 *     confirmed across a real top-5 to ~4e-8.
 *
 * The fixture `__fixtures__/deeplake-cosine-parity.json` bakes the measured (q, emb, deeplakeScore)
 * oracle straight from that live query, so this test fails the instant the local scorer stops
 * matching the operator (e.g. a regression to raw dot on a future non-unit embedding model).
 *
 * No `.skip` / `.only`; pure in-process; `vitest run` is CI.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { deeplakeCosineScore } from "../../../../src/daemon/storage/vector.js";
import { InMemoryLocalVectorIndex } from "../../../../src/daemon/runtime/memories/local-vector-index.js";
import type { StorageRow } from "../../../../src/daemon/storage/result.js";

interface ParityFixture {
	readonly queryText: string;
	readonly q: number[];
	readonly hits: readonly { readonly id: string; readonly emb: number[]; readonly deeplakeScore: number }[];
}

const fixture: ParityFixture = JSON.parse(
	readFileSync(fileURLToPath(new URL("./__fixtures__/deeplake-cosine-parity.json", import.meta.url)), "utf8"),
) as ParityFixture;

function memoryRow(id: string, embedding: number[]): StorageRow {
	return { id, content: `content for ${id}`, content_embedding: embedding, project_id: "proj-A", created_at: "", is_deleted: 0 };
}

// ── Live-grounded oracle: the local scorer reproduces Deep Lake's `((1+<#>)/2)` per hit ──────────

describe("PRD-078a D-3: deeplakeCosineScore matches the LIVE Deep Lake `((1+<#>)/2)` oracle", () => {
	it("equals the measured `<#>`-normalized score for every fixture (q, emb) within 1e-3", () => {
		expect(fixture.hits.length).toBeGreaterThanOrEqual(5);
		for (const hit of fixture.hits) {
			const local = deeplakeCosineScore(fixture.q, hit.emb);
			expect(local).not.toBeNull();
			// The oracle is the value Deep Lake's `<#>` SQL returned for this exact pair.
			expect(local as number).toBeCloseTo(hit.deeplakeScore, 3);
		}
	});

	it("the top hit's oracle is ~0.869 (a real hit magnitude — NOT the ~0.016 of a broken scorer)", () => {
		const top = fixture.hits[0]!;
		expect(top.deeplakeScore).toBeGreaterThan(0.8);
		expect(deeplakeCosineScore(fixture.q, top.emb) as number).toBeGreaterThan(0.8);
	});
});

// ── Ranking + magnitude parity: the index's scored+sorted output matches the `<#>` oracle ───────

describe("PRD-078a D-3: InMemoryLocalVectorIndex.search matches the live `<#>` oracle in ORDER and SCORE", () => {
	it("search over the live fixture returns the same ids in the same order with the same magnitudes", () => {
		const index = new InMemoryLocalVectorIndex();
		index.buildFromRows(fixture.hits.map((h) => memoryRow(h.id, h.emb)));

		const got = index.search(fixture.q, "proj-A", fixture.hits.length);

		// The Deep Lake reference: the hits already came back ORDER BY score DESC.
		const refOrder = [...fixture.hits].sort((a, b) => b.deeplakeScore - a.deeplakeScore);
		expect(got.map((r) => r.id)).toEqual(refOrder.map((h) => h.id));
		got.forEach((r, i) => {
			// Same magnitude as the live `<#>` score — the index and the SQL fallback are interchangeable.
			expect(r.score as number).toBeCloseTo(refOrder[i]!.deeplakeScore, 3);
		});
	});
});

// ── The decisive semantic: deeplakeCosineScore NORMALIZES (like `<#>`), it is not a raw dot ──────

describe("PRD-078a D-3: deeplakeCosineScore is COSINE (normalizes), matching `<#>`'s measured semantics", () => {
	/** A hand-computed `((1 + cosine)/2)` reference — the exact `<#>` normalization proven live. */
	function cosineNorm(a: readonly number[], b: readonly number[]): number {
		let dot = 0, ma = 0, mb = 0;
		for (let i = 0; i < a.length; i += 1) {
			dot += a[i]! * b[i]!;
			ma += a[i]! * a[i]!;
			mb += b[i]! * b[i]!;
		}
		return (1 + Math.min(1, Math.max(-1, dot / (Math.sqrt(ma) * Math.sqrt(mb))))) / 2;
	}

	it("is invariant to query scale (as `<#>` was measured to be): score(q) == score(2q)", () => {
		const emb = fixture.hits[0]!.emb;
		const q = fixture.q;
		const q2 = q.map((x) => x * 2); // a NON-unit query — a raw-dot scorer would DOUBLE here.
		const s1 = deeplakeCosineScore(q, emb) as number;
		const s2 = deeplakeCosineScore(q2, emb) as number;
		expect(s2).toBeCloseTo(s1, 6); // unchanged → it normalizes, exactly like Deep Lake's `<#>`.
	});

	it("equals the hand-computed cosine normalization for NON-unit vectors (where raw dot would diverge)", () => {
		const a = [3, 0, 0, 0];
		const b = [0, 4, 0, 0]; // orthogonal, non-unit → cosine 0 → normalized 0.5; raw dot 0 too, so use a skewed pair:
		expect(deeplakeCosineScore(a, b) as number).toBeCloseTo(0.5, 6);

		const c = [2, 2, 0, 0]; // |c| = 2√2
		const d = [10, 0, 0, 0]; // |d| = 10 ; cosine = 20/(2√2·10) = 1/√2 ≈ 0.7071 → norm ≈ 0.8536
		expect(deeplakeCosineScore(c, d) as number).toBeCloseTo(cosineNorm(c, d), 6);
		expect(deeplakeCosineScore(c, d) as number).toBeCloseTo(0.853553, 5);
	});

	it("returns null on an unusable pair (mismatched length / zero vector), like cosineSimilarity", () => {
		expect(deeplakeCosineScore([1, 2, 3], [1, 2])).toBeNull();
		expect(deeplakeCosineScore([0, 0, 0], [1, 2, 3])).toBeNull();
	});
});
