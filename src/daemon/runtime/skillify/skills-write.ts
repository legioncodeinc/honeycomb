/**
 * Skills writes — PRD-016b Wave 1 (FULL), proving b-AC-1..6.
 *
 * Turns a gate {@link GateVerdict} into a durable, discoverable skill:
 *   - a local `SKILL.md` with provenance frontmatter (the human-readable artifact,
 *     written through the {@link SkillInstallTarget} seam), AND
 *   - an APPEND-ONLY, version-bumped row in the shared `skills` table (the team-
 *     discoverable record, written through the {@link SkillStore} seam — the daemon's
 *     own storage path, never a re-opened DeepLake connection).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE NON-NEGOTIABLE MECHANIC — APPEND-ONLY, VERSION-BUMPED (b-AC-1 / FR-5)
 * ════════════════════════════════════════════════════════════════════════════
 * b-AC-1 LITERALLY requires "a new version row, never an in-place UPDATE." A skills
 * edit is NEVER a mutate of the prior row: it reads the current MAX(version) for the
 * skill's logical id (`<name>--<author>`) and INSERTs a fresh row at version N+1. The
 * ACTIVE skill is the HIGHEST-version row, resolved poll-convergently. This is the
 * SAME live-proven mechanic as `memory_jobs`, `ontology/supersede.ts`, and
 * `sources/lifecycle.ts`: the DeepLake backend coalesces rapid UPDATEs and serves
 * reads from segments of differing freshness that flap non-monotonically, so a by-id
 * `SET` never converges — but versions only ever INCREASE and a higher version is
 * never fictitious, so resolving by MAX(version) across a bounded poll union
 * converges monotonically to the durable current skill. {@link SkillStore} has NO
 * `update` method by construction.
 *
 * ── The verdict → action map (b-AC-1 / b-AC-3 / b-AC-4) ──────────────────────
 *   - KEEP  → {@link writeNewSkill}: render the SKILL.md, write it, append v=N+1.
 *   - MERGE → {@link mergeSkill}: if the target exists LOCALLY, bump it (new body +
 *            version+1 in the frontmatter + append a new row). If the target is
 *            ABSENT locally (the gate hallucinated a name from the user's global
 *            skills), FALL BACK to writeNewSkill so the body is preserved (b-AC-3 /
 *            FR-4). A CROSS-author merge promotes the recorded row's scope `me`→`team`
 *            (b-AC-4 / FR-7).
 *   - SKIP  → no file, no row. The caller still advances the watermark (b-AC-2 — owned
 *            by `watermark.ts`, called by the worker after this returns).
 *
 * ── Daemon-only storage (b-AC-6 / FR-6) ─────────────────────────────────────
 * Every `skills` read/write goes through {@link SkillStore} — in production a thin
 * wrapper over the daemon-side `StorageQuery` ({@link createSkillStore}); in tests a
 * fake recording store. The worker NEVER opens DeepLake. The thin-client invariant
 * (`tests/daemon/storage/invariant.test.ts`) keeps this honest: 016b lives under
 * `src/daemon/` and 016a's hook half (the trigger) signals the daemon over 3850.
 *
 * ── SQL safety (FR-5) ───────────────────────────────────────────────────────
 * Every value routes through the 002d `val.*` constructors (→ `sLiteral`/`eLiteral`)
 * and every append through the heal-aware `appendOnlyInsert` (→ guarded
 * `buildInsert`); reads build their SELECT through `sqlIdent`/`sLiteral`. No value is
 * hand-quoted; no raw fetch. `npm run audit:sql` scans `src/daemon`.
 */

import { stringify as stringifyYaml } from "yaml";

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { healTargetFor } from "../../storage/catalog/index.js";
import type { HealTarget } from "../../storage/heal.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import { appendOnlyInsert, type RowValues, val } from "../../storage/writes.js";
import {
	type GateVerdict,
	type Skill,
	skillLogicalId,
	type SkillInstall,
	type SkillInstallTarget,
	type SkillProvenance,
	type SkillScope,
	type SkillStore,
} from "./contracts.js";

/** The bare `skills` catalog table 016b fills (product.ts SKILLS_COLUMNS). */
export const SKILLS_TABLE = "skills" as const;

/**
 * How many times a current-state / max-version read is polled before taking the
 * MAX(version) it observed. Mirrors `sources/lifecycle.ts`'s `RESOLVE_POLLS` +
 * `ontology/supersede.ts`'s `PRIOR_POLLS`: this backend serves a read from segments
 * of differing freshness, so a single read can UNDER-report (a stale lower version)
 * but NEVER over-reports — polling converges UP to the durable truth. On the
 * deterministic fake the first poll is authoritative.
 */
export const RESOLVE_POLLS = 8;

/** ISO timestamp for `created_at` / `updated_at`. */
function nowIso(): string {
	return new Date().toISOString();
}

// ════════════════════════════════════════════════════════════════════════════
// createSkillStore — the real append-only, version-bumped, poll-convergent store
// over the daemon-side StorageQuery (b-AC-6). The same live-correctness shape proven
// by SourceArtifactStore. A live itest injects `resolveTable` to read/write real
// throwaway tables NATIVELY (the heal CREATEs the physical name) instead of a SQL-
// string proxy, which races the heal.
// ════════════════════════════════════════════════════════════════════════════

/**
 * Build the production {@link SkillStore} over the daemon's `StorageQuery` (b-AC-6 /
 * FR-6). Every write is a version-bumped APPEND keyed by the skill's logical id;
 * every current-state read resolves the HIGHEST version per id, poll-convergently.
 * There is NO in-place UPDATE.
 *
 * `resolveTable` maps the canonical `skills` name to the PHYSICAL table. Identity in
 * production (the canonical name IS the physical table). A live itest injects a
 * per-run prefix so it reads/writes a real throwaway table NATIVELY — the heal
 * CREATEs the physical name directly — instead of rewriting SQL strings after the
 * fact (a SQL-string proxy races the heal's CREATE/introspect/ALTER and corrupts a
 * fresh table; passing the physical name through the HealTarget is the proven
 * isolation technique, copied verbatim from `SourceArtifactStore`).
 */
export function createSkillStore(
	storage: StorageQuery,
	scope: QueryScope,
	resolveTable: (canonical: string) => string = (t) => t,
): SkillStore {
	const physical = (): string => resolveTable(SKILLS_TABLE);

	const target = (): HealTarget => {
		const canonical = healTargetFor(SKILLS_TABLE);
		const phys = physical();
		return phys === SKILLS_TABLE ? canonical : { ...canonical, table: phys };
	};

	/**
	 * Resolve the highest-version ROW for a logical id, poll-convergent. A single read
	 * can land on a stale segment (lower version); the MAX across {@link RESOLVE_POLLS}
	 * polls converges UP to the durable current version. Returns the raw row, or null.
	 */
	const resolveCurrentRow = async (id: string): Promise<StorageRow | null> => {
		const tbl = sqlIdent(physical());
		const idCol = sqlIdent("id");
		const versionCol = sqlIdent("version");
		const sql =
			`SELECT * FROM "${tbl}" ` +
			`WHERE ${idCol} = ${sLiteral(id)} ` +
			`ORDER BY ${versionCol} DESC LIMIT 1`;
		let best: StorageRow | null = null;
		let bestVersion = -Infinity;
		for (let poll = 0; poll < RESOLVE_POLLS; poll++) {
			const res = await storage.query(sql, scope);
			if (isOk(res) && res.rows.length > 0) {
				const row = res.rows[0] as StorageRow;
				const v = typeof row.version === "number" ? row.version : Number(row.version);
				const ver = Number.isFinite(v) ? v : 0;
				if (ver >= bestVersion) {
					bestVersion = ver;
					best = row;
				}
			}
		}
		return best;
	};

	return {
		async maxVersion(id: string): Promise<number> {
			const row = await resolveCurrentRow(id);
			if (row === null) return 0;
			const v = typeof row.version === "number" ? row.version : Number(row.version);
			return Number.isFinite(v) ? v : 0;
		},

		async readActive(id: string): Promise<Skill | null> {
			const row = await resolveCurrentRow(id);
			return row === null ? null : rowToSkill(row);
		},

		async appendVersion(skill: Skill): Promise<number> {
			const now = nowIso();
			// The row mirrors the SKILLS_COLUMNS shape exactly. `source_sessions` and
			// `contributors` are JSON arrays stored as TEXT (the catalog default is
			// '[]'); the author IS the creator (→ `author` + `agent_id`).
			const row: RowValues = [
				["id", val.str(skill.id)],
				["name", val.str(skill.name)],
				["scope", val.str(skill.provenance.scope)],
				["install", val.str(skill.install)],
				["author", val.str(skill.author)],
				["contributors", val.text(JSON.stringify(contributorsFor(skill)))],
				["source_sessions", val.text(JSON.stringify(skill.provenance.sourceSessions))],
				["description", val.text(skill.description)],
				["trigger_text", val.text(skill.triggerText)],
				["body", val.text(skill.body)],
				["version", val.num(skill.provenance.version)],
				["agent_id", val.str(skill.author)],
				["created_at", val.str(now)],
				["updated_at", val.str(now)],
			];
			await appendOnlyInsert(storage, target(), scope, row);
			return skill.provenance.version;
		},
	};
}

/**
 * Contributors for a recorded row. A `team` skill carries BOTH the original author
 * and the merging author as contributors so a later pull surfaces co-ownership; a
 * `me` skill lists just its author. (The merge path supplies the merging author by
 * recording under the target's id with the merger added — see {@link mergeSkill}.)
 */
function contributorsFor(skill: Skill): readonly string[] {
	return [skill.author];
}

/** Map a raw `skills` row back to the {@link Skill} shape (highest-version read). */
function rowToSkill(row: StorageRow): Skill {
	const str = (k: string, d = ""): string => (typeof row[k] === "string" ? (row[k] as string) : d);
	const num = (k: string, d = 0): number => {
		const v = row[k];
		const n = typeof v === "number" ? v : Number(v);
		return Number.isFinite(n) ? n : d;
	};
	const scope: SkillScope = str("scope", "me") === "team" ? "team" : "me";
	const install: SkillInstall = str("install", "project") === "global" ? "global" : "project";
	return {
		id: str("id"),
		name: str("name"),
		author: str("author"),
		description: str("description"),
		triggerText: str("trigger_text"),
		body: str("body"),
		install,
		provenance: {
			sourceSessions: parseJsonArray(str("source_sessions", "[]")),
			version: num("version", 1),
			createdBy: str("author"),
			scope,
		},
	};
}

/** Parse a TEXT-stored JSON array of strings; tolerate malformed input → []. */
function parseJsonArray(text: string): readonly string[] {
	try {
		const parsed = JSON.parse(text) as unknown;
		return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
	} catch {
		return [];
	}
}

// ════════════════════════════════════════════════════════════════════════════
// SKILL.md rendering — provenance frontmatter + body (FR-2).
// ════════════════════════════════════════════════════════════════════════════

/**
 * Render a `SKILL.md` with YAML provenance frontmatter (FR-2 / b-AC-1). The
 * frontmatter carries `source_sessions`, `version`, `created_by_agent`, `scope`, and
 * timestamps; the body follows. `yaml.stringify` escapes the frontmatter values
 * (this is a FILE, not SQL — the SQL path escapes separately via `val.*`).
 */
export function renderSkillMarkdown(skill: Skill): string {
	const frontmatter = {
		name: skill.name,
		description: skill.description,
		trigger: skill.triggerText,
		source_sessions: [...skill.provenance.sourceSessions],
		version: skill.provenance.version,
		created_by_agent: skill.provenance.createdBy,
		scope: skill.provenance.scope,
		updated_at: nowIso(),
	};
	const yaml = stringifyYaml(frontmatter).trimEnd();
	return `---\n${yaml}\n---\n\n${skill.body}\n`;
}

// ════════════════════════════════════════════════════════════════════════════
// writeSkill — the public entry: route a verdict to KEEP / MERGE / SKIP.
// ════════════════════════════════════════════════════════════════════════════

/** Construction deps for {@link writeSkill} (injected — CONVENTIONS §1). */
export interface SkillWriteDeps {
	/** The append-only skills store (the daemon's storage path — b-AC-6). */
	readonly store: SkillStore;
	/** The local SKILL.md writer/reader seam (injectable base dir for tests — b-AC-5). */
	readonly install: SkillInstallTarget;
	/** The author/agent mining this skill (→ `author`/`agent_id`/`created_by_agent`). */
	readonly author: string;
}

/** The outcome of a {@link writeSkill} call, for the worker's audit + the watermark. */
export interface WriteSkillOutcome {
	/** The decision acted on. */
	readonly decision: GateVerdict["decision"];
	/** Whether a SKILL.md file was written (false on SKIP). */
	readonly fileWritten: boolean;
	/** The absolute path of the written SKILL.md, or null on SKIP. */
	readonly filePath: string | null;
	/** The append-only row version written, or null on SKIP. */
	readonly version: number | null;
	/** The logical id the row was written under, or null on SKIP. */
	readonly skillId: string | null;
	/** The recorded row's scope (`me` | `team`), or null on SKIP. */
	readonly scope: SkillScope | null;
	/** True when a MERGE fell back to writeNewSkill (absent target — b-AC-3). */
	readonly mergeFellBack: boolean;
}

/**
 * Act on a gate verdict (b-AC-1 / b-AC-3 / b-AC-4 / b-AC-5 / b-AC-6). KEEP writes a
 * new skill; MERGE bumps an existing one (or falls back to new when the target is
 * absent locally); SKIP writes nothing. Every write is an append-only version row +
 * a provenance-frontmatter `SKILL.md`. The watermark advance (b-AC-2) is the caller's
 * job — `writeSkill` is verdict→write only.
 *
 * `mined` carries the session ids the skill was mined from (→ `source_sessions`
 * provenance + the watermark the worker advances). `install` chooses project vs
 * global (b-AC-5).
 */
export async function writeSkill(
	verdict: GateVerdict,
	deps: SkillWriteDeps,
	sourceSessions: readonly string[],
	install: SkillInstall,
): Promise<WriteSkillOutcome> {
	switch (verdict.decision) {
		case "SKIP":
			return {
				decision: "SKIP",
				fileWritten: false,
				filePath: null,
				version: null,
				skillId: null,
				scope: null,
				mergeFellBack: false,
			};
		case "KEEP":
			return writeNewSkill(verdict, deps, sourceSessions, install, "me");
		case "MERGE":
			return mergeSkill(verdict, deps, sourceSessions, install);
	}
}

/**
 * KEEP → write a brand-new skill (b-AC-1 / FR-1). Renders the SKILL.md with
 * provenance frontmatter, writes it through the install seam (b-AC-5), and APPENDS a
 * version row at N+1 for the skill's logical id (never an in-place UPDATE). The new
 * version is N+1 of whatever the id already had — so a SECOND KEEP for the same
 * (name, author) bumps the same chain (the prior version is retained on disk).
 *
 * Exported because MERGE falls back to it when the target is absent locally (b-AC-3 /
 * FR-4) — the body is preserved as a new skill.
 */
export async function writeNewSkill(
	verdict: GateVerdict,
	deps: SkillWriteDeps,
	sourceSessions: readonly string[],
	install: SkillInstall,
	scope: SkillScope,
	mergeFellBack = false,
): Promise<WriteSkillOutcome> {
	const name = verdict.name ?? verdict.target ?? "untitled-skill";
	const id = skillLogicalId(name, deps.author);
	const version = (await deps.store.maxVersion(id)) + 1;
	const skill = buildSkill(id, name, deps.author, verdict, sourceSessions, version, scope, install);

	const filePath = await deps.install.write(install, name, renderSkillMarkdown(skill));
	const writtenVersion = await deps.store.appendVersion(skill);

	return {
		decision: verdict.decision,
		fileWritten: true,
		filePath,
		version: writtenVersion,
		skillId: id,
		scope,
		mergeFellBack,
	};
}

/**
 * MERGE → bump an existing skill, or fall back to a new one (b-AC-3 / b-AC-4 / FR-3 /
 * FR-4 / FR-7).
 *
 *   - If the MERGE target is ABSENT locally (the gate hallucinated a name from the
 *     user's global skills), FALL BACK to {@link writeNewSkill} so the body is
 *     preserved (b-AC-3). The fallback records under the merging author's own id.
 *   - If the target EXISTS, the body updates and the version bumps in BOTH the
 *     frontmatter and the append-only row. A CROSS-author merge (the target's author
 *     differs from the merging author) promotes the recorded row's scope `me`→`team`
 *     so a future pull knows the skill is co-owned (b-AC-4 / FR-7). A same-author
 *     merge keeps `me`.
 *
 * The bump is recorded under the TARGET's logical id (`<target>--<targetAuthor>`) so
 * the version chain accrues on the original skill, never forking a parallel chain.
 */
export async function mergeSkill(
	verdict: GateVerdict,
	deps: SkillWriteDeps,
	sourceSessions: readonly string[],
	install: SkillInstall,
): Promise<WriteSkillOutcome> {
	const targetName = verdict.target ?? verdict.name ?? "untitled-skill";

	// Detect a hallucinated target: no local SKILL.md for the named skill.
	const localBody = await deps.install.read(install, targetName);
	if (localBody === null) {
		// FALL BACK to a new skill — the body is preserved (b-AC-3).
		return writeNewSkill(verdict, deps, sourceSessions, install, "me", /* mergeFellBack */ true);
	}

	// CROSS-author merge → promote scope me→team (b-AC-4). The target's author is the
	// chain owner; when it differs from the merging author, the skill is co-owned.
	const targetAuthor = verdict.targetAuthor ?? deps.author;
	const crossAuthor = targetAuthor !== deps.author;
	const scope: SkillScope = crossAuthor ? "team" : "me";

	// Record under the TARGET's logical id so the bump accrues on the original chain.
	const id = skillLogicalId(targetName, targetAuthor);
	const version = (await deps.store.maxVersion(id)) + 1;
	const skill = buildSkill(id, targetName, targetAuthor, verdict, sourceSessions, version, scope, install);

	const filePath = await deps.install.write(install, targetName, renderSkillMarkdown(skill));
	const writtenVersion = await deps.store.appendVersion(skill);

	return {
		decision: "MERGE",
		fileWritten: true,
		filePath,
		version: writtenVersion,
		skillId: id,
		scope,
		mergeFellBack: false,
	};
}

/** Assemble a {@link Skill} from a verdict + the resolved version/scope/install. */
function buildSkill(
	id: string,
	name: string,
	author: string,
	verdict: GateVerdict,
	sourceSessions: readonly string[],
	version: number,
	scope: SkillScope,
	install: SkillInstall,
): Skill {
	const provenance: SkillProvenance = {
		sourceSessions: [...sourceSessions],
		version,
		createdBy: author,
		scope,
	};
	return {
		id,
		name,
		author,
		description: verdict.description ?? "",
		triggerText: verdict.triggerText ?? "",
		body: verdict.body ?? "",
		install,
		provenance,
	};
}

// Re-export the escaping helpers so a caller building a fragment reaches them through
// this module (one skills-write surface), mirroring `supersede.ts`'s re-exports.
export { sLiteral, sqlIdent };
