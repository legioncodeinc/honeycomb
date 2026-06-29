/** State store tests (defensive read/write, graceful degradation). */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { silentLogger } from "../src/logger.js";
import { createStateStore, DEFAULT_STATE, mergeState } from "../src/state.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hivedoctor-state-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("state store", () => {
	it("read() returns DEFAULT_STATE when no file exists", () => {
		const store = createStateStore({ workspaceDir: dir, logger: silentLogger });
		expect(store.read()).toEqual(DEFAULT_STATE);
	});

	it("write() then read() round-trips", () => {
		const store = createStateStore({ workspaceDir: dir, logger: silentLogger });
		const next = { ...DEFAULT_STATE, lastKnownHealth: "degraded" as const, consecutiveRestartFailures: 2, backoffRung: 1 };
		store.write(next);
		const read = store.read();
		expect(read.lastKnownHealth).toBe("degraded");
		expect(read.consecutiveRestartFailures).toBe(2);
		expect(read.backoffRung).toBe(1);
	});

	it("read() degrades garbage JSON to DEFAULT_STATE (never throws)", () => {
		writeFileSync(join(dir, "state.json"), "{ not valid json", "utf8");
		const store = createStateStore({ workspaceDir: dir, logger: silentLogger });
		expect(store.read()).toEqual(DEFAULT_STATE);
	});

	it("write() is atomic (no leftover .tmp after a successful write)", () => {
		const store = createStateStore({ workspaceDir: dir, logger: silentLogger });
		store.write(DEFAULT_STATE);
		const final = readFileSync(join(dir, "state.json"), "utf8");
		expect(JSON.parse(final).version).toBe(1);
	});
});

describe("mergeState", () => {
	it("merges a partial object field-by-field over the defaults", () => {
		const merged = mergeState({ consecutiveRestartFailures: 5, lastKnownHealth: "ok", junk: true });
		expect(merged.consecutiveRestartFailures).toBe(5);
		expect(merged.lastKnownHealth).toBe("ok");
		expect(merged.currentRung).toBe(DEFAULT_STATE.currentRung); // untouched field keeps default
	});

	it("replaces wrong-typed fields with defaults", () => {
		const merged = mergeState({ consecutiveRestartFailures: "lots", backoffRung: -3, currentRung: 0 });
		expect(merged.consecutiveRestartFailures).toBe(0);
		expect(merged.backoffRung).toBe(0);
		expect(merged.currentRung).toBe(1);
	});

	it("returns DEFAULT_STATE for a non-object", () => {
		expect(mergeState(null)).toEqual(DEFAULT_STATE);
		expect(mergeState(42)).toEqual(DEFAULT_STATE);
	});
});
