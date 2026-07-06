import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { installProcessSafetyNet, isDaemonMainEntry } from "../../src/daemon/index.js";

describe("daemon package entry main guard", () => {
	it("auto-runs only when argv[1] is the daemon entry itself", () => {
		const daemonEntry = join(process.cwd(), "daemon", "index.js");
		const scriptEntry = join(process.cwd(), "scripts", "local-queue-packaged-live-proof.mjs");

		expect(isDaemonMainEntry(pathToFileURL(daemonEntry).href, daemonEntry)).toBe(true);
		expect(isDaemonMainEntry(pathToFileURL(daemonEntry).href, scriptEntry)).toBe(false);
	});

	it("does not treat every bundled daemon/index.js import as a main execution", () => {
		expect(isDaemonMainEntry("file:///tmp/package/daemon/index.js", "/tmp/package/scripts/smoke.mjs")).toBe(false);
	});
});

/**
 * The top-level process safety net (fail-soft). The daemon is a long-lived HTTP server: a stray
 * background rejection must degrade to a logged error and KEEP the process alive; a stray uncaught
 * synchronous throw is a corrupt-state signal that must exit NON-ZERO so the OS supervisor restarts
 * the daemon (a zero exit would leave the scheduled task Ready + never restart). This proves both
 * arms of that contract, with the listeners removed after each test so the net does not leak across
 * suites (Vitest shares the worker process).
 */
describe("installProcessSafetyNet — fail-soft rejection, non-zero exit on uncaught throw", () => {
	const rejListeners = () => process.listeners("unhandledRejection");
	const excListeners = () => process.listeners("uncaughtException");
	let priorRej: ReturnType<typeof rejListeners>;
	let priorExc: ReturnType<typeof excListeners>;
	let priorExitCode: typeof process.exitCode;

	beforeEach(() => {
		priorRej = rejListeners();
		priorExc = excListeners();
		priorExitCode = process.exitCode;
	});

	afterEach(() => {
		// Remove ONLY the listeners this test installed, restore exitCode, and let real timers run.
		for (const l of rejListeners()) if (!priorRej.includes(l)) process.off("unhandledRejection", l);
		for (const l of excListeners()) if (!priorExc.includes(l)) process.off("uncaughtException", l);
		process.exitCode = priorExitCode;
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	it("an unhandledRejection is LOGGED and the process is KEPT alive (exitCode untouched)", () => {
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		process.exitCode = 0;
		installProcessSafetyNet();

		// Invoke the handler directly (deterministic — no need to actually orphan a rejection).
		const handler = rejListeners().at(-1) as (reason: unknown) => void;
		handler(new Error("deeplake batch insert timed out"));

		expect(stderr).toHaveBeenCalledWith(expect.stringContaining("unhandledRejection (kept alive)"));
		expect(process.exitCode, "a background rejection must NOT end the daemon").toBe(0);
	});

	it("an uncaughtException is LOGGED and sets a NON-ZERO exit code (supervisor restarts us)", () => {
		const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
		const exit = vi.spyOn(process, "exit").mockImplementation(((): never => undefined as never));
		vi.useFakeTimers();
		process.exitCode = 0;
		installProcessSafetyNet();

		const handler = excListeners().at(-1) as (err: unknown) => void;
		handler(new Error("corrupt daemon state"));

		expect(stderr).toHaveBeenCalledWith(expect.stringContaining("uncaughtException (restarting)"));
		expect(process.exitCode, "a fatal throw exits NON-ZERO so RestartOnFailure fires").toBe(1);

		// The deferred hard-exit is scheduled (100ms, unref'd) and forces a non-zero process.exit(1).
		vi.advanceTimersByTime(100);
		expect(exit).toHaveBeenCalledWith(1);
	});
});
