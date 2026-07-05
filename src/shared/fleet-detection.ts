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
 * Solo-vs-fleet detection (PRD-003a) - Tier 1 shared.
 *
 * Honeycomb (and, independently, nectar via its own mirror of this same contract) must decide
 * whether Hive is installed alongside it BEFORE it initiates any device-flow login. The rule
 * ("authentication is a HIVE concern when Hive is present; solo installs self-serve") is settled
 * by three LIVE signals evaluated at each decision point (the install verb here):
 *
 *   S1 - a `daemons` entry named "hive" in the registry, reading BOTH `~/.apiary/registry.json`
 *        and the legacy `~/.honeycomb/doctor.daemons.json` (whichever exist).
 *   S2 - any HTTP response from `http://127.0.0.1:3853/health` within a short (~750ms) budget.
 *   S3 - `@legioncodeinc/hive` present in `npm ls -g @legioncodeinc/hive --depth 0` (best-effort
 *        `execFile`; any failure means the signal is absent). On win32 ONLY the spawn sets
 *        `shell: true`, because Node's CVE-2024-27980 hardening makes a shell-less `npm.cmd`
 *        spawn throw EINVAL, which would silently blind this signal on every Windows machine;
 *        safe because every argv element is a compile-time constant, never user input (the same
 *        audited posture as nectar's mirror of this contract).
 *
 * Classification (orchestrator decision, do not re-litigate): ANY signal fired means FLEET;
 * none means SOLO. Suppressing a popup wrongly is cheap; opening one wrongly is the bug this
 * module exists to kill. The result carries which signals fired so the caller can log them for
 * supportability (a-AC-6).
 *
 * Every signal is behind an injectable seam so tests drive the whole surface deterministically:
 * no network, no real home dir, no `npm` subprocess.
 */

import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { join } from "node:path";

import { HIVE_HOST, HIVE_PORT } from "./constants.js";
import { type FleetRootOptions, fleetRootFile, legacyHoneycombDir } from "./fleet-root.js";

/** The npm global package name that proves Hive is installed (S3). */
export const HIVE_NPM_PACKAGE = "@legioncodeinc/hive" as const;
/** The registry `daemons[].name` that proves Hive is registered (S1). */
export const HIVE_REGISTRY_NAME = "hive" as const;
/** The fleet-root registry file name (`~/.apiary/registry.json`) — S1 primary source. */
const FLEET_REGISTRY_FILE_NAME = "registry.json" as const;
/** The legacy registry file name (`~/.honeycomb/doctor.daemons.json`) — S1 compat source. */
const LEGACY_REGISTRY_FILE_NAME = "doctor.daemons.json" as const;
/** The default budget for the live Hive-port probe (S2). */
export const FLEET_PORT_PROBE_TIMEOUT_MS = 750;

/** The two mutually-exclusive machine classifications. */
export type FleetMode = "solo" | "fleet";

/** Which of the three detection signals fired. */
export interface FleetSignals {
	/** S1: a Hive entry exists in the fleet or legacy registry file. */
	readonly registryHiveEntry: boolean;
	/** S2: the Hive portal answered on 127.0.0.1:3853 within the probe budget. */
	readonly hivePortAnswering: boolean;
	/** S3: `@legioncodeinc/hive` is present in the npm global tree. */
	readonly hiveNpmGlobal: boolean;
}

/** The deterministic classification result — the mode plus the evidence for it (a-AC-6). */
export interface FleetClassification {
	/** `fleet` when ANY signal fired; `solo` when none did. */
	readonly mode: FleetMode;
	/** The raw per-signal booleans. */
	readonly signals: FleetSignals;
	/** Human-readable labels of the signals that fired (for logs / status). */
	readonly firedSignals: readonly string[];
}

/**
 * The injectable seams. Production leaves all unset (the real fs / fetch / npm defaults apply);
 * a test injects each to drive the classification without touching the network, the real home,
 * or an `npm` subprocess.
 */
export interface FleetDetectionSeams {
	/** Override S1 wholesale (else the default reads the two registry files under `home`). */
	readonly readRegistrySignal?: () => boolean;
	/** Override S2 wholesale (else the default probes 127.0.0.1:3853/health). */
	readonly probeHivePort?: (timeoutMs: number) => Promise<boolean>;
	/** Override S3 wholesale (else the default runs `npm ls -g` best-effort). */
	readonly npmGlobalHasHive?: () => Promise<boolean>;
	/** The home dir the registry paths resolve under. Defaults to `os.homedir()`. */
	readonly home?: string;
	/** The env the fleet root resolves from. Defaults to `process.env`. */
	readonly env?: NodeJS.ProcessEnv;
	/** The platform (steers the XDG leg + the npm binary name). Defaults to `process.platform`. */
	readonly platform?: NodeJS.Platform;
	/**
	 * Override the `child_process.execFile` the default S3 spawns npm through (tests assert the
	 * exact cmd/argv/options without executing). Defaults to the real, lazily-required `execFile`.
	 */
	readonly execFileImpl?: ExecFileLike;
}

/** The minimal `execFile` surface the default S3 needs (injectable for tests). */
export type ExecFileLike = (
	cmd: string,
	args: readonly string[],
	options: { readonly timeout: number; readonly windowsHide: boolean; readonly shell: boolean },
	callback: (err: Error | null, stdout: string) => void,
) => void;

/** Build the fleet-root path options from the detection seams. */
function pathOptionsFrom(seams: FleetDetectionSeams): FleetRootOptions {
	return {
		...(seams.home !== undefined ? { home: seams.home } : {}),
		...(seams.env !== undefined ? { env: seams.env } : {}),
		...(seams.platform !== undefined ? { platform: seams.platform } : {}),
	};
}

/** True when the registry document at `path` carries a `daemons[]` entry named "hive". */
function registryFileHasHive(path: string): boolean {
	if (!existsSync(path)) return false;
	let parsed: unknown;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return false;
	}
	if (typeof parsed !== "object" || parsed === null) return false;
	const daemons = (parsed as { daemons?: unknown }).daemons;
	if (!Array.isArray(daemons)) return false;
	return daemons.some(
		(entry) => typeof entry === "object" && entry !== null && (entry as { name?: unknown }).name === HIVE_REGISTRY_NAME,
	);
}

/** The default S1: read the fleet + legacy registry files under `home` for a Hive entry. */
export function defaultReadRegistrySignal(seams: FleetDetectionSeams = {}): boolean {
	const options = pathOptionsFrom(seams);
	const home = seams.home ?? homedir();
	const candidates = [
		fleetRootFile(FLEET_REGISTRY_FILE_NAME, options),
		join(legacyHoneycombDir(home), LEGACY_REGISTRY_FILE_NAME),
	];
	return candidates.some(registryFileHasHive);
}

/** The default S2: any HTTP answer from the Hive portal within `timeoutMs` proves it is up. */
export async function defaultProbeHivePort(timeoutMs: number = FLEET_PORT_PROBE_TIMEOUT_MS): Promise<boolean> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	if (typeof timer.unref === "function") timer.unref();
	try {
		await fetch(`http://${HIVE_HOST}:${HIVE_PORT}/health`, { method: "GET", signal: controller.signal });
		return true;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * The default S3: `npm ls -g @legioncodeinc/hive --depth 0`, best-effort and fixed-argv. Any
 * failure (npm missing, non-zero exit because the package is absent, a timeout) resolves `false` —
 * the signal is only present when npm exits 0 AND names the package. `child_process` is loaded
 * lazily via `createRequire` so this shared module carries no top-level subprocess import (the
 * OpenClaw ClawHub scanner posture, mirrored from `daemon-service.ts`).
 *
 * `npm` ships as `npm.cmd` on Windows, and since Node's CVE-2024-27980 hardening (all Node >= 22)
 * a `.cmd` cannot be spawned with `shell: false` (it throws EINVAL, which would silently blind
 * this signal on every Windows machine), so win32 ALONE sets `shell: true`. That is safe here
 * because every argv element is a compile-time constant, never user input; it also keeps this
 * module behavior-identical to nectar's mirror of the same contract (`nectar/src/fleet-detection.ts`).
 */
export function defaultNpmGlobalHasHive(seams: FleetDetectionSeams = {}): Promise<boolean> {
	return new Promise<boolean>((resolve) => {
		try {
			const exec: ExecFileLike =
				seams.execFileImpl ??
				(() => {
					const require = createRequire(import.meta.url);
					const cp = require("node:child_process") as typeof import("node:child_process");
					return cp.execFile as unknown as ExecFileLike;
				})();
			const platform = seams.platform ?? process.platform;
			const win32 = platform === "win32";
			exec(
				win32 ? "npm.cmd" : "npm",
				["ls", "-g", HIVE_NPM_PACKAGE, "--depth", "0"],
				{ timeout: 5000, windowsHide: true, shell: win32 },
				(err, stdout) => {
					if (err) {
						resolve(false);
						return;
					}
					resolve(typeof stdout === "string" && stdout.includes(HIVE_NPM_PACKAGE));
				},
			);
		} catch {
			resolve(false);
		}
	});
}

/**
 * Classify the machine solo-vs-fleet from the three LIVE signals (a-AC-6). ANY signal fired means
 * FLEET; none means SOLO. Deterministic for a given machine state, and the result records which
 * signals fired so the caller can log the evidence. S2 (the network probe) and S3 (the npm read)
 * run concurrently; S1 is a cheap synchronous file read.
 */
export async function classifyFleet(seams: FleetDetectionSeams = {}): Promise<FleetClassification> {
	const registryHiveEntry = (seams.readRegistrySignal ?? (() => defaultReadRegistrySignal(seams)))();
	const [hivePortAnswering, hiveNpmGlobal] = await Promise.all([
		(seams.probeHivePort ?? defaultProbeHivePort)(FLEET_PORT_PROBE_TIMEOUT_MS),
		(seams.npmGlobalHasHive ?? (() => defaultNpmGlobalHasHive(seams)))(),
	]);
	const signals: FleetSignals = { registryHiveEntry, hivePortAnswering, hiveNpmGlobal };
	const firedSignals: string[] = [];
	if (registryHiveEntry) firedSignals.push("registry Hive entry");
	if (hivePortAnswering) firedSignals.push("Hive portal on 127.0.0.1:3853");
	if (hiveNpmGlobal) firedSignals.push(`npm global ${HIVE_NPM_PACKAGE}`);
	return { mode: firedSignals.length > 0 ? "fleet" : "solo", signals, firedSignals };
}

/** A one-line, log-friendly summary of a classification (a-AC-6 supportability). */
export function fleetSignalLine(classification: FleetClassification): string {
	if (classification.mode === "fleet") {
		return `fleet detection: FLEET (signals fired: ${classification.firedSignals.join(", ")}).`;
	}
	return "fleet detection: SOLO (no Hive signals fired: no registry entry, no 127.0.0.1:3853 answer, no npm global).";
}
