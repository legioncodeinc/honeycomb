/**
 * Test harness: builds a fully-wired supervisor over fakes + a temp workspace, so
 * each AC test drives the real loop with deterministic time and injected I/O.
 *
 * Built-ins only (node:fs, node:os, node:path) for the temp workspace, matching the
 * package's runtime constraint.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createBackoff } from "../../src/backoff.js";
import { createIncidentLog } from "../../src/incidents.js";
import { silentLogger, type Logger } from "../../src/logger.js";
import {
	createRemediationLadder,
	createRestartRung,
	type ReadDaemonPidFn,
	type RestartFn,
	type Rung,
} from "../../src/remediation.js";
import { createStateStore } from "../../src/state.js";
import { createSupervisor, type ErrorSink, type ProbeFn, type Supervisor, type SupervisorClock } from "../../src/supervisor.js";

/** A deterministic, advanceable fake clock. */
export interface FakeClock extends SupervisorClock {
	advance(ms: number): void;
}

/** Build a fake clock starting at `start` ms; `sleep` resolves immediately (no real wait). */
export function createFakeClock(start = 0): FakeClock {
	let t = start;
	return {
		now: () => t,
		sleep: async (): Promise<void> => {
			// No real delay: the loop's interval/backoff sleeps are collapsed for tests. Time only
			// advances when the test explicitly calls `advance` (e.g. to cross the cooldown window).
		},
		advance: (ms: number) => {
			t += ms;
		},
	};
}

/** A throwaway temp workspace dir + a cleanup fn. */
export function makeWorkspace(): { dir: string; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "hivedoctor-test-"));
	return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Knobs for {@link buildHarness}. */
export interface HarnessOptions {
	readonly probe: ProbeFn;
	readonly restart: RestartFn;
	readonly readDaemonPid?: ReadDaemonPidFn;
	readonly isHealthy?: () => Promise<boolean>;
	readonly restartGiveUpThreshold?: number;
	readonly cooldownMs?: number;
	readonly logger?: Logger;
	readonly clock?: FakeClock;
	/** Startup/post-restart grace in ms. Defaults to 0 so older supervisor tests keep legacy immediacy. */
	readonly startupGraceMs?: number;
	/** Extra rungs to register beyond rung 1 (default: none, so rung 2 is an unimplemented slot). */
	readonly extraRungs?: readonly Rung[];
	/** Replace the default restart rung 1 with a custom rung (for the targeted-classification test). */
	readonly rung1?: Rung;
	/** Optional error-telemetry seam (PRD-064d) so a test asserts caught errors route to the error stream. */
	readonly onError?: ErrorSink;
}

/** A built harness exposing the supervisor + the fakes the test asserts against. */
export interface Harness {
	readonly supervisor: Supervisor;
	readonly clock: FakeClock;
	readonly workspaceDir: string;
	readonly cleanup: () => void;
	/** The current persisted state (re-read from disk). */
	readState(): ReturnType<ReturnType<typeof createStateStore>["read"]>;
	/** The raw incident NDJSON lines written so far. */
	readIncidents(): unknown[];
}

/** Wire a complete supervisor over fakes + a temp workspace. */
export function buildHarness(options: HarnessOptions): Harness {
	const { dir, cleanup } = makeWorkspace();
	const logger = options.logger ?? silentLogger;
	const clock = options.clock ?? createFakeClock();
	const stateStore = createStateStore({ workspaceDir: dir, logger });
	const incidents = createIncidentLog({ workspaceDir: dir, logger, now: () => clock.now() });
	// Deterministic backoff: no jitter, fixed RNG, so delay assertions are stable.
	const backoff = createBackoff({ floorMs: 1_000, ceilingMs: 30_000, jitter: 0, random: () => 0.5 });

	let lastRestartAt: number | null = null;
	const restartRung = createRestartRung({
		restart: options.restart,
		readDaemonPid: options.readDaemonPid ?? (async () => null),
		isHealthy: options.isHealthy ?? (async () => false),
		cooldownMs: options.cooldownMs ?? 5_000,
		clock: { now: () => clock.now() },
		lastRestartAt: () => lastRestartAt,
		markRestarted: (at: number) => {
			lastRestartAt = at;
		},
	});

	const ladder = createRemediationLadder({
		rungs: [options.rung1 ?? restartRung, ...(options.extraRungs ?? [])],
		restartGiveUpThreshold: options.restartGiveUpThreshold ?? 3,
		logger,
	});

	const supervisor = createSupervisor({
		probe: options.probe,
		ladder,
		backoff,
		stateStore,
		incidents,
		logger,
		clock,
		probeIntervalMs: 30_000,
		startupGraceMs: options.startupGraceMs ?? 0,
		...(options.onError !== undefined ? { onError: options.onError } : {}),
	});

	return {
		supervisor,
		clock,
		workspaceDir: dir,
		cleanup,
		readState: () => stateStore.read(),
		readIncidents: () => {
			// Read incidents.ndjson defensively; empty when nothing was written.
			try {
				const raw = readFileSync(join(dir, "incidents.ndjson"), "utf8");
				return raw
					.split("\n")
					.filter((l) => l.trim() !== "")
					.map((l) => JSON.parse(l) as unknown);
			} catch {
				return [];
			}
		},
	};
}
