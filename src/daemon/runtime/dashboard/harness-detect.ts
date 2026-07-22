/**
 * The cheap, fail-soft install-presence detector for the canonical six harnesses — PRD-039a
 * (a-AC-3 / OQ-1: "which harnesses are wired?").
 *
 * The 039a telemetry endpoint (`mountHarnessApi`) reports each harness's `installed` flag from an
 * injected `ReadonlySet<string>` resolved ONCE at assembly (never a per-request walk or spawn). This
 * module is that resolver for the REAL production daemon: it answers "which of the six harnesses has
 * Honeycomb actually wired on this box?" by checking for the on-disk MARKER each installer writes —
 * `existsSync` only, no spawn, no network, no directory walk, never a throw.
 *
 * ── The markers are HONEYCOMB's own artifacts, never dead hivemind-v1 leftovers ───────
 *   Each harness is "wired" when at least one of its install markers is present. Every marker points
 *   at what the CURRENT honeycomb product writes — NOT the legacy hivemind-v1 install paths (an old
 *   `~/.hermes` / `~/.codex/hivemind` must never masquerade as a honeycomb install):
 *     - `claude-code` → `~/.claude/settings.json` — the hook-config file the connector patches
 *       (`src/connectors/claude-code.ts` `configPath()`); OR the plugin root `~/.claude/plugins/honeycomb`
 *       (that connector's `pluginRoot`, where the compiled handlers land).
 *     - `cursor` → `~/.cursor/hooks.json` — the connector's `configPath()` (`src/connectors/cursor.ts`);
 *       OR the plugin root `~/.cursor/honeycomb`.
 *     - `codex` → `~/.codex/hooks.json` (the connector's `configPath()`) OR the plugin root
 *       `~/.codex/plugins/honeycomb` (`src/connectors/codex.ts`). Repointed off the dead
 *       `~/.codex/hivemind` leftover.
 *     - `hermes` → `~/.hermes/honeycomb/bundle/capture.mjs`, the concrete installed hook alias.
 *     - `pi` / `openclaw` → no Honeycomb connector wires these yet; their marker is the
 *       honeycomb-namespaced directory Honeycomb would write once wired (`~/.pi/honeycomb`,
 *       `~/.openclaw/honeycomb`), so stale hivemind-v1 artifacts never report installed.
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
import { isAbsolute, join, resolve } from "node:path";

import { CANONICAL_HARNESS_IDS } from "./harness-registry.js";

/**
 * One canonical harness's install markers: the resolver reports the harness installed iff AT LEAST
 * ONE marker path exists. `paths` is a builder over the resolved `homeDir` so the whole detector is
 * root-injectable. Each entry is grounded in that harness's installer (see the module docblock).
 */
interface HarnessMarker {
	/** The canonical harness id (must be one of {@link CANONICAL_HARNESS_IDS}). */
	readonly name: string;
	/** Build candidate marker paths from trusted roots (cheap `join`s, no IO). */
	readonly paths: (homeDir: string, hermesHome?: string) => readonly string[];
}

/**
 * The per-harness markers, keyed by canonical id. Each path is the AUTHORITATIVE on-disk signal the
 * CURRENT honeycomb install writes (the connector `configPath()`/`pluginRoot`, or — for a harness with
 * no connector yet — the honeycomb-namespaced dir honeycomb would write). Never a legacy hivemind-v1
 * path. OR-over-paths: any one present → wired.
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
		// src/connectors/codex.ts: configPath() = ~/.codex/hooks.json; pluginRoot = ~/.codex/plugins/honeycomb.
		// (Repointed off the dead hivemind-v1 `~/.codex/hivemind` path to the CURRENT honeycomb connector's artifacts.)
		paths: (h) => [join(h, ".codex", "hooks.json"), join(h, ".codex", "plugins", "honeycomb")],
	},
	{
		name: "hermes",
		// The Hermes connector writes this concrete handler and removes it on uninstall. Checking the
		// file—not the parent directory—prevents an empty leftover directory from reading as wired.
		paths: (_homeDir, hermesHome) =>
			hermesHome === undefined ? [] : [join(hermesHome, "honeycomb", "bundle", "capture.mjs")],
	},
	{
		name: "pi",
		// No honeycomb connector wires pi yet. Detect ONLY the honeycomb-namespaced dir, not the dead
		// hivemind-v1 `~/.pi/agent/AGENTS.md` / `~/.pi/agent/extensions/hivemind.ts` leftovers.
		paths: (h) => [join(h, ".pi", "honeycomb")],
	},
	{
		name: "openclaw",
		// No honeycomb connector wires openclaw yet. Detect ONLY the honeycomb-namespaced dir, not the
		// dead hivemind-v1 `~/.openclaw/extensions/hivemind` leftover.
		paths: (h) => [join(h, ".openclaw", "honeycomb")],
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

/** Resolve Hermes' effective profile root, rejecting unsafe configured values. */
function configuredHermesHome(homeDir: string): string | undefined {
	const configured = process.env.HERMES_HOME?.trim();
	const candidate = configured === undefined || configured === "" ? join(homeDir, ".hermes") : configured;
	if (!isAbsolute(candidate) || candidate.includes("\0")) return undefined;
	return resolve(candidate);
}

/**
 * Resolve which of the canonical six harnesses Honeycomb has wired on disk (a-AC-3). For each harness,
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
export function detectInstalledHarnesses(homeDir: string = homedir(), _cwd: string = process.cwd()): Set<string> {
	// Only probe beneath a concrete absolute home root. This function never accepts a caller-controlled
	// relative path, so its fixed marker suffixes cannot escape through cwd resolution.
	if (!isAbsolute(homeDir) || homeDir.includes("\0")) return new Set();
	const trustedHomeRoot = resolve(homeDir);
	const trustedHermesHome = configuredHermesHome(trustedHomeRoot);
	const canonical = new Set<string>(CANONICAL_HARNESS_IDS);
	const installed = new Set<string>();
	for (const marker of HARNESS_MARKERS) {
		// Defensive: only ever record a canonical id (the registry is the source of truth; a marker for
		// a non-canonical id is ignored so the set can never diverge from the six the endpoint enumerates).
		if (!canonical.has(marker.name)) continue;
		if (marker.paths(trustedHomeRoot, trustedHermesHome).some(markerExists)) installed.add(marker.name);
	}
	return installed;
}
