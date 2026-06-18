/**
 * The Cursor extension entry — PRD-020c (FR-1..FR-9). The SHELL `activate`.
 *
 * `activate(host, deps)` registers the four commands (Wire/Refresh Hooks, Login, Open
 * Dashboard, Sync Skills), creates the D1–D5 status bar + paints it, and runs the activation-time
 * skill sync + bundle self-heal. It binds the editor capabilities through the {@link ExtensionHost}
 * SEAM (never importing `vscode`), the hook wiring through the {@link HookWiring} seam (019a
 * reuse, D-4), the webview through the {@link DashboardWebviewRenderer} seam (020b reuse, D-6),
 * the health into the status bar through the {@link StatusBarHealthSource} seam (020d), and the
 * no-terminal login through the {@link LoginFlow} seam (011b reuse → shared 0600 creds, c-AC-5).
 *
 * ── References gate (FR-8 / D-3 — documented convention) ─────────────────────
 *   The host capabilities this shell binds mirror the VS Code / Cursor extension API:
 *   `commands.registerCommand`, `window.createStatusBarItem`, `window.createWebviewPanel`
 *   (`webview.html`), and `env.openExternal`. The hook config this shell wires is Cursor's
 *   `~/.cursor/hooks.json` (the 1.7+ hooks harness: event arrays of `{ type, command, timeout }`
 *   command objects, NO outer `{ hooks: [...] }` wrapper) — but the merge itself is DELEGATED to
 *   the 019a connector (D-4), never re-implemented here. No `references/cursor/` sibling repo
 *   exists in this repo (D-3), so the protocol is cited here as the documented contribution-gate
 *   convention. (Sources: Cursor hooks.json — the 1.7+ lifecycle event map; the VS Code Extension
 *   API — `commands`/`window`/`env`. The real `vscode`-bound {@link ExtensionHost} adapter is the
 *   DEFERRED assembly step, D-7.)
 *
 * The real `ExtensionHost` (a `vscode`-bound adapter) is the DEFERRED assembly step (D-7) — no
 * editor binding is claimed live this wave; the shell is constructed-and-tested behind the seam.
 */

import {
	type DashboardWebviewRenderer,
	EXTENSION_COMMANDS,
	type ExtensionHost,
	type HookWiring,
	type LoginFlow,
	type LoginMode,
	type SkillSync,
	type StatusBarHealthSource,
	type StatusBarItem,
	type WebviewPanel,
} from "./contracts.js";
import { paintStatusBar } from "./render.js";

/**
 * The seams `activate` wires (FR-1..FR-9). All injected so a Wave-2 test drives the whole
 * shell against fakes (a {@link FakeExtensionHost}, a `HookWiring`/`SkillSync` over a 019a
 * connector backed by `FakeFs`, a fake webview renderer, a fake health source, a fake login
 * flow) with no editor, no daemon, and no real `~/.cursor`.
 */
export interface ExtensionDeps {
	/** Hook wiring (Wire/Refresh + self-heal) — 019a reuse (D-4). */
	readonly hooks: HookWiring;
	/** Skill symlink sync (no-clobber) — 019a reuse (D-4). */
	readonly skills: SkillSync;
	/** The dashboard webview renderer — 020b reuse (D-6). */
	readonly dashboard: DashboardWebviewRenderer;
	/** The D1–D5 status-bar health source — 020d (the boundary). */
	readonly health: StatusBarHealthSource;
	/** The no-terminal login flow — 011b reuse → shared 0600 creds (FR-5 / c-AC-5). */
	readonly login: LoginFlow;
	/**
	 * The login mode the `honeycomb.login` command uses (FR-5). Defaults to the browser device
	 * flow; an editor that prefers API-key entry passes `"api-key"`. Injected so a test asserts
	 * both paths land the shared 0600 creds (c-AC-5).
	 */
	readonly loginMode?: LoginMode;
}

/**
 * The live extension instance `activate` returns — the editor lifecycle handle. Holds the
 * status-bar item, the open webview (if any), and the on-demand refresh the editor can re-invoke
 * (FR-4: refresh on activation + on demand). {@link deactivate} disposes it.
 */
export interface ExtensionInstance {
	/** The status-bar item the D1–D5 health is painted into. */
	readonly statusBar: StatusBarItem;
	/** Re-paint the status bar from a fresh health evaluation (FR-4 on-demand refresh). */
	refreshStatusBar(): Promise<void>;
	/** Open (or re-render) the dashboard webview embedding the 020b views (FR-6). */
	openDashboard(): Promise<WebviewPanel>;
	/** Dispose the status bar + any open webview (the editor `deactivate`). */
	dispose(): void;
}

/**
 * Activate the extension (FR-1..FR-9). Registers the four commands on `host`, creates + paints the
 * status bar from `deps.health`, and runs the activation-time skill-sync + bundle self-heal. The
 * command handlers delegate to the seams:
 *   - `wireHooks`  → `deps.hooks.wire()` then re-paint the status bar (D5 may flip, FR-2/FR-3);
 *   - `login`      → `deps.login.login(mode)` writing the shared 0600 creds, opening the device
 *                    URL via `host.openExternal` when present (FR-5 / c-AC-5);
 *   - `openDashboard` → render the 020b views to HTML into a webview (FR-6 / c-AC-6);
 *   - `syncSkills` → `deps.skills.sync()` (no-clobber, FR-7 / c-AC-2).
 * Returns the live {@link ExtensionInstance}. Constructed-and-tested behind the seam (D-7).
 */
export async function activate(host: ExtensionHost, deps: ExtensionDeps): Promise<ExtensionInstance> {
	const statusBar = host.createStatusBarItem();
	let webview: WebviewPanel | null = null;

	// FR-4: paint the D1–D5 health into the status bar, visibly flagging a failing dimension
	// (c-AC-4). Re-usable so the on-demand refresh + the post-wire refresh share one path.
	async function refreshStatusBar(): Promise<void> {
		const dimensions = await deps.health.evaluate();
		const paint = paintStatusBar(dimensions);
		statusBar.setText(paint.text);
		statusBar.setTooltip(paint.tooltip);
		statusBar.show();
	}

	// FR-6 / c-AC-6: render the canonical 020b views into a webview (D-6 — no duplicate view code).
	async function openDashboard(): Promise<WebviewPanel> {
		const html = await deps.dashboard.renderHtml();
		if (webview === null) webview = host.createWebviewPanel("Honeycomb Dashboard");
		webview.setHtml(html);
		return webview;
	}

	// ── FR-1: register the four operator commands ────────────────────────────────
	host.registerCommand(EXTENSION_COMMANDS.wireHooks, async () => {
		// FR-2 / FR-3 / c-AC-1 / c-AC-3: copy the bundle + idempotent foreign-preserving merge,
		// DELEGATED to the 019a connector (D-4). D5 (hooks wired) may flip → re-paint the bar.
		await deps.hooks.wire();
		await refreshStatusBar();
	});

	host.registerCommand(EXTENSION_COMMANDS.login, async () => {
		// FR-5 / c-AC-5: no-terminal login writing the SHARED `~/.honeycomb/credentials.json` (0600).
		const result = await deps.login.login(deps.loginMode ?? "device");
		if (result.verificationUrl !== undefined) {
			// Browser device login: open the verification URL externally (no terminal).
			await host.openExternal(result.verificationUrl);
		}
		// D4 (login) may flip → re-paint the bar.
		await refreshStatusBar();
	});

	host.registerCommand(EXTENSION_COMMANDS.openDashboard, async () => {
		await openDashboard();
	});

	host.registerCommand(EXTENSION_COMMANDS.syncSkills, async () => {
		// FR-7 / c-AC-2: symlink org/team skills without clobbering (019a `linkSkills`, D-4).
		await deps.skills.sync();
	});

	// ── Activation-time work (FR-4 / FR-7 / FR-8) ────────────────────────────────
	// FR-8: restore a bundle a marketplace auto-upgrade may have dropped (idempotent on a healthy
	// bundle). Runs FIRST so the hooks the status bar reports on are present.
	await deps.hooks.selfHeal();
	// FR-7 / c-AC-2: sync skills on activation, without clobbering existing entries.
	await deps.skills.sync();
	// FR-4: paint the status bar on activation.
	await refreshStatusBar();

	return {
		statusBar,
		refreshStatusBar,
		openDashboard,
		dispose(): void {
			if (webview !== null) {
				webview.dispose();
				webview = null;
			}
		},
	};
}

/**
 * Deactivate the extension (the editor lifecycle hook). Disposes the live instance's status bar +
 * any open webview. The editor calls this on unload; passing the instance `activate` returned makes
 * the teardown deterministic + testable (no module-global state).
 */
export function deactivate(instance?: ExtensionInstance): void {
	instance?.dispose();
}
