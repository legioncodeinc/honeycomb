/**
 * The synthesized `index.md` — PRD-015a (a-AC-5 / FR-8). Tier 2 of the read chain.
 *
 * When NO real `/index.md` row exists and the mount ROOT is read, `generateVirtualIndex`
 * renders a TWO-SECTION overview so an agent that `cat ~/.honeycomb/memory/index.md` sees a
 * live table of contents rather than ENOENT:
 *
 *   1. Recent memories — the 50 most-recent `memory.summary` rows (by `last_update_date`).
 *   2. Recent sessions — the 50 most-recent `sessions` paths (grouped by `path`).
 *
 * Each section is CAPPED at 50 rows. To detect "more available" without a second COUNT
 * round-trip, each SELECT fetches 51 (`LIMIT 51`); a 51st row means the section is
 * truncated, so we render only the first 50 and append a TRUNCATION NOTICE pointing the
 * agent at Grep (a-AC-5) — the cap is a guardrail against dumping an unbounded table into a
 * single `cat`, and the notice tells the agent how to see the rest.
 *
 * EVERY row reaches storage through the {@link DaemonDispatch} seam (a-AC-6) under the
 * caller's {@link VfsScope} — this module opens no DeepLake. The two SELECTs are built with
 * the pure `sqlIdent` escaping helper (identifiers only; no caller value is interpolated,
 * so there is no injection surface here — `npm run audit:sql` stays green).
 */

import { sqlIdent } from "../../daemon/storage/sql.js";
import type { DaemonDispatch, Row, VfsScope } from "./contracts.js";

/**
 * The agent-facing memory mount display path emitted in generated text (PRD-072b.3 / AC-072b.3.2).
 * The mount relocated to `~/.apiary/honeycomb/memory/` (ADR-0003); the pre-tool-use classifier still
 * recognizes the legacy `~/.honeycomb/memory/` shape (dual recognition), but generated overviews
 * point agents at the new path.
 */
export const MEMORY_MOUNT_DISPLAY_PATH = "~/.apiary/honeycomb/memory/" as const;

/** The per-section row cap (a-AC-5 / FR-8). */
export const INDEX_SECTION_LIMIT = 50;
/** The fetch size — one over the cap, so a 51st row signals "more available". */
const INDEX_FETCH_SIZE = INDEX_SECTION_LIMIT + 1;

/**
 * Build the "recent memories" SELECT (FR-8): the most-recent `memory` summary rows by
 * `last_update_date`, projecting `path` + `summary`, capped at {@link INDEX_FETCH_SIZE}.
 * Identifiers only — no value interpolation.
 */
export function buildRecentMemoriesSql(): string {
	const tbl = sqlIdent("memory");
	const path = sqlIdent("path");
	const summary = sqlIdent("summary");
	const updated = sqlIdent("last_update_date");
	return `SELECT ${path}, ${summary} FROM "${tbl}" ` + `ORDER BY ${updated} DESC LIMIT ${INDEX_FETCH_SIZE}`;
}

/**
 * Build the "recent sessions" SELECT (FR-8 / Implementation notes). Sessions are grouped by
 * `path` and take `MAX(creation_date)` per path (DeepLake returns NULL for `SUM(size_bytes)`
 * under `GROUP BY`, so we aggregate a column it answers reliably — the freshest event date),
 * ordered most-recent first, capped at {@link INDEX_FETCH_SIZE}. Identifiers only.
 */
export function buildRecentSessionsSql(): string {
	const tbl = sqlIdent("sessions");
	const path = sqlIdent("path");
	const created = sqlIdent("creation_date");
	return (
		`SELECT ${path}, MAX(${created}) AS ${sqlIdent("latest")} FROM "${tbl}" ` +
		`GROUP BY ${path} ORDER BY ${sqlIdent("latest")} DESC LIMIT ${INDEX_FETCH_SIZE}`
	);
}

/** A first-column-cell extractor that tolerates a missing/non-string value. */
function cell(row: Row, key: string): string {
	const v = row[key];
	return typeof v === "string" ? v : v === undefined || v === null ? "" : String(v);
}

/** Collapse a summary to a single trimmed line so the table stays one-row-per-entry. */
function oneLine(value: string, max = 120): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Render one capped section as a small markdown table + a truncation notice when over the cap. */
function renderSection(
	title: string,
	rows: readonly Row[],
	pathKey: string,
	descKey: string | null,
	descHeader: string,
): string[] {
	const lines: string[] = [`## ${title}`, ""];
	const shown = rows.slice(0, INDEX_SECTION_LIMIT);
	if (shown.length === 0) {
		lines.push("_(none yet)_", "");
		return lines;
	}
	lines.push(`| path | ${descHeader} |`, "| --- | --- |");
	for (const row of shown) {
		const path = cell(row, pathKey);
		const desc = descKey === null ? "" : oneLine(cell(row, descKey));
		lines.push(`| ${path} | ${desc} |`);
	}
	lines.push("");
	// A 51st row means the section is truncated — point the agent at Grep (a-AC-5).
	if (rows.length > INDEX_SECTION_LIMIT) {
		lines.push(
			`_Showing the ${INDEX_SECTION_LIMIT} most recent of more. Use Grep over the mount to search the rest._`,
			"",
		);
	}
	return lines;
}

/**
 * Generate the virtual `index.md` body (a-AC-5 / FR-8). Dispatches the two section SELECTs
 * through {@link DaemonDispatch} under `scope`, then renders the two-section table. Each
 * section is capped at 50 rows with a per-section truncation notice. Reaches storage ONLY
 * through the seam.
 */
export async function generateVirtualIndex(dispatch: DaemonDispatch, scope: VfsScope): Promise<string> {
	const [memories, sessions] = await Promise.all([
		dispatch.query(buildRecentMemoriesSql(), scope),
		dispatch.query(buildRecentSessionsSql(), scope),
	]);

	const lines: string[] = [
		"# Honeycomb memory",
		"",
		`Mounted at \`${MEMORY_MOUNT_DISPLAY_PATH}\`.`,
		"",
		"A virtual index of team memory. These are not real files — each `cat` resolves through",
		"the daemon. Use Grep to search beyond the most-recent rows shown here.",
		"",
		...renderSection("Recent memories", memories, "path", "summary", "summary"),
		...renderSection("Recent sessions", sessions, "path", null, "latest event"),
	];
	return lines.join("\n");
}
