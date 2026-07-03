/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

/**
 * Deep Lake connection hibernation — the idle-cost master switch (cost incident follow-up to PRD-062 / PRD-066).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Activeloop's serverless Postgres (the `api.deeplake.ai` data plane) scales the
 * per-tenant compute pod to zero, but ONLY after the tenant's LAST connection
 * disconnects: an idle timer starts on last-disconnect and, if no connection
 * arrives before it fires, the pod is dropped. Billing is `compute (uptime)` — the
 * pod being provisioned, NOT query volume. So a single recurring query keeps the
 * pod warm forever and bills a flat hourly rate even on a near-empty dataset.
 *
 * Measured behavior: Node's global fetch dispatcher closes an idle Deep Lake
 * socket on its own ~9s after the last request (the server does not extend
 * keep-alive). So we do NOT need a custom dispatcher or an explicit socket close —
 * we only need to STOP issuing Deep Lake queries while the daemon is idle. The
 * connection then closes itself and the pod scales to zero. PRD-062's backoff and
 * PRD-066's local queue reduced query churn but never reach zero: the worker poll
 * loops still re-touch the shared Deep Lake queue on their ceiling cadence, which
 * re-provisions the pod each cycle. This controller is the master switch that
 * silences ALL of them when idle.
 *
 * ── What it does ─────────────────────────────────────────────────────────────
 * It holds a set of {@link Pausable} handles — one per background activity that
 * touches Deep Lake on a timer (the pipeline / pollinating / summary / skillify
 * workers, the lease coordinator, the storage health probe, the codebase-graph
 * rebuild). After `idleMs` with no daemon activity it HIBERNATES: pauses every
 * handle so no further Deep Lake query is issued; the socket closes within ~10s and
 * the pod scales to zero. The local HTTP server stays up and the local job queue
 * still accepts captures, so nothing is lost. On the next activity — a capture or a
 * recall arriving on the HTTP server calls {@link DeepLakeHibernation.touch} — it
 * WAKES: resumes every handle. The first post-wake Deep Lake query pays Activeloop's
 * cold-start (a few seconds to re-provision the pod); responses are simply slower at
 * spin-up, which is the accepted trade for an idle cost of ~zero.
 *
 * ── No I/O, no clock-of-record ───────────────────────────────────────────────
 * The controller owns no Deep Lake access and no wall clock. It calls the injected
 * `pause()`/`resume()` on its handles and the injected `now`/`setTimer`/`clearTimer`
 * seams, so the AC-named tests drive the whole surface with a manual clock and fake
 * handles — no timers, no network. `pause`/`resume` are guarded so one handle that
 * throws never blocks the rest.
 *
 * ── Default-ON, with a parity off-switch (mirrors PRD-062b's AC-9 posture) ────
 * The cost fix ships DEFAULT-ON via {@link envHibernationConfigProvider} (an ABSENT
 * `HONEYCOMB_DEEPLAKE_HIBERNATE_ENABLED` means enabled). ONLY an explicit `false`/`0`
 * disables it and the daemon behaves exactly as before (every loop runs forever, the
 * pre-fix cadence) — the documented rollback. With the flag off `start()` is a no-op
 * and no handle is ever paused.
 */

/** Default idle window before the daemon hibernates its Deep Lake connection (2 min). */
export const DEFAULT_HIBERNATE_IDLE_MS = 120_000;
/** Floor for the idle window: a fat-fingered tiny value is clamped so we never thrash. */
export const MIN_HIBERNATE_IDLE_MS = 5_000;

/**
 * A background activity that touches Deep Lake on a timer and can be silenced while
 * idle. `pause()` stops it issuing further Deep Lake queries; `resume()` restarts it.
 * Both MUST be idempotent (safe to call when already paused/resumed) — the controller
 * relies on that, exactly like {@link DaemonService}. A label is carried for logs only.
 */
export interface Pausable {
	/** Human label for diagnostics (e.g. "health-probe", "pollinating"). */
	readonly label: string;
	/** Stop issuing Deep Lake queries. Idempotent. */
	pause(): void | Promise<void>;
	/** Resume normal operation. Idempotent. */
	resume(): void | Promise<void>;
}

/** The validated hibernation config the controller reads (resolved once, injected). */
export interface HibernationConfig {
	/** Master switch; off → `start()` is a no-op and nothing is ever paused (rollback). */
	readonly enabled: boolean;
	/** Idle window (ms) with no daemon activity before hibernating. Clamped to a sane floor. */
	readonly idleMs: number;
}

/** The injected timer seam (mirrors the poll loop's `setTimer`/`clearTimer`). */
export interface HibernationTimers {
	readonly setTimer: (cb: () => void, ms: number) => unknown;
	readonly clearTimer: (handle: unknown) => void;
}

/** A minimal logger seam; the daemon injects its structured logger, tests a no-op. */
export interface HibernationLogger {
	info(event: string, fields?: Record<string, unknown>): void;
}

/** Construction deps for {@link createDeepLakeHibernation}. */
export interface HibernationDeps {
	/** Everything that touches Deep Lake on a timer and must go quiet when idle. */
	readonly pausables: readonly Pausable[];
	/** The resolved config (its `enabled` flag decides whether the switch is live). */
	readonly config: HibernationConfig;
	/** Monotonic-ish clock; the controller never reads the wall clock directly. */
	readonly now: () => number;
	/** Timer seam; defaults can be the host's setTimeout/clearTimeout at the call site. */
	readonly timers: HibernationTimers;
	/** Optional logger; omitted in unit tests. */
	readonly logger?: HibernationLogger;
}

/**
 * The idle-cost master switch. `start()`/`stop()` make it a {@link DaemonService}-
 * shaped lifecycle citizen; `touch()` records activity and wakes if hibernated;
 * `isHibernated()` exposes state for diagnostics and the health surface.
 */
export interface DeepLakeHibernation {
	/** Begin idle monitoring (no-op when disabled). Idempotent. */
	start(): void;
	/** Stop idle monitoring and cancel the pending timer. Does NOT touch the handles. Idempotent. */
	stop(): void;
	/** Record daemon activity; if hibernated, wake (resume every handle). Cheap + sync. */
	touch(): void;
	/** True iff currently hibernated (handles paused, Deep Lake connection allowed to drop). */
	isHibernated(): boolean;
}

type State = "stopped" | "active" | "hibernated";

/** Clamp an idle-window config value to the floor; a non-numeric one falls back to the default. */
function resolveIdleMs(idleMs: number): number {
	return Number.isFinite(idleMs) ? Math.max(MIN_HIBERNATE_IDLE_MS, Math.trunc(idleMs)) : DEFAULT_HIBERNATE_IDLE_MS;
}

/**
 * Apply `pause`/`resume` to every handle in order, guarding each so a single thrower
 * is logged and skipped rather than aborting the rest of the sweep (one wedged worker
 * must never strand the others paused or running).
 */
async function applyToHandles(
	pausables: readonly Pausable[],
	op: "pause" | "resume",
	logger?: HibernationLogger,
): Promise<void> {
	const event = op === "pause" ? "hibernate.pause.error" : "wake.resume.error";
	for (const p of pausables) {
		try {
			await (op === "pause" ? p.pause() : p.resume());
		} catch (err) {
			logger?.info(event, { handle: p.label, error: err instanceof Error ? err.message : String(err) });
		}
	}
}

/**
 * The idle-cost master switch as a small-method state machine. The state machine has
 * three states (`stopped` → `active` ⇄ `hibernated`) and debounces on `idleMs`: every
 * {@link touch} pushes the idle deadline out; when the debounce fires with no
 * intervening activity it pauses every handle, and the next `touch()` resumes them.
 * Async transitions (hibernate/wake) are serialized by a `transitioning` guard so a
 * slow pause/resume can never overlap its inverse.
 */
class HibernationController implements DeepLakeHibernation {
	private readonly pausables: readonly Pausable[];
	private readonly config: HibernationConfig;
	private readonly now: () => number;
	private readonly timers: HibernationTimers;
	private readonly logger?: HibernationLogger;
	private readonly idleMs: number;

	private state: State = "stopped";
	private lastActivityAt = 0;
	private handle: unknown = null;
	private transitioning = false;

	constructor(deps: HibernationDeps) {
		this.pausables = deps.pausables;
		this.config = deps.config;
		this.now = deps.now;
		this.timers = deps.timers;
		this.logger = deps.logger;
		this.idleMs = resolveIdleMs(deps.config.idleMs);
	}

	start(): void {
		if (!this.config.enabled || this.state !== "stopped") return;
		this.state = "active";
		this.lastActivityAt = this.now();
		this.arm();
	}

	stop(): void {
		this.clear();
		this.state = "stopped";
	}

	touch(): void {
		if (this.state === "stopped") return;
		this.lastActivityAt = this.now();
		if (this.state === "hibernated") void this.wake();
		else this.arm();
	}

	isHibernated(): boolean {
		return this.state === "hibernated";
	}

	private clear(): void {
		if (this.handle !== null) {
			this.timers.clearTimer(this.handle);
			this.handle = null;
		}
	}

	/** Arm the debounce to fire `delay` (default the full idle window) from now. */
	private arm(delay: number = this.idleMs): void {
		this.clear();
		this.handle = this.timers.setTimer(() => this.onIdle(), delay);
	}

	private onIdle(): void {
		this.handle = null;
		// Only hibernate from the active state, and only if the idle window truly elapsed —
		// a late timer that raced a fresh touch re-arms for the remaining time instead.
		if (this.state !== "active") return;
		const elapsed = this.now() - this.lastActivityAt;
		if (elapsed < this.idleMs) this.arm(this.idleMs - elapsed);
		else void this.hibernate();
	}

	private async hibernate(): Promise<void> {
		if (this.state !== "active" || this.transitioning) return;
		this.transitioning = true;
		try {
			await applyToHandles(this.pausables, "pause", this.logger);
			this.state = "hibernated";
			this.logger?.info("deeplake.hibernated", { idleMs: this.idleMs, handles: this.pausables.length });
		} finally {
			this.transitioning = false;
		}
	}

	private async wake(): Promise<void> {
		if (this.state !== "hibernated" || this.transitioning) return;
		this.transitioning = true;
		try {
			await applyToHandles(this.pausables, "resume", this.logger);
			this.state = "active";
			this.logger?.info("deeplake.woke", { handles: this.pausables.length });
			this.arm();
		} finally {
			this.transitioning = false;
		}
	}
}

/** Build the idle-cost master switch (see {@link HibernationController}). */
export function createDeepLakeHibernation(deps: HibernationDeps): DeepLakeHibernation {
	return new HibernationController(deps);
}

/**
 * Resolve the hibernation config from the environment. DEFAULT-ON: an ABSENT
 * `HONEYCOMB_DEEPLAKE_HIBERNATE_ENABLED` means enabled, and ONLY an explicit
 * `false`/`0` rolls it back to the pre-fix always-connected behavior — a typo or any
 * other value stays enabled rather than silently disabling the cost fix.
 * `HONEYCOMB_DEEPLAKE_HIBERNATE_IDLE_MS` tunes the idle window (clamped to a floor);
 * a non-numeric value falls back to the default. Daemon-only (reads `process.env`).
 */
export function envHibernationConfigProvider(env: NodeJS.ProcessEnv = process.env): HibernationConfig {
	const rawEnabled = env.HONEYCOMB_DEEPLAKE_HIBERNATE_ENABLED;
	const enabled = !(rawEnabled === "false" || rawEnabled === "0");
	return { enabled, idleMs: resolveIdleMs(Number(env.HONEYCOMB_DEEPLAKE_HIBERNATE_IDLE_MS)) };
}
