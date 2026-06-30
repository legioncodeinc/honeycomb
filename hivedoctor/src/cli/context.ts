/**
 * The CLI execution context: IO seams + injected dependencies (PRD-064f).
 *
 * Every command runs against a {@link CliContext} so the whole CLI is hermetic: stdout,
 * the confirm prompt, and every external action (probe, ladder run, npm install, version
 * reads, incident-log tail) are injected. A test captures `out`, scripts `confirm`, and
 * asserts which deps were called. The real `process.stdout` / interactive prompt / live
 * deps are wired by the entry point ({@link file://./index.ts}) and the composition root.
 *
 * AC-064f.6 falls out of this design: `status` and `diagnose` only ever call the injected
 * probe/version seams, each of which resolves a value when the daemon is down - so they
 * work with no daemon present.
 *
 * Built-ins only; this module is types + the IO surface, no I/O of its own.
 */

import type { Colors } from "./colors.js";
import type { ReadInstalledVersionFn } from "../update/update-engine.js";
import type { HealthClassification } from "../health-probe.js";
import type { LadderDecision, RemediationLadder, RungContext } from "../remediation.js";
import type { ServiceModule } from "./service-stub.js";
import type { ResolvedOptOut } from "./opt-out.js";

/** A captured line of output (text + which stream it went to). */
export interface OutputLine {
	readonly stream: "stdout" | "stderr";
	readonly text: string;
}

/** The output sink: tests capture; production writes to the real streams. */
export interface OutputSink {
	/** Write a line to stdout (a trailing newline is added by the sink). */
	out(text: string): void;
	/** Write a line to stderr (a trailing newline is added by the sink). */
	err(text: string): void;
}

/** The confirm prompt seam (gated/destructive commands). Resolves true to proceed. */
export type ConfirmFn = (question: string) => Promise<boolean>;

/** How the auto-update poll loop / engine bits are exposed to the CLI `update`/`self-update`. */
export interface UpdateActions {
	/**
	 * Preview the primary-daemon update decision WITHOUT installing (`update --check`).
	 * Returns a human-readable line describing what an update would do.
	 */
	checkPrimaryUpdate(): Promise<string>;
	/** Apply the primary-daemon update through the blessed gate (`update`). */
	applyPrimaryUpdate(): Promise<string>;
	/**
	 * The ONE path that updates HiveDoctor's own package (`self-update`, AC-064f.5).
	 * Implemented in {@link file://./self-update.ts}; injected so tests assert it is the
	 * only command that ever calls it.
	 */
	selfUpdate(): Promise<string>;
}

/** Reads the recent incident-log lines for `logs`. */
export type TailIncidentsFn = (limit: number) => Promise<readonly string[]>;

/** Snapshot of the persisted state the `status` command reports (read defensively). */
export interface StatusStateSnapshot {
	/** The last confirmed heal time (ISO-8601), or null. */
	readonly lastHealAt: string | null;
	/** The last coarse daemon health HiveDoctor recorded. */
	readonly lastKnownHealth: string;
}

/** Reads the durable state snapshot for `status`. */
export type ReadStatusStateFn = () => StatusStateSnapshot;

/** Coarse HiveDoctor service state for `status` (064b owns the real registration). */
export type ServiceState = "running" | "not-running" | "unknown";

/** The injected dependencies every command shares. */
export interface CliDeps {
	/** Probe + classify `/health` (returns a classification even when the daemon is down). */
	readonly probe: () => Promise<HealthClassification>;
	/** Read the daemon's reported version from `/health`, or null when unreachable. */
	readonly readDaemonVersion: ReadInstalledVersionFn;
	/** HiveDoctor's own package version (single-sourced via src/version.ts). */
	readonly hivedoctorVersion: string;
	/** The remediation ladder (decide + run rungs), shared with the watch loop. */
	readonly ladder: RemediationLadder;
	/** Build a rung context from a classification (logger comes from the dep wiring). */
	readonly rungContextFor: (classification: HealthClassification) => RungContext;
	/** Decide the recommended rung for the current failure count (for `diagnose`). */
	readonly decideRung: (consecutiveRestartFailures: number) => LadderDecision;
	/** Read the persisted consecutive-restart-failure count (for `diagnose` rung choice). */
	readonly readConsecutiveFailures: () => number;
	/** Read the status-state snapshot (last heal, last-known health). */
	readonly readStatusState: ReadStatusStateFn;
	/**
	 * Coarse HiveDoctor service state - the SYNC seam, retained for the test harness. The production
	 * wiring injects the ASYNC {@link serviceStateAsync} instead; `runStatus` only falls back to this
	 * when the async probe is absent.
	 */
	readonly serviceState: () => ServiceState;
	/**
	 * The bounded ASYNC service-state probe `status` prefers (IRD-192 AC-5): wired to
	 * `serviceStatus()` (the real OS-service-manager query) in the composition root, bounded by the
	 * existing service-command timeout so `status` never blocks indefinitely. A registered task
	 * resolves to a real state, not a hardcoded "unknown". Optional: when absent, `runStatus` uses the
	 * sync {@link serviceState} seam (the test-harness default).
	 */
	readonly serviceStateAsync?: () => Promise<ServiceState>;
	/** The resolved opt-out + pin (auto-update disabled? pinned? which layer?). */
	readonly optOut: ResolvedOptOut;
	/** Update actions (primary update + the sacred self-update). */
	readonly update: UpdateActions;
	/** Tail recent incident-log lines for `logs`. */
	readonly tailIncidents: TailIncidentsFn;
	/**
	 * The 064b service module, when wired in. When absent, `install-service`/`uninstall-service`
	 * print the "not yet available" stub message. The composition root injects the real module.
	 */
	readonly serviceModule?: ServiceModule;
}

/** Everything a command needs: IO + styling + deps. */
export interface CliContext {
	/** Output sink. */
	readonly io: OutputSink;
	/** Confirm prompt (gated commands). */
	readonly confirm: ConfirmFn;
	/** Styling surface. */
	readonly colors: Colors;
	/** Injected dependencies. */
	readonly deps: CliDeps;
}
