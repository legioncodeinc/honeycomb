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
 * PRD-077 (read/write split) — the dedicated WRITE-client in-flight ceiling. The daemon builds a
 * SECOND in-process {@link StorageClient} for capture appends ONLY, sized by this knob, so a slow
 * DeepLake can never let capture writes consume the read client's Semaphore slots and queue recall
 * arms tens of seconds behind them (the live-observed `armsMs: 73273`). Default 3 leaves the read
 * client its full {@link MAX_CONCURRENT_QUERIES} (5) for recall/dashboard/heal/prime.
 */
export const DEFAULT_WRITE_MAX_CONCURRENCY = 3;
/** The floor for the write-concurrency knob: the write pool must admit at least one append. */
export const MIN_WRITE_MAX_CONCURRENCY = 1;

/**
 * PRD-077b (L-B6) — the four hot-lane knobs. All config-backed, env-overridable, coerce-and-clamp
 * like {@link DEFAULT_RECALL_MAX_CONCURRENCY} (a typo never takes the daemon down; it falls back to
 * the documented default or is clamped to a safe floor). Defaults are tuned from `request_log`
 * latency (the ~1.5s fast query, the ~4s client budget, the 25-min heavy tail), never hard-guessed.
 */
/** `HONEYCOMB_RECALL_FAST_MAX_CONCURRENCY` — the fast lane's dedicated in-flight ceiling; 8 sizes it to run one per-turn recall's 7 arms concurrently with headroom (L-B1). */
export const DEFAULT_RECALL_FAST_MAX_CONCURRENCY = 8;
/** `HONEYCOMB_RECALL_FAST_DEADLINE_MS` — the fast-lane server-side deadline; 3000ms sits above the ~1.5s fast query and below the ~4s client budget (L-B2). */
export const DEFAULT_RECALL_FAST_DEADLINE_MS = 3000;
/** `HONEYCOMB_RECALL_FAST_SHED_QUEUE_DEPTH` — the fast-lane waiter backlog past which a per-turn recall sheds instead of queuing (L-B3). */
export const DEFAULT_RECALL_FAST_SHED_QUEUE_DEPTH = 8;
/** `HONEYCOMB_RECALL_HEAVY_DEADLINE_MS` — the generous dashboard/heavy deadline (D-4); 15000ms caps the 25-min tail while a human waits for full quality (L-B8). */
export const DEFAULT_RECALL_HEAVY_DEADLINE_MS = 15000;
/**
 * PRD-077 (L-B9) — the two pre-arm EMBED deadlines. The query embed on the recall hot path runs
 * BEFORE the arm-deadline exists, so a hung embed daemon wedged both paths with zero completions
 * (the live-observed hang). These bound the embed so a slow/hung embed degrades to lexical-only.
 */
/** `HONEYCOMB_RECALL_FAST_EMBED_DEADLINE_MS` — bound on the fast-lane pre-arm query embed; 1500ms is generous over the ~13ms normal embed and keeps total fast ≈ embed + ~1.5s arms within the ~4s client budget (L-B9). */
export const DEFAULT_RECALL_FAST_EMBED_DEADLINE_MS = 1500;
/** `HONEYCOMB_RECALL_HEAVY_EMBED_DEADLINE_MS` — bound on the heavy-path pre-arm query embed; 3000ms is generous for the dashboard path where a human waits for full quality (L-B9). */
export const DEFAULT_RECALL_HEAVY_EMBED_DEADLINE_MS = 3000;
/** The floor for a concurrency knob: a pool must admit at least one task. */
export const MIN_RECALL_FAST_MAX_CONCURRENCY = 1;
/** The floor for a deadline knob (ms): a positive value — a `0` would abort every query on the next tick. */
export const MIN_RECALL_DEADLINE_MS = 1;
/** The floor for the shed queue-depth knob: `0` is legal (shed the moment ANY waiter parks). */
export const MIN_RECALL_SHED_QUEUE_DEPTH = 0;

/**
 * A coerce-and-clamp integer-knob factory (the ONE preprocess shape all five recall knobs share, so
 * the duplication gate stays green): a non-numeric value falls back to `fallback`; a sub-`min` value
 * is clamped UP to `min` (a `0` concurrency would deadlock the pool, so it becomes the near-serial 1).
 */
function clampedIntKnob(fallback: number, min: number) {
	return z.preprocess((raw) => {
		const n = typeof raw === "number" ? raw : Number(raw);
		if (!Number.isFinite(n)) return fallback;
		return Math.max(min, Math.trunc(n));
	}, z.number().int());
}

/**
 * The concurrency knob: a positive integer, clamped UP to {@link MIN_RECALL_MAX_CONCURRENCY}.
 * A non-numeric value falls back to the default; a sub-1 value is clamped (a `0` would
 * deadlock the pool, so it becomes 1, the near-serial posture) — a typo is tuning noise.
 */
const ConcurrencyKnob = clampedIntKnob(DEFAULT_RECALL_MAX_CONCURRENCY, MIN_RECALL_MAX_CONCURRENCY);

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
	/** `HONEYCOMB_WRITE_MAX_CONCURRENCY` — the dedicated write-client in-flight ceiling; 3 by default (PRD-077 read/write split). */
	writeMaxConcurrency: clampedIntKnob(DEFAULT_WRITE_MAX_CONCURRENCY, MIN_WRITE_MAX_CONCURRENCY).default(
		DEFAULT_WRITE_MAX_CONCURRENCY,
	),
	/** `HONEYCOMB_RECALL_FAST_MAX_CONCURRENCY` — the fast lane's dedicated ceiling; 8 by default (L-B1). */
	recallFastMaxConcurrency: clampedIntKnob(DEFAULT_RECALL_FAST_MAX_CONCURRENCY, MIN_RECALL_FAST_MAX_CONCURRENCY).default(
		DEFAULT_RECALL_FAST_MAX_CONCURRENCY,
	),
	/** `HONEYCOMB_RECALL_FAST_DEADLINE_MS` — the fast-lane server-side deadline; 3000ms by default (L-B2). */
	recallFastDeadlineMs: clampedIntKnob(DEFAULT_RECALL_FAST_DEADLINE_MS, MIN_RECALL_DEADLINE_MS).default(
		DEFAULT_RECALL_FAST_DEADLINE_MS,
	),
	/** `HONEYCOMB_RECALL_FAST_SHED_QUEUE_DEPTH` — the fast-lane shed queue-depth; 8 waiters by default (L-B3). */
	recallFastShedQueueDepth: clampedIntKnob(DEFAULT_RECALL_FAST_SHED_QUEUE_DEPTH, MIN_RECALL_SHED_QUEUE_DEPTH).default(
		DEFAULT_RECALL_FAST_SHED_QUEUE_DEPTH,
	),
	/** `HONEYCOMB_RECALL_HEAVY_DEADLINE_MS` — the generous heavy-path deadline (D-4); 15000ms by default (L-B8). */
	recallHeavyDeadlineMs: clampedIntKnob(DEFAULT_RECALL_HEAVY_DEADLINE_MS, MIN_RECALL_DEADLINE_MS).default(
		DEFAULT_RECALL_HEAVY_DEADLINE_MS,
	),
	/** `HONEYCOMB_RECALL_FAST_EMBED_DEADLINE_MS` — bound on the fast-lane pre-arm query embed; 1500ms by default (L-B9). */
	recallFastEmbedDeadlineMs: clampedIntKnob(DEFAULT_RECALL_FAST_EMBED_DEADLINE_MS, MIN_RECALL_DEADLINE_MS).default(
		DEFAULT_RECALL_FAST_EMBED_DEADLINE_MS,
	),
	/** `HONEYCOMB_RECALL_HEAVY_EMBED_DEADLINE_MS` — bound on the heavy-path pre-arm query embed; 3000ms by default (L-B9). */
	recallHeavyEmbedDeadlineMs: clampedIntKnob(DEFAULT_RECALL_HEAVY_EMBED_DEADLINE_MS, MIN_RECALL_DEADLINE_MS).default(
		DEFAULT_RECALL_HEAVY_EMBED_DEADLINE_MS,
	),
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
	/** PRD-077 (read/write split): the dedicated write-client in-flight ceiling. */
	readonly writeMaxConcurrency?: unknown;
	/** PRD-077b (L-B6): the four hot-lane knobs — fast-lane width, fast + heavy deadlines, shed depth. */
	readonly recallFastMaxConcurrency?: unknown;
	readonly recallFastDeadlineMs?: unknown;
	readonly recallFastShedQueueDepth?: unknown;
	readonly recallHeavyDeadlineMs?: unknown;
	/** PRD-077 (L-B9): the two pre-arm embed deadlines — fast + heavy. */
	readonly recallFastEmbedDeadlineMs?: unknown;
	readonly recallHeavyEmbedDeadlineMs?: unknown;
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
				// PRD-077 (read/write split): the dedicated write-client in-flight ceiling.
				writeMaxConcurrency: env.HONEYCOMB_WRITE_MAX_CONCURRENCY,
				// PRD-077b (L-B6): the four hot-lane knobs, env-overridable from `request_log` latency.
				recallFastMaxConcurrency: env.HONEYCOMB_RECALL_FAST_MAX_CONCURRENCY,
				recallFastDeadlineMs: env.HONEYCOMB_RECALL_FAST_DEADLINE_MS,
				recallFastShedQueueDepth: env.HONEYCOMB_RECALL_FAST_SHED_QUEUE_DEPTH,
				recallHeavyDeadlineMs: env.HONEYCOMB_RECALL_HEAVY_DEADLINE_MS,
				// PRD-077 (L-B9): the two pre-arm embed deadlines, env-overridable.
				recallFastEmbedDeadlineMs: env.HONEYCOMB_RECALL_FAST_EMBED_DEADLINE_MS,
				recallHeavyEmbedDeadlineMs: env.HONEYCOMB_RECALL_HEAVY_EMBED_DEADLINE_MS,
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
