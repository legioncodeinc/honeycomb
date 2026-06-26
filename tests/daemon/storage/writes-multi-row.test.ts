/**
 * PRD-062c L-C1 / AC-5 — multi-row append (`buildInsertMany` / `appendOnlyInsertMany`).
 *
 * Proves a batched append builds ONE `INSERT … VALUES (…), (…)` statement through the
 * SAME guarded path as the single-row insert (sqlIdent + renderValue), that a single
 * row produces the identical shape to `buildInsert`, that an empty batch is a no-op,
 * and that a column-shape mismatch throws (a misaligned tuple is never written).
 */

import { describe, expect, it } from "vitest";

import {
	appendOnlyInsertMany,
	buildInsert,
	buildInsertMany,
	type RowValues,
	val,
} from "../../../src/daemon/storage/writes.js";
import { healTargetFor } from "../../../src/daemon/storage/catalog/index.js";
import type { QueryOptions, QueryScope, StorageQuery } from "../../../src/daemon/storage/client.js";
import { isOk, ok, type QueryResult } from "../../../src/daemon/storage/result.js";

const SCOPE: QueryScope = { org: "o", workspace: "w" };
const TARGET = healTargetFor("sessions");

function row(id: string, msg: string): RowValues {
	return [
		["id", val.str(id)],
		["message", val.text(msg)],
	];
}

/** A recording StorageQuery: captures every SQL + the options it was called with. */
class RecordingStorage implements StorageQuery {
	readonly calls: Array<{ sql: string; opts?: QueryOptions }> = [];
	async query(sql: string, _scope: QueryScope, opts?: QueryOptions): Promise<QueryResult> {
		this.calls.push({ sql, ...(opts !== undefined ? { opts } : {}) });
		return ok([], 1);
	}
}

describe("buildInsertMany builds one multi-row VALUES statement", () => {
	it("emits (cols) VALUES (v1), (v2), … with every identifier + value guarded", () => {
		const sql = buildInsertMany("sessions", [row("a", "hi"), row("b", "yo")]);
		expect(sql).toBe(`INSERT INTO "sessions" (id, message) VALUES ('a', E'hi'), ('b', E'yo')`);
	});

	it("a single row is byte-identical to buildInsert", () => {
		const single = buildInsert("sessions", row("a", "hi"));
		const many = buildInsertMany("sessions", [row("a", "hi")]);
		expect(many).toBe(single);
	});

	it("throws on an empty batch", () => {
		expect(() => buildInsertMany("sessions", [])).toThrow(/at least one row/);
	});

	it("throws on a divergent column shape (never writes a misaligned tuple)", () => {
		const bad: RowValues = [["id", val.str("c")], ["author", val.str("x")]];
		expect(() => buildInsertMany("sessions", [row("a", "hi"), bad])).toThrow(/column/);
	});
});

describe("appendOnlyInsertMany", () => {
	it("issues ONE query for N rows and threads the meter source", async () => {
		const storage = new RecordingStorage();
		const res = await appendOnlyInsertMany(storage, TARGET, SCOPE, [row("a", "x"), row("b", "y"), row("c", "z")], {
			source: "capture-write",
		});
		expect(isOk(res)).toBe(true);
		expect(storage.calls.length, "three rows → ONE append").toBe(1);
		expect(storage.calls[0].sql).toMatch(/VALUES \('a', E'x'\), \('b', E'y'\), \('c', E'z'\)/);
		expect(storage.calls[0].opts?.source).toBe("capture-write");
	});

	it("an empty batch is a no-op that issues no query", async () => {
		const storage = new RecordingStorage();
		const res = await appendOnlyInsertMany(storage, TARGET, SCOPE, []);
		expect(isOk(res)).toBe(true);
		expect(storage.calls.length).toBe(0);
	});
});
