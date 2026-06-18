/**
 * Cursor extension contracts + seams — PRD-020c Wave 1 (the extension SHELL).
 *
 * ── THE THESIS (FR-1..FR-9 / c-AC-1 / D-2 / D-4 / D-6) ───────────────────────
 *   The Honeycomb-for-Cursor extension is operator UX ON TOP of the 019c hook shim:
 *   Wire/Refresh Hooks, no-terminal Login, a D1–D5 status bar, a dashboard webview,
 *   and skill symlink sync. It is a THIN CLIENT (D-2): it reaches the daemon ONLY
 *   through seams, opens NO DeepLake, and REUSES the 019a connector rules for hook
 *   wiring (D-4) and the 020b view layer for the webview (D-6). It forks NEITHER a
 *   second merge engine NOR a second set of views.
 *
 * ── Module home = `harnesses/cursor/extension/` ─────────────────────────────
 *   Added to `NON_DAEMON_ROOTS` (`tests/daemon/storage/invariant.test.ts`, D-2). The
 *   extension TS compiles under the repo `tsc` (the `harnesses` glob is in `include`).
 *
 * ── No `vscode`/`cursor` runtime import — the host is a SEAM ─────────────────
 *   The editor extension API is NOT a repo dependency, so the extension never imports
 *   `vscode`. Instead the {@link ExtensionHost} seam abstracts exactly the host
 *   capabilities the shell needs (register a command, set the status bar, open a
 *   webview). The real impl (a tiny `vscode`-bound adapter) is the DEFERRED assembly
 *   step (D-7); the fake drives every Wave-2 test. This keeps the shell testable + the
 *   repo `tsc`/`build` green without adding an editor dependency.
 *
 * Every export is STABLE — Wave 2 fills bodies + adds ADDITIVELY.
 */

/** Honest-stub thrower — an early call FAILS LOUD with a stable, greppable message. */
export function notImplemented(what: string): never {
	throw new Error(`PRD-020c: not implemented — ${what}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// The command list (FR-1 / c-AC-1) — what the extension registers
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The extension's registered command ids (FR-1). Stable ids the editor binds to menu
 * items / the command palette. The four operator actions: wire/refresh the hooks, log in
 * without a terminal, open the dashboard webview, and sync skills.
 */
export const EXTENSION_COMMANDS = Object.freeze({
	/** Wire / Refresh Hooks — copy the bundle + idempotent `hooks.json` merge (FR-2 / c-AC-1). */
	wireHooks: "honeycomb.wireHooks",
	/** Login — no-terminal browser device login or API-key entry (FR-5 / c-AC-5). */
	login: "honeycomb.login",
	/** Open Dashboard — the webview embedding the 020b views (FR-6 / c-AC-6). */
	openDashboard: "honeycomb.openDashboard",
	/** Sync Skills — symlink org/team skills without clobbering (FR-7 / c-AC-2). */
	syncSkills: "honeycomb.syncSkills",
} as const);

/** One command id the extension registers. */
export type ExtensionCommandId = (typeof EXTENSION_COMMANDS)[keyof typeof EXTENSION_COMMANDS];

/** The ordered command list (registration order). */
export const EXTENSION_COMMAND_LIST: readonly ExtensionCommandId[] = Object.freeze([
	EXTENSION_COMMANDS.wireHooks,
	EXTENSION_COMMANDS.login,
	EXTENSION_COMMANDS.openDashboard,
	EXTENSION_COMMANDS.syncSkills,
]);

// ─────────────────────────────────────────────────────────────────────────────
// ExtensionHost — the editor seam (FR-1 / FR-4 / FR-6 / D-7)
// ─────────────────────────────────────────────────────────────────────────────

/** A status-bar item the extension paints the D1–D5 health into (FR-4 / c-AC-4). */
export interface StatusBarItem {
	/** Set the status-bar text (e.g. a compact D1–D5 health glyph row). */
	setText(text: string): void;
	/** Set the hover tooltip (the per-dimension detail). */
	setTooltip(tooltip: string): void;
	/** Show the item. */
	show(): void;
}

/** A webview the extension opens to host the 020b dashboard (FR-6 / c-AC-6). */
export interface WebviewPanel {
	/** Set the webview HTML (the painted 020b `ViewBlock` tree). */
	setHtml(html: string): void;
	/** Dispose the panel. */
	dispose(): void;
}

/**
 * THE EXTENSION HOST SEAM (FR-1 / FR-4 / FR-6 / D-7). The editor capabilities the shell
 * needs, abstracted so the extension never imports `vscode`. The real impl is a tiny
 * `vscode`-bound adapter constructed at the DEFERRED assembly step; the
 * {@link createFakeExtensionHost} fake drives every Wave-2 test (assert a command was
 * registered, the status bar got the D1–D5 text, the webview got the embedded views).
 */
export interface ExtensionHost {
	/** Register a command handler (FR-1 / c-AC-1). */
	registerCommand(id: ExtensionCommandId, handler: () => Promise<void> | void): void;
	/** Create the status-bar item (FR-4 / c-AC-4). */
	createStatusBarItem(): StatusBarItem;
	/** Open a webview panel for the dashboard (FR-6 / c-AC-6). */
	createWebviewPanel(title: string): WebviewPanel;
	/** Open an external URL (the no-terminal browser login, FR-5 / c-AC-5). */
	openExternal(url: string): Promise<void>;
}

/** A fake {@link ExtensionHost} recording every registration/paint (for assertions). */
export interface FakeExtensionHost extends ExtensionHost {
	/** The registered command handlers, keyed by id. */
	readonly commands: ReadonlyMap<ExtensionCommandId, () => Promise<void> | void>;
	/** The status-bar item's latest text/tooltip. */
	readonly statusBar: { text: string; tooltip: string; shown: boolean };
	/** The latest webview HTML set (for the embed assertion, c-AC-6). */
	readonly webviewHtml: string | null;
	/** Every external URL opened (the login flow, c-AC-5). */
	readonly openedUrls: readonly string[];
}

/** Build an in-memory {@link FakeExtensionHost} (the seam Wave-2 extension tests drive). */
export function createFakeExtensionHost(): FakeExtensionHost {
	const commands = new Map<ExtensionCommandId, () => Promise<void> | void>();
	const statusBar = { text: "", tooltip: "", shown: false };
	const openedUrls: string[] = [];
	let webviewHtml: string | null = null;
	return {
		get commands(): ReadonlyMap<ExtensionCommandId, () => Promise<void> | void> {
			return commands;
		},
		get statusBar(): { text: string; tooltip: string; shown: boolean } {
			return statusBar;
		},
		get webviewHtml(): string | null {
			return webviewHtml;
		},
		get openedUrls(): readonly string[] {
			return openedUrls;
		},
		registerCommand(id: ExtensionCommandId, handler: () => Promise<void> | void): void {
			commands.set(id, handler);
		},
		createStatusBarItem(): StatusBarItem {
			return {
				setText(text: string): void {
					statusBar.text = text;
				},
				setTooltip(tooltip: string): void {
					statusBar.tooltip = tooltip;
				},
				show(): void {
					statusBar.shown = true;
				},
			};
		},
		createWebviewPanel(_title: string): WebviewPanel {
			void _title;
			return {
				setHtml(html: string): void {
					webviewHtml = html;
				},
				dispose(): void {
					webviewHtml = null;
				},
			};
		},
		async openExternal(url: string): Promise<void> {
			openedUrls.push(url);
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// HookWiring — REUSES the 019a connector rules (FR-2 / FR-3 / c-AC-1 / c-AC-3 / D-4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE HOOK-WIRING SEAM (FR-2 / FR-3 / c-AC-1 / c-AC-3 / D-4). Wire/Refresh Hooks copies
 * `harnesses/cursor/bundle/` → `~/.cursor/honeycomb/bundle/` and idempotently merges
 * `~/.cursor/hooks.json`, REUSING the 019a connector rules: preserve foreign hooks
 * (`isHoneycombEntry`), idempotent (`writeJsonIfChanged` → fingerprint stable on a no-op),
 * reversible. The real impl DELEGATES to the 019a `CursorConnector` (a `HarnessConnector`
 * subclass) — it does NOT fork a second merge engine (D-4). `wire()` returns whether the
 * config changed; `selfHeal()` restores a bundle symlink a marketplace upgrade may have
 * dropped (FR-8).
 */
export interface HookWiring {
	/** Copy the bundle + idempotently merge `hooks.json`, foreign-preserving (FR-2 / FR-3). */
	wire(): Promise<{ wroteConfig: boolean }>;
	/** Reverse only Honeycomb's wiring (FR-3 / reversible). */
	unwire(): Promise<void>;
	/** Restore a broken bundle symlink (the marketplace-upgrade self-heal, FR-8). */
	selfHeal(): Promise<void>;
}

/**
 * THE SKILL-SYNC SEAM (FR-7 / c-AC-2). Symlinks org/team skills into
 * `~/.cursor/skills-cursor/` and `<project>/.cursor/skills/` WITHOUT clobbering existing
 * entries — the 019a `linkSkills` rule (D-4). The real impl delegates to the connector's
 * skill-link mechanics; the fake records links for the no-clobber assertion (c-AC-2).
 */
export interface SkillSync {
	/** Symlink skills without clobbering existing entries (FR-7 / c-AC-2). Returns links created. */
	sync(): Promise<readonly string[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// The dashboard-webview + status-bar seams the shell consumes (D-6 / 020d)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE WEBVIEW EMBED SEAM (FR-6 / c-AC-6 / D-6). Renders the CANONICAL 020b dashboard views
 * to webview HTML. The real impl calls the 020b `renderDashboard(...)` (the SAME view layer
 * the daemon-served dashboard uses) and paints the `ViewBlock` tree to HTML — NO duplicate
 * view code (D-6). The fake returns canned HTML for the embed assertion. The shell does NOT
 * render views itself.
 */
export interface DashboardWebviewRenderer {
	/** Render the 020b dashboard views to webview HTML (FR-6 / c-AC-6). */
	renderHtml(): Promise<string>;
}

/**
 * THE STATUS-BAR HEALTH SEAM (FR-4 / c-AC-4 / 020d). Supplies the D1–D5 dimension states the
 * status bar paints. The real impl calls 020d's `HealthCheck.evaluate()` (the SAME D1–D5
 * engine the CLI `status` uses); the fake returns canned dimension lines. The status bar
 * SURFACES the result — it does not re-probe (the 020d boundary). The shape mirrors 020d's
 * `HealthDimension` WITHOUT importing it (the Wave-1 cross-stream decoupling); Wave 2 binds it.
 */
export interface StatusBarHealthSource {
	/** The D1–D5 dimension lines to paint (id, label, ok, optional detail). */
	evaluate(): Promise<readonly { id: string; label: string; ok: boolean; detail?: string }[]>;
}

// ─────────────────────────────────────────────────────────────────────────────
// LoginFlow — the no-terminal login seam (FR-5 / c-AC-5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * THE LOGIN SEAM (FR-5 / c-AC-5). The `honeycomb.login` command delegates here so the editor
 * user logs in WITHOUT a terminal: either a browser device login (the extension opens the
 * verification URL via {@link ExtensionHost.openExternal}, then this seam polls the token) OR an
 * API-key entry. Either way the result WRITES THE SAME `~/.honeycomb/credentials.json` (mode
 * `0600`) the CLI + daemon share (c-AC-5) — the extension never invents a second credential file.
 *
 * The real impl REUSES the 011b device-flow (`deviceFlowLogin`) + the 011a `saveCredentials`
 * (0600/0700) as the DEFERRED assembly step (D-7); the extension shell only knows this seam. A
 * test drives a {@link FakeLoginFlow} over a `FakeFs`-style credential sink, asserting the creds
 * landed at the shared path with the 0600 mode requested.
 */
export interface LoginFlow {
	/**
	 * Run a no-terminal login (FR-5). `mode` selects the browser device flow (default) or API-key
	 * entry. Returns the verification URL the caller opens externally (device flow), plus the
	 * resolved credential path once written. Writes the shared `~/.honeycomb/credentials.json` at
	 * mode `0600` (c-AC-5).
	 */
	login(mode?: LoginMode): Promise<LoginResult>;
}

/** How the user logs in without a terminal (FR-5). */
export type LoginMode = "device" | "api-key";

/** The result of a {@link LoginFlow.login} run — the URL opened + the shared creds written. */
export interface LoginResult {
	/** The verification URL opened in the browser (device flow), when any. */
	readonly verificationUrl?: string;
	/** The path the shared credentials were written to (the `~/.honeycomb/credentials.json`). */
	readonly credentialsPath: string;
	/** The POSIX mode the credentials file was written at (0o600 — c-AC-5). */
	readonly mode: number;
}

/** A fake {@link LoginFlow} recording the login mode + the (path, mode, contents) it wrote. */
export interface FakeLoginFlow extends LoginFlow {
	/** Every login attempt's mode, in order. */
	readonly attempts: readonly LoginMode[];
	/** The credential writes performed, keyed by path → { mode, contents }. */
	readonly writes: ReadonlyMap<string, { readonly mode: number; readonly contents: string }>;
}

/** The shared-credentials mode the login flow writes at (owner read/write only, c-AC-5). */
export const CREDENTIALS_FILE_MODE = 0o600;

/**
 * Build a fake {@link LoginFlow} (the seam Wave-2 login tests drive). Writes a canned credential
 * blob to the SHARED `credentialsPath` at mode {@link CREDENTIALS_FILE_MODE} (0600), recording the
 * write so a test asserts c-AC-5: login lands the creds at the shared path with 0600. `openExternal`
 * is the extension's job (the URL is returned); this fake just records mode + write.
 */
export function createFakeLoginFlow(options: {
	readonly credentialsPath: string;
	readonly verificationUrl?: string;
	readonly contents?: string;
}): FakeLoginFlow {
	const attempts: LoginMode[] = [];
	const writes = new Map<string, { mode: number; contents: string }>();
	const contents = options.contents ?? '{"token":"fake","orgId":"org","savedAt":"2026-06-18T00:00:00.000Z"}\n';
	return {
		get attempts(): readonly LoginMode[] {
			return attempts;
		},
		get writes(): ReadonlyMap<string, { readonly mode: number; readonly contents: string }> {
			return writes;
		},
		async login(mode: LoginMode = "device"): Promise<LoginResult> {
			attempts.push(mode);
			// Write the SAME shared credentials file the CLI + daemon read, at 0600 (c-AC-5).
			writes.set(options.credentialsPath, { mode: CREDENTIALS_FILE_MODE, contents });
			return {
				...(mode === "device" && options.verificationUrl !== undefined
					? { verificationUrl: options.verificationUrl }
					: {}),
				credentialsPath: options.credentialsPath,
				mode: CREDENTIALS_FILE_MODE,
			};
		},
	};
}
