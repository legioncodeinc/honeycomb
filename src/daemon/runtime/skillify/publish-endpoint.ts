/**
 * Daemon-side skill publish / select endpoint seam — PRD-018a (FR-1 / FR-2 / a-AC-1 /
 * a-AC-5 / a-AC-6 / D-7).
 *
 * The COUNTERPART, on the daemon side, of the thin-client pull (`daemon-client/skillify`):
 *
 *   - PUBLISH  — append a version-bumped skill row to the shared `skills` table. Reuses the
 *     016b {@link createSkillStore} `appendVersion` (append-only, never an in-place UPDATE),
 *     so a republish at vN lands a fresh vN+1 row and the prior is preserved (a-AC-1).
 *   - SELECT-NEWER-FOR-ORG-USERS — the team read: the HIGHEST-version row per logical id
 *     (`<name>--<author>`), poll-convergently across {@link RESOLVE_POLLS} polls (D-7). A
 *     teammate's pull dispatches THIS through the daemon; the daemon is the sole DeepLake
 *     client (a-AC-6).
 *
 * ── Why this lives in `src/daemon/` (the daemon-only invariant) ─────────────
 * The publish/select endpoint REACHES DeepLake — it holds a `StorageQuery`. That is allowed
 * ONLY inside `src/daemon/` (the thin-client invariant bans a storage import from any
 * non-daemon root). So the endpoint is built HERE, behind the {@link SkillPublishEndpoint}
 * seam, and the thin client reaches it ONLY over the 3850 dispatch. The HTTP route that
 * mounts this endpoint is the deferred pure-wiring step (mirrors `sources/api.ts`).
 *
 * ── SQL safety (FR-5) ───────────────────────────────────────────────────────
 * The select builds its SELECT through `sqlIdent` / `sLiteral` only (no hand-quoting, no
 * parameterized query — DeepLake has none). `npm run audit:sql` scans `src/daemon`.
 */

import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { sqlIdent } from "../../storage/sql.js";
import { type Skill } from "./contracts.js";
import { createSkillStore, RESOLVE_POLLS, SKILLS_TABLE } from "./skills-write.js";

/**
 * One published skill the select-newer read returns (the daemon-side shape). Mirrors the
 * thin-client `PulledSkill`: the highest-version `(name, author, version, body)` per logical
 * id. The thin client maps the dispatched rows onto its own `PulledSkill`.
 */
export interface PublishedSkill {
	readonly name: string;
	readonly author: string;
	readonly version: number;
	readonly body: string;
}

/**
 * The daemon-side publish/select endpoint seam (a-AC-6). The thin client reaches this ONLY
 * over the 3850 dispatch; in a live itest it is driven directly against a throwaway table.
 *
 *   - `publish(skill)` → append a version-bumped row; resolves the version written (a-AC-1).
 *   - `selectNewerForOrgUsers()` → the highest-version row per `(name, author)`, poll-
 *     convergent (a-AC-5 / D-7).
 */
export interface SkillPublishEndpoint {
	/** Append a version-bumped skill row (append-only). Returns the version written. */
	publish(skill: Skill): Promise<number>;
	/** Resolve the highest-version skill per logical id, poll-convergently (a-AC-5 / D-7). */
	selectNewerForOrgUsers(): Promise<readonly PublishedSkill[]>;
}

/**
 * Build the daemon-side {@link SkillPublishEndpoint} over the daemon's `StorageQuery`
 * (a-AC-6). `publish` delegates to the 016b {@link createSkillStore} append-only path;
 * `selectNewerForOrgUsers` runs the highest-version-per-(name,author) SELECT, polled
 * `RESOLVE_POLLS` times and kept at the highest version observed (D-7 — a single read on this
 * backend can under-report a version, never over-report).
 *
 * `resolveTable` maps the canonical `skills` name to the PHYSICAL table — identity in
 * production; a live itest injects a per-run prefix so it reads/writes a throwaway table
 * NATIVELY (the heal CREATEs the physical name), the same isolation `createSkillStore` uses.
 */
export function createSkillPublishEndpoint(
	storage: StorageQuery,
	scope: QueryScope,
	resolveTable: (canonical: string) => string = (t) => t,
): SkillPublishEndpoint {
	const store = createSkillStore(storage, scope, resolveTable);
	const physical = (): string => resolveTable(SKILLS_TABLE);

	return {
		async publish(skill: Skill): Promise<number> {
			// Append-only, version-bumped — reuse the 016b store (NO in-place UPDATE).
			return store.appendVersion(skill);
		},

		async selectNewerForOrgUsers(): Promise<readonly PublishedSkill[]> {
			const sql = buildSelectNewerSql(physical());
			// Poll-convergent: keep the highest version seen per logical id across the polls.
			const best = new Map<string, PublishedSkill>();
			for (let poll = 0; poll < RESOLVE_POLLS; poll++) {
				const res = await storage.query(sql, scope);
				if (!isOk(res)) continue;
				for (const row of res.rows) {
					const skill = rowToPublished(row);
					if (skill === null) continue;
					const id = `${skill.name}--${skill.author}`;
					const prior = best.get(id);
					if (prior === undefined || skill.version >= prior.version) best.set(id, skill);
				}
			}
			return [...best.values()];
		},
	};
}

/**
 * The highest-version-per-(name,author) SELECT (a-AC-5 / D-7). A self-join against the
 * MAX(version) grouped by `(name, author)` yields exactly the active row for each logical
 * skill. Identifiers go through `sqlIdent`; the physical table name is escaped via
 * `sLiteral`-free `sqlIdent` quoting. There are no caller values (the scope is applied
 * daemon-side as a partition filter), so the statement is static + injection-free.
 */
export function buildSelectNewerSql(physicalTable: string): string {
	const tbl = sqlIdent(physicalTable);
	const name = sqlIdent("name");
	const author = sqlIdent("author");
	const version = sqlIdent("version");
	const body = sqlIdent("body");
	return (
		`SELECT s.${name} AS name, s.${author} AS author, s.${version} AS version, s.${body} AS body ` +
		`FROM "${tbl}" s ` +
		`JOIN (SELECT ${name}, ${author}, MAX(${version}) AS mv FROM "${tbl}" ` +
		`GROUP BY ${name}, ${author}) latest ` +
		`ON s.${name} = latest.${name} AND s.${author} = latest.${author} AND s.${version} = latest.mv`
	);
}

/** Map a raw row to a {@link PublishedSkill}, or `null` when a required field is missing. */
function rowToPublished(row: StorageRow): PublishedSkill | null {
	const name = typeof row.name === "string" ? row.name : "";
	const author = typeof row.author === "string" ? row.author : "";
	const body = typeof row.body === "string" ? row.body : "";
	if (name === "" || author === "") return null;
	const v = typeof row.version === "number" ? row.version : Number(row.version);
	const version = Number.isFinite(v) ? v : 0;
	return { name, author, version, body };
}
