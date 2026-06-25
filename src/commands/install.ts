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

import { type CommandResult, type OutputSink } from "./contracts.js";
import { type DaemonVerbDeps, ensureDaemonRunning } from "./daemon.js";
import {
	DEFAULT_REF,
	loadOnboarding,
	type OnboardingState,
	saveOnboarding,
} from "../daemon/runtime/onboarding/index.js";
import { type EmitDeps, emitTelemetry } from "../daemon/runtime/telemetry/index.js";
import { DAEMON_HOST, DAEMON_PORT } from "../shared/constants.js";

/**
 * The mDNS/hosts name the dashboard is attempted at FIRST (a-AC-6). It is NEVER required: if it
 * does not resolve, the open falls back to the {@link loopbackDashboardUrl} and the run still
 * succeeds. The daemon binds loopback only (it does not serve on this name); `honeycomb.local`
 * resolving to 127.0.0.1 (via a future hosts/mDNS entry) is a nicety, not a dependency.
 */
export const DASHBOARD_LOCAL_HOST = "honeycomb.local" as const;

/** The dashboard route the daemon serves the viewable host page at (mirrors 021d `/dashboard`). */
export const DASHBOARD_PATH = "/dashboard" as const;

/** The best-effort friendly dashboard URL (`http://honeycomb.local:3850/dashboard`). */
export function localDashboardUrl(): string {
	return `http://${DASHBOARD_LOCAL_HOST}:${DAEMON_PORT}${DASHBOARD_PATH}`;
}

/** The always-correct loopback dashboard URL (`http://127.0.0.1:3850/dashboard`) — the a-AC-6 fallback. */
export function loopbackDashboardUrl(): string {
	return `http://${DAEMON_HOST}:${DAEMON_PORT}${DASHBOARD_PATH}`;
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
		const isLocal =
			host === DAEMON_HOST || host === "localhost" || host === "::1" || host === DASHBOARD_LOCAL_HOST;
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
 * Open the dashboard with the `honeycomb.local`→loopback fallback (a-AC-6). Tries the friendly
 * `honeycomb.local` URL first; if that opener returns false (it could not launch, e.g. the name does
 * not resolve to a reachable opener target), falls back to the loopback URL. ALWAYS prints the URL
 * actually targeted so a headless/no-browser host still learns where the dashboard lives. A failed
 * launch is non-fatal — the run still succeeds on the printed loopback URL.
 */
function openDashboardWithFallback(opener: DashboardOpener, out: OutputSink): void {
	const friendly = localDashboardUrl();
	const loopback = loopbackDashboardUrl();
	// Best-effort friendly host first (a-AC-6) — never required.
	if (opener(friendly)) {
		out(`→ opening dashboard at ${friendly}…`);
		return;
	}
	// Fall back to the always-correct loopback URL; the run succeeds regardless of the launch result.
	const opened = opener(loopback);
	out(
		opened
			? `→ opening dashboard at ${loopback}…`
			: `→ dashboard is ready at ${loopback} (open it in your browser).`,
	);
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

	// 2) Persist the onboarding "installed" marker + effective ref (a-AC-5). Fail-soft.
	const wrote = writeInstalledMarker(ref, deps.dir, out);
	if (wrote) out(`✓ onboarding marked installed (ref: ${ref}).`);

	// 3) Open the dashboard, honeycomb.local best-effort → loopback fallback (a-AC-6).
	openDashboardWithFallback(opener, out);

	out("✓ Honeycomb is ready.");

	// 4) Emit the `honeycomb_installed` lifecycle event (PRD-050e e-AC-1) — AFTER the user-facing
	//    success, NEVER gating it (e-AC-4). Fire-and-forget through the single chokepoint: the result is
	//    intentionally ignored, all errors are swallowed inside `emitTelemetry`, and the onboarding `dir`
	//    is threaded so the dedupe ledger lives in the same temp HOME under test. A second install run is
	//    a no-op send (e-AC-5, dedupe). Tier-1 → opt-out default; an opt-out env / empty key silences it.
	await emitTelemetry(
		"honeycomb_installed",
		{ ref, tier: "tier1" },
		{ ...(deps.telemetry ?? {}), ...(deps.dir !== undefined ? { dir: deps.dir } : {}) },
	);

	return { exitCode: 0 };
}
