/**
 * Capture-domain config — PRD-062c L-X1 / AC-9 (the capture write-batching +
 * envelope-trim knobs).
 *
 * This is the ONE place the PRD-062c capture flags live; the capture handler reads
 * the resolved {@link CaptureConfig}, never `process.env` directly (mirrors
 * `pollinating/config.ts` / `pipeline/config.ts`: a raw-record provider seam, one
 * `safeParse` boundary, coerce/clamp tuning knobs rather than rejecting the whole
 * config on a fat-fingered number). It is DELIBERATELY scoped to the capture domain
 * — it does NOT touch the shared global storage/runtime config.
 *
 * ── The flags (DEFAULT-ON per L-X1; off ⇒ exact pre-PRD behavior, AC-9) ───────
 * - `batch`        master switch for write batching. DEFAULT TRUE. When false the
 *                  handler does ONE append-only INSERT per event (the pre-062c path),
 *                  so a regression is a config rollback, not a redeploy.
 * - `windowMs`     time-flush window in ms (default 1000). A burst flushes after at
 *                  most this long; the worst-case crash loss is one window.
 * - `maxEvents`    size-flush cap (default 25). A burst of this many events flushes
 *                  immediately regardless of the window.
 * - `envelopeBudgetBytes` per-field tool-I/O byte budget before truncation (default
 *                  16384). `0` DISABLES trimming (the full untrimmed envelope is
 *                  written — the pre-062c content), so flag-off parity is exact.
 *
 * ── Why coerce-and-clamp, not hard-reject ────────────────────────────────────
 * The numeric knobs are tuning: a non-numeric `HONEYCOMB_CAPTURE_WINDOW_MS` falls
 * back to its default and a sub-floor value is clamped, so a typo never takes the
 * capture path (the cheap, always-on front of the system) down. `batch` defaults
 * TRUE (the cost incident is P0 — batching is the win), and the budget defaults to
 * 16384; both can be turned off without a redeploy.
 */

import { z } from "zod";

/** Default time-flush window in ms (AC-5). */
export const DEFAULT_CAPTURE_WINDOW_MS = 1_000;
/** Default size-flush cap in events (AC-5). */
export const DEFAULT_CAPTURE_MAX_EVENTS = 25;
/** Default per-field tool-I/O byte budget before truncation (AC-6). */
export const DEFAULT_CAPTURE_ENVELOPE_BUDGET_BYTES = 16_384;

/**
 * A boolean flag read from an env string: `true`/`1` → true, `false`/`0` → false.
 *
 * NOTE: this `BoolFlag` is duplicated across the config modules (recall, pipeline, pollinating,
 * lifecycle, poll-backoff, lease-coordinator); a single shared helper is a follow-up. Until then each
 * copy must carry the same trim — see below.
 */
const BoolFlag = z.preprocess((raw) => {
	if (typeof raw === "boolean") return raw;
	// TRIM before comparing: env values routinely arrive with surrounding whitespace (a Windows
	// scheduled-task `set "VAR=true" && …` chain, a copy-paste). Without the trim an exact `=== "true"`
	// read `"true "` as FALSE (the same trailing-space class as the APIARY_HOME bug).
	const s = typeof raw === "string" ? raw.trim() : raw;
	return s === "true" || s === "1";
}, z.boolean());

/**
 * A non-negative-integer tuning knob: a non-numeric value falls back to the default,
 * a value below `min` is clamped up to `min`. `min` defaults to 0 so the envelope
 * budget can be set to `0` (trimming OFF); the window/size knobs pass `min = 1`.
 */
function ClampedInt(def: number, min = 0) {
	return z.preprocess((raw) => {
		const n = typeof raw === "number" ? raw : Number(raw);
		if (!Number.isFinite(n)) return def;
		return Math.max(min, Math.trunc(n));
	}, z.number().int());
}

/** The validated capture-domain config the handler reads. Resolved once + injected. */
export const CaptureConfigSchema = z.object({
	/** Master switch for write batching; DEFAULT-ON (L-X1). Off ⇒ one INSERT per event. */
	batch: BoolFlag.default(true),
	/** Time-flush window in ms (AC-5). */
	windowMs: ClampedInt(DEFAULT_CAPTURE_WINDOW_MS, 1).default(DEFAULT_CAPTURE_WINDOW_MS),
	/** Size-flush cap in events (AC-5). */
	maxEvents: ClampedInt(DEFAULT_CAPTURE_MAX_EVENTS, 1).default(DEFAULT_CAPTURE_MAX_EVENTS),
	/** Per-field tool-I/O byte budget; `0` disables trimming (full envelope, pre-062c). */
	envelopeBudgetBytes: ClampedInt(DEFAULT_CAPTURE_ENVELOPE_BUDGET_BYTES, 0).default(
		DEFAULT_CAPTURE_ENVELOPE_BUDGET_BYTES,
	),
});

/** The resolved capture-domain config a consumer takes as a dep (never re-resolves). */
export type CaptureConfig = z.infer<typeof CaptureConfigSchema>;

/** The env keys this config reads (the L-X1 flags). Exported so docs/tests reference one source. */
export const CAPTURE_ENV_KEYS = {
	batch: "HONEYCOMB_CAPTURE_BATCH",
	windowMs: "HONEYCOMB_CAPTURE_WINDOW_MS",
	maxEvents: "HONEYCOMB_CAPTURE_MAX_EVENTS",
	envelopeBudgetBytes: "HONEYCOMB_CAPTURE_ENVELOPE_BUDGET_BYTES",
	/** PRD-073a: the `__unsorted__` inbox opt-in (default OFF). */
	inboxCapture: "HONEYCOMB_INBOX_CAPTURE",
} as const;

/**
 * Resolve the capture config from a raw env record (defaults to `process.env`).
 * The single `safeParse` boundary: a malformed knob coerces/clamps to its default
 * rather than throwing, so the always-on capture path never fails to construct.
 * The provider seam (an explicit `env` record) lets a test resolve a config
 * without mutating the real environment.
 */
export function resolveCaptureConfig(env: NodeJS.ProcessEnv = process.env): CaptureConfig {
	const parsed = CaptureConfigSchema.safeParse({
		batch: env[CAPTURE_ENV_KEYS.batch],
		windowMs: env[CAPTURE_ENV_KEYS.windowMs],
		maxEvents: env[CAPTURE_ENV_KEYS.maxEvents],
		envelopeBudgetBytes: env[CAPTURE_ENV_KEYS.envelopeBudgetBytes],
	});
	// safeParse can only fail if a default itself is invalid (it cannot) — fall back
	// to the all-defaults config so resolution is total.
	return parsed.success ? parsed.data : CaptureConfigSchema.parse({});
}

/**
 * Resolve the PRD-073a `__unsorted__` inbox opt-in from the env (default OFF). Kept as a STANDALONE
 * parse — separate from {@link CaptureConfig} — so the pre-073 config shape (and every test literal
 * that constructs it) is unchanged, while the flag still lives in one place (this module). `true`/`1`
 * ⇒ ON (the PRD-049a inbox behavior is restored for unbound-cwd captures); anything else ⇒ OFF (a
 * session in an unbound folder is GATED, not inboxed). Total: a malformed value reads as OFF.
 */
export function resolveInboxCaptureEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	const raw = env[CAPTURE_ENV_KEYS.inboxCapture];
	const parsed = BoolFlag.safeParse(raw);
	return parsed.success ? parsed.data : false;
}
