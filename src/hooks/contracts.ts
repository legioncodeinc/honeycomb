/**
 * Per-harness shim contracts — PRD-019c Wave 1 (the thin-override seam).
 *
 * ── THE THESIS (FR-2 / D-4 / c-AC-1) ────────────────────────────────────────
 *   A SHIM IS A THIN OVERRIDE, NOT A FORK. Claude Code is the REFERENCE shim
 *   (full six-event); every other harness (Codex, Cursor, OpenClaw, Hermes, pi,
 *   + OpenCode/Gemini/OhMyPi) overrides ONLY what differs — its event-name map,
 *   payload normalization, context channel, host CLI, and async pattern — and
 *   maps onto the SAME shared core (`src/hooks/shared/`, 019b). No memory logic,
 *   no SQL, no DeepLake lives in shim code; the core owns all of it. Adding a
 *   harness is a small subdirectory, not an engine rewrite.
 *
 * ── MODULE HOME = `src/hooks/<harness>/` ────────────────────────────────────
 * `src/hooks` is in `NON_DAEMON_ROOTS` (`tests/daemon/storage/invariant.test.ts`,
 * D-2). Shim code is thin-client by construction — it normalizes IN and routes the
 * core's result OUT through the harness's native response format; the daemon call
 * happens in the shared core via the injected `DaemonHookClient` seam.
 *
 * ── WHAT A SHIM OVERRIDES (the five divergences, FR-2) ──────────────────────
 *   1. event-name map   — native event vocabulary → {@link LogicalEvent}
 *   2. payload normalize — native payload → {@link HookInput}
 *   3. context channel   — model-only vs user-visible {@link ContextChannel}
 *   4. host CLI          — the binary for detached summaries (`claude -p`, …)
 *   5. async pattern + CLI fallback — for write-intercept-less harnesses (FR-9)
 *
 * Wave 1 ships this contract + the Claude Code REFERENCE shim stub + placeholder
 * dirs for the other harnesses. Wave 2 (019c) fills each shim against the core.
 */

import type { HookInput, HookSessionMeta, LogicalEvent, RuntimePath } from "./shared/contracts.js";

/**
 * The single honest-stub helper every Wave-1 shim stub body calls so an early call
 * FAILS LOUD with a stable, greppable message. Wave 2 deletes each call as it fills
 * the override.
 */
export function notImplemented(what: string): never {
	throw new Error(`PRD-019c: not implemented — ${what}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// ContextChannel — model-only vs user-visible (FR-10 / c-AC-5 / open question)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The channel a harness injects the `additionalContext` block through (FR-10 /
 * c-AC-5). `model-only` lands in the model's context but is not shown to the user
 * (Claude Code `additionalContext`); `user-visible` is rendered in the transcript
 * (Codex's brief login line, Hermes's `{ context }` output). The shim normalizes
 * the SAME logical block to its harness's channel before handoff (PRD open
 * question: normalize vs surface-per-harness — recorded, not resolved, here).
 */
export const CONTEXT_CHANNELS = ["model-only", "user-visible"] as const;

/** One context-injection channel. */
export type ContextChannel = (typeof CONTEXT_CHANNELS)[number];

/**
 * The channel-routed shape a shim hands its host so the SAME logical block lands
 * through the correct surface (FR-10 / c-AC-5). The shared core renders ONE block
 * (`HookResult.additionalContext`); the shim wraps it for its channel:
 *   - `model-only`   → `{ channel: "model-only", additionalContext }` — the block
 *     enters the model's context but is not shown to the user (Claude Code, Cursor,
 *     OpenClaw). The shim renders it under the harness's native key (e.g. Cursor's
 *     `additional_context`) at handoff; the envelope carries the verbatim block.
 *   - `user-visible` → `{ channel: "user-visible", text }` — the block is rendered
 *     in the transcript (Codex's brief login line, Hermes's `{ context }` output,
 *     pi's `AGENTS.md`). `text` is the SAME logical block, possibly condensed by the
 *     shim's {@link ShimSpec.renderUserVisible} (e.g. Codex's brief login line).
 *
 * Both channels carry the same logical content; only the routing (and any
 * harness-specific condensation) differs — so c-AC-5 asserts the block "lands
 * through the correct channel for that harness".
 */
export type ContextEnvelope =
	| {
			readonly channel: "model-only";
			readonly additionalContext: string;
			/**
			 * PRD-076a (a-AC-5): the OPTIONAL Claude Code `hookSpecificOutput` wrapper. ABSENT for the
			 * session-start prime (the envelope stays byte-identical to today — a-AC-8 regression guard);
			 * PRESENT for the per-turn `UserPromptSubmit` recall arm, carrying `{ hookEventName, additionalContext }`
			 * so the host delivers the recall hits under its documented per-event channel
			 * (`references/claude-code/userprompt-response-schema.ts`). The top-level `additionalContext` is
			 * retained alongside it as the Channel-2 fallback, mirroring the 075b block-and-inject precedent.
			 */
			readonly hookSpecificOutput?: { readonly hookEventName: string; readonly additionalContext: string };
			/**
			 * ISS-022 (additive): the OPTIONAL user-visible one-liner (`HookResult.systemMessage`).
			 * Claude Code renders a top-level `systemMessage` response field to the USER (a documented
			 * pass-through field — `references/claude-code/userprompt-response-schema.ts:49`), so the
			 * recall arm surfaces "N memories injected" without touching the model channel. Stamped
			 * ONLY on the `contextHookEvent` (per-turn recall) envelope; the session-start prime
			 * envelope NEVER carries it (the a-AC-8 byte-identical guard).
			 */
			readonly systemMessage?: string;
	  }
	| { readonly channel: "user-visible"; readonly text: string };

// ─────────────────────────────────────────────────────────────────────────────
// HarnessShim — the per-harness override surface (FR-1 / FR-2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A native harness event before normalization. The shim receives this from its
 * host (a hook payload, a plugin callback) and lowers it into a {@link HookInput}.
 * `name` is the harness's native event name; `payload` is the raw, un-normalized
 * body — `unknown` because each harness's shape differs and the shim is the ONLY
 * place that knows it.
 */
export interface NativeEvent {
	/** The harness's native event name (e.g. `PreToolUse`, `beforeSubmitPrompt`). */
	readonly name: string;
	/** The raw harness payload, normalized by the shim into a {@link HookInput}. */
	readonly payload: unknown;
}

/**
 * The host-CLI descriptor for detached summaries (FR-2 / 019b FR-6). The shim
 * declares the binary + args its harness uses so session-end spawns the right
 * worker (`claude -p`, `codex exec --dangerously-bypass-approvals-and-sandbox`,
 * `cursor-agent`/`claude`, `hermes` non-interactive, `pi --print …`).
 */
export interface HostCli {
	/** The summary-worker binary (e.g. `claude`, `codex`, `cursor-agent`, `hermes`, `pi`). */
	readonly bin: string;
	/** The args that put the binary in non-interactive print/exec mode. */
	readonly args: readonly string[];
	/** An optional fallback binary when the primary is unavailable (Cursor → `claude`). */
	readonly fallbackBin?: string;
}

/**
 * The CLI-fallback seam for write-intercept-less harnesses (FR-9 / c-AC-2). A
 * harness with no pre-tool hook cannot intercept a goal/KPI write, so the shim
 * routes the action through a CLI call (`honeycomb goal …`, `honeycomb kpi …`)
 * rather than dropping it. Injected so a Wave-2 test asserts the fallback fires
 * without shelling out for real.
 */
export interface CliFallback {
	/** Route a goal/KPI action through the CLI. Returns the CLI's exit summary. */
	run(argv: readonly string[]): Promise<{ readonly code: number }>;
}

/** Build a {@link CliFallback} fake that records the argv it was asked to run. */
export function createFakeCliFallback(): CliFallback & { readonly runs: readonly (readonly string[])[] } {
	const runs: (readonly string[])[] = [];
	return {
		get runs(): readonly (readonly string[])[] {
			return runs;
		},
		async run(argv: readonly string[]): Promise<{ readonly code: number }> {
			runs.push(argv);
			return { code: 0 };
		},
	};
}

/**
 * The per-harness shim contract (FR-1 / FR-2). Each harness implements this as a
 * THIN override; the shared core (019b) owns the lifecycle behavior. The reference
 * (Claude Code) is the baseline every other shim's test asserts equivalence to
 * (D-4 / c-AC-1).
 */
export interface HarnessShim {
	/** The harness this shim adapts (e.g. `claude-code`, `codex`, `cursor`). */
	readonly harness: string;
	/** The runtime path this surface stamps (FR-10): `plugin` for runtime extensions, `legacy` for hook scripts. */
	readonly runtimePath: RuntimePath;
	/** The context-injection channel for this harness (FR-10 / c-AC-5). */
	readonly contextChannel: ContextChannel;
	/** The host CLI for detached summaries (FR-2 / 019b FR-6). */
	readonly hostCli: HostCli;
	/**
	 * The protocol/event-name source this shim cites (FR-11 / D-3 / c-AC-6). No
	 * sibling repo exists under `references/<harness>/` in THIS repo, so the gate is
	 * a documented contribution rule + a machine-readable citation here: the path the
	 * engineer would inspect for the exact event names and payloads. A Wave-2 test
	 * asserts every shim cites a `references/<harness>/` path.
	 */
	readonly references: string;

	/**
	 * Map a native event name onto a {@link LogicalEvent}, or `undefined` when this
	 * harness has no native equivalent (the lifecycle still completes via the
	 * batched-at-end path, 019b FR-7 / c-AC-1). The event-name map (FR-1).
	 */
	mapEvent(nativeName: string): LogicalEvent | undefined;

	/**
	 * Normalize a native event into a {@link HookInput} the shared core consumes
	 * (FR-2). The ONLY place that knows the harness's payload shape. Returns
	 * `undefined` to drop a non-lifecycle event.
	 */
	normalize(event: NativeEvent, meta: HookSessionMeta): HookInput | undefined;

	/**
	 * Wrap the shared core's rendered context block into this harness's channel
	 * envelope (FR-10 / c-AC-5). The core renders ONE block; the shim routes it
	 * model-only or user-visible per {@link contextChannel}. The ONLY place the
	 * channel divergence is applied.
	 *
	 * ISS-022 (additive, source-compatible): `extras` optionally carries the core's
	 * user-visible `systemMessage`. The shared engine applies it per channel — spread
	 * top-level onto the `contextHookEvent` (per-turn recall) model-only envelope,
	 * appended to the user-visible text — and IGNORES it on the plain model-only
	 * (session-start prime) envelope so that arm stays byte-identical (a-AC-8).
	 * Existing single-argument callers are unaffected.
	 */
	renderContext(block: string, extras?: { readonly systemMessage?: string }): ContextEnvelope;

	/**
	 * OPTIONAL host-native stdout renderer for hook binaries whose response schema
	 * cannot accept the shared {@link ContextEnvelope} directly. The shared binary
	 * passes the native event name so the shim can stamp the host's required
	 * event-specific discriminator. Returning `undefined` keeps the shared envelope
	 * fallback for events the shim does not override.
	 */
	renderHookResponse?(
		nativeEventName: string,
		block: string,
		extras?: { readonly systemMessage?: string },
	): unknown | undefined;

	/**
	 * OPTIONAL: hand the session-start hygiene pulls (skills / assets / graph) to a
	 * DETACHED CHILD process so the parent hook binary does no in-process hygiene I/O
	 * and can exit promptly after writing its response. When a shim implements this,
	 * `runSessionStart` calls it INSTEAD of the three hygiene seams (`autoPullSkills` /
	 * `autoPullAssets` / `spawnGraphPull`) and the runtime builds the parent with no-op
	 * seams for those three.
	 *
	 * Why this exists: `backgroundPull` detaches the await but NOT the underlying fetch
	 * I/O. The pending loopback sockets keep the parent's event loop alive for seconds
	 * after stdout is written, so Claude Code's hook runner perceived the hook as still
	 * running. `process.exit(0)` to force exit CRASHES on Windows (libuv assertion when
	 * sockets are mid-flight). Spawning the hygiene in a detached + unref'd child keeps
	 * the parent's loop free of hygiene I/O, so the parent exits naturally in
	 * milliseconds on every platform. The child runs to completion on its own.
	 *
	 * ABSENT (the default for harnesses that have not opted in) → the runtime runs the
	 * three hygiene seams in-process via `backgroundPull` (the prior behavior). This
	 * keeps every other harness unchanged; only a harness that ships a hygiene child
	 * bundle + implements this method opts into the off-process path.
	 *
	 * Fail-soft: the implementation MUST never throw (a hygiene spawn failure is
	 * best-effort — the next session-start tries again). The seams are idempotent, so a
	 * missed pull here is a no-op for the next run.
	 *
	 * @param meta the session metadata (passed to the child via env so it can run the
	 *   graph-pull seam with the right conversation path).
	 */
	spawnHygieneChild?(meta: HookSessionMeta): void;
}

export type { HookInput, HookSessionMeta, LogicalEvent, RuntimePath };
