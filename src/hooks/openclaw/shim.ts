/**
 * OpenClaw shim — PRD-019c Wave 2 (FR-5 / c-AC-3 / c-AC-2).
 *
 * OpenClaw (native extension flagship + connector) has the most divergent lifecycle:
 *   1. it BATCHES capture at `agent_end`, sending ONLY the slice of NEW messages
 *      since the previous flush (c-AC-3). {@link openclawSliceSinceLastFlush} cuts
 *      the slice by a cursor; {@link openclawExpandBatch} normalizes it to one
 *      {@link HookInput} per message, which the shim flushes through the 019b core's
 *      `runCaptureBatch` — so the daemon writes the SAME rows as incremental capture
 *      (019b FR-7 / b-AC-1).
 *   2. it auto-routes the agent from the session key (`agent:alice:...`) via
 *      `deriveMeta` (FR-5).
 *   3. it maps `before_agent_start` + `before_prompt_build` → session-start, and has
 *      NO `PreToolUse` (tools are registered, not hooked) — so goal/KPI writes route
 *      through the CLI fallback ({@link CliFallback}, FR-9 / c-AC-2) instead of a
 *      pre-tool intercept.
 *   4. channel `model-only`; runtime path `plugin` (the native extension).
 *
 * BUNDLE CONSTRAINT: this shim is bundled into the OpenClaw thin-client bundle that
 * ClawHub statically scans. It adds NO `child_process` and NO `process.env`-near-
 * network — it only normalizes and routes through injected seams (the daemon call +
 * the CLI fallback are seams supplied by the core / connector, not spawned here).
 *
 * References gate (FR-11 / D-3 / c-AC-6): cited at `references/openclaw/`.
 */

import { type CliFallback, type ContextChannel, type HarnessShim, type HostCli, type RuntimePath } from "../contracts.js";
import {
	asRecord,
	assistantMessageData,
	createShim,
	sessionEndData,
	sessionStartData,
	toolCallData,
	userMessageData,
} from "../normalize.js";
import type { HookInput, HookSessionMeta, LogicalEvent } from "../shared/contracts.js";

/**
 * The canonical OpenClaw harness token (= the `agent` value its captured turns are
 * attributed to, the same token `harness-registry.CANONICAL_SHIMS` derives the six
 * from). Single-sourced so the `createShim` spec AND the batch path stamp ONE string.
 */
export const OPENCLAW_HARNESS = "openclaw" as const;

export const OPENCLAW_EVENT_MAP: Readonly<Record<string, LogicalEvent>> = {
	before_agent_start: "session-start",
	before_prompt_build: "session-start",
	agent_end: "session-end",
};

export const OPENCLAW_CONTEXT_CHANNEL: ContextChannel = "model-only";
export const OPENCLAW_RUNTIME_PATH: RuntimePath = "plugin";
// OpenClaw summaries run as a NEW slice via the native extension, not a host-CLI exec
// (the bundle stubs child_process); the host-CLI descriptor is empty here.
export const OPENCLAW_HOST_CLI: HostCli = { bin: "", args: [] };
export const OPENCLAW_REFERENCES = "references/openclaw/" as const;

/**
 * One message in an OpenClaw `agent_end` slice. The native payload carries the whole
 * conversation; the shim sends only the NEW tail (c-AC-3). `role` discriminates the
 * logical event each message normalizes to.
 */
export interface OpenClawMessage {
	readonly role: "user" | "assistant" | "tool";
	readonly text?: string;
	readonly tool?: string;
	readonly input?: unknown;
	readonly response?: unknown;
}

/**
 * Auto-route the per-USER agent from the OpenClaw session key (`agent:alice:...` →
 * `alice`) onto the ENGINE scope `agentId` (FR-5). When the session id is namespaced
 * `agent:<name>:...`, the `<name>` segment is the capturing per-user agent; otherwise
 * the base meta is unchanged.
 *
 * It sets ONLY `agentId` (+ `author`, downstream) — NOT `agent`. `agent` is the
 * CANONICAL HARNESS token (`openclaw`), stamped by the shared engine (`createShim`)
 * and the batch path; the Harnesses page GROUPs BY `agent`, so routing the per-user
 * name there would mis-attribute OpenClaw's turns to a phantom `alice` harness and
 * leave `openclaw` reading 0. The two identities live in two columns by design.
 */
export function openclawDeriveMeta(_raw: unknown, base: HookSessionMeta): HookSessionMeta {
	void _raw;
	const match = /^agent:([^:]+):/.exec(base.sessionId);
	if (match) return { ...base, agentId: match[1] };
	return base;
}

/**
 * Cut the NEW-message slice since the last flush (c-AC-3). `cursor` is the index of
 * the first un-flushed message (0 on the first flush); the returned slice is the
 * messages from `cursor` to the end. The shim persists the new cursor (= total
 * length) so the NEXT `agent_end` sends only what arrived since — never re-sending
 * already-captured messages, so the daemon rows match incremental capture (b-AC-1).
 */
export function openclawSliceSinceLastFlush(
	messages: readonly OpenClawMessage[],
	cursor: number,
): { readonly slice: readonly OpenClawMessage[]; readonly nextCursor: number } {
	const start = Math.max(0, Math.min(cursor, messages.length));
	return { slice: messages.slice(start), nextCursor: messages.length };
}

/**
 * Normalize an OpenClaw message slice into one {@link HookInput} per message, in
 * order (c-AC-3 / b-AC-1). Each message becomes the SAME canonical capture data the
 * reference produces (`user_message`/`assistant_message`/`tool_call`), so flushing
 * the slice through the 019b core's `runCaptureBatch` writes IDENTICAL daemon rows
 * to incremental capture. The shim passes the result to `runCaptureBatch`.
 */
export function openclawExpandBatch(
	messages: readonly OpenClawMessage[],
	meta: HookSessionMeta,
): readonly HookInput[] {
	const fullMeta = openclawDeriveMeta(undefined, meta);
	const inputs: HookInput[] = [];
	for (const m of messages) {
		const data = openclawMessageData(m);
		if (data === undefined) continue;
		inputs.push({
			event: openclawMessageEvent(m.role),
			// Stamp the canonical harness token (`openclaw`) into `agent` on the BATCH path too —
			// this slice-expansion bypasses `createShim.normalize`, so without this the batched
			// rows would land with `agent=""` and the Harnesses page would read 0 for OpenClaw.
			// `agentId` (the per-USER agent from `openclawDeriveMeta`) stays distinct in `fullMeta`.
			meta: { ...fullMeta, agent: OPENCLAW_HARNESS, hookEventName: "agent_end" },
			data,
			runtimePath: OPENCLAW_RUNTIME_PATH,
		});
	}
	return inputs;
}

/** Map an OpenClaw message role to its logical capture event. */
function openclawMessageEvent(role: OpenClawMessage["role"]): LogicalEvent {
	switch (role) {
		case "user":
			return "user_message";
		case "assistant":
			return "assistant_message";
		case "tool":
			return "tool_call";
	}
}

/** Normalize one OpenClaw message into the canonical capture data shape. */
function openclawMessageData(m: OpenClawMessage): unknown | undefined {
	switch (m.role) {
		case "user":
			return userMessageData(m.text ?? "");
		case "assistant":
			return assistantMessageData(m.text ?? "");
		case "tool":
			return toolCallData(m.tool ?? "", m.input, m.response);
	}
}

/**
 * Route a goal/KPI write through the CLI fallback (FR-9 / c-AC-2). OpenClaw has NO
 * pre-tool hook, so it cannot intercept the write the way Claude Code does — instead
 * the shim shells `honeycomb goal …` / `honeycomb kpi …` via the injected
 * {@link CliFallback} seam rather than dropping the action. Returns the CLI exit code.
 */
export async function openclawGoalKpiFallback(
	cli: CliFallback,
	verb: "goal" | "kpi",
	args: readonly string[],
): Promise<{ readonly code: number }> {
	return cli.run(["honeycomb", verb, ...args]);
}

/**
 * Lower an OpenClaw native payload for the single-event path (`normalize`).
 * `before_agent_start`/`before_prompt_build` → session-start; `agent_end` →
 * session-end. The MESSAGE-SLICE capture is the batch path
 * ({@link openclawExpandBatch}), not this single-event normalizer.
 */
export function openclawExtractData(raw: unknown, logical: LogicalEvent): unknown | undefined {
	switch (logical) {
		case "session-start":
			return sessionStartData(typeof asRecord(raw).source === "string" ? (asRecord(raw).source as string) : "agent_start");
		case "session-end":
			return sessionEndData(typeof asRecord(raw).reason === "string" ? (asRecord(raw).reason as string) : "agent_end");
		default:
			return undefined;
	}
}

/** Construct the OpenClaw shim (FR-5). Agent auto-route + new-slice batch + CLI fallback. */
export function createOpenClawShim(): HarnessShim {
	return createShim({
		harness: OPENCLAW_HARNESS,
		runtimePath: OPENCLAW_RUNTIME_PATH,
		contextChannel: OPENCLAW_CONTEXT_CHANNEL,
		hostCli: OPENCLAW_HOST_CLI,
		references: OPENCLAW_REFERENCES,
		eventMap: OPENCLAW_EVENT_MAP,
		deriveMeta: openclawDeriveMeta,
		extractData(raw: unknown, logical: LogicalEvent, _meta: HookSessionMeta): unknown | undefined {
			void _meta;
			return openclawExtractData(raw, logical);
		},
	});
}
