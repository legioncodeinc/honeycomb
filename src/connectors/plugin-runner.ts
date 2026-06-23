/**
 * The `claude plugin …` command seam — the injected runner the Claude Code connector drives.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * Claude Code is wired NOT by writing top-level `~/.claude/settings.json` hooks (those never
 * receive `${CLAUDE_PLUGIN_ROOT}` — that variable is ONLY injected for PLUGIN-provided hooks, so a
 * top-level hook that references it is unresolvable), but by REGISTERING Honeycomb as a Claude Code
 * marketplace plugin through the first-party `claude plugin` CLI. The plugin's own
 * `hooks/hooks.json` then fires with `${CLAUDE_PLUGIN_ROOT}` correctly set by the host.
 *
 * This module is the seam between the connector and that CLI: an injectable
 * {@link PluginCommandRunner} so a unit test asserts the EXACT `claude plugin …` argv issued
 * (idempotency, the hivemind→honeycomb migration, fail-soft when `claude` is absent, uninstall)
 * WITHOUT the real `claude` binary, and the production runner shells to `claude` via `spawnSync`.
 *
 * ── Boundary ─────────────────────────────────────────────────────────────────
 * `src/connectors` is a NON_DAEMON_ROOT: this opens NO DeepLake and holds no daemon handle. It
 * shells to one external binary (`claude`) at install time only.
 */

import { spawnSync } from "node:child_process";

/** The outcome of one `claude plugin …` invocation. */
export interface PluginCommandResult {
	/** True when the command exited 0. */
	readonly ok: boolean;
	/** The process exit code (or a non-zero sentinel when the binary could not be spawned). */
	readonly code: number;
	/** Captured stdout (best-effort). */
	readonly stdout: string;
	/** Captured stderr (best-effort). */
	readonly stderr: string;
}

/**
 * Runs `claude plugin …` subcommands. Injected so the connector is testable: a fake records the
 * argv issued and returns scripted results; the production impl shells to the real `claude` binary.
 */
export interface PluginCommandRunner {
	/**
	 * True when the `claude` CLI is resolvable on PATH. Cheap + side-effect-free (a `--version`
	 * probe). When false, the connector fails SOFT — it never writes broken `${CLAUDE_PLUGIN_ROOT}`
	 * settings.json hooks; it reports how to register manually (or writes an absolute-path fallback).
	 */
	available(): boolean;
	/** Run `claude <args…>` and capture the outcome. `args` already includes the `plugin` verb. */
	run(args: readonly string[]): PluginCommandResult;
	/**
	 * True when the named plugin is installed AND enabled (the capture-health signal for D5). Parses
	 * `claude plugin list`. Returns false when `claude` is absent or the plugin is missing/disabled.
	 */
	isPluginEnabled(name: string): boolean;
}

/**
 * True when `claude plugin list` output shows `<name>@…` installed and enabled (not disabled). The
 * CLI prints one block per plugin: a `<name>@<marketplace>` header line followed by a
 * `Status: ✔ enabled` / `Status: ✘ disabled` line. We find the named plugin's block and require its
 * status line to read `enabled`.
 */
export function parsePluginEnabled(listOutput: string, name: string): boolean {
	const lines = listOutput.split(/\r?\n/);
	const headerIdx = lines.findIndex((l) => new RegExp(`(^|\\s)${escapeRegExp(name)}@`).test(l));
	if (headerIdx < 0) return false;
	// Scan the few lines after the header for this plugin's Status line (stop at the next plugin block).
	for (let i = headerIdx + 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (/@/.test(line) && /❯|^\s{0,4}\S+@/.test(line)) break; // next plugin block
		if (/Status:/i.test(line)) return /enabled/i.test(line) && !/disabled/i.test(line);
	}
	return false;
}

/** Escape a string for safe embedding in a RegExp. */
function escapeRegExp(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The production {@link PluginCommandRunner}: shells to the real `claude` binary via `spawnSync`.
 * `available()` probes `claude --version`; `run()` invokes `claude <args…>`. Both swallow a spawn
 * failure (binary absent) into a non-zero result rather than throwing, so the connector's fail-soft
 * branch is reached instead of crashing `honeycomb setup`.
 */
export function createClaudePluginRunner(binary = "claude"): PluginCommandRunner {
	function invoke(args: readonly string[]): PluginCommandResult {
		try {
			const proc = spawnSync(binary, args as string[], {
				encoding: "utf8",
				windowsHide: true,
				// `claude` is a real CLI; cap the wait so a hung invocation never blocks install forever.
				timeout: 120_000,
			});
			if (proc.error !== undefined || typeof proc.status !== "number") {
				return { ok: false, code: 127, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
			}
			return { ok: proc.status === 0, code: proc.status, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "" };
		} catch (err) {
			return { ok: false, code: 127, stdout: "", stderr: err instanceof Error ? err.message : "spawn failed" };
		}
	}
	let cachedAvailable: boolean | undefined;
	return {
		available(): boolean {
			if (cachedAvailable === undefined) cachedAvailable = invoke(["--version"]).ok;
			return cachedAvailable;
		},
		run(args: readonly string[]): PluginCommandResult {
			return invoke(args);
		},
		isPluginEnabled(name: string): boolean {
			if (!this.available()) return false;
			const res = invoke(["plugin", "list"]);
			if (!res.ok) return false;
			return parsePluginEnabled(res.stdout, name);
		},
	};
}
