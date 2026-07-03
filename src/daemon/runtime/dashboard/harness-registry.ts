/**
 * The canonical-six harness registry + capability descriptor — PRD-039a (the data backbone's
 * source of truth) / PRD-039c (the data-driven capability descriptor, folded server-side per c-OQ-2).
 *
 * ── DERIVED-FROM-OR-ASSERTED-AGAINST THE SHIM SET (a-OQ-3 / parent AC-1) ─────────────
 *   The six canonical harnesses are NOT a hand-typed string list that can silently drift. They are
 *   DERIVED from the real {@link HarnessShim} instances every harness exports via its
 *   `create<Harness>Shim()` factory (`src/hooks/<harness>/shim.ts`, barrelled in `src/hooks/index.ts`)
 *   — the SAME shims the capture pipeline runs. {@link CANONICAL_SHIMS} is the one place the six are
 *   listed; a test asserts that set equals the shims `src/hooks` actually ships, so a SEVENTH shim
 *   cannot land without appearing on the Harnesses page (the "derive-or-assert" lean, a-OQ-3).
 *
 * ── CAPABILITIES ARE THE SHIM STATICS, NOT A MARKETING TEMPLATE (parent D-5 / c-AC-4) ──
 *   Each harness's {@link HarnessCapabilities} descriptor is built from its shim's declared statics
 *   (`runtimePath`, `contextChannel`, `hostCli`, the native event-name map) PLUS the genuinely
 *   harness-specific divergences grounded in the shim modules:
 *     - Cursor declares `agents` (`cursor-agent` + the `claude` fallback) + `workspaceRoots`
 *       (`cursorDeriveMeta` reads `workspace_roots[0]`) — `src/hooks/cursor/shim.ts`.
 *     - Claude Code declares the full six `lifecycleEvents` and NO `agents` — `claude-code/shim.ts`.
 *     - Hermes, pi, and OpenClaw are explicitly marked `in-progress` until their runtime paths are
 *       fully wired in production (C-1 claim-reduction path).
 *     - Codex declares `userVisibleLogin` (the brief login line) — `codex/shim.ts`.
 *   An ABSENT capability omits its panel on the detail page (c-AC-3) — the descriptor's missing field
 *   drives omission, never an empty "none" card.
 *
 * This module is PURE: it imports the shim factories (thin-client constructors, no DeepLake, no SQL)
 * and exposes the frozen six + their descriptors. The endpoint (`mountHarnessApi`) reads activity from
 * storage and folds these descriptors in; nothing here touches storage or the network.
 */

import {
	CLAUDE_CODE_EVENT_MAP,
	CODEX_EVENT_MAP,
	CURSOR_EVENT_MAP,
	HERMES_EVENT_MAP,
	OPENCLAW_EVENT_MAP,
	PI_EVENT_MAP,
	createClaudeCodeShim,
	createCodexShim,
	createCursorShim,
	createHermesShim,
	createOpenClawShim,
	createPiShim,
	type ContextChannel,
	type HarnessShim,
	type HostCli,
} from "../../../hooks/index.js";
import type { RuntimePath } from "../../../hooks/shared/contracts.js";

/**
 * The canonical six shim instances, constructed ONCE from the real factories (the shim set). This is
 * the single source the canonical-id list, the descriptors, and the tests all read — derive-or-assert
 * (a-OQ-3): a test compares these to the shims `src/hooks` ships so a seventh cannot silently skip the
 * page. Frozen so no consumer mutates the shared array.
 */
export const CANONICAL_SHIMS: readonly HarnessShim[] = Object.freeze([
	createClaudeCodeShim(),
	createCodexShim(),
	createCursorShim(),
	createHermesShim(),
	createPiShim(),
	createOpenClawShim(),
]);

/**
 * The canonical harness ids (`claude-code` | `codex` | `cursor` | `hermes` | `pi` | `openclaw`),
 * DERIVED from {@link CANONICAL_SHIMS} (parent AC-1 / a-OQ-3). The endpoint enumerates THIS list (not
 * `sessions`), so a harness with zero capture activity still appears. Frozen, stable order.
 */
export const CANONICAL_HARNESS_IDS: readonly string[] = Object.freeze(CANONICAL_SHIMS.map((s) => s.harness));

/** The native event-name map per harness, keyed by canonical id (the shim's `eventMap`, c-AC-4). */
const EVENT_MAPS: Readonly<Record<string, Readonly<Record<string, string>>>> = Object.freeze({
	"claude-code": CLAUDE_CODE_EVENT_MAP,
	codex: CODEX_EVENT_MAP,
	cursor: CURSOR_EVENT_MAP,
	hermes: HERMES_EVENT_MAP,
	pi: PI_EVENT_MAP,
	openclaw: OPENCLAW_EVENT_MAP,
});

/**
 * The Cursor-agent descriptor (parent D-5 / c-AC-3). Cursor runs the `cursor-agent` binary with a
 * `claude` fallback (`CURSOR_HOST_CLI`), the ONE harness that exposes an "agents" surface. The
 * detail page renders an Agents panel iff this field is present; every other harness omits it.
 */
export interface HarnessAgents {
	/** The agent kind (Cursor's `cursor-agent`). */
	readonly kind: string;
	/** The agent binary the harness invokes. */
	readonly binary: string;
	/** The fallback binary when the primary is unavailable (Cursor → `claude`). */
	readonly fallbackBin?: string;
}

/**
 * The data-driven capability descriptor for one harness (PRD-039c), folded into the 039a response
 * server-side (c-OQ-2) so the detail page reflects LIVE shim state without re-importing the shims in
 * the browser. Every field is grounded in `src/hooks/<harness>/shim.ts`. The OPTIONAL fields are the
 * harness-specific divergences — a missing field omits that harness's panel (c-AC-3), never a blank.
 */
export interface HarnessCapabilities {
	/** Canonical harness id (mirrors {@link HarnessShim.harness}). */
	readonly name: string;
	/** Honest support state for this harness in the current production wiring. */
	readonly supportStatus: "supported" | "in-progress";
	/** The runtime path the shim stamps: `plugin` (extension) | `legacy` (hook scripts). */
	readonly runtimePath: RuntimePath;
	/** The context-injection channel: `model-only` | `user-visible`. */
	readonly contextChannel: ContextChannel;
	/** The host CLI for detached summaries (`claude -p`, `cursor-agent`→`claude`, …). */
	readonly hostCli: HostCli;
	/** The native lifecycle events this shim maps (Claude Code = the full six). */
	readonly lifecycleEvents: readonly string[];
	/** Cursor's `cursor-agent` agents — PRESENT for Cursor, ABSENT for Claude Code (c-AC-3). */
	readonly agents?: HarnessAgents;
	/** `true` iff the harness reads its cwd from editor `workspace_roots` (Cursor). */
	readonly workspaceRoots?: boolean;
	/** `true` iff the harness advertises the Honeycomb MCP server/tools (Hermes). */
	readonly mcpRegistration?: boolean;
	/** `true` iff the harness registers contracted tools rather than hooking pre-tool (OpenClaw). */
	readonly contractedTools?: boolean;
	/** `true` iff the harness injects context via a static `AGENTS.md` block (pi). */
	readonly agentsMdContext?: boolean;
	/** `true` iff the harness surfaces a brief user-visible login line (Codex). */
	readonly userVisibleLogin?: boolean;
}

/** The harness-specific capability flags, keyed by canonical id (grounded in each shim module). */
const HARNESS_SPECIFICS: Readonly<Record<string, Partial<HarnessCapabilities>>> = Object.freeze({
	cursor: {
		// `CURSOR_HOST_CLI = { bin: "cursor-agent", fallbackBin: "claude" }` + `cursorDeriveMeta`
		// reads `workspace_roots[0]` — the real Cursor divergences (src/hooks/cursor/shim.ts).
		agents: { kind: "cursor-agent", binary: "cursor-agent", fallbackBin: "claude" },
		workspaceRoots: true,
	},
	// Hermes, pi, and OpenClaw remain in-progress in production (C-1 claim-reduction).
	hermes: {},
	openclaw: {},
	pi: {},
	// Codex surfaces only the brief user-visible login line (CODEX_LOGIN_LINE, codex/shim.ts).
	codex: { userVisibleLogin: true },
	// Claude Code is the REFERENCE: the full six lifecycle events, NO agents panel (the absence is the point).
	"claude-code": {},
});

const SUPPORTED_HARNESSES = new Set(["claude-code", "codex", "cursor"]);

/** Build one harness's capability descriptor from its shim statics + the grounded specifics. */
function buildCapabilities(shim: HarnessShim): HarnessCapabilities {
	const eventMap = EVENT_MAPS[shim.harness] ?? {};
	const lifecycleEvents = Object.keys(eventMap);
	const specifics = HARNESS_SPECIFICS[shim.harness] ?? {};
	return {
		name: shim.harness,
		supportStatus: SUPPORTED_HARNESSES.has(shim.harness) ? "supported" : "in-progress",
		runtimePath: shim.runtimePath,
		contextChannel: shim.contextChannel,
		hostCli: shim.hostCli,
		lifecycleEvents,
		...specifics,
	};
}

/**
 * The frozen per-harness capability descriptors, keyed by canonical id (PRD-039c). Built ONCE from
 * {@link CANONICAL_SHIMS}; the endpoint folds the matching descriptor into each `HarnessStatus`
 * (c-OQ-2). Adding a capability is a new optional field + a `HARNESS_SPECIFICS` entry — not a bespoke
 * page (parent D-5).
 */
export const HARNESS_CAPABILITIES: Readonly<Record<string, HarnessCapabilities>> = Object.freeze(
	Object.fromEntries(CANONICAL_SHIMS.map((s) => [s.harness, buildCapabilities(s)])),
);

/** Look up a harness's capability descriptor by canonical id, or `undefined` for an unknown id. */
export function capabilitiesFor(name: string): HarnessCapabilities | undefined {
	return HARNESS_CAPABILITIES[name];
}
