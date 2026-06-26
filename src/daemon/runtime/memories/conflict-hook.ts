/**
 * PRD-058b — the LIVE post-commit conflict-detection hook (C-1, the "completed != live" fix).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE WIRE that makes conflict detection RUN on the real daemon path. PRD-058b
 * shipped {@link detectAndProject} (detection over a candidate set → projection into
 * `memory_conflicts` + `memory_history`) and the recall-time κ gate
 * ({@link createConflictSuppressionSource}) fully implemented and unit-tested, but
 * NOTHING invoked the detector on a production write — so `memory_conflicts` stayed
 * empty, the κ gate always read empty, and two contradictory memories BOTH surfaced.
 * This module builds the {@link ControlledWriteConflictHook} the controlled-write
 * stage calls AFTER it lands a fact, closing that gap: a committed fact now runs
 * detection over the candidate set the decision stage already fetched.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── Where it sits in the pipeline ────────────────────────────────────────────
 *   decision stage  → fetches the candidate set + HYDRATES each candidate's content,
 *                     forwards `{ id, content }` on the `memory_controlled_write` job.
 *   controlled-write → lands the fact (append-only version bump), THEN calls this hook
 *                     with the committed `{ id, content }` + the forwarded candidates.
 *   THIS HOOK        → builds the voters, runs {@link detectAndProject} over the
 *                     candidate set (NO new table scan), projects any flagged pair into
 *                     `memory_conflicts` + appends `memory_history`.
 *   recall           → the κ gate ({@link createConflictSuppressionSource}) reads the
 *                     open projection and suppresses the loser — now non-empty.
 *
 * ── The invariants this hook honors (C-1) ────────────────────────────────────
 *  - OFF the write's critical section: the hook runs AFTER the commit, and the
 *    controlled-write handler additionally guards the call, so a slow/failing judge or
 *    a missing `memory_conflicts` table NEVER costs the user a memory or throws into the
 *    write. `detectAndProject` is fail-soft by construction (a down embed/model degrades
 *    to the lexical signal; a projection failure is swallowed by `projectConflict`).
 *  - Provider `none` SKIPS the model judge: when no {@link ModelClient} is injected, the
 *    detector uses `opp = opp_lexical` only (`conflict-detect.ts` `modelContradiction`).
 *  - APPEND-ONLY projection + poll-to-convergence read-back: inherited from
 *    {@link projectConflict} / {@link readConflictConverged} (the projection is a
 *    version-bumped append; the live verdict is `MAX(version)`).
 *  - The default OPEN verdict stays `review` (never auto-`supersede`): `detectAndProject`
 *    projects `status = 'open'` with the resolver's verdict; an operator confirms a
 *    `supersede` via the resolve endpoint unless `conflictAutoResolve` is on (default off,
 *    NOT applied here — this hook only DETECTS + projects, it never auto-applies).
 *
 * ── Why a separate module (the dependency arrow) ─────────────────────────────
 * The controlled-write stage (`pipeline/controlled-writes.ts`) declares the hook as a
 * PLAIN callback seam and does NOT import the detector — importing `conflict-resolve.ts`
 * there would invert the `memories → pipeline` arrow and cycle through `store.ts`. The
 * real hook is built HERE (the `memories` side, which already depends on `pipeline`) and
 * injected at the composition root (`assemble.ts`), exactly as the graph-persist fan-out
 * is injected via `onOutcome`.
 */

import type { QueryScope } from "../../storage/client.js";
import type {
	ControlledWriteCandidate,
	ControlledWriteConflictHook,
} from "../pipeline/controlled-writes.js";
import type { EmbedClient } from "../services/embed-client.js";
import type { ModelClient } from "../pipeline/model-client.js";
import { deriveClaimOutcome } from "./claim-outcome.js";
import {
	type CandidateVoter,
	type ConflictPersistDeps,
	type ConflictResolveParams,
	type DetectAndProjectDeps,
	detectAndProject,
} from "./conflict-resolve.js";
import type { ConflictDetectDeps, KeepBothMemo } from "./conflict-detect.js";

/** Construction deps for {@link createControlledWriteConflictHook}. */
export interface ControlledWriteConflictHookDeps {
	/** The DeepLake storage client (daemon-only) the projection writes through. */
	readonly storage: ConflictPersistDeps["storage"];
	/**
	 * The embed seam (005b) for claim-slot vectors. ABSENT/no-op → the detector's `sim` falls to the
	 * lexical-only path (a fact lands a `content_embedding` already, but the detector re-embeds the claim
	 * text; a down daemon degrades to lexical — fail-soft, never a throw).
	 */
	readonly embed?: EmbedClient;
	/**
	 * The model seam for `P_contradiction` (the `memory_extraction` workload). ABSENT → provider `none`:
	 * the model judge is SKIPPED and `opp = opp_lexical` (PRD-058b AC-55b.2.3). The daemon threads the
	 * real router-backed client; a test omits it (lexical-only detection).
	 */
	readonly model?: ModelClient;
	/** The `keep-both` memo (AC-55b.2.4); ABSENT → every write re-evaluates. */
	readonly memo?: KeepBothMemo;
	/** Detection-threshold overrides (`θ_detect`, escalation/conclusive floors). */
	readonly detectParams?: Omit<ConflictDetectDeps, "embed" | "model" | "memo">;
	/** Resolution tunables (γ, τ thresholds, ρ). */
	readonly resolveParams?: ConflictResolveParams;
	/** A clock for the projection/audit timestamps; defaults to wall-clock. */
	readonly now?: () => Date;
	/** An id generator for the conflict + audit rows; defaults to a UUID. */
	readonly newId?: () => string;
}

/**
 * Build the {@link ControlledWriteConflictHook} the controlled-write stage invokes after a committed
 * fact (PRD-058b LIVE / C-1). The hook assembles the committed memory + its forwarded candidate set into
 * {@link CandidateVoter}s, then runs {@link detectAndProject} over them — detection over the EXISTING
 * candidate set (no new scan), projecting any flagged pair into `memory_conflicts` + appending
 * `memory_history`. FAIL-SOFT: `detectAndProject` never throws (a down embed/model degrades to the
 * lexical signal; a projection failure is swallowed), so the hook returns the projected ids and never
 * propagates an error into the write.
 *
 * The OUTCOME (the claim value a voter asserts) is derived from each memory's content via
 * {@link deriveClaimOutcome}: opposite outcomes are what conflict, so the detector's `Contra` carries
 * the contradiction signal while the outcome string lets the resolver group agreeing-vs-competing votes.
 * The committed write is a DISTILLED `memory` (the high-provenance arm, `PROV_DISTILLED`); a forwarded
 * candidate is whatever arm it was stored as — both default to `memory` here (the durable arm), the
 * conservative provenance the resolver weights.
 */
export function createControlledWriteConflictHook(deps: ControlledWriteConflictHookDeps): ControlledWriteConflictHook {
	const detect: ConflictDetectDeps = {
		...(deps.embed !== undefined ? { embed: deps.embed } : {}),
		...(deps.model !== undefined ? { model: deps.model } : {}),
		...(deps.memo !== undefined ? { memo: deps.memo } : {}),
		...(deps.detectParams ?? {}),
	};
	const persist: ConflictPersistDeps = {
		storage: deps.storage,
		...(deps.now !== undefined ? { now: deps.now } : {}),
		...(deps.newId !== undefined ? { newId: deps.newId } : {}),
	};
	const projectDeps: DetectAndProjectDeps = {
		detect,
		persist,
		...(deps.resolveParams !== undefined ? { params: deps.resolveParams } : {}),
		...(deps.newId !== undefined ? { newConflictId: deps.newId } : {}),
	};

	return {
		async detect(
			committed: { readonly id: string; readonly content: string; readonly arm?: "memory" | "session" },
			candidates: readonly ControlledWriteCandidate[],
			scope: QueryScope,
		): Promise<{ readonly projectedIds: readonly string[] }> {
			// Nothing to detect against → no-op (mirrors the detector's candidate-bounded short-circuit).
			if (candidates.length === 0 || committed.id === "" || committed.content === "") {
				return { projectedIds: [] };
			}
			// Build the voter set: the just-committed memory PLUS each forwarded candidate. The outcome
			// (claim value) is derived from each memory's content; opposite outcomes compete in the resolver.
			const voters: CandidateVoter[] = [
				{
					id: committed.id,
					claimText: committed.content,
					outcome: deriveClaimOutcome(committed.content),
					arm: committed.arm ?? "memory",
				},
				...candidates.map((c) => ({
					id: c.id,
					claimText: c.content,
					outcome: deriveClaimOutcome(c.content),
					arm: "memory" as const,
				})),
			];
			// FAIL-SOFT (the C-1 invariant): detectAndProject degrades a down embed/model to the lexical
			// signal and swallows a non-ok projection write (the real StorageClient returns typed error
			// results). A RAW throw escaping the storage layer (a transport that rejects rather than
			// returning a result) is caught HERE so the hook's "never throws" contract holds independently
			// of the controlled-write handler's outer guard — a flagged-but-unprojectable pair degrades to
			// "no conflict this write", never an error into the committed write.
			try {
				const result = await detectAndProject(voters, scope, projectDeps);
				return { projectedIds: result.projectedIds };
			} catch {
				return { projectedIds: [] };
			}
		},
	};
}
