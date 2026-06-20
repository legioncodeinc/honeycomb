/**
 * The real D1–D5 health probes the CLI binds for `honeycomb status` — PRD-021b (FR-3 / b-AC-5).
 *
 * 020a's `status` consumes the 020d {@link HealthCheck} through the {@link StatusHealthSource} seam,
 * and 020d shipped the `createHealthCheck` engine + the {@link HealthProbes} SEAM — but left the
 * concrete probes to "the daemon-assembly wiring". 021b binds them: this module builds the REAL
 * five-dimension probe set so `honeycomb status` reports the genuine environment health (b-AC-5),
 * not a placeholder. The D2 (daemon reachable) probe REUSES the loopback {@link DaemonClient} the
 * storage verbs dispatch through, so "is the daemon up" has ONE answer everywhere (the impl note).
 *
 * ── Boundary: PATH / editor-dir / hooks.json + the daemon HTTP probe; NO DeepLake ──
 * Each probe touches PATH, the user's editor dir, or `~/.cursor/hooks.json`, plus the D2 daemon
 * `/health` ping over HTTP. `src/cli` is a NON_DAEMON_ROOT — no probe opens DeepLake.
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DaemonClient, StatusHealthSource } from "../commands/index.js";
import { healthSourceFromCheck } from "../commands/status.js";
import {
	createAutoWiring,
	createHealthCheck,
	type HealthProbes,
	type ProbeOutcome,
} from "../notifications/index.js";
import { ClaudeCodeConnector, createNodeConnectorFs } from "../connectors/index.js";
import { HONEYCOMB_VERSION } from "../shared/constants.js";

/** D1 — is the `honeycomb` CLI resolvable and does `--version` answer? */
function probeCli(): ProbeOutcome {
	// This process IS the CLI, so the binary is trivially present; report the running version as the
	// proof. (A spawn of `honeycomb --version` would deadlock under some shells; the in-process
	// version is the honest, fast signal.)
	return { ok: true, detail: `v${HONEYCOMB_VERSION}` };
}

/** D3 — is `cursor-agent` present on PATH? (best-effort; absence is a FAIL, not a crash). */
function probeCursorAgent(): ProbeOutcome {
	try {
		const probe = process.platform === "win32"
			? spawnSync("where", ["cursor-agent"], { stdio: "ignore" })
			: spawnSync("which", ["cursor-agent"], { stdio: "ignore" });
		const ok = probe.status === 0;
		return ok ? { ok: true, detail: "on PATH" } : { ok: false, detail: "cursor-agent not on PATH" };
	} catch (err) {
		return { ok: false, detail: err instanceof Error ? err.message : "probe failed" };
	}
}

/** D4 — best-effort cursor-agent login check (a present agent dir with a session marker). */
function probeCursorLogin(): ProbeOutcome {
	// Without a stable `cursor-agent status` contract in this environment, surface UNKNOWN as a
	// soft fail with a clear detail rather than a false green. (FR-8: a non-wirable dim is surfaced,
	// never auto-fixed.)
	const agentDir = join(homedir(), ".cursor");
	return existsSync(agentDir)
		? { ok: false, detail: "cursor present; login state unknown (run `cursor-agent login`)" }
		: { ok: false, detail: "cursor-agent not configured" };
}

/** D5 — are hooks wired? (does `~/.cursor/hooks.json` exist?). */
function probeHooksWired(): ProbeOutcome {
	const hooksPath = join(homedir(), ".cursor", "hooks.json");
	return existsSync(hooksPath)
		? { ok: true, detail: "hooks.json present" }
		: { ok: false, detail: "hooks.json not found (run `honeycomb setup`)" };
}

/**
 * Build the real {@link HealthProbes} set (FR-3 / b-AC-5). D2 reuses the loopback daemon client's
 * `ping()` (the SAME reachability the storage verbs + ensure-running use), so the daemon-up answer
 * is single-sourced. The other dims probe PATH / the editor dir / `hooks.json`.
 */
export function buildHealthProbes(daemon: DaemonClient): HealthProbes {
	return {
		async probeCli(): Promise<ProbeOutcome> {
			return probeCli();
		},
		async probeDaemon(): Promise<ProbeOutcome> {
			const alive = await daemon.ping();
			return alive
				? { ok: true, detail: "127.0.0.1:3850" }
				: { ok: false, detail: "not reachable on 127.0.0.1:3850" };
		},
		async probeCursorAgent(): Promise<ProbeOutcome> {
			return probeCursorAgent();
		},
		async probeCursorLogin(): Promise<ProbeOutcome> {
			return probeCursorLogin();
		},
		async probeHooksWired(): Promise<ProbeOutcome> {
			return probeHooksWired();
		},
	};
}

/**
 * Build the {@link StatusHealthSource} `status` renders (b-AC-5). Wraps the 020d
 * {@link createHealthCheck} over the real probes + an auto-wiring engine backed by the cursor
 * connector (D5 is the only auto-wirable dim, d-AC-6). `status` calls `evaluate()` (it surfaces the
 * dims, it does not auto-wire); the auto-wiring is wired so the SAME check object can `autoWire()`
 * from another caller without a rebuild.
 */
export function buildStatusHealthSource(daemon: DaemonClient): StatusHealthSource {
	const fs = createNodeConnectorFs();
	const cursorConnector = new ClaudeCodeConnector(fs, {
		home: homedir(),
		bundleSource: join(homedir(), ".cursor", "honeycomb", "bundle"),
	});
	const check = createHealthCheck({
		probes: buildHealthProbes(daemon),
		autoWiring: createAutoWiring({ connector: cursorConnector }),
	});
	return healthSourceFromCheck(check);
}
