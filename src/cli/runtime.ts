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
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
	DEFAULT_DEEPLAKE_API_URL,
	credentialsPath,
	healOrgDrift,
	loadCredentials,
	loadDiskCredentials,
	systemClock,
	verifyTokenClaims,
} from "../daemon/runtime/auth/index.js";
import { DAEMON_HOST, DAEMON_PORT } from "../shared/constants.js";

import { authMain } from "./auth.js";
import { orgMain } from "./org.js";
import { projectMain } from "./project.js";
import { whoamiMain } from "./whoami.js";
import { buildRealTokenIssuer } from "./token-issuer.js";
import { buildConnectorRunner } from "./connector-runner.js";
import { buildStatusHealthSource } from "./health-probes.js";
import { launchDashboard } from "../dashboard/launch.js";
import {
	type DaemonServiceController,
	type ServiceManager,
	type ServiceSpec,
	createDaemonServiceController,
	detectServiceManager,
} from "./daemon-service.js";

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

/**
 * Node flags the spawned daemon process is launched with (PRD-043a). `--experimental-sqlite`
 * unlocks the built-in `node:sqlite` (`DatabaseSync`) the durable log store uses on Node 22.x (the
 * `engines` floor; the module landed in 22.5.0). It is flag-free on Node 24/25, where the flag is
 * ACCEPTED AS A HARMLESS NO-OP — so passing it unconditionally keeps production persistence green
 * across the whole supported Node matrix without a version branch. The store itself is fail-soft
 * (an unavailable `node:sqlite` degrades to in-memory), so a Node that somehow rejects the flag
 * still boots — the daemon just runs without log history.
 */
const DAEMON_NODE_FLAGS: readonly string[] = ["--experimental-sqlite"];

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

/**
 * How long ensure-running / `daemon start` waits for the daemon to answer `/health` after spawn.
 * A COLD boot does real warmup off the critical path before binding — spawn the embeddings child
 * + bounded liveness wait, wire the queue/pipeline/summary/skillify workers, and run the first
 * DeepLake round-trips — which measured ~26s on a warm cache (longer on the first-ever run that
 * downloads the embed model). The old 8s budget expired mid-boot and made `daemon start` print
 * "failed to start" for a daemon that was simply still coming up. The budget now comfortably
 * exceeds a normal warm boot; the poll returns the instant `/health` answers, so a fast boot is
 * still fast, and a boot that exceeds even this is reported as "still warming up" (not "failed").
 */
const DEFAULT_START_TIMEOUT_MS = 45_000;
/** The `/health` poll cadence while waiting for a freshly-spawned daemon to bind. */
const START_POLL_INTERVAL_MS = 150;

/** Resolve the `~/.honeycomb` runtime dir the 021a PID/lock guard writes to. */
function runtimeDir(): string {
	return join(homedir(), ".honeycomb");
}

/**
 * Resolve a guaranteed-WRITABLE workspace to PIN onto the spawned daemon (the `C:\WINDOWS\system32`
 * footgun). A detached daemon inherits the spawner's cwd, and `assemble.ts` resolves its `.secrets/`
 * + `.daemon/` root from `HONEYCOMB_WORKSPACE ?? process.cwd()`. On Windows a CLI invoked from a
 * service / stray shell can sit in `C:\WINDOWS\system32` — an unwritable root that makes every
 * secret save EACCES (a 502 `store_failed` with no audit trail). So `start()` pins BOTH `cwd` and
 * `HONEYCOMB_WORKSPACE` to the first writable of: an explicit `HONEYCOMB_WORKSPACE`, the CLI cwd,
 * then `~/.honeycomb`. The daemon's own resolver applies the same fallback as defense-in-depth.
 */
export function resolveDaemonWorkspace(): string {
	const fromEnv = process.env.HONEYCOMB_WORKSPACE;
	const candidates = [fromEnv !== undefined && fromEnv.length > 0 ? fromEnv : process.cwd(), runtimeDir()];
	for (const dir of candidates) {
		if (canWriteDir(dir)) return dir;
	}
	return runtimeDir();
}

/**
 * True iff `dir` accepts a real create-write-unlink probe. `accessSync(W_OK)` lies on Windows (it
 * checks the read-only attribute, not the ACL), so the actual round-trip is the only honest test.
 */
export function canWriteDir(dir: string): boolean {
	try {
		mkdirSync(dir, { recursive: true });
		// Probe with an EXCLUSIVE, randomly-suffixed temp dir (mkdtemp guarantees a fresh name) so
		// the check only ever creates + removes a path it owns — never truncating or deleting a
		// pre-existing workspace file the way a deterministic `${pid}` marker could.
		const probe = mkdtempSync(join(dir, ".hc-spawn-probe-"));
		rmSync(probe, { recursive: true, force: true });
		return true;
	} catch {
		return false;
	}
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
 * Build the {@link ServiceSpec} the OS-service unit is rendered from (PRD-064h). Pins the
 * caller-resolved WRITABLE workspace (AC-064h.4) and the bundled daemon entry + Node flags. Resolved
 * here (the same place `start()` resolves them for the spawn fallback), so service mode and spawn
 * mode agree on the entry, flags, and workspace.
 */
function buildServiceSpec(): ServiceSpec {
	return {
		nodePath: process.execPath,
		entry: resolveDaemonEntry(),
		nodeFlags: DAEMON_NODE_FLAGS,
		workspace: resolveDaemonWorkspace(),
	};
}

/**
 * Spawn the bundled `daemon/index.js` DETACHED and wait for `/health` (the documented FALLBACK path,
 * PRD-064h HC-1). Extracted from the original `start()` so service mode and the fallback share ONE
 * spawn implementation. Pins BOTH `cwd` and `HONEYCOMB_WORKSPACE` to the writable workspace (the
 * `C:\WINDOWS\system32` 502 footgun close). The 021a PID/lock guard inside the spawned process makes
 * a concurrent start a no-op rather than a double-bind.
 */
async function spawnDaemonAndWait(
	client: DaemonClient,
): Promise<{ readonly started: boolean; readonly alreadyRunning: boolean }> {
	const entry = resolveDaemonEntry();
	const workspace = resolveDaemonWorkspace();
	const child = spawn(process.execPath, [...DAEMON_NODE_FLAGS, entry], {
		detached: true,
		stdio: "ignore",
		cwd: workspace,
		env: { ...process.env, HONEYCOMB_WORKSPACE: workspace },
		// Hide the transient console window on Windows: a detached daemon spawn is never an
		// interactive terminal the user needs to see.
		windowsHide: true,
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
}

/** Poll `/health` until it answers or the start budget is exhausted (shared by the service path). */
async function waitForHealth(client: DaemonClient): Promise<boolean> {
	const deadline = Date.now() + DEFAULT_START_TIMEOUT_MS;
	while (Date.now() < deadline) {
		if (await client.ping()) return true;
		await new Promise((r) => setTimeout(r, START_POLL_INTERVAL_MS));
	}
	return false;
}

/** Signal the recorded daemon pid to drain gracefully (SIGTERM → 021a shutdown). Shared helper. */
async function signalDaemonStop(): Promise<boolean> {
	const pid = await readDaemonPid();
	if (pid === null || !isPidAlive(pid)) return false;
	try {
		// SIGTERM → the 021a graceful-shutdown handler drains services, closes the socket, and removes
		// the lock. No SIGKILL: a clean drain is the contract (a-AC-5).
		process.kill(pid, "SIGTERM");
		return true;
	} catch {
		return false;
	}
}

/**
 * The injectable seams the service-aware lifecycle resolves the OS service manager + controller
 * through (PRD-064h test discipline). Production leaves these UNSET → real env detection + the real
 * `createDaemonServiceController` (which shells out fixed-argv behind its own injected runner). A
 * unit test injects a fixed `manager` + a recording `controllerFor` so the argv/path is asserted
 * WITHOUT touching the host's service manager, and the spawn fallback is exercised by forcing
 * `manager: null`.
 */
export interface DaemonLifecycleOptions {
	/**
	 * The resolved OS service manager, or `null` to force the detached-spawn fallback (CI, locked-down
	 * hosts, the existing tests). Defaults to {@link detectServiceManager} (cheap + side-effect-free).
	 */
	readonly serviceManager?: ServiceManager | null;
	/** Build the controller for a manager. Defaults to the real {@link createDaemonServiceController}. */
	readonly controllerFor?: (manager: ServiceManager) => DaemonServiceController;
}

/**
 * Build the real {@link DaemonLifecycle} (b-AC-2 / b-AC-3 + PRD-064h AC-064h.5/.6).
 *
 * ── Service-preferred, spawn-fallback (PRD-064h HC-1) ────────────────────────
 * When an OS service manager is available ({@link detectServiceManager} returns non-null), `start`
 * REGISTERS + starts the daemon as a userland service (launchd LaunchAgent / systemd --user /
 * per-user Scheduled Task), making the service the LIVENESS FLOOR (restart-on-crash + start-on-boot).
 * Where registration is impossible / opted out (`HONEYCOMB_DAEMON_SERVICE=spawn`, CI, the tests),
 * detection returns `null` and `start` falls back to the existing detached spawn. A service
 * register/start that THROWS (binary missing, permission denied) also falls back to spawn, so a
 * half-configured host never strands the user with no daemon.
 *
 * `stop`/`status` reflect+control the SAME path: in service mode they go through the manager (and
 * status reports the supervising manager); in fallback mode they use the 021a PID/lock + SIGTERM.
 * `restart` (AC-064h.5) prefers the service manager (`kickstart`/`restart`/task re-run) so HiveDoctor's
 * rung-1 never double-spawns; the 021a single-instance guard prevents any double-bind. Never imports
 * the composition root (D-2).
 */
export function buildDaemonLifecycle(client: DaemonClient, options: DaemonLifecycleOptions = {}): DaemonLifecycle {
	const manager: ServiceManager | null = options.serviceManager !== undefined ? options.serviceManager : detectServiceManager();
	const controllerFor = options.controllerFor ?? ((m: ServiceManager): DaemonServiceController => createDaemonServiceController(m));
	// Lazily build the controller once (only when a manager is present). A controller construction
	// that throws (e.g. a missing runner dep) degrades to spawn, never crashes `start`.
	let controller: DaemonServiceController | null = null;
	function serviceController(): DaemonServiceController | null {
		if (manager === null) return null;
		if (controller === null) {
			try {
				controller = controllerFor(manager);
			} catch {
				return null;
			}
		}
		return controller;
	}

	return {
		async start(): Promise<{ readonly started: boolean; readonly alreadyRunning: boolean }> {
			if (await client.ping()) return { started: false, alreadyRunning: true };

			// Service-preferred (PRD-064h): register + start through the OS manager so the service is the
			// liveness floor. A register that throws (binary missing / permission) falls back to spawn.
			const svc = serviceController();
			if (svc !== null) {
				try {
					svc.register(buildServiceSpec());
					// The manager (RunAtLoad/enable --now/`/Run`) starts it; wait for /health to confirm.
					if (await waitForHealth(client)) return { started: true, alreadyRunning: false };
					// Registered but not yet answering: report not-yet-started; status() distinguishes
					// "warming up" from "failed" exactly as the spawn path does. Do NOT also spawn, that
					// would race the service for the 3850 bind.
					return { started: false, alreadyRunning: false };
				} catch {
					// Service registration unavailable on this host → fall through to the spawn fallback.
				}
			}

			// FALLBACK (HC-1): the documented detached spawn for hosts without a service manager.
			return spawnDaemonAndWait(client);
		},

		async stop(): Promise<{ readonly stopped: boolean }> {
			// Service mode: stop THROUGH the manager so it does not immediately restart the daemon
			// (KeepAlive/Restart=always would otherwise treat a SIGTERM as a crash and respawn).
			const svc = serviceController();
			if (svc !== null) {
				try {
					svc.stop(buildServiceSpec());
					return { stopped: true };
				} catch {
					// Fall through to the PID/lock signal path if the manager stop is unavailable.
				}
			}
			return { stopped: await signalDaemonStop() };
		},

		async status(): Promise<DaemonStatus> {
			const pid = await readDaemonPid();
			const running = pid !== null && isPidAlive(pid);
			// Reflect the supervising manager when the daemon runs as a registered service, so
			// `daemon status` can say "running as a launchd service" honestly.
			const svc = serviceController();
			let serviceManager: ServiceManager | undefined;
			if (svc !== null) {
				try {
					if (svc.isRegistered(buildServiceSpec())) serviceManager = svc.manager;
				} catch {
					// A status probe failure must never throw out of `status()`, omit the manager bit.
				}
			}
			if (running) {
				return serviceManager !== undefined
					? { running, pid, port: DAEMON_PORT, serviceManager }
					: { running, pid, port: DAEMON_PORT };
			}
			return serviceManager !== undefined
				? { running: false, port: DAEMON_PORT, serviceManager }
				: { running: false, port: DAEMON_PORT };
		},

		async restart(): Promise<{ readonly restarted: boolean; readonly viaService: boolean }> {
			// AC-064h.5: prefer the service manager (kickstart / systemctl restart / schtasks stop+run)
			// so HiveDoctor's rung-1 restart goes THROUGH the service, never a second spawn that would
			// fight the service for the 3850 bind. The 021a PID/lock guard prevents any double-bind.
			const svc = serviceController();
			if (svc !== null && svc.isRegistered(buildServiceSpec())) {
				try {
					svc.restart(buildServiceSpec());
					const ok = await waitForHealth(client);
					return { restarted: ok, viaService: true };
				} catch {
					// Fall through to the spawn-based stop+start if the manager restart is unavailable.
				}
			}
			// FALLBACK: stop (SIGTERM via PID/lock) then start (which itself prefers service, else spawn).
			await signalDaemonStop();
			const { started, alreadyRunning } = await spawnDaemonAndWait(client);
			return { restarted: started || alreadyRunning, viaService: false };
		},
	};
}

/**
 * The auth-passthrough seam (FR-4 / b-AC-4 + PRD-023 Wave 3). Routes every tenancy verb:
 *   - `login` / `logout` → {@link authMain}: the REAL PRD-023 `api.deeplake.ai` device flow /
 *     headless token login (`HONEYCOMB_TOKEN` / `--token`), writing the SHARED
 *     `~/.deeplake/credentials.json` at 0600 (real `fetch` + the validated browser opener defaulted in).
 *   - `whoami` → {@link whoamiMain}: GET /me identity (AC-3) — user / org / workspace, never the token.
 *   - `org` (`list`/`switch`) / `workspace` (`list`/`switch`/`use`) / `workspaces` → {@link orgMain}:
 *     PRD-023 Wave 3 migrated these onto the REAL Wave-2 auth client (AC-4 / AC-5). The `org switch`
 *     re-mint and the `org/workspace list` calls hit `api.deeplake.ai` directly; no stub issuer is
 *     passed, so the real client (bound to the credential's `apiUrl`) is constructed on demand.
 */
export function buildAuthPassthrough(): AuthPassthrough {
	return {
		async dispatch(args: readonly string[]): Promise<number> {
			const verb = args[0] ?? "";
			const tail = args.slice(1);
			if (verb === "login" || verb === "logout") {
				// PRD-023: login/logout use the real deeplake flows (real fetch + validated opener defaulted).
				const result = await authMain([verb, ...tail]);
				return result.exitCode;
			}
			if (verb === "whoami") {
				// AC-3: GET /me identity. The real client is constructed from the credential's apiUrl.
				const result = await whoamiMain(tail);
				return result.exitCode;
			}
			if (verb === "project") {
				// PRD-049d: the PROJECT level (`list`/`bind`/`use`/`status`). Thin-client only — it writes
				// the local `~/.deeplake/projects.json` binding store and reports the per-cwd resolved
				// scope; no `api.deeplake.ai` call, no token re-mint, no machine-global mutation.
				const result = projectMain(tail);
				return result.exitCode;
			}
			// `org` / `workspace` / `workspaces` route to the tenancy dispatcher. PRD-023 Wave 3 drives
			// the list/switch verbs through the REAL `api.deeplake.ai` client (no stub issuer needed).
			const result = await orgMain([verb, ...tail]);
			return result.exitCode;
		},
	};
}

/**
 * The org-drift healer seam (FR-8 / b-AC-4 / b-AC-5). Reuses 011b's {@link healOrgDrift} (decode
 * the JWT, compare the `org_id` claim with the active org, re-mint on mismatch) — NOT reimplemented.
 * The active org is the credential's own org in local single-user mode; a drift only arises when an
 * env override (`HONEYCOMB_ORG_ID`) disagrees with the token claim. Best-effort: never throws.
 *
 * ── C-1 GUARD: never clobber the SHARED real credential with a locally-minted STUB ────────────
 * PRD-023 made `~/.deeplake/credentials.json` a SHARED file (Honeycomb + Hivemind). In LOCAL
 * single-user mode {@link buildRealTokenIssuer} returns the stub issuer (no `HONEYCOMB_AUTH_URL`),
 * whose `reMint` mints a LOCAL stub token. If we let {@link healOrgDrift} re-mint through that stub
 * on a drift, it would OVERWRITE the shared file's REAL `api.deeplake.ai` token with a stub —
 * silently breaking real DeepLake auth for BOTH tools.
 *
 * The drift healer runs in the OFFLINE `status` path, so it cannot safely call the real Wave-2
 * client (that would put a network round-trip in `status` — undesirable). So we GUARD instead
 * (option #2): when the stored credential is bound to the REAL backend (its `apiUrl` is the
 * canonical `https://api.deeplake.ai`) AND the active org drifts from the token's verified org, we
 * REFUSE to run the stub healer — the shared file is left intact and the drift is SURFACED to the
 * user (`honeycomb org switch <org>` re-mints a REAL token via the real client). The stub healer is
 * only ever allowed to write in a LOCAL/stub context (no real `apiUrl`), never over real shared creds.
 */
export function buildOrgDriftHealer(creds: Credentials | null, dir?: string): OrgDriftHealer {
	const issuer = buildRealTokenIssuer();
	const activeOrg = process.env.HONEYCOMB_ORG_ID ?? creds?.orgId ?? "local";
	return {
		async heal() {
			// C-1: inspect the RAW disk credential (the in-memory `Credentials` drops `apiUrl`). When the
			// stored credential targets the REAL backend, a stub re-mint here would clobber a real token
			// over the shared file — so detect the drift WITHOUT minting and surface it instead.
			const disk = loadDiskCredentials(dir);
			if (disk !== null && isRealBackendCredential(disk.apiUrl)) {
				const claims = verifyTokenClaims(disk.token);
				const tokenOrg = claims?.org;
				// A verifiable token whose org disagrees with the active org IS a drift — but on REAL
				// shared creds we never re-mint via the stub. Leave the file untouched, surface the drift.
				if (tokenOrg !== undefined && tokenOrg !== activeOrg) {
					return { kind: "drift-surfaced", to: activeOrg };
				}
				// Aligned (or an unverifiable token we won't risk re-minting over): no write, no clobber.
				return { kind: "aligned" };
			}

			// LOCAL/stub context (no real `apiUrl`): the existing best-effort heal is safe — it only ever
			// mints + writes a stub over a stub, never over a real shared credential.
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

/**
 * C-1 — true when a stored credential's `apiUrl` points at the REAL DeepLake backend
 * ({@link DEFAULT_DEEPLAKE_API_URL}, `https://api.deeplake.ai`), the trailing slash tolerated. A
 * credential on the real backend MUST NOT be re-minted through the local STUB issuer (that would
 * clobber the shared file). A missing/empty `apiUrl` is treated as NON-real (a legacy or local
 * credential), so the local single-user heal path still runs for genuinely local creds.
 */
function isRealBackendCredential(apiUrl: string | undefined): boolean {
	if (apiUrl === undefined || apiUrl.length === 0) return false;
	return apiUrl.replace(/\/+$/, "") === DEFAULT_DEEPLAKE_API_URL;
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
