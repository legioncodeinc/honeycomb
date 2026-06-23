/**
 * Codex connector — installs Honeycomb lifecycle hooks into Codex's user-level hook config.
 *
 * Codex uses the same nested event → matcher block → command handler shape as Claude Code, but
 * reads it from `~/.codex/hooks.json`. This subclass keeps install/uninstall inherited from the
 * shared connector base and supplies only Codex's paths, handler set, skill target, and event map.
 */

import {
	type ConnectorFs,
	HarnessConnector,
	HONEYCOMB_MARKER,
	type HookHandlerEntry,
	type SkillLinkTarget,
} from "./contracts.js";

/** Injected paths so tests point the connector at temp/in-memory dirs, never the real `~`. */
export interface CodexConnectorOptions {
	/** The user home dir (defaults to `~`). The config + skill links resolve under it. */
	readonly home: string;
	/** The plugin root the compiled handlers are written under. */
	readonly pluginRoot?: string;
	/** The bundle source dir the compiled handlers are copied from (`harnesses/codex/bundle`). */
	readonly bundleSource: string;
	/** The org/team skill sources to symlink into Codex's skill dir. */
	readonly skillSources?: readonly string[];
}

/** Codex's native lifecycle event names, in lifecycle order. */
const CODEX_EVENT_MAP: Readonly<Record<string, string>> = {
	"session-start": "SessionStart",
	user_message: "UserPromptSubmit",
	"pre-tool-use": "PreToolUse",
	post_tool: "PostToolUse",
	assistant_message: "Stop",
};

/** The compiled handler files + their per-event timeouts. */
const CODEX_HANDLERS: ReadonlyArray<{ logical: string; file: string; timeout: number }> = [
	{ logical: "session-start", file: "session-start.js", timeout: 10 },
	{ logical: "user_message", file: "capture.js", timeout: 10 },
	{ logical: "pre-tool-use", file: "pre-tool-use.js", timeout: 60 },
	{ logical: "post_tool", file: "capture.js", timeout: 15 },
	{ logical: "assistant_message", file: "capture.js", timeout: 30 },
];

/** The Codex connector. Subclass-only: overrides the four seams plus the install-proof root. */
export class CodexConnector extends HarnessConnector {
	readonly harness = "codex";

	private readonly opts: Required<Omit<CodexConnectorOptions, "skillSources">> & {
		skillSources: readonly string[];
	};

	constructor(fs: ConnectorFs, opts: CodexConnectorOptions) {
		super(fs);
		this.opts = {
			home: opts.home,
			pluginRoot: opts.pluginRoot ?? `${opts.home}/.codex/plugins/${HONEYCOMB_MARKER}`,
			bundleSource: opts.bundleSource,
			skillSources: opts.skillSources ?? [],
		};
	}

	/** SEAM 1 — Codex loads user-level hooks from `~/.codex/hooks.json`. */
	protected configPath(): string {
		return `${this.opts.home}/.codex/hooks.json`;
	}

	/** SEAM 2 — the compiled handler set from `harnesses/codex/bundle/`. */
	protected hookHandlers(): readonly HookHandlerEntry[] {
		return CODEX_HANDLERS.map((h) => {
			const handlerPath = `${this.opts.pluginRoot}/bundle/${h.file}`;
			return {
				event: CODEX_EVENT_MAP[h.logical] as string,
				handlerPath,
				sourcePath: `${this.opts.bundleSource}/${h.file}`,
				command: `node "${handlerPath}"`,
				timeout: h.timeout,
			};
		});
	}

	/** SEAM 3 — Codex skill-link target. */
	protected skillLinkTargets(): readonly SkillLinkTarget[] {
		const dir = `${this.opts.home}/.codex/skills`;
		return this.opts.skillSources.map((source) => ({ dir, source }));
	}

	/** SEAM 4 — Codex native event names. */
	protected eventNameMap(): Readonly<Record<string, string>> {
		return CODEX_EVENT_MAP;
	}

	/** Codex is installed when `~/.codex` exists. */
	protected configRoot(): string {
		return `${this.opts.home}/.codex`;
	}
}
