/**
 * L-W6 (PRD-058b AC-55b.2.4) — the PRODUCTION in-process KeepBothMemoStore.
 *
 * The store is the production realization of the {@link KeepBothMemoStore} seam Wave 1 wired but
 * never implemented. It is a daemon-lifetime `Map<string, true>` keyed on the normalized pair, the
 * same shape as the test fakes (`conflict-detect.spec.ts`, `conflict-api-recall.spec.ts`). Covers:
 *   - `remember` then `has` for the SAME pair (in either order) → true.
 *   - a pair that was NEVER remembered → false.
 *   - the store prevents re-flagging of a known keep-both pair when injected into `detectConflicts`.
 *   - key normalization is idempotent: a normalized pair re-remembered does not fragment the key.
 */

import { describe, expect, it } from "vitest";

import { createInProcessKeepBothMemoStore } from "../../../../src/daemon/runtime/memories/keep-both-memo.js";
import {
	type ConflictCandidate,
	detectConflicts,
} from "../../../../src/daemon/runtime/memories/conflict-detect.js";

// Two memories whose lexical overlap + antonym flip would normally flag (Contra > θ_detect). The
// `slotEmbedding` makes `sim = 1` (cosine of identical vectors), so `Contra = sim · opp_lexical`
// clears θ_detect exactly as the conflict-detect.spec.ts suite asserts for this same text pair.
const VEC_SAME = [1, 0, 0, 0];
const A: ConflictCandidate = { id: "a", claimText: "the cache is enabled now", slotEmbedding: VEC_SAME };
const B: ConflictCandidate = { id: "b", claimText: "the cache is disabled now", slotEmbedding: VEC_SAME };

describe("L-W6 createInProcessKeepBothMemoStore — production keep-both memo (AC-55b.2.4)", () => {
	it("remembers a pair and reports it present (normalized, either order)", () => {
		const memo = createInProcessKeepBothMemoStore();
		expect(memo.has("a", "b")).toBe(false);
		memo.remember("a", "b");
		expect(memo.has("a", "b")).toBe(true);
		// The read side normalizes, so the reversed order must also hit.
		expect(memo.has("b", "a")).toBe(true);
	});

	it("a pair that was never remembered is absent", () => {
		const memo = createInProcessKeepBothMemoStore();
		memo.remember("a", "b");
		expect(memo.has("c", "d")).toBe(false);
	});

	it("re-remembering an already-memoized pair is a no-op (idempotent)", () => {
		const memo = createInProcessKeepBothMemoStore();
		memo.remember("a", "b");
		memo.remember("b", "a"); // reversed order, same normalized key.
		memo.remember("a", "b");
		expect(memo.has("a", "b")).toBe(true);
		expect(memo.has("x", "y")).toBe(false); // still only the one pair.
	});

	it("prevents re-flagging of a known keep-both pair when injected into detectConflicts", async () => {
		// Without the memo, this pair flags (Contra > θ_detect on the lexical antonym flip).
		const baseline = await detectConflicts([A, B], {});
		expect(baseline).toHaveLength(1);

		// With the production memo remembering the pair, detection is suppressed (AC-55b.2.4).
		const memo = createInProcessKeepBothMemoStore();
		memo.remember("a", "b");
		const flagged = await detectConflicts([B, A], { memo }); // reversed order, same pair.
		expect(flagged).toHaveLength(0);
	});
});
