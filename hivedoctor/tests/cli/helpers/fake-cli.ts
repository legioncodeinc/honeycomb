/**
 * CLI test harness: build a fully-faked {@link CliContext} with captured output, a
 * scripted confirm, and spy-able deps, so each AC test drives the real dispatcher
 * hermetically (no process, no network, no npm, no daemon).
 *
 * Built-ins only, matching the package's runtime constraint.
 */

import { vi } from "vitest";

import { createColors } from "../../../src/cli/colors.js";
import type {
	CliContext,
	CliDeps,
	ConfirmFn,
	OutputSink,
	ServiceState,
	StatusStateSnapshot,
} from "../../../src/cli/context.js";
import { resolveOptOut, type ResolvedOptOut } from "../../../src/cli/opt-out.js";
import { silentLogger } from "../../../src/logger.js";
import type { HealthClassification } from "../../../src/health-probe.js";
import type { LadderDecision, RemediationLadder, RungContext, RungResult } from "../../../src/remediation.js";

/** A capturing output sink: every line is recorded with its stream. */
export interface CapturedOutput extends OutputSink {
	readonly stdout: string[];
	readonly stderr: string[];
	/** The full stdout joined with newlines (for substring assertions). */
	text(): string;
	/** The full stderr joined with newlines. */
	errText(): string;
}

/** Build a capturing output sink. */
export function captureOutput(): CapturedOutput {
	const stdout: string[] = [];
	const stderr: string[] = [];
	return {
		stdout,
		stderr,
		out: (t: string) => stdout.push(t),
		err: (t: string) => stderr.push(t),
		text: () => stdout.join("\n"),
		errText: () => stderr.join("\n"),
	};
}

/** A spy-able ladder that records decide()/run()/escalate() calls. */
export interface FakeLadder extends RemediationLadder {
	readonly runCalls: number[];
	readonly escalateCalls: number;
}

/** Build a fake ladder. `decideResult` controls the recommended rung; run() resolves `runResult`. */
export function fakeLadder(opts?: {
	decideResult?: LadderDecision;
	runResult?: RungResult;
}): FakeLadder {
	const runCalls: number[] = [];
	let escalateCalls = 0;
	const decideResult = opts?.decideResult ?? { rung: 1, advanced: false };
	const runResult = opts?.runResult ?? { ok: true, action: "restart-daemon" };
	return {
		runCalls,
		get escalateCalls() {
			return escalateCalls;
		},
		decide(): LadderDecision {
			return decideResult;
		},
		async run(rung: number, _ctx: RungContext): Promise<RungResult> {
			runCalls.push(rung);
			return { ...runResult, action: runResult.action };
		},
		async escalate(): Promise<RungResult> {
			escalateCalls += 1;
			return { ok: true, action: "escalate" };
		},
	};
}

/** Knobs for {@link buildCliHarness}. */
export interface CliHarnessOptions {
	/** The classification probe resolves (default: ok). */
	readonly classification?: HealthClassification;
	/** The daemon version readDaemonVersion resolves (default: "1.2.3"; null = unreachable). */
	readonly daemonVersion?: string | null;
	/** Confirm answer (default: true). A function gets the question for assertion. */
	readonly confirm?: boolean | ConfirmFn;
	/** Override the ladder (default: a fresh fakeLadder). */
	readonly ladder?: FakeLadder;
	/** The decide() result for diagnose/heal (default: rung 1). */
	readonly decision?: LadderDecision;
	/** The consecutive-failure count (default: 0). */
	readonly consecutiveFailures?: number;
	/** The status-state snapshot (default: never healed, unknown health). */
	readonly statusState?: StatusStateSnapshot;
	/** The coarse service state (default: "unknown"). The sync seam value. */
	readonly serviceState?: ServiceState;
	/**
	 * The bounded async service-state probe (IRD-192 AC-5). When provided, `runStatus` awaits it
	 * instead of the sync {@link serviceState} seam; default absent so tests that only set
	 * `serviceState` still drive the sync path. A registered-task test sets this to e.g.
	 * `async () => "running"`.
	 */
	readonly serviceStateAsync?: () => Promise<ServiceState>;
	/** The resolved opt-out (default: not disabled). */
	readonly optOut?: ResolvedOptOut;
	/** Incident log tail lines (default: none). */
	readonly incidents?: readonly string[];
	/** Whether a 064b service module is wired (default: absent). */
	readonly serviceModule?: CliDeps["serviceModule"];
	/** Force color on/off (default off, so assertions are plain text). */
	readonly color?: boolean;
}

/** A built CLI harness: the context + the spies the tests assert against. */
export interface CliHarness {
	readonly ctx: CliContext;
	readonly out: CapturedOutput;
	readonly ladder: FakeLadder;
	readonly selfUpdate: ReturnType<typeof vi.fn>;
	readonly applyPrimaryUpdate: ReturnType<typeof vi.fn>;
	readonly checkPrimaryUpdate: ReturnType<typeof vi.fn>;
	readonly confirmSpy: ReturnType<typeof vi.fn>;
}

/** Wire a complete CLI context over fakes. */
export function buildCliHarness(options: CliHarnessOptions = {}): CliHarness {
	const out = captureOutput();
	const ladder = options.ladder ?? fakeLadder({ decideResult: options.decision });
	const classification = options.classification ?? { kind: "ok" as const };
	const daemonVersion = options.daemonVersion === undefined ? "1.2.3" : options.daemonVersion;

	const confirmAnswer = options.confirm ?? true;
	const confirmSpy = vi.fn(async (question: string): Promise<boolean> => {
		if (typeof confirmAnswer === "function") return confirmAnswer(question);
		return confirmAnswer;
	});

	const selfUpdate = vi.fn(async () => "HiveDoctor updated (self-update ran).");
	const applyPrimaryUpdate = vi.fn(async () => "Update updated: 1.2.3 -> 1.2.4.");
	const checkPrimaryUpdate = vi.fn(async () => "No update: already_current.");

	const ctx: CliContext = {
		io: out,
		confirm: confirmSpy,
		colors: createColors({ env: {}, isTty: options.color ?? false }),
		deps: {
			probe: async () => classification,
			readDaemonVersion: async () => daemonVersion,
			hivedoctorVersion: "9.9.9-test",
			ladder,
			rungContextFor: (c) => ({ classification: c, logger: silentLogger }),
			decideRung: (n) => ladder.decide(n),
			readConsecutiveFailures: () => options.consecutiveFailures ?? 0,
			readStatusState: () => options.statusState ?? { lastHealAt: null, lastKnownHealth: "unknown" },
			serviceState: () => options.serviceState ?? "unknown",
			...(options.serviceStateAsync !== undefined ? { serviceStateAsync: options.serviceStateAsync } : {}),
			optOut: options.optOut ?? resolveOptOut({ cliNoAutoUpdate: false, env: {} }),
			update: { checkPrimaryUpdate, applyPrimaryUpdate, selfUpdate },
			tailIncidents: async () => options.incidents ?? [],
			...(options.serviceModule !== undefined ? { serviceModule: options.serviceModule } : {}),
		},
	};

	return { ctx, out, ladder, selfUpdate, applyPrimaryUpdate, checkPrimaryUpdate, confirmSpy };
}
