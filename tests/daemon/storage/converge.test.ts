/**
 * PRD-028 read-your-writes convergence seam — proves W1's unit ACs.
 *
 * Drives `readConverged` + the watermark/predicate builders against a SCRIPTABLE
 * fake `StorageQuery` (per-call results) and an INJECTED fake clock + sleep, so the
 * tests are fast, deterministic, and need no live backend:
 *   - AC-1: a flapping fake (stale/empty/lower-version for N calls then fresh) →
 *           polls until the watermark predicate holds and returns the fresh `ok`,
 *           converging before the budget.
 *   - AC-2: a never-converging fake → exhausts the bounded budget and returns the
 *           LAST real `QueryResult` (no throw, no hang, no invented row), within the
 *           wall-clock bound, attempt count == maxAttempts.
 *   - predicate-builder matrix: rowPresent / minRowCount / minVersion /
 *           watermarkPredicate (present-and-version).
 *   - AC-5: a trace-on run with a recording sink carries no token and no full org.
 *   - non-ok fail-soft: a transport-failure result → predicate false → budget
 *           governs → returns the last non-ok result, never throws.
 */

import { describe, expect, it } from "vitest";
import type { QueryOptions, QueryScope, StorageQuery } from "../../../src/daemon/storage/client.js";
import {
	connectionError,
	ok,
	type QueryResult,
	type StorageRow,
} from "../../../src/daemon/storage/result.js";
import {
	type ConvergeClock,
	type ConvergeTraceSink,
	DEFAULT_CONVERGE_BUDGET,
	minRowCount,
	minVersion,
	readConverged,
	resolveConvergeBudget,
	rowPresent,
	type SleepFn,
	watermarkOf,
	watermarkPredicate,
} from "../../../src/daemon/storage/converge.js";

const SCOPE: QueryScope = { org: "secret-org-1234567890", workspace: "ws1" } as const;

/** A scriptable fake `StorageQuery`: returns the next queued result per call, then repeats the last. */
class ScriptedClient implements StorageQuery {
	private readonly script: QueryResult[];
	readonly calls: Array<{ sql: string; scope: QueryScope; opts?: QueryOptions }> = [];
	constructor(script: QueryResult[]) {
		this.script = script;
	}
	query(sql: string, scope: QueryScope, opts?: QueryOptions): Promise<QueryResult> {
		this.calls.push({ sql, scope, opts });
		const idx = Math.min(this.calls.length - 1, this.script.length - 1);
		const next = this.script[idx];
		if (next === undefined) throw new Error("ScriptedClient: empty script");
		return Promise.resolve(next);
	}
}

/** A fake clock that ADVANCES on each `sleep`, so the wall-clock bound is deterministic. */
class FakeClock {
	private t = 0;
	readonly slept: number[] = [];
	readonly clock: ConvergeClock = { now: () => this.t };
	readonly sleep: SleepFn = (ms: number): Promise<void> => {
		this.slept.push(ms);
		this.t += ms;
		return Promise.resolve();
	};
}

/** Build an `ok` result carrying the given rows. */
function okRows(rows: StorageRow[]): QueryResult {
	return ok(rows, 1);
}

describe("PRD-028 readConverged", () => {
	it("AC-1 polls a flapping client until the watermark predicate holds and returns the fresh ok", async () => {
		// Stale (empty) for 2 calls, then a lower-version row, then the fresh version-3 row.
		const fresh = okRows([{ id: "row-1", version: 3 }]);
		const client = new ScriptedClient([
			okRows([]),
			okRows([]),
			okRows([{ id: "row-1", version: 2 }]), // present but version too low
			fresh,
		]);
		const fake = new FakeClock();
		const wm = watermarkOf("row-1", 3);

		const result = await readConverged(client, 'SELECT * FROM "skills" WHERE id = \'row-1\'', SCOPE, watermarkPredicate(wm), {
			budgetProvider: { read: () => ({}) }, // pure defaults, no env
			clock: fake.clock,
			sleep: fake.sleep,
		});

		expect(result).toBe(fresh);
		expect(result.kind).toBe("ok");
		// Converged on the 4th poll, before the 10-attempt cap.
		expect(client.calls.length).toBe(4);
		expect(client.calls.length).toBeLessThan(DEFAULT_CONVERGE_BUDGET.maxAttempts);
	});

	it("AC-2 exhausts the bounded budget on a never-converging client and returns the last real result", async () => {
		const last = okRows([{ id: "other", version: 1 }]); // never the awaited row-1
		const client = new ScriptedClient([last]); // every poll returns this
		const fake = new FakeClock();
		const wm = watermarkOf("row-1", 3);

		const result = await readConverged(client, "SELECT * FROM skills", SCOPE, watermarkPredicate(wm), {
			budgetProvider: { read: () => ({}) },
			clock: fake.clock,
			sleep: fake.sleep,
		});

		// Returned the LAST real read — never threw, never invented row-1.
		expect(result).toBe(last);
		expect(result.kind).toBe("ok");
		if (result.kind === "ok") {
			expect(result.rows).toEqual([{ id: "other", version: 1 }]);
			expect(result.rows.some((r) => r.id === "row-1")).toBe(false); // no fabricated row
		}
		// Exactly maxAttempts polls, and bounded by the wall-clock budget (fake clock proves it).
		expect(client.calls.length).toBe(DEFAULT_CONVERGE_BUDGET.maxAttempts);
		expect(fake.clock.now()).toBeLessThanOrEqual(DEFAULT_CONVERGE_BUDGET.maxWallClockMs);
	});

	it("AC-2 stops early when the next backoff would breach the wall-clock budget", async () => {
		const last = okRows([]);
		const client = new ScriptedClient([last]);
		const fake = new FakeClock();

		const result = await readConverged(client, "SELECT 1", SCOPE, rowPresent("id", "never"), {
			// A tiny wall-clock budget with many attempts: the wall-clock bound, not the
			// attempt cap, is what stops it — and it must still return the last real read.
			budget: { maxAttempts: 100, maxWallClockMs: 30, backoffBaseMs: 25, backoffCapMs: 25 },
			budgetProvider: { read: () => ({}) },
			clock: fake.clock,
			sleep: fake.sleep,
		});

		expect(result).toBe(last);
		expect(client.calls.length).toBeLessThan(100); // walltime stopped it well before the attempt cap
		expect(fake.clock.now()).toBeLessThanOrEqual(30);
	});

	it("non-ok transport failure → predicate false → budget governs → returns the last non-ok result (fail-soft)", async () => {
		const failure = connectionError("socket reset");
		const client = new ScriptedClient([failure]);
		const fake = new FakeClock();

		const result = await readConverged(client, "SELECT * FROM memory", SCOPE, rowPresent("id", "row-1"), {
			budget: { maxAttempts: 3 },
			budgetProvider: { read: () => ({}) },
			clock: fake.clock,
			sleep: fake.sleep,
		});

		expect(result).toBe(failure);
		expect(result.kind).toBe("connection_error");
		expect(client.calls.length).toBe(3); // budget governed; no throw, no hang
	});

	it("AC-5 a trace-on run carries no token and no full org (redaction proof)", async () => {
		const client = new ScriptedClient([okRows([])]);
		const fake = new FakeClock();
		const lines: string[] = [];
		const sink: ConvergeTraceSink = (line) => lines.push(line);

		await readConverged(client, "SELECT token FROM secrets", SCOPE, rowPresent("id", "nope"), {
			budget: { maxAttempts: 2 },
			budgetProvider: { read: () => ({}) },
			clock: fake.clock,
			sleep: fake.sleep,
			trace: true,
			traceSink: sink,
		});

		expect(lines.length).toBeGreaterThan(0);
		const joined = lines.join("\n");
		// The full org never appears verbatim; only the redacted `****`+last-4 form does.
		expect(joined).not.toContain(SCOPE.org);
		expect(joined).toContain("****7890"); // redactToken keeps only the last 4
		// No token-shaped secret leaks (the seam never has the token; prove the org redaction held).
		expect(joined).not.toContain("secret-org");
	});

	it("trace OFF by default (no env, no opt) emits nothing", async () => {
		const client = new ScriptedClient([okRows([])]);
		const fake = new FakeClock();
		const lines: string[] = [];
		await readConverged(client, "SELECT 1", SCOPE, rowPresent("id", "nope"), {
			budget: { maxAttempts: 1 },
			budgetProvider: { read: () => ({}) },
			clock: fake.clock,
			sleep: fake.sleep,
			trace: false,
			traceSink: (line) => lines.push(line),
		});
		expect(lines).toEqual([]);
	});
});

describe("PRD-028 predicate builders", () => {
	it("rowPresent matches an id (string-coerced) and rejects a non-ok result", () => {
		const p = rowPresent("id", "7");
		expect(p(okRows([{ id: "7" }]))).toBe(true);
		expect(p(okRows([{ id: 7 }]))).toBe(true); // numeric cell, string watermark
		expect(p(okRows([{ id: "8" }]))).toBe(false);
		expect(p(okRows([]))).toBe(false);
		expect(p(connectionError("x"))).toBe(false);
	});

	it("minRowCount is satisfied at or above k; k<=0 accepts any ok (incl. empty)", () => {
		expect(minRowCount(2)(okRows([{}, {}]))).toBe(true);
		expect(minRowCount(2)(okRows([{}]))).toBe(false);
		expect(minRowCount(0)(okRows([]))).toBe(true);
		expect(minRowCount(-5)(okRows([]))).toBe(true);
		expect(minRowCount(1)(connectionError("x"))).toBe(false);
	});

	it("minVersion matches when some row's version column meets the floor", () => {
		const p = minVersion("version", 3);
		expect(p(okRows([{ version: 3 }]))).toBe(true);
		expect(p(okRows([{ version: 4 }]))).toBe(true);
		expect(p(okRows([{ version: "5" }]))).toBe(true); // string-coerced
		expect(p(okRows([{ version: 2 }]))).toBe(false);
		expect(p(okRows([{ version: 1 }, { version: 9 }]))).toBe(true); // any row qualifies
		expect(p(okRows([]))).toBe(false);
		expect(p(connectionError("x"))).toBe(false);
	});

	it("watermarkPredicate (present-and-version) needs the id present AND version >= watermark", () => {
		const p = watermarkPredicate(watermarkOf("row-1", 3));
		expect(p(okRows([{ id: "row-1", version: 3 }]))).toBe(true);
		expect(p(okRows([{ id: "row-1", version: 5 }]))).toBe(true);
		expect(p(okRows([{ id: "row-1", version: 2 }]))).toBe(false); // present but stale version
		expect(p(okRows([{ id: "other", version: 9 }]))).toBe(false); // version ok but wrong id
		expect(p(okRows([]))).toBe(false);
		expect(p(connectionError("x"))).toBe(false);
	});

	it("watermarkPredicate (id-only, no version) needs only the id present", () => {
		const p = watermarkPredicate(watermarkOf("row-1"));
		expect(p(okRows([{ id: "row-1" }]))).toBe(true);
		expect(p(okRows([{ id: "row-1", version: 1 }]))).toBe(true);
		expect(p(okRows([{ id: "other" }]))).toBe(false);
	});

	it("watermarkPredicate honors custom id/version column names", () => {
		const p = watermarkPredicate(watermarkOf("s1", 2), { idColumn: "skill_id", versionColumn: "ver" });
		expect(p(okRows([{ skill_id: "s1", ver: 2 }]))).toBe(true);
		expect(p(okRows([{ skill_id: "s1", ver: 1 }]))).toBe(false);
		expect(p(okRows([{ id: "s1", version: 2 }]))).toBe(false); // wrong columns
	});

	it("watermarkOf is additive: assembles {id} or {id,version} from a write's pieces", () => {
		expect(watermarkOf("k1")).toEqual({ id: "k1" });
		expect(watermarkOf("k1", 5)).toEqual({ id: "k1", version: 5 });
	});
});

describe("PRD-028 budget resolution (coerce-and-clamp, never throw)", () => {
	it("defaults when env + override are empty", () => {
		const b = resolveConvergeBudget({ read: () => ({}) }, {});
		expect(b).toEqual(DEFAULT_CONVERGE_BUDGET);
	});

	it("env knobs are read and clamped; a fat-fingered value falls back, never throws", () => {
		const b = resolveConvergeBudget(
			{ read: () => ({ maxAttempts: "not-a-number", maxWallClockMs: "5000" }) },
			{},
		);
		expect(b.maxAttempts).toBe(DEFAULT_CONVERGE_BUDGET.maxAttempts); // garbage → default
		expect(b.maxWallClockMs).toBe(5000); // numeric env string parsed
	});

	it("a per-call override wins per-field over env", () => {
		const b = resolveConvergeBudget({ read: () => ({ maxAttempts: "3" }) }, { maxAttempts: 7 });
		expect(b.maxAttempts).toBe(7);
	});

	it("maxAttempts floors at 1; backoff cap floors at the base (no inverted pair)", () => {
		const b = resolveConvergeBudget({ read: () => ({}) }, { maxAttempts: 0, backoffBaseMs: 100, backoffCapMs: 10 });
		expect(b.maxAttempts).toBe(1); // clamped up to the floor
		expect(b.backoffCapMs).toBe(100); // cap floored at base
	});
});
