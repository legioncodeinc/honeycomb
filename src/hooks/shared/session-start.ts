/**
 * Session-start core — PRD-019b Wave 2 (FR-3 / b-AC-3).
 *
 * Session-start runs, in order (FR-3): load credentials (prompt login or continue
 * read-only by harness policy), `healDriftedOrgToken`, `autoUpdate`, ensure the
 * `memory` and `sessions` tables, write a placeholder summary row, render the
 * rules/goals context block, `autoPullSkills`, spawn the graph-pull worker, and
 * return `additionalContext`. Steps 4 and 5 (table-ensure + placeholder) are gated
 * on `HONEYCOMB_CAPTURE !== "false"` — REUSE `src/shared/capture-gate.ts`, never
 * re-implement the gate here.
 *
 * THIN CLIENT: every storage-touching step (table-ensure, placeholder, context)
 * is a daemon call through the injected seams ({@link HookCoreDeps.daemon} for the
 * context block; {@link SessionStartSeams} for ensure/placeholder, whose real impls
 * POST to the daemon); this module opens NO DeepLake and builds NO SQL (b-AC-2 / D-2).
 *
 * The heal/update/pull steps already exist from prior PRDs — session-start CALLS
 * them through {@link SessionStartSeams}, it does NOT reimplement them. Every step is
 * FAIL-SOFT: a step that throws is absorbed (FR-10) so a heal/update/pull failure
 * never breaks session-start; the lifecycle still returns its `additionalContext`.
 */

import { shouldCapture } from "../../shared/capture-gate.js";
import {
	createNoopSessionStartSeams,
	type HookInput,
	type HookResult,
	type SessionStartDeps,
	type SessionStartSeams,
} from "./contracts.js";

/**
 * Run the session-start lifecycle (FR-3 / b-AC-3). Returns the {@link HookResult}
 * carrying the rendered `additionalContext` block; the shim routes it through its
 * harness's context channel (019c).
 *
 * Order (FR-3): credentials → heal → autoUpdate → [gated] ensureTables →
 * [gated] placeholder → render context → autoPullSkills → spawn graph-pull →
 * return `additionalContext`. The two gated steps run ONLY when the capture gate
 * says capture (`HONEYCOMB_CAPTURE !== "false"`); when capture is off, the tables
 * are not ensured and no placeholder row is written, but the context block STILL
 * renders (read-only) and is returned — recall is never disabled by the gate.
 */
export async function runSessionStart(input: HookInput, deps: SessionStartDeps): Promise<HookResult> {
	const seams: SessionStartSeams = deps.seams ?? createNoopSessionStartSeams();
	const meta = input.meta;

	// Step 1: load credentials (presence decides login-vs-read-only; never logged).
	const credential = await safe(() => deps.credentials.read(), undefined);

	// Step 2: reconcile a drifted org token. Fail-soft.
	await safeVoid(() => seams.healDriftedOrgToken(credential));

	// Step 3: self-update if a newer plugin exists. Fail-soft.
	await safeVoid(() => seams.autoUpdate());

	// Steps 4 + 5: table-ensure + placeholder — GATED on the capture gate (FR-3). The
	// gate is the pure `shouldCapture`; we only consult `captureFlag` here (plugin /
	// entrypoint / recursion are capture-path concerns). When capture is off, neither
	// step runs and NO `sessions`/`memory` write happens.
	const captureOn = shouldCapture({ captureFlag: deps.captureEnv?.captureFlag }).capture;
	if (captureOn) {
		await safeVoid(() => seams.ensureTables(meta));
		await safeVoid(() => seams.writePlaceholderSummary(meta));
	}

	// Step 6: render the rules/goals context block (READ-ONLY, fail-soft — the
	// renderer absorbs its own errors and returns "" on failure, FR-10).
	const contextBlock = await safe(() => deps.context.render({ meta, runtimePath: input.runtimePath, credential }), "");

	// Step 6.5 (PRD-046d / d-AC-1..5): fetch the session-start memory prime ONCE
	// (d-AC-3 — this is the session-start branch; per-turn capture never primes) and
	// append it to the context block. READ-ONLY + fail-soft: the renderer absorbs its
	// own errors and a cold (`empty:true`) repo yields "", so an unreachable daemon or
	// an empty scope contributes NOTHING and never blocks/errors session-start (d-AC-4).
	// The hook does NO assembly — it injects 046c's already-bounded digest verbatim
	// (d-AC-5). When no prime seam is wired, this is a no-op (prior behaviour unchanged).
	const primeBlock =
		deps.prime !== undefined
			? await safe(
					() =>
						(deps.prime as NonNullable<typeof deps.prime>).render({ meta, runtimePath: input.runtimePath, credential }),
					"",
				)
			: "";

	// The injected `additionalContext` is the rendered rules/goals block plus the prime
	// digest, joined when both are present so neither is lost. Either alone is returned
	// as-is; both empty omits `additionalContext` entirely.
	const additionalContext = joinBlocks(contextBlock, primeBlock);

	// Step 7: pull team/org skills. Fail-soft.
	await safeVoid(() => seams.autoPullSkills(credential));

	// Step 7b (PRD-033 R-1): pull team/org synced ASSETS and install them in-process. Unlike
	// the skills pull (a fire-and-forget daemon POST), this runs the thin-client install locally
	// (the daemon returns rows; this client writes the files). Idempotent + fail-soft + bounded by
	// the assets thin client's own 5s budget. Ordered right after the skills pull, before graph-pull.
	await safeVoid(() => seams.autoPullAssets(credential));

	// Step 8: spawn the detached graph-pull worker (fire-and-forget). Fail-soft.
	await safeVoid(() => seams.spawnGraphPull(meta));

	// Step 9: return the rendered block; the shim chooses the channel (c-AC-5).
	return additionalContext === "" ? { ok: true } : { ok: true, additionalContext };
}

/**
 * Join the rules/goals context block and the 046d prime digest into one
 * `additionalContext` payload. Either-empty returns the other unchanged; both-empty
 * returns `""` (the caller omits `additionalContext`); both-present are separated by a
 * blank line so the two blocks stay legible to the model.
 */
function joinBlocks(context: string, prime: string): string {
	if (context === "") return prime;
	if (prime === "") return context;
	return `${context}\n\n${prime}`;
}

/** Run a producing step, returning `fallback` if it throws (fail-soft, FR-10). */
async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
	try {
		return await fn();
	} catch {
		return fallback;
	}
}

/** Run a side-effecting step, absorbing any throw (fail-soft, FR-10). */
async function safeVoid(fn: () => Promise<void>): Promise<void> {
	try {
		await fn();
	} catch {
		// A heal/update/ensure/pull/spawn failure never breaks session-start.
	}
}
