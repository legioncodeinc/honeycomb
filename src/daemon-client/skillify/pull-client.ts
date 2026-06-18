/**
 * The production {@link SkillPullClient} — reads the latest skills THROUGH THE DAEMON
 * (PRD-016c c-AC-6 / D-10).
 *
 * This is the thin-client side of the wire: it BUILDS the highest-version-per-(name,author)
 * SELECT with the PURE `sqlIdent` / `sLiteral` helpers (the SQL-injection floor — importing
 * them pulls in NO DeepLake client) and DISPATCHES it through the daemon's {@link DaemonDispatch}
 * seam (reused from the VFS, `127.0.0.1:3850`). The daemon is the sole DeepLake client and
 * applies the org/workspace scope as a partition filter. This module opens NOTHING — the
 * thin-client invariant (`tests/daemon/storage/invariant.test.ts`) proves it.
 *
 * ── Highest-version-per-(name,author), poll-convergent ──────────────────────
 * The `skills` table is append-only + version-bumped (PRD-016b): the ACTIVE skill for a
 * logical id `<name>--<author>` is its HIGHEST-version row. The read resolves that with a
 * GROUP BY (name, author) → MAX(version) self-join, polled `RESOLVE_POLLS` times and kept at
 * the highest version observed — the SAME poll-convergent shape `skills-write.ts`'s
 * `createSkillStore` uses, because a single read on this backend can land on a stale segment
 * and UNDER-report a version (never over-report).
 */

import { sLiteral, sqlIdent } from "../../daemon/storage/sql.js";
import { type DaemonDispatch, type Row, type VfsScope } from "../vfs/contracts.js";
import { type PulledSkill, type SkillPullClient } from "./contracts.js";

/** The `skills` catalog table (final — PRD-016b CONVENTIONS §5). */
const SKILLS_TABLE = "skills";

/**
 * How many times the latest-skills read is polled before taking the highest version it
 * observed per logical id. Mirrors `skills-write.ts`'s `RESOLVE_POLLS`: this backend serves
 * a read from segments of differing freshness, so a single read can UNDER-report a version
 * but never over-report — polling converges UP to the durable truth.
 */
export const RESOLVE_POLLS = 8;

/**
 * Build the production {@link SkillPullClient} over a {@link DaemonDispatch} (c-AC-6). Every
 * read dispatches the highest-version SELECT through the daemon under `scope`; nothing opens
 * DeepLake. A live/daemon-assembly step injects the real dispatch; a test injects a fake.
 */
export function createDaemonPullClient(dispatch: DaemonDispatch, scope: VfsScope): SkillPullClient {
	return {
		async readLatestSkills(): Promise<readonly PulledSkill[]> {
			const sql = buildLatestSkillsSql();
			// Poll-convergent: keep the highest version seen per logical id across the polls.
			const best = new Map<string, PulledSkill>();
			for (let poll = 0; poll < RESOLVE_POLLS; poll++) {
				const rows = await dispatch.query(sql, scope);
				for (const row of rows) {
					const skill = rowToPulledSkill(row);
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
 * The highest-version-per-(name,author) SELECT (c-AC-1). A self-join against the
 * MAX(version) grouped by (name, author) yields exactly the active row for each logical
 * skill. Identifiers go through `sqlIdent`; there are no caller values to escape (the scope
 * is applied daemon-side as a partition filter), so the statement is static + injection-free.
 */
export function buildLatestSkillsSql(): string {
	const tbl = sqlIdent(SKILLS_TABLE);
	const name = sqlIdent("name");
	const author = sqlIdent("author");
	const version = sqlIdent("version");
	const body = sqlIdent("body");
	// `latest` = the MAX(version) per (name, author); join back to fetch that row's body.
	return (
		`SELECT s.${name} AS name, s.${author} AS author, s.${version} AS version, s.${body} AS body ` +
		`FROM "${tbl}" s ` +
		`JOIN (SELECT ${name}, ${author}, MAX(${version}) AS mv FROM "${tbl}" ` +
		`GROUP BY ${name}, ${author}) latest ` +
		`ON s.${name} = latest.${name} AND s.${author} = latest.${author} AND s.${version} = latest.mv`
	);
}

/** Map a dispatched row to a {@link PulledSkill}, or `null` when a required field is missing. */
function rowToPulledSkill(row: Row): PulledSkill | null {
	const name = typeof row.name === "string" ? row.name : "";
	const author = typeof row.author === "string" ? row.author : "";
	const body = typeof row.body === "string" ? row.body : "";
	if (name === "" || author === "") return null;
	const v = typeof row.version === "number" ? row.version : Number(row.version);
	const version = Number.isFinite(v) ? v : 0;
	return { name, author, version, body };
}
