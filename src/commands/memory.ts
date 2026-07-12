/**
 * `honeycomb memory` lifecycle thin-client verb — PRD-058d (US-55d.3, the CLI parity surface).
 *
 * The terminal-first operator surface over the four lifecycle engines, mirroring
 * {@link import("./maintenance.js").runMaintenanceVerb}: each subcommand builds a
 * {@link DaemonRequest} and dispatches it through the {@link DaemonClient} seam — the SAME loopback
 * path every storage verb uses, so the actor/scope/session headers are stamped by the shared
 * `createLoopbackDaemonClient`, never re-implemented here. It imports NO `daemon/storage` path and
 * holds NO lifecycle math: the daemon owns the reads + the 058b resolve write; the CLI dispatches
 * intent. `src/commands` is a NON_DAEMON_ROOT, so a stray storage import FAILS the build.
 *
 * ── Subcommands (US-55d.3) ────────────────────────────────────────────────────────────────────
 *   - `honeycomb memory conflicts [--status open]`                       → GET  /api/memories/conflicts
 *   - `honeycomb memory conflicts resolve <id> --verdict <v> [--winner <id>] [--reason <r>]`
 *                                                                        → POST /api/memories/conflicts/<id>/resolve
 *   - `honeycomb memory stale-refs`                                      → GET  /api/memories/stale-refs
 *   - `honeycomb memory inspect <id> --lifecycle`                        → GET  /api/memories/<id>
 *                                                                          + GET /api/memories/calibration
 *
 * THE RESOLVE goes through the EXACT 058b endpoint + code path the dashboard uses (US-55d.3.2 — no
 * parallel resolve logic): the CLI just POSTs the verdict/winner/reason; the daemon applies the κ
 * assignment, the append-only supersession, the `memory_history` append, and the poll-to-convergence
 * read-back. The CLI never re-implements any of that.
 *
 * Scope is resolved daemon-side from the request headers (org/workspace/agent), so the list reads are
 * scope-filtered to the caller's tenant (US-55d.3.1) without the CLI carrying a partition into SQL.
 */

import {
	type CommandDeps,
	type CommandResult,
	type DaemonRequest,
	type DaemonResponse,
	type OutputSink,
} from "./contracts.js";

/** The lifecycle daemon routes the `memory` verb dispatches to (the 058d read API + the 058b resolve). */
export const MEMORY_CONFLICTS_LIST_ROUTE = "/api/memories/conflicts" as const;
/** The 058b resolve endpoint (the SAME path the dashboard hits — no parallel resolve logic). */
export const MEMORY_CONFLICTS_RESOLVE_ROUTE = "/api/memories/conflicts" as const; // + `/<id>/resolve`
/** The 058d stale-ref list route. */
export const MEMORY_STALE_REFS_ROUTE = "/api/memories/stale-refs" as const;
/** The memory-detail read route (the `--lifecycle` inspect base). */
export const MEMORY_DETAIL_ROUTE = "/api/memories" as const;
/** The 058e calibration introspection route (reused by `inspect --lifecycle`). */
export const MEMORY_CALIBRATION_ROUTE = "/api/memories/calibration" as const;
/** PRD-080b (b-AC-4): the controlled-write outbox RE-DRIVE trigger the `memory redrive` verb POSTs to. */
export const MEMORY_REDRIVE_ENDPOINT = "/api/diagnostics/memory-redrive" as const;

/** The recognized conflict verdicts the CLI accepts (mirrors the daemon `CONFLICT_VERDICTS`). */
export const MEMORY_CONFLICT_VERDICTS = Object.freeze(["supersede", "review", "keep-both"] as const);
/** One CLI verdict token. */
export type MemoryConflictVerdict = (typeof MEMORY_CONFLICT_VERDICTS)[number];

/** The parsed `memory` invocation: the sub + its sub-sub (for `conflicts resolve`) + the flags. */
export interface MemoryCliInvocation {
	/** The subcommand (`conflicts` | `stale-refs` | `inspect` | unknown). */
	readonly sub: string;
	/** The second positional (the `resolve` action under `conflicts`, or the memory id under `inspect`). */
	readonly arg: string;
	/** The third positional (the conflict id under `conflicts resolve`). */
	readonly id: string;
	/** `--status <open|resolved|reversed>` for the conflicts list (default `open`). */
	readonly status: string;
	/** `--verdict <supersede|review|keep-both>` for resolve. */
	readonly verdict: string;
	/** `--winner <memory-id>` for a `supersede` verdict. */
	readonly winner: string;
	/** `--reason <text>` for the audit trail. */
	readonly reason: string;
	/** `--lifecycle` on `inspect` → print the lifecycle fields + the computed H. */
	readonly lifecycle: boolean;
}

/** Read a `--flag value` pair off an argv tail (`undefined` when absent or value-less). */
function flagValue(argv: readonly string[], flag: string): string | undefined {
	const idx = argv.indexOf(flag);
	if (idx < 0) return undefined;
	const v = argv[idx + 1];
	return v !== undefined && !v.startsWith("--") ? v : undefined;
}

/** The value-bearing flags whose following token is CONSUMED (so it never folds into a positional). */
const MEMORY_VALUE_FLAGS: ReadonlySet<string> = new Set(["--status", "--verdict", "--winner", "--reason"]);

/**
 * Parse a raw `memory` argv tail (everything AFTER the `memory` word) into a typed
 * {@link MemoryCliInvocation}. The first non-flag word is the subcommand; the next two non-flag
 * words are the action/id positionals; the `--status`/`--verdict`/`--winner`/`--reason` pairs and the
 * `--lifecycle` boolean are recognized flags. The scan SKIPS a value-flag's following token so a
 * paired value (e.g. `--verdict supersede`) interleaved BEFORE or BETWEEN positionals never shifts the
 * sub/arg/id positions (CodeRabbit #125: `conflicts resolve --verdict supersede c1` must parse `c1` as
 * the id, not `supersede`). Pure: no IO, fully testable.
 */
export function parseMemoryCliArgs(argv: readonly string[]): MemoryCliInvocation {
	const positionals: string[] = [];
	for (let i = 0; i < argv.length; i += 1) {
		const tok = argv[i];
		if (tok === undefined) continue;
		if (MEMORY_VALUE_FLAGS.has(tok)) {
			i += 1; // consume the flag's value so it is never treated as a positional.
			continue;
		}
		if (tok.startsWith("--")) continue; // a boolean flag (e.g. `--lifecycle`) or an unknown flag.
		positionals.push(tok);
	}
	return {
		sub: positionals[0] ?? "",
		arg: positionals[1] ?? "",
		id: positionals[2] ?? "",
		status: flagValue(argv, "--status") ?? "open",
		verdict: flagValue(argv, "--verdict") ?? "",
		winner: flagValue(argv, "--winner") ?? "",
		reason: flagValue(argv, "--reason") ?? "",
		lifecycle: argv.includes("--lifecycle"),
	};
}

// ── Defensive response narrowing (the daemon body crosses the IO boundary) ────

/** One conflict row from `GET /api/memories/conflicts` (every field optional across the boundary). */
interface ConflictRow {
	readonly id?: string;
	readonly memoryAId?: string;
	readonly memoryBId?: string;
	readonly verdict?: string;
	readonly winnerId?: string | null;
	readonly status?: string;
}

/** One stale-ref row from `GET /api/memories/stale-refs`. */
interface StaleRefRow {
	readonly memoryId?: string;
	readonly refStatus?: string;
	readonly staleRefs?: readonly string[];
}

/** Narrow a daemon body into a typed record array under `key` (defensive: bad shape → []). */
function rowsOf<T>(body: unknown, key: string): readonly T[] {
	if (typeof body !== "object" || body === null) return [];
	const arr = (body as Record<string, unknown>)[key];
	return Array.isArray(arr) ? (arr as T[]) : [];
}

/** Read a string field defensively. */
function s(v: unknown): string {
	return v === undefined || v === null ? "" : String(v);
}

// ── Renderers (--json prints the raw body; otherwise human lines) ─────────────

/** Render the conflicts list (US-55d.3.1): ids, the pair, the verdict, the status. */
function renderConflicts(res: DaemonResponse, json: boolean, out: OutputSink): void {
	if (json) {
		out(JSON.stringify(res.body ?? {}, null, 2));
		return;
	}
	const rows = rowsOf<ConflictRow>(res.body, "conflicts");
	if (rows.length === 0) {
		out("no conflicts found in scope.");
		return;
	}
	for (const r of rows) {
		const winner = s(r.winnerId) !== "" ? `  winner=${s(r.winnerId)}` : "";
		out(`${s(r.id)}  [${s(r.status) || "open"}]  ${s(r.memoryAId)} ⇄ ${s(r.memoryBId)}  verdict=${s(r.verdict) || "review"}${winner}`);
	}
}

/** Render the stale-ref list (US-55d.3.3): the memory id + its unresolved references. */
function renderStaleRefs(res: DaemonResponse, json: boolean, out: OutputSink): void {
	if (json) {
		out(JSON.stringify(res.body ?? {}, null, 2));
		return;
	}
	const rows = rowsOf<StaleRefRow>(res.body, "staleRefs");
	if (rows.length === 0) {
		out("no stale references found in scope.");
		return;
	}
	for (const r of rows) {
		const refs = Array.isArray(r.staleRefs) ? r.staleRefs : [];
		out(`${s(r.memoryId)}  [${s(r.refStatus) || "stale"}]  refs: ${refs.length > 0 ? refs.join(", ") : "(unrecorded)"}`);
	}
}

/** Build the conflicts subcommand request (list or resolve). Returns `null` for a malformed resolve. */
function buildConflictsRequest(inv: MemoryCliInvocation, out: OutputSink): DaemonRequest | null {
	if (inv.arg === "resolve") {
		// `memory conflicts resolve <id> --verdict <v> [--winner <id>]` → the 058b POST (SAME path/code).
		if (inv.id === "") {
			out("usage: honeycomb memory conflicts resolve <id> --verdict <supersede|review|keep-both> [--winner <memory-id>]");
			return null;
		}
		if (!(MEMORY_CONFLICT_VERDICTS as readonly string[]).includes(inv.verdict)) {
			out(`error: --verdict must be one of: ${MEMORY_CONFLICT_VERDICTS.join(", ")}`);
			return null;
		}
		const body: Record<string, string> = { verdict: inv.verdict };
		if (inv.winner !== "") body.winnerId = inv.winner;
		if (inv.reason !== "") body.reason = inv.reason;
		return { method: "POST", path: `${MEMORY_CONFLICTS_RESOLVE_ROUTE}/${encodeURIComponent(inv.id)}/resolve`, body };
	}
	// The list view (scope-filtered, paginated daemon-side).
	return { method: "GET", path: MEMORY_CONFLICTS_LIST_ROUTE, query: { status: inv.status } };
}

/**
 * Run the `memory` verb (PRD-058d US-55d.3). Dispatches the subcommand through the daemon seam and
 * renders the response; an unknown subcommand prints usage. The dispatch goes ONLY through
 * `deps.daemon` — no DeepLake. A non-2xx daemon status renders an error and exits 1. `json` is the
 * parsed `--json` global flag (the list/inspect views print the raw body when set).
 */
export async function runMemoryVerb(argv: readonly string[], deps: CommandDeps, json = false): Promise<CommandResult> {
	const out: OutputSink = deps.out ?? ((line: string): void => console.log(line));
	const inv = parseMemoryCliArgs(argv);

	if (inv.sub === "conflicts") {
		const req = buildConflictsRequest(inv, out);
		if (req === null) return { exitCode: 1 };
		const res = await deps.daemon.send(req);
		if (res.status >= 400) {
			out(`error: memory conflicts failed (daemon ${res.status}).`);
			return { exitCode: 1 };
		}
		if (inv.arg === "resolve") {
			if (json) out(JSON.stringify(res.body ?? {}, null, 2));
			else out(`resolved conflict ${inv.id} (${inv.verdict}).`);
			return { exitCode: 0 };
		}
		renderConflicts(res, json, out);
		return { exitCode: 0 };
	}

	if (inv.sub === "stale-refs") {
		const res = await deps.daemon.send({ method: "GET", path: MEMORY_STALE_REFS_ROUTE });
		if (res.status >= 400) {
			out(`error: memory stale-refs failed (daemon ${res.status}).`);
			return { exitCode: 1 };
		}
		renderStaleRefs(res, json, out);
		return { exitCode: 0 };
	}

	if (inv.sub === "inspect") {
		return runInspect(inv, deps, json, out);
	}

	if (inv.sub === "redrive") {
		return runRedrive(deps, json, out);
	}

	out("usage: honeycomb memory <conflicts|stale-refs|inspect|redrive>");
	out("       conflicts [--status open]                 list conflicts in scope");
	out("       conflicts resolve <id> --verdict <v> [--winner <id>]   resolve via the 058b endpoint");
	out("       stale-refs                                list memories with stale references");
	out("       inspect <id> --lifecycle                  show freshness, calibrated confidence, refStatus, conflict, H");
	out("       redrive                                   recover memories dropped in a degraded window (PRD-080b)");
	// An empty subcommand is a benign usage print (exit 0); an unknown one is an error (exit 1).
	return { exitCode: inv.sub === "" ? 0 : 1 };
}

/** The count pair the daemon returns from the re-drive (defensive: every field optional across the IO boundary). */
interface RedriveBody {
	/** Facts recovered — re-committed / deduped / durably deferred to the outbox. */
	readonly redriven?: number;
	/** Facts NOT recovered — unparseable / gate-skipped / genuine-failure. */
	readonly skipped?: number;
}

/** Narrow an unknown daemon body into a {@link RedriveBody} + coerce each count to a non-negative int. */
function asRedriveBody(body: unknown): { redriven: number; skipped: number } {
	const b = typeof body === "object" && body !== null ? (body as RedriveBody) : {};
	const coerce = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.trunc(v)) : 0);
	return { redriven: coerce(b.redriven), skipped: coerce(b.skipped) };
}

/**
 * `honeycomb memory redrive` (PRD-080b b-AC-4): POST the re-drive trigger and render `{ redriven, skipped }`
 * — recovering the distilled memories dropped in a past degraded window. THIN CLIENT: the dispatch goes
 * ONLY through `deps.daemon` (no DeepLake); the daemon owns the terminal-job read + the controlled-write
 * re-run. READ-THROUGH FAIL-SOFT: a daemon-down / error status is reported cleanly (a one-line message +
 * a non-zero exit code), never a throw.
 */
async function runRedrive(deps: CommandDeps, json: boolean, out: OutputSink): Promise<CommandResult> {
	let res: DaemonResponse;
	try {
		res = await deps.daemon.send({ method: "POST", path: MEMORY_REDRIVE_ENDPOINT });
	} catch {
		// Read-through fail-soft: a daemon-down / connection error is reported cleanly, never thrown.
		out("error: memory redrive could not reach the daemon on 127.0.0.1:3850.");
		return { exitCode: 1 };
	}
	if (res.status >= 400) {
		out(`error: memory redrive failed (daemon ${res.status}).`);
		return { exitCode: 1 };
	}
	if (json) {
		out(JSON.stringify(res.body ?? {}, null, 2));
		return { exitCode: 0 };
	}
	const counts = asRedriveBody(res.body);
	out(`memory redrive: ${counts.redriven} redriven, ${counts.skipped} skipped.`);
	return { exitCode: 0 };
}

/** The lifecycle fields the daemon's memory-detail response carries (058a/058b/058c/058e ride the body). */
interface LifecycleDetailBody {
	readonly memory?: {
		readonly id?: string;
		readonly freshnessScore?: number;
		readonly activation?: number;
		readonly calibratedConfidence?: number;
		readonly staleness?: number;
		readonly refStatus?: string;
		readonly openConflict?: boolean;
		readonly kappa?: number;
	};
}

/** Read a numeric field defensively. */
function n(v: unknown): number | undefined {
	const x = typeof v === "number" ? v : Number(v);
	return Number.isFinite(x) ? x : undefined;
}

/**
 * `memory inspect <id> --lifecycle` (US-55d.3.4): print `freshnessScore`, `calibratedConfidence`,
 * `refStatus`, the open-conflict status, and the computed `H`. The lifecycle fields RIDE the existing
 * memory-detail response (058a/b/c/e emit them); `H = A · C · (1 − σ) · κ` is assembled CLIENT-SIDE
 * from those fields with the dormant-term identity (a missing term reads as its identity factor), the
 * SAME read-side projection the dashboard + daemon use. Without `--lifecycle` the bare detail prints.
 */
async function runInspect(inv: MemoryCliInvocation, deps: CommandDeps, json: boolean, out: OutputSink): Promise<CommandResult> {
	if (inv.arg === "") {
		out("usage: honeycomb memory inspect <id> [--lifecycle]");
		return { exitCode: 1 };
	}
	const res = await deps.daemon.send({ method: "GET", path: `${MEMORY_DETAIL_ROUTE}/${encodeURIComponent(inv.arg)}` });
	if (res.status >= 400) {
		out(`error: memory ${inv.arg} not found (daemon ${res.status}).`);
		return { exitCode: 1 };
	}
	if (json) {
		out(JSON.stringify(res.body ?? {}, null, 2));
		return { exitCode: 0 };
	}
	const body = (typeof res.body === "object" && res.body !== null ? res.body : {}) as LifecycleDetailBody;
	const m = body.memory ?? {};
	if (!inv.lifecycle) {
		out(`memory ${s(m.id) || inv.arg}`);
		return { exitCode: 0 };
	}
	// Assemble H = A · C · (1 − σ) · κ with each absent term = its identity (058d read-side projection).
	const a = n(m.activation) ?? n(m.freshnessScore) ?? 1;
	const cFactor = n(m.calibratedConfidence) ?? 1;
	const sigma = n(m.staleness) ?? 0;
	const kappa = n(m.kappa) ?? 1;
	const clamp = (x: number): number => Math.min(1, Math.max(0, x));
	const health = clamp(a) * clamp(cFactor) * (1 - clamp(sigma)) * clamp(kappa);
	out(`memory ${s(m.id) || inv.arg} — lifecycle`);
	out(`  freshnessScore        ${n(m.freshnessScore) ?? n(m.activation) ?? "(none)"}`);
	out(`  calibratedConfidence  ${n(m.calibratedConfidence) ?? "(none — calibration dormant)"}`);
	out(`  refStatus             ${s(m.refStatus) || "unknown"}`);
	out(`  open-conflict         ${m.openConflict === true ? "yes" : "no"}`);
	out(`  H (health)            ${health.toFixed(3)}`);
	return { exitCode: 0 };
}
