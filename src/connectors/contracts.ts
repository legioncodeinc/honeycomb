/**
 * Connector base contracts + seams — PRD-019a Wave 1 (install-time only).
 *
 * ── THE THESIS (FR-9 / a-AC-5 / D-2) ────────────────────────────────────────
 *   A CONNECTOR IS AN INSTALL-TIME TOOL, NEVER A RUNTIME CLIENT. It patches a
 *   harness's config, writes the compiled hook handlers, and links skills — once,
 *   during `honeycomb setup` / `honeycomb connect <harness>`. It NEVER opens
 *   DeepLake, holds NO daemon handle, and stamps NO runtime path (runtime calls are
 *   the hooks' job, 019b). Adding a harness means a SUBCLASS that fills config
 *   locations + event names, not a rewrite of install logic (FR-1 / a-AC-5).
 *
 * ── MODULE HOME = `src/connectors/` ─────────────────────────────────────────
 * `src/connectors` is in `NON_DAEMON_ROOTS` (`tests/daemon/storage/invariant.test.ts`,
 * D-2). The connector touches the local filesystem (harness config + skill links)
 * through the {@link FakeFs}-able {@link ConnectorFs} seam — NEVER DeepLake.
 *
 * ── THE FOUR SUBCLASS SEAMS (FR-1) ──────────────────────────────────────────
 *   1. config path        — where the harness keeps its hook config
 *   2. hook-handler set    — which compiled handlers to write + register
 *   3. skill-link targets  — where org/team skills are symlinked
 *   4. event-name map      — the native event names the handlers register under
 * Plus the shared mechanics every connector INHERITS: `writeJsonIfChanged`,
 * `isHoneycombEntry`, `detectPlatforms`, the foreign-config-preserve filter, the
 * symlink-link rule, and the idempotent hook-trust fingerprint (FR-2..FR-7).
 *
 * Wave 1 ships the abstract base + the `FakeFs` seam + a `ClaudeCodeConnector`
 * subclass SKELETON (honest stubs). Wave 2 (019a) fills `install()`/`uninstall()`
 * and the subclass seams against the {@link ConnectorFs} seam.
 */

/** Honest-stub thrower — an early call FAILS LOUD with a stable, greppable message. */
export function notImplemented(what: string): never {
	throw new Error(`PRD-019a: not implemented — ${what}`);
}

/**
 * The marker substring identifying Honeycomb's own paths (FR-2 / a-AC-1). Used in the
 * plugin-root dir name + as the skill-link / handler-path component a connector owns.
 */
export const HONEYCOMB_MARKER = "honeycomb";

/**
 * The sentinel field stamped on every Honeycomb config hook entry (FR-2 / a-AC-1). A
 * harness command (`node "${…_PLUGIN_ROOT}/bundle/…"`) is NOT self-identifying — the
 * runtime-resolved plugin root carries no literal marker — so a path-substring match would
 * mis-classify (false negative on a Honeycomb entry → duplicate on re-install; false positive
 * on a foreign one → clobber a third-party hook). Stamping a dedicated boolean the harness
 * round-trips verbatim makes the predicate exact: an entry is Honeycomb's iff it carries this
 * key, and a foreign third-party hook NEVER does. This is what keeps install idempotent
 * (a-AC-3) and uninstall foreign-safe (a-AC-2).
 */
export const HONEYCOMB_ENTRY_KEY = "_honeycomb";

// ─────────────────────────────────────────────────────────────────────────────
// ConnectorFs — the filesystem seam every connector touches (FR-2..FR-6 / D-2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The filesystem operations a connector performs at install time (FR-2..FR-6). All
 * filesystem access goes through this seam so a Wave-2 test drives install/uninstall
 * against a {@link FakeFs} touching temp dirs (or an in-memory map) — never the
 * developer's real `~/.cursor`, `~/.codex`, etc. The real impl wraps `node:fs`.
 *
 * Only the operations a connector needs: read/write a config file, ensure a dir,
 * create/read/remove a symlink, check existence, and stat for the emptied-file
 * unlink rule (FR-6).
 */
export interface ConnectorFs {
	/** Read a UTF-8 file, or `undefined` when absent (config-not-yet-present). */
	readFile(path: string): Promise<string | undefined>;
	/** Write a UTF-8 file, creating parent dirs as needed. */
	writeFile(path: string, contents: string): Promise<void>;
	/** Atomically replace a UTF-8 file from a same-directory temporary file. */
	writeFileAtomic(path: string, contents: string): Promise<void>;
	/** Remove a file. No-op when absent (idempotent uninstall). */
	removeFile(path: string): Promise<void>;
	/** True when a path exists (file, dir, or symlink). */
	exists(path: string): Promise<boolean>;
	/** Ensure a directory exists (mkdir -p). */
	ensureDir(path: string): Promise<void>;
	/** Remove a directory only when empty; never removes foreign contents. */
	removeEmptyDir(path: string): Promise<void>;
	/** Create a symlink `linkPath` → `target`, never clobbering a foreign entry (FR-4 / a-AC-6). */
	symlink(target: string, linkPath: string): Promise<void>;
	/** Read a symlink's target, or `undefined` when `linkPath` is not a symlink. */
	readlink(path: string): Promise<string | undefined>;
	/** Remove a symlink. No-op when absent. */
	removeSymlink(path: string): Promise<void>;
}

/** An in-memory {@link ConnectorFs} fake recording every write/symlink for assertions. */
export interface FakeFs extends ConnectorFs {
	/** The current in-memory file contents, keyed by path (for assertions). */
	readonly files: ReadonlyMap<string, string>;
	/** The current symlinks, keyed by link path → target (for assertions). */
	readonly links: ReadonlyMap<string, string>;
	/** Every write call, in order (idempotency assertions: a no-change install writes nothing). */
	readonly writes: readonly string[];
}

/**
 * Build an in-memory {@link FakeFs} (the temp-dir-free seam Wave-2 tests touch).
 * Seedable with initial files (e.g. a config already holding foreign hooks, for the
 * preserve-foreign-entries assertion, a-AC-1). Records writes so an idempotency test
 * asserts a no-change re-install touches NO file (FR-5 / a-AC-3).
 */
export function createFakeFs(seed?: { files?: Record<string, string>; links?: Record<string, string> }): FakeFs {
	const files = new Map<string, string>(Object.entries(seed?.files ?? {}));
	const links = new Map<string, string>(Object.entries(seed?.links ?? {}));
	const writes: string[] = [];
	return {
		get files(): ReadonlyMap<string, string> {
			return files;
		},
		get links(): ReadonlyMap<string, string> {
			return links;
		},
		get writes(): readonly string[] {
			return writes;
		},
		async readFile(path: string): Promise<string | undefined> {
			return files.get(path);
		},
		async writeFile(path: string, contents: string): Promise<void> {
			files.set(path, contents);
			writes.push(path);
		},
		async writeFileAtomic(path: string, contents: string): Promise<void> {
			files.set(path, contents);
			writes.push(path);
		},
		async removeFile(path: string): Promise<void> {
			files.delete(path);
		},
		async exists(path: string): Promise<boolean> {
			return files.has(path) || links.has(path);
		},
		async ensureDir(): Promise<void> {
			/* in-memory: dirs are implicit */
		},
		async removeEmptyDir(): Promise<void> {
			/* in-memory: dirs are implicit */
		},
		async symlink(target: string, linkPath: string): Promise<void> {
			links.set(linkPath, target);
		},
		async readlink(path: string): Promise<string | undefined> {
			return links.get(path);
		},
		async removeSymlink(path: string): Promise<void> {
			links.delete(path);
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// Connector descriptor types — what a subclass declares (FR-1)
// ─────────────────────────────────────────────────────────────────────────────

/** A compiled hook handler the connector writes + registers (FR-3). */
export interface HookHandlerEntry {
	/** The native event name the handler registers under (from the event-name map). */
	readonly event: string;
	/** The on-disk path the compiled handler is written to (e.g. `~/.cursor/honeycomb/bundle/…`). */
	readonly handlerPath: string;
	/** The source bundle path the handler is copied/linked from (`harnesses/<h>/bundle/`). */
	readonly sourcePath: string;
	/** The command string registered in the harness config (e.g. `node "…/bundle/capture.js"`). */
	readonly command: string;
	/** The per-event timeout (seconds) the harness honors; passed through to the config entry. */
	readonly timeout?: number;
	/** True when the handler runs detached off the critical path (FR-3 latency discipline). */
	readonly async?: boolean;
}

/** An additional install-time artifact copied alongside hook handlers (for example an MCP server bundle). */
export interface InstallFileEntry {
	readonly sourcePath: string;
	readonly targetPath: string;
}

/**
 * One hook entry as it lands inside a harness config event block (FR-2 / FR-3). The Claude
 * Code shape (`{ type, command, timeout, async }`) is the lingua franca every hooks-based
 * harness shares; a subclass that diverges overrides {@link HarnessConnector.toConfigEntry}.
 */
export interface ConfigHookEntry {
	readonly type: string;
	readonly command: string;
	readonly timeout?: number;
	readonly async?: boolean;
	readonly [k: string]: unknown;
}

/** A matcher block holding a `hooks` array, the Claude Code per-event config structure. */
export interface ConfigMatcherBlock {
	readonly matcher?: string;
	readonly hooks: ConfigHookEntry[];
	readonly [k: string]: unknown;
}

/** The harness config shape the base patches — a `hooks` map plus arbitrary foreign keys. */
export interface HarnessConfig {
	hooks?: Record<string, ConfigMatcherBlock[]>;
	[k: string]: unknown;
}

/** A skill-link target the connector symlinks org/team skills into (FR-4). */
export interface SkillLinkTarget {
	/** The directory skills are linked into (e.g. `~/.cursor/skills-cursor/`). */
	readonly dir: string;
	/** The skill source to link (the org/team skill path). */
	readonly source: string;
}

/** The platform-detection result (FR-7) — a harness found installed on this box. */
export interface DetectedPlatform {
	/** The harness slug (e.g. `claude-code`, `cursor`). */
	readonly harness: string;
	/** The harness config root that proves it is installed. */
	readonly configRoot: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// HarnessConnector — the abstract base (FR-1 / a-AC-5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The result of an install/uninstall run — what changed, for the CLI to report and
 * a test to assert. `wroteConfig` is false on an idempotent no-change re-install
 * (FR-5 / a-AC-3 — the hook-trust fingerprint is unchanged when nothing is written).
 */
export interface ConnectorRunResult {
	/** The harness this run targeted. */
	readonly harness: string;
	/** True when the config file was actually written (false = idempotent no-op). */
	readonly wroteConfig: boolean;
	/** The handler paths written (install) or removed (uninstall). */
	readonly handlers: readonly string[];
	/** The skill links added (install) or removed (uninstall). */
	readonly skillLinks: readonly string[];
}

/**
 * The abstract connector base every per-harness connector extends (FR-1 / a-AC-5).
 * Owns `install()`/`uninstall()` and the shared mechanics (`writeJsonIfChanged`,
 * `isHoneycombEntry`, `detectPlatforms`, foreign-config-preserve, the symlink rule,
 * the idempotent hook-trust fingerprint). A subclass overrides ONLY the four seams.
 *
 * Wave 1 declares the shape with honest-stub bodies; Wave 2 fills them against the
 * injected {@link ConnectorFs}. The base is constructed with the fs seam so the whole
 * connector is testable against a {@link FakeFs}.
 */
export abstract class HarnessConnector {
	/** The filesystem seam — the ONLY way the connector touches disk (D-2). */
	protected readonly fs: ConnectorFs;

	constructor(fs: ConnectorFs) {
		this.fs = fs;
	}

	/** The harness slug this connector targets (e.g. `claude-code`). */
	abstract readonly harness: string;

	// ── The four subclass seams (FR-1) ────────────────────────────────────────

	/** SEAM 1 — the harness's hook-config file path (FR-1). */
	protected abstract configPath(): string;
	/** SEAM 2 — the compiled hook handlers to write + register (FR-1 / FR-3). */
	protected abstract hookHandlers(): readonly HookHandlerEntry[];
	/** SEAM 3 — the skill-link targets (FR-1 / FR-4). */
	protected abstract skillLinkTargets(): readonly SkillLinkTarget[];
	/** SEAM 4 — the native event-name map (FR-1). */
	protected abstract eventNameMap(): Readonly<Record<string, string>>;
	/** Optional non-hook files this connector installs and owns. */
	protected additionalFiles(): readonly InstallFileEntry[] {
		return [];
	}

	/**
	 * SEAM 3.5 (optional) — the config root that PROVES this harness is installed
	 * (FR-7). Default: the directory the config file lives in. A subclass whose
	 * install-proof differs from its config dir overrides this. A connector reports
	 * itself "detected" when this root exists on disk.
	 */
	protected configRoot(): string {
		return dirOf(this.configPath());
	}

	/**
	 * Render a {@link HookHandlerEntry} into the config-entry shape the harness writes
	 * (FR-3). Default is the Claude Code `{ type:"command", command, timeout, async }`
	 * lingua franca every hooks-based harness shares; a subclass diverges by override.
	 */
	protected toConfigEntry(handler: HookHandlerEntry): ConfigHookEntry {
		const entry: ConfigHookEntry = { type: "command", command: handler.command };
		return {
			...entry,
			...(handler.timeout !== undefined ? { timeout: handler.timeout } : {}),
			...(handler.async !== undefined ? { async: handler.async } : {}),
			// Stamp the sentinel so `isHoneycombEntry` reclaims THIS entry exactly on the next
			// install/uninstall — and never mistakes a foreign hook for one of ours (FR-2 / a-AC-1).
			[HONEYCOMB_ENTRY_KEY]: true,
		};
	}

	// ── The shared mechanics every connector inherits (FR-2..FR-7) ────────────

	/**
	 * FR-2 / a-AC-1 — true when a parsed config hook entry is a Honeycomb entry, so
	 * install filters/refreshes only Honeycomb's and PRESERVES foreign entries. The
	 * predicate keys off the {@link HONEYCOMB_MARKER} token in the entry's `command`
	 * (every Honeycomb handler points at the `honeycomb/bundle/` compiled handler; a
	 * third-party hook's command never carries that token).
	 */
	protected isHoneycombEntry(entry: unknown): boolean {
		if (entry === null || typeof entry !== "object") return false;
		// The exact, round-trip-stable signal: the sentinel field Honeycomb stamps on its own
		// entries. A foreign third-party hook never carries it.
		if ((entry as Record<string, unknown>)[HONEYCOMB_ENTRY_KEY] === true) return true;
		// Back-compat fallback: a legacy Honeycomb entry whose command path carries the marker
		// (pre-sentinel installs) is still reclaimed so an upgrade-uninstall cleans it up.
		const command = (entry as { command?: unknown }).command;
		if (typeof command !== "string") return false;
		return command.replace(/\\/g, "/").includes(`/${HONEYCOMB_MARKER}/bundle/`);
	}

	/**
	 * FR-2 / FR-5 / a-AC-3 — write `contents` to `path` ONLY when it differs from what
	 * is already there. The idempotency floor: a no-change re-install touches NO file,
	 * so the harness's hook-trust fingerprint is unchanged (no re-trust dialog). Returns
	 * true iff it actually wrote. A byte-identical compare (not a structural one) is the
	 * fingerprint the harness itself keys off, so the comparison is on the serialized text.
	 */
	protected async writeJsonIfChanged(path: string, contents: string): Promise<boolean> {
		const existing = await this.fs.readFile(path);
		if (existing === contents) return false;
		await this.fs.ensureDir(dirOf(path));
		await this.fs.writeFile(path, contents);
		return true;
	}

	/**
	 * FR-7 / a-AC-4 — detect whether THIS connector's harness is installed (its config
	 * root exists). `honeycomb setup` with no target asks every connector and wires the
	 * detected ones; `honeycomb connect <harness>` wires exactly one. A subclass needing
	 * a richer probe overrides {@link configRoot}.
	 */
	async detectPlatforms(): Promise<readonly DetectedPlatform[]> {
		const root = this.configRoot();
		if (!(await this.fs.exists(root))) return [];
		return [{ harness: this.harness, configRoot: root }];
	}

	// ── The install/uninstall contract (FR-2..FR-6) ───────────────────────────

	/**
	 * Install (FR-2..FR-5 / a-AC-1 / a-AC-3 / a-AC-6):
	 *   1. write each compiled handler to its on-disk location (FR-3);
	 *   2. patch the config — parse existing → filter Honeycomb entries via
	 *      {@link isHoneycombEntry} → append fresh Honeycomb entries → serialize, and
	 *      `writeJsonIfChanged` so a no-change re-run writes NOTHING (a-AC-1 / a-AC-3);
	 *   3. symlink org/team skills, never clobbering a foreign entry (FR-4 / a-AC-6).
	 * Returns what changed; `wroteConfig` is false on an idempotent no-op.
	 */
	async install(): Promise<ConnectorRunResult> {
		const handlers = this.hookHandlers();

		// 1. Write the compiled handlers to their on-disk locations (FR-3). The source
		// bundle is copied verbatim; an unreadable source is skipped (the bundle is the
		// build's job — a connector never invents handler bytes).
		const written: string[] = [];
		for (const handler of handlers) {
			const body = await this.fs.readFile(handler.sourcePath);
			if (body === undefined) continue;
			await this.fs.ensureDir(dirOf(handler.handlerPath));
			await this.fs.writeFile(handler.handlerPath, body);
			written.push(handler.handlerPath);
		}
		for (const file of this.additionalFiles()) {
			const body = await this.fs.readFile(file.sourcePath);
			if (body === undefined) continue;
			await this.fs.ensureDir(dirOf(file.targetPath));
			await this.fs.writeFile(file.targetPath, body);
			written.push(file.targetPath);
		}

		// 2. Patch the config, foreign-preserving + idempotent.
		const path = this.configPath();
		const patchedText = this.patchConfigText(await this.fs.readFile(path), handlers);
		const wroteConfig = await this.writeJsonIfChanged(path, patchedText);

		// 3. Symlink skills, preserving foreign entries (FR-4 / a-AC-6).
		const skillLinks = await this.linkSkills();

		return { harness: this.harness, wroteConfig, handlers: written, skillLinks };
	}

	/**
	 * Uninstall (FR-6 / a-AC-2): remove ONLY Honeycomb's hook entries (filter every
	 * event block through {@link isHoneycombEntry}, drop emptied matcher blocks + emptied
	 * event keys), unlink ONLY Honeycomb's skill symlinks, and remove the written handler
	 * files. When the resulting config holds NO further entries, the config file is cleanly
	 * unlinked (never left as an empty `{}`). A foreign hook or a still-populated config is
	 * always preserved.
	 */
	async uninstall(): Promise<ConnectorRunResult> {
		const path = this.configPath();
		const stripped = this.stripConfigText(await this.fs.readFile(path));

		let wroteConfig = false;
		if (stripped.empty) {
			// FR-6: an emptied config is cleanly UNLINKED, not left as `{}`.
			if (await this.fs.exists(path)) {
				await this.fs.removeFile(path);
				wroteConfig = true;
			}
		} else {
			wroteConfig = await this.writeJsonIfChanged(path, stripped.text);
		}

		// Remove the written handler files.
		const removedHandlers: string[] = [];
		for (const handler of this.hookHandlers()) {
			if (await this.fs.exists(handler.handlerPath)) {
				await this.fs.removeFile(handler.handlerPath);
				removedHandlers.push(handler.handlerPath);
			}
		}
		for (const file of this.additionalFiles()) {
			if (await this.fs.exists(file.targetPath)) {
				await this.fs.removeFile(file.targetPath);
				removedHandlers.push(file.targetPath);
			}
		}

		// Unlink ONLY Honeycomb's skill symlinks (a foreign entry is never touched).
		const removedLinks = await this.unlinkSkills();

		return { harness: this.harness, wroteConfig, handlers: removedHandlers, skillLinks: removedLinks };
	}

	// ── Internal patch/link helpers (shared by every connector) ───────────────

	/**
	 * Parse, patch, and serialize this harness's config text. JSON is the shared
	 * default. A non-JSON harness (Hermes YAML) overrides this text seam while
	 * retaining the base install/uninstall filesystem mechanics.
	 */
	protected patchConfigText(text: string | undefined, handlers: readonly HookHandlerEntry[]): string {
		return serializeConfig(this.patchConfig(parseConfig(text), handlers));
	}

	/**
	 * Strip Honeycomb-owned entries and serialize the remaining config. The
	 * `empty` bit controls whether the base removes the config file entirely.
	 */
	protected stripConfigText(text: string | undefined): { readonly empty: boolean; readonly text: string } {
		const stripped = this.stripHoneycomb(parseConfig(text));
		return { empty: this.isConfigEmpty(stripped), text: serializeConfig(stripped) };
	}

	/**
	 * Append fresh Honeycomb hook entries to the config, foreign-preserving (FR-2 / a-AC-1).
	 * For each native event the handlers register under: filter out any prior Honeycomb
	 * entries (a re-install refreshes Honeycomb's own, never duplicating them), then append
	 * the current Honeycomb entries. Foreign matcher blocks + foreign hook entries are kept
	 * verbatim. Honeycomb entries live in their OWN matcher block so a foreign block is
	 * never edited.
	 */
	protected patchConfig(config: HarnessConfig, handlers: readonly HookHandlerEntry[]): HarnessConfig {
		const hooks: Record<string, ConfigMatcherBlock[]> = {};
		for (const [event, blocks] of Object.entries(config.hooks ?? {})) {
			hooks[event] = (Array.isArray(blocks) ? blocks : [])
				// Guard a block that lacks a `.hooks` array (e.g. a FLAT Cursor entry that reached the
				// nested-shape base): treat its handler list as empty rather than throwing on
				// `undefined.filter` — crash-safety for the base, even though the Cursor subclass
				// overrides this method with its own flat merge.
				.map((b) => ({ ...b, hooks: (Array.isArray(b.hooks) ? b.hooks : []).filter((h) => !this.isHoneycombEntry(h)) }))
				.filter((b) => b.hooks.length > 0);
		}
		// Group handlers by native event, append one Honeycomb matcher block per event.
		const byEvent = new Map<string, ConfigHookEntry[]>();
		for (const handler of handlers) {
			const entry = this.toConfigEntry(handler);
			const list = byEvent.get(handler.event) ?? [];
			list.push(entry);
			byEvent.set(handler.event, list);
		}
		for (const [event, entries] of byEvent) {
			const block: ConfigMatcherBlock = { hooks: entries };
			hooks[event] = [...(hooks[event] ?? []), block];
		}
		return { ...config, hooks };
	}

	/**
	 * SEAM (strip) — remove every Honeycomb hook entry from a parsed config, preserving foreign
	 * entries + foreign top-level keys verbatim (FR-6 / a-AC-2). Default is the Claude-Code-style
	 * nested-matcher-block strip; a subclass whose on-disk shape differs (e.g. Cursor's FLAT
	 * per-event entry array) overrides this to strip in ITS shape. The base delegates to the pure
	 * {@link stripHoneycomb} helper so the inherited behavior is byte-identical for nested harnesses.
	 */
	protected stripHoneycomb(config: HarnessConfig): HarnessConfig {
		return stripHoneycomb(config, (e) => this.isHoneycombEntry(e));
	}

	/**
	 * SEAM (empty) — true when a stripped config holds NO entries at all (the unlink trigger,
	 * FR-6). Default keys off the total key count; a subclass overrides only if its shape needs a
	 * different emptiness rule. The base delegates to the pure {@link isConfigEmpty} helper.
	 */
	protected isConfigEmpty(config: HarnessConfig): boolean {
		return isConfigEmpty(config);
	}

	/**
	 * Symlink every {@link SkillLinkTarget} source into its target dir, NEVER clobbering a
	 * foreign entry (FR-4 / a-AC-6). A link path already holding a NON-Honeycomb entry (a real
	 * dir/file or a link to a foreign target) is left untouched; only the Honeycomb symlink is
	 * (re)created. Returns the link paths created or already-ours.
	 */
	protected async linkSkills(): Promise<string[]> {
		const created: string[] = [];
		for (const target of this.skillLinkTargets()) {
			const linkPath = joinPath(target.dir, baseName(target.source));
			await this.fs.ensureDir(target.dir);
			const existing = await this.fs.readlink(linkPath);
			if (existing === target.source) {
				// Already our link — idempotent, leave it.
				created.push(linkPath);
				continue;
			}
			if (existing !== undefined) {
				// A foreign symlink at this path → never clobber (a-AC-6).
				continue;
			}
			if (await this.fs.exists(linkPath)) {
				// A real foreign dir/file at this path → never clobber (a-AC-6).
				continue;
			}
			await this.fs.symlink(target.source, linkPath);
			created.push(linkPath);
		}
		return created;
	}

	/**
	 * Unlink ONLY Honeycomb's skill symlinks (FR-6 / a-AC-2). A link path is removed iff it is
	 * a symlink whose target is exactly OUR skill source — a foreign symlink or a real dir/file
	 * is left untouched. Returns the link paths removed.
	 */
	protected async unlinkSkills(): Promise<string[]> {
		const removed: string[] = [];
		for (const target of this.skillLinkTargets()) {
			const linkPath = joinPath(target.dir, baseName(target.source));
			if ((await this.fs.readlink(linkPath)) === target.source) {
				await this.fs.removeSymlink(linkPath);
				removed.push(linkPath);
			}
		}
		return removed;
	}
}

// ─────────────────────────────────────────────────────────────────────────────
// Pure config + path helpers (no IO — testable in isolation)
// ─────────────────────────────────────────────────────────────────────────────

/** Parse a harness config file's text into a {@link HarnessConfig}; absent/garbled → `{}`. */
function parseConfig(text: string | undefined): HarnessConfig {
	if (text === undefined) return {};
	try {
		const parsed: unknown = JSON.parse(text);
		if (parsed === null || typeof parsed !== "object") return {};
		return parsed as HarnessConfig;
	} catch {
		return {};
	}
}

/** Serialize a config the way the harness writes it (2-space, trailing newline) — the fingerprint. */
function serializeConfig(config: HarnessConfig): string {
	return `${JSON.stringify(config, null, 2)}\n`;
}

/**
 * Strip every Honeycomb hook entry from the config (FR-6 / a-AC-2). Each event block is filtered
 * through `isHc`; an emptied matcher block is dropped; an event with no remaining blocks has its
 * key removed. Foreign entries + foreign top-level keys are preserved verbatim.
 */
function stripHoneycomb(config: HarnessConfig, isHc: (entry: unknown) => boolean): HarnessConfig {
	if (config.hooks === undefined) return config;
	const hooks: Record<string, ConfigMatcherBlock[]> = {};
	for (const [event, blocks] of Object.entries(config.hooks)) {
		const kept = blocks
			.map((b) => ({ ...b, hooks: b.hooks.filter((h) => !isHc(h)) }))
			.filter((b) => b.hooks.length > 0);
		if (kept.length > 0) hooks[event] = kept;
	}
	const next: HarnessConfig = { ...config };
	if (Object.keys(hooks).length > 0) next.hooks = hooks;
	else delete next.hooks;
	return next;
}

/** True when a stripped config holds no entries at all (no hooks + no foreign keys) — the unlink trigger. */
function isConfigEmpty(config: HarnessConfig): boolean {
	return Object.keys(config).length === 0;
}

/** The directory portion of a `/`-or-`\`-separated path. */
function dirOf(path: string): string {
	const norm = path.replace(/\\/g, "/");
	const idx = norm.lastIndexOf("/");
	return idx <= 0 ? "" : norm.slice(0, idx);
}

/** The final segment of a `/`-or-`\`-separated path. */
function baseName(path: string): string {
	const norm = path.replace(/\\/g, "/").replace(/\/+$/, "");
	const idx = norm.lastIndexOf("/");
	return idx < 0 ? norm : norm.slice(idx + 1);
}

/** Join a dir and a segment with a forward slash (the seam is path-style-agnostic in-memory). */
function joinPath(dir: string, segment: string): string {
	return `${dir.replace(/\/+$/, "")}/${segment}`;
}
