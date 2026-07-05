/**
 * `honeycomb install [--ref <code>]` — the bootstrap installer's daemon-up + open-dashboard
 * verb (PRD-050a, a-AC-1..6).
 *
 * ── Why this verb exists (the "open logic lives once" contract, 050a impl-note) ──────────────
 *   The two shell entrypoints (`scripts/install/install.sh`, `scripts/install/install.ps1`) own
 *   ONLY the host-bootstrap half: detect/install Node+npm (via fnm + a pinned LTS), pull the
 *   embedding deps, and `npm i -g @legioncodeinc/honeycomb`. The moment a `honeycomb` bin exists,
 *   they hand off to THIS verb for everything between "package installed" and "browser open on the
 *   dashboard." That keeps the daemon-ensure + health-gate + dashboard-open logic in ONE place
 *   (TypeScript, unit-tested) instead of duplicated across two shell dialects.
 *
 * ── What it does (composes existing seams — D-2 thin client, never a daemon-core import) ─────
 *   1. Ensure the daemon is running, HEALTH-GATED (a-AC-4): reuse {@link ensureDaemonRunning}
 *      (021b b-AC-3), which is IDEMPOTENT via the 021a PID/lock guard — an already-healthy daemon
 *      is a no-op, never a second bind of 3850 (a-AC-2). If the daemon never becomes reachable
 *      within the lifecycle's wait budget, report "daemon didn't start" + how to retry and exit
 *      NON-ZERO (a-AC-4) — no raw stack.
 *   2. Persist onboarding `phase: "installed"` + the effective `ref` through the SHARED onboarding
 *      module (a-AC-5). The ref is `--ref <code>` when given, else the build-time {@link DEFAULT_REF}
 *      (`__HONEYCOMB_REF_DEFAULT__`, default "mario"). 050c's login reads this ref; this verb only
 *      PERSISTS it (the device-flow/referral header is 050c's job, not here). The write is fail-soft
 *      — an onboarding-write hiccup never fails the install, it only logs a warning.
 *   3. Open the dashboard honestly (a-AC-6) — SOLO mode ONLY. When Hive is present (FLEET mode),
 *      the dashboard IS the Hive portal and Hive's own onboarding owns it, so this verb opens
 *      NOTHING and prints one plain line saying so (it must never race a second, competing browser
 *      window against the tab Hive already opened). In SOLO mode it probes the loopback portal URL
 *      (`http://127.0.0.1:3853/`); if reachable it opens the loopback URL (`http://127.0.0.1:3853/`),
 *      and if not reachable it opens no browser and prints one plain sentence naming the one command
 *      to install Hive. The friendly `honeycomb.local` host was dropped: it does not resolve on a
 *      normal machine, so showing it only confused users — the always-correct loopback URL is used.
 *
 * ── Idempotency (a-AC-2) ─────────────────────────────────────────────────────────────────────
 *   Re-running is safe: ensure-running short-circuits on an already-healthy daemon (no start, no
 *   double-bind), the onboarding write is a stable upsert (phase stays "installed"), and the
 *   dashboard is simply re-opened.
 *
 * ── Plain-language errors (parent AC-7) ──────────────────────────────────────────────────────
 *   Every handled failure is a single readable line on the OUT sink + a non-zero exit. This module
 *   never throws an uncaught error to the bin: the only failure path (daemon-didn't-start) is a
 *   clean `{ exitCode: 1 }` with a retry hint.
 */

import { execFileSync } from "node:child_process";
import { isAbsolute, resolve } from "node:path";
import type { Credentials } from "../daemon/runtime/auth/contracts.js";
import { loadCredentials } from "../daemon/runtime/auth/credentials-store.js";
import { defaultBrowserOpener, loginWithDeviceFlow } from "../daemon/runtime/auth/deeplake-issuer.js";
import { resolveRuntimeConfig } from "../daemon/runtime/config.js";
import {
	DEFAULT_REF,
	loadOnboarding,
	type OnboardingState,
	saveOnboarding,
} from "../daemon/runtime/onboarding/index.js";
import { type RegistryBind, registerHoneycombWithDoctor } from "../daemon/runtime/telemetry/fleet-registry.js";
import { type EmitDeps, emitTelemetry, recordVersionAndEmitUpdated } from "../daemon/runtime/telemetry/index.js";
import { DAEMON_HOST, DAEMON_PORT, HIVE_HOST, HIVE_PORT } from "../shared/constants.js";
import { classifyFleet, type FleetClassification, fleetSignalLine } from "../shared/fleet-detection.js";
import type { CommandResult, OutputSink } from "./contracts.js";
import { type DaemonVerbDeps, ensureDaemonRunning } from "./daemon.js";

/** The portal route hive serves the dashboard SPA at (ADR-0001). */
export const DASHBOARD_PATH = "/" as const;

/**
 * The always-correct loopback portal URL (`http://127.0.0.1:3853/`) — the ONLY dashboard URL the
 * SOLO install ever opens. The former friendly `honeycomb.local` host was dropped because it does
 * not resolve on a normal machine (no hosts/mDNS entry ships), so surfacing it only stranded users
 * on a non-resolving address. The daemon binds loopback only; the portal is Hive's, also on loopback.
 */
export function loopbackDashboardUrl(): string {
	return `http://${HIVE_HOST}:${HIVE_PORT}${DASHBOARD_PATH}`;
}

/** The short timeout budget for the local portal reachability probe. */
const DASHBOARD_PROBE_TIMEOUT_MS = 750;

/**
 * One plain sentence for the "portal not installed/running" branch (C-6 claim-honesty fix),
 * branched by platform so the named command is actually runnable on the user's shell. The two
 * one-liners are the CANONICAL forms the bootstrap installers document: the POSIX pipe from
 * `scripts/install/install.sh`, and the PowerShell flag-passing invocation from the
 * `scripts/install/install.ps1` header (a bare `irm | iex` pipe cannot see flags, so the
 * documented `& { ... } --products=` form is the one that works).
 */
export function dashboardPortalNotRunningMessage(platform: NodeJS.Platform = process.platform): string {
	const command =
		platform === "win32"
			? 'powershell -c "& { $(irm https://get.theapiary.sh/install.ps1) } --products=honeycomb,doctor,hive"'
			: "curl -fsSL https://get.theapiary.sh | sh -s -- --products=honeycomb,doctor,hive";
	return `Dashboard portal is not running; install it with ${command}.`;
}

/** The C-6 fallback sentence for THIS platform (what `runInstallCommand` actually prints). */
export const DASHBOARD_PORTAL_NOT_RUNNING_MESSAGE = dashboardPortalNotRunningMessage();

/**
 * The browser-opener seam (a-AC-6). Returns `true` iff it launched the URL. The production default
 * is {@link openLocalDashboardUrl}; a test injects a recorder so no real browser launches and the
 * loopback URL it opens is asserted by the URLs it was handed.
 */
export type DashboardOpener = (url: string) => boolean;

/** The local portal reachability probe seam used before opening a browser tab (C-6). */
export type DashboardProbe = () => Promise<boolean>;

/**
 * Open a LOCAL dashboard URL in the OS browser via a fixed-argv `execFileSync` (never a shell) —
 * the SAME safe-open discipline as `defaultBrowserOpener` in `deeplake-issuer.ts`, but admitting an
 * `http:` LOOPBACK URL (the auth opener is https-only because it opens a server-derived OAuth URL;
 * the dashboard URL is a fixed local loopback we construct ourselves, so `http:` is correct and
 * safe here).
 *
 * The guard still REFUSES anything that is not a parsed `http:`/`https:` URL whose host is the
 * loopback IP or `localhost` — so a malformed or non-local URL never reaches an OS opener. On open it
 * uses `open` (darwin) / `rundll32 url.dll,FileProtocolHandler` (win32, which avoids `cmd /c start`
 * re-parsing metacharacters) / `xdg-open` (linux), each fixed-argv. Returns `false` (never throws) on
 * a refused URL or a failed launch, so the caller treats a missing browser as non-fatal and prints
 * the URL instead.
 */
export function openLocalDashboardUrl(url: string): boolean {
	let safeUrl: string;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
		const host = parsed.hostname;
		const isLocal = host === DAEMON_HOST || host === "localhost" || host === "::1";
		if (!isLocal) return false;
		safeUrl = parsed.href;
	} catch {
		return false;
	}
	try {
		if (process.platform === "darwin") {
			execFileSync("open", [safeUrl], { stdio: "ignore", timeout: 5000, windowsHide: true });
		} else if (process.platform === "win32") {
			execFileSync("rundll32", ["url.dll,FileProtocolHandler", safeUrl], {
				stdio: "ignore",
				timeout: 5000,
				windowsHide: true,
			});
		} else {
			execFileSync("xdg-open", [safeUrl], { stdio: "ignore", timeout: 5000, windowsHide: true });
		}
		return true;
	} catch {
		return false;
	}
}

/** The deps the `install` verb runs against — the daemon HTTP+lifecycle seams plus injectable IO. */
export interface InstallVerbDeps extends DaemonVerbDeps {
	/** The browser opener (a-AC-6). Defaults to {@link openLocalDashboardUrl}; tests inject a recorder. */
	readonly openDashboard?: DashboardOpener;
	/** The loopback portal probe used before any browser open (C-6). */
	readonly probeDashboard?: DashboardProbe;
	/**
	 * Override the onboarding-state directory (tests point this at a temp HOME so the real
	 * `~/.deeplake/onboarding.json` is never touched). Defaults to the real shared dir.
	 */
	readonly dir?: string;
	/**
	 * Telemetry chokepoint seam (PRD-050e). The `honeycomb_installed` event emits through here AFTER
	 * the user-facing success, fire-and-forget — its injected `fetch`/`dir` let a test assert zero or
	 * one network call without touching the real PostHog. The onboarding `dir` is threaded in
	 * automatically; a test may inject `telemetry.fetch` to record/throw. Omit it entirely in production
	 * — `emitTelemetry`'s defaults apply (and an empty build key makes it a no-op).
	 */
	readonly telemetry?: EmitDeps;
	/**
	 * PRD-003a: the solo-vs-fleet classifier (a-AC-6). Defaults to the real {@link classifyFleet}
	 * (registry read + 127.0.0.1:3853 probe + npm global read). A test injects a fixed result so the
	 * fleet-defer vs solo-auto-login branch is driven without touching the network or the npm tree.
	 */
	readonly detectFleet?: () => Promise<FleetClassification>;
	/**
	 * PRD-003a: read the shared `~/.deeplake/credentials.json` (a-AC-3: only auto-login when it is
	 * ABSENT). Defaults to the real {@link loadCredentials}; a test injects a fake so no real
	 * credential file is read.
	 */
	readonly loadInstallCredentials?: () => Credentials | null;
	/**
	 * PRD-003a: run the device-flow login on the SOLO auto-login path (a-AC-3 / a-AC-7). Defaults to
	 * {@link defaultInstallDeviceLogin} (the same `loginWithDeviceFlow` `honeycomb login` runs, with
	 * the validated browser opener; headless degrades to printing the URL + code and polling). A test
	 * injects a recorder so no real browser launches and no real device flow runs.
	 */
	readonly runDeviceLogin?: (out: OutputSink) => Promise<boolean>;
}

/** Parse the effective referral code off the argv tail (`--ref <code>`), else `undefined`. */
export function parseRefArg(argv: readonly string[]): string | undefined {
	const i = argv.indexOf("--ref");
	if (i !== -1) {
		const next = argv[i + 1];
		if (next !== undefined && !next.startsWith("--") && next.length > 0) return next;
	}
	// Also accept `--ref=<code>` for parity with common CLI conventions.
	const eq = argv.find((a) => a.startsWith("--ref="));
	if (eq !== undefined) {
		const value = eq.slice("--ref=".length);
		if (value.length > 0) return value;
	}
	return undefined;
}

/**
 * Resolve the effective ref: the `--ref` override when present, else the build-time
 * {@link DEFAULT_REF} (`__HONEYCOMB_REF_DEFAULT__`, default "mario"). 050c's login reads this.
 */
export function resolveEffectiveRef(argv: readonly string[]): string {
	return parseRefArg(argv) ?? DEFAULT_REF;
}

/**
 * Parse the installer's `--home <path>` / `--home=<path>` pin (PRD-072d / ADR-0003), the chosen
 * fleet-root location. Returns the value, else `undefined` when the flag is absent/empty.
 */
export function parseHomeArg(argv: readonly string[]): string | undefined {
	const i = argv.indexOf("--home");
	if (i !== -1) {
		const next = argv[i + 1];
		if (next !== undefined && !next.startsWith("--") && next.length > 0) return next;
	}
	const eq = argv.find((a) => a.startsWith("--home="));
	if (eq !== undefined) {
		const value = eq.slice("--home=".length);
		if (value.length > 0) return value;
	}
	return undefined;
}

/**
 * Record the installer's `--home=` choice by delivering it as `APIARY_HOME` in the process
 * environment (fleet ADR Resolved decision: the `--home=` pin is delivered as `APIARY_HOME`; there is
 * NO config.json recording step). Setting it here means every downstream fleet-root resolution in
 * THIS install run agrees: the doctor registry entry advertises the overridden root, the service
 * registration pins `APIARY_HOME` into the unit (PRD-072d), and the spawned daemon inherits it.
 * A subsequent re-register with a changed root re-pins the unit. On the Windows LocalSystem enterprise
 * opt-in this is where the installer captures the installing user's home so state never lands under
 * `System32` (the pinned env wins regardless of the service account).
 */
export function applyHomeOverride(argv: readonly string[], env: NodeJS.ProcessEnv = process.env): void {
	const home = parseHomeArg(argv);
	if (home === undefined) return;
	// The resolver honors ABSOLUTE roots only (a relative value would re-anchor state on the service
	// manager's cwd). A relative `--home=` is resolved against the INSTALLER's cwd here, at capture
	// time, so the user's intent survives and the pinned value is deterministic everywhere downstream.
	env.APIARY_HOME = isAbsolute(home) ? home : resolve(home);
}

/**
 * Persist onboarding `phase: "installed"` + the effective `ref` through the SHARED onboarding store
 * (a-AC-5). FAIL-SOFT: an IO error here logs a warning and returns `false` (the install still
 * succeeds — the marker is best-effort bookkeeping, never a hard dependency). Idempotent: re-running
 * leaves `phase` at "installed" and re-stamps the same ref.
 */
function writeInstalledMarker(ref: string, dir: string | undefined, out: OutputSink): boolean {
	try {
		const current: OnboardingState = loadOnboarding(dir);
		const next: OnboardingState = { ...current, phase: "installed", ref };
		saveOnboarding(next, dir);
		return true;
	} catch {
		// Fail-soft (the onboarding file is bookkeeping, not a blocker) — never abort the install.
		out("note: could not persist the onboarding marker (continuing — the install still succeeded).");
		return false;
	}
}

/**
 * Register (or refresh) honeycomb's entry in doctor's static registry (PRD-071 Contract A /
 * AC-1 / AC-071a.1), declaring honeycomb's identity, `/health` URL, and its fleet telemetry SQLite
 * path so doctor knows honeycomb should exist and where to poll it. FAIL-SOFT (071a technical
 * considerations): a registry write error (a locked file, a missing/unwritable `~/.honeycomb`)
 * logs a note and returns `false` — it NEVER aborts the install. Idempotent: re-running REPLACES
 * the existing `honeycomb` entry in place rather than duplicating it (AC-071a.1.2).
 */
/**
 * Resolve the daemon bind (host/port) the registry entry's `healthUrl` should advertise, from the
 * SAME runtime-config resolution the daemon itself binds with (`HONEYCOMB_PORT` / `HONEYCOMB_HOST`
 * / `HONEYCOMB_BIND`), so a non-default bind advertises the right probe URL. A wildcard listen
 * address (0.0.0.0 / ::) maps to the loopback host: that is the address doctor (same machine)
 * can actually reach a wildcard-bound daemon on. FAIL-SOFT: an invalid env value falls back to the
 * shared default constants rather than failing the install.
 */
function resolveRegistryBind(): RegistryBind | undefined {
	try {
		const config = resolveRuntimeConfig();
		const host = config.host === "0.0.0.0" || config.host === "::" ? DAEMON_HOST : config.host;
		return { host, port: config.port };
	} catch {
		return undefined;
	}
}

function writeDoctorRegistryEntry(dir: string | undefined, out: OutputSink): boolean {
	try {
		const bind = resolveRegistryBind();
		registerHoneycombWithDoctor({
			...(dir !== undefined ? { homeDir: dir } : {}),
			...(bind !== undefined ? { bind } : {}),
		});
		return true;
	} catch {
		out("note: could not register with doctor (continuing — the install still succeeded).");
		return false;
	}
}

/**
 * Probe the loopback dashboard portal (`127.0.0.1:3853`) with a short timeout. Returns `true` when
 * the portal responds at all; status code does not matter because any HTTP response proves the
 * portal process is running and reachable. `timeoutMs` is injectable so a unit test can prove the
 * abort path in milliseconds instead of waiting out the production budget.
 */
export async function probeLoopbackDashboard(timeoutMs: number = DASHBOARD_PROBE_TIMEOUT_MS): Promise<boolean> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	if (typeof timer.unref === "function") timer.unref();
	try {
		await fetch(loopbackDashboardUrl(), { method: "GET", signal: controller.signal });
		return true;
	} catch {
		return false;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Open the SOLO dashboard at the always-correct loopback URL (`http://127.0.0.1:3853/`). The former
 * friendly `honeycomb.local` first-attempt was dropped (it does not resolve on a normal machine, so a
 * user was shown a non-resolving address). ALWAYS prints the URL so a headless/no-browser host still
 * learns where the dashboard lives; a failed launch is non-fatal — the run still succeeds. This is
 * called ONLY in SOLO mode; in FLEET mode Hive's onboarding owns the portal and this never runs.
 */
function openSoloDashboard(opener: DashboardOpener, out: OutputSink): void {
	const loopback = loopbackDashboardUrl();
	const opened = opener(loopback);
	out(
		opened ? `→ opening dashboard at ${loopback}…` : `→ dashboard is ready at ${loopback} (open it in your browser).`,
	);
}

/**
 * Report how the now-running daemon is supervised (PRD-064h, AC-064h.6 surfaced at install). A pure,
 * FAIL-SOFT read of `lifecycle.status()`: when the daemon runs as a registered OS service it prints
 * the supervising manager (the liveness floor); otherwise it notes the detached-spawn fallback. It
 * NEVER changes the install result: no lifecycle seam, or a status read that throws, simply skips
 * the line. The daemon was already registered+started by `ensureDaemonRunning` → `lifecycle.start()`
 * (service-preferred), so this only narrates the outcome.
 */
async function reportDaemonSupervision(deps: InstallVerbDeps, out: OutputSink): Promise<void> {
	if (deps.lifecycle === undefined) return;
	try {
		const status = await deps.lifecycle.status();
		if (status.serviceManager !== undefined) {
			out(`✓ daemon registered as an OS service (${status.serviceManager}): it restarts on crash and starts on boot.`);
		} else {
			out("note: daemon running as a detached process (OS service registration unavailable on this host).");
		}
	} catch {
		// A status read must never affect the install outcome: swallow and continue.
	}
}

/**
 * The production SOLO auto-login (PRD-003a a-AC-3 / a-AC-7): run the SAME device flow `honeycomb
 * login` runs (`loginWithDeviceFlow`) with the validated OS browser opener. It PRINTS the
 * verification URL + user code through the reporter BEFORE any open attempt, and on a headless host
 * the opener simply returns false (never throws) and the flow polls to completion — so a no-browser
 * environment degrades to "print + poll" rather than hanging or crashing (a-AC-7). Resolves `true`
 * on a persisted credential; `loginWithDeviceFlow` throws on failure, which the caller reports.
 */
async function defaultInstallDeviceLogin(out: OutputSink): Promise<boolean> {
	await loginWithDeviceFlow({
		reporter: { prompt: (line: string): void => out(line) },
		openBrowser: defaultBrowserOpener,
	});
	return true;
}

/**
 * The PRD-003a install-time login decision (a-AC-1 / a-AC-3 / a-AC-6 / a-AC-7), run from the install
 * path ONLY (never daemon boot). Classifies solo vs fleet, LOGS which signals fired (a-AC-6), then:
 *
 *   - FLEET (Hive detected): print ONE line that login is deferred to Hive onboarding and initiate
 *     NOTHING — no browser popup, no prompt (a-AC-1). The daemon sits degraded on /health until
 *     Hive-side login writes the shared credential; the 15s SELECT-1 health probe flips it healthy
 *     with no restart (a-AC-2).
 *   - SOLO with credentials already present: no popup — say the user is already signed in (a-AC-3).
 *   - SOLO with NO credentials: auto-open the device-flow popup (a-AC-3); headless degrades to
 *     printing the URL + code and polling (a-AC-7).
 *
 * Fail-soft (parent AC-9): this NEVER changes the install exit code. A detection error DEFERS
 * (suppressing a popup wrongly is cheap; opening one wrongly is the bug), and a login failure prints
 * a plain-language "run `honeycomb login`" hint rather than aborting the install.
 */
async function runInstallLoginStep(deps: InstallVerbDeps, out: OutputSink): Promise<FleetClassification> {
	let classification: FleetClassification;
	try {
		classification = await (deps.detectFleet ?? (() => classifyFleet()))();
	} catch {
		// Detection blew up: DEFER (treat as fleet) so we never pop a wrong browser NOR a competing
		// dashboard window. Actionable line, and the returned fleet classification gates the dashboard
		// step to "open nothing" too.
		out("note: could not determine solo vs fleet mode; deferring login (run `honeycomb login` to sign in).");
		return { mode: "fleet", signals: { registryHiveEntry: false, hivePortAnswering: false, hiveNpmGlobal: false }, firedSignals: [] };
	}
	// a-AC-6: the classification's inputs (which signals fired) are visible in the install output.
	out(fleetSignalLine(classification));

	if (classification.mode === "fleet") {
		// a-AC-1: defer ALL login initiation to Hive; never open a browser or prompt.
		out("→ login is deferred to Hive onboarding (Hive detected); Honeycomb connects once Hive signs in.");
		return classification;
	}

	// SOLO. Only auto-open when the shared credential is absent (a-AC-3).
	const creds = (deps.loadInstallCredentials ?? loadCredentials)();
	if (creds !== null) {
		out("✓ already signed in (existing credentials found); no browser opened.");
		return classification;
	}

	out("→ no credentials found; opening sign-in…");
	try {
		const ok = await (deps.runDeviceLogin ?? defaultInstallDeviceLogin)(out);
		out(ok ? "✓ signed in." : "note: sign-in did not complete; run `honeycomb login` to finish.");
	} catch (err) {
		// a-AC-9: a login failure is a plain-language, actionable line — never a raw stack, never a fail.
		const reason = err instanceof Error ? err.message : "sign-in failed";
		out(`note: automatic sign-in could not complete (${reason}); run \`honeycomb login\` to sign in.`);
	}
	return classification;
}

/**
 * Run `honeycomb install [--ref <code>]` (a-AC-1..6). Health-gates the daemon up (idempotent, no
 * double-bind), persists the onboarding "installed" marker + effective ref, then — in SOLO mode only —
 * opens the dashboard at the loopback URL (in FLEET mode Hive's onboarding owns the portal, so this
 * opens nothing). Every effect goes through an injected seam; a handled failure is a single readable
 * line + a non-zero exit, never a raw stack (parent AC-7).
 */
export async function runInstallCommand(argv: readonly string[], deps: InstallVerbDeps): Promise<CommandResult> {
	const out: OutputSink = deps.out ?? ((line: string): void => console.log(line));
	const opener = deps.openDashboard ?? openLocalDashboardUrl;
	const probeDashboard = deps.probeDashboard ?? probeLoopbackDashboard;
	const ref = resolveEffectiveRef(argv);
	// PRD-072d: record the `--home=` pin as APIARY_HOME BEFORE the daemon is ensured/registered, so the
	// registry write, the service-unit pin, and the spawned daemon all resolve the chosen fleet root.
	applyHomeOverride(argv);

	// 1) Health-gate the daemon (a-AC-4). ensureDaemonRunning is idempotent (a-AC-2): an already-up
	//    daemon returns at once with NO second start/bind; a down daemon is started + waited on the
	//    lifecycle's existing budget. The dashboard is opened ONLY after this returns reachable.
	out(`→ starting the Honeycomb daemon on ${DAEMON_HOST}:${DAEMON_PORT}…`);
	const reachable = await ensureDaemonRunning({
		daemon: deps.daemon,
		...(deps.lifecycle !== undefined ? { lifecycle: deps.lifecycle } : {}),
		out,
	});
	if (!reachable) {
		// a-AC-4: the daemon never bound within the wait budget. Plain-language error + retry hint;
		// NON-ZERO exit; NO dashboard open; NO raw stack.
		out("error: the daemon didn't start (it never became reachable on 127.0.0.1:3850).");
		out("       retry with `honeycomb install`, or run `honeycomb daemon start` to see the startup log.");
		return { exitCode: 1 };
	}
	out(`✓ daemon up on ${DAEMON_HOST}:${DAEMON_PORT}.`);

	// 1b) Report how the daemon is supervised (PRD-064h). `lifecycle.start()` (reached via
	//     ensureDaemonRunning above) PREFERS registering the daemon as an OS-native service (launchd /
	//     systemd --user / per-user Scheduled Task): the liveness floor that restarts it on crash and
	//     starts it on boot, and FALLS BACK to a detached spawn where registration is impossible (CI,
	//     locked-down machines). This is a pure, fail-soft READ of the now-running daemon's status so
	//     the user learns which path took effect; it NEVER alters the install outcome (a status read
	//     that throws is swallowed, and an absent lifecycle seam simply skips the line).
	await reportDaemonSupervision(deps, out);

	// 2) Persist the onboarding "installed" marker + effective ref (a-AC-5). Fail-soft.
	const wrote = writeInstalledMarker(ref, deps.dir, out);
	if (wrote) out(`✓ onboarding marked installed (ref: ${ref}).`);

	// 2b) Register (or refresh) honeycomb's doctor static-registry entry (PRD-071 Contract A).
	// Fail-soft — see `writeDoctorRegistryEntry`.
	writeDoctorRegistryEntry(deps.dir, out);

	// 2c) PRD-003a: the solo-vs-fleet login decision (a-AC-1 / a-AC-3 / a-AC-6 / a-AC-7). Fires from
	//     the install path ONLY. Fleet → defer to Hive (no popup); solo + no creds → auto device flow;
	//     solo + creds → already signed in. Fail-soft: it never changes the install exit code. The
	//     returned classification also gates the dashboard-open step below (solo-only).
	const classification = await runInstallLoginStep(deps, out);

	// 3) Open the dashboard — SOLO mode ONLY. When Hive is present (FLEET) the dashboard IS the Hive
	//    portal and Hive's own onboarding already opened it; opening a SECOND competing window here is
	//    the field bug this gate kills. So in fleet mode we open NOTHING and print one plain line.
	//    In solo mode we probe the portal first: reachable → open the loopback URL; not reachable →
	//    print one plain sentence and open no tab (C-6). FAIL-SOFT: a throwing probe (an injected seam
	//    misbehaving) degrades to the not-running branch, never a failed install.
	if (classification.mode === "fleet") {
		out("→ dashboard: the Hive portal owns it; Hive onboarding opened it, so Honeycomb opens nothing here.");
	} else {
		let portalReachable = false;
		try {
			portalReachable = await probeDashboard();
		} catch {
			portalReachable = false;
		}
		if (portalReachable) {
			openSoloDashboard(opener, out);
		} else {
			out(DASHBOARD_PORTAL_NOT_RUNNING_MESSAGE);
		}
	}

	out("✓ Honeycomb is ready.");

	// 4) Emit the `honeycomb_installed` lifecycle event (PRD-050e e-AC-1) — AFTER the user-facing
	//    success, NEVER gating it (e-AC-4). FIRE-AND-FORGET through the single chokepoint: the promise is
	//    intentionally NOT awaited (`void`), so a slow/timing-out PostHog hop never delays the installer
	//    after the success line has printed. All errors are swallowed inside `emitTelemetry`; the
	//    onboarding `dir` is threaded so the dedupe ledger lives in the same temp HOME under test. A second
	//    install run is a no-op send (e-AC-5, dedupe). Tier-1 → opt-out default; an opt-out env / empty
	//    key silences it.
	//
	//    ── the-apiary PRD-002c c-AC-5 note: this event is SCOPED, not retired ────────────────────────
	//    ADR-0002 moves the install-LIFECYCLE phone-home into the shell scripts (`install_started` /
	//    `install_completed` / `install_failed`, fired from `scripts/install/install.sh` /
	//    `install.ps1`), which is now the reliable "did an install run happen, and how did it end"
	//    signal — it survives a keyless Node build and a pre-CLI failure, neither of which
	//    `honeycomb_installed` can ever observe (it only fires from inside a successful run of THIS
	//    verb). `honeycomb_installed` is DELIBERATELY KEPT, scoped to a narrower, DIFFERENT meaning:
	//    "this machine's `honeycomb` CLI verb completed successfully, ONCE, ever" (e-AC-5's dedupe
	//    ledger enforces the "once" — repeat `honeycomb install` runs never re-fire it), correlated to
	//    the SAME onboarding `installId`/`ref` the Node-side telemetry and login event
	//    (`honeycomb_first_link`) already use. The two surfaces are structurally incapable of double
	//    counting the SAME event: they are different event NAMES, sent to the same PostHog project
	//    from two independent transports, answering two different questions (funnel/failure-rate over
	//    every install attempt, vs. one-time CLI-verb-completion-and-onboarding-correlation per
	//    machine). Retiring `honeycomb_installed` outright would lose that onboarding correlation for
	//    no gain, so this pass keeps it and documents the split here rather than deleting it.
	//
	//    The `honeycomb_updated` version checkpoint (the-apiary lifecycle telemetry) runs in the SAME
	//    fire-and-forget chain, SEQUENCED after the installed emit: both mutate the one onboarding
	//    state file (ledger / lastVersion), so running them concurrently would race a load/save and
	//    lose one write. `recordVersionAndEmitUpdated` is a one-string-compare no-op when the version
	//    is unchanged, records the baseline silently on first sighting, and emits `honeycomb_updated`
	//    (deduped per event+version) on a real change. Fail-soft always - see version-check.ts.
	const telemetryDeps: EmitDeps = {
		...(deps.telemetry ?? {}),
		...(deps.dir !== undefined ? { dir: deps.dir } : {}),
	};
	void (async () => {
		await emitTelemetry("honeycomb_installed", { ref, tier: "tier1" }, telemetryDeps);
		await recordVersionAndEmitUpdated(ref, telemetryDeps);
	})();

	return { exitCode: 0 };
}
