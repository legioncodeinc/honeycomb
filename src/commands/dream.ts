/**
 * `honeycomb dream` thin-client verb — PRD-026 Wave 2a (Deliverable 3).
 *
 * The manual operator override for the PRD-009 dreaming loop. `honeycomb dream trigger`
 * POSTs to the daemon's `POST /api/diagnostics/dream` endpoint (the "Dream now" trigger
 * seam, PRD-024 `mountDreamApi`) through the {@link DaemonClient} seam — the SAME loopback
 * path every storage verb uses, so the actor/scope/loopback headers are stamped by the
 * shared `createLoopbackDaemonClient`, never re-implemented here.
 *
 * ── It is a THIN CLIENT (D-2 / the dispatcher thesis) ─────────────────────────
 * This handler imports NO `daemon/storage` path and holds NO dreaming lifecycle: it builds
 * a {@link DaemonRequest}, dispatches it through `deps.daemon.send`, and renders the ack the
 * daemon returns. The daemon owns the trigger (the counter + the single-pending guard + the
 * enqueue); the CLI dispatches intent. `src/commands` is a NON_DAEMON_ROOT, so a stray
 * storage import FAILS the build (`invariant.test.ts`) — the thin-client property is enforced.
 *
 * ── The endpoint is the diagnostics "Dream now" trigger ───────────────────────
 * `POST /api/diagnostics/dream` evaluates the daemon's OWN dreaming counter + guard and
 * enqueues AT MOST ONE pass, returning a small ack: `{triggered:true,status:"enqueued"}` at/
 * over threshold; `{triggered:true,status:"running"}` when a pass is already pending or the
 * counter is below threshold; `{triggered:false,status:"skipped",reason:"disabled"}` when the
 * `HONEYCOMB_DREAMING_ENABLED` master switch is off. The ack carries NO token/secret (AC-6);
 * this handler renders only the decision + the short machine reason.
 *
 * ── `--compact` ───────────────────────────────────────────────────────────────
 * `honeycomb dream trigger --compact` asks for a full-graph COMPACTION pass: the body carries
 * `{mode:"compaction"}` so the daemon's trigger enqueues a compaction job (the mode the
 * runner's strategy selector reads). Without `--compact` the daemon picks the mode (incremental
 * in steady state; compaction on the first-run backfill). Either way the endpoint owns the
 * mode→strategy choice; the CLI only forwards the operator's preference.
 */

import {
	type CommandDeps,
	type CommandResult,
	type DaemonRequest,
	type DaemonResponse,
	type OutputSink,
} from "./contracts.js";

/** The daemon route the `dream` verb dispatches to (the PRD-024 "Dream now" trigger seam). */
export const DREAM_ENDPOINT = "/api/diagnostics/dream" as const;

/** The parsed `dream` invocation: the subcommand + the `--compact` preference. */
export interface DreamCliInvocation {
	/** The subcommand word (`trigger` | unknown). */
	readonly subCommand: string;
	/** `--compact` present → request a full-graph compaction pass. */
	readonly compact: boolean;
}

/** The ack body the daemon returns (defensive: every field optional across the IO boundary). */
interface DreamAckBody {
	/** True when the trigger ran (enqueued OR found the loop already busy/below-threshold). */
	readonly triggered?: boolean;
	/** The coarse status: a pass was queued, one is already running, or the trigger was skipped. */
	readonly status?: string;
	/** A short machine reason (present for `running`/`skipped`); carries no token/secret. */
	readonly reason?: string;
}

/**
 * Parse a raw `dream` argv tail (everything AFTER the `dream` word) into a typed
 * {@link DreamCliInvocation}. The first non-flag word is the subcommand; `--compact` is the
 * only recognized flag. Pure: no IO, fully testable.
 */
export function parseDreamCliArgs(argv: readonly string[]): DreamCliInvocation {
	let subCommand = "";
	let compact = false;
	for (const a of argv) {
		if (a === "--compact") {
			compact = true;
		} else if (!a.startsWith("--") && subCommand === "") {
			subCommand = a;
		}
	}
	return { subCommand, compact };
}

/** Narrow an unknown daemon body into a {@link DreamAckBody} (defensive across the IO boundary). */
function asAck(body: unknown): DreamAckBody {
	if (typeof body !== "object" || body === null) return {};
	return body as DreamAckBody;
}

/**
 * Render the daemon's dream ack as one human line. `enqueued` → a pass was queued; `running`
 * → the loop is healthy but nothing new was queued (a pass is in flight or below threshold);
 * `skipped` → the dreaming master switch is off (or the subsystem is unavailable). The reason
 * is the daemon's short machine string — never a token or secret.
 */
function renderAck(ack: DreamAckBody, out: OutputSink): void {
	const status = ack.status ?? "unknown";
	const suffix = ack.reason !== undefined && ack.reason.length > 0 ? ` (${ack.reason})` : "";
	switch (status) {
		case "enqueued":
			out("dream: a consolidation pass was enqueued.");
			break;
		case "running":
			out(`dream: the loop is healthy; no new pass queued${suffix}.`);
			break;
		case "skipped":
			out(`dream: skipped${suffix}. Enable with HONEYCOMB_DREAMING_ENABLED=true.`);
			break;
		default:
			out(`dream: ${status}${suffix}.`);
			break;
	}
}

/**
 * Run the `dream` verb (Deliverable 3). `dream trigger [--compact]` POSTs to
 * `/api/diagnostics/dream` through the daemon seam and renders the ack; any other subcommand
 * prints usage. The dispatch goes ONLY through `deps.daemon` — no DeepLake. A non-2xx daemon
 * status renders an error and exits 1.
 */
export async function runDreamVerb(argv: readonly string[], deps: CommandDeps): Promise<CommandResult> {
	const out: OutputSink = deps.out ?? ((line: string): void => console.log(line));
	const inv = parseDreamCliArgs(argv);

	if (inv.subCommand !== "trigger") {
		out("usage: honeycomb dream trigger [--compact]");
		out("       trigger a dreaming consolidation pass on the loopback daemon.");
		// An empty subcommand is a benign usage print (exit 0); an unknown one is an error (exit 1).
		return { exitCode: inv.subCommand === "" ? 0 : 1 };
	}

	// `--compact` asks the daemon for a full-graph compaction pass; otherwise the daemon picks
	// the mode (incremental in steady state, compaction on first-run backfill).
	const req: DaemonRequest = {
		method: "POST",
		path: DREAM_ENDPOINT,
		...(inv.compact ? { body: { mode: "compaction" } } : {}),
	};
	const res: DaemonResponse = await deps.daemon.send(req);
	if (res.status >= 400) {
		out(`error: dream failed (daemon ${res.status}).`);
		return { exitCode: 1 };
	}
	renderAck(asAck(res.body), out);
	return { exitCode: 0 };
}
