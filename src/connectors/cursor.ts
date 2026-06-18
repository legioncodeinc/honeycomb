/**
 * Cursor connector — PRD-020a (D-4, sibling of `claude-code.ts`).
 *
 * The second concrete connector, proving the 019a base is subclass-only (a-AC-5): a new harness
 * connector is a SMALL subclass that overrides the four seams (config path, hook-handler set,
 * skill-link targets, event-name map), never a fork of install logic. Install/uninstall is
 * INHERITED from {@link HarnessConnector} — this subclass adds NO install logic.
 *
 * `honeycomb setup` (020a `runConnectorVerb` → 019a `connectorMain`) wires Cursor through THIS
 * connector: it writes the compiled hook handlers under `~/.cursor/honeycomb/bundle/`, patches
 * `~/.cursor/hooks.json` foreign-preservingly + idempotently (the 019a engine), and symlinks
 * org/team skills into `~/.cursor/skills/`.
 *
 * ── References gate ──────────────────────────────────────────────────────────
 * The config schema + hook protocol implemented here is Cursor's: hooks live in
 * `~/.cursor/hooks.json` under a top-level `hooks` object keyed by Cursor's native event names
 * (`sessionStart`, `beforeSubmitPrompt`, `beforeShellExecution`, `postToolUse`,
 * `afterAgentResponse`, `stop`, `sessionEnd`), each holding matcher blocks with a `hooks` array
 * of `{ type:"command", command, timeout, async }` entries — the same Claude Code lingua franca
 * the 019b cursor shim (`src/hooks/cursor/shim.ts`, `CURSOR_EVENT_MAP`) targets. Honeycomb's
 * compiled handlers come from `harnesses/cursor/bundle/`.
 */

import {
	type ConnectorFs,
	HarnessConnector,
	HONEYCOMB_MARKER,
	type HookHandlerEntry,
	type SkillLinkTarget,
} from "./contracts.js";

/** Injected paths so a test points the whole connector at temp dirs (never the real `~`). */
export interface CursorConnectorOptions {
	/** The user home dir (defaults to `~`). The config + skill links resolve under it. */
	readonly home: string;
	/**
	 * The plugin root the compiled handlers are written under. Defaults to
	 * `<home>/.cursor/honeycomb` (mirrors the Claude Code `pluginRoot` convention).
	 */
	readonly pluginRoot?: string;
	/** The bundle source dir the compiled handlers are copied from (`harnesses/cursor/bundle`). */
	readonly bundleSource: string;
	/** The org/team skill sources to symlink into Cursor's skill dir. */
	readonly skillSources?: readonly string[];
}

/**
 * Cursor's native event names mapped from the logical lifecycle events — SEAM 4. Mirrors the
 * 019b `CURSOR_EVENT_MAP` (`src/hooks/cursor/shim.ts`) so the connector registers handlers under
 * exactly the native event names the cursor shim expects.
 */
const CURSOR_EVENT_MAP: Readonly<Record<string, string>> = {
	"session-start": "sessionStart",
	user_message: "beforeSubmitPrompt",
	"pre-tool-use": "beforeShellExecution",
	post_tool: "postToolUse",
	assistant_message: "stop",
	"session-end": "sessionEnd",
};

/** The compiled handler files + their per-event timeouts (mirrors the cursor hook lifecycle). */
const CURSOR_HANDLERS: ReadonlyArray<{ logical: string; file: string; timeout: number; async?: boolean }> = [
	{ logical: "session-start", file: "session-start.js", timeout: 10 },
	{ logical: "user_message", file: "capture.js", timeout: 10, async: true },
	{ logical: "pre-tool-use", file: "pre-tool-use.js", timeout: 60 },
	{ logical: "post_tool", file: "capture.js", timeout: 15, async: true },
	{ logical: "assistant_message", file: "capture.js", timeout: 30, async: true },
	{ logical: "session-end", file: "session-end.js", timeout: 60 },
];

/** The Cursor connector. Subclass-only: overrides the four 019a seams (D-4 / a-AC-5). */
export class CursorConnector extends HarnessConnector {
	readonly harness = "cursor";

	private readonly opts: Required<Omit<CursorConnectorOptions, "skillSources">> & {
		skillSources: readonly string[];
	};

	constructor(fs: ConnectorFs, opts: CursorConnectorOptions) {
		super(fs);
		this.opts = {
			home: opts.home,
			pluginRoot: opts.pluginRoot ?? `${opts.home}/.cursor/${HONEYCOMB_MARKER}`,
			bundleSource: opts.bundleSource,
			skillSources: opts.skillSources ?? [],
		};
	}

	/** SEAM 1 — Cursor's hook-config file is `~/.cursor/hooks.json`. */
	protected configPath(): string {
		return `${this.opts.home}/.cursor/hooks.json`;
	}

	/** SEAM 2 — the compiled handler set from `harnesses/cursor/bundle/` (FR-3). */
	protected hookHandlers(): readonly HookHandlerEntry[] {
		return CURSOR_HANDLERS.map((h) => {
			const handlerPath = `${this.opts.pluginRoot}/bundle/${h.file}`;
			return {
				event: CURSOR_EVENT_MAP[h.logical] as string,
				handlerPath,
				sourcePath: `${this.opts.bundleSource}/${h.file}`,
				// The command points at the honeycomb-marked compiled handler so `isHoneycombEntry`
				// reclaims it on re-install/uninstall (and never mistakes a foreign cursor hook).
				command: `node "${this.opts.pluginRoot}/bundle/${h.file}"`,
				timeout: h.timeout,
				...(h.async !== undefined ? { async: h.async } : {}),
			};
		});
	}

	/** SEAM 3 — Cursor skill-link targets: org/team skills → `~/.cursor/skills/` (a-AC-6). */
	protected skillLinkTargets(): readonly SkillLinkTarget[] {
		const dir = `${this.opts.home}/.cursor/skills`;
		return this.opts.skillSources.map((source) => ({ dir, source }));
	}

	/** SEAM 4 — Cursor native event names (mirrors the 019b cursor shim map). */
	protected eventNameMap(): Readonly<Record<string, string>> {
		return CURSOR_EVENT_MAP;
	}

	/** SEAM 3.5 — Cursor is "installed" when `~/.cursor` exists (FR-7 / a-AC-4). */
	protected configRoot(): string {
		return `${this.opts.home}/.cursor`;
	}
}
