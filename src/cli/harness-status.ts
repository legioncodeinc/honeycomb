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
 * The CLI-tier implementation of the harness connect / status / repair surface - PRD-006c
 * (c-AC-1/4/5) + PRD-006d (d-AC-3/4/5).
 *
 * ── Tier decision (LOAD-BEARING, mirrors 006b's onDaemonUp seam) ──────────────────────────────
 * This lives in `src/cli` (Tier 4), the ONLY tier that may legally import the 006b reconcile
 * (`src/cli/harness-reconcile.ts`), the `claude plugin` runner + plugin name (`src/connectors`,
 * NON_DAEMON_ROOT), and the daemon-NON-storage agent detector
 * (`src/daemon/runtime/dashboard/harness-detect.ts`, `existsSync`-only). The daemon (Tier 2) CANNOT
 * import any of these, so the coherent status/trigger/repair surface is built HERE and injected onto
 * the deps as {@link import("../commands/harness-status.js").HarnessStatusRunner} by
 * `src/cli/runtime.ts` - exactly how 006b arms the reconcile from `onDaemonUp`. Hive shells the
 * `honeycomb harness <sub>` verbs that consume it; it never reaches a daemon endpoint for this data.
 *
 * ── Reuse, do not fork (c-AC / d-AC impl notes) ──────────────────────────────────────────────
 * `connect` and `repair` DELEGATE to the 006b reconcile's `reconcileOnce()` (the single wiring path
 * over the real connector composition) and map its exposed outcome to the renderable status; they add
 * NO second merge/wire logic. `status` is a read-only derivation over the same primitives the
 * reconcile uses (`detectInstalledHarnesses` + `isPluginEnabled`), never a wire.
 *
 * ── Fail-soft + bounded (c-AC-5 / d-AC-5) ────────────────────────────────────────────────────
 * Every method absorbs a throw to a clear status and returns; the reconcile already caps each wire
 * with its own timeout. So the onboarding step + dashboard card never hang and never dead-end.
 */

import { CLAUDE_PLUGIN_NAME, createClaudePluginRunner } from "../connectors/index.js";
import { detectInstalledHarnesses } from "../daemon/runtime/dashboard/harness-detect.js";
import type {
	ConnectSeamResult,
	ConnectStatus,
	HarnessConnectionState,
	HarnessStatusRunner,
	RepairResult,
} from "../commands/harness-status.js";
import {
	DEFAULT_RECONCILE_HARNESSES,
	type HarnessReconcileResult,
	type HarnessReconciler,
	type ReconcileOutcome,
} from "./harness-reconcile.js";

/**
 * Map a 006b {@link ReconcileOutcome} to the renderable 006c/006d {@link ConnectStatus} (c-AC-4).
 * `wired` and `already-enabled` both mean the plugin is enabled -> `connected` (c-AC-2); the
 * absent/error outcomes carry through verbatim. Exhaustive by a `never` default so a new outcome
 * variant is a compile error until mapped.
 */
export function mapOutcomeToConnectStatus(outcome: ReconcileOutcome): ConnectStatus {
	switch (outcome) {
		case "wired":
		case "already-enabled":
			return "connected";
		case "agent-absent":
			return "agent-absent";
		case "cli-absent":
			return "cli-absent";
		case "error":
			return "error";
		default: {
			const _never: never = outcome;
			return _never;
		}
	}
}

/** The injectable seams the runner probes through (all default to the REAL production impls). */
export interface HarnessStatusDeps {
	/** The harnesses to report/target, in order. Defaults to {@link DEFAULT_RECONCILE_HARNESSES}. */
	readonly harnesses?: readonly string[];
	/** The plugin name the enabled-check probes. Defaults to {@link CLAUDE_PLUGIN_NAME} (`honeycomb`). */
	readonly pluginName?: string;
	/** Agent-presence resolver. Defaults to {@link detectInstalledHarnesses} (existsSync-only, fail-soft). */
	readonly detectAgents?: () => Set<string>;
	/** True iff the named plugin is enabled for `harness`. Defaults to the real `claude plugin list` parse. */
	readonly isPluginEnabled?: (harness: string, name: string) => boolean;
}

/**
 * Run ONE reconcile pass (the 006b single wiring path) and resolve the result for `target`, falling
 * back to the reconciler's last-outcome, else a synthesized `error` result. Absorbs any throw to an
 * `error` result so callers never see a rejection (c-AC-5 / d-AC-5).
 */
async function reconcileTarget(reconcile: HarnessReconciler, target: string): Promise<HarnessReconcileResult> {
	try {
		const results = await reconcile.reconcileOnce();
		const found = results.find((r) => r.harness === target) ?? reconcile.lastOutcome(target);
		if (found !== undefined) return found;
		return {
			harness: target,
			outcome: "error",
			at: new Date().toISOString(),
			detail: `no reconcile result for ${target}`,
		};
	} catch (err) {
		const detail = err instanceof Error ? err.message : "reconcile failed";
		return { harness: target, outcome: "error", at: new Date().toISOString(), detail };
	}
}

/** c-AC-1/c-AC-4: run one reconcile pass for `target` and render its outcome as a connect result. */
async function runConnect(reconcile: HarnessReconciler, target: string): Promise<ConnectSeamResult> {
	const r = await reconcileTarget(reconcile, target);
	const status = mapOutcomeToConnectStatus(r.outcome);
	return r.detail !== undefined ? { harness: r.harness, status, detail: r.detail } : { harness: r.harness, status };
}

/**
 * d-AC-3: re-run the reconcile for the requested (or default) harness and render an updated repair
 * result, including the derived `connected` boolean `harness-status.js`'s callers key off of.
 */
async function runRepair(
	reconcile: HarnessReconciler,
	defaultTarget: string,
	harness: string | undefined,
): Promise<RepairResult> {
	const target = harness ?? defaultTarget;
	const r = await reconcileTarget(reconcile, target);
	const status = mapOutcomeToConnectStatus(r.outcome);
	const connected = status === "connected";
	return r.detail !== undefined
		? { harness: r.harness, status, connected, detail: r.detail }
		: { harness: r.harness, status, connected };
}

/** d-AC-4: fail-soft resolve the installed-agent set once per `status()` call. */
function resolveAgentsFailSoft(detectAgents: () => Set<string>): Set<string> {
	try {
		return detectAgents();
	} catch {
		return new Set<string>();
	}
}

/**
 * d-AC-4: derive one harness's read-only connection state - agent-present, plugin-enabled (DERIVED
 * from `isPluginEnabled`, fail-soft false when claude is absent or the probe throws - never stored
 * Deeplake state, no secret/path involved), and the reconciler's last recorded outcome.
 */
function deriveHarnessState(
	harness: string,
	agents: Set<string>,
	pluginName: string,
	isPluginEnabled: (harness: string, name: string) => boolean,
	reconcile: HarnessReconciler,
): HarnessConnectionState {
	const agentPresent = agents.has(harness);
	let pluginEnabled = false;
	try {
		pluginEnabled = isPluginEnabled(harness, pluginName);
	} catch {
		pluginEnabled = false;
	}
	const last = reconcile.lastOutcome(harness);
	const base = { harness, agentPresent, pluginEnabled, connected: pluginEnabled } as const;
	return last === undefined ? base : { ...base, lastOutcome: last.outcome, lastOutcomeAt: last.at };
}

/** d-AC-4: derive the read-only connection state for every configured harness. Never triggers a wire. */
async function runStatus(
	harnesses: readonly string[],
	detectAgents: () => Set<string>,
	pluginName: string,
	isPluginEnabled: (harness: string, name: string) => boolean,
	reconcile: HarnessReconciler,
): Promise<readonly HarnessConnectionState[]> {
	const agents = resolveAgentsFailSoft(detectAgents);
	return harnesses.map((h) => deriveHarnessState(h, agents, pluginName, isPluginEnabled, reconcile));
}

/**
 * Build the {@link HarnessStatusRunner} over the 006b reconcile. `connect`/`repair` reuse
 * `reconcile.reconcileOnce()` (the single wiring path); `status` derives per-harness agent-present +
 * plugin-enabled + last outcome read-only. Every method is fail-soft. Defaults are the real production
 * seams; a unit test injects fakes so no real `claude` binary or home dir is touched.
 */
export function buildHarnessStatusRunner(
	reconcile: HarnessReconciler,
	deps: HarnessStatusDeps = {},
): HarnessStatusRunner {
	const harnesses = deps.harnesses ?? DEFAULT_RECONCILE_HARNESSES;
	const pluginName = deps.pluginName ?? CLAUDE_PLUGIN_NAME;
	const detectAgents = deps.detectAgents ?? ((): Set<string> => detectInstalledHarnesses());
	// Default the enabled-check to ONE shared claude plugin runner (matches the reconciler's default).
	const runner = deps.isPluginEnabled === undefined ? createClaudePluginRunner() : undefined;
	const isPluginEnabled =
		deps.isPluginEnabled ?? ((_harness: string, name: string): boolean => runner?.isPluginEnabled(name) ?? false);

	const defaultTarget = harnesses[0] ?? "claude-code";

	return {
		connect: (): Promise<ConnectSeamResult> => runConnect(reconcile, defaultTarget),
		repair: (harness?: string): Promise<RepairResult> => runRepair(reconcile, defaultTarget, harness),
		status: (): Promise<readonly HarnessConnectionState[]> =>
			runStatus(harnesses, detectAgents, pluginName, isPluginEnabled, reconcile),
	};
}
