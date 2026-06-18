/**
 * pi shim — PRD-019c Wave 2 (FR-7 / c-AC-2).
 *
 * pi (extension + `AGENTS.md` block) is the most minimal lifecycle:
 *   1. context injects via the STATIC `AGENTS.md` block (channel: `user-visible`,
 *      the static doc) — {@link piAgentsBlock} renders the block the extension writes
 *      into `AGENTS.md`. Recall is ON-DEMAND (the model reads the block), not pushed
 *      per turn.
 *   2. it maps `agent_end` + `session_shutdown` → session-end and has NO `PreToolUse`
 *      (so goal/KPI writes route through the CLI fallback, FR-9 / c-AC-2).
 *   3. host CLI `pi --print --provider <p> --model <m>` — `<p>`/`<m>` are resolved at
 *      spawn time from the active provider/model ({@link piResolveHostCli}); runtime
 *      path `plugin`.
 *
 * IMPL NOTE (FR-7): only the summary worker lives under `src/hooks/pi/` — pi's
 * extension entry point is pi-specific TypeScript pi compiles directly at
 * `harnesses/pi/extension-source/honeycomb.ts` (delivered as raw `.ts`, NOT
 * pre-compiled). This shim provides the event map + summary host-CLI + the static
 * block; the extension source does the on-demand recall.
 *
 * References gate (FR-11 / D-3 / c-AC-6): cited at `references/pi/`.
 */

import { type CliFallback, type ContextChannel, type HarnessShim, type HostCli, type RuntimePath } from "../contracts.js";
import { asRecord, createShim, sessionEndData } from "../normalize.js";
import type { HookSessionMeta, LogicalEvent } from "../shared/contracts.js";

export const PI_EVENT_MAP: Readonly<Record<string, LogicalEvent>> = {
	agent_end: "session-end",
	session_shutdown: "session-end",
};

export const PI_CONTEXT_CHANNEL: ContextChannel = "user-visible";
export const PI_RUNTIME_PATH: RuntimePath = "plugin";
// `<p>`/`<m>` are placeholders resolved by `piResolveHostCli` at spawn time.
export const PI_HOST_CLI: HostCli = { bin: "pi", args: ["--print", "--provider", "<p>", "--model", "<m>"] };
export const PI_REFERENCES = "references/pi/" as const;

/**
 * Resolve pi's summary host CLI for the active provider/model (FR-7). pi's summary
 * worker shells `pi --print --provider <p> --model <m>`; this fills `<p>`/`<m>` at
 * spawn time. Defers to the active session's provider/model.
 */
export function piResolveHostCli(provider: string, model: string): HostCli {
	return { bin: "pi", args: ["--print", "--provider", provider, "--model", model] };
}

/**
 * Render the STATIC `AGENTS.md` block pi injects (FR-7 / c-AC-5). The full recall
 * block is wrapped in a fenced Honeycomb section the pi extension writes into
 * `AGENTS.md`; an empty block renders nothing (no section written). This is the
 * user-visible channel for pi (the static doc the model reads on demand).
 */
export function piAgentsBlock(block: string): string {
	if (block.trim() === "") return "";
	return `<!-- honeycomb:start -->\n${block}\n<!-- honeycomb:end -->`;
}

/** pi renders its user-visible context through the static `AGENTS.md` block. */
export function piRenderUserVisible(block: string): string {
	return piAgentsBlock(block);
}

/**
 * Route a goal/KPI write through the CLI fallback (FR-9 / c-AC-2). pi has NO pre-tool
 * hook, so the shim shells `honeycomb goal …` / `honeycomb kpi …` via the injected
 * {@link CliFallback} seam rather than dropping the action.
 */
export async function piGoalKpiFallback(
	cli: CliFallback,
	verb: "goal" | "kpi",
	args: readonly string[],
): Promise<{ readonly code: number }> {
	return cli.run(["honeycomb", verb, ...args]);
}

/**
 * Lower a pi native payload (FR-7). pi only fires session-end events
 * (`agent_end`/`session_shutdown`); the per-turn capture is batched at end through
 * the 019b core's `runCaptureBatch` (the OpenClaw-style completeness path, FR-7),
 * which the extension source drives from the conversation buffer.
 */
export function piExtractData(raw: unknown, logical: LogicalEvent): unknown | undefined {
	if (logical !== "session-end") return undefined;
	const reason = asRecord(raw).reason;
	return sessionEndData(typeof reason === "string" ? reason : "session_shutdown");
}

/** Construct the pi shim (FR-7). Static AGENTS.md block + no pre-tool + CLI fallback. */
export function createPiShim(): HarnessShim {
	return createShim({
		harness: "pi",
		runtimePath: PI_RUNTIME_PATH,
		contextChannel: PI_CONTEXT_CHANNEL,
		hostCli: PI_HOST_CLI,
		references: PI_REFERENCES,
		eventMap: PI_EVENT_MAP,
		renderUserVisible: piRenderUserVisible,
		extractData(raw: unknown, logical: LogicalEvent, _meta: HookSessionMeta): unknown | undefined {
			void _meta;
			return piExtractData(raw, logical);
		},
	});
}
