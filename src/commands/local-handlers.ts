/**
 * The LOCAL (non-storage) verb handlers — PRD-020a (FR-6 / FR-10 / a-AC-1).
 *
 * These verbs touch the local filesystem / process / the daemon CONTROL surface, but
 * never a storage verb: `setup`, `connect`, `uninstall` (FR-6 — REUSE the 019a connector
 * base, D-4: do NOT fork a second install engine), `dashboard` (FR-10 — launch 020b's
 * surface), `hook` (inspect/wire harness hooks), and `update` (FR-10 — self-update with
 * `--dry-run`). They reach the connector engine through the 019a `connectorMain` and the
 * daemon (for liveness/launch) through the {@link DaemonClient} seam.
 *
 * ── D-4 REUSE (setup / connect / uninstall) ──────────────────────────────────
 *   `setup`/`connect`/`uninstall` delegate to `src/connectors` (the 019a `connectorMain`):
 *   detect platforms, wire hooks idempotently (preserve foreign, `writeJsonIfChanged`),
 *   reverse cleanly. This module ROUTES the CLI verb onto that engine through the injected
 *   {@link ConnectorRunner} seam — it does NOT re-implement the merge. The real seam binds
 *   `connectorMain` over a `node:fs`-backed `ConnectorFs` + the registry (the cursor +
 *   claude-code connectors); a test injects a fake.
 */

import { DEFAULT_REF, loadOnboarding } from "../daemon/runtime/onboarding/index.js";
import { type EmitDeps, emitTelemetry } from "../daemon/runtime/telemetry/index.js";
import type { CommandDeps, CommandResult, OutputSink } from "./contracts.js";
import type { HarnessStatusRunner } from "./harness-status.js";

/** The parsed connector invocation handed to the 019a engine (`setup`/`connect`/`uninstall`). */
export interface ConnectorVerbArgs {
	/** The verb (`setup` | `connect` | `uninstall`). */
	readonly verb: string;
	/** The harness slug for `connect <harness>` / `uninstall <harness>`, if any. */
	readonly harness?: string;
}

/** The outcome the connector engine reports — exit code + per-harness wired/reversed slugs. */
export interface ConnectorVerbResult {
	readonly exitCode: number;
	/** The harness slugs wired (setup/connect) or reversed (uninstall). */
	readonly harnesses: readonly string[];
}

/**
 * The connector-engine seam (D-4). The daemon-assembly wiring binds 019a's `connectorMain` over
 * a real `ConnectorFs` + the connector registry (cursor + claude-code); a test injects a fake.
 * `status` is intentionally NOT here — only the install-time verbs route through this seam.
 */
export interface ConnectorRunner {
	/** Run `setup` / `connect <harness>` / `uninstall [<harness>]` through the 019a engine. */
	run(args: ConnectorVerbArgs): Promise<ConnectorVerbResult>;
}

/** A dashboard launcher seam (FR-10) — binds 020b's `launchDashboard`; a test injects a fake. */
export interface DashboardLauncher {
	/** Launch the 020b daemon-served surface; returns whether the daemon was reachable. */
	launch(): Promise<{ readonly reachable: boolean }>;
}

/**
 * The PRD-003b fleet-lifecycle uninstall steps (b-AC-2 / b-AC-3 / b-AC-4). A FULL `uninstall` runs
 * these required phases in order before reversing harness hooks. The transaction fails closed: a
 * failed phase stops later destructive work, and explicit OS-service inspection/removal cannot be
 * bypassed by spawn mode. The real bindings are assembled in `src/cli/runtime.ts` (daemon quiescence,
 * the explicit OS-service controller, the Doctor-registry delete writer, and the resolved state-dir
 * remover); a test injects a recording fake so no live resources are touched. Every method reports
 * what it did (or that there was nothing to do) so the caller narrates each committed phase.
 */
export interface UninstallLifecycleSteps {
	/** Quiesce the running daemon before mandatory explicit service inspection and removal. */
	stopDaemon(): Promise<{ readonly stopped: boolean }>;
	/** Remove Honeycomb's current OS service definition; legacy-label cleanup may be best-effort. */
	unregisterService(): { readonly removed: boolean; readonly manager?: string };
	/** Delete honeycomb's entry from doctor's registry, leaving every other entry intact. */
	deleteRegistryEntry(): { readonly removed: boolean };
	/** Remove honeycomb's own state dir under the fleet root (by resolved absolute path). */
	removeStateDir(): { readonly removed: boolean; readonly dir: string };
}

/** The deps the local verbs add on top of {@link CommandDeps} — the connector + dashboard seams. */
export interface LocalDeps extends CommandDeps {
	/** The 019a connector engine (setup/connect/uninstall). Bound at assembly. */
	readonly connector?: ConnectorRunner;
	/** The 020b dashboard launcher (`dashboard`). Bound at assembly. */
	readonly dashboard?: DashboardLauncher;
	/**
	 * Telemetry chokepoint seam (PRD-050e posture). The `honeycomb_uninstalled` lifecycle event
	 * emits through here when the full `uninstall` verb runs - fire-and-forget, never gating the
	 * verb. Tests inject a `fetch` recorder + temp `dir`; omit in production (the chokepoint's
	 * defaults apply, and an empty build key makes it a no-op).
	 */
	readonly telemetry?: EmitDeps;
	/**
	 * PRD-003b: the fleet-lifecycle uninstall steps (b-AC-2/3/4). Bound by `src/cli/runtime.ts` for the
	 * FULL `uninstall` verb (stop daemon → unregister the OS service unit → delete the doctor registry
	 * entry → remove the state dir), run alongside the existing harness-hook reversal. Optional so the
	 * older connector-only tests still type-check; when unbound, `uninstall` reverses hooks only.
	 */
	readonly uninstallSteps?: UninstallLifecycleSteps;
	/**
	 * PRD-006c/006d: the coherent harness connect/status/repair surface the `harness` verb routes to.
	 * Bound by `src/cli/runtime.ts` over the 006b reconcile (Tier 4). Optional so the older
	 * connector-only handler tests still type-check; when unbound the verb reports the deferred-assembly
	 * line and exits non-zero (it never throws).
	 */
	readonly harnessStatus?: HarnessStatusRunner;
}

/** Parse the harness slug (first non-flag word) off a connector verb's argv tail. */
function harnessArg(argv: readonly string[]): string | undefined {
	return argv.find((a) => !a.startsWith("--"));
}

/**
 * Run `honeycomb setup` / `connect <harness>` / `uninstall [<harness>]` (FR-6 / D-4). Delegates
 * to the 019a `connectorMain` through the {@link ConnectorRunner} seam: `setup` detects + wires
 * every installed harness, `connect` wires one, `uninstall` reverses ONLY Honeycomb's changes.
 * The merge is the 019a engine — foreign-preserving, idempotent, reversible — NOT re-implemented
 * here. When no connector seam is bound (the deferred bin assembly) it reports that honestly.
 */
export async function runConnectorVerb(verb: string, argv: readonly string[], deps: LocalDeps): Promise<CommandResult> {
	const out: OutputSink = deps.out ?? ((line: string): void => console.log(line));
	if (deps.connector === undefined) {
		out(`${verb}: the connector engine is not wired in this build (deferred assembly).`);
		return { exitCode: 1 };
	}
	const harness = harnessArg(argv);
	const isFullUninstall = verb === "uninstall" && harness === undefined;
	let uninstallRef = DEFAULT_REF;
	if (isFullUninstall) {
		try {
			uninstallRef = loadOnboarding(deps.dir).ref;
		} catch {
			// Fail-soft: an unreadable onboarding state never blocks removal.
		}
	}
	// PRD-003b (b-AC-2/3/4): FULL uninstall is an ordered, fail-closed transaction: quiesce the daemon,
	// explicitly inspect/remove the current OS service, delete Doctor registration, remove product state,
	// then reverse harness hooks. A required-phase failure stops later destructive work; only supplemental
	// legacy service-label cleanup is best-effort.
	let fleetRemovedSomething = false;
	if (isFullUninstall && deps.uninstallSteps !== undefined) {
		const lifecycle = await runUninstallLifecycleSteps(deps.uninstallSteps, out);
		fleetRemovedSomething = lifecycle.removedSomething;
		if (!lifecycle.ok) return { exitCode: 1 };
	}
	const result = await deps.connector.run({ verb, ...(harness !== undefined ? { harness } : {}) });
	if (result.harnesses.length > 0) {
		out(`${verb}: ${verb === "uninstall" ? "reversed" : "wired"} ${result.harnesses.join(", ")}.`);
	} else {
		out(`${verb}: no harnesses ${verb === "uninstall" ? "reversed" : "wired"}.`);
	}
	// b-AC-6: a full uninstall on a machine where NOTHING was installed exits 0 with a friendly
	// nothing-to-remove line (in addition to the per-step reports above).
	if (isFullUninstall && deps.uninstallSteps !== undefined && !fleetRemovedSomething && result.harnesses.length === 0) {
		out("uninstall: nothing to remove — Honeycomb was not installed here.");
	}
	// Commit-point telemetry: emit only after every required removal phase and connector reversal
	// succeeded. A failed transaction must never consume the one-time uninstall event.
	if (isFullUninstall && result.exitCode === 0) {
		void emitTelemetry(
			"honeycomb_uninstalled",
			{ ref: uninstallRef, tier: "tier1" },
			{ ...(deps.telemetry ?? {}), ...(deps.dir !== undefined ? { dir: deps.dir } : {}) },
		);
	}
	return { exitCode: result.exitCode };
}

/**
 * Run required uninstall phases in contract order. A failed phase stops later destructive work and
 * suppresses success telemetry.
 */
async function runUninstallLifecycleSteps(
	steps: UninstallLifecycleSteps,
	out: OutputSink,
): Promise<{ readonly removedSomething: boolean; readonly ok: boolean }> {
	let removedSomething = false;
	// 1. Stop the daemon first so doctor never sees a registered-but-gone product mid-flight.
	try {
		const { stopped } = await steps.stopDaemon();
		out(stopped ? "uninstall: stopped the daemon." : "uninstall: daemon was not running.");
	} catch {
		out("uninstall: could not stop the daemon; no further removal was attempted.");
		return { removedSomething, ok: false };
	}
	// 2. Inspect and remove the current OS service explicitly so it cannot restart at boot. Failure is
	//    fatal to the transaction; only supplemental legacy-label cleanup may be best-effort.
	try {
		const r = steps.unregisterService();
		out(
			r.removed
				? `uninstall: removed the OS service unit${r.manager !== undefined ? ` (${r.manager})` : ""}.`
				: "uninstall: no OS service unit to remove.",
		);
		removedSomething = removedSomething || r.removed;
	} catch {
		out("uninstall: could not remove the OS service unit; registration and state were preserved.");
		return { removedSomething, ok: false };
	}
	// 3. Delete honeycomb's entry from doctor's registry, leaving every other entry intact.
	try {
		const r = steps.deleteRegistryEntry();
		out(
			r.removed
				? "uninstall: removed Honeycomb's entry from doctor's registry."
				: "uninstall: no doctor registry entry to remove.",
		);
		removedSomething = removedSomething || r.removed;
	} catch {
		out("uninstall: could not update doctor's registry; product state was preserved.");
		return { removedSomething, ok: false };
	}
	// 4. Remove honeycomb's state dir LAST, by resolved absolute path (never a glob, never a symlink
	//    followed out of the fleet root).
	try {
		const r = steps.removeStateDir();
		out(
			r.removed
				? `uninstall: removed the Honeycomb state directory (${r.dir}).`
				: "uninstall: no state directory to remove.",
		);
		removedSomething = removedSomething || r.removed;
	} catch {
		out("uninstall: could not remove the state directory.");
		return { removedSomething, ok: false };
	}
	return { removedSomething, ok: true };
}

/**
 * Run `honeycomb dashboard` (FR-10). Launches the 020b daemon-served surface through the
 * {@link DashboardLauncher} seam, surfacing a clear connectivity state when the daemon is down
 * (020b b-AC-2). It does NOT render views itself — 020b owns the canonical view layer.
 */
export async function runDashboardCommand(deps: LocalDeps): Promise<CommandResult> {
	const out: OutputSink = deps.out ?? ((line: string): void => console.log(line));
	if (deps.dashboard === undefined) {
		out("dashboard: the dashboard launcher is not wired in this build (deferred assembly).");
		return { exitCode: 1 };
	}
	const { reachable } = await deps.dashboard.launch();
	out(
		reachable
			? "dashboard: launched (daemon reachable)."
			: "dashboard: daemon is not reachable — start it with `honeycomb setup`.",
	);
	return { exitCode: 0 };
}

/**
 * Run `honeycomb hook` (inspect/wire harness hooks). Reports wired state per harness and
 * (re)wires through the 019a connector engine (D-4). Local FS only — never DeepLake.
 */
export async function runHookCommand(argv: readonly string[], deps: LocalDeps): Promise<CommandResult> {
	const out: OutputSink = deps.out ?? ((line: string): void => console.log(line));
	const sub = argv.find((a) => !a.startsWith("--")) ?? "status";
	if (sub === "wire") {
		// Re-wire is `setup` semantics through the same 019a engine.
		return runConnectorVerb("setup", argv.slice(1), deps);
	}
	out("hook: run `honeycomb hook wire` to (re)wire harness hooks, or `honeycomb status` for D1–D5.");
	return { exitCode: 0 };
}
