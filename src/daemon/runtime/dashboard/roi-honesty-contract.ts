/**
 * The honesty-contract COMPILE-TIME witness — PRD-060b (b-AC-4), enforced by `tsc`.
 *
 * This module carries NO executed runtime logic. It exists so the `npm run typecheck` gate (which
 * excludes `*.test.ts`, so a `@ts-expect-error` inside a test is NOT enforced) proves the honesty
 * contract STRUCTURALLY: a `measured` value can never be derived from a `modeled` input, and any
 * aggregate folding a modeled term is itself `modeled`. The `@ts-expect-error` lines below FAIL the
 * typecheck if the engine's types ever loosen to permit a measured-from-modeled derivation — that is
 * the structural enforcement b-AC-4 demands (not a naming convention).
 *
 * The assertions live inside {@link _honestyContractWitness}, which is NEVER called: the function body
 * is type-checked by `tsc` but its (deliberately ill-typed) call expressions never run, so importing
 * this module is side-effect-free. {@link HONESTY_CONTRACT_WITNESSED} is the only runtime export — a
 * harmless `true` a test can touch so the witness participates in the build graph.
 */

import {
	type Measured,
	type Modeled,
	type NetRoi,
	measuredCacheSavings,
	modeledMemoryInjectionSavings,
	netRoi,
} from "./roi-savings.js";

/**
 * The compile-time contract witness. NEVER invoked — `tsc` checks the body, the runtime never runs it.
 * Each `@ts-expect-error` asserts a derivation the type system MUST forbid; if any becomes "unused"
 * (the types loosened), `tsc` errors and the build is correctly red.
 */
function _honestyContractWitness(): void {
	// A modeled value — the poison input the measured path must reject.
	const someModeled: Modeled<unknown> = modeledMemoryInjectionSavings(5);

	// CONTRACT 1 — `measuredCacheSavings` takes `readonly CapturedTurn[]`, never a `Modeled<…>`. Passing a
	// modeled value MUST be a type error, so a measured figure can never be derived from a modeled input.
	// @ts-expect-error — Modeled<…> is not assignable to readonly CapturedTurn[] (b-AC-4).
	const _rejectModeledIntoMeasured: Measured<unknown> = measuredCacheSavings(someModeled);

	// CONTRACT 2 — `netRoi` folds a modeled term, so its return is `Modeled<NetRoi>`. Assigning the net to
	// a `Measured<…>` MUST be a type error: the est. taint propagates through the type.
	const net = netRoi(measuredCacheSavings([]), modeledMemoryInjectionSavings(1));
	// @ts-expect-error — Modeled<NetRoi> is not assignable to Measured<NetRoi>; the net is tainted (b-AC-4).
	const _netIsNotMeasured: Measured<NetRoi> = net;

	// CONTRACT 3 (positive) — the net IS a `Modeled<…>`; this assignment compiles, witnessing the taint
	// landed on the right side. (No `@ts-expect-error`: this line must typecheck.)
	const _netIsModeled: Modeled<NetRoi> = net;

	// Reference the locals so "declared but never read" does not fire (the assignments are the assertion).
	void _rejectModeledIntoMeasured;
	void _netIsNotMeasured;
	void _netIsModeled;
}

// Reference the witness so it is not "declared but never used"; it is never CALLED (side-effect-free).
void _honestyContractWitness;

/** A harmless runtime marker a test touches so the witness module stays in the build graph (b-AC-4). */
export const HONESTY_CONTRACT_WITNESSED = true as const;
