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
 * PRD-076a - the recall core helpers + the file-backed session store + the coexistence gate.
 *
 *   - `renderRecallBlock` produces a bounded, legible block (a-AC-1) and "" for an empty set (a-AC-7).
 *   - `shouldFireNudge` throttles the reminder (a-AC-7): fires first, then once per interval.
 *   - `createFileRecallSessionStore` round-trips a snapshot and is fail-soft (a-AC-6 cross-process state).
 *   - the hooks.json coexistence (Option A) CONFORMS to the references gate + carries the injector arg.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { RECALL_HOOK_ARG } from "../../../src/hooks/claude-code/shim.js";
import {
	createFakeCredentialReader,
	createFakeDaemonHookClient,
	createFakeContextRenderer,
	createFakeRecallRenderer,
	createFakeRecallSessionStore,
	EMPTY_RECALL_SNAPSHOT,
	type HookCoreDeps,
	type HookInput,
	type RecallHit,
} from "../../../src/hooks/shared/contracts.js";
import {
	createFileRecallSessionStore,
	NUDGE_INTERVAL_TURNS,
	RECALL_BLOCK_HEADER,
	RECALL_REMINDER,
	renderInjectionNotice,
	renderRecallBlock,
	runUserPromptRecall,
	shouldFireNudge,
} from "../../../src/hooks/shared/user-prompt-recall.js";
import { assertClaudeCodeHooksConform } from "../../../references/claude-code/hooks-schema.js";

const HITS: readonly RecallHit[] = [
	{ ref: "memories:m1", text: "  Token TTL dropped to 1h.  " },
	{ ref: "sessions:s9", text: "auth refactor thread" },
];

describe("PRD-076a renderRecallBlock: bounded, legible, never malformed", () => {
	it("renders a headed, trimmed, bullet block for the given hits (a-AC-1)", () => {
		const block = renderRecallBlock(HITS);
		expect(block.startsWith(RECALL_BLOCK_HEADER)).toBe(true);
		expect(block).toContain("- Token TTL dropped to 1h.");
		expect(block).toContain("- auth refactor thread");
		// Text is trimmed (no leading/trailing whitespace inside the bullet).
		expect(block).not.toContain("-   Token");
	});

	it("returns '' for an empty hit set (a-AC-7 - never an empty block)", () => {
		expect(renderRecallBlock([])).toBe("");
	});

	it("skips whitespace-only hit text (never a malformed bullet)", () => {
		expect(renderRecallBlock([{ ref: "x:1", text: "   " }])).toBe("");
	});
});

describe("PRD-076a shouldFireNudge: throttled reminder cadence (a-AC-7)", () => {
	it("fires on the first eligible turn (never nudged)", () => {
		expect(shouldFireNudge(1, -1)).toBe(true);
	});

	it("does NOT fire again within the throttle interval", () => {
		expect(shouldFireNudge(2, 1)).toBe(false);
		expect(shouldFireNudge(1 + NUDGE_INTERVAL_TURNS - 1, 1)).toBe(false);
	});

	it("fires again once the interval has elapsed", () => {
		expect(shouldFireNudge(1 + NUDGE_INTERVAL_TURNS, 1)).toBe(true);
	});
});

describe("PRD-076a createFileRecallSessionStore: cross-process state (a-AC-6)", () => {
	it("round-trips a snapshot to disk and reads it back", () => {
		const dir = mkdtempSync(join(tmpdir(), "hc-recall-"));
		try {
			const store = createFileRecallSessionStore(dir);
			expect(store.load("sess-a"), "a fresh session is the zero-state").toEqual(EMPTY_RECALL_SNAPSHOT);
			store.save("sess-a", { injectedRefs: ["memories:m1"], turns: 3, lastNudgeTurn: 2 });
			expect(store.load("sess-a")).toEqual({ injectedRefs: ["memories:m1"], turns: 3, lastNudgeTurn: 2 });
			// The state file exists under the sanitized session id.
			expect(existsSync(join(dir, "sess-a.json"))).toBe(true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("sanitizes the session id so it cannot escape the state directory", () => {
		const dir = mkdtempSync(join(tmpdir(), "hc-recall-"));
		try {
			const store = createFileRecallSessionStore(dir);
			store.save("../../etc/evil", { injectedRefs: [], turns: 1, lastNudgeTurn: -1 });
			// No path traversal: the slashes are flattened to `_`, so the state file is a single flat
			// name INSIDE `dir` and nothing is written to the traversal target outside it.
			expect(existsSync(join(dir, ".._.._etc_evil.json"))).toBe(true);
			expect(existsSync(join(tmpdir(), "etc", "evil.json"))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	// SECURITY (recall-store default-permission exposure): the persisted `injectedRefs` can embed a
	// bounded prefix of recalled memory CONTENT (the `text:` ref fallback), so the store is
	// captured-trace-derived and must not be group/world-readable on a shared POSIX host. The dir is
	// created 0700 and the file 0600. Skipped on win32 where POSIX modes are a no-op (NTFS ACLs).
	it.skipIf(process.platform === "win32")(
		"writes the state dir 0700 and the state file 0600 (no group/world read of recalled content)",
		() => {
			const parent = mkdtempSync(join(tmpdir(), "hc-recall-perm-"));
			const dir = join(parent, "recall-sessions");
			try {
				const store = createFileRecallSessionStore(dir);
				store.save("sess-perm", { injectedRefs: ["text:a recalled memory fragment"], turns: 1, lastNudgeTurn: -1 });
				expect(statSync(dir).mode & 0o777).toBe(0o700);
				expect(statSync(join(dir, "sess-perm.json")).mode & 0o777).toBe(0o600);
			} finally {
				rmSync(parent, { recursive: true, force: true });
			}
		},
	);

	it("is fail-soft: a corrupt state file degrades to the zero-state", () => {
		const dir = mkdtempSync(join(tmpdir(), "hc-recall-"));
		try {
			const store = createFileRecallSessionStore(dir);
			store.save("sess-b", { injectedRefs: ["x"], turns: 1, lastNudgeTurn: 0 });
			// Corrupt the file, then load - must not throw, must return the zero-state.
			const path = join(dir, "sess-b.json");
			writeFileSync(path, "{ not json", "utf8");
			expect(store.load("sess-b")).toEqual(EMPTY_RECALL_SNAPSHOT);
			expect(readFileSync(path, "utf8")).toBe("{ not json");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// ISS-022 — the user-visible `systemMessage` injection notice on the recall core.
// ─────────────────────────────────────────────────────────────────────────────

/** The shared fake seam bundle for driving `runUserPromptRecall` directly. */
function fakeDeps(): HookCoreDeps {
	return {
		daemon: createFakeDaemonHookClient(),
		credentials: createFakeCredentialReader({ token: "t", org: "acme" }),
		context: createFakeContextRenderer(),
	};
}

/** A `user_prompt_recall` HookInput carrying the given prompt text. */
function recallInput(text: string): HookInput {
	return {
		event: "user_prompt_recall",
		meta: { sessionId: "sess-iss022", path: "conversations/sess-iss022", cwd: "/repo/honeycomb" },
		data: { kind: "user_message", text },
		runtimePath: "plugin",
	};
}

describe("ISS-022 runUserPromptRecall: systemMessage fires ONLY when a NEW block is injected", () => {
	it("a new-hit turn carries the notice with the correct N (non-empty hits) and ~X (chars/4)", async () => {
		const result = await runUserPromptRecall(
			recallInput("what changed in auth?"),
			fakeDeps(),
			createFakeRecallRenderer(HITS),
			createFakeRecallSessionStore(),
		);
		const block = renderRecallBlock(HITS);
		expect(result.additionalContext).toBe(block);
		expect(result.systemMessage).toBe(`🐝 Honeycomb: 2 memories injected (~${Math.ceil(block.length / 4)} tokens)`);
	});

	it("N counts only NON-EMPTY new hits (a whitespace-only hit does not inflate the count)", async () => {
		const mixed: readonly RecallHit[] = [...HITS, { ref: "memories:blank", text: "   " }];
		const result = await runUserPromptRecall(
			recallInput("auth?"),
			fakeDeps(),
			createFakeRecallRenderer(mixed),
			createFakeRecallSessionStore(),
		);
		// The blank hit renders no bullet, so it is not counted in N either.
		const block = renderRecallBlock(mixed);
		expect(result.systemMessage).toBe(`🐝 Honeycomb: 2 memories injected (~${Math.ceil(block.length / 4)} tokens)`);
	});

	it("a deduped-only turn (same hits again) carries NO systemMessage and NO block", async () => {
		const store = createFakeRecallSessionStore();
		const deps = fakeDeps();
		const recall = createFakeRecallRenderer(HITS);
		const turn1 = await runUserPromptRecall(recallInput("auth?"), deps, recall, store);
		expect(turn1.systemMessage, "turn 1 injects and notifies").toBeDefined();
		const turn2 = await runUserPromptRecall(recallInput("auth again?"), deps, recall, store);
		expect(turn2.additionalContext, "turn 2 injects nothing new").toBeUndefined();
		expect(turn2.systemMessage, "no notice on a deduped-only turn").toBeUndefined();
	});

	it("an empty-recall NUDGE turn carries the reminder but NO systemMessage", async () => {
		const result = await runUserPromptRecall(
			recallInput("hello?"),
			fakeDeps(),
			createFakeRecallRenderer([]),
			createFakeRecallSessionStore(),
		);
		expect(result.additionalContext, "the nudge fires on the first empty turn").toBe(RECALL_REMINDER);
		expect(result.systemMessage, "the nudge is model-facing only — no user notice").toBeUndefined();
	});

	it("an empty-recall throttled-off turn carries neither block nor systemMessage", async () => {
		const store = createFakeRecallSessionStore();
		const deps = fakeDeps();
		const recall = createFakeRecallRenderer([]);
		await runUserPromptRecall(recallInput("hi"), deps, recall, store); // turn 1 nudges.
		const turn2 = await runUserPromptRecall(recallInput("hi again"), deps, recall, store);
		expect(turn2.additionalContext).toBeUndefined();
		expect(turn2.systemMessage).toBeUndefined();
	});
});

describe("ISS-022 renderInjectionNotice: the local heuristic (no daemon import across NON_DAEMON_ROOT)", () => {
	it("formats N from the non-empty hits and ~X = ceil(block.length / 4)", () => {
		const block = renderRecallBlock(HITS);
		expect(renderInjectionNotice(HITS, block)).toBe(
			`🐝 Honeycomb: 2 memories injected (~${Math.ceil(block.length / 4)} tokens)`,
		);
	});

	it("singular: one hit reads 'memory', never '1 memories'", () => {
		const one = HITS.slice(0, 1);
		const block = renderRecallBlock(one);
		expect(renderInjectionNotice(one, block)).toBe(
			`🐝 Honeycomb: 1 memory injected (~${Math.ceil(block.length / 4)} tokens)`,
		);
	});
});

describe("PRD-076a coexistence (Option A): hooks.json conforms to the references gate", () => {
	it("registers UserPromptSubmit TWICE (sync injector + async capture) and conforms to the gate", () => {
		const hooks = JSON.parse(readFileSync(join(process.cwd(), "harnesses/claude-code/hooks/hooks.json"), "utf8")) as {
			hooks: Record<string, Array<{ hooks: Array<{ command: string; async?: boolean }> }>>;
		};

		// The references gate ACCEPTS multiple matcher blocks per event (Option A is valid).
		expect(() => assertClaudeCodeHooksConform(hooks)).not.toThrow();

		const entries = hooks.hooks.UserPromptSubmit;
		expect(entries, "UserPromptSubmit is registered twice").toHaveLength(2);

		const injector = entries.find((e) => e.hooks.some((h) => h.command.includes(RECALL_HOOK_ARG)));
		const capture = entries.find((e) => e.hooks.some((h) => h.async === true));
		// The injector is synchronous (no async) and carries the recall arg.
		expect(injector, "a synchronous injector entry carries the recall arg").toBeDefined();
		expect(injector?.hooks[0].async, "the injector is synchronous").toBeUndefined();
		// The capture entry is unchanged (async: true, no recall arg).
		expect(capture, "the async capture entry is preserved").toBeDefined();
		expect(capture?.hooks[0].command.includes(RECALL_HOOK_ARG), "capture does not carry the recall arg").toBe(false);
	});
});
