/**
 * PRD-020d state seams — the real ClaimLock (`wx`/EEXIST) + NotificationsState (temp+rename).
 *
 * Drives the GENUINE `createClaimLock` / `createNotificationsState` factories against an
 * in-memory `StateFs` that honors the SAME `EEXIST`/atomic-rename contract as `node:fs`, so the
 * LOGIC — the exclusive-create race winner/loser split (d-AC-1) and the crash-safe temp→rename
 * write (FR-5 / d-AC-4) — is verified without touching disk.
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
	CLAIM_DIR_NAME,
	createClaimLock,
	createInMemoryStateFs,
	createNotificationsState,
	STATE_FILE_NAME,
} from "../../src/notifications/index.js";

const DIR = "/tmp/hc-state";
/**
 * The on-disk state-file path the factory reads, built with the SAME `join` the source uses —
 * so a SEEDED file actually lands where `createNotificationsState` looks (otherwise a path
 * mismatch makes a "garbled file" test pass for the wrong reason: file-absent → empty).
 */
const STATE_PATH = join(DIR, STATE_FILE_NAME);

describe("d-AC-1: claim lock — exclusive create gives exactly one winner across racers", () => {
	it("d-AC-1 first claim of a key wins (true); a racer before release hits EEXIST → loses (false)", () => {
		const fs = createInMemoryStateFs();
		const lock = createClaimLock({ dir: DIR, fs });

		const first = lock.claim("welcome");
		const racer = lock.claim("welcome");

		expect(first).toBe(true); // the first process created the claim file → emits.
		expect(racer).toBe(false); // the racer hit EEXIST → skips → exactly one banner.
		// The claim file lives under the claims/ subdir.
		expect([...fs.files.keys()].some((p) => p.includes(CLAIM_DIR_NAME))).toBe(true);
	});

	it("d-AC-1 release unlinks the claim so a future session re-claims (transient re-emit, FR-6)", () => {
		const fs = createInMemoryStateFs();
		const lock = createClaimLock({ dir: DIR, fs });

		expect(lock.claim("payment-fail")).toBe(true);
		lock.release("payment-fail");
		// After release the claim file is gone, so the next session wins the claim again.
		expect(lock.claim("payment-fail")).toBe(true);
	});

	it("d-AC-1 distinct keys never collide (independent locks)", () => {
		const fs = createInMemoryStateFs();
		const lock = createClaimLock({ dir: DIR, fs });
		expect(lock.claim("a")).toBe(true);
		expect(lock.claim("b")).toBe(true);
	});

	it("rejects every unsafe claim key shape (no escape from claims/)", () => {
		const lock = createClaimLock({ dir: DIR, fs: createInMemoryStateFs() });
		// Each guard arm of safeClaimSegment is a separate path-escape defense — pin them ALL so a
		// dropped `||` clause cannot silently re-open one vector (the security floor for the lock).
		expect(() => lock.claim("../escape")).toThrow(/unsafe claim key/); // parent traversal.
		expect(() => lock.claim("")).toThrow(/unsafe claim key/); // empty key.
		expect(() => lock.claim("a/b")).toThrow(/unsafe claim key/); // forward-slash separator.
		expect(() => lock.claim("a\\b")).toThrow(/unsafe claim key/); // back-slash separator.
		expect(() => lock.claim("..")).toThrow(/unsafe claim key/); // bare dot-dot.
		// A safe single-segment key is accepted (the guard does not over-reject).
		expect(lock.claim("welcome-v1")).toBe(true);
	});
});

describe("d-AC-4 (state): persistent show-once via temp-file + atomic rename", () => {
	it("d-AC-4 markShown records a dedupKey; wasShown reports it on the next load", () => {
		const fs = createInMemoryStateFs();
		const state = createNotificationsState({ dir: DIR, fs });

		expect(state.wasShown("welcome:v1")).toBe(false);
		state.markShown({ id: "welcome", dedupKey: "welcome:v1", shownAt: "2026-06-18T00:00:00.000Z" });
		expect(state.wasShown("welcome:v1")).toBe(true);

		// A fresh state instance over the SAME fs sees the persisted record (no in-memory cache lie).
		const reopened = createNotificationsState({ dir: DIR, fs });
		expect(reopened.wasShown("welcome:v1")).toBe(true);
	});

	it("d-AC-4 markShown MERGES with prior records — a second mark does not erase the first", () => {
		// The `{ ...current.seen, [key]: record }` merge is load-bearing: marking a second banner
		// must not drop the first (otherwise show-once regresses). Pins the spread/merge.
		const fs = createInMemoryStateFs();
		const state = createNotificationsState({ dir: DIR, fs });
		state.markShown({ id: "a", dedupKey: "a:1", shownAt: "2026-06-18T00:00:00.000Z" });
		state.markShown({ id: "b", dedupKey: "b:1", shownAt: "2026-06-18T00:01:00.000Z" });
		// BOTH dedupKeys survive the second write.
		expect(state.wasShown("a:1")).toBe(true);
		expect(state.wasShown("b:1")).toBe(true);
		expect(Object.keys(state.load().seen).sort()).toEqual(["a:1", "b:1"]);
	});

	it("FR-5 writes are crash-safe: the final file is committed via rename, leaving no .tmp behind", () => {
		const fs = createInMemoryStateFs();
		const state = createNotificationsState({ dir: DIR, fs });
		state.markShown({ id: "g", dedupKey: "guide:1", shownAt: "2026-06-18T00:00:00.000Z" });

		const paths = [...fs.files.keys()];
		// The committed state file exists…
		expect(paths.some((p) => p.endsWith(STATE_FILE_NAME))).toBe(true);
		// …and no torn temp file is left over (the rename atomically removed it).
		expect(paths.some((p) => p.endsWith(".tmp"))).toBe(false);
	});

	it("an absent state file loads as empty (no throw)", () => {
		const state = createNotificationsState({ dir: DIR, fs: createInMemoryStateFs() });
		expect(state.load()).toEqual({ seen: {} });
		expect(state.wasShown("anything")).toBe(false);
	});

	it("a garbled state file loads as empty (fail-soft, never a crashed session)", () => {
		const fs = createInMemoryStateFs({ [STATE_PATH]: "{ not json" });
		const state = createNotificationsState({ dir: DIR, fs });
		expect(state.load()).toEqual({ seen: {} });
	});

	it("a valid-JSON-but-non-object state file loads as empty (the parsed-shape guard)", () => {
		// JSON that parses to a NON-object (array, number, string, null) must coerce to empty —
		// pins the `parsed === null || typeof parsed !== 'object'` guard, not just the catch path.
		for (const body of ["[1,2,3]", "42", '"a string"', "null", "true"]) {
			const fs = createInMemoryStateFs({ [STATE_PATH]: body });
			const state = createNotificationsState({ dir: DIR, fs });
			expect(state.load(), body).toEqual({ seen: {} });
		}
	});

	it("a state object whose `seen` is missing or not an object loads as empty (the seen-shape guard)", () => {
		// An object with no `seen`, or a `seen` that is null / a non-object, coerces to empty —
		// pins the `seen === null || typeof seen !== 'object'` guard.
		for (const body of ['{"other":1}', '{"seen":null}', '{"seen":"nope"}', '{"seen":5}']) {
			const fs = createInMemoryStateFs({ [STATE_PATH]: body });
			const state = createNotificationsState({ dir: DIR, fs });
			expect(state.load(), body).toEqual({ seen: {} });
		}
		// A well-formed `seen` object is preserved (the guard does not wipe a valid record).
		const good = createInMemoryStateFs({
			[STATE_PATH]: JSON.stringify({
				seen: { "k:1": { id: "k", dedupKey: "k:1", shownAt: "2026-06-18T00:00:00.000Z" } },
			}),
		});
		const state = createNotificationsState({ dir: DIR, fs: good });
		expect(state.wasShown("k:1")).toBe(true);
	});
});
