/**
 * PRD-020d state seams — the real ClaimLock (`wx`/EEXIST) + NotificationsState (temp+rename).
 *
 * Drives the GENUINE `createClaimLock` / `createNotificationsState` factories against an
 * in-memory `StateFs` that honors the SAME `EEXIST`/atomic-rename contract as `node:fs`, so the
 * LOGIC — the exclusive-create race winner/loser split (d-AC-1) and the crash-safe temp→rename
 * write (FR-5 / d-AC-4) — is verified without touching disk.
 */

import { describe, expect, it } from "vitest";

import {
	CLAIM_DIR_NAME,
	createClaimLock,
	createInMemoryStateFs,
	createNotificationsState,
	STATE_FILE_NAME,
} from "../../src/notifications/index.js";

const DIR = "/tmp/hc-state";

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

	it("rejects a traversal claim key (no escape from claims/)", () => {
		const lock = createClaimLock({ dir: DIR, fs: createInMemoryStateFs() });
		expect(() => lock.claim("../escape")).toThrow(/unsafe claim key/);
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
		const fs = createInMemoryStateFs({ [`${DIR}/${STATE_FILE_NAME}`]: "{ not json" });
		const state = createNotificationsState({ dir: DIR, fs });
		expect(state.load()).toEqual({ seen: {} });
	});
});
