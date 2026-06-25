/**
 * Skillify contracts + seams — PRD-016 Wave 1 (the typed shapes 016a / 016b / 016c
 * all code against).
 *
 * Skillify mines recurring session patterns, crystallizes a reusable `SKILL.md`,
 * and propagates it to the team. The pipeline has three sub-PRDs that meet ONLY at
 * these contracts:
 *
 *   - 016a (trace miner, `miner.ts`) — trigger + lock + session fetch + pair
 *     extraction + the gate-CLI shell-out. PRODUCES a {@link GateVerdict} over a
 *     batch of {@link MinedPair}s.
 *   - 016b (skills writes, `skills-write.ts` + `watermark.ts`, THIS WAVE, FULL) —
 *     CONSUMES a verdict: writes the `SKILL.md` + an APPEND-ONLY version row into the
 *     existing `skills` table, advances the watermark.
 *   - 016c (skill install, `install.ts`) — pull + auto-pull + symlink fan-out.
 *     CONSUMES 016b's append-only rows (reads highest-version-per-(name,author)).
 *
 * ── The two non-negotiable invariants every seam encodes ─────────────────────
 *   1. APPEND-ONLY, VERSION-BUMPED writes. b-AC-1 LITERALLY requires "a new version
 *      row, never an in-place UPDATE." The active skill for a logical id is its
 *      HIGHEST-version row, resolved poll-convergently (a single read under-reports
 *      on the live backend). This is the SAME mechanic `memory_jobs`,
 *      `ontology/supersede.ts`, and `sources/lifecycle.ts` all proved live.
 *   2. THE HOOK SIGNALS THE DAEMON; THE DAEMON OWNS THE ONLY DEEPLAKE CONNECTION.
 *      016b runs INSIDE the daemon, so its storage seam IS the daemon-side
 *      {@link SkillStore} (a thin wrapper over `StorageQuery`). A skills write never
 *      re-opens DeepLake — it goes through the storage path the daemon already holds
 *      (b-AC-6). The hook half (016a's trigger) lives on the thin-client side and
 *      signals the daemon over port 3850; it is OUT of 016b's scope.
 *
 * ── Boundary vs interior (where zod lives) ──────────────────────────────────
 * The shapes 016a BUILDS ({@link MinedPair}, {@link GateVerdict}) and 016b WRITES
 * ({@link Skill}, {@link SkillProvenance}) are plain TS interfaces — they are
 * constructed in-process from already-trusted data, so a runtime re-validation would
 * be ceremony (mirrors `sources/contracts.ts` + `ontology/contracts.ts`). zod
 * validates at the UNTRUSTED boundary (the CLI / API config), which 016a/016c own.
 *
 * Every value these contracts carry is eventually interpolated into SQL by
 * `skills-write.ts` through the `sqlStr` / `sLiteral` / `val.*` helpers — the
 * contracts hold the data, the writer escapes it.
 */

// ────────────────────────────────────────────────────────────────────────────
// MinedPair — one extracted prompt/answer exchange (016a produces; 016b reads).
// ────────────────────────────────────────────────────────────────────────────

/**
 * One extracted prompt/answer exchange from a mined session (016a-AC-1). The miner
 * (016a) extracts the last N in-scope exchanges past the watermark — dropping
 * tool-calls + thinking, capping each pair at 2000 chars and the batch at 40000 —
 * and hands the batch to the gate. 016b never extracts; it only reads the batch's
 * `sessionId` / `sessionDate` to derive provenance + the watermark advance.
 *
 * - `sessionId`   the session the exchange came from (provenance — `source_sessions`).
 * - `sessionDate` the session's ISO date; the watermark advances to the OLDEST of
 *                 these across the batch (016b-AC-2 / FR-8).
 * - `prompt`      the user turn (tool-calls + thinking already stripped by 016a).
 * - `answer`      the assistant turn.
 */
export interface MinedPair {
	/** The session id this exchange came from (provenance). */
	readonly sessionId: string;
	/** The session's ISO-8601 date (the watermark advances to the oldest). */
	readonly sessionDate: string;
	/** The user turn (tool-calls / thinking stripped upstream). */
	readonly prompt: string;
	/** The assistant turn. */
	readonly answer: string;
}

// ────────────────────────────────────────────────────────────────────────────
// GateVerdict — the gate's KEEP | MERGE | SKIP decision (016a produces; 016b acts).
// ────────────────────────────────────────────────────────────────────────────

/** The three gate decisions, frozen so the type + the writer's switch read one source. */
export const GATE_VERDICTS = Object.freeze(["KEEP", "MERGE", "SKIP"] as const);
/** A single gate decision. */
export type GateDecision = (typeof GATE_VERDICTS)[number];

/**
 * The gate's verdict over a mined batch (016a-AC-2 / D-3). The gate (a host-CLI
 * shell-out, no API key — {@link GateCli}) returns EXACTLY one decision:
 *
 *   - `KEEP`  → a non-obvious pattern recurring across ≥3 exchanges, not already
 *              covered. 016b writes a NEW skill (`SKILL.md` + append-only row).
 *   - `MERGE` → the pattern refines an EXISTING skill named by `target`. 016b bumps
 *              the existing skill; if `target` is absent locally, it FALLS BACK to a
 *              new skill so the body is not lost (016b-AC-3 / FR-4).
 *   - `SKIP`  → nothing worth crystallizing. 016b writes no file + no row, but the
 *              watermark STILL advances (016b-AC-2 / FR-9).
 *
 * The skill payload (`name` / `description` / `triggerText` / `body`) is present on
 * KEEP and MERGE, absent on SKIP. `targetAuthor` distinguishes a same-author bump
 * from a CROSS-author merge (which promotes scope `me`→`team`, 016b-AC-4 / FR-7).
 */
export interface GateVerdict {
	/** The decision the gate returned. */
	readonly decision: GateDecision;
	/** The skill's logical name (KEEP / MERGE). Absent on SKIP. */
	readonly name?: string;
	/** A one-line description for the frontmatter + the row. */
	readonly description?: string;
	/** The trigger text (when to invoke the skill). */
	readonly triggerText?: string;
	/** The crystallized SKILL.md body (KEEP / MERGE). Absent on SKIP. */
	readonly body?: string;
	/** On MERGE: the existing skill's name to bump. Absent on KEEP / SKIP. */
	readonly target?: string;
	/** On MERGE: the existing skill's author — a cross-author merge promotes scope. */
	readonly targetAuthor?: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Skill + SkillProvenance — the row 016b writes (mirrors the `skills` table).
// ────────────────────────────────────────────────────────────────────────────

/**
 * A skill's scope (D-7 / FR-7). `me` is a personal skill; `team` is co-owned. A
 * cross-author MERGE auto-promotes `me`→`team` so a later `pull` knows the skill is
 * shared (016b-AC-4). Frozen so the type + the promotion logic read one source.
 */
export const SKILL_SCOPES = Object.freeze(["me", "team"] as const);
/** A skill scope. */
export type SkillScope = (typeof SKILL_SCOPES)[number];

/** Where the `SKILL.md` lands (016b-AC-5 / D-8). `project` → cwd; `global` → home. */
export const SKILL_INSTALLS = Object.freeze(["project", "global"] as const);
/** A skill install target. */
export type SkillInstall = (typeof SKILL_INSTALLS)[number];

/**
 * The cross-project promotion marker (PRD-049c D6 / 49c-AC-2 / 49c-AC-4). It is ORTHOGONAL
 * to {@link SkillScope} (`me`/`team`, the publish/co-ownership axis) and governs WHICH of a
 * user's PROJECTS surface a skill:
 *
 *   - `none`       project-scoped — surfaces ONLY in its origin `project_id` (the mine/pull
 *                  DEFAULT; isolation, 49c-AC-1). A mined or pulled skill is ALWAYS `none`.
 *   - `user`       this-user-cross-project — surfaces in ANY of the promoting user's projects
 *                  (49c-AC-2). Set ONLY by the explicit `promote --cross-project` operation.
 *   - `workspace`  workspace-wide — surfaces in EVERY project for EVERY teammate (49c-AC-2).
 *                  Set ONLY by the explicit `promote --workspace` operation.
 *
 * Frozen so the type, the surfacing predicate, and the promote operations read ONE source.
 * NO mining path and NO pull path ever sets a value other than `none` (49c-AC-4 — the
 * structural test asserts the mine + pull rows carry `none`).
 */
export const CROSS_PROJECT_SCOPES = Object.freeze(["none", "user", "workspace"] as const);
/** A cross-project promotion marker (PRD-049c D6). */
export type CrossProjectScope = (typeof CROSS_PROJECT_SCOPES)[number];

/** Narrow an arbitrary string to a known {@link CrossProjectScope}, defaulting to `none` (fail-closed: never wider). */
export function asCrossProjectScope(raw: string): CrossProjectScope {
	return (CROSS_PROJECT_SCOPES as readonly string[]).includes(raw) ? (raw as CrossProjectScope) : "none";
}

/**
 * The provenance frontmatter every mined `SKILL.md` carries (FR-2) and the
 * provenance columns the `skills` row records. A teammate reads this to know WHO
 * mined the skill, FROM WHICH sessions, at WHAT version, and its scope — so a pull
 * is traceable (016b-AC-1).
 *
 * - `sourceSessions` the session ids the skill was mined from (→ `source_sessions`).
 * - `version`        the append-only version this row sits at (→ `version`).
 * - `createdBy`      the author/agent that mined it (→ `author` / `agent_id`).
 * - `scope`          `me` | `team` (→ `scope`; cross-author merge promotes it).
 */
export interface SkillProvenance {
	/** The session ids the skill was mined from. */
	readonly sourceSessions: readonly string[];
	/** The append-only version (highest = current). */
	readonly version: number;
	/** The author/agent that mined the skill. */
	readonly createdBy: string;
	/** The skill's scope (`me` | `team`). */
	readonly scope: SkillScope;
	/**
	 * PRD-049c (49c-AC-1 / 49c-AC-5): the RESOLVED registry key (049a) the skill is scoped to —
	 * stamped at MINE time from the session cwd (`resolveScopeFromDisk`). An identity-less session
	 * resolves to the workspace {@link UNSORTED_PROJECT_ID} inbox (49c-AC-5, mirroring 049b
	 * capture). The surfacing predicate ({@link import("../recall/scope-clause.js").buildProjectScopeClause})
	 * filters on this so a skill mined in project A never surfaces in project B. ABSENT/blank on a
	 * legacy pre-049c row → the unset sentinel `''`, admitted at read alongside the session's
	 * project + the inbox (back-compat, D5). Defaults to the inbox in the writer when unset.
	 */
	readonly projectId?: string;
	/**
	 * PRD-049c (49c-AC-2 / 49c-AC-4 / D6): the EXPLICIT cross-project promotion + its provenance.
	 * ABSENT on every mined or pulled row — mining and pull NEVER promote (49c-AC-4); the row then
	 * records `cross_project_scope = 'none'`. PRESENT only on a row written by one of the two
	 * explicit promote operations ({@link promoteSkill}), carrying WHO promoted it, WHEN, and the
	 * ORIGIN project it was promoted FROM (visible cross-project provenance on the surfaced result,
	 * 49c-AC-2).
	 */
	readonly promotion?: SkillPromotion;
}

/**
 * The explicit cross-project promotion provenance (PRD-049c D6 / 49c-AC-2 / 49c-AC-4). Recorded
 * ONLY by the two explicit promote operations — never by mining, never by pull. A surfaced
 * cross-project skill carries this so the user SEES it is shared across projects and from where.
 */
export interface SkillPromotion {
	/** The promotion reach — `user` (this user's projects) or `workspace` (all teammates). Never `none` here. */
	readonly crossProjectScope: Exclude<CrossProjectScope, "none">;
	/** WHO promoted the skill (the acting user/agent) — visible provenance (49c-AC-2). */
	readonly promotedBy: string;
	/** WHEN the promotion happened (ISO-8601) — visible provenance (49c-AC-2). */
	readonly promotedAt: string;
	/** The ORIGIN `project_id` the skill was promoted FROM — surfaced as "promoted from <project>" (49c-AC-2). */
	readonly promotedFromProject: string;
}

/**
 * A skill row — the shape that mirrors the existing `skills` catalog table
 * (`product.ts` SKILLS_COLUMNS, `pattern: "version-bumped"`). 016b writes one of
 * these per version; the ACTIVE skill for a logical id is the HIGHEST-version row.
 *
 * The LOGICAL id is `<name>--<author>` (see {@link skillLogicalId}): every version
 * of a skill by the same author shares it, so the highest-version read resolves the
 * current skill and a same-author re-KEEP bumps the same chain (016b-AC-1).
 */
export interface Skill {
	/** The logical id `<name>--<author>` — the version-chain key. */
	readonly id: string;
	/** The skill's logical name. */
	readonly name: string;
	/** The author/agent that mined the skill (the creator — maps to `author`/`agent_id`). */
	readonly author: string;
	/** A one-line description. */
	readonly description: string;
	/** The trigger text. */
	readonly triggerText: string;
	/** The crystallized SKILL.md body. */
	readonly body: string;
	/** Where the SKILL.md was installed (`project` | `global`). */
	readonly install: SkillInstall;
	/** The provenance (sessions / version / createdBy / scope). */
	readonly provenance: SkillProvenance;
	/**
	 * The recorded contributor list (PRD-018a a-AC-4 / FR-8). Absent on a plain KEEP (the
	 * row's `contributors` then defaults to just the author). On a CROSS-author MERGE it
	 * carries the `skillopt` lineage marker ({@link SKILLOPT_CONTRIBUTOR}) + the ORIGINAL
	 * author, so a later pull surfaces that a machine merge co-owned the skill — distinct
	 * from a human contributor. The writer (`contributorsFor`) honors this when present.
	 */
	readonly contributors?: readonly string[];
}

/**
 * The lineage marker stamped into a cross-author merge's `contributors` (PRD-018a a-AC-4 /
 * FR-8). It distinguishes a MACHINE merge (the skillify gate folded one author's skill into
 * another's) from a human contributor, so the provenance is honest about how co-ownership
 * arose. A row carrying `skillopt` was merged across authors; the original author rides
 * alongside it.
 */
export const SKILLOPT_CONTRIBUTOR = "skillopt" as const;

/**
 * Derive a skill's stable LOGICAL id from its name + author (the version-chain key,
 * 016b-AC-1). Every version of a skill by the same author resolves the SAME id, so
 * the highest-version read is the current skill and a re-KEEP bumps the same chain.
 * A cross-author merge writes under the TARGET author's id, so the bump accrues on
 * the original chain (the scope promotes `me`→`team`). Pure + deterministic.
 *
 * Format `<name>--<author>` mirrors the 016c install-dir convention
 * (`~/.claude/skills/<name>--<author>/`). Both halves are kept verbatim; the writer
 * escapes the value before it touches SQL, so no sanitization happens here.
 */
export function skillLogicalId(name: string, author: string): string {
	return `${name}--${author}`;
}

// ────────────────────────────────────────────────────────────────────────────
// GateCli SEAM — the host-CLI shell-out (016a owns the real impl; faked in tests).
// ────────────────────────────────────────────────────────────────────────────

/**
 * THE gate seam (D-3 / 016a-AC-2 / 016a-AC-6). The gate model is NOT called with an
 * API key — it SHELLS OUT to the host agent's CLI (Claude Code / Codex / …), which
 * already holds the user's auth. 016a fills the real shell-out (a `spawn` with an
 * args array — NEVER a shell string, so a mined transcript can't command-inject) and
 * enforces the 120s timeout → abort-no-verdict + lock-released-in-`finally`.
 *
 * 016b does NOT call this — it receives the already-computed {@link GateVerdict}. The
 * seam is pinned HERE so 016a implements exactly it and every test fakes it
 * deterministically (there is no host CLI in the test env).
 *
 * `run` takes the assembled gate prompt and resolves to the verdict; a timeout /
 * crash rejects (016a aborts the run, releases the lock, writes nothing).
 */
export interface GateCli {
	/** Shell out to the host CLI with the gate prompt; resolve to the verdict. */
	run(prompt: string): Promise<GateVerdict>;
}

/**
 * Build a deterministic FAKE {@link GateCli} that returns a fixed verdict (the test
 * double — there is no host CLI in this env). 016a's own tests drive the real
 * shell-out; 016b's tests construct a verdict directly and never need this, but it is
 * pinned here so the seam has one canonical fake.
 */
export function createFakeGateCli(verdict: GateVerdict): GateCli {
	return {
		async run(): Promise<GateVerdict> {
			return verdict;
		},
	};
}

// ────────────────────────────────────────────────────────────────────────────
// SkillInstall SEAM — where the SKILL.md lands (injectable base dir for tests).
// ────────────────────────────────────────────────────────────────────────────

/**
 * The local `SKILL.md` writer/reader seam (016b-AC-5 / FR-1 / FR-3). 016b writes the
 * crystallized markdown HERE: `install=project` → `<cwd>/.claude/skills/<name>/`;
 * `install=global` → `~/.claude/skills/<name>/`. The base dirs are INJECTABLE so a
 * test points them at a temp dir (no real home/cwd writes), and a MERGE reads the
 * existing file back to detect a hallucinated target (016b-AC-3).
 *
 * The seam is filesystem-only — it never touches DeepLake. The append-only `skills`
 * row is written SEPARATELY through {@link SkillStore} (the daemon's storage path).
 */
export interface SkillInstallTarget {
	/**
	 * Write the `SKILL.md` for a skill under the install root, returning the absolute
	 * path written. Creates the `<name>/` dir if absent; overwrites the file (the body
	 * is the crystallized markdown WITH provenance frontmatter — the caller renders it).
	 */
	write(install: SkillInstall, name: string, markdown: string): Promise<string>;
	/**
	 * Read an existing `SKILL.md` body for a skill under the install root, or `null`
	 * when absent. A MERGE uses this to detect a hallucinated target → fall back to a
	 * new skill (016b-AC-3 / FR-4).
	 */
	read(install: SkillInstall, name: string): Promise<string | null>;
}

// ────────────────────────────────────────────────────────────────────────────
// SkillStore SEAM — the daemon's append-only skills storage (b-AC-6 dispatch path).
// ────────────────────────────────────────────────────────────────────────────

/**
 * The append-only `skills` storage seam (016b-AC-1 / 016b-AC-6 / FR-5 / FR-6). 016b
 * runs INSIDE the daemon, so "through the daemon, not a direct DeepLake connection"
 * means it writes through the storage path the daemon ALREADY holds — never a
 * re-opened client. {@link createSkillStore} (in `skills-write.ts`) builds the real
 * store over the daemon-side `StorageQuery`; a unit test injects a fake recording
 * store so it can assert the write was an INSERT (never an UPDATE) and that storage
 * was reached ONLY through this seam.
 *
 * Every write is a VERSION-BUMPED APPEND keyed by the skill's logical id; every read
 * that needs current state resolves the HIGHEST version per id, poll-convergently.
 * There is NO `update` method — by construction the store cannot mutate in place.
 */
export interface SkillStore {
	/**
	 * Read the current MAX(version) for a skill's logical id; 0 when the id has no
	 * rows yet. Poll-convergent (a stale segment under-reports the version, never
	 * over-reports). The next append lands at this + 1.
	 */
	maxVersion(id: string): Promise<number>;
	/**
	 * Read the ACTIVE (highest-version) skill row for a logical id, or `null` when
	 * absent. Poll-convergent. The reader convention paired with {@link appendVersion}.
	 */
	readActive(id: string): Promise<Skill | null>;
	/**
	 * APPEND a version row for a skill (heal-aware → lazy table create). NEVER an
	 * in-place UPDATE — the prior version stays on disk. Returns the version written.
	 */
	appendVersion(skill: Skill): Promise<number>;
}

// ────────────────────────────────────────────────────────────────────────────
// notImplemented — the honest Wave-2 (016a / 016c) thrower.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The standard "PRD-016a / 016c fills this" thrower (mirrors the
 * sources/vfs/secrets harness posture). A stubbed Wave-2 body calls this so an
 * accidental early call FAILS LOUD with the owning sub-PRD, never silently returns a
 * fake-passing value.
 */
export function notImplemented(what: string): never {
	throw new Error(`skillify: ${what} is not implemented in Wave 1 (PRD-016a / 016c owns it — see CONVENTIONS.md)`);
}
