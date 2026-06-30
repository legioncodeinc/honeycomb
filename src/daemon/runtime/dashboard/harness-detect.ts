/**
 * The cheap, fail-soft install-presence detector for the canonical seven harnesses — PRD-039a
 * (a-AC-3 / OQ-1: "which harnesses are wired?").
 *
 * The 039a telemetry endpoint (`mountHarnessApi`) reports each harness's `installed` flag from an
 * injected `ReadonlySet<string>` resolved ONCE at assembly (never a per-request walk or spawn). This
 * module is that resolver for the REAL production daemon: it answers "which of the seven harnesses has
 * Honeycomb actually wired on this box?" by checking for the on-disk MARKER each installer writes —
 * `existsSync` only, no spawn, no network, no directory walk, never a throw.
 *
 * ── The markers are the install pipeline's own authoritative signals ─────────────────
 *   Each harness is "wired" when at least one of its install markers is present. The markers are
 *   grounded in the install code, NOT guessed:
 *     - `claude-code` → `~/.claude/settings.json` — the hook-config file the connector patches
 *       (`src/connectors/claude-code.ts` `configPath()`); OR the plugin root `~/.claude/plugins/honeycomb`
 *       (that connector's `pluginRoot`, where the compiled handlers land).
 *     - `cursor` → `~/.cursor/hooks.json` — the connector's `configPath()` (`src/connectors/cursor.ts`);
 *       OR the plugin root `~/.cursor/honeycomb`.
 *     - `codex` → `~/.codex/hooks.json` + the plugin dir `~/.codex/hivemind` the installer writes
 *       (`hivemind-v1/src/cli/install-codex.ts` `HOOKS_PATH` / `PLUGIN_DIR`).
 *     - `hermes` → `~/.hermes/config.yaml` + the bundle dir `~/.hermes/hivemind`
 *       (`hivemind-v1/src/cli/install-hermes.ts` `CONFIG_PATH` / `HIVEMIND_DIR`).
 *     - `pi` → `~/.pi/agent/AGENTS.md` (the BEGIN/END Honeycomb block upsert) + the extension
 *       `~/.pi/agent/extensions/hivemind.ts` (`hivemind-v1/src/cli/install-pi.ts` `AGENTS_MD` / `EXTENSION_PATH`).
 *     - `openclaw` → the plugin dir `~/.openclaw/extensions/hivemind`
 *       (`hivemind-v1/src/cli/install-openclaw.ts` `PLUGIN_DIR`).
 *
 *   A harness reads INSTALLED iff one of its markers exists. The check is intentionally OR-over-markers
 *   and tolerant: a partially-wired harness (e.g. the config written but the plugin dir pruned) still
 *   reads installed, which is the honest "this harness is wired" picture the page asks for.
 *
 * ── Roots are injectable so tests never touch the real home ──────────────────────────
 *   `homeDir` defaults to `os.homedir()` and `cwd` to `process.cwd()`; a test passes temp dirs so it
 *   drives the present/absent mix against a fixture tree, never the developer's real `~/.claude` etc.
 *
 * ── No secret surfaces ───────────────────────────────────────────────────────────────
 *   This reads PATH EXISTENCE only — never a marker file's CONTENTS. The result is a `Set<string>` of
 *   canonical harness ids. No token, config value, or path string rides the telemetry response (the
 *   endpoint only consults `installed.has(name)`), so no secret can leak through it.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { CANONICAL_HARNESS_IDS } from "./harness-registry.js";

/**
 * One canonical harness's install markers: the resolver reports the harness installed iff AT LEAST
 * ONE marker path exists. `paths` is a builder over the resolved `homeDir` so the whole detector is
 * root-injectable. Each entry is grounded in that harness's installer (see the module docblock).
 */
interface HarnessMarker {
	/** The canonical harness id (must be one of {@link CANONICAL_HARNESS_IDS}). */
	readonly name: string;
	/** Build the candidate marker paths from the resolved home dir (cheap `join`s, no IO). */
	readonly paths: (homeDir: string) => readonly string[];
}

/**
 * The per-harness markers, keyed by canonical id. Each path is the AUTHORITATIVE on-disk signal the
 * harness's installer writes (the connector `configPath()`/`pluginRoot`, or the legacy installer's
 * `HOOKS_PATH`/`PLUGIN_DIR`/`AGENTS_MD`/`EXTENSION_PATH`). OR-over-paths: any one present → wired.
 */
const HARNESS_MARKERS: readonly HarnessMarker[] = [
	{
		name: "claude-code",
		// src/connectors/claude-code.ts: configPath() = ~/.claude/settings.json; pluginRoot = ~/.claude/plugins/honeycomb.
		paths: (h) => [join(h, ".claude", "settings.json"), join(h, ".claude", "plugins", "honeycomb")],
	},
	{
		name: "cursor",
		// src/connectors/cursor.ts: configPath() = ~/.cursor/hooks.json; pluginRoot = ~/.cursor/honeycomb.
		paths: (h) => [join(h, ".cursor", "hooks.json"), join(h, ".cursor", "honeycomb")],
	},
	{
		name: "codex",
		// hivemind-v1/src/cli/install-codex.ts: HOOKS_PATH = ~/.codex/hooks.json; PLUGIN_DIR = ~/.codex/hivemind.
		paths: (h) => [join(h, ".codex", "hooks.json"), join(h, ".codex", "hivemind")],
	},
	{
		name: "grok",
		// src/connectors/grok.ts: configPath = ~/.grok/hooks/honeycomb.json; pluginRoot = ~/.grok/plugins/honeycomb.
		paths: (h) => [
			join(h, ".grok", "hooks", "honeycomb.json"),
			join(h, ".grok", "plugins", "honeycomb"),
		],
	},
	{
		name: "hermes",
		// hivemind-v1/src/cli/install-hermes.ts: CONFIG_PATH = ~/.hermes/config.yaml; HIVEMIND_DIR = ~/.hermes/hivemind.
		paths: (h) => [join(h, ".hermes", "config.yaml"), join(h, ".hermes", "hivemind")],
	},
	{
		name: "pi",
		// hivemind-v1/src/cli/install-pi.ts: AGENTS_MD = ~/.pi/agent/AGENTS.md; EXTENSION_PATH = ~/.pi/agent/extensions/hivemind.ts.
		paths: (h) => [
			join(h, ".pi", "agent", "extensions", "hivemind.ts"),
			join(h, ".pi", "agent", "AGENTS.md"),
		],
	},
	{
		name: "openclaw",
		// hivemind-v1/src/cli/install-openclaw.ts: PLUGIN_DIR = ~/.openclaw/extensions/hivemind.
		paths: (h) => [join(h, ".openclaw", "extensions", "hivemind")],
	},
];

/** True iff `path` exists; any `existsSync` throw (unreadable/permission) is swallowed → false (fail-soft). */
function markerExists(path: string): boolean {
	try {
		return existsSync(path);
	} catch {
		// A marker that cannot be stat'd (permission, ELOOP, …) is treated as ABSENT — the detector
		// must never throw and must never over-report. The harness simply reads `installed: false`.
		return false;
	}
}

/**
 * Resolve which of the canonical seven harnesses Honeycomb has wired on disk (a-AC-3). For each harness,
 * the result includes its id iff at least one of its install markers exists under `homeDir`. Cheap
 * (`existsSync` only), fail-soft (a missing/unreadable marker → simply not in the set, never a throw),
 * and root-injectable (a test passes a temp `homeDir`, never the real home).
 *
 * The returned set is exactly the shape the 039a endpoint consumes: `mountHarnessApi` reads
 * `installedHarnesses.has(name)` per canonical harness. Only canonical ids ever enter the set, so a
 * stray marker for a non-canonical tool can never inflate the count.
 *
 * @param homeDir  The user home dir to resolve markers under (defaults to `os.homedir()`).
 * @param _cwd     The workspace root — accepted for symmetry with the assembly seam (a future
 *                 project-local marker could key off it); UNUSED today (no current marker is cwd-local).
 */
export function detectInstalledHarnesses(
	homeDir: string = homedir(),
	_cwd: string = process.cwd(),
): Set<string> {
	const canonical = new Set<string>(CANONICAL_HARNESS_IDS);
	const installed = new Set<string>();
	for (const marker of HARNESS_MARKERS) {
		// Defensive: only ever record a canonical id (the registry is the source of truth; a marker for
		// a non-canonical id is ignored so the set can never diverge from the seven the endpoint enumerates).
		if (!canonical.has(marker.name)) continue;
		if (marker.paths(homeDir).some(markerExists)) installed.add(marker.name);
	}
	return installed;
}
