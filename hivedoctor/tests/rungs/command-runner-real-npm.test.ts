/**
 * REAL-npm smoke test through the PRODUCTION command runner (PRD-064c Windows fix).
 *
 * Every OTHER rung test injects a fake runner and never touches npm. This one is the deliberate
 * exception that the mock-only suite structurally could not catch: it drives the actual
 * {@link createExecFileRunner} (the production seam) against the actual npm on the host, so it
 * proves npm launches correctly on Windows, macOS, AND Linux in the multi-OS CI matrix.
 *
 * It is the test that WOULD HAVE caught the shipped bug: `execFile("npm", args)` with no shell
 * fails to spawn on Windows (npm is `npm.cmd`/`npm.ps1`). Because the old runner was only ever
 * exercised through the fake, that ENOENT never surfaced. Here `result.ok` must be true.
 *
 * Hermetic + fast: `npm --version` reads the npm version and touches nothing on disk - no install,
 * no network, no global state. The runner's own `timeoutMs` budgets the npm subprocess; the
 * per-test {@link TEST_TIMEOUT_MS} (passed as the third `it` arg) budgets the VITEST test and must
 * sit ABOVE it. The 5s vitest DEFAULT was too tight for a cold `npm ls -g` (global-module
 * enumeration) on a busy Windows runner and flaked the HiveDoctor gate; this absorbs that.
 */

import { describe, expect, it } from "vitest";

import { createExecFileRunner } from "../../src/rungs/command-runner.js";

const SEMVER = /^\d+\.\d+\.\d+/;

// npm subprocess budget (kills npm); the vitest test budget must exceed it so a real npm timeout
// surfaces as a clean assertion failure, not an opaque "Test timed out in 5000ms" from the runner.
const NPM_TIMEOUT_MS = 60_000;
const TEST_TIMEOUT_MS = 70_000;

describe("createExecFileRunner against real npm (multi-OS smoke)", () => {
	it(
		"runs `npm --version` and returns ok with a parseable semver",
		async () => {
			const runner = createExecFileRunner();
			const result = await runner.run("npm", ["--version"], { timeoutMs: NPM_TIMEOUT_MS });

			// The load-bearing assertion: npm actually launched (this was false on Windows before the fix).
			expect(result.ok).toBe(true);
			expect(result.code).toBe(0);
			// `npm --version` prints just the version; assert it parses as a semver.
			expect(result.stdout.trim()).toMatch(SEMVER);
		},
		TEST_TIMEOUT_MS,
	);

	it(
		"runs `npm ls -g <pkg> --depth=0 --json` and returns parseable JSON (the installed-version path)",
		async () => {
			// This is the exact argv the auto-update installed-version reader issues. `npm ls` exits
			// NON-ZERO when the queried package is absent, but STILL prints valid JSON, so we assert on the
			// JSON body, not on ok. The point is the spawn itself succeeds cross-platform (no ENOENT).
			const runner = createExecFileRunner();
			const result = await runner.run(
				"npm",
				["ls", "-g", "@legioncodeinc/this-package-does-not-exist", "--depth=0", "--json"],
				{ timeoutMs: NPM_TIMEOUT_MS },
			);

			// npm launched and produced output even though the package is absent (exit may be non-zero).
			expect(result.stdout.trim().length).toBeGreaterThan(0);
			// The body parses as JSON (npm ls --json always emits a JSON object), proving a real npm ran.
			const parsed: unknown = JSON.parse(result.stdout);
			expect(parsed).toBeTypeOf("object");
			// A genuine spawn failure (the pre-fix Windows bug) would have left stdout empty with an ENOENT
			// detail instead; assert we did NOT hit that.
			expect(result.detail).not.toBe("ENOENT");
		},
		TEST_TIMEOUT_MS,
	);
});
