/**
 * Embed-daemon supervisor — PRD-025 Wave 2 (D-6 / AC-1 second half / AC-5 plumbing).
 *
 * The Hivemind daemon OWNS the embed daemon: this {@link DaemonService} spawns it
 * as a single supervised child, polls its `/health` until it answers (liveness),
 * triggers + waits for its background warmup OFF the turn path (D-3), and
 * crash-restarts it with BOUNDED attempts when it exits. It is wired into
 * `assembleDaemon`'s lifecycle exactly like the job queue + file watcher: `start()`
 * on daemon start, `stop()` on daemon stop (so a clean daemon shutdown also drains
 * the embed child).
 *
 * ── Why a supervisor, not a per-request spawn (embeddings-runtime non-negotiable) ──
 * Model load + warmup is the expensive step. The child stays WARM and answers
 * batched `/embed` requests over the loopback IPC for the daemon's whole life;
 * per-request spawning would pay the warmup cost on every recall. The supervisor
 * warms it ONCE, in the background, so the first user recall is never blocked on a
 * cold model (D-3) — until warm, recall degrades to lexical + `degraded:true`
 * (Wave-1 already returns that on an unreachable/timeout embed), NEVER a hung recall.
 *
 * ── Restart policy (D-6 / D-4) ───────────────────────────────────────────────
 * A crashed child → bounded restart attempts with a backoff window. Each restart
 * re-warms. Once the bound is exhausted the supervisor STOPS retrying and leaves
 * recall on the lexical path (degraded) — a crash loop never wedges the daemon and
 * never blocks a turn. A deliberate {@link EmbedSupervisor.restart} (the AC-5 live
 * toggle) resets the bound and brings semantic back.
 *
 * ── Liveness after warm (ISS-007 / ISS-008: the wedge detector) ──────────────
 * The pre-existing warm wait was a ONE-SHOT latch: once `/health.ready` answered
 * true the supervisor NEVER probed again, so an embed daemon that later WEDGED
 * (accepts TCP, never replies — event-loop-blocked inference) kept reporting
 * `warm:true` forever while every recall burned its full embed deadline. The
 * supervisor now keeps a PERIODIC bounded liveness probe running after warm
 * (every {@link EmbedSupervisorConfig.livenessIntervalMs}, default 30s; the probe
 * itself is bounded by the 2s `/health` fetch timeout) plus an ON-DEMAND
 * {@link EmbedSupervisor.checkNow} the recall path fires when a bounded embed
 * times out. States: `warming → warm → suspect → failed`:
 *   - ONE failed probe on a warm child → `suspect` (recall skips the embed, no
 *     flap on a single slow reply) and a confirming re-probe is scheduled;
 *   - a SECOND consecutive failure CONFIRMS the wedge → mark not-warm, kill the
 *     wedged child, and respawn via the EXISTING bounded crash-restart machinery.
 *     The respawned child transitions back through `warming` (the live-observed
 *     ~40s post-respawn warmup tail where embeds take 10-27s) — a binary
 *     alive/dead probe would flap here, so `warming` is a first-class state and
 *     the periodic probe only ARMS once warm.
 * The probe is cheap (one loopback GET / 30s) and NON-REENTRANT (`probing` guard:
 * overlapping periodic + on-demand checks coalesce into one in-flight probe).
 *
 * ── Opt-out + zero-config (D-1 / D-2) ────────────────────────────────────────
 * `HONEYCOMB_EMBEDDINGS=false`/`0` → the supervisor is INERT: it never spawns, so
 * an explicit opt-out costs nothing and recall is cleanly lexical. Otherwise (unset
 * or on) it spawns + warms with no flag — the fresh-`honeycomb login` zero-config
 * default. First-run model acquisition is the child's concern (it downloads + caches
 * on warmup); the supervisor only ensures the child is up and warming.
 *
 * ── Hermetic by injection ────────────────────────────────────────────────────
 * `spawnChild` + `probeHealth` + the clock are injected. The unit tests drive a
 * FAKE child process (no real model, no 600 MB) and a scripted health probe to
 * prove: spawns on start, restarts on crash (bounded), stops on stop, warmup is off
 * the turn path, a never-starting child leaves recall degrading (not hanging).
 * Production defaults spawn the real bundled `embeddings/embed-daemon.js` and probe
 * the real loopback `/health`.
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { resolveEmbedClientOptions } from "./embed-client.js";
import type { DaemonService } from "./types.js";

/** A structured-log sink the supervisor reports lifecycle events to (no secret — AC-7). */
export interface EmbedSupervisorLogger {
	/** Record a structured event (e.g. `embed.spawned`, `embed.warm`, `embed.restart`). */
	event(name: string, fields?: Record<string, unknown>): void;
}

/** A no-op logger (default when the daemon does not inject one). */
const silentLogger: EmbedSupervisorLogger = { event(): void {} };

/** The minimal child-process handle the supervisor needs (so tests inject a fake). */
export interface EmbedChild {
	/** The OS pid, when known. */
	readonly pid: number | undefined;
	/** Register the exit callback (called once when the child exits/crashes). */
	onExit(cb: (code: number | null, signal: string | null) => void): void;
	/** Signal the child to terminate (graceful SIGTERM by default). */
	kill(signal?: NodeJS.Signals): void;
}

/** The injected clock + scheduler so tests drive time deterministically. */
export interface EmbedSupervisorClock {
	/** Sleep `ms` (defaults to a real timer). */
	sleep(ms: number): Promise<void>;
	/** Current wall-clock ms (defaults to `Date.now`). */
	now(): number;
}

/** Construction deps for {@link createEmbedSupervisor}. */
export interface EmbedSupervisorDeps {
	/**
	 * Spawn the embed-daemon child and return a handle. Defaults to spawning the
	 * bundled `embeddings/embed-daemon.js` DETACHED-but-tracked with `windowsHide:true`
	 * (Windows dev host). A test injects a fake that never touches the real model.
	 */
	readonly spawnChild?: () => EmbedChild;
	/**
	 * Probe the embed daemon's `/health` once. Returns `{ ok, ready, warmFailed }`: `ok` = the
	 * listener answered (liveness), `ready` = the model finished warming (D-3), `warmFailed` = the
	 * child's background warmup THREW (deps/model/download failure — the embed daemon stays live but
	 * can never serve, so this must not read as "still warming" forever). Defaults to a loopback
	 * `fetch` of `<url>/health`. A test scripts the sequence.
	 */
	readonly probeHealth?: () => Promise<{ ok: boolean; ready: boolean; warmFailed?: boolean }>;
	/** Optional structured-log sink. */
	readonly logger?: EmbedSupervisorLogger;
	/** Optional injected clock (real timers otherwise). */
	readonly clock?: EmbedSupervisorClock;
	/**
	 * ISS-007: schedule ONE deferred callback (the next periodic liveness probe) and return a
	 * cancel. Defaults to an UNREF'd `setTimeout` so a pending 30s probe never delays daemon
	 * shutdown or wedges a test runner. Injected as its own seam — deliberately NOT the
	 * `clock.sleep` used by the bounded start/warm polls — so the deterministic suites' instant
	 * clocks do not turn the open-ended periodic loop into a microtask spin; a test injects a
	 * manual scheduler and fires the probe tick explicitly.
	 */
	readonly scheduleProbe?: (cb: () => void, ms: number) => () => void;
	/** The env the enable toggle + URL resolve from (defaults to `process.env`). */
	readonly env?: NodeJS.ProcessEnv;
	/** Tuning knobs (all defaulted). */
	readonly config?: EmbedSupervisorConfig;
	/**
	 * The BOOT enabled decision (PRD dashboard-actions). When supplied it OVERRIDES the env-derived
	 * default so the composition root can seed the supervisor from the persisted `embeddings.enabled`
	 * vault setting (precedence: persisted setting → `HONEYCOMB_EMBEDDINGS` → default-on). ABSENT →
	 * the prior env-only behaviour (`!resolveEmbedClientOptions(env).enabled` decides `disabled`).
	 * The runtime {@link EmbedSupervisor.setEnabled} toggle can flip this live afterward.
	 */
	readonly enabled?: boolean;
}

/** Supervisor tuning (D-6 / D-4). All optional. */
export interface EmbedSupervisorConfig {
	/** Max bounded restart attempts before giving up the crash loop. Default 5. */
	readonly maxRestarts?: number;
	/** Backoff between restart attempts in ms. Default 1000. */
	readonly restartBackoffMs?: number;
	/** How long to poll `/health` for liveness after a spawn, in ms. Default 10000. */
	readonly liveTimeoutMs?: number;
	/** `/health` poll cadence while waiting for liveness/warm, in ms. Default 250. */
	readonly pollIntervalMs?: number;
	/** How long to wait for warm (`ready:true`) before giving up the wait, in ms. Default 120000. */
	readonly warmTimeoutMs?: number;
	/**
	 * ISS-007: cadence of the PERIODIC post-warm liveness probe, in ms. Default 30000.
	 * Each probe is itself bounded (the `/health` fetch aborts at 2s), so the steady-state
	 * cost is one cheap loopback GET every 30s — never a spawned process, never an inference.
	 */
	readonly livenessIntervalMs?: number;
	/**
	 * ISS-007: delay between a first failed post-warm probe (`suspect`) and the CONFIRMING
	 * re-probe, in ms. Default 1000. Two consecutive failures are required before the child
	 * is declared wedged, so a single slow `/health` reply never flaps a warm daemon.
	 */
	readonly livenessRetryMs?: number;
}

/** Resolved supervisor config. */
interface ResolvedConfig {
	readonly maxRestarts: number;
	readonly restartBackoffMs: number;
	readonly liveTimeoutMs: number;
	readonly pollIntervalMs: number;
	readonly warmTimeoutMs: number;
	readonly livenessIntervalMs: number;
	readonly livenessRetryMs: number;
}

function resolveConfig(c: EmbedSupervisorConfig | undefined): ResolvedConfig {
	return {
		maxRestarts: c?.maxRestarts ?? 5,
		restartBackoffMs: c?.restartBackoffMs ?? 1_000,
		liveTimeoutMs: c?.liveTimeoutMs ?? 10_000,
		pollIntervalMs: c?.pollIntervalMs ?? 250,
		warmTimeoutMs: c?.warmTimeoutMs ?? 120_000,
		livenessIntervalMs: c?.livenessIntervalMs ?? 30_000,
		livenessRetryMs: c?.livenessRetryMs ?? 1_000,
	};
}

/** The default real clock. */
const defaultClock: EmbedSupervisorClock = {
	sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
	now: () => Date.now(),
};

/**
 * The embed daemon's coarse liveness state as the SUPERVISOR currently sees it (ISS-007):
 *   - `off`     — embeddings disabled (opted out); no child, recall is cleanly lexical.
 *   - `warming` — enabled and the child is coming up / loading + warming the model (this covers
 *                 the live-observed ~40s post-respawn tail where embeds take 10-27s); recall
 *                 skips the embed and stays lexical MEANWHILE — no flap, no burned deadline.
 *   - `warm`    — the model answered `ready:true` and the last liveness probe was healthy:
 *                 semantic recall is actually servable right now.
 *   - `suspect` — the child WAS warm but the last periodic/on-demand probe went unanswered;
 *                 a confirming re-probe is pending. Recall already skips the embed here.
 *   - `failed`  — the child cannot serve: warmup threw, or the bounded crash-restart budget
 *                 was exhausted. Terminal until a deliberate restart/re-enable.
 */
export type EmbedLivenessState = "off" | "warming" | "warm" | "suspect" | "failed";

/**
 * The default real probe scheduler: an UNREF'd `setTimeout` (a pending 30s liveness tick must
 * never keep the process alive after daemon stop). Returns the cancel closure.
 */
const defaultScheduleProbe = (cb: () => void, ms: number): (() => void) => {
	const t = setTimeout(cb, ms);
	// `unref` exists on the Node Timeout; guard for exotic timer shims.
	(t as { unref?: () => void }).unref?.();
	return () => clearTimeout(t);
};

/**
 * Resolve the bundled `embeddings/embed-daemon.js` the supervisor spawns. The embed daemon lives at
 * `<package-root>/embeddings/embed-daemon.js`, but this module's DEPTH under the root differs by build
 * layout, so a fixed `..`-walk cannot be correct in both:
 *   - BUNDLED (production npm install): the supervisor is inlined into `<root>/daemon/index.js`, so the
 *     entry is ONE level up (`<root>/daemon` → `<root>/embeddings/embed-daemon.js`).
 *   - DEV (tsc): `<root>/dist/src/daemon/runtime/services/embed-supervisor.js`, so the entry is FIVE
 *     levels up (`services` → `runtime` → `daemon` → `src` → `dist` → `<root>`).
 *
 * The pre-existing code hard-coded the FIVE-level walk — correct for dev but WRONG for the bundled
 * install, where it resolved to `<root>/../../../embeddings/…` (outside the package). `spawn` then got a
 * non-existent path, the child exited 1 on start, the bounded-restart policy exhausted, and embeddings
 * were silently dead while `/health` still reported them enabled. We now probe candidate paths and pick
 * the first that EXISTS, so both layouts resolve correctly. `HONEYCOMB_EMBED_ENTRY` still wins (tests/itests).
 */
function resolveEmbedEntry(env: NodeJS.ProcessEnv): string {
	const here = dirname(fileURLToPath(import.meta.url));
	return pickEmbedEntry(here, existsSync, env.HONEYCOMB_EMBED_ENTRY);
}

/**
 * The pure entry-resolution core (extracted so the layout bug is deterministically testable without
 * spawning). Given the supervisor MODULE's directory, an `exists` predicate, and the optional
 * `HONEYCOMB_EMBED_ENTRY` override, return the embed-daemon path. The override wins; otherwise the
 * first candidate that EXISTS is chosen; otherwise the bundled sibling (the production shape) is the
 * sensible fallback. This is what fixes the ship bug: the pre-existing single hard-coded FIVE-up walk
 * was correct for the dev layout but resolved OUTSIDE the package in the bundled install.
 */
export function pickEmbedEntry(moduleDir: string, exists: (p: string) => boolean, override?: string): string {
	if (override !== undefined && override.length > 0) return override;
	const candidates = [
		// Bundled: `<root>/daemon/index.js` → sibling `<root>/embeddings/embed-daemon.js` (ONE level up).
		resolve(moduleDir, "..", "embeddings", "embed-daemon.js"),
		// Dev tsc: `<root>/dist/src/daemon/runtime/services/…` → `<root>/embeddings/…` (FIVE levels up).
		resolve(moduleDir, "..", "..", "..", "..", "..", "embeddings", "embed-daemon.js"),
	];
	const found = candidates.find((c) => exists(c));
	return found ?? candidates[0]!;
}

/**
 * The DeepLake/Activeloop credential env vars the daemon may hold in `process.env`
 * (the env credential provider reads `HONEYCOMB_DEEPLAKE_TOKEN`/`_ORG`/`_WORKSPACE`/
 * `_ENDPOINT` and the legacy `HONEYCOMB_TOKEN` directly). The embed child NEVER needs
 * any of them — it only reads `HOME`/`USERPROFILE` + the `HONEYCOMB_EMBED_*` knobs and
 * talks to a loopback HTTP listener + (on first warmup) huggingface.co. So they are
 * STRIPPED before spawn: a leaked Activeloop JWT in the address space of a third-party
 * inference stack that performs outbound network I/O is exactly the credential-exposure
 * surface to deny (least privilege — security-stinger C6).
 */
const CREDENTIAL_ENV_KEYS: readonly string[] = [
	"HONEYCOMB_DEEPLAKE_TOKEN",
	"HONEYCOMB_DEEPLAKE_ENDPOINT",
	"HONEYCOMB_DEEPLAKE_ORG",
	"HONEYCOMB_DEEPLAKE_WORKSPACE",
	"HONEYCOMB_TOKEN",
];

/**
 * Return a copy of `env` with the DeepLake/Activeloop credential vars removed, so the
 * embed child is spawned WITHOUT the daemon's token in its environment. Pure — never
 * mutates the caller's env. The child keeps everything else it needs (`PATH`, `HOME`,
 * `USERPROFILE`, all `HONEYCOMB_EMBED_*`, `HONEYCOMB_EMBEDDINGS`).
 */
export function scrubChildEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
	const scrubbed: NodeJS.ProcessEnv = { ...env };
	for (const key of CREDENTIAL_ENV_KEYS) delete scrubbed[key];
	return scrubbed;
}

/**
 * The default real spawn: launch the bundled embed daemon as a tracked child with
 * `windowsHide:true`. stdio is ignored (its logs go to its own stderr); the parent
 * tracks exit for crash-restart. NOT detached — the supervisor owns its lifetime and
 * tears it down on daemon stop. The child env is SCRUBBED of DeepLake credentials
 * ({@link scrubChildEnv}) — the embed stack never needs them and must not hold them.
 */
function defaultSpawnChild(env: NodeJS.ProcessEnv): () => EmbedChild {
	const entry = resolveEmbedEntry(env);
	const childEnv = scrubChildEnv(env);
	return (): EmbedChild => {
		const child: ChildProcess = spawn(process.execPath, [entry], {
			stdio: "ignore",
			env: childEnv,
			// Hide the transient console window on Windows — the embed child is never an
			// interactive terminal the user needs to see (Windows is the dev host).
			windowsHide: true,
		});
		return {
			pid: child.pid,
			onExit: (cb) => {
				child.once("exit", cb);
			},
			kill: (signal) => {
				child.kill(signal ?? "SIGTERM");
			},
		};
	};
}

/** The default real `/health` probe over the loopback URL the client dials. */
function defaultProbeHealth(env: NodeJS.ProcessEnv): () => Promise<{ ok: boolean; ready: boolean; warmFailed: boolean }> {
	const { url } = resolveEmbedClientOptions(env);
	// The default probe always returns a concrete `warmFailed` (the injected test seam may omit it).
	return async (): Promise<{ ok: boolean; ready: boolean; warmFailed: boolean }> => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 2_000);
		try {
			const res = await fetch(`${url}/health`, { signal: controller.signal });
			if (!res.ok) return { ok: false, ready: false, warmFailed: false };
			// The embed daemon reports `warmFailed:true` when its background model warmup threw (missing
			// optional deps, an offline model fetch, a dim mismatch). It stays live but can never serve, so
			// the supervisor must surface this as `failed`, not an indefinite "warming".
			const body = (await res.json()) as { ready?: unknown; warmFailed?: unknown };
			return { ok: true, ready: body.ready === true, warmFailed: body.warmFailed === true };
		} catch {
			return { ok: false, ready: false, warmFailed: false };
		} finally {
			clearTimeout(timer);
		}
	};
}

/**
 * The embed-daemon supervisor. Extends {@link DaemonService} so the bootstrap
 * starts/stops it uniformly alongside the queue + watcher. Exposes liveness/warm
 * accessors + a deliberate {@link restart} (the AC-5 live toggle).
 */
export interface EmbedSupervisor extends DaemonService {
	/** True once a spawned child has answered `/health` (liveness). */
	readonly live: boolean;
	/** True once the model finished warming (`/health.ready` — D-3). */
	readonly warm: boolean;
	/** True when the supervisor is inert (embeddings explicitly opted out — D-1). */
	readonly disabled: boolean;
	/**
	 * True when embeddings are ENABLED but the child cannot serve — either its background warmup threw
	 * (the embed daemon's `/health.warmFailed`) or the bounded crash-restart budget was exhausted (the
	 * child never came live). Distinct from `warm:false` alone, which just means "still warming". Lets
	 * `/health` report `failed` (actionable) instead of an indefinite `warming` (misleading).
	 */
	readonly failed: boolean;
	/**
	 * ISS-007: true while a previously-warm child has ONE unanswered liveness probe and the
	 * confirming re-probe is pending (the `suspect` state). Recall skips the embed while set;
	 * a healthy re-probe clears it, a second failure confirms the wedge and respawns. OPTIONAL
	 * (additive) so pre-existing structural fakes still satisfy the contract; absent ⇒ never suspect.
	 */
	readonly suspect?: boolean;
	/**
	 * ISS-007: the coarse liveness state (`off`/`warming`/`warm`/`suspect`/`failed`) recall's
	 * fast-skip gate and `/health` read. OPTIONAL (additive) for the same structural-fake reason;
	 * a consumer treats an absent state as the legacy warm/failed booleans.
	 */
	readonly state?: EmbedLivenessState;
	/** Current bounded restart count (for diagnostics). */
	readonly restarts: number;
	/**
	 * ISS-007: fire ONE on-demand bounded liveness probe NOW (outside the periodic cadence) —
	 * the recall path calls this when a bounded embed burns its deadline, so a wedge surfaces in
	 * seconds instead of at the next 30s tick. Coalesced + non-reentrant: a call while a probe is
	 * already in flight (or while not warm/suspect) is a no-op. Never throws; fire-and-forget.
	 * OPTIONAL (additive) so pre-existing structural fakes still satisfy the contract.
	 */
	checkNow?(): void;
	/**
	 * Deliberately tear down + respawn the child (the AC-5 live toggle: kill →
	 * recall degrades → restart → semantic back). Resets the bounded restart count.
	 */
	restart(): Promise<void>;
	/**
	 * Turn embeddings on/off LIVE (the dashboard toggle). `setEnabled(true)` spawns + warms the
	 * child if it is not already running; `setEnabled(false)` stops it (recall degrades to lexical).
	 * Idempotent: calling it with the already-current state is a no-op. Flips the supervisor's
	 * `disabled` accessor so a subsequent `start()`/`restart()` honors the new state. Persistence of
	 * the choice is the caller's concern (the action endpoint writes the `embeddings.enabled` vault
	 * setting); this method only actuates the running process.
	 */
	setEnabled(enabled: boolean): Promise<void>;
}

/** Build the embed-daemon supervisor (PRD-025 Wave 2 / D-6). */
export function createEmbedSupervisor(deps: EmbedSupervisorDeps = {}): EmbedSupervisor {
	const env = deps.env ?? process.env;
	const logger = deps.logger ?? silentLogger;
	const clock = deps.clock ?? defaultClock;
	const cfg = resolveConfig(deps.config);
	const spawnChild = deps.spawnChild ?? defaultSpawnChild(env);
	const probeHealth = deps.probeHealth ?? defaultProbeHealth(env);
	const scheduleProbe = deps.scheduleProbe ?? defaultScheduleProbe;

	// D-1: an explicit `HONEYCOMB_EMBEDDINGS=false`/`0` makes the supervisor inert. The composition
	// root may OVERRIDE this with `deps.enabled` (the persisted `embeddings.enabled` vault setting), and
	// the dashboard `setEnabled` toggle flips it live afterward — so this is a MUTABLE runtime flag, not
	// a construction-time const. `enabled === false` ⇒ `disabled` (no child; recall is cleanly lexical).
	let enabled = deps.enabled ?? resolveEmbedClientOptions(env).enabled;

	let started = false;
	// True once the daemon lifecycle has called `start()` at least once. Unlike `started` (which
	// `stop()` clears), this is sticky — so `setEnabled` can distinguish a PRE-start boot reconciliation
	// (just record the desired state; let `start()` spawn within the lifecycle) from a live re-enable
	// AFTER the lifecycle is up (spawn now). Prevents spawning embeddings outside the service lifecycle.
	let lifecycleStarted = false;
	let stopping = false;
	let child: EmbedChild | null = null;
	let live = false;
	let warm = false;
	let restarts = 0;
	// True when the child's background warmup THREW (observed via `/health.warmFailed`): the daemon is
	// live but can never serve. Sticky until a deliberate re-enable/restart re-arms a fresh warmup.
	let warmFailed = false;
	// True once the bounded crash-restart budget is exhausted (the child never came live). Sticky until a
	// deliberate re-enable/restart resets the restart count. Together with `warmFailed` → the `failed` state.
	let restartExhausted = false;
	// The in-flight background warmup wait, so stop() can let it settle.
	let warmWatch: Promise<void> | null = null;
	// ISS-007: true while a previously-warm child has ONE unanswered liveness probe (the `suspect`
	// state — a confirming re-probe decides warm-again vs wedged). Cleared on every fresh spawn.
	let suspect = false;
	// ISS-007 non-reentrancy guard: at most ONE liveness probe (periodic OR on-demand) in flight.
	let probing = false;
	// ISS-007: the cancel for the currently-scheduled periodic probe tick (null when none pending).
	let cancelScheduledProbe: (() => void) | null = null;

	/** Cancel any pending periodic liveness tick (stop/restart/crash/disable paths). */
	function cancelLiveness(): void {
		if (cancelScheduledProbe !== null) {
			cancelScheduledProbe();
			cancelScheduledProbe = null;
		}
		suspect = false;
	}

	/** Schedule the NEXT periodic liveness probe for `current` (one pending tick at a time). */
	function scheduleNextProbe(current: EmbedChild): void {
		cancelScheduledProbe?.();
		cancelScheduledProbe = scheduleProbe(() => {
			cancelScheduledProbe = null;
			void probeOnce(current);
		}, cfg.livenessIntervalMs);
	}

	/**
	 * ISS-007: ONE bounded liveness check of a warm child (periodic tick or on-demand). States:
	 * a healthy reply keeps/returns `warm`; the FIRST failure → `suspect` (recall skips the embed;
	 * no flap on one slow reply) + a confirming re-probe after `livenessRetryMs`; a SECOND
	 * consecutive failure CONFIRMS the wedge → mark not-warm, kill the wedged child, and respawn
	 * via the EXISTING bounded crash-restart machinery (the respawn transitions back through
	 * `warming`, covering the ~40s post-respawn warmup tail without flapping). NON-REENTRANT:
	 * overlapping periodic/on-demand calls coalesce into the one in-flight probe. Never throws.
	 */
	async function probeOnce(current: EmbedChild): Promise<void> {
		if (probing) return; // non-reentrant: one probe in flight, overlapping calls coalesce.
		probing = true;
		try {
			if (stopping || child !== current || !warm) return;
			const first = await probeHealth();
			if (stopping || child !== current) return;
			if (first.ok) {
				suspect = false;
				scheduleNextProbe(current);
				return;
			}
			// First miss on a warm child → suspect. Recall's gate skips the embed from here on.
			suspect = true;
			logger.event("embed.suspect", { pid: current.pid });
			await clock.sleep(cfg.livenessRetryMs);
			if (stopping || child !== current) return;
			const second = await probeHealth();
			if (stopping || child !== current) return;
			if (second.ok) {
				// Transient (e.g. one slow reply under load) — recovered, no flap, keep probing.
				suspect = false;
				logger.event("embed.recovered", { pid: current.pid });
				scheduleNextProbe(current);
				return;
			}
			// Two consecutive misses CONFIRM the wedge (accepts TCP / never replies). Mark not-warm
			// so /health stops reporting "on" and recall skips embeds IMMEDIATELY, then kill + respawn
			// through the EXISTING bounded machinery (D-6) — the fresh child re-warms through `warming`.
			suspect = false;
			live = false;
			warm = false;
			logger.event("embed.wedged", { pid: current.pid });
			child = null; // detach FIRST so the SIGTERM-driven exit callback does not double-restart.
			try {
				current.kill("SIGTERM");
			} catch {
				// already gone — the respawn below still runs.
			}
			void handleCrash();
		} finally {
			probing = false;
		}
	}

	/** Poll `/health` until the listener answers (liveness) or the budget is exhausted. */
	async function waitForLive(): Promise<boolean> {
		const deadline = clock.now() + cfg.liveTimeoutMs;
		while (clock.now() < deadline && !stopping) {
			const { ok } = await probeHealth();
			if (ok) return true;
			await clock.sleep(cfg.pollIntervalMs);
		}
		return false;
	}

	/**
	 * Poll `/health.ready` until the model is warm or the warm budget is exhausted.
	 * Runs in the BACKGROUND (D-3) — never awaited on the daemon-start path, so the
	 * first user recall is not blocked on a cold model; until warm, recall is lexical.
	 */
	async function waitForWarm(): Promise<void> {
		const deadline = clock.now() + cfg.warmTimeoutMs;
		while (clock.now() < deadline && !stopping) {
			const { ok, ready, warmFailed: probeWarmFailed } = await probeHealth();
			if (ok && ready) {
				warm = true;
				warmFailed = false;
				logger.event("embed.warm", { pid: child?.pid });
				// ISS-007: warm reached — ARM the periodic liveness probe (the one-shot warm latch was
				// the blind spot: a later wedge kept reporting warm forever). Armed ONLY here, after
				// warm, so the ~40s warmup tail is never probed as if it were a wedge (no flap).
				if (child !== null && !stopping) scheduleNextProbe(child);
				return;
			}
			// The child's warmup threw (deps/model/download). It is live but can never serve — stop polling
			// (it will not recover on its own) and mark `failed` so `/health` reports it honestly, not an
			// indefinite `warming`. Recall stays lexical (D-4). A deliberate restart re-arms a fresh warmup.
			if (ok && probeWarmFailed) {
				warmFailed = true;
				logger.event("embed.warm_failed", { pid: child?.pid });
				return;
			}
			await clock.sleep(cfg.pollIntervalMs);
		}
		// Warm budget exhausted: leave `warm:false`. Recall stays lexical (D-4) — never a hang.
		if (!warm && !stopping) logger.event("embed.warm_timeout", { pid: child?.pid });
	}

	/** Spawn one child, wire its crash handler, and wait for liveness; warm in the background. */
	async function spawnAndWatch(): Promise<void> {
		// A fresh child re-attempts warmup, so clear any prior warm-failure before it comes up.
		warmFailed = false;
		// ISS-007: a fresh child starts un-suspected with no stale periodic tick pending.
		cancelLiveness();
		// Hold a LOCAL reference: a concurrent stop()/restart() may null the shared `child`
		// field while we await liveness, so every read below uses `current`, never `child`.
		const current = spawnChild();
		child = current;
		const pid = current.pid;
		logger.event("embed.spawned", { pid });
		current.onExit((code, signal) => {
			// The child exited. If it was a deliberate stop/restart (the shared `child` no longer
			// points at THIS instance) the caller handles respawn; otherwise this is a crash →
			// bounded restart (D-6).
			if (stopping || child !== current) return;
			live = false;
			warm = false;
			cancelLiveness(); // ISS-007: a crashed child needs no further liveness ticks.
			logger.event("embed.exited", { code, signal, pid });
			void handleCrash();
		});

		const isLive = await waitForLive();
		// If a stop()/restart() swapped the child out from under us while we waited, bail —
		// the newer spawn owns liveness now.
		if (child !== current) return;
		live = isLive;
		if (!isLive) {
			// Never came up. Treat as a crash so the bounded-restart policy applies — a
			// never-starting child leaves recall degrading (lexical), never hanging.
			logger.event("embed.never_live", { pid });
			void handleCrash();
			return;
		}
		logger.event("embed.live", { pid });
		// D-3: warm OFF the turn path — kick the warm wait in the background, do NOT await it
		// on the start path. Recall degrades to lexical until this resolves `warm:true`.
		warmWatch = waitForWarm();
	}

	/** Bounded crash-restart (D-6): respawn with backoff until the bound is exhausted. */
	async function handleCrash(): Promise<void> {
		if (stopping) return;
		if (restarts >= cfg.maxRestarts) {
			// Crash loop bound hit: stop retrying. Recall stays lexical (degraded) — the host
			// daemon is never wedged and no turn is ever blocked (D-4). Mark `restartExhausted` so
			// `/health` reports embeddings `failed` (the child never came live) instead of `warming`.
			restartExhausted = true;
			logger.event("embed.restart_exhausted", { restarts });
			child = null;
			return;
		}
		restarts += 1;
		logger.event("embed.restart", { attempt: restarts, backoffMs: cfg.restartBackoffMs });
		await clock.sleep(cfg.restartBackoffMs);
		if (stopping) return;
		await spawnAndWatch();
	}

	const api: EmbedSupervisor = {
		get live(): boolean {
			return live;
		},
		get warm(): boolean {
			return warm;
		},
		get disabled(): boolean {
			return !enabled;
		},
		get failed(): boolean {
			// Enabled but unusable: warmup threw, or the crash-restart budget was exhausted. Never
			// `failed` while disabled (that is `off`) or while a live child is still warming (that is
			// `warming`). Once warm, `warmFailed` is cleared, so a warmed child is never `failed`.
			return enabled && !stopping && (warmFailed || restartExhausted);
		},
		get suspect(): boolean {
			// Only meaningful on a warm-but-unconfirmed child; never suspect while disabled/stopped.
			return enabled && !stopping && warm && suspect;
		},
		get state(): EmbedLivenessState {
			// ISS-007: the coarse liveness state the recall gate + /health read. Order matters:
			// disabled wins (off is not a failure), then the terminal failure signals, then the
			// warm/suspect pair, else the child is coming up / re-warming (`warming` — the state
			// that absorbs the ~40s post-respawn tail without flapping a binary probe).
			if (!enabled) return "off";
			if (warmFailed || restartExhausted) return "failed";
			if (warm) return suspect ? "suspect" : "warm";
			return "warming";
		},
		get restarts(): number {
			return restarts;
		},

		checkNow(): void {
			// ISS-007 on-demand check (recall observed an embed timeout): fire one bounded probe now.
			// probeOnce is non-reentrant + no-ops unless the child is currently considered warm, so
			// this is safe to call from the hot path — fire-and-forget, never a throw, never a wait.
			const current = child;
			if (current === null || stopping || !warm) return;
			void probeOnce(current);
		},

		async start(): Promise<void> {
			lifecycleStarted = true; // the service lifecycle is now up (sticky; stop() does not clear it)
			if (started) return; // idempotent
			started = true;
			if (!enabled) {
				// D-1 opt-out: inert. Never spawn; recall is cleanly lexical.
				logger.event("embed.disabled");
				return;
			}
			// A deliberate start re-arms the failure signals (a prior run may have exhausted restarts).
			restartExhausted = false;
			stopping = false;
			await spawnAndWatch();
		},

		async stop(): Promise<void> {
			if (!started) return; // idempotent
			stopping = true;
			started = false;
			cancelLiveness(); // ISS-007: no periodic tick may outlive the lifecycle.
			const current = child;
			child = null;
			if (current !== null) {
				try {
					current.kill("SIGTERM");
				} catch {
					// A missing/already-dead child on shutdown is fine.
				}
			}
			// Let any in-flight background warm wait observe `stopping` and settle.
			if (warmWatch !== null) {
				try {
					await warmWatch;
				} catch {
					// warm wait never throws, but guard anyway.
				}
				warmWatch = null;
			}
			live = false;
			warm = false;
		},

		async restart(): Promise<void> {
			// The AC-5 live toggle: deliberate kill → respawn. Reset the bounded count so a
			// restart after a crash-loop-exhaustion brings semantic back.
			cancelLiveness(); // ISS-007: the old child's pending tick must not probe the new one.
			const current = child;
			child = null;
			if (current !== null) {
				try {
					current.kill("SIGTERM");
				} catch {
					/* already gone */
				}
			}
			live = false;
			warm = false;
			restarts = 0;
			// Reset the failure signals: a deliberate restart re-attempts warmup and re-arms the budget.
			restartExhausted = false;
			warmFailed = false;
			if (!enabled || stopping) return;
			logger.event("embed.manual_restart");
			await spawnAndWatch();
		},

		async setEnabled(want: boolean): Promise<void> {
			// The dashboard live toggle. Flip the runtime flag, then actuate the child to match:
			// enabling spawns (if the lifecycle is up and no child is running); disabling stops.
			enabled = want;
			if (want) {
				logger.event("embed.enabled");
				// PRE-start (boot reconciliation): only record the desired state — do NOT spawn outside
				// the service lifecycle; `start()` will honor `enabled` when the lifecycle comes up.
				if (!lifecycleStarted) return;
				// Lifecycle is up: spawn iff no child is currently running. `stop()` cleared `started`, so
				// reset it to false and route through `start()` (which re-arms `stopping` + spawns).
				if (child === null) {
					started = false;
					await api.start();
				}
			} else {
				logger.event("embed.disabled_live");
				// Stop only when there is something to stop (a running child) — never a no-op stop pre-start.
				if (child !== null) await api.stop();
			}
		},
	};
	return api;
}

/**
 * The no-op embed supervisor (the bootstrap default before assembly wires the real
 * one). `start`/`stop`/`restart` are inert; it reports itself disabled so a bare
 * `createDaemon` never spawns a child. The composition root swaps in the real
 * supervisor via `assembleDaemon`.
 */
export const noopEmbedSupervisor: EmbedSupervisor = {
	live: false,
	warm: false,
	disabled: true,
	failed: false,
	suspect: false,
	state: "off",
	restarts: 0,
	checkNow(): void {
		/* no-op stub — nothing to probe */
	},
	start(): void {
		/* no-op stub */
	},
	stop(): void {
		/* no-op stub */
	},
	async restart(): Promise<void> {
		/* no-op stub */
	},
	async setEnabled(): Promise<void> {
		/* no-op stub — the inert supervisor never spawns a child */
	},
};
