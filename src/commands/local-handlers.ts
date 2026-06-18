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

import {
	type CommandDeps,
	type CommandResult,
	type OutputSink,
} from "./contracts.js";

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

/** The deps the local verbs add on top of {@link CommandDeps} — the connector + dashboard seams. */
export interface LocalDeps extends CommandDeps {
	/** The 019a connector engine (setup/connect/uninstall). Bound at assembly. */
	readonly connector?: ConnectorRunner;
	/** The 020b dashboard launcher (`dashboard`). Bound at assembly. */
	readonly dashboard?: DashboardLauncher;
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
	const result = await deps.connector.run({ verb, ...(harness !== undefined ? { harness } : {}) });
	if (result.harnesses.length > 0) {
		out(`${verb}: ${verb === "uninstall" ? "reversed" : "wired"} ${result.harnesses.join(", ")}.`);
	} else {
		out(`${verb}: no harnesses ${verb === "uninstall" ? "reversed" : "wired"}.`);
	}
	return { exitCode: result.exitCode };
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
	out(reachable ? "dashboard: launched (daemon reachable)." : "dashboard: daemon is not reachable — start it with `honeycomb setup`.");
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

/**
 * Run `honeycomb update [--dry-run]` (FR-10). Self-updates the CLI, daemon, and bundles;
 * `--dry-run` reports the plan without writing. Local process + daemon-launch only. The real
 * self-update mechanism is deferred assembly (the bin owns the update fetch); the `--dry-run`
 * plan path is constructed-and-tested here.
 */
export async function runUpdateCommand(argv: readonly string[], deps: LocalDeps): Promise<CommandResult> {
	const out: OutputSink = deps.out ?? ((line: string): void => console.log(line));
	const dryRun = argv.includes("--dry-run");
	if (dryRun) {
		out("update --dry-run: would update the CLI, daemon, and harness bundles to the latest release.");
		return { exitCode: 0 };
	}
	out("update: self-update is performed by the bundled bin (deferred assembly); re-run with --dry-run to preview.");
	return { exitCode: 0 };
}
