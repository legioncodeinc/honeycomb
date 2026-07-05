/**
 * Pollinating-loop config — PRD-009 Wave 1 (the single config module the trigger +
 * runner read, under `memory.pollinating`).
 *
 * Resolves the pollinating loop's enablement + token-budget knobs from the
 * environment, validated by zod, mirroring `pipeline/config.ts`: a raw-record
 * provider seam, one `safeParse` boundary, and coerce/clamp tuning knobs rather
 * than rejecting the whole config on a fat-fingered number. This is the ONE place
 * the pollinating flags live; the trigger + runner NEVER read `process.env` directly.
 *
 * ── The flags (D-2 / FR-3 / FR-7 / D-4) ─────────────────────────────────────
 * - `enabled`            master switch. When false the trigger STILL increments
 *                        the counter but enqueues NOTHING, so re-enabling resumes
 *                        from accumulated tokens (FR-7 / a-AC-4).
 * - `tokenThreshold`     tokens-since-last-pass that queues a pass (default 100000,
 *                        D-2 / FR-3). The reset SUBTRACTS this value (FR-5).
 * - `maxInputTokens`     the input budget a pass's payload must fit under (default
 *                        128000, D-2). Compaction (009c) SAMPLES summaries to this.
 * - `backfillOnFirstRun` when true and no prior pass exists, the first run enters
 *                        compaction (full graph) rather than incremental (D-4 /
 *                        c-AC-1). Default true.
 *
 * ── Why coerce-and-clamp, not hard-reject (mirrors pipeline/config.ts) ───────
 * `enabled` defaults false-safe (a missing flag is OFF — the pollinating loop is a
 * premium tier, so it does nothing unless explicitly enabled). The numeric knobs
 * are tuning: a non-numeric value falls back to its default and a value below the
 * floor is clamped, so a typo never takes the daemon down.
 */

import { z } from "zod";

/** Default tokens-since-last-pass that queues a pollinating pass (D-2 / FR-3). */
export const DEFAULT_TOKEN_THRESHOLD = 100_000;
/** Default input-token budget a pollinating pass's payload fits under (D-2). */
export const DEFAULT_MAX_INPUT_TOKENS = 128_000;

/** A boolean flag read from an env string: `true`/`1` → true, anything else → false. */
const BoolFlag = z.preprocess((raw) => {
	if (typeof raw === "boolean") return raw;
	// TRIM before comparing: env values routinely arrive with surrounding whitespace (a Windows
	// scheduled-task `set "VAR=true" && …` chain) — without it an exact `=== "true"` read `"true "` as
	// FALSE (the same trailing-space class as the APIARY_HOME bug). Duplicated helper; shared-helper follow-up.
	const s = typeof raw === "string" ? raw.trim() : raw;
	return s === "true" || s === "1";
}, z.boolean());

/**
 * A positive-integer tuning knob: a non-numeric value falls back to the default, a
 * value below `min` is clamped up to `min`. A fat-fingered threshold is tuning
 * noise, never a config failure (mirrors `pipeline/config.ts` `ClampedInt`).
 */
function ClampedInt(def: number, min = 1) {
	return z.preprocess((raw) => {
		const n = typeof raw === "number" ? raw : Number(raw);
		if (!Number.isFinite(n)) return def;
		return Math.max(min, Math.trunc(n));
	}, z.number().int());
}

/**
 * The validated pollinating config the trigger + runner read. Resolved once and
 * injected; a consumer takes the resolved {@link PollinatingConfig} as a dep and
 * never re-resolves it.
 */
export const PollinatingConfigSchema = z.object({
	/** Master switch; off → counter still grows but no job is queued (FR-7 / a-AC-4). */
	enabled: BoolFlag.default(false),
	/** Tokens-since-last-pass that queues a pass; reset SUBTRACTS this (FR-3 / FR-5). */
	tokenThreshold: ClampedInt(DEFAULT_TOKEN_THRESHOLD).default(DEFAULT_TOKEN_THRESHOLD),
	/** Input-token budget a pass's payload must fit under (D-2 / 009c). */
	maxInputTokens: ClampedInt(DEFAULT_MAX_INPUT_TOKENS).default(DEFAULT_MAX_INPUT_TOKENS),
	/** First run with no prior pass enters compaction, not incremental (D-4 / c-AC-1). */
	backfillOnFirstRun: BoolFlag.default(true),
});

/** The validated pollinating config every pollinating consumer reads. */
export type PollinatingConfig = z.infer<typeof PollinatingConfigSchema>;

/**
 * Structured pollinating-config error. Carries the flattened zod issues so the daemon
 * logs exactly which knob failed. Distinct type so a pollinating-config failure is
 * never mistaken for a runtime request failure (mirrors `PipelineConfigError`).
 */
export class PollinatingConfigError extends Error {
	readonly issues: string[];
	constructor(issues: string[]) {
		super(`Invalid memory.pollinating config: ${issues.join("; ")}`);
		this.name = "PollinatingConfigError";
		this.issues = issues;
	}
}

/**
 * The pollinating-config provider seam (mirrors `PipelineConfigProvider`). Returns the
 * raw, un-validated record so validation is the schema's job (one boundary, not
 * two). The env provider is the default; a test injects a fixed record.
 */
export interface PollinatingConfigProvider {
	/** Read the raw pollinating-config record. Missing keys yield undefined. */
	read(): RawPollinatingConfig;
}

/** The raw, un-validated shape the provider yields. */
export interface RawPollinatingConfig {
	readonly enabled?: unknown;
	readonly tokenThreshold?: unknown;
	readonly maxInputTokens?: unknown;
	readonly backfillOnFirstRun?: unknown;
}

/**
 * Default provider: reads `HONEYCOMB_POLLINATING_*` from the environment. Daemon-only
 * code (never bundled into the OpenClaw target, which forbids `process.env`), so a
 * direct env read is correct here — mirrors `envPipelineConfigProvider`. The flags
 * live under `memory.pollinating` in the config model; the env keys flatten that to
 * the `HONEYCOMB_POLLINATING_` prefix.
 */
export function envPollinatingConfigProvider(env: NodeJS.ProcessEnv = process.env): PollinatingConfigProvider {
	return {
		read(): RawPollinatingConfig {
			return {
				enabled: env.HONEYCOMB_POLLINATING_ENABLED,
				tokenThreshold: env.HONEYCOMB_POLLINATING_TOKEN_THRESHOLD,
				maxInputTokens: env.HONEYCOMB_POLLINATING_MAX_INPUT_TOKENS,
				backfillOnFirstRun: env.HONEYCOMB_POLLINATING_BACKFILL_ON_FIRST_RUN,
			};
		},
	};
}

/**
 * Resolve the raw record into a validated {@link PollinatingConfig}. The schema
 * defaults `enabled` false-safe and clamps every knob, so resolution succeeds for
 * nearly any input — but a structurally-impossible value still throws
 * {@link PollinatingConfigError} listing every issue. This is the single boundary
 * where untrusted env crosses into typed pollinating config (zod-at-boundary).
 */
export function resolvePollinatingConfig(provider: PollinatingConfigProvider = envPollinatingConfigProvider()): PollinatingConfig {
	const parsed = PollinatingConfigSchema.safeParse(provider.read());
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
		throw new PollinatingConfigError(issues);
	}
	return parsed.data;
}
