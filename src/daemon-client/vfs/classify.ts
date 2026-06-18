/**
 * Path classification — PRD-015a (a-AC-3 / index AC-2 / FR-5). PURE.
 *
 * `classifyPath(path)` maps a mount path to its {@link PathClass} so the intercept routes
 * the op. The contract (a-AC-3 / D-3):
 *
 *   - a VALID `goal/<owner>/<status>/<goal_id>.md` SHAPE        → `goal`
 *   - a VALID `kpi/<goal_id>/<kpi_id>.md` SHAPE                 → `kpi`
 *   - a `sessions/<...>` path                                  → `session`
 *   - a `graph/<...>` path (or bare `graph`)                   → `graph`
 *   - `index.md` at the mount root                             → `index`
 *   - ANYTHING malformed or otherwise                          → `memory`  (the fallback)
 *
 * The fallback to `memory` is the load-bearing rule (a-AC-3): a goal/kpi path that does NOT
 * match its exact shape (wrong status token, missing `.md`, too few segments) is NOT a
 * broken goal — it is a generic memory file. So a malformed goal path is surfaced as
 * `memory`, never silently dropped.
 *
 * Path-shape tolerance (Implementation notes): the mount appears in several shapes —
 * mount-relative (`goal/...`), host-absolute (`/home/u/.honeycomb/memory/goal/...`), a
 * test mount, a shell-redirect. `classifyPath` strips the prefix by the LAST occurrence of
 * `/memory/` (or a leading `memory/`), so every shape reduces to the same mount-relative
 * remainder before matching. Pure: no IO, deterministic.
 */

import type { PathClass } from "./contracts.js";

/** The valid goal status tokens in a `goal/<owner>/<status>/<goal_id>.md` path (FR-5). */
export const GOAL_STATUS_TOKENS = ["opened", "in_progress", "closed"] as const;
/** One valid goal status token. */
export type GoalStatusToken = (typeof GOAL_STATUS_TOKENS)[number];

const GOAL_STATUS_SET: ReadonlySet<string> = new Set(GOAL_STATUS_TOKENS);

/**
 * Reduce any accepted path shape to its mount-relative remainder (FR-5 / Implementation
 * notes). Strips a leading slash-run, then:
 *   - if `/memory/` occurs, keep everything AFTER the LAST occurrence (host-absolute,
 *     test-mount, shell-redirect shapes all collapse here);
 *   - else if it starts with `memory/`, drop that one prefix (mount-relative-with-root);
 *   - else return it as-is (already mount-relative: `goal/...`, `sessions/...`).
 * The result carries no leading slash and no `memory/` prefix.
 */
export function toMountRelative(path: string): string {
	const trimmed = path.replace(/^\/+/, "");
	const marker = "/memory/";
	const last = trimmed.lastIndexOf(marker);
	if (last >= 0) return trimmed.slice(last + marker.length);
	if (trimmed.startsWith("memory/")) return trimmed.slice("memory/".length);
	return trimmed;
}

/** Split a mount-relative path into non-empty segments. */
function segmentsOf(rel: string): string[] {
	return rel.split("/").filter((s) => s !== "");
}

/**
 * True for a VALID goal path SHAPE: `goal/<owner>/<status>/<goal_id>.md` — exactly four
 * segments, a recognized status token, a non-empty owner + goal_id, and a `.md` filename
 * (FR-5). A single malformed component fails the whole match (→ `memory`).
 */
function isGoalShape(segs: string[]): boolean {
	if (segs.length !== 4) return false;
	const [head, owner, status, file] = segs;
	if (head !== "goal") return false;
	if (owner === "") return false;
	if (!GOAL_STATUS_SET.has(status)) return false;
	return isMdFileWithStem(file);
}

/**
 * True for a VALID kpi path SHAPE: `kpi/<goal_id>/<kpi_id>.md` — exactly three segments, a
 * non-empty goal_id, and a `.md` filename with a non-empty stem (FR-5).
 */
function isKpiShape(segs: string[]): boolean {
	if (segs.length !== 3) return false;
	const [head, goalId, file] = segs;
	if (head !== "kpi") return false;
	if (goalId === "") return false;
	return isMdFileWithStem(file);
}

/** True for a `<non-empty-stem>.md` filename. */
function isMdFileWithStem(file: string): boolean {
	return file.endsWith(".md") && file.length > ".md".length;
}

/**
 * Classify a mount path into its {@link PathClass} (a-AC-3 / index AC-2). PURE. A valid
 * goal/kpi shape returns its kind; a sessions/graph path its kind; root `index.md` →
 * `index`; everything else (including a malformed goal/kpi shape) → `memory`.
 */
export function classifyPath(path: string): PathClass {
	const rel = toMountRelative(path);
	const segs = segmentsOf(rel);

	// Root index.md → the synthesized index (tier 2 of the read chain).
	if (segs.length === 1 && segs[0] === "index.md") return "index";

	// Sessions + graph are recognized by their head segment (any depth under them).
	const head = segs[0];
	if (head === "sessions") return "session";
	if (head === "graph") return "graph";

	// A VALID goal/kpi SHAPE → its kind. A malformed goal/kpi path falls through to memory.
	if (isGoalShape(segs)) return "goal";
	if (isKpiShape(segs)) return "kpi";

	// The generic fallback (a-AC-3): anything malformed or otherwise is a memory file.
	return "memory";
}
