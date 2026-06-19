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
 * `afterAgentResponse`, `stop`, `sessionEnd`). UNLIKE Claude Code, REAL Cursor lists each event's
 * handlers as a FLAT array of entries directly under the event key —
 * `hooks[event] = [ { command, type?, timeout?, matcher?, … } ]` — NOT the Claude-Code-style
 * nested `{ matcher?, hooks: [...] }` matcher block. (Contract: `references/cursor/hooks-schema.ts`.)
 *
 * Because the 019a base emits + merges the nested matcher-block shape, this subclass OVERRIDES the
 * config-shape seams ({@link patchConfig} emit/merge and {@link stripHoneycomb}) to produce and
 * reclaim the FLAT per-event array Cursor actually parses — while still inheriting install/uninstall
 * and PRESERVING the base's guarantees on that flat shape (foreign-preserve via
 * {@link isHoneycombEntry}, idempotent `writeJsonIfChanged`, reversible uninstall, crash-safety
 * against BOTH a pre-existing flat config AND an unlikely nested one). Honeycomb's compiled
 * handlers come from `harnesses/cursor/bundle/`.
 */

import {
	type ConfigHookEntry,
	type ConnectorFs,
	type HarnessConfig,
	HarnessConnector,
	HONEYCOMB_ENTRY_KEY,
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

	// ── Cursor FLAT-shape overrides (the real `hooks.json` contract) ──────────────
	//
	// REAL Cursor stores each event's handlers as a FLAT array of entries directly under the event
	// key: `hooks[event] = [ { command, type?, matcher?, … } ]`. The 019a base emits + merges the
	// Claude-Code-style nested `{ matcher?, hooks: [...] }` block, which Cursor cannot read (capture/
	// recall silently dead) and which crashes the base merge over a pre-existing flat entry (no
	// `.hooks` to `.filter`). These three overrides produce, merge, and strip the flat shape.

	/**
	 * Render one Honeycomb handler into a FLAT Cursor entry — `{ command, type, matcher?, timeout?,
	 * _honeycomb }` — carrying the sentinel so {@link isHoneycombEntry} reclaims exactly THIS entry
	 * on re-install/uninstall and never a foreign one. The `pre-tool-use → beforeShellExecution`
	 * handler carries a `Shell` matcher (Cursor's terminal-tool gate, the analogue of Claude Code's
	 * Bash matcher) so the VFS intercept lands on the shell command, per the 019b shim.
	 */
	protected override toConfigEntry(handler: HookHandlerEntry): ConfigHookEntry {
		const entry: ConfigHookEntry = { type: "command", command: handler.command };
		const isShellGate = handler.event === "beforeShellExecution";
		return {
			...entry,
			...(isShellGate ? { matcher: "Shell" } : {}),
			...(handler.timeout !== undefined ? { timeout: handler.timeout } : {}),
			// Cursor has NO `async` field; its concurrency model is timeout/failClosed/loop_limit.
			// We deliberately DROP `async` here so the emitted entry is honest Cursor config.
			[HONEYCOMB_ENTRY_KEY]: true,
		};
	}

	/**
	 * Merge Honeycomb's flat entries into the existing config, foreign-preserving + idempotent, in
	 * Cursor's FLAT shape (`hooks[event] = ConfigHookEntry[]`). For each event: drop any prior
	 * Honeycomb entries (a re-install refreshes ours, never duplicates), then append the current
	 * ones. Foreign FLAT entries are kept byte-identical; an (unlikely) pre-existing nested block is
	 * tolerated — its own foreign handlers are flattened forward so the merge never throws.
	 */
	protected override patchConfig(config: HarnessConfig, handlers: readonly HookHandlerEntry[]): HarnessConfig {
		const existing = flatHooks(config);
		// Null-prototype accumulator: a foreign event key like `__proto__` / `constructor` must
		// round-trip as an OWN data property, not assign through the prototype setter (which would
		// SILENTLY DROP that foreign event — a foreign-preserve violation, FR-2 / a-AC-1) — and must
		// never reach `Object.prototype`. JSON.stringify still re-emits own keys verbatim.
		const hooks: Record<string, ConfigHookEntry[]> = Object.create(null) as Record<string, ConfigHookEntry[]>;
		for (const [event, entries] of Object.entries(existing)) {
			const kept = entries.filter((e) => !this.isHoneycombEntry(e));
			if (kept.length > 0) hooks[event] = kept;
		}
		for (const handler of handlers) {
			const entry = this.toConfigEntry(handler);
			hooks[handler.event] = [...(hooks[handler.event] ?? []), entry];
		}
		return { ...config, hooks: hooks as unknown as HarnessConfig["hooks"] };
	}

	/**
	 * Strip every Honeycomb entry from the FLAT Cursor config (the uninstall counterpart of
	 * {@link patchConfig}). Each event's flat array is filtered through {@link isHoneycombEntry}; an
	 * emptied event key is removed; foreign flat entries + foreign top-level keys survive verbatim.
	 * When no event remains, the `hooks` key is dropped so the base unlinks an emptied config.
	 */
	protected override stripHoneycomb(config: HarnessConfig): HarnessConfig {
		if (config.hooks === undefined) return config;
		const existing = flatHooks(config);
		// Null-prototype accumulator — see {@link patchConfig}: keep a foreign `__proto__`-keyed event
		// as an OWN key so uninstall PRESERVES it rather than dropping it through the prototype setter.
		const hooks: Record<string, ConfigHookEntry[]> = Object.create(null) as Record<string, ConfigHookEntry[]>;
		for (const [event, entries] of Object.entries(existing)) {
			const kept = entries.filter((e) => !this.isHoneycombEntry(e));
			if (kept.length > 0) hooks[event] = kept;
		}
		const next: HarnessConfig = { ...config };
		if (Object.keys(hooks).length > 0) next.hooks = hooks as unknown as HarnessConfig["hooks"];
		else delete next.hooks;
		return next;
	}
}

/**
 * Read a config's `hooks` map as Cursor's FLAT per-event entry arrays. Crash-safety bridge: a real
 * Cursor config holds `hooks[event] = [ entry, … ]` (flat); an unlikely Claude-Code-shaped config
 * holds `hooks[event] = [ { hooks: [ entry, … ] }, … ]` (nested). This normalizes BOTH to a flat
 * entry array per event so neither the merge nor the strip ever reads `.filter` off `undefined`
 * (bug #2) — foreign handlers from a nested block are flattened forward, never dropped.
 */
function flatHooks(config: HarnessConfig): Record<string, ConfigHookEntry[]> {
	// Null-prototype accumulator so a foreign event key like `__proto__` / `constructor` lands as an
	// OWN property (preserved, not silently dropped via the prototype setter) and can never pollute
	// `Object.prototype`. The downstream merge/strip iterate this with `Object.entries`, which only
	// reads own enumerable keys — so the dangerous key is carried forward faithfully, never executed.
	const out: Record<string, ConfigHookEntry[]> = Object.create(null) as Record<string, ConfigHookEntry[]>;
	const raw = (config.hooks ?? {}) as Record<string, unknown>;
	for (const [event, value] of Object.entries(raw)) {
		if (!Array.isArray(value)) continue;
		const entries: ConfigHookEntry[] = [];
		for (const item of value) {
			if (item === null || typeof item !== "object") continue;
			const nested = (item as { hooks?: unknown }).hooks;
			if (Array.isArray(nested)) {
				// A nested matcher block: flatten its handler array forward (preserve foreign handlers).
				for (const h of nested) {
					if (h !== null && typeof h === "object") entries.push(h as ConfigHookEntry);
				}
			} else {
				// A real FLAT Cursor entry.
				entries.push(item as ConfigHookEntry);
			}
		}
		out[event] = entries;
	}
	return out;
}
