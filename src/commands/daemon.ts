/**
 * `honeycomb daemon start|stop|status` + ensure-running-on-demand — PRD-021b (b-AC-2 / b-AC-3).
 *
 * The daemon LIFECYCLE verbs the CLI owns. `start` brings the daemon up (via 021a's
 * `runAssembledDaemon`, reached through a SPAWNED detached process so `src/commands` stays a thin
 * client — it never imports `daemon/storage`); `stop` signals it to drain gracefully; `status`
 * reports whether it is running on 3850 via the 021a PID/lock guard plus a live `/health` probe.
 *
 * ── Thin-client boundary (D-2) ───────────────────────────────────────────────
 * This module imports NOTHING from `daemon/storage` and holds no DeepLake handle. It reaches the
 * daemon two ways only: over HTTP through the injected {@link DaemonClient} seam (the `/health`
 * probe lives in `daemon.ping()`), and over the PROCESS boundary through the {@link DaemonLifecycle}
 * seam (spawn / signal / read the PID-lock). The real lifecycle (`src/cli/runtime.ts`) spawns the
 * bundled `daemon/index.js`, whose `runAssembledDaemon` IS the only importer of `daemon/storage`
 * (021a a-AC-1) — so the composition root stays in the daemon, never the CLI.
 *
 * ── Ensure-running-on-demand (b-AC-3) ────────────────────────────────────────
 * {@link ensureDaemonRunning} is the idempotent guard a storage verb calls before dispatching: if
 * the daemon answers `/health` it returns immediately; otherwise it starts one (through the same
 * 021a PID/lock guard, so a concurrent start never double-binds) and waits for it to bind, so a
 * storage verb never fails with ECONNREFUSED for a daemon the user simply had not started.
 */

import {
	type CommandResult,
	type DaemonClient,
	type OutputSink,
} from "./contracts.js";

/** The status the {@link DaemonLifecycle} reports for `daemon status` (b-AC-2). */
export interface DaemonStatus {
	/** True when a daemon process holds the 021a PID/lock (a live pid recorded). */
	readonly running: boolean;
	/** The recorded pid, when the lock is held by a live process. */
	readonly pid?: number;
	/** The port the daemon is bound to (3850 in production). */
	readonly port: number;
	/**
	 * PRD-064h: the OS service manager supervising the daemon when it runs as a service
	 * (`launchd` / `systemd-user` / `schtasks`), or omitted in the detached-spawn fallback. Lets
	 * `daemon status` report "running as a launchd service" vs "running (detached)" honestly.
	 */
	readonly serviceManager?: "launchd" | "systemd-user" | "schtasks";
}

/**
 * The daemon process-lifecycle SEAM (b-AC-2 / b-AC-3 / D-2). The CLI controls the daemon PROCESS
 * through this — never by importing the composition root (which would drag `daemon/storage` into
 * the thin client). The real impl (`src/cli/runtime.ts`) spawns the bundled `daemon/index.js`
 * detached and reads/signals the 021a PID/lock; a test injects a fake recording start/stop calls.
 */
export interface DaemonLifecycle {
	/**
	 * Bring the daemon up (b-AC-2). Idempotent via the 021a PID/lock guard: a start against an
	 * already-running daemon is a no-op (it does NOT double-bind 3850). Resolves once the daemon
	 * answers `/health` (or the wait budget is exhausted, surfaced as `started:false`).
	 */
	start(): Promise<{ readonly started: boolean; readonly alreadyRunning: boolean }>;
	/** Signal the running daemon to drain + shut down gracefully (b-AC-2). No-op when down. */
	stop(): Promise<{ readonly stopped: boolean }>;
	/** Read the current run state from the 021a PID/lock guard (b-AC-2). */
	status(): Promise<DaemonStatus>;
	/**
	 * Restart the daemon (PRD-064h AC-064h.5). OPTIONAL on the seam (additive): when the daemon runs
	 * as an OS service the real impl restarts it THROUGH the service manager (`launchctl kickstart` /
	 * `systemctl --user restart` / schtasks stop+run) so HiveDoctor's rung-1 never spawns a second
	 * process that would fight the service for the 3850 bind; in the detached-spawn fallback it
	 * stop+starts via the PID/lock path. The 021a single-instance guard prevents any double-bind.
	 * Resolves `{ restarted, viaService }` so the caller / HiveDoctor knows which path ran. A seam
	 * that does not implement it (an older recording fake) simply omits it; callers guard with `?.`.
	 */
	restart?(): Promise<{ readonly restarted: boolean; readonly viaService: boolean }>;
}

/** The deps the `daemon` verb runs against — the daemon HTTP seam + the lifecycle seam. */
export interface DaemonVerbDeps {
	/** The loopback daemon client (the `/health` probe is `daemon.ping()`). */
	readonly daemon: DaemonClient;
	/** The process-lifecycle seam (spawn / signal / read-lock). Bound at assembly; faked in tests. */
	readonly lifecycle?: DaemonLifecycle;
	/** The output sink (defaults to `console.log`). */
	readonly out?: OutputSink;
}

/** Pull the `daemon` subcommand (`start` | `stop` | `status`) off the argv tail. */
export function parseDaemonArgs(argv: readonly string[]): string {
	return argv.find((a) => !a.startsWith("--")) ?? "status";
}

/** Run `honeycomb daemon start` (b-AC-2). */
async function start(deps: DaemonVerbDeps, out: OutputSink): Promise<CommandResult> {
	if (deps.lifecycle === undefined) {
		out("daemon start: no daemon lifecycle is available in this context.");
		return { exitCode: 1 };
	}
	const { started, alreadyRunning } = await deps.lifecycle.start();
	if (alreadyRunning) {
		out("daemon: already running on 127.0.0.1:3850.");
		return { exitCode: 0 };
	}
	if (started) {
		out("daemon: started on 127.0.0.1:3850.");
		return { exitCode: 0 };
	}
	// The readiness budget was exhausted without a `/health` answer. Distinguish a daemon that is
	// still WARMING UP (the process is up and holds the 021a PID/lock, just not answering yet — a
	// cold boot warms embeddings + wires workers, which can exceed the budget) from a genuine
	// failure. Reporting "failed to start" at a daemon that is actually coming up is exactly what
	// made a slow-but-fine boot look like a crash.
	const status = await deps.lifecycle.status();
	if (status.running) {
		out(
			`daemon: starting — the process is up (pid ${status.pid ?? "?"}) but has not answered /health within the start budget; it is likely still warming up. Re-check with \`honeycomb daemon status\`.`,
		);
		return { exitCode: 0 };
	}
	out("daemon: failed to start (did not become reachable on 127.0.0.1:3850).");
	return { exitCode: 1 };
}

/** Run `honeycomb daemon stop` (b-AC-2). */
async function stop(deps: DaemonVerbDeps, out: OutputSink): Promise<CommandResult> {
	if (deps.lifecycle === undefined) {
		out("daemon stop: no daemon lifecycle is available in this context.");
		return { exitCode: 1 };
	}
	const { stopped } = await deps.lifecycle.stop();
	out(stopped ? "daemon: stopped." : "daemon: not running.");
	return { exitCode: 0 };
}

/** Run `honeycomb daemon status` (b-AC-2): the PID/lock state + a live `/health` probe. */
async function status(deps: DaemonVerbDeps, out: OutputSink): Promise<CommandResult> {
	if (deps.lifecycle === undefined) {
		// Even without the lifecycle seam, the HTTP reachability answer is still useful.
		const alive = await deps.daemon.ping();
		out(`daemon: ${alive ? "up (127.0.0.1:3850)" : "down"}`);
		return { exitCode: 0 };
	}
	const state = await deps.lifecycle.status();
	const reachable = await deps.daemon.ping();
	if (state.running && reachable) {
		out(`daemon: running on 127.0.0.1:${state.port}${state.pid !== undefined ? ` (pid ${state.pid})` : ""}.`);
	} else if (state.running && !reachable) {
		out(`daemon: process holds the lock${state.pid !== undefined ? ` (pid ${state.pid})` : ""} but is not answering /health yet.`);
	} else {
		out("daemon: not running.");
	}
	return { exitCode: 0 };
}

/**
 * Run `honeycomb daemon <start|stop|status>` (b-AC-2). Routes the subcommand to the lifecycle seam
 * (start/stop) or the combined PID-lock + `/health` status read. Every effect goes through the
 * injected seams — never a direct daemon-core import (D-2).
 */
export async function runDaemonCommand(argv: readonly string[], deps: DaemonVerbDeps): Promise<CommandResult> {
	const out: OutputSink = deps.out ?? ((line: string): void => console.log(line));
	const sub = parseDaemonArgs(argv);
	if (sub === "start") return start(deps, out);
	if (sub === "stop") return stop(deps, out);
	if (sub === "status") return status(deps, out);
	out("usage: honeycomb daemon <start | stop | status>");
	return { exitCode: 1 };
}

/**
 * Ensure a daemon is running before a storage verb dispatches (b-AC-3). Idempotent: if the daemon
 * already answers `/health`, return at once; otherwise start one (through the 021a PID/lock guard,
 * so a concurrent start never double-binds) and wait for it to bind. Returns whether the daemon is
 * reachable AFTER the attempt — a storage verb proceeds on `true` and surfaces a clear error on
 * `false` (rather than an opaque ECONNREFUSED).
 *
 * No lifecycle seam bound (e.g. a degraded build) → best-effort: report the current reachability
 * without trying to start, so the caller still gets a truthful answer.
 */
export async function ensureDaemonRunning(deps: DaemonVerbDeps): Promise<boolean> {
	if (await deps.daemon.ping()) return true;
	if (deps.lifecycle === undefined) return false;
	const { started, alreadyRunning } = await deps.lifecycle.start();
	if (alreadyRunning || started) {
		// The lifecycle's `start()` resolves only once /health answers, but re-probe so the
		// caller's decision is based on the HTTP seam it will actually dispatch through.
		return deps.daemon.ping();
	}
	return false;
}
