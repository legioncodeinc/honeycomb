/**
 * Amplification-control config — PRD-062d (L-X1 / AC-62d.9 / parent AC-9).
 *
 * The single config module for the two PRD-062d amplification knobs, mirroring the
 * `pipeline/config.ts` + `recall/config.ts` pattern exactly: a provider seam, ONE
 * zod `safeParse` boundary, coerce/clamp rather than reject. It spans both the
 * pipeline fan-out side (`fan-out.ts` / `controlled-writes.ts`) and the recall side
 * (`recall.ts` / `usefulness-grader.ts`), so it lives in the memories domain that
 * both reach into — a fan-out/recall module NEVER reads `process.env` directly.
 *
 * ── The two knobs (both default to the LIVE posture — parent AC-9) ───────────
 *  - `fanoutBatch`        `HONEYCOMB_FANOUT_BATCH` — DEFAULT ON. When on, a multi-fact
 *                         decision enqueues ONE batched `memory_controlled_write` job
 *                         carrying all proposals (sub-linear in M, AC-62d.1.1) instead
 *                         of M independent enqueues. OFF ⇒ the exact pre-PRD per-proposal
 *                         enqueue loop (the AC-9 parity escape hatch).
 *  - `recallMaxConcurrency` `HONEYCOMB_RECALL_MAX_CONCURRENCY` — DEFAULT 6. The ceiling
 *                         on in-flight DeepLake queries across the recall arms + the
 *                         usefulness-grader batch (AC-62d.2.1). A non-positive value is
 *                         clamped UP to 1 (a pool must admit at least one task); a typo
 *                         never deadlocks the pool, it just runs near-serial.
 *
 * ── Why DEFAULT-ON (not the usual false-safe pipeline default) ───────────────
 * PRD-062 is a P0 cost incident: the fix must ship live, so both knobs default to the
 * REDUCING posture and the flag is the OFF-switch (parent AC-9: "Off ⇒ exact pre-PRD
 * behavior"). This inverts the pipeline-config false-safe convention deliberately —
 * the safe posture for a cost incident is "cut by default, opt out to revert".
 *
 * ── Why coerce-and-clamp, not hard-reject (mirrors the sibling config modules) ─
 * The boolean defaults true (the live posture); the concurrency knob is tuning, so a
 * non-numeric value falls back to the default and a sub-1 value is clamped up — a typo
 * never takes the daemon down, it just runs with the documented default.
 */

import { z } from "zod";

import { OnByDefaultFlag } from "../../../shared/bool-flag.js";

/** The default for `HONEYCOMB_FANOUT_BATCH` — ON (the live cost-reducing posture, parent AC-9). */
export const DEFAULT_FANOUT_BATCH = true;
/** The default in-flight DeepLake-query ceiling for recall + grading (AC-62d.2.1). */
export const DEFAULT_RECALL_MAX_CONCURRENCY = 6;
/** The floor for the concurrency knob: a pool must admit at least one task (no deadlock). */
export const MIN_RECALL_MAX_CONCURRENCY = 1;

/**
 * The concurrency knob: a positive integer, clamped UP to {@link MIN_RECALL_MAX_CONCURRENCY}.
 * A non-numeric value falls back to the default; a sub-1 value is clamped (a `0` would
 * deadlock the pool, so it becomes 1, the near-serial posture) — a typo is tuning noise.
 */
const ConcurrencyKnob = z.preprocess((raw) => {
	const n = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(n)) return DEFAULT_RECALL_MAX_CONCURRENCY;
	return Math.max(MIN_RECALL_MAX_CONCURRENCY, Math.trunc(n));
}, z.number().int());

/**
 * The validated amplification config the fan-out + recall sides read. Resolved once
 * and consumed; a module takes the resolved object (or reads it via the cached
 * default resolver), never re-resolves it per call.
 */
export const AmplificationConfigSchema = z.object({
	/** `HONEYCOMB_FANOUT_BATCH` — batched fan-out enqueue; ON by default (AC-62d.1.1 / AC-9). */
	fanoutBatch: OnByDefaultFlag.default(DEFAULT_FANOUT_BATCH),
	/** `HONEYCOMB_RECALL_MAX_CONCURRENCY` — in-flight DeepLake-query ceiling; 6 by default (AC-62d.2.1). */
	recallMaxConcurrency: ConcurrencyKnob.default(DEFAULT_RECALL_MAX_CONCURRENCY),
});

/** The validated amplification config object the fan-out + recall sides consume. */
export type AmplificationConfig = z.infer<typeof AmplificationConfigSchema>;

/**
 * Structured amplification-config error. Carries the flattened zod issues so the
 * daemon logs exactly which knob failed (mirrors `PipelineConfigError` /
 * `RecallConfigError`). A distinct type so this never reads as a runtime failure.
 */
export class AmplificationConfigError extends Error {
	readonly issues: string[];
	constructor(issues: string[]) {
		super(`Invalid amplification config: ${issues.join("; ")}`);
		this.name = "AmplificationConfigError";
		this.issues = issues;
	}
}

/** The amplification-config provider seam (mirrors the sibling config modules). */
export interface AmplificationConfigProvider {
	/** Read the raw amplification-config record. Missing keys yield undefined. */
	read(): RawAmplificationConfig;
}

/** The raw, un-validated shape the provider yields. */
export interface RawAmplificationConfig {
	readonly fanoutBatch?: unknown;
	readonly recallMaxConcurrency?: unknown;
}

/**
 * Default provider: reads `HONEYCOMB_FANOUT_BATCH` + `HONEYCOMB_RECALL_MAX_CONCURRENCY`
 * from the environment. Daemon-only code (never bundled into the OpenClaw target, which
 * forbids `process.env`), so a direct env read is correct here — mirrors the sibling
 * `env*ConfigProvider`s.
 */
export function envAmplificationConfigProvider(env: NodeJS.ProcessEnv = process.env): AmplificationConfigProvider {
	return {
		read(): RawAmplificationConfig {
			return {
				fanoutBatch: env.HONEYCOMB_FANOUT_BATCH,
				recallMaxConcurrency: env.HONEYCOMB_RECALL_MAX_CONCURRENCY,
			};
		},
	};
}

/**
 * Resolve the raw record into a validated {@link AmplificationConfig}. The schema
 * defaults both knobs to the live posture and clamps the concurrency, so resolution
 * succeeds for nearly any input — a structurally-impossible value still throws
 * {@link AmplificationConfigError} listing every issue. The single boundary where
 * untrusted env crosses into typed amplification config (zod-at-boundary discipline).
 */
export function resolveAmplificationConfig(
	provider: AmplificationConfigProvider = envAmplificationConfigProvider(),
): AmplificationConfig {
	const parsed = AmplificationConfigSchema.safeParse(provider.read());
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
		throw new AmplificationConfigError(issues);
	}
	return parsed.data;
}

/**
 * The process-wide resolved amplification config, computed ONCE on first read and
 * cached. The fan-out + recall modules read their knobs through this so the env is
 * parsed a single time per daemon (a recall on the hot path never re-runs `safeParse`).
 * A test that needs a specific posture passes an explicit config to the consumer
 * instead of relying on this cache (the consumers all take an optional override).
 */
let cached: AmplificationConfig | undefined;

/** Read the cached process-wide amplification config (resolving + caching on first call). */
export function amplificationConfig(): AmplificationConfig {
	if (cached === undefined) cached = resolveAmplificationConfig();
	return cached;
}

/** Reset the cached config (test-only seam, so a test can re-read env after mutating it). */
export function resetAmplificationConfigCache(): void {
	cached = undefined;
}
