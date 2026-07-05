/**
 * PRD-062c capture-domain config (L-X1) — the zod boundary for the always-on capture path.
 *
 * Proves the batch `BoolFlag` + the `HONEYCOMB_INBOX_CAPTURE` opt-in coerce/clamp rather than throwing,
 * and — the reason this suite exists — that a trailing-/surrounding-space env value (the Windows
 * scheduled-task `set "VAR=true" && …` quoting artifact, the same class as the APIARY_HOME bug) still
 * reads correctly rather than silently disabling the flag.
 *
 * No `.skip` / `.only`; `vitest run` is CI.
 */

import { describe, expect, it } from "vitest";

import {
	CAPTURE_ENV_KEYS,
	resolveCaptureConfig,
	resolveInboxCaptureEnabled,
} from "../../../../src/daemon/runtime/capture/capture-config.js";

describe("capture config: the batch BoolFlag (L-X1, DEFAULT-ON)", () => {
	it("defaults to batch ON when the env is absent", () => {
		expect(resolveCaptureConfig({}).batch).toBe(true);
	});

	it("`true` / `1` keep it ON; `false` / `0` flip it off", () => {
		expect(resolveCaptureConfig({ [CAPTURE_ENV_KEYS.batch]: "true" }).batch).toBe(true);
		expect(resolveCaptureConfig({ [CAPTURE_ENV_KEYS.batch]: "1" }).batch).toBe(true);
		expect(resolveCaptureConfig({ [CAPTURE_ENV_KEYS.batch]: "false" }).batch).toBe(false);
		expect(resolveCaptureConfig({ [CAPTURE_ENV_KEYS.batch]: "0" }).batch).toBe(false);
	});

	it("trims surrounding whitespace on the batch flag (the trailing-space env class)", () => {
		// A Windows scheduled-task `set "VAR=true" && …` chain leaks a trailing space; the trim keeps
		// `"true "` / `" true "` reading as ON and `"false "` / junk as OFF.
		expect(resolveCaptureConfig({ [CAPTURE_ENV_KEYS.batch]: "true " }).batch).toBe(true);
		expect(resolveCaptureConfig({ [CAPTURE_ENV_KEYS.batch]: " true " }).batch).toBe(true);
		expect(resolveCaptureConfig({ [CAPTURE_ENV_KEYS.batch]: "false " }).batch).toBe(false);
		expect(resolveCaptureConfig({ [CAPTURE_ENV_KEYS.batch]: " nope " }).batch).toBe(false);
	});
});

describe("capture config: the HONEYCOMB_INBOX_CAPTURE opt-in (PRD-073a, DEFAULT-OFF)", () => {
	it("defaults OFF when the env is absent", () => {
		expect(resolveInboxCaptureEnabled({})).toBe(false);
	});

	it("trims surrounding whitespace on the inbox flag (the trailing-space env class)", () => {
		expect(resolveInboxCaptureEnabled({ [CAPTURE_ENV_KEYS.inboxCapture]: "true " })).toBe(true);
		expect(resolveInboxCaptureEnabled({ [CAPTURE_ENV_KEYS.inboxCapture]: " true " })).toBe(true);
		expect(resolveInboxCaptureEnabled({ [CAPTURE_ENV_KEYS.inboxCapture]: "false " })).toBe(false);
		expect(resolveInboxCaptureEnabled({ [CAPTURE_ENV_KEYS.inboxCapture]: " nope " })).toBe(false);
	});
});
