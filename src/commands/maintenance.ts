/**
 * `honeycomb maintenance` thin-client verb — PRD-030 Wave 2a (Deliverable 2).
 *
 * The standalone operator entry point for the PRD-030 version-history COMPACTION job.
 * `honeycomb maintenance compact [--table <name>]` POSTs to the daemon's
 * `POST /api/diagnostics/compact` endpoint (the compaction trigger seam, `mountCompactApi`)
 * through the {@link DaemonClient} seam — the SAME loopback path every storage verb uses, so
 * the actor/scope/loopback headers are stamped by the shared `createLoopbackDaemonClient`,
 * never re-implemented here. This is the AC-bearing PRIMARY path (D-2): it runs REGARDLESS of
 * whether premium pollinating is enabled.
 *
 * ── It is a THIN CLIENT (D-2 / the dispatcher thesis) ─────────────────────────
 * This handler imports NO `daemon/storage` path and holds NO compaction logic: it builds a
 * {@link DaemonRequest}, dispatches it through `deps.daemon.send`, and renders the summary the
 * daemon returns. The daemon owns the compactor (the guarded SQL reap, the poll-convergent
 * survivor resolve, the allow-list guard); the CLI dispatches intent. `src/commands` is a
 * NON_DAEMON_ROOT, so a stray storage import FAILS the build (`invariant.test.ts`).
 *
 * ── The endpoint is the diagnostics compaction trigger ────────────────────────
 * `POST /api/diagnostics/compact` runs the Wave-1 compactor over the version-bumped tables
 * under the daemon scope and returns a per-table summary array. `--table <name>` narrows the
 * pass to one allow-listed table (the body carries `{table:"<name>"}`); without it the daemon
 * compacts every allow-listed table. The summary carries NO token/secret (AC-6); this handler
 * renders only table names + reap/skip counts.
 *
 * ── `keysSkipped` is surfaced as the transient-flap signal ────────────────────
 * Each table's summary carries `keysSkipped` — keys the compactor declined to reap because it
 * could not confirm the survivor durable (D-3). A non-zero count is the operator's signal that
 * the backend was flapping; a re-run (the job is idempotent) converges.
 */

import {
	type CommandDeps,
	type CommandResult,
	type DaemonRequest,
	type DaemonResponse,
	type OutputSink,
} from "./contracts.js";

/** The daemon route the `maintenance` verb dispatches to (the PRD-030 compaction trigger seam). */
export const MAINTENANCE_COMPACT_ENDPOINT = "/api/diagnostics/compact" as const;

/** The parsed `maintenance` invocation: the subcommand + the optional `--table` selector. */
export interface MaintenanceCliInvocation {
	/** The subcommand word (`compact` | unknown). */
	readonly subCommand: string;
	/** `--table <name>` value → narrow the pass to one table; empty → all allow-listed tables. */
	readonly table: string;
}

/** One table's compaction summary the daemon returns (defensive: every field optional across the IO boundary). */
interface CompactTableSummary {
	/** The table that was compacted. */
	readonly table?: string;
	/** Distinct keys discovered + scanned. */
	readonly keysScanned?: number;
	/** Keys that had at least one version reaped. */
	readonly keysCompacted?: number;
	/** Total version rows reaped across all keys. */
	readonly rowsReaped?: number;
	/** Keys skipped because the survivor could not be confirmed durable (D-3) — the flap signal. */
	readonly keysSkipped?: number;
	/** Per-table errors swallowed during the pass (fail-soft). */
	readonly errored?: number;
}

/** The summary body the daemon returns (defensive across the IO boundary). */
interface CompactSummaryBody {
	/** True when the pass ran to completion. */
	readonly ok?: boolean;
	/** One entry per table that existed and was compacted. */
	readonly summaries?: readonly CompactTableSummary[];
	/** Allow-listed tables skipped because they did not exist. */
	readonly skippedTables?: readonly string[];
}

/**
 * Parse a raw `maintenance` argv tail (everything AFTER the `maintenance` word) into a typed
 * {@link MaintenanceCliInvocation}. The first non-flag word is the subcommand; `--table <name>`
 * (or `--table=<name>`) is the only recognized flag. Pure: no IO, fully testable.
 */
export function parseMaintenanceCliArgs(argv: readonly string[]): MaintenanceCliInvocation {
	let subCommand = "";
	let table = "";
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--table") {
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				table = next;
				i += 1;
			}
		} else if (a.startsWith("--table=")) {
			table = a.slice("--table=".length);
		} else if (!a.startsWith("--") && subCommand === "") {
			subCommand = a;
		}
	}
	return { subCommand, table };
}

/** Narrow an unknown daemon body into a {@link CompactSummaryBody} (defensive across the IO boundary). */
function asSummaryBody(body: unknown): CompactSummaryBody {
	if (typeof body !== "object" || body === null) return {};
	return body as CompactSummaryBody;
}

/**
 * Render the daemon's compaction summary as human lines. Prints a per-table line
 * (rows reaped + keys skipped, the flap signal) plus a header total. A pass that reaped
 * nothing prints an honest "nothing to compact". No token/secret is ever rendered (AC-6).
 */
function renderSummary(body: CompactSummaryBody, out: OutputSink): void {
	const summaries = body.summaries ?? [];
	const skippedTables = body.skippedTables ?? [];

	let totalReaped = 0;
	let totalSkipped = 0;
	let tablesCompacted = 0;
	for (const s of summaries) {
		const reaped = s.rowsReaped ?? 0;
		const skipped = s.keysSkipped ?? 0;
		totalReaped += reaped;
		totalSkipped += skipped;
		if (reaped > 0) tablesCompacted += 1;
	}

	out(`maintenance compact: ${tablesCompacted}/${summaries.length} table(s) reaped, ${totalReaped} row(s) reaped, ${totalSkipped} key(s) skipped.`);
	for (const s of summaries) {
		const table = s.table ?? "(unknown)";
		const reaped = s.rowsReaped ?? 0;
		const scanned = s.keysScanned ?? 0;
		const skipped = s.keysSkipped ?? 0;
		const errored = s.errored ?? 0;
		const flap = skipped > 0 ? ` — ${skipped} key(s) SKIPPED (survivor not durable; re-run converges)` : "";
		const err = errored > 0 ? ` — ${errored} error(s) (fail-soft; re-run)` : "";
		out(`  ${table}: ${reaped} row(s) reaped over ${scanned} key(s)${flap}${err}.`);
	}
	if (skippedTables.length > 0) {
		out(`  not-yet-created (skipped): ${skippedTables.join(", ")}.`);
	}
	if (totalReaped === 0 && totalSkipped === 0) {
		out("maintenance compact: nothing to compact (history already within the retention bound).");
	}
}

/**
 * Run the `maintenance` verb (Deliverable 2). `maintenance compact [--table <name>]` POSTs to
 * `/api/diagnostics/compact` through the daemon seam and renders the per-table summary; any
 * other subcommand prints usage. The dispatch goes ONLY through `deps.daemon` — no DeepLake. A
 * non-2xx daemon status renders an error and exits 1.
 */
export async function runMaintenanceVerb(argv: readonly string[], deps: CommandDeps): Promise<CommandResult> {
	const out: OutputSink = deps.out ?? ((line: string): void => console.log(line));
	const inv = parseMaintenanceCliArgs(argv);

	if (inv.subCommand !== "compact") {
		out("usage: honeycomb maintenance compact [--table <name>]");
		out("       run the version-history compactor over the version-bumped tables on the daemon.");
		// An empty subcommand is a benign usage print (exit 0); an unknown one is an error (exit 1).
		return { exitCode: inv.subCommand === "" ? 0 : 1 };
	}

	// `--table <name>` narrows the pass to one allow-listed table; omitting it compacts all.
	const req: DaemonRequest = {
		method: "POST",
		path: MAINTENANCE_COMPACT_ENDPOINT,
		...(inv.table !== "" ? { body: { table: inv.table } } : {}),
	};
	const res: DaemonResponse = await deps.daemon.send(req);
	if (res.status >= 400) {
		out(`error: maintenance compact failed (daemon ${res.status}).`);
		return { exitCode: 1 };
	}
	renderSummary(asSummaryBody(res.body), out);
	return { exitCode: 0 };
}
