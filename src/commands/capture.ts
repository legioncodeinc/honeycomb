/**
 * `honeycomb capture` thin-client verb — PRD-079b (b-AC-4).
 *
 * The operator entry point for the durable capture retry outbox. `honeycomb capture drain` POSTs to
 * the daemon's `POST /api/diagnostics/capture-drain` endpoint (the force-drain trigger seam,
 * `mountCaptureDrainApi`) through the {@link DaemonClient} seam — the SAME loopback path every
 * storage verb uses, so the actor/scope/loopback headers are stamped by the shared
 * `createLoopbackDaemonClient`, never re-implemented here. It forces one drain pass and prints the
 * `{ drained, retried, deadLettered }` counts so an operator can flush a degraded-window backlog on
 * demand instead of waiting for the 30s interval / the next successful capture.
 *
 * ── It is a THIN CLIENT (the dispatcher thesis) ──────────────────────────────
 * This handler imports NO `daemon/storage` path and holds NO drain logic: it builds a
 * {@link DaemonRequest}, dispatches it through `deps.daemon.send`, and renders the counts the daemon
 * returns. The daemon owns the outbox (the guarded re-append, the backoff, the dead-letter
 * transition); the CLI dispatches intent. `src/commands` is a NON_DAEMON_ROOT, so a stray storage
 * import FAILS the build (`invariant.test.ts`).
 *
 * ── Read-through fail-soft (b-AC-4) ──────────────────────────────────────────
 * A daemon-down (send rejects / never connects) or an error status is reported CLEANLY (a one-line
 * message + a non-zero exit code) — the command NEVER throws. The drain itself is fail-soft on the
 * daemon; this handler mirrors that posture on the client side.
 */

import { type CommandDeps, type CommandResult, type DaemonRequest, type OutputSink } from "./contracts.js";

/** The daemon route the `capture drain` verb dispatches to (the PRD-079b force-drain trigger seam). */
export const CAPTURE_DRAIN_ENDPOINT = "/api/diagnostics/capture-drain" as const;

/** The count triple the daemon returns (defensive: every field optional across the IO boundary). */
interface CaptureDrainBody {
	/** Rows re-appended OK and removed from the outbox this pass. */
	readonly drained?: number;
	/** Rows whose re-append failed this pass and stayed pending. */
	readonly retried?: number;
	/** Rows moved to terminal `dead` this pass (hit `maxAttempts` OR exceeded `maxAgeMs`). */
	readonly deadLettered?: number;
}

/** Narrow an unknown daemon body into a {@link CaptureDrainBody} + coerce each count to a non-negative int. */
function asDrainBody(body: unknown): { drained: number; retried: number; deadLettered: number } {
	const b = typeof body === "object" && body !== null ? (body as CaptureDrainBody) : {};
	const coerce = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? Math.max(0, Math.trunc(n)) : 0);
	return { drained: coerce(b.drained), retried: coerce(b.retried), deadLettered: coerce(b.deadLettered) };
}

/**
 * Run the `capture` verb (b-AC-4). `honeycomb capture drain` forces one outbox drain pass on the
 * daemon and renders the counts; any other subcommand prints usage. The dispatch goes ONLY through
 * `deps.daemon` — no DeepLake. Read-through fail-soft: a daemon-down / error path reports cleanly
 * and exits non-zero, never throws.
 */
export async function runCaptureVerb(argv: readonly string[], deps: CommandDeps): Promise<CommandResult> {
	const out: OutputSink = deps.out ?? ((line: string): void => console.log(line));
	const subCommand = argv.find((a) => !a.startsWith("--")) ?? "";

	if (subCommand !== "drain") {
		out("usage: honeycomb capture drain");
		out("       force one capture-outbox drain pass on the daemon and print the counts.");
		// An empty subcommand is a benign usage print (exit 0); an unknown one is an error (exit 1).
		return { exitCode: subCommand === "" ? 0 : 1 };
	}

	const req: DaemonRequest = { method: "POST", path: CAPTURE_DRAIN_ENDPOINT };
	let status: number;
	let body: unknown;
	try {
		const res = await deps.daemon.send(req);
		status = res.status;
		body = res.body;
	} catch {
		// Read-through fail-soft: a daemon-down / connection error is reported cleanly, never thrown.
		out("error: capture drain could not reach the daemon on 127.0.0.1:3850.");
		return { exitCode: 1 };
	}
	if (status >= 400) {
		out(`error: capture drain failed (daemon ${status}).`);
		return { exitCode: 1 };
	}
	const counts = asDrainBody(body);
	out(
		`capture drain: ${counts.drained} drained, ${counts.retried} retried, ${counts.deadLettered} dead-lettered.`,
	);
	return { exitCode: 0 };
}
