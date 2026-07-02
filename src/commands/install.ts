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
 *   3. Open the dashboard (a-AC-6): try `http://honeycomb.local:3850/dashboard` first (best-effort),
 *      and ALWAYS fall back to the `http://127.0.0.1:3850/dashboard` loopback URL — the run succeeds
 *      on the loopback whether or not `honeycomb.local` resolves. The open uses the reused safe
 *      fixed-argv opener ({@link openLocalDashboardUrl}); a failed browser launch is non-fatal (the
 *      URL is printed for the user to open manually).
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
import { resolveRuntimeConfig } from "../daemon/runtime/config.js";
import {
	DEFAULT_REF,
	loadOnboarding,
	type OnboardingState,
	saveOnboarding,
} from "../daemon/runtime/onboarding/index.js";
import { type RegistryBind, registerHoneycombWithHivedoctor } from "../daemon/runtime/telemetry/fleet-registry.js";
import { type EmitDeps, emitTelemetry, recordVersionAndEmitUpdated } from "../daemon/runtime/telemetry/index.js";
import { DAEMON_HOST, DAEMON_PORT, THEHIVE_HOST, THEHIVE_PORT } from "../shared/constants.js";
import type { CommandResult, OutputSink } from "./contracts.js";
import { type DaemonVerbDeps, ensureDaemonRunning } from "./daemon.js";

/**
 * The mDNS/hosts name the dashboard is attempted at FIRST (a-AC-6). It is NEVER required: if it
 * does not resolve, the open falls back to the {@link loopbackDashboardUrl} and the run still
 * succeeds. The daemon binds loopback only (it does not serve on this name); `honeycomb.local`
 * resolving to 127.0.0.1 (via a future hosts/mDNS entry) is a nicety, not a dependency.
 */
export const DASHBOARD_LOCAL_HOST = "honeycomb.local" as const;

/** The portal route thehive serves the dashboard SPA at (ADR-0001). */
export const DASHBOARD_PATH = "/" as const;

/** The best-effort friendly portal URL (`http://honeycomb.local:3853/`). */
export function localDashboardUrl(): string {
	return `http://${DASHBOARD_LOCAL_HOST}:${THEHIVE_PORT}${DASHBOARD_PATH}`;
}

/** The always-correct loopback portal URL (`http://127.0.0.1:3853/`) — the a-AC-6 fallback. */
export function loopbackDashboardUrl(): string {
	return `http://${THEHIVE_HOST}:${THEHIVE_PORT}${DASHBOARD_PATH}`;
}

/**
 * The browser-opener seam (a-AC-6). Returns `true` iff it launched the URL. The production default
 * is {@link openLocalDashboardUrl}; a test injects a recorder so no real browser launches and the
 * `honeycomb.local`→loopback fallback is asserted by the URLs it was handed.
 */
export type DashboardOpener = (url: string) => boolean;

/**
 * Open a LOCAL dashboard URL in the OS browser via a fixed-argv `execFileSync` (never a shell) —
 * the SAME safe-open discipline as `defaultBrowserOpener` in `deeplake-issuer.ts`, but admitting an
 * `http:` LOOPBACK / `honeycomb.local` URL (the auth opener is https-only because it opens a
 * server-derived OAuth URL; the dashboard URL is a fixed local loopback we construct ourselves, so
 * `http:` is correct and safe here).
 *
 * The guard still REFUSES anything that is not a parsed `http:`/`https:` URL whose host is the
 * loopback IP, `localhost`, or `honeycomb.local` — so a malformed or non-local URL never reaches an
 * OS opener. On open it uses `open` (darwin) / `rundll32 url.dll,FileProtocolHandler` (win32, which
 * avoids `cmd /c start` re-parsing metacharacters) / `xdg-open` (linux), each fixed-argv. Returns
 * `false` (never throws) on a refused URL or a failed launch, so the caller treats a missing browser
 * as non-fatal and prints the URL instead.
 */
export function openLocalDashboardUrl(url: string): boolean {
	let safeUrl: string;
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
		const host = parsed.hostname;
		const isLocal = host === DAEMON_HOST || host === "localhost" || host === "::1" || host === DASHBOARD_LOCAL_HOST;
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
 * Register (or refresh) honeycomb's entry in hivedoctor's static registry (PRD-071 Contract A /
 * AC-1 / AC-071a.1), declaring honeycomb's identity, `/health` URL, and its fleet telemetry SQLite
 * path so hivedoctor knows honeycomb should exist and where to poll it. FAIL-SOFT (071a technical
 * considerations): a registry write error (a locked file, a missing/unwritable `~/.honeycomb`)
 * logs a note and returns `false` — it NEVER aborts the install. Idempotent: re-running REPLACES
 * the existing `honeycomb` entry in place rather than duplicating it (AC-071a.1.2).
 */
/**
 * Resolve the daemon bind (host/port) the registry entry's `healthUrl` should advertise, from the
 * SAME runtime-config resolution the daemon itself binds with (`HONEYCOMB_PORT` / `HONEYCOMB_HOST`
 * / `HONEYCOMB_BIND`), so a non-default bind advertises the right probe URL. A wildcard listen
 * address (0.0.0.0 / ::) maps to the loopback host: that is the address hivedoctor (same machine)
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

function writeHivedoctorRegistryEntry(dir: string | undefined, out: OutputSink): boolean {
	try {
		const bind = resolveRegistryBind();
		registerHoneycombWithHivedoctor({
			...(dir !== undefined ? { homeDir: dir } : {}),
			...(bind !== undefined ? { bind } : {}),
		});
		return true;
	} catch {
		out("note: could not register with hivedoctor (continuing — the install still succeeded).");
		return false;
	}
}

/**
 * Open the dashboard with the `honeycomb.local`→loopback fallback (a-AC-6). Tries the friendly
 * `honeycomb.local` URL first; if that opener returns false (it could not launch, e.g. the name does
 * not resolve to a reachable opener target), falls back to the loopback URL. ALWAYS prints the URL
 * actually targeted so a headless/no-browser host still learns where the dashboard lives. A failed
 * launch is non-fatal — the run still succeeds on the printed loopback URL.
 */
function openDashboardWithFallback(opener: DashboardOpener, out: OutputSink): void {
	const friendly = localDashboardUrl();
	const loopback = loopbackDashboardUrl();
	// Best-effort friendly host first (a-AC-6) — never required. A successful OS-opener launch only means
	// the browser was handed the URL, NOT that `honeycomb.local` resolves on this machine. So even on the
	// happy path we ALSO print the always-correct loopback URL as the guaranteed fallback link — a user
	// whose `.local` name does not resolve is never stranded on a broken page with no working URL to try.
	if (opener(friendly)) {
		out(`→ opening dashboard at ${friendly}…`);
		out(`  (if that doesn't load, use ${loopback})`);
		return;
	}
	// Fall back to the always-correct loopback URL; the run succeeds regardless of the launch result.
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
 * Run `honeycomb install [--ref <code>]` (a-AC-1..6). Health-gates the daemon up (idempotent, no
 * double-bind), persists the onboarding "installed" marker + effective ref, then opens the dashboard
 * (`honeycomb.local` best-effort → loopback fallback). Every effect goes through an injected seam;
 * a handled failure is a single readable line + a non-zero exit, never a raw stack (parent AC-7).
 */
export async function runInstallCommand(argv: readonly string[], deps: InstallVerbDeps): Promise<CommandResult> {
	const out: OutputSink = deps.out ?? ((line: string): void => console.log(line));
	const opener = deps.openDashboard ?? openLocalDashboardUrl;
	const ref = resolveEffectiveRef(argv);

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

	// 2b) Register (or refresh) honeycomb's hivedoctor static-registry entry (PRD-071 Contract A).
	// Fail-soft — see `writeHivedoctorRegistryEntry`.
	writeHivedoctorRegistryEntry(deps.dir, out);

	// 3) Open the dashboard, honeycomb.local best-effort → loopback fallback (a-AC-6).
	openDashboardWithFallback(opener, out);

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
