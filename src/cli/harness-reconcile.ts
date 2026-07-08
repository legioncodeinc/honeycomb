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
 * Self-healing harness auto-wire reconcile - PRD-006b (b-AC-1..b-AC-7).
 *
 * ── What it does ─────────────────────────────────────────────────────────────
 * An idempotent, fail-soft reconcile that wires any supported harness whose AGENT
 * is present but whose PLUGIN is not yet enabled, by DELEGATING to the 019a
 * connector through 020d's {@link createAutoWiring}. It reuses (never forks) the
 * pieces that already exist:
 *   - agent presence  -> `detectInstalledHarnesses` (`src/daemon/runtime/dashboard/harness-detect.ts`)
 *   - plugin-enabled  -> the `claude plugin list` parse behind `PluginCommandRunner.isPluginEnabled`
 *   - delegation seam -> `createAutoWiring({ connector }).wire()` over the REAL connector composition
 *                        (`createConnectorRegistry` -> `ClaudeCodeConnector`, `src/cli/connector-runner.ts`)
 *
 * Gate order is the cheap path (PRD-006b impl note): `isPluginEnabled('honeycomb')`
 * first (short-circuit no-op), then `available()`, then the agent-present check,
 * then `wire()`. Steady state is one cheap probe per cycle - no repeated
 * `claude plugin install`.
 *
 * ── Host + tier decision (LOAD-BEARING, per AGENTS.md build-tier invariant) ──
 * The daemon is Tier 2 and MUST NOT import upward. The connector composition
 * (`buildConnectorRunner`/`createConnectorRegistry`) lives in `src/cli` (Tier 4)
 * and `src/connectors` (a NON_DAEMON_ROOT), and `createAutoWiring` lives in
 * `src/notifications` (also a NON_DAEMON_ROOT). So the reconcile CANNOT live in
 * the daemon runtime: importing the connector composition into `src/daemon` would
 * both violate the tier order and create a `cli <-> daemon` import cycle, and
 * injecting it as a daemon service would require editing the contention seams
 * (`src/daemon/runtime/server.ts`, `services/types.ts`) that `runtime/CONVENTIONS.md`
 * forbids touching.
 *
 * THEREFORE this module lives in `src/cli` (Tier 4), the tier that MAY legally
 * import the connector composition. It reaches `detectInstalledHarnesses` through
 * the same Tier-4 -> daemon-NON-storage path `src/cli/runtime.ts` already uses for
 * `auth`/`config` (the DeepLake-confinement invariant only bans `daemon/storage`,
 * which this module never imports). It is triggered on daemon-start from
 * `src/cli/runtime.ts` (`buildDaemonLifecycle`'s `onDaemonUp` seam) and arms a
 * recurring, unref'd cadence - both entirely OUT of the daemon's loopback request
 * path, so a slow `claude plugin` shell never affects loopback latency.
 *
 * ── Last-outcome status (b-AC-7) ─────────────────────────────────────────────
 * The reconcile records a per-harness last outcome
 * (`wired`/`already-enabled`/`agent-absent`/`cli-absent`/`error`) in process-local
 * memory (no Deeplake, no sidecar file) that 006c (onboarding) and 006d (dashboard
 * card) read. Bookkeeping is daemon-local status per FR-8, never persisted.
 */

import { detectInstalledHarnesses } from "../daemon/runtime/dashboard/harness-detect.js";
import { CLAUDE_PLUGIN_NAME, createClaudePluginRunner, createNodeConnectorFs } from "../connectors/index.js";
import type { AutoWiring } from "../notifications/contracts.js";
import { createAutoWiring } from "../notifications/auto-wiring.js";
import { createConnectorRegistry } from "./connector-runner.js";

/**
 * The last outcome of a single harness's reconcile pass (b-AC-7). Stable string
 * union 006c/006d render:
 *   - `wired`          - the plugin was not enabled, the agent + CLI were present, and `wire()` ran.
 *   - `already-enabled`- the plugin was already enabled; a cheap no-op (b-AC-3).
 *   - `agent-absent`   - the harness agent is not installed on this box (b-AC-4).
 *   - `cli-absent`     - the harness CLI is not on PATH; nothing to register (b-AC-4).
 *   - `error`          - a probe or `wire()` threw / timed out; absorbed fail-soft (b-AC-6).
 */
export type ReconcileOutcome = "wired" | "already-enabled" | "agent-absent" | "cli-absent" | "error";

/** One harness's reconcile result - the shape 006c/006d read (b-AC-7). */
export interface HarnessReconcileResult {
	/** The canonical harness id (e.g. `claude-code`). */
	readonly harness: string;
	/** The last outcome for this harness. */
	readonly outcome: ReconcileOutcome;
	/** ISO timestamp the outcome was recorded. */
	readonly at: string;
	/** A short, non-secret detail (e.g. an error message). Never a token or config value. */
	readonly detail?: string;
}

/**
 * The reconciler surface. `reconcileOnce` runs one pass across the configured
 * harnesses; `start`/`stop` own the recurring cadence; `lastOutcome`/`lastOutcomes`
 * expose the status for 006c/006d (b-AC-7).
 */
export interface HarnessReconciler {
	/** Run one reconcile pass across all configured harnesses; returns each harness's result. */
	reconcileOnce(): Promise<readonly HarnessReconcileResult[]>;
	/**
	 * Fire an immediate reconcile (fail-soft, fire-and-forget) and arm the recurring cadence
	 * (b-AC-1 / b-AC-2). Idempotent: a second `start()` while the cadence is live is a no-op.
	 */
	start(): void;
	/** Clear the recurring cadence timer. Idempotent. */
	stop(): void;
	/** The last recorded result for one harness, or `undefined` if it has not run yet (b-AC-7). */
	lastOutcome(harness: string): HarnessReconcileResult | undefined;
	/** Every harness's last recorded result, in configuration order (b-AC-7). */
	lastOutcomes(): readonly HarnessReconcileResult[];
}

/** The supported harnesses, first cut scoped to claude-code (codex/cursor slot in later, b-AC / impl note). */
export const DEFAULT_RECONCILE_HARNESSES: readonly string[] = ["claude-code"];

/** Default recurring cadence: reconcile every 5 minutes (periodic, out of the request path). */
export const DEFAULT_RECONCILE_INTERVAL_MS = 300_000;

/**
 * Default belt-and-suspenders timeout for a single `wire()` (b-AC-6). The connector's own
 * `spawnSync` already caps each `claude` shell at 120s; this bounds a hung async delegation just
 * above that so a wedged wire never blocks a reconcile cycle forever.
 */
export const DEFAULT_RECONCILE_WIRE_TIMEOUT_MS = 130_000;

/** A minimal interval handle so the cadence works under both `node:timers` and vitest fake timers. */
interface IntervalHandle {
	unref?: () => void;
}

/** The injectable seams the reconciler runs against (all default to the REAL production impls). */
export interface HarnessReconcileDeps {
	/** The harnesses to reconcile, in order. Defaults to {@link DEFAULT_RECONCILE_HARNESSES}. */
	readonly harnesses?: readonly string[];
	/** The plugin name the enabled-check probes. Defaults to {@link CLAUDE_PLUGIN_NAME} (`honeycomb`). */
	readonly pluginName?: string;
	/** Agent-presence resolver. Defaults to {@link detectInstalledHarnesses} (existsSync-only, fail-soft). */
	readonly detectAgents?: () => Set<string>;
	/** True iff the named plugin is installed AND enabled for `harness`. Defaults to the real `claude plugin list` parse. */
	readonly isPluginEnabled?: (harness: string, name: string) => boolean;
	/** True iff the harness CLI is resolvable on PATH. Defaults to the real `claude --version` probe. */
	readonly cliAvailable?: (harness: string) => boolean;
	/** Build the delegation seam for `harness`. Defaults to {@link buildConnectorWiring} (real composition). */
	readonly buildWiring?: (harness: string) => AutoWiring | undefined;
	/** The recurring cadence in ms. Defaults to {@link DEFAULT_RECONCILE_INTERVAL_MS}. */
	readonly intervalMs?: number;
	/** Per-`wire()` timeout budget in ms (b-AC-6). Defaults to {@link DEFAULT_RECONCILE_WIRE_TIMEOUT_MS}. */
	readonly wireTimeoutMs?: number;
	/** Clock seam for the recorded timestamps. Defaults to `() => new Date()`. */
	readonly now?: () => Date;
	/** A fail-soft log sink for absorbed errors (never throws). Defaults to a no-op (the daemon must stay silent). */
	readonly onError?: (line: string) => void;
}

/**
 * Build the delegation seam for one harness over the REAL connector composition (b-AC-5): the same
 * `createConnectorRegistry` -> `ClaudeCodeConnector` the CLI's `setup`/`connect` verbs use, wrapped
 * in 020d's {@link createAutoWiring}. NO forked merge logic - `wire()` runs the connector's own
 * idempotent, foreign-preserving `install()`. Returns `undefined` for an unknown harness (the
 * registry has no builder), which the reconciler treats as an `error` outcome.
 */
export function buildConnectorWiring(harness: string, home?: string): AutoWiring | undefined {
	const registry = home !== undefined ? createConnectorRegistry(home) : createConnectorRegistry();
	const connector = registry.build(harness, createNodeConnectorFs());
	if (connector === undefined) return undefined;
	return createAutoWiring({ connector });
}

/**
 * Race a `wire()` against a timeout (b-AC-6). A wire that never settles rejects after `ms` so the
 * reconciler records `error` rather than hanging the cadence. The timer is unref'd + cleared so it
 * never keeps the process alive nor leaks.
 */
async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => reject(new Error(`reconcile wire() timed out after ${ms}ms`)), ms);
		if (timer !== undefined && typeof timer.unref === "function") timer.unref();
	});
	try {
		return await Promise.race([work, timeout]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
	}
}

/**
 * Build the self-healing harness auto-wire reconciler (PRD-006b). Every external effect is behind an
 * injectable seam so a unit test drives every AC branch without a real `claude` binary; the defaults
 * are the real production impls (agent detect + `claude plugin` runner + real connector composition +
 * `createAutoWiring`).
 */
export function createHarnessReconciler(deps: HarnessReconcileDeps = {}): HarnessReconciler {
	const harnesses = deps.harnesses ?? DEFAULT_RECONCILE_HARNESSES;
	const pluginName = deps.pluginName ?? CLAUDE_PLUGIN_NAME;
	const detectAgents = deps.detectAgents ?? ((): Set<string> => detectInstalledHarnesses());
	const intervalMs = deps.intervalMs ?? DEFAULT_RECONCILE_INTERVAL_MS;
	const wireTimeoutMs = deps.wireTimeoutMs ?? DEFAULT_RECONCILE_WIRE_TIMEOUT_MS;
	const now = deps.now ?? ((): Date => new Date());
	const onError = deps.onError ?? ((): void => {});

	// The gate + wiring seams default to ONE shared claude plugin runner (so `available()` and
	// `isPluginEnabled()` agree) and the real connector composition for `wire()`.
	const runner = createClaudePluginRunner();
	const isPluginEnabled =
		deps.isPluginEnabled ?? ((_harness: string, name: string): boolean => runner.isPluginEnabled(name));
	const cliAvailable = deps.cliAvailable ?? ((_harness: string): boolean => runner.available());
	const buildWiring = deps.buildWiring ?? ((harness: string): AutoWiring | undefined => buildConnectorWiring(harness));

	// Process-local last-outcome status (b-AC-7). No Deeplake, no sidecar file (FR-8).
	const last = new Map<string, HarnessReconcileResult>();
	let timer: IntervalHandle | undefined;

	function record(harness: string, outcome: ReconcileOutcome, detail?: string): HarnessReconcileResult {
		const result: HarnessReconcileResult =
			detail !== undefined
				? { harness, outcome, at: now().toISOString(), detail }
				: { harness, outcome, at: now().toISOString() };
		last.set(harness, result);
		return result;
	}

	/** Reconcile ONE harness through the gate order, absorbing any throw/timeout to `error` (b-AC-6). */
	async function reconcileHarness(harness: string, agents: Set<string>): Promise<HarnessReconcileResult> {
		try {
			// Gate 1 (cheapest, b-AC-3): plugin already enabled -> no-op, never `claude plugin install`.
			if (isPluginEnabled(harness, pluginName)) return record(harness, "already-enabled");
			// Gate 2 (b-AC-4): the harness CLI must be on PATH to register anything.
			if (!cliAvailable(harness)) return record(harness, "cli-absent");
			// Gate 3 (b-AC-1 / b-AC-4): the agent must be present - the "should we consider wiring?" gate.
			if (!agents.has(harness)) return record(harness, "agent-absent");
			// Wire via the delegation seam (b-AC-5): the connector's own idempotent `install()`.
			const wiring = buildWiring(harness);
			if (wiring === undefined) return record(harness, "error", `no connector for harness ${harness}`);
			await withTimeout(wiring.wire(), wireTimeoutMs);
			return record(harness, "wired");
		} catch (err) {
			// b-AC-6: a throw or timeout is absorbed to a fail-soft status; never re-thrown.
			const reason = err instanceof Error ? err.message : "reconcile failed";
			onError(`harness-reconcile: ${harness} reconcile error: ${reason}`);
			return record(harness, "error", reason);
		}
	}

	async function reconcileOnce(): Promise<readonly HarnessReconcileResult[]> {
		// Resolve agent presence ONCE per pass (a single existsSync sweep), fail-soft to an empty set.
		let agents: Set<string>;
		try {
			agents = detectAgents();
		} catch (err) {
			const reason = err instanceof Error ? err.message : "detect failed";
			onError(`harness-reconcile: agent detection error: ${reason}`);
			agents = new Set<string>();
		}
		const results: HarnessReconcileResult[] = [];
		for (const harness of harnesses) {
			results.push(await reconcileHarness(harness, agents));
		}
		return results;
	}

	return {
		reconcileOnce,
		start(): void {
			// Fire an immediate pass (b-AC-1), fire-and-forget + fail-soft so it never blocks the caller
			// nor the daemon-start path. Any rejection is absorbed (reconcileOnce is already fail-soft).
			void reconcileOnce().catch((err: unknown) => {
				const reason = err instanceof Error ? err.message : "reconcile failed";
				onError(`harness-reconcile: start pass error: ${reason}`);
			});
			// Arm the recurring cadence (b-AC-2). Idempotent: a live timer is left in place.
			if (timer !== undefined) return;
			const handle = setInterval((): void => {
				void reconcileOnce().catch((err: unknown) => {
					const reason = err instanceof Error ? err.message : "reconcile failed";
					onError(`harness-reconcile: cadence pass error: ${reason}`);
				});
			}, intervalMs);
			// Never keep a short-lived CLI alive purely for the cadence.
			if (typeof handle.unref === "function") handle.unref();
			timer = handle;
		},
		stop(): void {
			if (timer !== undefined) {
				clearInterval(timer as unknown as ReturnType<typeof setInterval>);
				timer = undefined;
			}
		},
		lastOutcome(harness: string): HarnessReconcileResult | undefined {
			return last.get(harness);
		},
		lastOutcomes(): readonly HarnessReconcileResult[] {
			return harnesses.map((h) => last.get(h)).filter((r): r is HarnessReconcileResult => r !== undefined);
		},
	};
}
