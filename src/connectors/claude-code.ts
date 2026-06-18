/**
 * Claude Code connector — PRD-019a reference (a-AC-5).
 *
 * The reference concrete connector proving the base is subclass-only (FR-1 / a-AC-5):
 * a new harness connector is a SMALL subclass that overrides the four seams (config
 * path, hook-handler set, skill-link targets, event-name map), never a copy-paste fork
 * of install logic. Install/uninstall behavior is INHERITED from {@link HarnessConnector}
 * — this subclass adds NO install logic, which is the whole point of a-AC-5.
 *
 * ── References gate (FR-8 / D-3) ────────────────────────────────────────────
 * The config schema + hook protocol implemented here is Claude Code's: hooks live in
 * `~/.claude/settings.json` under a top-level `hooks` object keyed by the native event
 * names (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`,
 * `SubagentStop`, `SessionEnd`), each holding matcher blocks with a `hooks` array of
 * `{ type:"command", command, timeout, async }` entries. Honeycomb's compiled handlers
 * come from `harnesses/claude-code/bundle/`; the marketplace plugin loader resolves
 * `${CLAUDE_PLUGIN_ROOT}` at runtime. No `references/claude-code/` sibling repo exists in
 * this repo (D-3), so this protocol is cited here as the documented contribution-gate
 * convention. (Source: Claude Code hooks config — `settings.json#hooks` event map; the
 * legacy `hivemind-v1/harnesses/claude-code/hooks/hooks.json` is the in-repo reference.)
 */

import {
	type ConnectorFs,
	HarnessConnector,
	HONEYCOMB_MARKER,
	type HookHandlerEntry,
	type SkillLinkTarget,
} from "./contracts.js";

/** Injected paths so a test points the whole connector at temp dirs (never the real `~`). */
export interface ClaudeCodeConnectorOptions {
	/** The user home dir (defaults to `~`). The config + skill links resolve under it. */
	readonly home: string;
	/**
	 * The plugin root the compiled handlers are written under (where the marketplace plugin
	 * loader resolves `${CLAUDE_PLUGIN_ROOT}`). Defaults to `<home>/.claude/plugins/honeycomb`.
	 */
	readonly pluginRoot?: string;
	/** The bundle source dir the compiled handlers are copied from (`harnesses/claude-code/bundle`). */
	readonly bundleSource: string;
	/** The org/team skill sources to symlink into Claude Code's skill dir. */
	readonly skillSources?: readonly string[];
}

/** Claude Code's native event names, in lifecycle order — SEAM 4 (a-AC-5). */
const CLAUDE_EVENT_MAP: Readonly<Record<string, string>> = {
	"session-start": "SessionStart",
	user_message: "UserPromptSubmit",
	"pre-tool-use": "PreToolUse",
	post_tool: "PostToolUse",
	assistant_message: "Stop",
	"session-end": "SessionEnd",
};

/** The compiled handler files + their per-event timeouts (mirrors the in-repo hooks.json). */
const CLAUDE_HANDLERS: ReadonlyArray<{ logical: string; file: string; timeout: number; async?: boolean }> = [
	{ logical: "session-start", file: "session-start.js", timeout: 10 },
	{ logical: "user_message", file: "capture.js", timeout: 10, async: true },
	{ logical: "pre-tool-use", file: "pre-tool-use.js", timeout: 60 },
	{ logical: "post_tool", file: "capture.js", timeout: 15, async: true },
	{ logical: "assistant_message", file: "capture.js", timeout: 30, async: true },
	{ logical: "session-end", file: "session-end.js", timeout: 60 },
];

/** The Claude Code connector. Subclass-only: overrides the four seams (a-AC-5). */
export class ClaudeCodeConnector extends HarnessConnector {
	readonly harness = "claude-code";

	private readonly opts: Required<Omit<ClaudeCodeConnectorOptions, "skillSources">> & {
		skillSources: readonly string[];
	};

	constructor(fs: ConnectorFs, opts: ClaudeCodeConnectorOptions) {
		super(fs);
		this.opts = {
			home: opts.home,
			pluginRoot: opts.pluginRoot ?? `${opts.home}/.claude/plugins/${HONEYCOMB_MARKER}`,
			bundleSource: opts.bundleSource,
			skillSources: opts.skillSources ?? [],
		};
	}

	/** SEAM 1 — Claude Code's hook-config file is `~/.claude/settings.json`. */
	protected configPath(): string {
		return `${this.opts.home}/.claude/settings.json`;
	}

	/** SEAM 2 — the compiled handler set from `harnesses/claude-code/bundle/` (FR-3). */
	protected hookHandlers(): readonly HookHandlerEntry[] {
		return CLAUDE_HANDLERS.map((h) => {
			const handlerPath = `${this.opts.pluginRoot}/bundle/${h.file}`;
			return {
				event: CLAUDE_EVENT_MAP[h.logical] as string,
				handlerPath,
				sourcePath: `${this.opts.bundleSource}/${h.file}`,
				// The marketplace plugin loader resolves `${CLAUDE_PLUGIN_ROOT}` at runtime; the
				// command carries the honeycomb marker so `isHoneycombEntry` reclaims it.
				command: `node "\${CLAUDE_PLUGIN_ROOT}/bundle/${h.file}"`,
				timeout: h.timeout,
				...(h.async !== undefined ? { async: h.async } : {}),
			};
		});
	}

	/** SEAM 3 — Claude Code skill-link targets: org/team skills → `~/.claude/skills/` (a-AC-6). */
	protected skillLinkTargets(): readonly SkillLinkTarget[] {
		const dir = `${this.opts.home}/.claude/skills`;
		return this.opts.skillSources.map((source) => ({ dir, source }));
	}

	/** SEAM 4 — Claude Code native event names (mirrors the 019c reference shim map). */
	protected eventNameMap(): Readonly<Record<string, string>> {
		return CLAUDE_EVENT_MAP;
	}

	/**
	 * SEAM 3.5 — Claude Code is "installed" when `~/.claude` exists (FR-7 / a-AC-4). Overrides
	 * the default (config dir) because the proof is the agent home, not the settings file.
	 */
	protected configRoot(): string {
		return `${this.opts.home}/.claude`;
	}
}
