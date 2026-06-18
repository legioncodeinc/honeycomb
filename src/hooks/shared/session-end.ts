/**
 * Session-end core — PRD-019b Wave 2 (FR-6 / b-AC-5).
 *
 * Session-end exits FAST and pushes work to detached processes (FR-6 / b-AC-5):
 * `markSessionEnded`, `recordSessionUsage`, `forceSessionEndTrigger` (skillify),
 * then acquire the per-session summary lock and spawn the DETACHED summary worker
 * with reason `SessionEnd`. If the spawn throws BEFORE the worker takes ownership,
 * the lock is RELEASED so `--resume` can retrigger.
 *
 * THIN CLIENT: mark/usage/skillify are a single daemon call through
 * {@link HookCoreDeps.daemon} to `/api/hooks/session-end` (the daemon performs the
 * three operations server-side); this module opens NO DeepLake and builds NO SQL
 * (b-AC-2 / D-2). The detached summary worker uses the HOST CLI selected by the
 * shim (`claude -p`, `codex exec`, `cursor-agent`, `pi --print`) — the host-CLI
 * choice is a 019c shim concern (the {@link SummarySpawn} seam below), not a core
 * decision. The per-session lock is the {@link SummaryLock} seam (injected).
 */

import {
	createFakeSummaryLock,
	type HookCoreDeps,
	type HookInput,
	type HookResult,
	type SummaryLock,
} from "./contracts.js";

/** The daemon `/api/hooks/session-end` sub-path (relative to the `/api/hooks` group). */
export const SESSION_END_ENDPOINT = "session-end" as const;

/** The reason stamped on the detached summary worker spawn (FR-6). */
export const SUMMARY_REASON = "SessionEnd" as const;

/**
 * The detached-summary-spawn seam (FR-6). The shim supplies the host CLI for its
 * harness (019c); the core acquires the lock and calls `spawn` AFTER mark/usage/
 * skillify. Injected so a Wave-2 test asserts the lock-then-spawn ordering and the
 * lock-release-on-spawn-throw path (b-AC-5) without launching a real process.
 */
export interface SummarySpawn {
	/** Spawn the detached summary worker for `sessionId`. Throws on spawn failure. */
	spawn(sessionId: string): Promise<void>;
}

/** Build a {@link SummarySpawn} fake that records the spawn (or throws to drive the lock-release path). */
export function createFakeSummarySpawn(opts: { throwOnSpawn?: boolean } = {}): SummarySpawn & {
	readonly spawns: readonly string[];
} {
	const spawns: string[] = [];
	return {
		get spawns(): readonly string[] {
			return spawns;
		},
		async spawn(sessionId: string): Promise<void> {
			if (opts.throwOnSpawn) throw new Error("spawn failed (test)");
			spawns.push(sessionId);
		},
	};
}

/**
 * Run the session-end lifecycle (FR-6 / b-AC-5). In order:
 *   1. mark ended + record usage + fire skillify — ONE daemon call to
 *      `/api/hooks/session-end` (the daemon performs the three server-side). Fail-soft.
 *   2. acquire the per-session summary lock. If another path already holds it, SKIP
 *      the spawn (another session-end is summarizing this session).
 *   3. spawn the DETACHED summary worker (reason `SessionEnd`). If the spawn throws
 *      BEFORE the worker takes ownership, RELEASE the lock so `--resume` retriggers.
 *
 * Exits fast — the heavy summary work is detached. The whole flow is fail-soft: a
 * daemon error in step 1 never blocks the lock+spawn; a spawn throw is contained and
 * releases the lock (b-AC-5). `lock` is injected (defaults to a fake so an unwired
 * call is inert).
 */
export async function runSessionEnd(
	input: HookInput,
	deps: HookCoreDeps,
	spawn: SummarySpawn,
	lock: SummaryLock = createFakeSummaryLock(),
): Promise<HookResult> {
	const sessionId = input.meta.sessionId;

	// Step 1: mark ended + usage + skillify — one daemon call. Fail-soft (a daemon
	// error here must NOT block the summary spawn, which is the durability path).
	await markEndedUsageSkillify(input, deps);

	// Step 2: acquire the per-session summary lock. Already held → another path owns
	// the summary; skip the spawn (no double-spawn).
	const won = await acquireLock(lock, sessionId);
	if (!won) {
		return { ok: true, reason: "summary-lock-held" };
	}

	// Step 3: spawn the detached summary worker. On a throw BEFORE ownership, release
	// the lock so `--resume` retriggers (b-AC-5).
	try {
		await spawn.spawn(sessionId);
	} catch {
		await releaseLock(lock, sessionId);
		return { ok: false, reason: "summary-spawn-failed" };
	}

	return { ok: true };
}

/** POST mark+usage+skillify to `/api/hooks/session-end`. Fail-soft (errors absorbed). */
async function markEndedUsageSkillify(input: HookInput, deps: HookCoreDeps): Promise<void> {
	try {
		await deps.daemon.send({
			endpoint: SESSION_END_ENDPOINT,
			// The daemon maps these intents to markSessionEnded + recordSessionUsage +
			// forceSessionEndTrigger (skillify). The hook STATES what happened.
			body: { intents: ["mark-ended", "record-usage", "skillify"], data: input.data },
			meta: input.meta,
			runtimePath: input.runtimePath,
		});
	} catch {
		// A mark/usage/skillify failure never blocks the summary spawn or breaks exit.
	}
}

/** Acquire the lock, treating a throw as "not won" (fail-soft → skip spawn, never crash). */
async function acquireLock(lock: SummaryLock, sessionId: string): Promise<boolean> {
	try {
		return await lock.acquire(sessionId);
	} catch {
		return false;
	}
}

/** Release the lock on a spawn throw (the `--resume` retrigger path, b-AC-5). Absorb any release error. */
async function releaseLock(lock: SummaryLock, sessionId: string): Promise<void> {
	try {
		await lock.release(sessionId);
	} catch {
		// A release failure is non-fatal: worst case `--resume` cannot retrigger.
	}
}
