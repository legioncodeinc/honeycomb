/**
 * Explicit cross-project skill PROMOTION — PRD-049c D6 / 49c-AC-2 / 49c-AC-4.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * Promotion is the ONLY path that ever widens a skill past its origin project. It is an
 * EXPLICIT, provenance-recorded operation — NEVER an implicit default of mining or pull
 * (49c-AC-4). There are TWO distinct, explicit entry points (D6), exposed as one function
 * with a typed reach so a call site MUST name which it wants:
 *
 *   - `promoteToMyProjects(...)`  → `cross_project_scope = 'user'`  — surface in ANY of THIS
 *     user's projects (this-user-cross-project).
 *   - `promoteWorkspaceWide(...)` → `cross_project_scope = 'workspace'` — surface in EVERY
 *     project for EVERY teammate (workspace-wide).
 * ════════════════════════════════════════════════════════════════════════════
 *
 * ── Append-only, version-bumped (d-AC-1) ─────────────────────────────────────
 * A promotion does NOT mutate the mined row. It reads the skill's current (highest-version)
 * row through the {@link SkillStore}, then APPENDS a fresh version N+1 carrying the SAME body
 * + the SAME origin `project_id`, with the promotion columns stamped (`cross_project_scope`,
 * `promoted_by`, `promoted_at`, `promoted_from_project`). The origin `project_id` is PRESERVED
 * — promotion WIDENS surfacing, it does not MOVE the skill — and is recorded as
 * `promoted_from_project` so the surfaced result shows "promoted from <origin>" (49c-AC-2).
 *
 * ── Why this is a SEPARATE module from the mine write (49c-AC-4 structural) ──
 * The mine path (`writeSkill` → `buildSkill`) constructs NO `promotion` block — by
 * construction it can only ever write `cross_project_scope = 'none'`. Promotion lives HERE,
 * reachable only by an explicit operator action. The structural test asserts the mine + pull
 * rows carry `none` and that ONLY this module stamps a non-`none` reach — so no mining/pull
 * code path can drift into setting promotion.
 *
 * ── Storage (b-AC-6 / the daemon-only invariant) ────────────────────────────
 * Like every skills write, this goes through the daemon-side {@link SkillStore} seam — never a
 * re-opened DeepLake connection. The HTTP route that invokes it is a thin pure-wiring step.
 */

import type { CrossProjectScope, Skill, SkillPromotion, SkillStore } from "./contracts.js";
import { skillLogicalId } from "./contracts.js";

/** The non-`none` reach a promotion can target (the two explicit entry points, D6). */
export type PromotionReach = Exclude<CrossProjectScope, "none">;

/** Inputs to {@link promoteSkill} — the skill to promote + the explicit reach + who is acting. */
export interface PromoteSkillInput {
	/** The skill's logical name (`<name>` half of `<name>--<author>`). */
	readonly name: string;
	/** The skill's author (`<author>` half) — the version chain owner. */
	readonly author: string;
	/** The explicit reach: `user` (this user's projects) or `workspace` (all teammates). */
	readonly reach: PromotionReach;
	/** WHO is performing the promotion (recorded as `promoted_by`, visible provenance — 49c-AC-2). */
	readonly promotedBy: string;
	/** Injected clock for `promoted_at` (defaults to `new Date().toISOString()`); a test pins it. */
	readonly now?: () => string;
}

/** The outcome of a {@link promoteSkill} call. */
export interface PromoteSkillOutcome {
	/** True when the target skill existed and a promotion version row was appended. */
	readonly promoted: boolean;
	/** The logical id the promotion row was appended under (`<name>--<author>`), or null when absent. */
	readonly skillId: string | null;
	/** The reach stamped (`user` | `workspace`), or null when the target was absent. */
	readonly crossProjectScope: PromotionReach | null;
	/** The origin `project_id` recorded as `promoted_from_project`, or null when the target was absent. */
	readonly promotedFromProject: string | null;
	/** The append-only version the promotion row landed at, or null when the target was absent. */
	readonly version: number | null;
}

/** Construction deps for {@link promoteSkill}. */
export interface PromoteSkillDeps {
	/** The append-only skills store (the daemon's storage path — b-AC-6). */
	readonly store: SkillStore;
}

/**
 * Promote a skill across projects — the EXPLICIT, provenance-recorded operation (49c-AC-2 /
 * 49c-AC-4). Reads the skill's current highest-version row, then APPENDS version N+1 with the
 * promotion columns stamped, PRESERVING the body + the origin `project_id` (promotion widens
 * surfacing, never moves the skill). Returns `promoted: false` when the target does not exist
 * (nothing to promote) — never throws past the store seam.
 *
 * This is the SINGLE place a non-`none` `cross_project_scope` is ever written. The two explicit
 * reaches (`user` / `workspace`) are the D6 granularity; a caller MUST name one via `input.reach`.
 */
export async function promoteSkill(input: PromoteSkillInput, deps: PromoteSkillDeps): Promise<PromoteSkillOutcome> {
	const id = skillLogicalId(input.name, input.author);
	const current = await deps.store.readActive(id);
	if (current === null) {
		// Nothing to promote — a promotion never CREATES a skill, it only widens an existing one.
		return { promoted: false, skillId: null, crossProjectScope: null, promotedFromProject: null, version: null };
	}

	const now = (input.now ?? (() => new Date().toISOString()))();
	// The origin project is the skill's resolved `project_id`; preserved on the row AND recorded
	// as the promotion's `promoted_from_project` so the surfaced result shows "promoted from <origin>".
	const originProject = current.provenance.projectId ?? "";
	const promotion: SkillPromotion = {
		crossProjectScope: input.reach,
		promotedBy: input.promotedBy,
		promotedAt: now,
		promotedFromProject: originProject,
	};

	const nextVersion = (await deps.store.maxVersion(id)) + 1;
	// Append-only: a fresh version row carrying the SAME body + origin project, now PROMOTED.
	const promoted: Skill = {
		...current,
		provenance: {
			...current.provenance,
			version: nextVersion,
			projectId: originProject,
			promotion,
		},
	};
	const writtenVersion = await deps.store.appendVersion(promoted);

	return {
		promoted: true,
		skillId: id,
		crossProjectScope: input.reach,
		promotedFromProject: originProject,
		version: writtenVersion,
	};
}

/**
 * Entry point 1 (D6): promote to THIS USER's other projects (`cross_project_scope = 'user'`).
 * A thin, explicitly-named wrapper over {@link promoteSkill} so a call site cannot accidentally
 * pick the wrong reach — it must call THIS for the cross-project-this-user grant.
 */
export function promoteToMyProjects(
	input: Omit<PromoteSkillInput, "reach">,
	deps: PromoteSkillDeps,
): Promise<PromoteSkillOutcome> {
	return promoteSkill({ ...input, reach: "user" }, deps);
}

/**
 * Entry point 2 (D6): promote WORKSPACE-WIDE (`cross_project_scope = 'workspace'`) — every
 * project, every teammate. A thin, explicitly-named wrapper over {@link promoteSkill}.
 */
export function promoteWorkspaceWide(
	input: Omit<PromoteSkillInput, "reach">,
	deps: PromoteSkillDeps,
): Promise<PromoteSkillOutcome> {
	return promoteSkill({ ...input, reach: "workspace" }, deps);
}
