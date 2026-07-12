/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

/**
 * The per-turn query-aware recall core - PRD-076a (a-AC-4/6/7).
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────
 * `runUserPromptRecall` is the injector core the runtime dispatches for the new
 * `user_prompt_recall` logical event (the synchronous `UserPromptSubmit` sibling of
 * the async `runCapture`). It reads the prompt text, calls the {@link RecallRenderer}
 * (loopback recall), and returns `{ ok, additionalContext }` - the shim's
 * `renderContext` wraps that block for the host, and the binary's `emitResponse`
 * writes it to stdout, all UNCHANGED (a-AC-4).
 *
 * ── THROTTLED + DEDUPED (a-AC-6/7) ──────────────────────────────────────────
 * Injection is deduped by hit `ref` ACROSS turns: a repeated prompt whose recall
 * returns already-injected hits injects NOTHING new (a-AC-6). Only NEW hits are
 * rendered, so an old hit is never re-injected even when it rides a later turn's
 * result. When recall returns genuinely NOTHING, a lightweight reminder nudge fires -
 * throttled (not every turn), deduped against the last nudge turn (a-AC-7).
 *
 * State persists across turns via the {@link RecallSessionStore} seam - each hook
 * invocation is its own process, so the state is file-backed in production.
 *
 * ── FAIL-SOFT ───────────────────────────────────────────────────────────────
 * The renderer never throws (it resolves to `[]`); this core additionally wraps the
 * render + the credential read, and the runtime's dispatch `try/catch` absorbs any
 * residual throw. The turn always proceeds.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import {
	type CredentialReader,
	EMPTY_RECALL_SNAPSHOT,
	type HookCoreDeps,
	type HookCredential,
	type HookInput,
	type HookResult,
	type RecallHit,
	type RecallRenderer,
	type RecallSessionSnapshot,
	type RecallSessionStore,
} from "./contracts.js";

/** The heading the injected recall block leads with (legible, stable for prompt-cache friendliness). */
export const RECALL_BLOCK_HEADER = "Relevant Honeycomb memory for this prompt:" as const;

/**
 * The lightweight reminder nudge (PRD-076a piece 4). A cheap, STABLE fallback for turns where
 * recall returns nothing: it reminds the model a searchable memory exists without spamming the
 * context. Stable text so a repeat does not churn the prompt cache; throttled + deduped so it
 * fires at most once per {@link NUDGE_INTERVAL_TURNS} (a-AC-7).
 */
export const RECALL_REMINDER =
	"Honeycomb memory is active for this project. Before assuming, you can search past decisions, " +
	"notes, and prior sessions with the Honeycomb memory tools when this turn needs earlier context.";

/** Fire the reminder nudge at most once per this many turns (throttle - a-AC-7). */
export const NUDGE_INTERVAL_TURNS = 5;

/** Cap the persisted dedupe set so a very long session cannot grow the state file unbounded. */
const MAX_TRACKED_REFS = 200;

/**
 * The state directory / file modes (0700 / 0600). The persisted `injectedRefs` can embed a bounded
 * prefix of recalled memory CONTENT (the `text:` ref fallback in `recall-renderer.ts`), so the
 * store is captured-trace-derived and must not be group/world-readable on a shared POSIX host.
 * Explicit modes match the credential/state-store convention used across the codebase
 * (`credentials-store.ts`, `onboarding-store.ts`, `secrets/store.ts`); both are no-ops on win32.
 */
const RECALL_STORE_DIR_MODE = 0o700;
const RECALL_STORE_FILE_MODE = 0o600;

/**
 * Run the per-turn recall injector (a-AC-4/6/7). Reads the prompt, calls the recall renderer,
 * and returns the injectable `additionalContext` - the NEW hits (deduped), or the throttled
 * nudge when recall returned nothing, or nothing at all. Never throws (fail-soft throughout).
 */
export async function runUserPromptRecall(
	input: HookInput,
	deps: HookCoreDeps,
	recall: RecallRenderer,
	store: RecallSessionStore,
): Promise<HookResult> {
	const query = extractPromptText(input.data);
	if (query.trim().length === 0) return { ok: true }; // no prompt text → nothing to recall.

	const credential = await readCredentialSoft(deps.credentials);
	const hits = await renderSoft(recall, {
		meta: input.meta,
		runtimePath: input.runtimePath,
		credential,
		query,
	});

	const sessionId = input.meta.sessionId;
	const prior = store.load(sessionId);
	const turns = prior.turns + 1;
	const injected = new Set(prior.injectedRefs);

	// Dedupe by ref: only hits not already injected this session are candidates (a-AC-6).
	const newHits = hits.filter((hit) => !injected.has(hit.ref));
	if (newHits.length > 0) {
		const block = renderRecallBlock(newHits);
		if (block.length > 0) {
			const refs = [...prior.injectedRefs, ...newHits.map((hit) => hit.ref)].slice(-MAX_TRACKED_REFS);
			store.save(sessionId, { injectedRefs: refs, turns, lastNudgeTurn: prior.lastNudgeTurn });
			// ISS-022: surface the injection to the USER (not just the model). Fires ONLY on a
			// genuinely-new block — deduped-only, empty, and nudge turns stay silent below.
			return { ok: true, additionalContext: block, systemMessage: renderInjectionNotice(newHits, block) };
		}
	}

	// No NEW hit to inject. Only when recall returned GENUINELY nothing do we consider the
	// throttled reminder nudge - a turn whose hits were all already injected stays silent
	// (the memory is clearly working, so no nudge - a-AC-6).
	if (hits.length === 0 && shouldFireNudge(turns, prior.lastNudgeTurn)) {
		store.save(sessionId, { injectedRefs: prior.injectedRefs, turns, lastNudgeTurn: turns });
		return { ok: true, additionalContext: RECALL_REMINDER };
	}

	store.save(sessionId, { injectedRefs: prior.injectedRefs, turns, lastNudgeTurn: prior.lastNudgeTurn });
	return { ok: true };
}

/**
 * Render the NEW recall hits into a bounded, legible context block (a-AC-1 / a-AC-7). Each hit's
 * text is trimmed; empties are skipped. An empty hit set (or all-empty text) yields `""` so the
 * arm injects nothing rather than a malformed/empty block. The hook does NO ranking - the daemon
 * ordered and bounded the hits already.
 */
export function renderRecallBlock(hits: readonly RecallHit[]): string {
	const items = hits
		.map((hit) => hit.text.trim())
		.filter((text) => text.length > 0)
		.map((text) => `- ${text}`);
	if (items.length === 0) return "";
	return `${RECALL_BLOCK_HEADER}\n\n${items.join("\n\n")}`;
}

/**
 * ISS-022: render the user-visible injection notice for a NEW injected block. `N` counts the
 * non-empty new hits (the ones {@link renderRecallBlock} actually rendered); `~X tokens` is the
 * local chars/4 heuristic over the rendered block — hooks CANNOT import daemon code (the
 * NON_DAEMON_ROOT boundary), so the estimate mirrors the daemon's own chars-per-token convention
 * without reaching for it. Deterministic + cheap: no I/O, no daemon call.
 */
export function renderInjectionNotice(newHits: readonly RecallHit[], block: string): string {
	const injectedCount = newHits.filter((hit) => hit.text.trim().length > 0).length;
	const approxTokens = Math.ceil(block.length / 4);
	return `🐝 Honeycomb: ${injectedCount} memories injected (~${approxTokens} tokens)`;
}

/**
 * Decide whether the throttled reminder nudge fires this turn (a-AC-7). Fires on the first
 * eligible turn (never nudged → `lastNudgeTurn < 0`), then at most once per
 * {@link NUDGE_INTERVAL_TURNS} - so it is NOT every turn.
 */
export function shouldFireNudge(turns: number, lastNudgeTurn: number): boolean {
	if (lastNudgeTurn < 0) return true;
	return turns - lastNudgeTurn >= NUDGE_INTERVAL_TURNS;
}

/** Read the prompt text off the normalized capture data (`{ kind, text }`); `""` when absent. */
function extractPromptText(data: unknown): string {
	if (data === null || typeof data !== "object") return "";
	const text = (data as { text?: unknown }).text;
	return typeof text === "string" ? text : "";
}

/** Read the credential fail-soft - a read error resolves to `undefined` (unscoped/signed-out). */
async function readCredentialSoft(credentials: CredentialReader): Promise<HookCredential | undefined> {
	try {
		return await credentials.read();
	} catch {
		return undefined;
	}
}

/** Call the recall renderer fail-soft - a throw resolves to `[]` (the renderer already fail-softs). */
async function renderSoft(
	recall: RecallRenderer,
	req: Parameters<RecallRenderer["render"]>[0],
): Promise<readonly RecallHit[]> {
	try {
		return await recall.render(req);
	} catch {
		return [];
	}
}

/**
 * Build the production {@link RecallSessionStore}: a file-backed per-session snapshot under
 * `~/.honeycomb/recall-sessions/<sessionId>.json`. Each hook invocation is its own process, so
 * the throttle/dedupe state MUST persist out of process (a-AC-6). Stores ONLY hit refs + counters
 * (no query text, no secret). FAIL-SOFT: a read error → the zero-state; a write error is swallowed.
 * `dir` overrides the state directory (tests).
 */
export function createFileRecallSessionStore(dir?: string): RecallSessionStore {
	const baseDir = dir ?? join(homedir(), ".honeycomb", "recall-sessions");
	return {
		load(sessionId: string): RecallSessionSnapshot {
			try {
				const path = snapshotPath(baseDir, sessionId);
				if (!existsSync(path)) return EMPTY_RECALL_SNAPSHOT;
				return coerceSnapshot(JSON.parse(readFileSync(path, "utf8")) as unknown);
			} catch {
				return EMPTY_RECALL_SNAPSHOT;
			}
		},
		save(sessionId: string, snapshot: RecallSessionSnapshot): void {
			try {
				mkdirSync(baseDir, { recursive: true, mode: RECALL_STORE_DIR_MODE });
				writeFileSync(snapshotPath(baseDir, sessionId), JSON.stringify(snapshot), {
					encoding: "utf8",
					mode: RECALL_STORE_FILE_MODE,
				});
			} catch {
				// Fail-soft: a write error never breaks the turn (the next turn re-attempts).
			}
		},
	};
}

/** The state-file path for a session, with the id sanitized so it cannot escape the state dir. */
function snapshotPath(baseDir: string, sessionId: string): string {
	const safe = sessionId.replace(/[^A-Za-z0-9_.-]/g, "_").slice(0, 200);
	return join(baseDir, `${safe.length > 0 ? safe : "session"}.json`);
}

/** Coerce a parsed state-file body to a valid {@link RecallSessionSnapshot} (unknown → zero-state). */
function coerceSnapshot(value: unknown): RecallSessionSnapshot {
	if (value === null || typeof value !== "object") return EMPTY_RECALL_SNAPSHOT;
	const rec = value as Record<string, unknown>;
	const injectedRefs = Array.isArray(rec.injectedRefs)
		? rec.injectedRefs.filter((ref): ref is string => typeof ref === "string")
		: [];
	const turns = isNonNegativeInt(rec.turns) ? rec.turns : 0;
	const lastNudgeTurn = Number.isInteger(rec.lastNudgeTurn) ? (rec.lastNudgeTurn as number) : -1;
	return { injectedRefs, turns, lastNudgeTurn };
}

/** True when `n` is a non-negative integer (a valid turn counter). */
function isNonNegativeInt(n: unknown): n is number {
	return typeof n === "number" && Number.isInteger(n) && n >= 0;
}
