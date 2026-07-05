/**
 * Memory-pipeline config — PRD-006 Wave 1 (the single config module every stage reads).
 *
 * Resolves the pipeline's feature flags and tuning knobs from the environment,
 * validated by zod, mirroring the storage `config.ts` / runtime `config.ts`
 * pattern: a credentials/raw-record provider seam, one fail-closed-ish `safeParse`
 * boundary, coerce/clamp tuning knobs rather than rejecting the whole config on a
 * fat-fingered number. This is the ONE place the pipeline's flags live; a stage
 * NEVER reads `process.env` directly (D-1..D-8, the ledger's "one pipeline-config
 * module").
 *
 * ── The flags (ledger "Pipeline config flags") ──────────────────────────────
 * - `enabled`                  master switch; off → no stage runs (a-AC-5 / FR-9).
 * - `extractionProvider`       router-selection token for the extraction model.
 *                              The literal `'none'` DISABLES extraction even when
 *                              `enabled` is true (a-AC-5 / FR-9). Any other value
 *                              is an opaque provider/router selector the stage
 *                              passes to the ModelClient — the stage holds NO
 *                              provider knowledge (006a FR-3).
 * - `shadowMode`               proposals logged, NO memory written (006c c-AC-4).
 * - `mutationsFrozen`          nothing written even if shadow is off; frozen
 *                              SUPERSEDES shadow (006c c-AC-5).
 * - `minFactConfidenceForWrite` the ADD gate (default 0.7, D-1 / 006c c-AC-1).
 * - `autonomous.{enabled,frozen,allowUpdateDelete}` retention + UPDATE/DELETE
 *                              brakes (006c c-AC-3 / 006e e-AC-4 / e-AC-5 / D-7).
 * - `graph.{enabled,extractionWritesEnabled}` graph-persistence gates (006d d-AC-4).
 * - retention windows + batch  per-run batch cap + decay windows (D-5 / 006e).
 *
 * ── Why coerce-and-clamp, not hard-reject (mirrors storage/config.ts) ────────
 * The booleans default false-safe (a missing flag is OFF — the conservative
 * posture: the pipeline does nothing rather than something unexpected). The
 * numeric knobs (caps, windows, confidence) are tuning, so a non-numeric value
 * falls back to its default and an out-of-range value is clamped — a typo never
 * takes the daemon down, it just runs with the documented default.
 */

import { z } from "zod";

// ── D-1 extraction caps + write threshold ──────────────────────────────────────
/** Input cap before the extraction model call (D-1 / a-AC-2 / FR-6). */
export const DEFAULT_INPUT_CHAR_CAP = 12_000;
/** Max facts kept from one extraction (D-1 / a-AC-3 / FR-7). */
export const DEFAULT_MAX_FACTS = 20;
/** Max entity triples kept from one extraction (D-1 / a-AC-3 / FR-7). */
export const DEFAULT_MAX_ENTITIES = 50;
/** Per-fact content length cap (D-1 / a-AC-3 / FR-7). */
export const DEFAULT_MAX_FACT_CHARS = 500;
/** ADD confidence gate (D-1 / 006c c-AC-1). */
export const DEFAULT_MIN_FACT_CONFIDENCE = 0.7;

// ── D-5 retention windows (ms) + batch ─────────────────────────────────────────
/** Per-run retention batch row limit (D-5 / 006e e-AC-1 / e-AC-6). */
export const DEFAULT_RETENTION_BATCH_LIMIT = 500;
/** Completed-jobs retention window (7d, D-5). */
export const DEFAULT_COMPLETED_JOB_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
/** Dead-jobs retention window (30d, D-5). */
export const DEFAULT_DEAD_JOB_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
/** History retention window (90d, D-5). */
export const DEFAULT_HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1_000;
/** Tombstone (soft-deleted memory) retention window (30d, D-5). */
export const DEFAULT_TOMBSTONE_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;

/** The disabling sentinel for `extractionProvider` (a-AC-5 / FR-9). */
export const EXTRACTION_PROVIDER_NONE = "none" as const;

/** A boolean flag read from an env string: `true`/`1` → true, anything else → false. */
const BoolFlag = z.preprocess((raw) => {
	if (typeof raw === "boolean") return raw;
	// TRIM before comparing: env values routinely arrive with surrounding whitespace (a Windows
	// scheduled-task `set "VAR=true" && …` chain, a shell heredoc, a copy-paste). Without the trim an
	// exact `=== "true"` silently read `"true "` as FALSE — which disabled the ENTIRE memory pipeline
	// on a real install while `/health` looked fine (the same trailing-space class as the APIARY_HOME bug).
	const s = typeof raw === "string" ? raw.trim() : raw;
	return s === "true" || s === "1";
}, z.boolean());

/**
 * A positive-integer tuning knob: a non-numeric value falls back to the default,
 * a value below `min` is clamped up to `min`. Used for caps/windows/limits — a
 * typo is tuning noise, never a config failure.
 */
function ClampedInt(def: number, min = 1) {
	return z.preprocess((raw) => {
		const n = typeof raw === "number" ? raw : Number(raw);
		if (!Number.isFinite(n)) return def;
		return Math.max(min, Math.trunc(n));
	}, z.number().int());
}

/**
 * The confidence knob: clamped into `[0, 1]`. A non-numeric value falls back to
 * the default; an out-of-range value is clamped (a 1.5 means "always-on gate" is
 * a bug, so clamp it to the legal ceiling rather than disabling the gate).
 */
const Confidence = z.preprocess((raw) => {
	const n = typeof raw === "number" ? raw : Number(raw);
	if (!Number.isFinite(n)) return DEFAULT_MIN_FACT_CONFIDENCE;
	return Math.min(Math.max(0, n), 1);
}, z.number());

/** Autonomous-mode brakes (retention + UPDATE/DELETE), all false-safe. */
export const AutonomousConfigSchema = z.object({
	/** Master switch for retention/autonomous mutation; off → retention does not run (006e e-AC-4). */
	enabled: BoolFlag.default(false),
	/** Halt switch: set → no further purges even when enabled (006e e-AC-5). */
	frozen: BoolFlag.default(false),
	/** Gate for UPDATE/DELETE proposals being applied (006c c-AC-3 / D-7). */
	allowUpdateDelete: BoolFlag.default(false),
});

/** Graph-persistence gates (006d d-AC-4), both false-safe. */
export const GraphConfigSchema = z.object({
	/** Master graph switch; off → no graph rows written (006d d-AC-4). */
	enabled: BoolFlag.default(false),
	/** Whether extraction-derived triples are persisted to the graph (006d d-AC-4). */
	extractionWritesEnabled: BoolFlag.default(false),
});

/** Extraction caps (D-1), grouped so the extraction stage reads one object. */
export const ExtractionConfigSchema = z.object({
	/** Input char cap before the model call (a-AC-2 / FR-6). */
	inputCharCap: ClampedInt(DEFAULT_INPUT_CHAR_CAP).default(DEFAULT_INPUT_CHAR_CAP),
	/** Max facts kept (a-AC-3 / FR-7). */
	maxFacts: ClampedInt(DEFAULT_MAX_FACTS).default(DEFAULT_MAX_FACTS),
	/** Max entity triples kept (a-AC-3 / FR-7). */
	maxEntities: ClampedInt(DEFAULT_MAX_ENTITIES).default(DEFAULT_MAX_ENTITIES),
	/** Per-fact content length cap (a-AC-3 / FR-7). */
	maxFactChars: ClampedInt(DEFAULT_MAX_FACT_CHARS).default(DEFAULT_MAX_FACT_CHARS),
});

/** Retention windows + batch cap (D-5), grouped so the retention stage reads one object. */
export const RetentionConfigSchema = z.object({
	/** Per-run row batch cap (e-AC-1 / e-AC-6). */
	batchLimit: ClampedInt(DEFAULT_RETENTION_BATCH_LIMIT).default(DEFAULT_RETENTION_BATCH_LIMIT),
	/** Completed-jobs window in ms. */
	completedJobMs: ClampedInt(DEFAULT_COMPLETED_JOB_RETENTION_MS).default(DEFAULT_COMPLETED_JOB_RETENTION_MS),
	/** Dead-jobs window in ms. */
	deadJobMs: ClampedInt(DEFAULT_DEAD_JOB_RETENTION_MS).default(DEFAULT_DEAD_JOB_RETENTION_MS),
	/** History window in ms. */
	historyMs: ClampedInt(DEFAULT_HISTORY_RETENTION_MS).default(DEFAULT_HISTORY_RETENTION_MS),
	/** Tombstone window in ms. */
	tombstoneMs: ClampedInt(DEFAULT_TOMBSTONE_RETENTION_MS).default(DEFAULT_TOMBSTONE_RETENTION_MS),
});

/**
 * The validated pipeline config every stage reads. Resolved once and injected;
 * a stage takes the resolved `PipelineConfig` as a dep, never re-resolves it.
 */
export const PipelineConfigSchema = z.object({
	/** Master switch; off → no stage runs (a-AC-5 / FR-9). */
	enabled: BoolFlag.default(false),
	/** Router-selection token; `'none'` disables extraction (a-AC-5 / FR-9). */
	extractionProvider: z.string().trim().min(1).default(EXTRACTION_PROVIDER_NONE),
	/** Shadow mode: proposals logged, no memory written (006c c-AC-4). */
	shadowMode: BoolFlag.default(false),
	/** Frozen: nothing written even if shadow off; supersedes shadow (006c c-AC-5). */
	mutationsFrozen: BoolFlag.default(false),
	/** ADD confidence gate (D-1 / 006c c-AC-1). */
	minFactConfidenceForWrite: Confidence.default(DEFAULT_MIN_FACT_CONFIDENCE),
	/** Autonomous brakes (retention + UPDATE/DELETE). */
	autonomous: AutonomousConfigSchema.default(() => AutonomousConfigSchema.parse({})),
	/** Graph-persistence gates. */
	graph: GraphConfigSchema.default(() => GraphConfigSchema.parse({})),
	/** Extraction caps (D-1). */
	extraction: ExtractionConfigSchema.default(() => ExtractionConfigSchema.parse({})),
	/** Retention windows + batch (D-5). */
	retention: RetentionConfigSchema.default(() => RetentionConfigSchema.parse({})),
});

/** The validated pipeline config object every stage consumes. */
export type PipelineConfig = z.infer<typeof PipelineConfigSchema>;
/** The validated autonomous sub-config. */
export type AutonomousConfig = z.infer<typeof AutonomousConfigSchema>;
/** The validated graph sub-config. */
export type GraphConfig = z.infer<typeof GraphConfigSchema>;
/** The validated extraction sub-config. */
export type ExtractionConfig = z.infer<typeof ExtractionConfigSchema>;
/** The validated retention sub-config. */
export type RetentionConfig = z.infer<typeof RetentionConfigSchema>;

/**
 * Structured pipeline-config error. Carries the flattened zod issues so the
 * daemon logs exactly which knob failed. Distinct type so a pipeline-config
 * failure is never mistaken for a runtime request failure (mirrors
 * `StorageConfigError` / `RuntimeConfigError`).
 */
export class PipelineConfigError extends Error {
	readonly issues: string[];
	constructor(issues: string[]) {
		super(`Invalid memory-pipeline config: ${issues.join("; ")}`);
		this.name = "PipelineConfigError";
		this.issues = issues;
	}
}

/**
 * The pipeline-config provider seam (mirrors `CredentialProvider` /
 * `RuntimeConfigProvider`). Returns the raw, un-validated record so validation
 * is the schema's job (one boundary, not two). The env provider is the default;
 * a test injects a fixed record.
 */
export interface PipelineConfigProvider {
	/** Read the raw pipeline-config record. Missing keys yield undefined. */
	read(): RawPipelineConfig;
}

/** The raw, un-validated shape the provider yields. */
export interface RawPipelineConfig {
	readonly enabled?: unknown;
	readonly extractionProvider?: unknown;
	readonly shadowMode?: unknown;
	readonly mutationsFrozen?: unknown;
	readonly minFactConfidenceForWrite?: unknown;
	readonly autonomous?: {
		readonly enabled?: unknown;
		readonly frozen?: unknown;
		readonly allowUpdateDelete?: unknown;
	};
	readonly graph?: {
		readonly enabled?: unknown;
		readonly extractionWritesEnabled?: unknown;
	};
	readonly extraction?: {
		readonly inputCharCap?: unknown;
		readonly maxFacts?: unknown;
		readonly maxEntities?: unknown;
		readonly maxFactChars?: unknown;
	};
	readonly retention?: {
		readonly batchLimit?: unknown;
		readonly completedJobMs?: unknown;
		readonly deadJobMs?: unknown;
		readonly historyMs?: unknown;
		readonly tombstoneMs?: unknown;
	};
}

/**
 * Default provider: reads `HONEYCOMB_PIPELINE_*` from the environment. Daemon-only
 * code (never bundled into the OpenClaw target, which forbids `process.env`), so a
 * direct env read is correct here — mirrors `envCredentialProvider`.
 *
 * The flag names map to env keys with the `HONEYCOMB_PIPELINE_` prefix and the
 * nested groups flattened (`HONEYCOMB_PIPELINE_AUTONOMOUS_ENABLED`, etc.).
 */
export function envPipelineConfigProvider(env: NodeJS.ProcessEnv = process.env): PipelineConfigProvider {
	return {
		read(): RawPipelineConfig {
			return {
				enabled: env.HONEYCOMB_PIPELINE_ENABLED,
				extractionProvider: env.HONEYCOMB_PIPELINE_EXTRACTION_PROVIDER,
				shadowMode: env.HONEYCOMB_PIPELINE_SHADOW_MODE,
				mutationsFrozen: env.HONEYCOMB_PIPELINE_MUTATIONS_FROZEN,
				minFactConfidenceForWrite: env.HONEYCOMB_PIPELINE_MIN_FACT_CONFIDENCE,
				autonomous: {
					enabled: env.HONEYCOMB_PIPELINE_AUTONOMOUS_ENABLED,
					frozen: env.HONEYCOMB_PIPELINE_AUTONOMOUS_FROZEN,
					allowUpdateDelete: env.HONEYCOMB_PIPELINE_AUTONOMOUS_ALLOW_UPDATE_DELETE,
				},
				graph: {
					enabled: env.HONEYCOMB_PIPELINE_GRAPH_ENABLED,
					extractionWritesEnabled: env.HONEYCOMB_PIPELINE_GRAPH_EXTRACTION_WRITES,
				},
				extraction: {
					inputCharCap: env.HONEYCOMB_PIPELINE_INPUT_CHAR_CAP,
					maxFacts: env.HONEYCOMB_PIPELINE_MAX_FACTS,
					maxEntities: env.HONEYCOMB_PIPELINE_MAX_ENTITIES,
					maxFactChars: env.HONEYCOMB_PIPELINE_MAX_FACT_CHARS,
				},
				retention: {
					batchLimit: env.HONEYCOMB_PIPELINE_RETENTION_BATCH_LIMIT,
					completedJobMs: env.HONEYCOMB_PIPELINE_RETENTION_COMPLETED_JOB_MS,
					deadJobMs: env.HONEYCOMB_PIPELINE_RETENTION_DEAD_JOB_MS,
					historyMs: env.HONEYCOMB_PIPELINE_RETENTION_HISTORY_MS,
					tombstoneMs: env.HONEYCOMB_PIPELINE_RETENTION_TOMBSTONE_MS,
				},
			};
		},
	};
}

/**
 * Resolve the raw record into a validated `PipelineConfig`. The schema defaults
 * every flag false-safe and clamps every knob, so resolution succeeds for nearly
 * any input — but a structurally-impossible value (e.g. an empty
 * `extractionProvider` string passed explicitly) still throws `PipelineConfigError`
 * listing every issue. This is the single boundary where untrusted env crosses
 * into typed pipeline config (zod-at-boundary discipline).
 */
export function resolvePipelineConfig(
	provider: PipelineConfigProvider = envPipelineConfigProvider(),
): PipelineConfig {
	const parsed = PipelineConfigSchema.safeParse(provider.read());
	if (!parsed.success) {
		const issues = parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
		throw new PipelineConfigError(issues);
	}
	return parsed.data;
}

/**
 * Is extraction live for this config? True only when the pipeline is `enabled`
 * AND the extraction provider is not the disabling `'none'` sentinel (a-AC-5 /
 * FR-9). The extraction stage calls this as its single gate.
 */
export function isExtractionEnabled(config: PipelineConfig): boolean {
	return config.enabled && config.extractionProvider !== EXTRACTION_PROVIDER_NONE;
}
