/**
 * The SINGLE telemetry-egress chokepoint — PRD-050e (e-AC-1 .. e-AC-10).
 *
 * `emitTelemetry(event, opts, deps?)` is the ONLY place in the codebase that posts to the PostHog
 * capture endpoint. Every emit site (install → `honeycomb_installed`, login → `honeycomb_first_link`,
 * migration → `honeycomb_hivemind_upgrade`, plus the gated Tier-2 representative) funnels through HERE
 * (e-AC-7), so the allow-list, the opt-out gate, the dedupe ledger, the tiered-consent gate, the
 * bounded-timeout fire-and-forget posture, and the glass-box `sent` log live in ONE module.
 *
 * ── The egress contract (the bright line, e-AC-2 / e-AC-10) ──────────────────
 * The payload is BUILT FROM AN ALLOW-LIST ({@link buildAllowedProperties}) — never from caller-
 * supplied free-form props. A caller MAY pass extra `properties`, but they are filtered through the
 * SAME allow-list, so a leak is structurally impossible: a field not on {@link ALLOWED_PROPERTY_KEYS}
 * never leaves the machine. There is NO per-item (per-memory / per-query / per-file) path here; counts
 * arrive pre-bucketed (e-AC-10). The {@link BANNED_PROPERTY_KEYS} set is the test's enumeration of what
 * must NEVER appear; the allow-list is the positive guarantee that proves it.
 *
 * ── The gates, in order (a return is silent — telemetry NEVER throws, e-AC-4) ─
 *   1. Build-injected `__HONEYCOMB_POSTHOG_KEY__` empty           → hard-disabled (unkeyed dev build).
 *   2. `HONEYCOMB_TELEMETRY=0` OR `DO_NOT_TRACK=1`                → opted out, BOTH tiers (e-AC-3/e-AC-9).
 *   3. Tier-2 event without `onboarding.telemetry.optInTier2`     → not consented (e-AC-9).
 *   4. Event already in the `reported` dedupe ledger             → already sent once (e-AC-5).
 * Only past all four does a single bounded-timeout POST fire; on a 2xx the event is recorded in BOTH
 * the `reported` ledger (dedupe) and the glass-box `sent` log (audit), then persisted.
 *
 * ── Fire-and-forget, fail-soft (e-AC-4) ──────────────────────────────────────
 * The POST is wrapped in an AbortController timeout and a try/catch that swallows EVERYTHING — a
 * timeout, a network error, a 4xx, a 5xx. `emitTelemetry` resolves to a structured {@link EmitOutcome}
 * for tests/glass-box, but it NEVER rejects and NEVER changes a host flow's exit code. The caller awaits
 * it only to know the outcome; install/login/migration call it AFTER their user-facing success and
 * ignore the result.
 *
 * ── The seams are injectable so unit tests never hit the network ─────────────
 * `fetch`, `loadOnboarding`/`saveOnboarding`, the `clock`, the opt-out `env`, and the timeout are all
 * injectable (mirroring the `deeplake-issuer.ts` posture). Production defaults are the global `fetch`,
 * the shared onboarding store, the system clock, `process.env`, and {@link DEFAULT_EMIT_TIMEOUT_MS}.
 *
 * ── This module carries NO secret ────────────────────────────────────────────
 * The PostHog project key (`phc_…`) is a PUBLIC write-only ingest key, build-injected via esbuild
 * `define` (`__HONEYCOMB_POSTHOG_KEY__`), never a runtime `process.env` read and never logged. The
 * payload holds NO token/email/path/content — only allow-listed operational facts.
 */

import { arch, platform, release } from "node:os";

import {
	type OnboardingState,
	type TelemetryEventName,
	type TelemetrySentRecord,
	appendSent,
	isReported,
	loadOnboarding,
	markReported,
	saveOnboarding,
} from "../onboarding/index.js";

// ────────────────────────────────────────────────────────────────────────────
// Build-injected destination (esbuild `define`; empty key ⇒ telemetry disabled).
// ────────────────────────────────────────────────────────────────────────────

/**
 * The PostHog project write-only ingest key (`phc_…`), build-injected via esbuild `define`. EMPTY
 * (`""`) — the un-keyed dev/un-bundled default — means telemetry is HARD-DISABLED (a no-op): the
 * fail-soft posture for any build that did not bake a key (e-AC, impl-note 1).
 */
export const POSTHOG_KEY: string = typeof __HONEYCOMB_POSTHOG_KEY__ === "string" ? __HONEYCOMB_POSTHOG_KEY__ : "";

/**
 * The PostHog ingest host, build-injected via esbuild `define`. Defaults to the US cloud. The capture
 * path {@link POSTHOG_CAPTURE_PATH} is appended to THIS host — and it is the ONLY URL this module ever
 * posts to (the e-AC-7 structural test greps for exactly this host/path, asserting no call site bypasses
 * the chokepoint).
 */
export const POSTHOG_HOST: string =
	typeof __HONEYCOMB_POSTHOG_HOST__ === "string" && __HONEYCOMB_POSTHOG_HOST__.length > 0
		? __HONEYCOMB_POSTHOG_HOST__
		: "https://us.i.posthog.com";

/**
 * The pinned PostHog US-Cloud capture path (PRD-050e RESOLVED). The full ingest URL is
 * `${POSTHOG_HOST}${POSTHOG_CAPTURE_PATH}`; the body is `{ api_key, event, properties, distinct_id }`.
 * This literal is the e-AC-7 grep anchor — it appears in THIS module and nowhere else.
 */
export const POSTHOG_CAPTURE_PATH = "/i/v0/e/" as const;

/** Build the full capture URL (`${host}${path}`) — the ONE URL this module posts to. */
export function captureUrl(host: string = POSTHOG_HOST): string {
	return `${host.replace(/\/+$/, "")}${POSTHOG_CAPTURE_PATH}`;
}

// ────────────────────────────────────────────────────────────────────────────
// Opt-out env (e-AC-3) — honored for BOTH tiers.
// ────────────────────────────────────────────────────────────────────────────

/** The Honeycomb-specific opt-out env var. `HONEYCOMB_TELEMETRY=0` silences ALL telemetry. */
export const ENV_TELEMETRY = "HONEYCOMB_TELEMETRY";
/** The cross-tool opt-out standard. `DO_NOT_TRACK=1` (or any truthy non-"0") silences ALL telemetry. */
export const ENV_DO_NOT_TRACK = "DO_NOT_TRACK";

/**
 * True when the user has OPTED OUT of all telemetry via either env var (e-AC-3). `HONEYCOMB_TELEMETRY=0`
 * is the explicit Honeycomb off-switch; `DO_NOT_TRACK=1` is the cross-tool standard (any value other than
 * empty/"0" counts as set, matching the consoledonottrack.com convention). Opt-out silences BOTH tiers.
 */
export function isOptedOut(env: NodeJS.ProcessEnv = process.env): boolean {
	if (env[ENV_TELEMETRY] === "0") return true;
	const dnt = env[ENV_DO_NOT_TRACK];
	return dnt !== undefined && dnt !== "" && dnt !== "0";
}

// ────────────────────────────────────────────────────────────────────────────
// Tier taxonomy (e-AC-9) — Tier-1 opt-out, Tier-2 opt-in.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The consent tier of an event. Tier-1 (operational lifecycle facts) emits under OPT-OUT; Tier-2
 * (usage-count signals) emits ONLY when `onboarding.telemetry.optInTier2` is true (e-AC-9).
 */
export type TelemetryTier = "tier1" | "tier2";

/**
 * The Tier-1 event set: the named lifecycle events (e-AC-1). All are operational "a moment
 * happened" facts with no content, so they ride the opt-out default. `honeycomb_hivemind_upgrade`'s
 * call site is PRD-050d's; this module builds + tests its emit so 050d only has to call the chokepoint.
 * `honeycomb_updated` (a version change observed at a lifecycle checkpoint, deduped per event+version
 * via {@link EmitOptions.dedupeKey}) and `honeycomb_uninstalled` (the `honeycomb uninstall` verb ran)
 * are lifecycle facts of the same shape, so they ride Tier-1 too.
 */
export const TIER1_EVENTS: ReadonlySet<TelemetryEventName> = new Set<TelemetryEventName>([
	"honeycomb_installed",
	"honeycomb_first_link",
	"honeycomb_hivemind_upgrade",
	"honeycomb_updated",
	"honeycomb_uninstalled",
]);

/**
 * Resolve the tier of an event NAME. The three named lifecycle events are Tier-1; everything else (the
 * usage-count signals carried via the `tier` option) is Tier-2. The caller passes the explicit tier in
 * {@link EmitOptions.tier}; this is the structural cross-check that a NAMED Tier-1 event is never
 * accidentally downgraded.
 */
export function tierForEvent(event: TelemetryEventName): TelemetryTier {
	return TIER1_EVENTS.has(event) ? "tier1" : "tier2";
}

// ────────────────────────────────────────────────────────────────────────────
// The allow-list (e-AC-2 / e-AC-10) — the SINGLE source of payload shape.
// ────────────────────────────────────────────────────────────────────────────

/**
 * The CLOSED allow-list of property keys that may leave the machine (e-AC-2). The payload is BUILT from
 * this set — `ref` + the coarse platform facts + an optional pre-bucketed count — and any caller-supplied
 * property whose key is not here is DROPPED. Adding a telemetry field means adding a key HERE (and the
 * banned-list assertion grows to cover the new field's shape); there is no other egress path.
 *
 *   - `ref`            — the effective referral code (e-AC-1). A short operator code, never PII.
 *   - `source_tool`    — the harness enum (`claude-code` | `cursor` | …) — a platform name, never a project.
 *   - `honeycomb_version` — the build version string (already public).
 *   - `os` / `arch` / `node` — coarse platform facts (e.g. `darwin` / `arm64` / `v22.5.0`). No hostname.
 *   - `tier`           — the consent tier the event rode (`tier1` | `tier2`), for the operator's funnel.
 *   - `count_bucket`   — a BUCKET label (`0` | `1-10` | `11-100` | `100+`) for a Tier-2 usage signal;
 *                        the PRECISE number never leaves the machine (e-AC-10).
 */
export const ALLOWED_PROPERTY_KEYS = [
	"ref",
	"source_tool",
	"honeycomb_version",
	"os",
	"arch",
	"node",
	"tier",
	"count_bucket",
] as const;

/** One allow-listed property key. */
export type AllowedPropertyKey = (typeof ALLOWED_PROPERTY_KEYS)[number];

/** The allow-listed property bag — the EXACT shape that may leave the machine. */
export type AllowedProperties = Partial<Record<AllowedPropertyKey, string>>;

/** Fast membership check used by {@link buildAllowedProperties} to drop any non-allow-listed key. */
const ALLOWED_KEY_SET: ReadonlySet<string> = new Set(ALLOWED_PROPERTY_KEYS);

/**
 * The BANNED key/value-shape set (e-AC-2) — the things that must NEVER appear in any payload. This is
 * the enumeration the structural test asserts absent from every emitted event; the allow-list above is
 * the positive guarantee that makes the assertion hold. Each entry is a substring the test scans the
 * serialized payload (keys AND values) for. It grows as events grow; the assertion stays one test.
 */
export const BANNED_PROPERTY_KEYS = [
	"token",
	"bearer",
	"authorization",
	"email",
	"userName",
	"username",
	"cwd",
	"path",
	"repo",
	"branch",
	"query",
	"memory",
	"session",
	"content",
	"prompt",
	"error",
	"stack",
	"message",
	"secret",
	"apiKey",
	"accountId",
	"orgId",
	"workspaceId",
	"account_id",
	"org_id",
	"workspace_id",
] as const;

/**
 * The valid coarse count buckets (e-AC-10). A Tier-2 usage signal reports ONE of these labels, never the
 * precise count (precision fingerprints a user). {@link bucketCount} maps a raw integer onto a label.
 */
export const COUNT_BUCKETS = ["0", "1-10", "11-100", "100+"] as const;

/** One coarse count bucket label. */
export type CountBucket = (typeof COUNT_BUCKETS)[number];

/**
 * Map a precise count onto its coarse {@link CountBucket} (e-AC-10) — the ONLY count representation that
 * may leave the machine. `0 → "0"`, `1..10 → "1-10"`, `11..100 → "11-100"`, `>100 → "100+"`. The precise
 * integer is discarded here and never egresses.
 */
export function bucketCount(n: number): CountBucket {
	if (n <= 0) return "0";
	if (n <= 10) return "1-10";
	if (n <= 100) return "11-100";
	return "100+";
}

/**
 * Build the coarse platform facts every event carries — `os` (e.g. `darwin`), `arch` (e.g. `arm64`), and
 * `node` (`process.version`). These are deliberately coarse: the OS FAMILY + arch + node version, NEVER a
 * hostname, a release detail beyond the kernel family, or any machine-identifying string. Injectable for a
 * deterministic test.
 */
export function platformFacts(): { os: string; arch: string; node: string } {
	// `platform()` is the OS family (`darwin`/`win32`/`linux`); `release()` is intentionally NOT included
	// (a kernel build string is needlessly fingerprinting). `arch()` is the CPU arch; `process.version` is
	// the node version. `release` is imported only to make the "we considered and rejected it" explicit.
	void release;
	return { os: platform(), arch: arch(), node: process.version };
}

/**
 * Assemble the allow-listed payload from the typed inputs (e-AC-2). Starts from `ref` + the coarse
 * platform facts + the build version + the consent `tier`, folds in an optional `count_bucket` and a
 * `source_tool`, then FILTERS any caller-supplied `extra` through {@link ALLOWED_KEY_SET} — so a non-
 * allow-listed key (or a banned field a caller mistakenly passes) is structurally DROPPED, never sent.
 * Only string values survive (a non-string is dropped), so no object/array can smuggle nested content.
 */
export function buildAllowedProperties(input: {
	ref: string;
	tier: TelemetryTier;
	version: string;
	sourceTool?: string;
	countBucket?: CountBucket;
	extra?: Readonly<Record<string, unknown>>;
}): AllowedProperties {
	const facts = platformFacts();
	const out: AllowedProperties = {
		ref: input.ref,
		honeycomb_version: input.version,
		os: facts.os,
		arch: facts.arch,
		node: facts.node,
		tier: input.tier,
	};
	if (input.sourceTool !== undefined && input.sourceTool.length > 0) out.source_tool = input.sourceTool;
	if (input.countBucket !== undefined) out.count_bucket = input.countBucket;
	// Caller-supplied extras are filtered through the allow-list — a non-allow-listed or non-string value
	// is DROPPED (the structural guarantee behind e-AC-2). The allow-listed core above always wins.
	if (input.extra !== undefined) {
		for (const [key, value] of Object.entries(input.extra)) {
			// `!(key in out)` enforces "the allow-listed core above always wins": a caller-supplied extra
			// may only FILL a missing allow-listed key, never OVERWRITE the canonical ref/tier/version/
			// platform facts already seeded (which would break attribution/platform integrity).
			if (ALLOWED_KEY_SET.has(key) && typeof value === "string" && !(key in out)) {
				out[key as AllowedPropertyKey] = value;
			}
		}
	}
	return out;
}

// ────────────────────────────────────────────────────────────────────────────
// The injectable seams + the emit options.
// ────────────────────────────────────────────────────────────────────────────

/** The minimal `fetch` response shape the chokepoint reads (a subset of the DOM `Response`). */
export interface TelemetryFetchResponse {
	readonly ok: boolean;
	readonly status: number;
}

/** The minimal request init the chokepoint passes (POST + JSON body + an abort signal for the timeout). */
export interface TelemetryFetchRequestInit {
	readonly method: string;
	readonly headers: Record<string, string>;
	readonly body: string;
	readonly signal?: AbortSignal;
}

/** The injectable `fetch` (the network seam). Tests pass a recorder so no real PostHog is hit. */
export type TelemetryFetch = (url: string, init: TelemetryFetchRequestInit) => Promise<TelemetryFetchResponse>;

/** A monotonic-ish clock returning an ISO-8601 timestamp (injectable for deterministic tests). */
export type TelemetryClock = () => string;

/** The real wall-clock ISO timestamp. */
export const systemTelemetryClock: TelemetryClock = () => new Date().toISOString();

/** The injectable deps the chokepoint runs against — all defaulted to the production seams. */
export interface EmitDeps {
	/** The network seam (defaults to the global `fetch`). */
	readonly fetch?: TelemetryFetch;
	/** Load the onboarding state (defaults to the shared store). Override `dir` instead in tests where possible. */
	readonly loadOnboarding?: (dir?: string) => OnboardingState;
	/** Persist the onboarding state (defaults to the shared store). */
	readonly saveOnboarding?: (state: OnboardingState, dir?: string) => OnboardingState;
	/** Override the onboarding dir (tests point this at a temp HOME). */
	readonly dir?: string;
	/** The env the opt-out gate reads (defaults to `process.env`). */
	readonly env?: NodeJS.ProcessEnv;
	/** The clock stamping `reported`/`sent` (defaults to {@link systemTelemetryClock}). */
	readonly clock?: TelemetryClock;
	/** The bounded POST timeout in ms (defaults to {@link DEFAULT_EMIT_TIMEOUT_MS}). */
	readonly timeoutMs?: number;
	/** Override the build-injected key (tests force the keyed/unkeyed branch without a rebuild). */
	readonly posthogKey?: string;
	/** Override the capture host (tests assert the posted URL without a rebuild). */
	readonly posthogHost?: string;
	/** Override the build version stamped into the payload (defaults to {@link HONEYCOMB_VERSION}). */
	readonly version?: string;
}

/** The per-emit options the caller supplies — the effective ref, the tier, and any allow-listed extras. */
export interface EmitOptions {
	/** The effective referral code carried in the payload (e-AC-1) — default `mario` upstream. */
	readonly ref: string;
	/** The consent tier (e-AC-9). A Tier-2 event is gated on `onboarding.telemetry.optInTier2`. */
	readonly tier: TelemetryTier;
	/** The harness/source enum, when known (`source_tool`). */
	readonly sourceTool?: string;
	/** A PRE-BUCKETED count for a Tier-2 usage signal (e-AC-10). The precise number stays on the machine. */
	readonly countBucket?: CountBucket;
	/** Extra allow-listed properties (filtered through {@link ALLOWED_KEY_SET}). */
	readonly properties?: Readonly<Record<string, unknown>>;
	/**
	 * Override the dedupe-ledger KEY (defaults to the event name, i.e. once-per-machine, e-AC-5).
	 * A version-qualified caller passes e.g. `honeycomb_updated@1.2.3` so dedupe is per
	 * event+version while the event NAME sent over the wire stays the plain `honeycomb_updated`.
	 */
	readonly dedupeKey?: string;
}

/** The default bounded POST timeout — a telemetry POST never hangs an install longer than this (e-AC-4). */
export const DEFAULT_EMIT_TIMEOUT_MS = 2000;

/** The build version stamped into the payload (build-injected, mirrors the constants seam). */
export const HONEYCOMB_VERSION: string =
	typeof __HONEYCOMB_VERSION__ === "string" ? __HONEYCOMB_VERSION__ : "0.0.0-dev";

/**
 * Why an emit did NOT send (the structured outcome, for tests + glass-box). NEVER thrown — a gate or a
 * failure resolves to one of these instead of changing the host flow (e-AC-4).
 */
export type EmitSkipReason =
	| "disabled" // empty build key (e-AC, impl-note 1)
	| "opted_out" // HONEYCOMB_TELEMETRY=0 / DO_NOT_TRACK=1 (e-AC-3)
	| "not_consented" // Tier-2 without opt-in (e-AC-9)
	| "already_reported" // dedupe ledger hit (e-AC-5)
	| "send_failed"; // the POST timed out / errored / 4xx / 5xx (swallowed — e-AC-4)

/** The outcome of an {@link emitTelemetry} call (resolved, never rejected). */
export interface EmitOutcome {
	/** True iff a 2xx came back AND the event was recorded in the dedupe + sent ledgers. */
	readonly sent: boolean;
	/** When `sent` is false, why (a gate or a swallowed failure). Absent when `sent` is true. */
	readonly skipped?: EmitSkipReason;
	/** The allow-listed payload that was built (present whether or not it was sent — glass-box). */
	readonly properties: AllowedProperties;
}

/** The PostHog capture body shape — exactly `{ api_key, event, properties, distinct_id }` (pinned). */
interface CaptureBody {
	readonly api_key: string;
	readonly event: TelemetryEventName;
	readonly properties: AllowedProperties;
	readonly distinct_id: string;
}

// ────────────────────────────────────────────────────────────────────────────
// The chokepoint.
// ────────────────────────────────────────────────────────────────────────────

/**
 * THE SINGLE TELEMETRY CHOKEPOINT (e-AC-7). Emit `event` with the allow-listed payload built from
 * `opts`, applying — in order — the disabled / opt-out / not-consented / already-reported gates, then a
 * bounded fire-and-forget POST. On a 2xx the event is marked reported (dedupe, e-AC-5) and appended to the
 * glass-box `sent` log (e-AC-8), and the onboarding state is persisted. NEVER throws and NEVER changes a
 * host flow's result (e-AC-4) — it resolves an {@link EmitOutcome} the caller may inspect or ignore.
 *
 * `distinct_id` is ALWAYS the anonymized random `installId` from the onboarding state — never an email or
 * a raw account id (e-AC-6). The whole function is wrapped so even an unexpected throw (e.g. a load/save
 * IO error) resolves to a `send_failed`/skip outcome rather than propagating.
 */
export async function emitTelemetry(
	event: TelemetryEventName,
	opts: EmitOptions,
	deps: EmitDeps = {},
): Promise<EmitOutcome> {
	const env = deps.env ?? process.env;
	const key = deps.posthogKey ?? POSTHOG_KEY;
	const version = deps.version ?? HONEYCOMB_VERSION;

	// The EFFECTIVE tier is the STRICTER of the event-derived tier and the caller-supplied tier — tier2
	// always wins. This closes two abuse paths the caller-trusted `opts.tier` alone left open: it cannot
	// DOWNGRADE a (future) Tier-2-named event to escape the consent gate, and a caller marking an emit
	// `tier2` still trips the Gate-3 consent check below even on a Tier-1-named event. A named Tier-1
	// lifecycle event therefore can never be silently suppressed, and no Tier-2 emit can bypass opt-in
	// (e-AC-9). `tierForEvent` supplies the floor; `opts.tier` may only raise it.
	const effectiveTier: TelemetryTier = tierForEvent(event) === "tier2" || opts.tier === "tier2" ? "tier2" : "tier1";

	// The payload is built up-front so the glass-box outcome carries it even when a gate blocks the send
	// (so `telemetry --show` can render "what WOULD be sent next" from the SAME builder — e-AC-8).
	const properties = buildAllowedProperties({
		ref: opts.ref,
		tier: effectiveTier,
		version,
		...(opts.sourceTool !== undefined ? { sourceTool: opts.sourceTool } : {}),
		...(opts.countBucket !== undefined ? { countBucket: opts.countBucket } : {}),
		...(opts.properties !== undefined ? { extra: opts.properties } : {}),
	});

	// Gate 1: empty build key ⇒ hard-disabled (unkeyed dev build). NO load, NO network.
	if (key.length === 0) return { sent: false, skipped: "disabled", properties };

	// Gate 2: opted out via either env var ⇒ silence BOTH tiers. NO load, NO network (e-AC-3).
	if (isOptedOut(env)) return { sent: false, skipped: "opted_out", properties };

	try {
		const load = deps.loadOnboarding ?? loadOnboarding;
		const save = deps.saveOnboarding ?? saveOnboarding;
		const state = load(deps.dir);

		// Gate 3: a Tier-2 event needs explicit opt-in (e-AC-9). Tier-1 rides the opt-out default. The tier
		// is the EVENT-derived effectiveTier (above), never the caller-supplied opts.tier, so consent
		// cannot be bypassed by mislabelling the event.
		if (effectiveTier === "tier2" && state.telemetry.optInTier2 !== true) {
			return { sent: false, skipped: "not_consented", properties };
		}

		// Gate 4: dedupe. Each ledger key sends AT MOST ONCE per machine (e-AC-5). The key defaults
		// to the event name; a caller-supplied `dedupeKey` (e.g. `honeycomb_updated@<version>`)
		// scopes the dedupe to event+version instead.
		const ledgerKey = opts.dedupeKey ?? event;
		if (isReported(state, ledgerKey)) return { sent: false, skipped: "already_reported", properties };

		// distinct_id is ALWAYS the anonymized random installId (e-AC-6) — never email/account id.
		const distinctId = state.installId;

		const ok = await postCapture(event, properties, distinctId, key, deps);
		if (!ok) return { sent: false, skipped: "send_failed", properties };

		// 2xx → record in BOTH ledgers (dedupe + glass-box) and persist. The persist is BEST-EFFORT: a 2xx
		// already happened, so a save IO failure must NOT flip the outcome to `send_failed` (which would
		// leave the dedupe ledger un-advanced and re-open a duplicate emission on the next trigger). The
		// event counts as sent regardless; PostHog-side dedup is the backstop per the PRD.
		const clock = deps.clock ?? systemTelemetryClock;
		const at = clock();
		const sentRecord: TelemetrySentRecord = { event, at, properties };
		const next = appendSent(markReported(state, ledgerKey, at), sentRecord);
		try {
			save(next, deps.dir);
		} catch {
			// A persist hiccup after a successful send is non-fatal — the send still counts (see above).
		}
		return { sent: true, properties };
	} catch {
		// Fail-soft: ANY unexpected error (load/save IO, a thrown fetch) is swallowed (e-AC-4).
		return { sent: false, skipped: "send_failed", properties };
	}
}

/**
 * Issue the ONE bounded-timeout POST to the PostHog capture endpoint and return whether it was a 2xx.
 * Wrapped in an AbortController timeout + a try/catch that swallows EVERYTHING (timeout / network /
 * non-2xx) → returns `false` rather than throwing (e-AC-4). This is the ONLY function that touches the
 * network; the body is exactly `{ api_key, event, properties, distinct_id }` (pinned).
 */
/**
 * THE SEAM PRD-050d CALLS for the Hivemind→Honeycomb upgrade event (e-AC-1). 050d's migration chokepoint
 * (Wave 2, not yet built) invokes THIS one line at the point a migration completes — it does NOT post to
 * PostHog itself (e-AC-7) and does NOT re-implement any gate. `honeycomb_hivemind_upgrade` is Tier-1
 * (operational), so it rides the opt-out default; it is deduped once per machine (e-AC-5) and silenced by
 * the opt-out env / empty key like every other event. Fire-and-forget: 050d must NOT let the returned
 * promise gate the migration's user-facing success (call it AFTER, ignore the result).
 *
 * Example 050d call site:
 *   await emitHivemindUpgrade(effectiveRef, { dir });   // after the migration's success line
 *
 * Kept as a named one-liner (not just "call emitTelemetry") so the upgrade emit has ONE obvious, greppable
 * seam 050d wires into, mirroring how install/login each have a single emit line.
 */
export async function emitHivemindUpgrade(ref: string, deps: EmitDeps = {}): Promise<EmitOutcome> {
	return emitTelemetry("honeycomb_hivemind_upgrade", { ref, tier: "tier1" }, deps);
}

async function postCapture(
	event: TelemetryEventName,
	properties: AllowedProperties,
	distinctId: string,
	key: string,
	deps: EmitDeps,
): Promise<boolean> {
	const doFetch = deps.fetch ?? (globalThis.fetch as unknown as TelemetryFetch);
	const host = deps.posthogHost ?? POSTHOG_HOST;
	const timeoutMs = deps.timeoutMs ?? DEFAULT_EMIT_TIMEOUT_MS;
	const body: CaptureBody = { api_key: key, event, properties, distinct_id: distinctId };

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		const resp = await doFetch(captureUrl(host), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(body),
			signal: controller.signal,
		});
		return resp.ok;
	} catch {
		// A dropped marketing event is acceptable; a hung install is not. Swallow + report not-sent.
		return false;
	} finally {
		clearTimeout(timer);
	}
}
