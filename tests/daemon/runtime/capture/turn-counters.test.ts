/**
 * PRD-005a — per-turn counter unit tests (FR-8 / a-AC-5 / D-1).
 *
 * Pure logic: the counters bump per event/turn and emit a cue exactly at each
 * threshold crossing, independent of the handler. These pin the D-1 thresholds
 * and the Stop-trigger (skillify-independent-of-summary) behaviour.
 */

import { describe, expect, it } from "vitest";

import {
	DEFAULT_MAX_SESSIONS,
	DEFAULT_SKILLIFY_EVERY_TURNS,
	DEFAULT_SUMMARY_EVERY_MESSAGES,
	TurnCounters,
	tryStopCounterTrigger,
} from "../../../../src/daemon/runtime/capture/turn-counters.js";

describe("TurnCounters thresholds (D-1)", () => {
	it("emits a summary cue every N messages and nothing in between", () => {
		const c = new TurnCounters({ summaryEveryMessages: 3, skillifyEveryTurns: 1000 });
		expect(c.recordMessage("s", "p")).toBeNull();
		expect(c.recordMessage("s", "p")).toBeNull();
		const cue = c.recordMessage("s", "p"); // 3rd → crossing
		expect(cue?.kind).toBe("summary");
		expect(cue?.count).toBe(3);
		expect(c.recordMessage("s", "p")).toBeNull(); // 4th
	});

	it("emits a skillify cue every N turns (the Stop-trigger), independent of messages", () => {
		const c = new TurnCounters({ summaryEveryMessages: 1000, skillifyEveryTurns: 2 });
		expect(tryStopCounterTrigger(c, "s", "p")).toBeNull(); // 1 turn
		const cue = tryStopCounterTrigger(c, "s", "p"); // 2nd turn → crossing
		expect(cue?.kind).toBe("skillify");
		expect(cue?.count).toBe(2);
	});

	it("tracks sessions independently", () => {
		const c = new TurnCounters({ summaryEveryMessages: 2, skillifyEveryTurns: 1000 });
		expect(c.recordMessage("a", "pa")).toBeNull();
		expect(c.recordMessage("b", "pb")).toBeNull();
		expect(c.recordMessage("a", "pa")?.kind).toBe("summary"); // a hits 2
		expect(c.peek("a").messages).toBe(2);
		expect(c.peek("b").messages).toBe(1);
	});

	it("exposes the D-1 defaults", () => {
		expect(DEFAULT_SUMMARY_EVERY_MESSAGES).toBe(20);
		expect(DEFAULT_SKILLIFY_EVERY_TURNS).toBe(10);
		const c = new TurnCounters();
		for (let i = 0; i < 19; i++) expect(c.recordMessage("s", "p")).toBeNull();
		expect(c.recordMessage("s", "p")?.kind).toBe("summary"); // 20th
	});
});

describe("TurnCounters memory-exhaustion guard (security: unbounded-map DoS)", () => {
	it("caps the number of distinct tracked sessions at maxSessions", () => {
		const c = new TurnCounters({ maxSessions: 3 });
		// Stream more distinct session ids than the cap (an attacker controls these).
		for (let i = 0; i < 1000; i++) c.recordMessage(`sess-${i}`, "p");
		// The map never grows past the cap regardless of how many ids were seen.
		expect(c.size()).toBe(3);
	});

	it("evicts the oldest-inserted session first (FIFO) when over capacity", () => {
		const c = new TurnCounters({ maxSessions: 2, summaryEveryMessages: 1000 });
		c.recordMessage("oldest", "p"); // inserted first
		c.recordMessage("middle", "p");
		c.recordMessage("newest", "p"); // overflows → evicts "oldest"
		expect(c.size()).toBe(2);
		expect(c.peek("oldest").messages).toBe(0); // evicted → counts reset
		expect(c.peek("middle").messages).toBe(1); // retained
		expect(c.peek("newest").messages).toBe(1); // retained
	});

	it("re-touching an existing session never evicts (only new sessions can)", () => {
		const c = new TurnCounters({ maxSessions: 2, summaryEveryMessages: 1000 });
		c.recordMessage("a", "p");
		c.recordMessage("b", "p");
		// Bump existing sessions many times — size stays at the cap, no churn.
		for (let i = 0; i < 100; i++) {
			c.recordMessage("a", "p");
			c.recordMessage("b", "p");
		}
		expect(c.size()).toBe(2);
		expect(c.peek("a").messages).toBe(101);
		expect(c.peek("b").messages).toBe(101);
	});

	it("a misconfigured non-positive cap falls back to the safe default (never disables tracking)", () => {
		const c = new TurnCounters({ maxSessions: 0 });
		c.recordMessage("s", "p");
		expect(c.size()).toBe(1); // tracking still works
		expect(DEFAULT_MAX_SESSIONS).toBeGreaterThanOrEqual(1000);
	});
});
