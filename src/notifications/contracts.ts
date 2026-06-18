/**
 * Notifications + environment-health contracts + seams — PRD-020d Wave 1.
 *
 * ── THE THESIS (FR-1..FR-9 / D-2 / D-5) ─────────────────────────────────────
 *   The notifications pipeline drains on SessionStart, fail-soft and bounded; the
 *   D1–D5 health check surfaces missing prerequisites before they cause silent data
 *   loss; the auto-wiring engine resolves the wirable dimensions REUSING the 019a
 *   connector rules (preserve foreign, idempotent, reversible — D-4). All of it is a
 *   THIN CLIENT: backend notifications are fetched THROUGH THE DAEMON (the only
 *   DeepLake client); this code opens NO DeepLake. `src/notifications` is a
 *   NON_DAEMON_ROOT (D-2; `tests/daemon/storage/invariant.test.ts`).
 *
 * ── Module home = `src/notifications/` ──────────────────────────────────────
 *   State files (`notifications-state.json`, claim files) live under `~/.honeycomb/`
 *   and are touched through the {@link NotificationsState} + {@link ClaimLock} seams
 *   (real POSIX `openSync(..,"wx")` + temp-file-plus-atomic-`renameSync`, D-5), so a
 *   Wave-2 test drives them against a temp dir / in-memory fake.
 *
 * ── What Wave 1 ships ────────────────────────────────────────────────────────
 *   The {@link NotificationsPipeline} contract, the {@link ClaimLock} seam + fake
 *   (D-5), the {@link NotificationsState} seam + fake (persistent vs transient,
 *   temp+atomic-rename), the {@link HealthCheck} contract with the five dimensions
 *   {@link HealthDimensionId} D1..D5 + the {@link HealthDimension} result type, and
 *   the {@link AutoWiring} seam reusing the connector rules. Bodies are honest stubs;
 *   Wave 2 fills them. Every export is STABLE — Wave 2 is additive only (020a's
 *   `status` + 020c's status bar consume the `HealthDimension` shape).
 */

/** Honest-stub thrower — an early call FAILS LOUD with a stable, greppable message. */
export function notImplemented(what: string): never {
	throw new Error(`PRD-020d: not implemented — ${what}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// Health: the five dimensions (FR-7 / d-AC-2 / index AC-3) — consumed by 020a + 020c
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The five INDEPENDENT health dimensions (FR-7). Stable ids 020a's `status` and 020c's
 * status bar render verbatim:
 *   - D1 `honeycomb` CLI installed (PATH + version probe)
 *   - D2 daemon reachable on port 3850 (TCP probe + fast-start fallback)
 *   - D3 `cursor-agent` present (PATH + IDE-directory fallbacks)
 *   - D4 `cursor-agent` login (lightweight status query)
 *   - D5 hooks wired and current (`hooks.json` matches the current bundle)
 */
export type HealthDimensionId = "D1" | "D2" | "D3" | "D4" | "D5";

/** The ordered dimension ids (the render order for `status` + the status bar). */
export const HEALTH_DIMENSION_IDS: readonly HealthDimensionId[] = Object.freeze(["D1", "D2", "D3", "D4", "D5"]);

/** Human labels for each dimension (FR-7). */
export const HEALTH_DIMENSION_LABELS: Readonly<Record<HealthDimensionId, string>> = Object.freeze({
	D1: "honeycomb CLI installed",
	D2: "daemon reachable (3850)",
	D3: "cursor-agent present",
	D4: "cursor-agent login",
	D5: "hooks wired and current",
});

/**
 * Whether a failing dimension can be AUTO-RESOLVED by the auto-wiring engine (FR-8).
 * D5 (hooks wired) is wirable; D1/D2/D3/D4 are prerequisites that auto-wiring SURFACES
 * but cannot mint (e.g. a logged-out D4 needs the user). The map drives d-AC-2: surface
 * a failing dimension, auto-resolve the wirable ones without clobbering foreign hooks.
 */
export const HEALTH_DIMENSION_WIRABLE: Readonly<Record<HealthDimensionId, boolean>> = Object.freeze({
	D1: false,
	D2: false,
	D3: false,
	D4: false,
	D5: true,
});

/**
 * One dimension's result (FR-7 / d-AC-2). The shape 020a (`status`) + 020c (status bar)
 * both consume — keep it STABLE. `ok` is the pass/fail; `detail` carries the version /
 * url / failure reason; `wirable` mirrors {@link HEALTH_DIMENSION_WIRABLE}.
 */
export interface HealthDimension {
	/** The dimension id (`D1`..`D5`). */
	readonly id: HealthDimensionId;
	/** Human label. */
	readonly label: string;
	/** True when the dimension passed. */
	readonly ok: boolean;
	/** Short detail: version / url / the failure reason. NEVER a token. */
	readonly detail?: string;
	/** True when a failing instance is auto-wirable (FR-8). */
	readonly wirable: boolean;
}

/** The full health report: one {@link HealthDimension} per id, in {@link HEALTH_DIMENSION_IDS} order. */
export interface HealthReport {
	/** The dimensions, in id order. */
	readonly dimensions: readonly HealthDimension[];
	/** True when every dimension passed. */
	readonly healthy: boolean;
}

/**
 * THE HEALTH-CHECK CONTRACT (FR-7 / d-AC-2). `evaluate()` probes all five dimensions and
 * returns the report; `autoWire()` resolves the wirable failing ones idempotently (FR-8 /
 * d-AC-2 / d-AC-6) and returns the post-wire report. The probes run through injected
 * seams (PATH/TCP/FS) so a test drives every D-x branch without a real CLI/daemon/editor.
 */
export interface HealthCheck {
	/** Probe D1–D5 and return the report (FR-7). */
	evaluate(): Promise<HealthReport>;
	/** Auto-resolve the wirable failing dimensions, foreign-preserving + idempotent (FR-8). */
	autoWire(): Promise<HealthReport>;
}

// ─────────────────────────────────────────────────────────────────────────────
// ClaimLock — the POSIX-exclusive double-invocation lock (FR-4 / d-AC-1 / D-5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE CLAIM-LOCK SEAM (FR-4 / d-AC-1 / D-5). The real impl is `openSync(path, "wx")`:
 * the FIRST process to create the claim file wins (emits the banner); a racer that hits
 * `EEXIST` returns `false` and SKIPS emitting — so exactly ONE banner shows across racing
 * hook processes. `release()` unlinks the claim (transient notifications re-emit next
 * session, FR-6). Behind a seam so a Wave-2 test drives the race deterministically against
 * a fake; the real impl uses the genuine POSIX exclusive create (D-5 — not a mutex stand-in).
 */
export interface ClaimLock {
	/** Atomically claim `key`. Returns true iff THIS caller won the race (FR-4 / d-AC-1). */
	claim(key: string): boolean;
	/** Release a previously-won claim (unlink the claim file) so it can re-fire (FR-6). */
	release(key: string): void;
}

/** A fake {@link ClaimLock} recording claims/releases — first claimant of a key wins. */
export interface FakeClaimLock extends ClaimLock {
	/** The keys currently held (for assertions). */
	readonly held: ReadonlySet<string>;
	/** Every claim attempt, in order, with the won/lost outcome. */
	readonly attempts: readonly { readonly key: string; readonly won: boolean }[];
}

/**
 * Build an in-memory {@link FakeClaimLock} (the deterministic race seam). The first
 * `claim(key)` wins (true); a second `claim(key)` before `release` loses (false) — exactly
 * the `wx`/`EEXIST` semantics, without touching disk. Records every attempt for d-AC-1.
 */
export function createFakeClaimLock(): FakeClaimLock {
	const held = new Set<string>();
	const attempts: { key: string; won: boolean }[] = [];
	return {
		get held(): ReadonlySet<string> {
			return held;
		},
		get attempts(): readonly { readonly key: string; readonly won: boolean }[] {
			return attempts;
		},
		claim(key: string): boolean {
			const won = !held.has(key);
			if (won) held.add(key);
			attempts.push({ key, won });
			return won;
		},
		release(key: string): void {
			held.delete(key);
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// NotificationsState — persistent vs transient (FR-5 / FR-6 / d-AC-4 / d-AC-5 / D-5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A persistent-notification record (FR-5 / d-AC-4). A welcome / first-time-guide / org
 * savings recap records its `id` + `dedupKey` in `notifications-state.json` so it shows
 * EXACTLY ONCE. State writes use temp-file + atomic `renameSync` (crash-safe, D-5).
 */
export interface PersistentRecord {
	/** The notification id. */
	readonly id: string;
	/** The dedup key — a record with a seen dedupKey is never re-shown (d-AC-4). */
	readonly dedupKey: string;
	/** When it was first shown (ISO). */
	readonly shownAt: string;
}

/** The on-disk state shape (`notifications-state.json`) — the seen persistent records. */
export interface NotificationsStateData {
	/** Seen persistent records, keyed by dedupKey. */
	readonly seen: Readonly<Record<string, PersistentRecord>>;
}

/**
 * THE STATE SEAM (FR-5 / FR-6 / D-5). Reads/writes `notifications-state.json` via
 * temp-file + atomic `renameSync` (the real impl), so a crash never leaves a torn file.
 * `markShown` records a persistent record (show-once); `wasShown` checks a dedupKey
 * (d-AC-4). Transient notifications do NOT record here — they re-emit each session while
 * the cause persists (FR-6 / d-AC-5), gated only by the {@link ClaimLock}. Behind a seam so
 * a Wave-2 test drives it against a temp dir.
 */
export interface NotificationsState {
	/** Load the current state (empty when the file is absent). */
	load(): NotificationsStateData;
	/** True when a persistent dedupKey has already been shown (FR-5 / d-AC-4). */
	wasShown(dedupKey: string): boolean;
	/** Record a persistent notification as shown (temp-file + atomic rename, D-5). */
	markShown(record: PersistentRecord): void;
}

/** A fake {@link NotificationsState} backed by an in-memory map (no disk). */
export interface FakeNotificationsState extends NotificationsState {
	/** The seen records (for assertions). */
	readonly records: ReadonlyMap<string, PersistentRecord>;
}

/** Build an in-memory {@link FakeNotificationsState} (seedable with prior seen records). */
export function createFakeNotificationsState(seed?: Record<string, PersistentRecord>): FakeNotificationsState {
	const records = new Map<string, PersistentRecord>(Object.entries(seed ?? {}));
	return {
		get records(): ReadonlyMap<string, PersistentRecord> {
			return records;
		},
		load(): NotificationsStateData {
			return { seen: Object.fromEntries(records) };
		},
		wasShown(dedupKey: string): boolean {
			return records.has(dedupKey);
		},
		markShown(record: PersistentRecord): void {
			records.set(record.dedupKey, record);
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// AutoWiring — REUSES the 019a connector rules (FR-9 / d-AC-6 / D-4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE AUTO-WIRING SEAM (FR-9 / d-AC-6 / D-4). Wires the lifecycle events into
 * `~/.cursor/hooks.json` on the user's behalf, REUSING the 019a connector rules:
 * preserve foreign (`isHoneycombEntry`), idempotent (`writeJsonIfChanged` → an unchanged
 * config is never rewritten, so the hook-trust fingerprint is stable, d-AC-6), reversible
 * (uninstall strips only Honeycomb hooks). The real impl DELEGATES to a `HarnessConnector`
 * (`src/connectors`) — it does NOT fork a second merge engine (D-4). `wire()` returns
 * whether the config actually changed (false on the idempotent no-op, d-AC-6).
 */
export interface AutoWiring {
	/** Wire the lifecycle events, foreign-preserving + idempotent (FR-9). Returns true iff written. */
	wire(): Promise<boolean>;
	/** Reverse only Honeycomb's wiring (FR-9 / reversible). */
	unwire(): Promise<void>;
}

// ─────────────────────────────────────────────────────────────────────────────
// NotificationsPipeline — drained on SessionStart, fail-soft + bounded (FR-1..FR-6)
// ─────────────────────────────────────────────────────────────────────────────

/** The trigger a drain runs under (FR-1). Today only `session_start`; future-extensible. */
export type NotificationTrigger = "session_start";

/** A notification's persistence class (FR-5 / FR-6). */
export type NotificationKind = "persistent" | "transient";

/**
 * One notification considered for the primary banner (FR-1). `priority` orders the
 * picker (higher wins); `kind` selects persistent (show-once via state) vs transient
 * (re-emit, gated by the claim lock). `dedupKey` is the persistent show-once key.
 */
export interface Notification {
	/** The notification id. */
	readonly id: string;
	/** Persistent (show-once) or transient (re-emit while cause persists). */
	readonly kind: NotificationKind;
	/** The banner text. */
	readonly text: string;
	/** Higher wins the primary-banner pick (FR-1 priority model). */
	readonly priority: number;
	/** The persistent show-once dedup key (persistent only). */
	readonly dedupKey?: string;
}

/** The seam that fetches backend notifications THROUGH THE DAEMON (FR-3 — never DeepLake). */
export interface BackendNotificationSource {
	/** Fetch backend notifications via the daemon. Bounded by the pipeline's ~1.5s timeout (FR-2). */
	fetch(): Promise<readonly Notification[]>;
}

/** A fake {@link BackendNotificationSource} replaying canned notifications (optionally hanging). */
export function createFakeBackendSource(notifications: readonly Notification[] = []): BackendNotificationSource {
	return {
		async fetch(): Promise<readonly Notification[]> {
			return notifications;
		},
	};
}

/** The outcome of a drain: the chosen primary banner (or none), and what was suppressed. */
export interface DrainResult {
	/** The primary banner picked under the priority model, or `null` when none fired. */
	readonly banner: Notification | null;
	/** Ids suppressed this drain (already-shown persistent, lost claim race, etc.). */
	readonly suppressed: readonly string[];
}

/** The injectable seams the pipeline drains against (FR-1..FR-6). */
export interface PipelineDeps {
	/** The persistent-state seam (show-once, D-5). */
	readonly state: NotificationsState;
	/** The double-invocation claim lock (D-5). */
	readonly lock: ClaimLock;
	/** The backend fetch seam (through the daemon, FR-3). */
	readonly backend: BackendNotificationSource;
	/** The per-fetch timeout budget in ms (FR-2). Defaults to ~1500. */
	readonly timeoutMs?: number;
}

/**
 * THE PIPELINE CONTRACT (FR-1 / FR-2). `drain(trigger)` reads persistent state + the queue,
 * evaluates rules for the trigger, fetches backend notifications through the daemon (in
 * parallel with the primary-banner fetch, each bounded by the ~1.5s timeout, FR-2),
 * suppresses already-shown persistent ones (FR-5) and lost claim-race ones (FR-4), and picks
 * the primary banner. FAIL-SOFT: every fetch failure is swallowed, never blocking the session
 * (FR-2 / d-AC-3). Wave 1 declares the shape with an honest-stub body; Wave 2 fills it.
 */
export interface NotificationsPipeline {
	/** Drain the notifications for a trigger and return the primary banner (FR-1). */
	drain(trigger: NotificationTrigger): Promise<DrainResult>;
}
