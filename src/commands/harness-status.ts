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
 * The coherent harness connect / status / repair surface - PRD-006c (c-AC-1/4/5) + PRD-006d
 * (d-AC-3/4/5), the honeycomb-SIDE seam the Hive onboarding step + dashboard card consume.
 *
 * ── Why this is a CLI-tier seam, not a daemon endpoint (LOAD-BEARING, tier invariant) ─────────
 * The status/trigger/repair surface derives from the 006b reconcile and `isPluginEnabled`, BOTH of
 * which live at Tier 4 (`src/cli` reconcile + `src/connectors`, NON_DAEMON_ROOTs). The daemon is
 * Tier 2 and MUST NOT import upward (AGENTS.md build-tier invariant), and the reconcile is inherently
 * CLI-process-scoped (it is armed from `src/cli/runtime.ts`'s `onDaemonUp` seam, not inside the
 * daemon). So the seam lives HERE, at the reconcile tier, exposed as `honeycomb harness <sub>`
 * verbs Hive SHELLS the same way it shells the onboarding seam - no Tier-2 -> Tier-4 import, no
 * daemon endpoint that would need to reach the connector it cannot legally import.
 *
 * This module is the THIN, tier-neutral half: the renderable contract ({@link ConnectStatus},
 * {@link HarnessConnectionState}) + the injected {@link HarnessStatusRunner} seam + the verb handler
 * that renders text/JSON. The REAL runner (which reads the reconcile + `isPluginEnabled` +
 * `detectInstalledHarnesses`) is built at the CLI tier in `src/cli/harness-status.ts` and injected on
 * the deps by `src/cli/runtime.ts`. `src/commands` stays a NON_DAEMON_ROOT: it imports no connector,
 * no reconcile, no DeepLake - only this contract.
 */

import type { CommandResult, OutputSink } from "./contracts.js";

/**
 * The renderable connect status the 006c onboarding step shows WITHOUT reimplementing detection or
 * wiring (c-AC-4). A stable union mapped from the 006b reconcile outcome:
 *   - `connected`    - the plugin is enabled (wired this pass OR already enabled): success (c-AC-2).
 *   - `agent-absent` - the harness agent is not installed; the one case automation cannot self-heal,
 *                      so the step shows "Install Claude Code, then Retry" (c-AC-3).
 *   - `cli-absent`   - the harness CLI is not on PATH; nothing to register yet.
 *   - `error`        - a probe or wire threw / timed out; absorbed fail-soft (c-AC-5).
 */
export type ConnectStatus = "connected" | "agent-absent" | "cli-absent" | "error";

/** The full set of renderable connect statuses, in a stable order (for hive rendering + tests). */
export const CONNECT_STATUSES: readonly ConnectStatus[] = Object.freeze([
	"connected",
	"agent-absent",
	"cli-absent",
	"error",
]);

/** The outcome of triggering the connect seam for one harness (c-AC-1/4/5). NO secret, NO path. */
export interface ConnectSeamResult {
	/** The canonical harness id the status is for (e.g. `claude-code`). */
	readonly harness: string;
	/** The renderable status hive shows (c-AC-4). */
	readonly status: ConnectStatus;
	/** A short, non-secret detail (e.g. an error message). Never a token, config value, or path. */
	readonly detail?: string;
}

/**
 * One harness's connection state for the 006d dashboard card (d-AC-1 shape at the CLI tier): agent
 * present? plugin enabled? plus the last 006b reconcile outcome. Read-only + derived (d-AC-4): NO
 * secret, NO path - only ids + booleans + a stable outcome string + an ISO timestamp.
 *
 * The two booleans (`agentPresent`, `pluginEnabled`) ARE the d-AC-1 data; `connected` is the derived
 * convenience (`connected === pluginEnabled`). We deliberately do NOT force a 4-value
 * {@link ConnectStatus} onto this read: "agent present but plugin not yet enabled" is a legitimate,
 * repairable state the 4-value onboarding vocabulary cannot honestly express, so the card renders the
 * booleans + offers Repair rather than mislabeling it. {@link ConnectStatus} is reserved for the
 * `connect`/`repair` triggers, which DO run a reconcile and resolve to one of the four.
 */
export interface HarnessConnectionState {
	/** The canonical harness id. */
	readonly harness: string;
	/** True iff the harness AGENT is installed on this box (existsSync marker only, fail-soft). */
	readonly agentPresent: boolean;
	/** True iff the honeycomb plugin is installed AND enabled (from `isPluginEnabled`, fail-soft false). */
	readonly pluginEnabled: boolean;
	/** Derived convenience: `pluginEnabled` (the card's "connected" column). */
	readonly connected: boolean;
	/** The last 006b reconcile outcome for this harness (`wired`/`already-enabled`/...), if any. */
	readonly lastOutcome?: string;
	/** ISO timestamp of the last reconcile outcome, if any. */
	readonly lastOutcomeAt?: string;
}

/** The outcome of a repair (Reconnect / Repair) trigger (d-AC-3/5). NO secret, NO path. */
export interface RepairResult {
	/** The canonical harness id the repair targeted. */
	readonly harness: string;
	/** The renderable status AFTER the repair pass (d-AC-3: the shown state updates). */
	readonly status: ConnectStatus;
	/** True iff the harness ended up connected (plugin enabled) after the repair. */
	readonly connected: boolean;
	/** A short, non-secret, plain-language detail - especially the "cannot complete" reason (d-AC-5). */
	readonly detail?: string;
}

/**
 * THE INJECTED SEAM (D-2 thin client). The real impl is built at the CLI tier
 * (`src/cli/harness-status.ts` -> `buildHarnessStatusRunner`) over the 006b reconcile +
 * `isPluginEnabled` + `detectInstalledHarnesses`; a test injects a fake. Every method is fail-soft
 * (never throws) and bounded (the reconcile caps each wire), so the onboarding step + dashboard card
 * NEVER hang or dead-end (c-AC-5 / d-AC-5).
 */
export interface HarnessStatusRunner {
	/**
	 * 006c (c-AC-1): trigger the 006b reconcile and return the renderable connect status for the
	 * target harness (default claude-code). Reuses the reconcile's exposed outcome (never re-wires
	 * a second path). Retry is the caller invoking this again after installing the agent (c-AC-3).
	 */
	connect(): Promise<ConnectSeamResult>;
	/**
	 * 006d: the per-harness connection report (agent present? plugin enabled? last outcome?) the
	 * dashboard card renders. Read-only + derived (d-AC-4); never spawns a wire.
	 */
	status(): Promise<readonly HarnessConnectionState[]>;
	/**
	 * 006d (d-AC-3): re-run the connector setup (the SAME 006b reconcile path) for `harness` (default
	 * claude-code) and return the updated status. A repair that cannot complete returns a clear
	 * `error`/`agent-absent`/`cli-absent` status with a plain-language detail, never a throw (d-AC-5).
	 */
	repair(harness?: string): Promise<RepairResult>;
}

/** Plain-language, non-secret one-liner for a connect status (shared by the text + hive copy). */
export function connectStatusLine(harness: string, status: ConnectStatus, detail?: string): string {
	switch (status) {
		case "connected":
			return `${harness}: connected (plugin enabled).`;
		case "agent-absent":
			return `${harness}: agent not installed - install it, then retry.`;
		case "cli-absent":
			return `${harness}: CLI not found on PATH - nothing to wire yet.`;
		case "error":
			return `${harness}: could not connect${detail !== undefined ? ` (${detail})` : ""} - retry.`;
		default: {
			// Exhaustiveness: a new ConnectStatus variant must be handled explicitly.
			const _never: never = status;
			return `${harness}: ${String(_never)}`;
		}
	}
}

/** Parse the subcommand (first non-flag word) + optional harness arg off a `harness` verb tail. */
function parseHarnessVerbArgs(argv: readonly string[]): { readonly sub: string; readonly harness?: string } {
	const positionals = argv.filter((a) => !a.startsWith("-"));
	const sub = positionals[0] ?? "status";
	const harness = positionals[1];
	return harness !== undefined ? { sub, harness } : { sub };
}

/** Emit a value as pretty JSON or fall through to a text renderer. */
function render(json: boolean, out: OutputSink, value: unknown, text: () => void): void {
	if (json) {
		out(JSON.stringify(value, null, 2));
		return;
	}
	text();
}

/**
 * Run `honeycomb harness <status|connect|repair> [<harness>] [--json]` (PRD-006c c-AC-1/4/5 +
 * PRD-006d d-AC-3/4/5). The ONE coherent surface Hive shells: onboarding calls `connect`, the
 * dashboard card calls `status` + `repair`. Delegates to the injected {@link HarnessStatusRunner}
 * (built at the CLI tier); when the seam is unbound (a degraded build / a plain handler test) it
 * reports that honestly and exits non-zero rather than throwing. NEVER hangs or dead-ends: every
 * path resolves to a clear line + a definite exit code (c-AC-5 / d-AC-5).
 */
export async function runHarnessVerb(
	argv: readonly string[],
	deps: { readonly harnessStatus?: HarnessStatusRunner; readonly out?: OutputSink },
	json: boolean,
): Promise<CommandResult> {
	const out: OutputSink = deps.out ?? ((line: string): void => console.log(line));
	if (deps.harnessStatus === undefined) {
		out("harness: the status surface is not wired in this build (deferred assembly).");
		return { exitCode: 1 };
	}
	const runner = deps.harnessStatus;
	const { sub, harness } = parseHarnessVerbArgs(argv);

	if (sub === "connect") {
		const result = await runner.connect();
		render(json, out, result, () => out(connectStatusLine(result.harness, result.status, result.detail)));
		// c-AC-5: onboarding never dead-ends - a non-connected state still exits 0 so the step can
		// proceed (or offer Retry); only a genuine error is a non-zero exit the caller can surface.
		return { exitCode: result.status === "error" ? 1 : 0 };
	}

	if (sub === "repair") {
		const result = await runner.repair(harness);
		render(json, out, result, () =>
			out(
				result.connected
					? `${result.harness}: repaired - connected.`
					: connectStatusLine(result.harness, result.status, result.detail),
			),
		);
		// d-AC-5: a repair that cannot complete never blocks - it exits 0 with a clear status so the
		// dashboard stays responsive; only a hard error exits non-zero.
		return { exitCode: result.status === "error" ? 1 : 0 };
	}

	// Default: `status` - the per-harness connection report the dashboard card renders.
	const states = await runner.status();
	render(json, out, { harnesses: states }, () => {
		for (const s of states) {
			out(
				`${s.harness}: agent ${s.agentPresent ? "present" : "absent"}, plugin ${
					s.pluginEnabled ? "enabled" : "not enabled"
				}${s.lastOutcome !== undefined ? ` [last: ${s.lastOutcome}]` : ""}.`,
			);
		}
		if (states.length === 0) out("harness: no harnesses to report.");
	});
	return { exitCode: 0 };
}
