/**
 * PRD-004b Durable Job Queue — b-AC-1..b-AC-7.
 *
 * Verification posture (EXECUTION_LEDGER-prd-004 / CONVENTIONS §5):
 *   - The queue runs against the PRD-002 fake transport (`FakeDeepLakeTransport`)
 *     wrapped in a real `StorageClient` — byte-identical to the production client,
 *     no live network.
 *   - A small SQL-aware {@link InMemoryJobs} responder emulates `memory_jobs` as an
 *     APPEND-ONLY, version-bumped row store so lease / fail / reaper / restart
 *     exercise the REAL SQL the service emits (asserted via `fake.requests`), not a
 *     hand-mocked method. Every transition is an INSERT of a new `version` row; the
 *     current state of a job is its highest-`version` row, served by the service's
 *     `ORDER BY version DESC LIMIT 1` reads exactly as the live backend would.
 *   - Time is driven through the injected {@link JobQueueClock} (D-3 seam): a
 *     manual clock advances `now()` so backoff / lease-expiry / reaper are
 *     deterministic without `vi.useFakeTimers()` fighting the async storage round
 *     trips.
 *   - Each test is named after the AC it proves (one-to-one ledger map).
 *   - No `.skip` / `.only`; `vitest run` is CI.
 *
 * Test layout:
 *   b-AC-1  leased job is not re-leasable until expiry/complete/fail
 *   b-AC-2  attempts >= max_attempts → dead, never leased again
 *   b-AC-3  reaper reclaims an expired lease (clock advanced past expiry)
 *   b-AC-4  fail with attempts remaining → next_run_at via doubling backoff
 *   b-AC-5  fresh service over the same state resumes queued + reaps dangling
 *   b-AC-6  first enqueue heals/creates memory_jobs + retries once
 *   b-AC-7  completed-past-window purged; dead retained longer
 */

import { describe, expect, it } from "vitest";

import { MEMORY_JOBS_COLUMNS } from "../../../../src/daemon/storage/catalog/index.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { QueryScope, StorageClient } from "../../../../src/daemon/storage/index.js";
import { TransportError, type TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { fakeCredentialRecord, FakeDeepLakeTransport, stubProvider } from "../../../helpers/fake-deeplake.js";
import {
	backoffDelayMs,
	createJobQueueService,
	type JobQueueClock,
	type JobQueueDeps,
} from "../../../../src/daemon/runtime/services/job-queue.js";

const SCOPE: QueryScope = { org: "fake-org", workspace: "fake-ws" };

// ── A manual clock: time only moves when a test advances it (D-3 seam). ──────
interface ManualClock extends JobQueueClock {
	/** Advance wall-clock by `ms`. */
	advance(ms: number): void;
	/** Fire every registered reaper timer once (the bootstrap-driven sweep). */
	tick(): void;
}

function manualClock(startMs = 1_000_000_000_000): ManualClock {
	let nowMs = startMs;
	const timers: Array<() => void> = [];
	return {
		now: () => nowMs,
		setTimer: (cb) => {
			timers.push(cb);
			return timers.length - 1;
		},
		clearTimer: (handle) => {
			if (typeof handle === "number") timers[handle] = () => {};
		},
		advance: (ms) => {
			nowMs += ms;
		},
		tick: () => {
			for (const cb of [...timers]) cb();
		},
	};
}

// ── A SQL-aware, APPEND-ONLY in-memory `memory_jobs` store. ───────────────────
// Emulates exactly the statements the version-bumped queue emits: the heal
// create/introspect, the transition INSERTs (one new `version` row per
// enqueue/lease/complete/fail/reap), the highest-version by-id reads
// (`ORDER BY version DESC LIMIT 1`), the discovery scan (`SELECT DISTINCT id`),
// and the purge DELETEs. The point is to run the REAL service SQL — not to
// re-implement DeepLake — so the AC assertions are about behaviour. The store
// keeps ALL appended rows; the current state of a job is its highest-version row,
// exactly as the live backend resolves it.
type Row = Record<string, unknown>;

class InMemoryJobs {
	/** Every appended row, in append order (append-only — never mutated in place). */
	readonly all: Row[] = [];
	created = false;
	/** Set true to make the FIRST statement fail missing-table (drives b-AC-6 heal). */
	private healPending: boolean;

	constructor(opts: { startMissing?: boolean } = {}) {
		this.healPending = opts.startMissing ?? false;
		this.created = !this.healPending;
	}

	/** The current (highest-version) row for an id, or undefined. */
	current(id: string): Row | undefined {
		let best: Row | undefined;
		for (const r of this.all) {
			if (String(r.id) !== id) continue;
			if (best === undefined || Number(r.version) > Number(best.version)) best = r;
		}
		return best;
	}

	/** All current (highest-version) rows, one per id (excluding the ensure sentinel). */
	currentRows(): Row[] {
		const ids = new Set(this.all.map((r) => String(r.id)));
		const out: Row[] = [];
		for (const id of ids) {
			if (id === "__ensure__") continue;
			const c = this.current(id);
			if (c) out.push(c);
		}
		return out;
	}

	responder = (req: TransportRequest): Row[] => {
		const sql = req.sql;

		// 1. Missing-table failure exactly once, to drive the heal-then-retry path.
		if (this.healPending && !/CREATE TABLE/i.test(sql)) {
			throw new TransportError("query", 'relation "memory_jobs" does not exist', 404);
		}

		// 2. CREATE TABLE IF NOT EXISTS … → table now exists; heal cleared.
		if (/CREATE TABLE/i.test(sql)) {
			this.created = true;
			this.healPending = false;
			return [];
		}

		// 3. Heal introspection: report the production columns as present so the
		//    column-heal diff finds nothing missing (the create already made them).
		if (/information_schema\.columns/i.test(sql)) {
			return MEMORY_JOBS_COLUMNS.map((c) => ({ column_name: c.name }));
		}

		// 4. DELETE (purge) — `DELETE FROM ... WHERE id = '...'` removes ALL rows for id.
		if (/^DELETE FROM/i.test(sql.trim())) {
			this.applyDelete(sql);
			return [];
		}

		// 5. INSERT (every transition append).
		if (/^INSERT INTO/i.test(sql.trim())) {
			this.applyInsert(sql);
			return [];
		}

		// 6. SELECT — route by shape.
		if (/^SELECT/i.test(sql.trim())) {
			return this.applySelect(sql);
		}

		return [];
	};

	// ―― helpers ――

	private extractEq(sql: string, column: string): string | undefined {
		const re = new RegExp(`${column}\\s*=\\s*'([^']*)'`);
		const m = sql.match(re);
		return m ? m[1] : undefined;
	}

	private applyInsert(sql: string): void {
		// INSERT INTO "memory_jobs" (cols...) VALUES (vals...). Parse the paired lists.
		const m = sql.match(/\(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\)\s*$/i);
		if (!m) return;
		const cols = m[1].split(",").map((c) => c.trim());
		const vals = this.splitValues(m[2]);
		const row: Row = {};
		cols.forEach((c, i) => {
			row[c] = this.coerce(vals[i]);
		});
		// Append-only: every INSERT is a NEW row, never a mutation of an existing one.
		this.all.push(row);
	}

	private applyDelete(sql: string): void {
		const id = this.extractEq(sql, "id");
		if (id === undefined) return;
		// Remove ALL appended rows for this id (the version-bumped purge).
		for (let i = this.all.length - 1; i >= 0; i--) {
			if (String(this.all[i].id) === id) this.all.splice(i, 1);
		}
	}

	private applySelect(sql: string): Row[] {
		// Discovery scan: SELECT DISTINCT id FROM ... (no WHERE). Returns one row per id.
		if (/SELECT\s+DISTINCT\s+id\s+FROM/i.test(sql)) {
			const ids = new Set(this.all.map((r) => String(r.id)));
			return [...ids].map((id) => ({ id }));
		}
		// Highest-version by-id read: SELECT <cols> WHERE id = '...' ORDER BY version DESC LIMIT 1.
		if (/WHERE\s+id\s*=/i.test(sql) && /ORDER\s+BY\s+version\s+DESC/i.test(sql)) {
			const id = this.extractEq(sql, "id");
			const row = id !== undefined ? this.current(id) : undefined;
			return row ? [{ ...row }] : [];
		}
		return [];
	}

	// ―― tiny SQL-literal parsing (the service quotes everything via sLiteral) ――

	private splitValues(list: string): string[] {
		return this.splitTopLevel(list).map((s) => s.trim());
	}

	/** Split a comma list, ignoring commas inside single-quoted literals. */
	private splitTopLevel(list: string): string[] {
		const out: string[] = [];
		let depth = 0;
		let inStr = false;
		let cur = "";
		for (let i = 0; i < list.length; i++) {
			const ch = list[i];
			if (ch === "'" && list[i - 1] !== "\\") inStr = !inStr;
			if (!inStr && ch === "(") depth++;
			if (!inStr && ch === ")") depth--;
			if (!inStr && depth === 0 && ch === ",") {
				out.push(cur);
				cur = "";
				continue;
			}
			cur += ch;
		}
		if (cur.trim() !== "") out.push(cur);
		return out;
	}

	private coerce(v: string): unknown {
		const t = v.trim();
		if (t.startsWith("E'") && t.endsWith("'")) return t.slice(2, -1).replace(/''/g, "'");
		if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
		if (/^-?\d+$/.test(t)) return Number(t);
		if (t === "NULL") return null;
		return t;
	}
}

// ── Fixture: a queue over a fresh in-memory store + manual clock. ────────────
function makeQueue(opts: { store?: InMemoryJobs; clock?: ManualClock; config?: JobQueueDeps["config"] } = {}) {
	const store = opts.store ?? new InMemoryJobs();
	const clock = opts.clock ?? manualClock();
	const fake = new FakeDeepLakeTransport(store.responder);
	const storage: StorageClient = createStorageClient({
		transport: fake,
		provider: stubProvider(fakeCredentialRecord()),
	});
	const queue = createJobQueueService({
		storage,
		scope: SCOPE,
		config: { owner: "owner-A", ...opts.config },
		clock,
	});
	return { queue, store, clock, fake };
}

describe("b-AC-6 first enqueue creates/heals memory_jobs and retries once", () => {
	it("a missing-table failure heals (CREATE) then the write retries and lands", async () => {
		const store = new InMemoryJobs({ startMissing: true });
		const { queue, fake } = makeQueue({ store });

		const id = await queue.enqueue({ kind: "distill", payload: { a: 1 } });

		expect(id).not.toBe("");
		// The CREATE TABLE statement was emitted (the heal fired) ...
		expect(fake.requests.some((r) => /CREATE TABLE IF NOT EXISTS "memory_jobs"/.test(r.sql))).toBe(true);
		// ... the enqueue is an append of the version-1 row (never an UPDATE) ...
		expect(
			fake.requests.some((r) => /INSERT INTO "memory_jobs"/.test(r.sql) && /'queued'/.test(r.sql) && /version/.test(r.sql)),
		).toBe(true);
		expect(fake.requests.some((r) => /UPDATE "memory_jobs"/.test(r.sql))).toBe(false);
		// ... and the version-1 queued row landed after the single retry.
		const current = store.current(id);
		expect(current?.status).toBe("queued");
		expect(Number(current?.version)).toBe(1);
	});
});

describe("b-AC-1 leased job is not re-leasable until expiry/complete/fail", () => {
	it("a second lease attempt finds nothing while the first lease is live", async () => {
		const { queue, store, fake } = makeQueue();
		await queue.enqueue({ kind: "summary", payload: {} });

		const first = await queue.lease();
		expect(first).not.toBeNull();
		// The current (highest-version) row is now leased — appended, not mutated.
		expect(store.current(first?.id ?? "")?.status).toBe("leased");
		expect(Number(store.current(first?.id ?? "")?.version)).toBe(2); // v1 queued, v2 leased.

		// Leasing is an APPEND of a `leased` version — never an in-place UPDATE.
		expect(fake.requests.some((r) => /UPDATE "memory_jobs"/.test(r.sql))).toBe(false);
		expect(
			fake.requests.some((r) => /INSERT INTO "memory_jobs"/.test(r.sql) && /'leased'/.test(r.sql)),
		).toBe(true);
		// And ownership was confirmed via the highest-version by-id read.
		expect(
			fake.requests.some((r) => /WHERE id = '/.test(r.sql) && /ORDER BY version DESC LIMIT 1/.test(r.sql)),
		).toBe(true);

		const second = await queue.lease();
		expect(second).toBeNull();
	});

	it("a worker that lost the ownership confirm backs off (returns null)", async () => {
		const { queue, store } = makeQueue();
		const id = await queue.enqueue({ kind: "x", payload: {} });
		// Simulate a race: another owner already appended a higher `leased` version, so
		// when we confirm the highest-version read shows a DIFFERENT owner → null. The
		// current highest version after enqueue is 1, so the racer appends version 2.
		store.all.push({
			id,
			type: "x",
			payload: {},
			status: "leased",
			lease_owner: "owner-B",
			lease_expires_at: "2999-01-01T00:00:00.000Z",
			attempts: 0,
			max_attempts: 5,
			next_run_at: "2999-01-01T00:00:00.000Z",
			created_at: "2999-01-01T00:00:00.000Z",
			updated_at: "2999-01-01T00:00:00.000Z",
			version: 2,
		});
		const leased = await queue.lease();
		expect(leased).toBeNull();
		// Our own lease append would be version 3, but the confirm reads back owner-B at
		// the highest version (>= our append) on at least one poll → we lose. The job's
		// current owner is never us.
		expect(store.current(id)?.lease_owner).not.toBe("owner-A");
	});
});

describe("b-AC-4 fail with attempts remaining sets next_run_at via doubling backoff", () => {
	it("the first failure schedules now + base, the second now + base*2", async () => {
		const clock = manualClock();
		const { queue, store } = makeQueue({ clock, config: { backoffBaseMs: 1_000, backoffCapMs: 300_000 } });
		const id = await queue.enqueue({ kind: "x", payload: {} });
		await queue.lease();

		const t0 = clock.now();
		await queue.fail(id, "boom");
		const afterFirst = store.current(id);
		expect(afterFirst?.status).toBe("failed");
		expect(afterFirst?.attempts).toBe(1);
		// attempts=1 → delay = base * 2^0 = 1000ms.
		expect(afterFirst?.next_run_at).toBe(new Date(t0 + 1_000).toISOString());

		// Make it leasable again, lease, fail a second time.
		clock.advance(2_000);
		await queue.lease();
		const t1 = clock.now();
		await queue.fail(id, "boom again");
		const afterSecond = store.current(id);
		expect(afterSecond?.attempts).toBe(2);
		// attempts=2 → delay = base * 2^1 = 2000ms.
		expect(afterSecond?.next_run_at).toBe(new Date(t1 + 2_000).toISOString());
	});

	it("backoffDelayMs is a pure doubling curve capped at the configured cap", () => {
		expect(backoffDelayMs(1, 1_000, 300_000)).toBe(1_000);
		expect(backoffDelayMs(2, 1_000, 300_000)).toBe(2_000);
		expect(backoffDelayMs(3, 1_000, 300_000)).toBe(4_000);
		expect(backoffDelayMs(4, 1_000, 300_000)).toBe(8_000);
		// Far out on the curve the cap clamps it.
		expect(backoffDelayMs(40, 1_000, 300_000)).toBe(300_000);
	});
});

describe("b-AC-2 a job exceeding max_attempts walks to dead and is never leased again", () => {
	it("after max_attempts failures the status is dead and lease yields nothing", async () => {
		const clock = manualClock();
		const { queue, store } = makeQueue({ clock, config: { maxAttempts: 3, backoffBaseMs: 1_000 } });
		const id = await queue.enqueue({ kind: "x", payload: {} });

		for (let i = 0; i < 3; i++) {
			const leased = await queue.lease();
			expect(leased).not.toBeNull();
			await queue.fail(id, `fail-${i}`);
			clock.advance(10 * 60 * 1_000); // jump past any backoff window so it is leasable.
		}

		const dead = store.current(id);
		expect(dead?.status).toBe("dead");
		expect(dead?.attempts).toBe(3);
		// A dead job's current row is neither queued nor failed → selectLeasable skips it.
		expect(await queue.lease()).toBeNull();
	});
});

describe("b-AC-3 reaper reclaims an expired lease", () => {
	it("advancing the clock past lease expiry returns the job to queued and leasable", async () => {
		const clock = manualClock();
		const { queue, store } = makeQueue({ clock, config: { leaseMs: 5 * 60 * 1_000 } });
		const id = await queue.enqueue({ kind: "x", payload: {} });
		const leased = await queue.lease();
		expect(leased).not.toBeNull();
		expect(store.current(id)?.status).toBe("leased");

		// Before expiry the reaper finds nothing.
		const reapedEarly = await queue.reapExpiredLeases();
		expect(reapedEarly).toBe(0);
		expect(store.current(id)?.status).toBe("leased");

		// Advance past the lease window → the reaper reclaims it (attempts untouched).
		clock.advance(5 * 60 * 1_000 + 1);
		const reaped = await queue.reapExpiredLeases();
		expect(reaped).toBe(1);
		expect(store.current(id)?.status).toBe("queued");
		expect(store.current(id)?.attempts).toBe(0); // a reaped lease does NOT consume an attempt.

		// And it is leasable again now.
		const released = await queue.lease();
		expect(released?.id).toBe(id);
	});

	it("the reaper timer started by start() reclaims on a clock tick", async () => {
		const clock = manualClock();
		const { queue, store } = makeQueue({ clock, config: { leaseMs: 1_000, reaperIntervalMs: 1_000 } });
		await queue.start(); // ensures table + starts the reaper timer.
		const id = await queue.enqueue({ kind: "x", payload: {} });
		await queue.lease();
		expect(store.current(id)?.status).toBe("leased");

		clock.advance(2_000);
		clock.tick(); // fire the bootstrap-owned reaper sweep.
		// The sweep is async (void-returning); flush microtasks so the append lands.
		await new Promise((r) => setImmediate(r));
		expect(store.current(id)?.status).toBe("queued");
		queue.stop();
	});
});

describe("b-AC-5 a fresh service over the same state resumes queued + reaps dangling leases", () => {
	it("a new instance over the shared store reaps a prior process's dangling lease and leases the queued job", async () => {
		const store = new InMemoryJobs();
		const clock = manualClock();

		// Instance 1 enqueues two jobs and leases one, then "crashes" (we just drop it).
		const inst1 = makeQueue({ store, clock, config: { leaseMs: 5 * 60 * 1_000 } });
		const dangling = await inst1.queue.enqueue({ kind: "a", payload: {} });
		const queued = await inst1.queue.enqueue({ kind: "b", payload: {} });
		const leased = await inst1.queue.lease(); // leases the older job (`dangling`).
		expect(leased?.id).toBe(dangling);
		expect(store.current(dangling)?.status).toBe("leased");

		// Time passes beyond the lease while no process is running.
		clock.advance(5 * 60 * 1_000 + 1);

		// Instance 2 starts fresh over the SAME durable store.
		const inst2 = makeQueue({ store, clock, config: { leaseMs: 5 * 60 * 1_000, owner: "owner-2" } });
		await inst2.queue.start(); // start() reaps dangling leases (b-AC-5 / FR-8).

		// The dangling lease was reclaimed to queued ...
		expect(store.current(dangling)?.status).toBe("queued");
		// ... and the still-queued job is unaffected and leasable.
		expect(store.current(queued)?.status).toBe("queued");
		const leasedAgain = await inst2.queue.lease();
		expect(leasedAgain).not.toBeNull();
		expect([dangling, queued]).toContain(leasedAgain?.id);
		inst2.queue.stop();
	});
});

describe("PRD-026 lease(kinds) kind filter — a kind-specialized worker never touches foreign jobs", () => {
	it("lease(['pollinating']) returns only a pollinating job and leaves other kinds queued", async () => {
		const { queue, store } = makeQueue();
		// A mixed queue: a summary, a pollinating, and a skillify job (capture enqueues all three).
		const summaryId = await queue.enqueue({ kind: "summary", payload: {} });
		const pollinatingId = await queue.enqueue({ kind: "pollinating", payload: { mode: "incremental" } });
		const skillifyId = await queue.enqueue({ kind: "skillify", payload: {} });

		// The kind-filtered lease returns ONLY the pollinating job.
		const leased = await queue.lease(["pollinating"]);
		expect(leased).not.toBeNull();
		expect(leased?.id).toBe(pollinatingId);
		expect(leased?.kind).toBe("pollinating");

		// The foreign kinds are untouched — still queued for their own workers.
		expect(store.current(summaryId)?.status).toBe("queued");
		expect(store.current(skillifyId)?.status).toBe("queued");
		// And only the pollinating job advanced to leased.
		expect(store.current(pollinatingId)?.status).toBe("leased");
	});

	it("lease(['pollinating']) over a queue with NO pollinating job returns null and leases nothing", async () => {
		const { queue, store } = makeQueue();
		const summaryId = await queue.enqueue({ kind: "summary", payload: {} });
		const skillifyId = await queue.enqueue({ kind: "skillify", payload: {} });

		// No pollinating job present → the pollinating worker finds nothing leasable.
		expect(await queue.lease(["pollinating"])).toBeNull();
		// The foreign jobs were never grabbed (and so never walked toward dead).
		expect(store.current(summaryId)?.status).toBe("queued");
		expect(store.current(skillifyId)?.status).toBe("queued");
	});

	it("an unfiltered lease() still leases ANY kind (existing callers are unchanged)", async () => {
		const { queue } = makeQueue();
		const summaryId = await queue.enqueue({ kind: "summary", payload: {} });

		// The default (no kinds) leases the only job regardless of kind — zero behaviour change.
		const leased = await queue.lease();
		expect(leased?.id).toBe(summaryId);
		expect(leased?.kind).toBe("summary");
	});

	it("the filter accepts a multi-kind set (lease the oldest matching kind)", async () => {
		const { queue, store } = makeQueue();
		const summaryId = await queue.enqueue({ kind: "summary", payload: {} });
		await queue.enqueue({ kind: "pollinating", payload: { mode: "incremental" } });

		// A worker that handles both summary + pollinating leases the OLDEST of the two (summary).
		const leased = await queue.lease(["summary", "pollinating"]);
		expect(leased?.id).toBe(summaryId);
		expect(store.current(summaryId)?.status).toBe("leased");
	});

	it("an EMPTY kinds array leases nothing (distinct from undefined) and walks no job toward dead", async () => {
		const { queue, store } = makeQueue();
		// Jobs of every kind are present and leasable.
		const summaryId = await queue.enqueue({ kind: "summary", payload: {} });
		const pollinatingId = await queue.enqueue({ kind: "pollinating", payload: { mode: "incremental" } });

		// `[]` matches NO kind (`[].includes(type)` is always false) — the explicit
		// empty filter must lease nothing, NOT degrade to the unfiltered "lease any"
		// behaviour. The boundary that distinguishes `[]` from `undefined`.
		expect(await queue.lease([])).toBeNull();

		// Both jobs stay queued — an empty filter never grabs-and-fails a foreign job.
		expect(store.current(summaryId)?.status).toBe("queued");
		expect(store.current(pollinatingId)?.status).toBe("queued");
	});

	it("a kind NOT present in the queue returns null and leaves every other kind queued", async () => {
		const { queue, store } = makeQueue();
		const summaryId = await queue.enqueue({ kind: "summary", payload: {} });
		const skillifyId = await queue.enqueue({ kind: "skillify", payload: {} });

		// Filtering for a kind that simply is not in the queue → nothing leasable, and
		// the present kinds are untouched (the worker waits rather than walking a job).
		expect(await queue.lease(["document"])).toBeNull();
		expect(store.current(summaryId)?.status).toBe("queued");
		expect(store.current(skillifyId)?.status).toBe("queued");
	});
});

describe("b-AC-7 completed jobs purge past the window; dead jobs are retained longer", () => {
	it("a done job aged past doneRetention is deleted while a dead job within deadRetention survives", async () => {
		const clock = manualClock();
		const { queue, store } = makeQueue({
			clock,
			config: {
				maxAttempts: 1,
				doneRetentionMs: 24 * 60 * 60 * 1_000, // 24h
				deadRetentionMs: 7 * 24 * 60 * 60 * 1_000, // 7d
			},
		});

		// A completed job.
		const doneId = await queue.enqueue({ kind: "done-kind", payload: {} });
		await queue.lease();
		await queue.complete(doneId);
		expect(store.current(doneId)?.status).toBe("done");

		// A dead job (maxAttempts 1 → first fail is fatal).
		const deadId = await queue.enqueue({ kind: "dead-kind", payload: {} });
		await queue.lease();
		await queue.fail(deadId, "fatal");
		expect(store.current(deadId)?.status).toBe("dead");

		// Advance 2 days: past the 24h done window, well within the 7d dead window.
		clock.advance(2 * 24 * 60 * 60 * 1_000);
		const purge = await queue.purgeRetained();
		expect(purge.doneDeleted).toBe(true);
		expect(purge.deadDeleted).toBe(true);

		// The done job's rows are gone; the dead job's rows are retained.
		expect(store.current(doneId)).toBeUndefined();
		expect(store.current(deadId)?.status).toBe("dead");
	});
});
