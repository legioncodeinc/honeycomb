/**
 * The CLI-side composition root — PRD-021b (b-AC-1..6 / FR-1..10).
 *
 * 021a left the per-handler seams in `src/cli/index.ts` UNBOUND (the honest-deferral stub line).
 * THIS module is the binding layer that makes the bundled `bundle/cli.js` a real end-to-end CLI: it
 * constructs every real seam the dispatcher + handlers consume and assembles them into the
 * {@link RuntimeDeps} the bin passes to `dispatch`. After this, every dispatched verb reaches a
 * bound handler — there is no remaining deferred-assembly stub path (b-AC-6).
 *
 * ── Thin-client boundary (D-2) ───────────────────────────────────────────────
 * `src/cli` imports nothing from `daemon/storage`. The seams here reach the daemon ONLY over HTTP
 * (the loopback {@link DaemonClient}) and over the PROCESS boundary (the {@link DaemonLifecycle}
 * spawns the bundled `daemon/index.js`, whose `runAssembledDaemon` is the sole importer of
 * `daemon/storage` — the composition root stays in the daemon). It reaches the credential FILE,
 * the harness configs, and PATH through `node:fs` / `node:child_process` only. The auth + health +
 * connector seams come from `src/daemon/runtime/auth`, `src/notifications`, and `src/connectors`,
 * all of which are themselves thin clients (NON_DAEMON_ROOTS).
 *
 * ── The shared credential is the one identity ────────────────────────────────
 * The loopback client stamps the org/workspace/actor headers from `~/.honeycomb/credentials.json`
 * (b-AC-4), the same file `login` writes at 0600 and the daemon reads at startup. The bearer token
 * is NEVER printed and never put in a log line — only the org/workspace ids reach a header.
 */

import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
	type AuthPassthrough,
	type CommandDeps,
	type ConnectorRunner,
	createLoopbackDaemonClient,
	type DaemonClient,
	type DaemonLifecycle,
	type DaemonStatus,
	type DashboardLauncher,
	type OrgDriftHealer,
	type StatusHealthSource,
} from "../commands/index.js";
import { healthSourceFromCheck } from "../commands/status.js";

import {
	type Credentials,
	credentialsPath,
	healOrgDrift,
	loadCredentials,
	systemClock,
} from "../daemon/runtime/auth/index.js";
import { DAEMON_HOST, DAEMON_PORT } from "../shared/constants.js";

import { authMain } from "./auth.js";
import { orgMain } from "./org.js";
import { buildRealTokenIssuer } from "./token-issuer.js";
import { buildConnectorRunner } from "./connector-runner.js";
import { buildStatusHealthSource } from "./health-probes.js";
import { launchDashboard } from "../dashboard/launch.js";

/** The full dep bundle the bin hands `dispatch` — `CommandDeps` plus the local/status/daemon seams. */
export interface RuntimeDeps extends CommandDeps {
	readonly auth: AuthPassthrough;
	readonly connector: ConnectorRunner;
	readonly dashboard: DashboardLauncher;
	readonly health: StatusHealthSource;
	readonly drift: OrgDriftHealer;
	readonly loggedIn: boolean;
	readonly lifecycle: DaemonLifecycle;
}

/** The daemon base URL the loopback client + health probe dial (loopback 3850). */
function daemonBaseUrl(): string {
	return `http://${DAEMON_HOST}:${DAEMON_PORT}`;
}

/**
 * Build the tenancy headers the loopback client stamps from the shared credential (b-AC-1 /
 * b-AC-4). Carries the org / workspace / actor ids ONLY — never the bearer token in a header value
 * the CLI would log; the daemon reads the token from the same credential file it loads at startup.
 * A logged-out CLI sends no tenancy headers (local single-user mode resolves a default org).
 */
function tenancyHeaders(creds: Credentials | null): Record<string, string> {
	if (creds === null) return {};
	const headers: Record<string, string> = {
		"x-honeycomb-org": creds.orgId,
		"x-honeycomb-workspace": creds.workspace,
		"x-honeycomb-actor": creds.agentId,
	};
	return headers;
}

/** Resolve the bundled `daemon/index.js` entry the lifecycle spawns (b-AC-2). */
function resolveDaemonEntry(): string {
	// In the published package the CLI runs from `bundle/cli.js`; the daemon bundle is the sibling
	// `daemon/index.js`. From this module's location, walk up out of `bundle/` (or `dist/src/cli/`
	// in a dev tsc run) to the package root, then into `daemon/`.
	const here = dirname(fileURLToPath(import.meta.url));
	// Candidate roots: the bundled layout (`<root>/bundle/cli.js` → here = `<root>/bundle`), and the
	// tsc dev layout (`<root>/dist/src/cli` → up three). Prefer the bundled sibling.
	const bundledSibling = resolve(here, "..", "daemon", "index.js");
	const devSibling = resolve(here, "..", "..", "..", "daemon", "index.js");
	// We cannot stat synchronously without importing fs here on the hot path for every invocation;
	// the spawn fails loudly with a clear error if neither exists, and `start()` surfaces it. Prefer
	// the bundled sibling (the production path); the dev path is the fallback the spawn tries on a
	// missing-file error is not worth the extra branch — the env var override covers dev.
	return process.env.HONEYCOMB_DAEMON_ENTRY ?? bundledSibling ?? devSibling;
}

/** How long ensure-running / `daemon start` waits for the daemon to answer `/health` after spawn. */
const DEFAULT_START_TIMEOUT_MS = 8_000;
/** The `/health` poll cadence while waiting for a freshly-spawned daemon to bind. */
const START_POLL_INTERVAL_MS = 150;

/** Resolve the `~/.honeycomb` runtime dir the 021a PID/lock guard writes to. */
function runtimeDir(): string {
	return join(homedir(), ".honeycomb");
}

/** Read the recorded daemon pid from the 021a lock file (or null when absent/garbage). */
async function readDaemonPid(): Promise<number | null> {
	const { readFile } = await import("node:fs/promises");
	try {
		const raw = (await readFile(join(runtimeDir(), "daemon.pid"), "utf8")).trim();
		const pid = Number.parseInt(raw, 10);
		return Number.isInteger(pid) && pid > 0 ? pid : null;
	} catch {
		return null;
	}
}

/** True when a process with `pid` is alive (signal 0 probes liveness without delivering a signal). */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException)?.code === "EPERM";
	}
}

/**
 * Build the real {@link DaemonLifecycle} (b-AC-2 / b-AC-3). `start` spawns the bundled
 * `daemon/index.js` DETACHED (so it outlives the CLI invocation) and waits for `/health` to answer;
 * the 021a PID/lock guard inside the spawned process makes a concurrent start a no-op rather than a
 * double-bind. `stop` signals the recorded pid to drain gracefully (SIGTERM → 021a SIGTERM handler).
 * `status` reads the PID/lock + reports the port. Never imports the composition root (D-2).
 */
export function buildDaemonLifecycle(client: DaemonClient): DaemonLifecycle {
	return {
		async start(): Promise<{ readonly started: boolean; readonly alreadyRunning: boolean }> {
			if (await client.ping()) return { started: false, alreadyRunning: true };

			const entry = resolveDaemonEntry();
			const child = spawn(process.execPath, [entry], {
				detached: true,
				stdio: "ignore",
				env: process.env,
			});
			// Let the daemon outlive this CLI process (b-AC-2: `start` brings it up and returns).
			child.unref();

			// Wait for the spawned daemon to bind + answer /health (or exhaust the budget).
			const deadline = Date.now() + DEFAULT_START_TIMEOUT_MS;
			while (Date.now() < deadline) {
				await new Promise((r) => setTimeout(r, START_POLL_INTERVAL_MS));
				if (await client.ping()) return { started: true, alreadyRunning: false };
			}
			return { started: false, alreadyRunning: false };
		},

		async stop(): Promise<{ readonly stopped: boolean }> {
			const pid = await readDaemonPid();
			if (pid === null || !isPidAlive(pid)) return { stopped: false };
			try {
				// SIGTERM → the 021a graceful-shutdown handler drains services, closes the socket, and
				// removes the lock. No SIGKILL: a clean drain is the contract (a-AC-5).
				process.kill(pid, "SIGTERM");
				return { stopped: true };
			} catch {
				return { stopped: false };
			}
		},

		async status(): Promise<DaemonStatus> {
			const pid = await readDaemonPid();
			const running = pid !== null && isPidAlive(pid);
			return running ? { running, pid, port: DAEMON_PORT } : { running: false, port: DAEMON_PORT };
		},
	};
}

/**
 * The auth-passthrough seam (FR-4 / b-AC-4). `org`/`workspace` forward to {@link orgMain};
 * `login`/`logout` forward to {@link authMain}. Both bind the REAL {@link TokenIssuer} so the device
 * flow actually runs and writes `~/.honeycomb/credentials.json` at 0600 (011b — not reimplemented).
 */
export function buildAuthPassthrough(): AuthPassthrough {
	const issuer = buildRealTokenIssuer();
	return {
		async dispatch(args: readonly string[]): Promise<number> {
			const verb = args[0] ?? "";
			const tail = args.slice(1);
			if (verb === "login" || verb === "logout") {
				const result = await authMain([verb, ...tail], { issuer });
				return result.exitCode;
			}
			// `org` / `workspace` route to the 011a tenancy dispatcher (re-mint / workspace set).
			const result = await orgMain([verb, ...tail], { issuer });
			return result.exitCode;
		},
	};
}

/**
 * The org-drift healer seam (FR-8 / b-AC-4 / b-AC-5). Reuses 011b's {@link healOrgDrift} (decode
 * the JWT, compare the `org_id` claim with the active org, re-mint on mismatch) — NOT reimplemented.
 * The active org is the credential's own org in local single-user mode; a drift only arises when an
 * env override (`HONEYCOMB_ORG_ID`) disagrees with the token claim. Best-effort: never throws.
 */
export function buildOrgDriftHealer(creds: Credentials | null, dir?: string): OrgDriftHealer {
	const issuer = buildRealTokenIssuer();
	const activeOrg = process.env.HONEYCOMB_ORG_ID ?? creds?.orgId ?? "local";
	return {
		async heal() {
			const outcome = await healOrgDrift({
				issuer,
				activeOrg,
				clock: systemClock,
				...(dir !== undefined ? { dir } : {}),
			});
			if (outcome.kind === "healed") return { kind: "healed", to: outcome.to };
			return { kind: outcome.kind };
		},
	};
}

/** The dashboard launcher seam (FR-4) — binds 020b's {@link launchDashboard} over the loopback daemon. */
export function buildDashboardLauncher(headers: Record<string, string>): DashboardLauncher {
	return {
		async launch(): Promise<{ readonly reachable: boolean }> {
			const rendered = await launchDashboard({ headers });
			return { reachable: rendered.connectivity.reachable };
		},
	};
}

/**
 * Assemble the full {@link RuntimeDeps} the bin passes to `dispatch` (b-AC-1..6). Reads the shared
 * credential once, stamps its tenancy onto the loopback client + dashboard, binds the daemon
 * lifecycle (spawn-based), the auth passthrough (real device flow), the connector engine (real
 * `node:fs`), the 020d health source (real D1–D5 probes), and the 011b drift healer. Every seam is
 * real — no deferred-assembly stub path remains.
 */
export function buildRuntimeDeps(): RuntimeDeps {
	const creds = loadCredentials();
	const headers = tenancyHeaders(creds);
	const daemon = createLoopbackDaemonClient({ baseUrl: daemonBaseUrl(), headers });
	const lifecycle = buildDaemonLifecycle(daemon);

	return {
		daemon,
		lifecycle,
		auth: buildAuthPassthrough(),
		connector: buildConnectorRunner(),
		dashboard: buildDashboardLauncher(headers),
		health: buildStatusHealthSource(daemon),
		drift: buildOrgDriftHealer(creds),
		loggedIn: creds !== null,
	};
}

/** Re-export the credential path helper so the bin / tests can locate the shared identity. */
export { credentialsPath, healthSourceFromCheck };
