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
	 * Probe the embed daemon's `/health` once. Returns `{ ok, ready }`: `ok` = the
	 * listener answered (liveness), `ready` = the model finished warming (D-3).
	 * Defaults to a loopback `fetch` of `<url>/health`. A test scripts the sequence.
	 */
	readonly probeHealth?: () => Promise<{ ok: boolean; ready: boolean }>;
	/** Optional structured-log sink. */
	readonly logger?: EmbedSupervisorLogger;
	/** Optional injected clock (real timers otherwise). */
	readonly clock?: EmbedSupervisorClock;
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
}

/** Resolved supervisor config. */
interface ResolvedConfig {
	readonly maxRestarts: number;
	readonly restartBackoffMs: number;
	readonly liveTimeoutMs: number;
	readonly pollIntervalMs: number;
	readonly warmTimeoutMs: number;
}

function resolveConfig(c: EmbedSupervisorConfig | undefined): ResolvedConfig {
	return {
		maxRestarts: c?.maxRestarts ?? 5,
		restartBackoffMs: c?.restartBackoffMs ?? 1_000,
		liveTimeoutMs: c?.liveTimeoutMs ?? 10_000,
		pollIntervalMs: c?.pollIntervalMs ?? 250,
		warmTimeoutMs: c?.warmTimeoutMs ?? 120_000,
	};
}

/** The default real clock. */
const defaultClock: EmbedSupervisorClock = {
	sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
	now: () => Date.now(),
};

/**
 * Resolve the bundled `embeddings/embed-daemon.js` the supervisor spawns. From this
 * module's location, walk up to the package root then into `embeddings/`. An env
 * override (`HONEYCOMB_EMBED_ENTRY`) covers the dev/tsc layout + tests.
 */
function resolveEmbedEntry(env: NodeJS.ProcessEnv): string {
	const override = env.HONEYCOMB_EMBED_ENTRY;
	if (override !== undefined && override.length > 0) return override;
	const here = dirname(fileURLToPath(import.meta.url));
	// Bundled: `<root>/daemon/index.js` imports this transitively; the embed daemon is
	// `<root>/embeddings/embed-daemon.js`. The dev tsc layout is `<root>/dist/src/daemon/runtime/services`.
	// Prefer the bundled sibling; the env override handles the dev path in tests/itests.
	return resolve(here, "..", "..", "..", "..", "..", "embeddings", "embed-daemon.js");
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
function defaultProbeHealth(env: NodeJS.ProcessEnv): () => Promise<{ ok: boolean; ready: boolean }> {
	const { url } = resolveEmbedClientOptions(env);
	return async (): Promise<{ ok: boolean; ready: boolean }> => {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 2_000);
		try {
			const res = await fetch(`${url}/health`, { signal: controller.signal });
			if (!res.ok) return { ok: false, ready: false };
			const body = (await res.json()) as { ready?: unknown };
			return { ok: true, ready: body.ready === true };
		} catch {
			return { ok: false, ready: false };
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
	/** Current bounded restart count (for diagnostics). */
	readonly restarts: number;
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

	// D-1: an explicit `HONEYCOMB_EMBEDDINGS=false`/`0` makes the supervisor inert. The composition
	// root may OVERRIDE this with `deps.enabled` (the persisted `embeddings.enabled` vault setting), and
	// the dashboard `setEnabled` toggle flips it live afterward — so this is a MUTABLE runtime flag, not
	// a construction-time const. `enabled === false` ⇒ `disabled` (no child; recall is cleanly lexical).
	let enabled = deps.enabled ?? resolveEmbedClientOptions(env).enabled;

	let started = false;
	let stopping = false;
	let child: EmbedChild | null = null;
	let live = false;
	let warm = false;
	let restarts = 0;
	// The in-flight background warmup wait, so stop() can let it settle.
	let warmWatch: Promise<void> | null = null;

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
			const { ok, ready } = await probeHealth();
			if (ok && ready) {
				warm = true;
				logger.event("embed.warm", { pid: child?.pid });
				return;
			}
			await clock.sleep(cfg.pollIntervalMs);
		}
		// Warm budget exhausted: leave `warm:false`. Recall stays lexical (D-4) — never a hang.
		if (!warm && !stopping) logger.event("embed.warm_timeout", { pid: child?.pid });
	}

	/** Spawn one child, wire its crash handler, and wait for liveness; warm in the background. */
	async function spawnAndWatch(): Promise<void> {
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
			// daemon is never wedged and no turn is ever blocked (D-4).
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
		get restarts(): number {
			return restarts;
		},

		async start(): Promise<void> {
			if (started) return; // idempotent
			started = true;
			if (!enabled) {
				// D-1 opt-out: inert. Never spawn; recall is cleanly lexical.
				logger.event("embed.disabled");
				return;
			}
			stopping = false;
			await spawnAndWatch();
		},

		async stop(): Promise<void> {
			if (!started) return; // idempotent
			stopping = true;
			started = false;
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
			if (!enabled || stopping) return;
			logger.event("embed.manual_restart");
			await spawnAndWatch();
		},

		async setEnabled(want: boolean): Promise<void> {
			// The dashboard live toggle. Flip the runtime flag, then actuate the child to match:
			// enabling spawns (if not already running); disabling stops. Idempotent — a no-op when the
			// child already matches the desired state, so a double-click never double-spawns.
			enabled = want;
			if (want) {
				logger.event("embed.enabled");
				if (!started || child === null) {
					// Allow start() to proceed even if a prior stop() left `started` set, and clear any
					// `stopping` latch (start() resets it) so spawnAndWatch runs.
					started = false;
					await api.start();
				}
			} else {
				logger.event("embed.disabled_live");
				if (started || child !== null) await api.stop();
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
	restarts: 0,
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
