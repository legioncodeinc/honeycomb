/**
 * The pre-auth GUIDED-SETUP gate — PRD-050b (b-AC-3 / b-AC-6).
 *
 * This is the dashboard's top-level phase switch. It polls `GET /setup/state` and renders ONE of two
 * states against the SAME running daemon (one daemon, two phases — never a second process):
 *
 *   - PRE-AUTH (no valid credential): the {@link GuidedSetup} screen — a clear "let's connect your
 *     account" panel fronted by the **"First time setup"** button (b-AC-6). The button BEGINS the
 *     on-page device flow (`POST /setup/login`, 050c) and shows the returned `user_code` + the
 *     verification link; the daemon keeps polling → mint → persist in the background.
 *   - AUTHENTICATED (a valid credential loads): the full {@link Shell} (sidebar + routed pages).
 *
 * ── The live transition is a POLL, no restart (b-AC-3) ───────────────────────
 * While on the pre-auth screen the gate polls `setupState()` on an interval. The instant the login
 * flow writes the shared credential, the next poll reports `authenticated: true` and the gate swaps
 * to the authenticated `<Shell>` — same tab, same daemon, no `honeycomb daemon restart`. This reuses
 * the exact self-hydration the shell already does from live endpoints; the gate adds only the
 * phase switch.
 *
 * ── b-AC-6: the button is PRESENT in fresh-install, ABSENT once linked ───────
 * The "First time setup" button renders ONLY in the pre-auth branch. Once `authenticated` flips true
 * the whole {@link GuidedSetup} subtree (button included) unmounts and the authenticated dashboard
 * renders instead — so the button is structurally absent in the linked state, not merely hidden.
 *
 * ── No token, no secret (parent AC-8) ────────────────────────────────────────
 * The gate reads only `/setup/state` (install metadata) and `/setup/login` (user_code + URIs). NO
 * token crosses either wire (the schemas have no token field by construction). The component holds
 * no credential and renders none.
 */

import React from "react";

import { Button } from "./primitives.js";
import { Shell, type ShellProps } from "./app.js";
import {
	createWireClient,
	FRESH_SETUP_STATE,
	type SetupStateWire,
	type SetupLoginWire,
	type SetupMigrateWire,
	type WireClient,
} from "./wire.js";

/** How often the pre-auth screen polls `/setup/state` for the live transition (ms). */
export const SETUP_POLL_MS = 2500 as const;

/** The migration sub-phases that mean "interrupted, not terminal" (d-AC-7 resume/rollback trigger). */
const NON_TERMINAL_MIGRATION_PHASES = new Set(["backup", "uninstall", "link"]);

/**
 * True when the setup state shows an INTERRUPTED migration (a non-terminal `migration.phase`) — the
 * dashboard must then present the resume/rollback affordance, NEVER a clean state (d-AC-7).
 */
export function isMigrationInterrupted(state: SetupStateWire): boolean {
	return state.migration !== undefined && NON_TERMINAL_MIGRATION_PHASES.has(state.migration.phase);
}

/**
 * True when the setup state shows a PRIOR Hivemind install that has NOT yet been migrated (d-AC-1) — the
 * dashboard renders the coexistence-warning wizard rather than the plain first-time state. Keys off the
 * derived `priorTool.hivemind === "present"` (or the raw `~/.hivemind` dir presence), and is suppressed
 * once `priorTool.hivemind === "migrated"`.
 */
export function hasUnmigratedPriorHivemind(state: SetupStateWire): boolean {
	if (state.priorTool.hivemind === "migrated") return false;
	return state.priorTool.hivemind === "present" || state.credentials.hivemind;
}

/** Props for {@link SetupGate} — the injected wire client + the asset base (same contract as {@link Shell}). */
export interface SetupGateProps {
	/** The wire client (injected by a unit test with a mocked fetch; defaults to the live one). */
	readonly client?: WireClient;
	/** The base path the host serves the logo/assets under (passed through to {@link Shell}). */
	readonly assetBase?: string;
}

/**
 * The guided-setup PRE-AUTH screen (b-AC-6). A single centered panel: the brand mark, a short
 * "connect your account" line, and the "First time setup" button that begins the on-page login. Once
 * the login grant arrives the panel shows the `user_code` + the verification link (the daemon polls →
 * persists in the background; the parent {@link SetupGate} polls `/setup/state` and swaps to the
 * dashboard when the credential lands). The migration variant (a detected prior Hivemind) is 050d.
 */
export function GuidedSetup({
	wire,
	assetBase,
	state,
}: {
	wire: WireClient;
	assetBase: string;
	state: SetupStateWire;
}): React.JSX.Element {
	const [grant, setGrant] = React.useState<SetupLoginWire | null>(null);
	const [busy, setBusy] = React.useState(false);
	const [error, setError] = React.useState(false);

	// A synchronous in-flight guard so a rapid double-click never fires two device flows.
	const inFlightRef = React.useRef(false);

	const beginSetup = React.useCallback(async (): Promise<void> => {
		if (inFlightRef.current) return;
		inFlightRef.current = true;
		setBusy(true);
		setError(false);
		const result = await wire.setupLogin();
		if (result === null) {
			// The device flow could not begin (502 / network). Show an honest error; the user can
			// retry the button or fall back to the `honeycomb login` CLI.
			setError(true);
			setBusy(false);
			inFlightRef.current = false;
			return;
		}
		setGrant(result);
		// Leave `busy` true: the page now waits for the background poll (in SetupGate) to flip to the
		// authenticated dashboard once the credential lands. The button stays disabled meanwhile.
	}, [wire]);

	// A prior Hivemind install is a HINT for the copy (050d owns the migration path); 050b only
	// surfaces it as a sub-line so the fresh-install vs has-prior-tool states read differently.
	const hasPriorHivemind = state.priorTool.hivemind === "present" || state.credentials.hivemind;

	return (
		<div
			data-testid="guided-setup"
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				gap: 18,
				minHeight: "100vh",
				padding: "28px",
				background: "var(--bg-canvas)",
				textAlign: "center",
			}}
		>
			<img src={`${assetBase}/honeycomb-memory-cluster.svg`} width={56} height={56} alt="" />
			<div style={{ display: "flex", flexDirection: "column", gap: 8, maxWidth: 460 }}>
				<h1 style={{ fontSize: "var(--text-xl)", fontWeight: 700, color: "var(--text-primary)", margin: 0, letterSpacing: "-0.02em" }}>
					Let&rsquo;s connect your account
				</h1>
				<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
					{hasPriorHivemind
						? "We found a previous Hivemind setup. Link your account to bring your memory online."
						: "Honeycomb keeps one shared memory for all your coding agents. Link your account to get started."}
				</p>
			</div>

			{grant === null ? (
				<>
					{/* b-AC-6: the "First time setup" button — present ONLY in the pre-auth (fresh-install) state. */}
					<Button variant="primary" size="lg" onClick={() => void beginSetup()} disabled={busy}>
						{busy ? "Starting setup…" : "First time setup"}
					</Button>
					{error && (
						<p data-testid="setup-error" style={{ fontSize: "var(--text-sm)", color: "var(--severity-critical)", margin: 0 }}>
							Could not start setup. Retry, or run <code>honeycomb login</code> in your terminal.
						</p>
					)}
				</>
			) : (
				// The grant arrived: show the user_code + the verification link. The daemon polls →
				// persists in the background; SetupGate's poll flips to the dashboard when it lands.
				<div data-testid="setup-grant" style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
					<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 }}>
						Enter this code to finish linking:
					</p>
					<code style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-lg)", color: "var(--honey)", letterSpacing: "0.08em" }}>
						{grant.user_code}
					</code>
					<a
						href={grant.verification_uri_complete ?? grant.verification_uri}
						target="_blank"
						rel="noreferrer"
						style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)" }}
					>
						Open the verification page
					</a>
					<span style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)" }}>Waiting for you to finish in the browser…</span>
				</div>
			)}
		</div>
	);
}

/**
 * The COEXISTENCE-WARNING wizard — PRD-050d (d-AC-1 / d-AC-2 / d-AC-3 / d-AC-4). Renders instead of the
 * plain first-time {@link GuidedSetup} when a prior, un-migrated Hivemind install is detected. It states
 * — BEFORE any destructive action — that running Hivemind and Honeycomb together is UNSUPPORTED and what
 * "Proceed with Honeycomb" does (back up + uninstall Hivemind, then reuse the shared login), then gates
 * the migrate call behind an explicit CONFIRM step (d-AC-2).
 *
 * On "Proceed" it POSTs `migrateFromHivemind`: a `migrated` result lets the parent's `/setup/state` poll
 * flip to the dashboard (no re-auth — the shared credential was adopted, d-AC-4); a `needsLogin` result
 * hands off to the on-page device flow ({@link GuidedSetup}'s login button, the 050c `--ref mario` flow);
 * an `ok:false` partial failure shows the plain-language message + the backup path (d-AC-5), never a stack.
 */
export function CoexistenceWarning({
	wire,
	assetBase,
	onNeedsLogin,
}: {
	wire: WireClient;
	assetBase: string;
	/** Called when the migration completed the uninstall but needs the device flow to finish linking (d-AC-4). */
	onNeedsLogin: () => void;
}): React.JSX.Element {
	const [confirming, setConfirming] = React.useState(false);
	const [busy, setBusy] = React.useState(false);
	const [result, setResult] = React.useState<SetupMigrateWire | null>(null);
	const inFlightRef = React.useRef(false);

	const proceed = React.useCallback(async (): Promise<void> => {
		if (inFlightRef.current) return;
		inFlightRef.current = true;
		setBusy(true);
		const r = await wire.migrateFromHivemind();
		setResult(r);
		if (r.ok && r.needsLogin === true) {
			// Uninstall done; the shared credential was not adoptable → run the 050c device flow.
			onNeedsLogin();
			return;
		}
		// `migrated` success: leave `busy` true — the parent SetupGate poll flips to the dashboard once
		// `/setup/state.authenticated` lands. A partial failure (`ok:false`) re-enables retry below.
		if (!r.ok) {
			setBusy(false);
			inFlightRef.current = false;
		}
	}, [wire, onNeedsLogin]);

	return (
		<div
			data-testid="coexistence-warning"
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				gap: 18,
				minHeight: "100vh",
				padding: "28px",
				background: "var(--bg-canvas)",
				textAlign: "center",
			}}
		>
			<img src={`${assetBase}/honeycomb-memory-cluster.svg`} width={56} height={56} alt="" />
			<div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 500 }}>
				<h1 style={{ fontSize: "var(--text-xl)", fontWeight: 700, color: "var(--text-primary)", margin: 0, letterSpacing: "-0.02em" }}>
					We found an existing Hivemind setup
				</h1>
				{/* d-AC-2: the rule + what Proceed does, stated clearly BEFORE any destructive action. */}
				<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
					Running Hivemind and Honeycomb on the same machine isn&rsquo;t supported &mdash; they share one
					memory and would collide. <strong>Proceed with Honeycomb</strong> will back up your Hivemind config,
					uninstall Hivemind, and reuse your existing DeepLake login (so you likely won&rsquo;t even need to
					sign in again).
				</p>
			</div>

			{result !== null && result.ok === false ? (
				// d-AC-5: a partial/failed uninstall — plain-language message + the backup location, retryable.
				<div data-testid="migration-error" style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center", maxWidth: 500 }}>
					<p style={{ fontSize: "var(--text-sm)", color: "var(--severity-critical)", margin: 0 }}>{result.message}</p>
					{result.backupPath !== undefined && (
						<p style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", margin: 0 }}>
							Backup saved at <code style={{ fontFamily: "var(--font-mono)" }}>{result.backupPath}</code>
						</p>
					)}
					<Button variant="primary" size="lg" onClick={() => void proceed()} disabled={busy}>
						{busy ? "Retrying…" : "Retry"}
					</Button>
				</div>
			) : !confirming ? (
				// First step: the explicit gate. The destructive migrate fires only after this confirm (d-AC-2).
				<Button variant="primary" size="lg" onClick={() => setConfirming(true)} data-testid="proceed-button">
					Proceed with Honeycomb
				</Button>
			) : (
				// Confirm step: a last explicit acknowledgement before the back-up + uninstall runs.
				<div data-testid="migration-confirm" style={{ display: "flex", flexDirection: "column", gap: 10, alignItems: "center" }}>
					<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 }}>
						This backs up and removes your Hivemind setup. Continue?
					</p>
					<div style={{ display: "flex", gap: 10 }}>
						<Button variant="secondary" size="md" onClick={() => setConfirming(false)} disabled={busy}>
							Cancel
						</Button>
						<Button variant="danger" size="md" onClick={() => void proceed()} disabled={busy} data-testid="confirm-migrate-button">
							{busy ? "Migrating…" : "Yes, proceed"}
						</Button>
					</div>
				</div>
			)}
		</div>
	);
}

/**
 * The INTERRUPTED-MIGRATION surface — PRD-050d (d-AC-7). Rendered when `/setup/state` reports a
 * NON-TERMINAL `migration.phase` (a daemon crash mid-migration). It NEVER presents the machine as cleanly
 * migrated or cleanly reverted: it states the migration was interrupted and offers RESUME (re-run the
 * idempotent migration) or ROLL BACK (restore the Hivemind backup). The backup path is shown for trust.
 */
export function MigrationInterrupted({
	wire,
	assetBase,
	state,
	onNeedsLogin,
}: {
	wire: WireClient;
	assetBase: string;
	state: SetupStateWire;
	onNeedsLogin: () => void;
}): React.JSX.Element {
	const [busy, setBusy] = React.useState<"" | "resume" | "rollback">("");
	const [message, setMessage] = React.useState<string | null>(null);
	const phase = state.migration?.phase ?? "backup";
	const backupPath = state.migration?.backupPath;

	const resume = React.useCallback(async (): Promise<void> => {
		setBusy("resume");
		const r = await wire.migrateFromHivemind();
		setMessage(r.message);
		if (r.ok && r.needsLogin === true) {
			onNeedsLogin();
			return;
		}
		// On success the parent poll flips to the dashboard; on failure leave the message + re-enable.
		if (!r.ok) setBusy("");
	}, [wire, onNeedsLogin]);

	const rollback = React.useCallback(async (): Promise<void> => {
		setBusy("rollback");
		const r = await wire.rollbackMigration();
		setMessage(r.message);
		// After a rollback the parent poll re-reads `/setup/state` (now `rolled_back`, terminal) and the
		// coexistence-warning re-renders from a clean restored state; re-enable the buttons regardless.
		setBusy("");
	}, [wire]);

	return (
		<div
			data-testid="migration-interrupted"
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				gap: 18,
				minHeight: "100vh",
				padding: "28px",
				background: "var(--bg-canvas)",
				textAlign: "center",
			}}
		>
			<img src={`${assetBase}/honeycomb-memory-cluster.svg`} width={56} height={56} alt="" />
			<div style={{ display: "flex", flexDirection: "column", gap: 10, maxWidth: 500 }}>
				<h1 style={{ fontSize: "var(--text-xl)", fontWeight: 700, color: "var(--text-primary)", margin: 0, letterSpacing: "-0.02em" }}>
					Your migration was interrupted
				</h1>
				<p style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0, lineHeight: 1.5 }}>
					A previous switch to Honeycomb didn&rsquo;t finish (it stopped at the <code>{phase}</code> step). You
					can resume it, or roll back to restore your previous Hivemind setup.
				</p>
				{backupPath !== undefined && (
					<p style={{ fontSize: "var(--text-xs)", color: "var(--text-tertiary)", margin: 0 }}>
						Backup at <code style={{ fontFamily: "var(--font-mono)" }}>{backupPath}</code>
					</p>
				)}
			</div>
			<div style={{ display: "flex", gap: 10 }}>
				<Button variant="primary" size="md" onClick={() => void resume()} disabled={busy !== ""} data-testid="resume-button">
					{busy === "resume" ? "Resuming…" : "Resume"}
				</Button>
				<Button variant="secondary" size="md" onClick={() => void rollback()} disabled={busy !== ""} data-testid="rollback-button">
					{busy === "rollback" ? "Rolling back…" : "Roll back"}
				</Button>
			</div>
			{message !== null && (
				<p data-testid="migration-interrupted-message" style={{ fontSize: "var(--text-sm)", color: "var(--text-secondary)", margin: 0 }}>
					{message}
				</p>
			)}
		</div>
	);
}

/**
 * The top-level phase gate (b-AC-3 / b-AC-6 / d-AC-1 / d-AC-7). Polls `/setup/state` and renders ONE of:
 *   - the authenticated {@link Shell} once a valid credential loads (the DERIVED source of truth);
 *   - the {@link MigrationInterrupted} resume/rollback surface when a migration is mid-flight (d-AC-7);
 *   - the {@link CoexistenceWarning} wizard when a prior un-migrated Hivemind is detected (d-AC-1);
 *   - the plain first-time {@link GuidedSetup} otherwise.
 * The poll is the live pre-auth → authenticated transition — no restart, same tab.
 *
 * The FIRST render shows the guided-setup state (the fresh-install-safe default) until the first poll
 * resolves, so a slow first read never flashes the authenticated chrome at an unlinked user.
 */
export function SetupGate({ client, assetBase = "assets" }: SetupGateProps = {}): React.JSX.Element {
	const wire = React.useMemo<WireClient>(() => client ?? createWireClient(), [client]);
	const [state, setState] = React.useState<SetupStateWire>(FRESH_SETUP_STATE);
	// Once the migration's uninstall completes but needs the device flow (d-AC-4), force the login UI
	// (GuidedSetup) even though a prior-Hivemind dir may still be reported — the user must finish linking.
	const [forceLogin, setForceLogin] = React.useState(false);

	React.useEffect(() => {
		// Once authenticated the Shell owns its own polling, so this pre-auth poll STOPS. Continuing to
		// poll here would let a single transient `/setup/state` error — `setupState()` falls back to
		// FRESH_SETUP_STATE on a failed/non-JSON response — flip `authenticated` back to false and bounce
		// a linked user out of the authenticated shell into Guided Setup.
		if (state.authenticated) return;
		let alive = true;
		const tick = async (): Promise<void> => {
			const next = await wire.setupState();
			if (alive) setState(next);
		};
		void tick();
		// Keep polling while pre-auth so the transition is live; we clear the interval on unmount and on
		// the authenticated flip (the effect re-runs and early-returns above).
		const id = setInterval(() => void tick(), SETUP_POLL_MS);
		return () => {
			alive = false;
			clearInterval(id);
		};
	}, [wire, state.authenticated]);

	// AUTHENTICATED is the DERIVED source of truth (a valid credential loads) — NOT the onboarding
	// phase. When true every guided-setup subtree unmounts and the dashboard renders.
	if (state.authenticated) {
		const shellProps: ShellProps = { client: wire, assetBase };
		return <Shell {...shellProps} />;
	}
	// d-AC-7: an interrupted migration ALWAYS wins — a half-migrated machine is never presented as a
	// clean first-time/coexistence state. Resume/rollback until the marker reaches a terminal phase.
	if (isMigrationInterrupted(state) && !forceLogin) {
		return <MigrationInterrupted wire={wire} assetBase={assetBase} state={state} onNeedsLogin={() => setForceLogin(true)} />;
	}
	// d-AC-1: a prior un-migrated Hivemind renders the coexistence-warning wizard (not the plain
	// first-time state) — unless the migration already handed off to the login flow (`forceLogin`).
	if (hasUnmigratedPriorHivemind(state) && !forceLogin) {
		return <CoexistenceWarning wire={wire} assetBase={assetBase} onNeedsLogin={() => setForceLogin(true)} />;
	}
	return <GuidedSetup wire={wire} assetBase={assetBase} state={state} />;
}
