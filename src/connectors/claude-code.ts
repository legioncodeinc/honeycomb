/**
 * Claude Code connector — registers Honeycomb as a Claude Code MARKETPLACE PLUGIN.
 *
 * ── The fix (why this is NOT a plain hooks-into-settings.json connector) ─────
 * Claude Code injects `${CLAUDE_PLUGIN_ROOT}` ONLY for PLUGIN-provided hooks. A top-level
 * `~/.claude/settings.json` hook that forks `node "${CLAUDE_PLUGIN_ROOT}/bundle/…"` is therefore
 * UNRESOLVABLE — that variable is never set for user-level hooks — so those hooks never worked on
 * their own. The correct wiring is to REGISTER Honeycomb as a Claude Code marketplace plugin via the
 * first-party `claude plugin` CLI: the plugin (`harnesses/claude-code/`) ships `.claude-plugin/
 * plugin.json` + `hooks/hooks.json`, and once installed the host sets `${CLAUDE_PLUGIN_ROOT}` so the
 * plugin's six lifecycle hooks fire. (The repo-root `.claude-plugin/marketplace.json` declares the
 * plugin with `"source": "./harnesses/claude-code"`.)
 *
 * So this connector OVERRIDES `install()`/`uninstall()` to drive `claude plugin` through the injected
 * {@link PluginCommandRunner}:
 *   - `install()`  — migrate (remove a stale `hivemind` marketplace + strip prior broken top-level
 *                    Honeycomb hooks this connector wrote), then `marketplace add <pkgRoot>` +
 *                    `marketplace update` + `install honeycomb@honeycomb`. Idempotent (every step is
 *                    a CLI no-op when already done).
 *   - `uninstall()` — `uninstall honeycomb` + `marketplace remove honeycomb`, and strip any
 *                    settings.json fallback hooks. Best-effort: a "not found" is a benign no-op.
 *   - FAIL-SOFT     — when `claude` is NOT on PATH, NEVER write broken `${CLAUDE_PLUGIN_ROOT}` hooks.
 *                    Write an ABSOLUTE-path settings.json fallback (resolved, so it actually runs)
 *                    via the inherited base machinery, and surface a clear manual-register message.
 *
 * ── Subclass thesis preserved (PRD-019a a-AC-5) ─────────────────────────────
 * The four seams (config path, hook-handler set, skill targets, event-name map) are still the only
 * harness-specific declarations; the settings.json patch/merge/foreign-preserve machinery is still
 * the inherited base's. This subclass adds plugin-registration ORCHESTRATION (the host's native
 * wiring mechanism is a CLI, not a config file) plus the resolved-path fallback — it does NOT fork
 * the config-merge engine.
 *
 * ── Boundary (FR-9 / D-2) ───────────────────────────────────────────────────
 * `src/connectors` is a NON_DAEMON_ROOT: no DeepLake, no daemon handle. Install-time filesystem +
 * one external CLI (`claude`) only.
 */

import {
	type ConnectorFs,
	type ConnectorRunResult,
	HarnessConnector,
	HONEYCOMB_MARKER,
	type HookHandlerEntry,
	type SkillLinkTarget,
} from "./contracts.js";
import { type PluginCommandRunner } from "./plugin-runner.js";

/** The marketplace + plugin name (both `honeycomb`) the `claude plugin` CLI registers under. */
export const CLAUDE_PLUGIN_NAME = HONEYCOMB_MARKER;
/** The plugin@marketplace spec `claude plugin install` takes. */
export const CLAUDE_PLUGIN_SPEC = `${CLAUDE_PLUGIN_NAME}@${CLAUDE_PLUGIN_NAME}`;
/** The stale marketplace name a pre-rename (hivemind) install left behind — removed on migration. */
export const STALE_MARKETPLACE_NAME = "hivemind";

/** Injected paths so a test points the whole connector at temp dirs (never the real `~`). */
export interface ClaudeCodeConnectorOptions {
	/** The user home dir (defaults to `~`). The config + skill links resolve under it. */
	readonly home: string;
	/**
	 * The plugin root the compiled handlers are written under for the settings.json FALLBACK (where
	 * the marketplace plugin loader resolves `${CLAUDE_PLUGIN_ROOT}`). Defaults to
	 * `<home>/.claude/plugins/honeycomb`.
	 */
	readonly pluginRoot?: string;
	/** The bundle source dir the compiled handlers are copied from (`harnesses/claude-code/bundle`). */
	readonly bundleSource: string;
	/** The org/team skill sources to symlink into Claude Code's skill dir. */
	readonly skillSources?: readonly string[];
	/**
	 * The package root holding `.claude-plugin/marketplace.json` (the dir `claude plugin marketplace
	 * add` is pointed at). For an npm install this is the package dir; for a clone it is the repo
	 * root. Required for plugin registration; absent only in the legacy hooks-vehicle tests.
	 */
	readonly packageRoot?: string;
	/**
	 * The `claude plugin …` runner. When PROVIDED, install/uninstall drive the marketplace-plugin
	 * registration (the real wiring). When OMITTED, the connector falls back to the inherited
	 * settings.json behavior (the generic-hooks-vehicle path the base/auto-wiring tests exercise).
	 */
	readonly pluginRunner?: PluginCommandRunner;
	/** An optional sink for human-facing notices (manual-register guidance on fail-soft). */
	readonly notify?: (line: string) => void;
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
	{ logical: "session-start", file: "session-start.js", timeout: 30 },
	{ logical: "user_message", file: "capture.js", timeout: 10, async: true },
	{ logical: "pre-tool-use", file: "pre-tool-use.js", timeout: 60 },
	{ logical: "post_tool", file: "capture.js", timeout: 15, async: true },
	{ logical: "assistant_message", file: "capture.js", timeout: 30, async: true },
	{ logical: "session-end", file: "session-end.js", timeout: 60 },
];

/** The Claude Code connector — registers the marketplace plugin (or a resolved-path fallback). */
export class ClaudeCodeConnector extends HarnessConnector {
	readonly harness = "claude-code";

	private readonly opts: Required<Omit<ClaudeCodeConnectorOptions, "skillSources" | "packageRoot" | "pluginRunner" | "notify">> & {
		skillSources: readonly string[];
		packageRoot?: string;
		pluginRunner?: PluginCommandRunner;
		notify?: (line: string) => void;
	};

	constructor(fs: ConnectorFs, opts: ClaudeCodeConnectorOptions) {
		super(fs);
		this.opts = {
			home: opts.home,
			pluginRoot: opts.pluginRoot ?? `${opts.home}/.claude/plugins/${HONEYCOMB_MARKER}`,
			bundleSource: opts.bundleSource,
			skillSources: opts.skillSources ?? [],
			packageRoot: opts.packageRoot,
			pluginRunner: opts.pluginRunner,
			notify: opts.notify,
		};
	}

	// ── Install/uninstall: marketplace-plugin registration (the real wiring) ──

	/**
	 * Register Honeycomb as a Claude Code marketplace plugin via the injected `claude plugin` runner.
	 * When no runner is injected (the legacy hooks-vehicle tests) the inherited settings.json install
	 * runs unchanged. When the runner reports `claude` ABSENT, fail soft to the absolute-path
	 * settings.json fallback + a manual-register notice — never a broken `${CLAUDE_PLUGIN_ROOT}` hook.
	 */
	async install(): Promise<ConnectorRunResult> {
		const runner = this.opts.pluginRunner;
		if (runner === undefined) return super.install();

		if (!runner.available()) return this.failSoftInstall();

		// Migrate first: a stale `hivemind` marketplace + any prior broken top-level Honeycomb hooks
		// this connector wrote must go before we register `honeycomb` cleanly.
		await this.migrate(runner);

		const pkgRoot = this.requirePackageRoot();
		// `marketplace add` is idempotent (re-add → "already on disk"); `update` refreshes a prior
		// registration so a re-run picks up a moved/updated checkout; `install` is idempotent
		// ("already installed"). None duplicate.
		runner.run(["plugin", "marketplace", "add", pkgRoot]);
		runner.run(["plugin", "marketplace", "update", CLAUDE_PLUGIN_NAME]);
		const installed = runner.run(["plugin", "install", CLAUDE_PLUGIN_SPEC]);
		// `enable` is a no-op when already enabled; it guarantees a previously-disabled plugin is on.
		runner.run(["plugin", "enable", CLAUDE_PLUGIN_NAME]);

		if (!installed.ok) {
			this.note(
				`Honeycomb plugin registration via \`claude plugin\` did not confirm success. ` +
					`Register manually: \`claude plugin marketplace add ${pkgRoot}\` then ` +
					`\`claude plugin install ${CLAUDE_PLUGIN_SPEC}\`.`,
			);
		}
		return { harness: this.harness, wroteConfig: installed.ok, handlers: [], skillLinks: [] };
	}

	/**
	 * Reverse the registration: `uninstall honeycomb` + `marketplace remove honeycomb` (best-effort —
	 * a "not found" is a benign no-op), and strip any settings.json fallback hooks this connector
	 * wrote. With no runner injected, the inherited settings.json uninstall runs unchanged.
	 */
	async uninstall(): Promise<ConnectorRunResult> {
		const runner = this.opts.pluginRunner;
		if (runner === undefined) return super.uninstall();

		// Always strip a settings.json fallback (a prior fail-soft install may have written one), and
		// reclaim any legacy broken top-level Honeycomb hooks — regardless of `claude` availability.
		const stripped = await super.uninstall();

		if (runner.available()) {
			runner.run(["plugin", "uninstall", CLAUDE_PLUGIN_NAME]);
			runner.run(["plugin", "marketplace", "remove", CLAUDE_PLUGIN_NAME]);
		}
		return { ...stripped, harness: this.harness };
	}

	/** Remove the stale pre-rename `hivemind` marketplace + any prior broken top-level Honeycomb hooks. */
	private async migrate(runner: PluginCommandRunner): Promise<void> {
		// Best-effort: removing an absent marketplace is a no-op ("not found"); we never gate on it.
		runner.run(["plugin", "uninstall", STALE_MARKETPLACE_NAME]);
		runner.run(["plugin", "marketplace", "remove", STALE_MARKETPLACE_NAME]);
		// Strip any prior broken top-level Honeycomb settings.json hooks this connector wrote before
		// the plugin-registration fix (they carry the honeycomb sentinel / bundle marker, so the
		// inherited strip reclaims exactly ours and preserves foreign hooks).
		await super.uninstall();
	}

	/**
	 * Fail-soft install: `claude` is not on PATH. Write the ABSOLUTE-path settings.json fallback (the
	 * inherited base machinery + the resolved-path command from {@link hookHandlers}) so capture works
	 * even without the CLI, and surface how to register the plugin manually once `claude` is present.
	 */
	private async failSoftInstall(): Promise<ConnectorRunResult> {
		this.note(
			`The \`claude\` CLI was not found on PATH, so Honeycomb wrote a direct hooks fallback to ` +
				`\`${this.configPath()}\` (resolved absolute paths). For the marketplace plugin, install ` +
				`the \`claude\` CLI, then run \`honeycomb setup\` again (or register manually: ` +
				`\`claude plugin marketplace add <package-root>\` + \`claude plugin install ${CLAUDE_PLUGIN_SPEC}\`).`,
		);
		return super.install();
	}

	/** The package root holding `.claude-plugin/marketplace.json` — required for registration. */
	private requirePackageRoot(): string {
		const root = this.opts.packageRoot;
		if (root === undefined || root.length === 0) {
			throw new Error(
				"ClaudeCodeConnector: packageRoot is required to register the marketplace plugin " +
					"(the dir holding .claude-plugin/marketplace.json).",
			);
		}
		return root;
	}

	/** Emit a human-facing notice (defaults to silence in tests; the CLI wires a real sink). */
	private note(line: string): void {
		this.opts.notify?.(line);
	}

	// ── The four subclass seams (FR-1) — still the only harness-specific bits ──

	/** SEAM 1 — Claude Code's hook-config file is `~/.claude/settings.json` (the FALLBACK target). */
	protected configPath(): string {
		return `${this.opts.home}/.claude/settings.json`;
	}

	/**
	 * SEAM 2 — the compiled handler set from `harnesses/claude-code/bundle/` (FR-3). The command uses
	 * the RESOLVED ABSOLUTE handler path, NEVER `${CLAUDE_PLUGIN_ROOT}`: this entry only ever lands in
	 * top-level `settings.json` (the fail-soft fallback), where that variable is never set. The
	 * marketplace plugin's OWN `hooks/hooks.json` is what uses `${CLAUDE_PLUGIN_ROOT}` (the host sets
	 * it there).
	 */
	protected hookHandlers(): readonly HookHandlerEntry[] {
		return CLAUDE_HANDLERS.map((h) => {
			const handlerPath = `${this.opts.pluginRoot}/bundle/${h.file}`;
			return {
				event: CLAUDE_EVENT_MAP[h.logical] as string,
				handlerPath,
				sourcePath: `${this.opts.bundleSource}/${h.file}`,
				// Resolved absolute path — the fallback hook actually runs (the plugin path is primary).
				command: `node "${handlerPath}"`,
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
	 * SEAM 3.5 — Claude Code is "installed" when `~/.claude` exists (FR-7 / a-AC-4). Overrides the
	 * default (config dir) because the proof is the agent home, not the settings file.
	 */
	protected configRoot(): string {
		return `${this.opts.home}/.claude`;
	}
}
