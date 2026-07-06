/**
 * PRD-058b AC-55b.2.4 — the PRODUCTION in-process {@link KeepBothMemoStore}.
 *
 * Wave 1 wired the SEAMS: {@link KeepBothMemo} (the read side) on the detector
 * (`conflict-detect.ts`) and {@link KeepBothMemoStore} (the write side) on the
 * resolve endpoint (`conflicts-api.ts`). Both shipped with NO production
 * implementation — every caller either omitted the dep or injected a test fake.
 * This module IS the production implementation: a daemon-lifetime, in-process
 * `Map<string, true>` keyed on the NORMALIZED pair, exactly the shape of the test
 * fakes (`conflict-detect.spec.ts`, `conflict-api-recall.spec.ts`).
 *
 * ── Why in-process (and not a projection read) ───────────────────────────────
 * The memo's only consumer is the LIVE post-commit detection hook
 * (`createControlledWriteConflictHook`), which runs in THIS daemon process right
 * after a controlled write lands. A memory flagged `keep-both` and re-detected on
 * the very next write of either side would re-flag the pair without this memo, so
 * the load-bearing window is "since the daemon booted". An in-process `Map` covers
 * that window with zero Deep Lake reads — a projection read would add a query to
 * the write path for a signal that flips rarely (a `keep-both` verdict is rare).
 * A future durable projection (a `memory_history`-derived read on boot) is a
 * drop-in: this module's {@link KeepBothMemoStore} interface is the contract.
 *
 * ── The key ──────────────────────────────────────────────────────────────────
 * The key is the NORMALIZED pair per the existing {@link KeepBothMemo} contract:
 * `min(a, b) + ":" + max(a, b)`. The detector's read side already normalizes
 * (it calls `normalizeConflictPair` before `memo.has`), and the resolve endpoint
 * normalizes before `remember`, so the key here is the SAME normalized ids — but
 * to be defensive against a caller that bypasses normalization, this store
 * re-normalizes on BOTH `has` and `remember` (idempotent: a normalized pair
 * normalizes to itself). The single canonicalizer is reused (`memory-conflicts.ts`)
 * so there is one definition of "normalized", never two.
 *
 * Pure-ish: the only state is the `Map`; there are no I/O, no clocks, no throws.
 * Construct ONCE at boot (a daemon-lifetime object) and inject the SAME instance
 * into both the resolve endpoint (the writer) and the detection hook (the reader).
 */

import { normalizeConflictPair } from "../../storage/catalog/memory-conflicts.js";
import type { KeepBothMemoStore } from "./conflicts-api.js";

/**
 * Build the canonical memo key for a (possibly un-normalized) memory-id pair:
 * `min(a, b) + ":" + max(a, b)`. The pair is re-normalized here so a caller that
 * bypasses {@link normalizeConflictPair} cannot fragment the key (idempotent on
 * an already-normalized pair). Pure.
 */
function memoKey(aId: string, bId: string): string {
	const norm = normalizeConflictPair(aId, bId);
	return `${norm.aId}:${norm.bId}`;
}

/**
 * The PRODUCTION in-process {@link KeepBothMemoStore} (PRD-058b AC-55b.2.4).
 *
 * A daemon-lifetime `Map<string, true>` keyed on the normalized pair. Construct
 * ONCE at boot and inject the SAME instance into the resolve endpoint (the
 * `remember` writer) and the post-commit detection hook (the `has` reader), so a
 * `keep-both` verdict suppresses re-detection of the same pair on the next write
 * of either side — the load-bearing behavior. The store is synchronous and never
 * throws; the seams it satisfies are themselves fail-soft. A test injects the same
 * shape (`has`/`remember`) — this is just the production realization.
 *
 * @returns a {@link KeepBothMemoStore} backed by an in-process `Map`.
 */
export function createInProcessKeepBothMemoStore(): KeepBothMemoStore {
	const store = new Map<string, true>();
	return {
		has(aId: string, bId: string): boolean {
			return store.has(memoKey(aId, bId));
		},
		remember(aId: string, bId: string): void {
			store.set(memoKey(aId, bId), true);
		},
	};
}
