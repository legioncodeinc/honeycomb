/**
 * Cursor extension barrel — PRD-020c (the extension shell).
 *
 * The public surface: the {@link ExtensionHost} seam (the `vscode`-free editor abstraction) +
 * {@link createFakeExtensionHost}, the {@link EXTENSION_COMMANDS} command list, the
 * {@link HookWiring} + {@link SkillSync} seams (019a reuse, D-4) + their connector-backed
 * factories ({@link connectorHookWiring} / {@link connectorSkillSync}), the
 * {@link DashboardWebviewRenderer} seam (020b reuse, D-6) + its {@link dashboardWebviewRenderer}
 * factory, the {@link StatusBarHealthSource} seam (020d) + its {@link healthSourceFromCheck}
 * adapter, the {@link LoginFlow} seam (011b reuse → shared 0600 creds, c-AC-5) + fake, the
 * {@link renderDashboardHtml} / {@link paintStatusBar} painters, and the {@link activate} entry.
 * Wave 2 fills the activate body + the seam factories; the real `vscode`-bound `ExtensionHost`,
 * the Wave-2 `CursorConnector`, and the device-flow login binding are the DEFERRED assembly step
 * (D-7). See CONVENTIONS.md before extending.
 */

export {
	CREDENTIALS_FILE_MODE,
	type DashboardWebviewRenderer,
	EXTENSION_COMMAND_LIST,
	EXTENSION_COMMANDS,
	type ExtensionCommandId,
	type ExtensionHost,
	type FakeExtensionHost,
	type FakeLoginFlow,
	createFakeExtensionHost,
	createFakeLoginFlow,
	type HookWiring,
	type LoginFlow,
	type LoginMode,
	type LoginResult,
	notImplemented,
	type SkillSync,
	type StatusBarHealthSource,
	type StatusBarItem,
	type WebviewPanel,
} from "./contracts.js";

export {
	connectorHookWiring,
	connectorSkillSync,
	dashboardWebviewRenderer,
	healthSourceFromCheck,
} from "./bindings.js";

export {
	escapeHtml,
	FAIL_GLYPH,
	OK_GLYPH,
	paintStatusBar,
	renderDashboardHtml,
	type StatusBarPaint,
	type StatusDimensionLine,
} from "./render.js";

export {
	activate,
	deactivate,
	type ExtensionDeps,
	type ExtensionInstance,
} from "./extension.js";
