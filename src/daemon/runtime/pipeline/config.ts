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
 *                              DEFAULTS to the `'auto'` sentinel (PRD: memory as a
 *                              discoverable feature): when unset, extraction is
 *                              DERIVED from whether a real inference ModelClient is
 *                              configured — the user never sets a SECOND provider
 *                              token for the pipeline. The literal `'none'` still
 *                              DISABLES extraction even when `enabled` is true
 *                              (a-AC-5 / FR-9, the deliberate opt-out). Any OTHER
 *                              explicit value is an opaque provider/router selector
 *                              (an override/escape hatch) the stage passes to the
 *                              ModelClient — the stage holds NO provider knowledge
 *                              (006a FR-3). Absence no longer means "disabled".
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

import { BoolFlag } from "../../../shared/bool-flag.js";

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

/** The disabling sentinel for `extractionProvider` (a-AC-5 / FR-9). Explicit opt-out. */
export const EXTRACTION_PROVIDER_NONE = "none" as const;

/**
 * The DEFAULT sentinel for `extractionProvider` — "derive extraction enablement from whether a
 * real inference provider is configured". This is what the flag resolves to when
 * `HONEYCOMB_PIPELINE_EXTRACTION_PROVIDER` is UNSET (the common case for a normal install). Under
 * `'auto'`, extraction runs iff the pipeline is `enabled` AND the assembled ModelClient is a REAL
 * (non-noop) client — so the user configures their model provider ONCE (Portkey key / `agent.yaml`
 * inference block / provider env) and never a second pipeline-specific token. `'none'` still opts
 * out; any other explicit value is a deliberate override that force-enables extraction.
 */
export const EXTRACTION_PROVIDER_AUTO = "auto" as const;

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
	/**
	 * Router-selection token; defaults to `'auto'` (derive from a configured provider). `'none'`
	 * disables extraction (a-AC-5 / FR-9); any other explicit value is an override (see
	 * {@link EXTRACTION_PROVIDER_AUTO} / {@link EXTRACTION_PROVIDER_NONE}).
	 */
	extractionProvider: z.string().trim().min(1).default(EXTRACTION_PROVIDER_AUTO),
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
 * Is extraction live for this config? The decision now honors the `'auto'` default (PRD: memory
 * as a discoverable, provider-derived feature):
 *
 *   1. the pipeline must be `enabled` (master switch) — off → always false;
 *   2. `extractionProvider === 'none'` → always false (the deliberate opt-out, a-AC-5 / FR-9);
 *   3. `extractionProvider === 'auto'` (the UNSET default) → derive from `providerConfigured`:
 *      extraction runs iff a REAL (non-noop) inference ModelClient is configured. Absence of the
 *      env override no longer means "disabled";
 *   4. any OTHER explicit value (an override / escape hatch) → enabled (the operator asked for it).
 *
 * `providerConfigured` is the assembly-time "is a real model provider wired?" signal (the
 * ModelClient is non-noop). It defaults to `false` so a PURE-config caller (no provider knowledge —
 * the config unit tests, the stage gate before a client exists) gets the conservative answer: under
 * `'auto'` with no provider signal, extraction is off. The worker passes the real signal.
 */
export function isExtractionEnabled(config: PipelineConfig, providerConfigured = false): boolean {
	if (!config.enabled) return false;
	if (config.extractionProvider === EXTRACTION_PROVIDER_NONE) return false;
	if (config.extractionProvider === EXTRACTION_PROVIDER_AUTO) return providerConfigured;
	return true;
}

/**
 * Collapse the `'auto'` extraction sentinel down to a CONCRETE provider token now that the
 * provider-configured signal is known (the worker calls this once, at boot, after building the
 * inference ModelClient). The returned config is what the STAGES read — so the extraction stage's
 * `isExtractionEnabled(config)` (which has no provider knowledge) sees a concrete value and behaves
 * exactly as before `'auto'` existed:
 *
 *   - `extractionProvider === 'auto'` + `providerConfigured` → rewrite to `EXTRACTION_PROVIDER_AUTO`
 *     kept as-is is NOT enough for the pure gate, so we rewrite to a REAL marker token that the pure
 *     gate treats as "enabled" — `'auto-resolved'` (any non-sentinel value enables). This keeps the
 *     stage provider-agnostic;
 *   - `extractionProvider === 'auto'` + NOT `providerConfigured` → rewrite to `'none'` (no provider
 *     wired → nothing to extract with, the honest disabled state);
 *   - an explicit `'none'` or any explicit override → returned UNCHANGED.
 *
 * Pure + total: returns a config (the input is treated as immutable). Idempotent for non-`'auto'`
 * inputs.
 */
export function resolveEffectiveExtractionProvider(
	config: PipelineConfig,
	providerConfigured: boolean,
): PipelineConfig {
	if (config.extractionProvider !== EXTRACTION_PROVIDER_AUTO) return config;
	return {
		...config,
		extractionProvider: providerConfigured ? EXTRACTION_PROVIDER_AUTO_RESOLVED : EXTRACTION_PROVIDER_NONE,
	};
}

/**
 * The concrete provider token `'auto'` resolves to when a real provider IS configured. It is NOT a
 * sentinel (it is neither `'auto'` nor `'none'`), so the pure {@link isExtractionEnabled} gate treats
 * it as "enabled" — the stage stays provider-agnostic. The value is opaque to the stage; the router
 * maps the workload to the actual model as always (the stage holds no provider knowledge, 006a FR-3).
 */
export const EXTRACTION_PROVIDER_AUTO_RESOLVED = "auto-resolved" as const;

/**
 * The VAULT-FIRST master-`enabled` precedence (this PRD), mirroring the embeddings/pollinating boot
 * resolution: the dashboard-persisted `memory.enabled` vault value WINS when present (true OR false),
 * otherwise the env-resolved `HONEYCOMB_PIPELINE_ENABLED` (`config.enabled`) stands. Pure + total so
 * the precedence is unit-testable in isolation from the vault/scope machinery.
 *
 *   - vault PRESENT (`decidedByVault: true`) → the vault value wins (a saved `true` enables memory
 *     with NO env editing; a saved `false` disables even when the env says true);
 *   - vault ABSENT (`decidedByVault: false`) → the env fallback (`envEnabled`) stands;
 *   - both absent/off → `false` (the false-safe default the schema already documents).
 *
 * @param vault the vault decision: whether a value was present, and (if so) its coerced boolean.
 * @param envEnabled the env-resolved `config.enabled` (the `HONEYCOMB_PIPELINE_ENABLED` fallback).
 */
export function resolveMemoryEnabledVaultFirst(
	vault: { decidedByVault: boolean; enabled: boolean },
	envEnabled: boolean,
): boolean {
	return vault.decidedByVault ? vault.enabled : envEnabled;
}
