/**
 * PRD-062d (L-X1 / AC-62d.9 / parent AC-9) — the amplification-control config.
 *
 * Verifies the two knobs default to the LIVE posture (fan-out batch ON, recall
 * concurrency 6), that the OFF tokens flip the batch flag off (the parity escape
 * hatch), and that the concurrency knob coerces/clamps rather than rejecting.
 *
 * No `.skip` / `.only`; `vitest run` is CI.
 */

import { describe, expect, it } from "vitest";

import {
	DEFAULT_FANOUT_BATCH,
	DEFAULT_RECALL_MAX_CONCURRENCY,
	DEFAULT_WRITE_MAX_CONCURRENCY,
	MIN_RECALL_MAX_CONCURRENCY,
	MIN_WRITE_MAX_CONCURRENCY,
	resolveAmplificationConfig,
	type AmplificationConfigProvider,
	type RawAmplificationConfig,
} from "../../../../src/daemon/runtime/memories/amplification-config.js";

/** A fixed provider yielding the supplied raw record (mirrors the sibling config tests). */
function provider(raw: RawAmplificationConfig): AmplificationConfigProvider {
	return { read: () => raw };
}

describe("amplification config: defaults to the live cost-reducing posture", () => {
	it("an empty record yields batch ON + concurrency 6 (parent AC-9 live default)", () => {
		const cfg = resolveAmplificationConfig(provider({}));
		expect(cfg.fanoutBatch).toBe(DEFAULT_FANOUT_BATCH);
		expect(cfg.fanoutBatch).toBe(true);
		expect(cfg.recallMaxConcurrency).toBe(DEFAULT_RECALL_MAX_CONCURRENCY);
		expect(cfg.recallMaxConcurrency).toBe(6);
	});

	it("an unset (undefined) batch flag stays ON (only explicit off tokens disable it)", () => {
		expect(resolveAmplificationConfig(provider({ fanoutBatch: undefined })).fanoutBatch).toBe(true);
		expect(resolveAmplificationConfig(provider({ fanoutBatch: "" })).fanoutBatch).toBe(true);
	});
});

describe("amplification config: the batch flag OFF tokens (the parity escape hatch)", () => {
	it("`false` / `0` flip the batch flag off; any other value stays ON", () => {
		expect(resolveAmplificationConfig(provider({ fanoutBatch: "false" })).fanoutBatch).toBe(false);
		expect(resolveAmplificationConfig(provider({ fanoutBatch: "0" })).fanoutBatch).toBe(false);
		expect(resolveAmplificationConfig(provider({ fanoutBatch: false })).fanoutBatch).toBe(false);
		expect(resolveAmplificationConfig(provider({ fanoutBatch: "true" })).fanoutBatch).toBe(true);
		expect(resolveAmplificationConfig(provider({ fanoutBatch: "yes" })).fanoutBatch).toBe(true);
	});

	it("trims surrounding whitespace on the OFF tokens (the trailing-space env class)", () => {
		// A Windows scheduled-task `set "VAR=false" && …` chain leaks a trailing space; without the trim
		// `"false "` slipped past the off-token check and stayed ON. Here the OFF tokens must still flip
		// off, and `"true "` / junk stays ON (this flag is default-ON — the inverse of the false-safe ones).
		expect(resolveAmplificationConfig(provider({ fanoutBatch: "false " })).fanoutBatch).toBe(false);
		expect(resolveAmplificationConfig(provider({ fanoutBatch: " false " })).fanoutBatch).toBe(false);
		expect(resolveAmplificationConfig(provider({ fanoutBatch: "0 " })).fanoutBatch).toBe(false);
		expect(resolveAmplificationConfig(provider({ fanoutBatch: "true " })).fanoutBatch).toBe(true);
		expect(resolveAmplificationConfig(provider({ fanoutBatch: " nope " })).fanoutBatch).toBe(true);
	});
});

describe("amplification config: the concurrency knob coerces + clamps", () => {
	it("parses a numeric string and honors an explicit width", () => {
		expect(resolveAmplificationConfig(provider({ recallMaxConcurrency: "10" })).recallMaxConcurrency).toBe(10);
		expect(resolveAmplificationConfig(provider({ recallMaxConcurrency: 3 })).recallMaxConcurrency).toBe(3);
	});

	it("clamps a sub-1 / non-numeric value rather than deadlocking the pool", () => {
		expect(resolveAmplificationConfig(provider({ recallMaxConcurrency: "0" })).recallMaxConcurrency).toBe(
			MIN_RECALL_MAX_CONCURRENCY,
		);
		expect(resolveAmplificationConfig(provider({ recallMaxConcurrency: -4 })).recallMaxConcurrency).toBe(
			MIN_RECALL_MAX_CONCURRENCY,
		);
		// A non-numeric value falls back to the documented default (not a config failure).
		expect(resolveAmplificationConfig(provider({ recallMaxConcurrency: "abc" })).recallMaxConcurrency).toBe(
			DEFAULT_RECALL_MAX_CONCURRENCY,
		);
	});
});

describe("PRD-077 read/write split: the write-concurrency knob (writeMaxConcurrency)", () => {
	it("defaults to 3 (the dedicated write-client ceiling) when unset", () => {
		expect(resolveAmplificationConfig(provider({})).writeMaxConcurrency).toBe(DEFAULT_WRITE_MAX_CONCURRENCY);
		expect(resolveAmplificationConfig(provider({})).writeMaxConcurrency).toBe(3);
	});

	it("honors an explicit override (numeric string or number)", () => {
		expect(resolveAmplificationConfig(provider({ writeMaxConcurrency: "2" })).writeMaxConcurrency).toBe(2);
		expect(resolveAmplificationConfig(provider({ writeMaxConcurrency: 4 })).writeMaxConcurrency).toBe(4);
	});

	it("clamps a sub-1 value to the floor (>=1) and falls back on a non-numeric value", () => {
		expect(resolveAmplificationConfig(provider({ writeMaxConcurrency: "0" })).writeMaxConcurrency).toBe(
			MIN_WRITE_MAX_CONCURRENCY,
		);
		expect(resolveAmplificationConfig(provider({ writeMaxConcurrency: -9 })).writeMaxConcurrency).toBe(
			MIN_WRITE_MAX_CONCURRENCY,
		);
		expect(resolveAmplificationConfig(provider({ writeMaxConcurrency: "xyz" })).writeMaxConcurrency).toBe(
			DEFAULT_WRITE_MAX_CONCURRENCY,
		);
	});
});
