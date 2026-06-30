/**
 * Grok connector — installs Honeycomb lifecycle hooks into Grok Build's hook config.
 *
 * Grok merges hook definitions from `~/.grok/hooks/*.json`. Honeycomb owns a single
 * file (`honeycomb.json`) so foreign hooks in sibling files are never touched.
 * The hook shape matches Claude Code / Codex (nested matcher blocks + command handlers).
 */

import {
	type ConnectorFs,
	HarnessConnector,
	HONEYCOMB_MARKER,
	type HookHandlerEntry,
	type SkillLinkTarget,
} from "./contracts.js";

/** Injected paths so tests point the connector at temp dirs, never the real `~`. */
export interface GrokConnectorOptions {
	readonly home: string;
	readonly pluginRoot?: string;
	readonly bundleSource: string;
	readonly skillSources?: readonly string[];
}

/** Grok's native lifecycle event names (Claude/Codex compatible). */
const GROK_EVENT_MAP: Readonly<Record<string, string>> = {
	"session-start": "SessionStart",
	user_message: "UserPromptSubmit",
	"pre-tool-use": "PreToolUse",
	post_tool: "PostToolUse",
	assistant_message: "Stop",
};

/** Compiled handler files + per-event timeouts (Grok default hook timeout is 5s; we allow more). */
const GROK_HANDLERS: ReadonlyArray<{ logical: string; file: string; timeout: number }> = [
	{ logical: "session-start", file: "session-start.js", timeout: 10 },
	{ logical: "user_message", file: "capture.js", timeout: 10 },
	{ logical: "pre-tool-use", file: "pre-tool-use.js", timeout: 60 },
	{ logical: "post_tool", file: "capture.js", timeout: 15 },
	{ logical: "assistant_message", file: "capture.js", timeout: 30 },
];

/** The Grok connector. Subclass-only: overrides the four seams plus the install-proof root. */
export class GrokConnector extends HarnessConnector {
	readonly harness = "grok";

	private readonly opts: Required<Omit<GrokConnectorOptions, "skillSources">> & {
		skillSources: readonly string[];
	};

	constructor(fs: ConnectorFs, opts: GrokConnectorOptions) {
		super(fs);
		this.opts = {
			home: opts.home,
			pluginRoot: opts.pluginRoot ?? `${opts.home}/.grok/plugins/${HONEYCOMB_MARKER}`,
			bundleSource: opts.bundleSource,
			skillSources: opts.skillSources ?? [],
		};
	}

	/** SEAM 1 — Honeycomb's dedicated hook file under Grok's merged hooks directory. */
	protected configPath(): string {
		return `${this.opts.home}/.grok/hooks/honeycomb.json`;
	}

	/** SEAM 2 — compiled handlers from `harnesses/grok/bundle/`. */
	protected hookHandlers(): readonly HookHandlerEntry[] {
		return GROK_HANDLERS.map((h) => {
			const handlerPath = `${this.opts.pluginRoot}/bundle/${h.file}`;
			return {
				event: GROK_EVENT_MAP[h.logical] as string,
				handlerPath,
				sourcePath: `${this.opts.bundleSource}/${h.file}`,
				command: `node "${handlerPath}"`,
				timeout: h.timeout,
			};
		});
	}

	/** SEAM 3 — Grok skill-link target (conventional path under `~/.grok/skills`). */
	protected skillLinkTargets(): readonly SkillLinkTarget[] {
		const dir = `${this.opts.home}/.grok/skills`;
		return this.opts.skillSources.map((source) => ({ dir, source }));
	}

	/** SEAM 4 — Grok native event names. */
	protected eventNameMap(): Readonly<Record<string, string>> {
		return GROK_EVENT_MAP;
	}

	/** Grok is installed when `~/.grok` exists (the Grok Build config root). */
	protected configRoot(): string {
		return `${this.opts.home}/.grok`;
	}
}
