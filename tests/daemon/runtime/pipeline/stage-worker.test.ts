/**
 * PRD-006 stage-worker harness — routing + a-AC-6 (reaper reclaim + retry).
 *
 * Verification posture:
 *   - The harness runs against the REAL durable queue (`createJobQueueService`)
 *     over the PRD-002 fake transport wrapped in a real `StorageClient` — so the
 *     lease/complete/fail/reaper behaviour a-AC-6 relies on is the queue's actual
 *     behaviour, not a mock. A small append-only `InMemoryJobs` responder
 *     emulates `memory_jobs` exactly as the job-queue suite does.
 *   - Time is driven through the injected `JobQueueClock` (manual clock) so lease
 *     expiry + the reaper sweep are deterministic.
 *   - Each test is named after what it proves; a-AC-6 maps to the ledger.
 *   - No `.skip` / `.only`; `vitest run` is CI.
 *
 * a-AC-6 demonstration (worker crash mid-job → reaper reclaims → retried):
 *   1. enqueue an extraction job; the worker leases + runs it.
 *   2. simulate a CRASH mid-job: a handler that throws is routed to `queue.fail`,
 *      which (attempts < max) re-queues with backoff → the job is leasable again
 *      and a second run processes it. This is the "abandoned lease is retried"
 *      path the ledger asks the harness to assert.
 *   3. ALSO assert the queue's reaper itself reclaims a STALE lease (the true
 *      crash: no complete/fail ever called) by advancing the clock past lease
 *      expiry and ticking the reaper, then leasing again succeeds.
 */

import { describe, expect, it } from "vitest";

import { MEMORY_JOBS_COLUMNS } from "../../../../src/daemon/storage/catalog/index.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { QueryScope, StorageClient } from "../../../../src/daemon/storage/index.js";
import { TransportError, type TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { fakeCredentialRecord, FakeDeepLakeTransport, stubProvider } from "../../../helpers/fake-deeplake.js";
import {
	createJobQueueService,
	type JobQueueClock,
	type JobQueueService,
} from "../../../../src/daemon/runtime/services/job-queue.js";
import {
	createPipelineHandlers,
	createStageWorker,
	PipelineConfigSchema,
	createFakeModelClient,
	type StageHandler,
	type StageHandlers,
	type StageJob,
} from "../../../../src/daemon/runtime/pipeline/index.js";

const SCOPE: QueryScope = { org: "fake-org", workspace: "fake-ws" };

// ── A manual clock (the D-3 seam), mirroring the job-queue suite. ─────────────
interface ManualClock extends JobQueueClock {
	advance(ms: number): void;
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

// ── An append-only in-memory `memory_jobs` store (same shape as the queue suite). ──
type Row = Record<string, unknown>;
class InMemoryJobs {
	readonly all: Row[] = [];
	current(id: string): Row | undefined {
		let best: Row | undefined;
		for (const r of this.all) {
			if (String(r.id) !== id) continue;
			if (best === undefined || Number(r.version) > Number(best.version)) best = r;
		}
		return best;
	}
	responder = (req: TransportRequest): Row[] => {
		const sql = req.sql;
		if (/CREATE TABLE/i.test(sql)) return [];
		if (/information_schema\.columns/i.test(sql)) return MEMORY_JOBS_COLUMNS.map((c) => ({ column_name: c.name }));
		if (/^DELETE FROM/i.test(sql.trim())) {
			const id = this.extractEq(sql, "id");
			if (id !== undefined) for (let i = this.all.length - 1; i >= 0; i--) if (String(this.all[i].id) === id) this.all.splice(i, 1);
			return [];
		}
		if (/^INSERT INTO/i.test(sql.trim())) {
			this.applyInsert(sql);
			return [];
		}
		if (/^SELECT/i.test(sql.trim())) return this.applySelect(sql);
		return [];
	};
	private extractEq(sql: string, column: string): string | undefined {
		const m = sql.match(new RegExp(`${column}\\s*=\\s*'([^']*)'`));
		return m ? m[1] : undefined;
	}
	private applyInsert(sql: string): void {
		const m = sql.match(/\(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\)\s*$/i);
		if (!m) return;
		const cols = m[1].split(",").map((c) => c.trim());
		const vals = this.splitTopLevel(m[2]).map((s) => s.trim());
		const row: Row = {};
		cols.forEach((c, i) => {
			row[c] = this.coerce(vals[i]);
		});
		this.all.push(row);
	}
	private applySelect(sql: string): Row[] {
		if (/SELECT\s+DISTINCT\s+id\s+FROM/i.test(sql)) {
			const ids = new Set(this.all.map((r) => String(r.id)));
			return [...ids].map((id) => ({ id }));
		}
		if (/WHERE\s+id\s*=/i.test(sql) && /ORDER\s+BY\s+version\s+DESC/i.test(sql)) {
			const id = this.extractEq(sql, "id");
			const row = id !== undefined ? this.current(id) : undefined;
			return row ? [{ ...row }] : [];
		}
		// Paginated full-column scan (discoverIds): SELECT <cols> FROM ... ORDER BY id,version LIMIT N OFFSET M.
		if (!/WHERE/i.test(sql) && /LIMIT\s+\d+\s+OFFSET\s+\d+/i.test(sql)) {
			const limit = Number(sql.match(/LIMIT\s+(\d+)/i)?.[1] ?? "0");
			const offset = Number(sql.match(/OFFSET\s+(\d+)/i)?.[1] ?? "0");
			const sorted = [...this.all].sort((a, b) => {
				const ai = String(a.id);
				const bi = String(b.id);
				if (ai !== bi) return ai < bi ? -1 : 1;
				return Number(a.version) - Number(b.version);
			});
			return sorted.slice(offset, offset + limit).map((r) => ({ ...r }));
		}
		return [];
	}
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

// ── Fixture: a real queue over the in-memory store + a manual clock. ──────────
function makeQueue(clock: ManualClock, store: InMemoryJobs): JobQueueService {
	const fake = new FakeDeepLakeTransport(store.responder);
	const storage: StorageClient = createStorageClient({
		transport: fake,
		provider: stubProvider(fakeCredentialRecord()),
	});
	return createJobQueueService({ storage, scope: SCOPE, config: { owner: "worker-A" }, clock });
}

// Handlers: extraction filled (records jobs it ran); b/c/d/e default no-op stubs.
function makeHandlers(opts: { onRun?: (job: StageJob) => void; throwOnce?: { count: number } } = {}): {
	handlers: StageHandlers;
	ran: StageJob[];
} {
	const ran: StageJob[] = [];
	const model = createFakeModelClient({
		memory_extraction: '{"facts":[{"content":"x","type":"fact","confidence":0.9}],"entities":[]}',
	});
	const filledExtraction: StageHandler = async (job) => {
		ran.push(job);
		opts.onRun?.(job);
		if (opts.throwOnce && opts.throwOnce.count > 0) {
			opts.throwOnce.count -= 1;
			throw new Error("simulated crash mid-extraction");
		}
	};
	const handlers = createPipelineHandlers({
		extraction: { config: PipelineConfigSchema.parse({ enabled: true, extractionProvider: "fake" }), model },
	});
	// Swap in the recording/throwing extraction handler for the test.
	handlers.memory_extraction = filledExtraction;
	return { handlers, ran };
}

describe("stage-worker routing: a leased job is routed by kind to its handler", () => {
	it("an extraction job runs the extraction handler and the job completes", async () => {
		const clock = manualClock();
		const store = new InMemoryJobs();
		const queue = makeQueue(clock, store);
		const { handlers, ran } = makeHandlers();
		const worker = createStageWorker({ queue, handlers });

		const id = await queue.enqueue({ kind: "memory_extraction", payload: { content: "raw", org: "o", workspace: "w", agent_id: "default" } });
		const processed = await worker.runOnce();

		expect(processed).toBe(true);
		expect(ran).toHaveLength(1);
		expect(ran[0].kind).toBe("memory_extraction");
		expect(ran[0].scope).toEqual({ org: "o", workspace: "w", agentId: "default" });
		expect(store.current(id)?.status).toBe("done");
	});

	it("a stubbed stage (memory_decision) is routed to its no-op and completes", async () => {
		const clock = manualClock();
		const store = new InMemoryJobs();
		const queue = makeQueue(clock, store);
		const { handlers } = makeHandlers();
		const worker = createStageWorker({ queue, handlers });

		const id = await queue.enqueue({ kind: "memory_decision", payload: {} });
		const processed = await worker.runOnce();

		expect(processed).toBe(true);
		// The no-op stub completes the job (inert routing) — proves b/c/d/e are wired.
		expect(store.current(id)?.status).toBe("done");
	});

	it("runOnce returns false when nothing is leasable", async () => {
		const clock = manualClock();
		const store = new InMemoryJobs();
		const queue = makeQueue(clock, store);
		const { handlers } = makeHandlers();
		const worker = createStageWorker({ queue, handlers });
		expect(await worker.runOnce()).toBe(false);
	});
});

describe("a-AC-6 worker crash mid-job → the queue reclaims and the job is retried", () => {
	it("a handler that throws is failed→re-queued (attempts remain) and a later run completes it", async () => {
		const clock = manualClock();
		const store = new InMemoryJobs();
		const queue = makeQueue(clock, store);
		// First run throws (the crash); subsequent runs succeed.
		const { handlers, ran } = makeHandlers({ throwOnce: { count: 1 } });
		const worker = createStageWorker({ queue, handlers });

		const id = await queue.enqueue({ kind: "memory_extraction", payload: { content: "raw" } });

		// Run 1: the handler throws → the worker routes it to queue.fail → re-queued.
		await worker.runOnce();
		expect(ran).toHaveLength(1);
		const afterFail = store.current(id);
		expect(afterFail?.status).toBe("failed"); // attempts < max → failed (retryable), not dead.
		expect(Number(afterFail?.attempts)).toBe(1);

		// Advance past the backoff window so next_run_at has passed, then run again.
		clock.advance(60_000);
		const processedAgain = await worker.runOnce();
		expect(processedAgain).toBe(true);
		expect(ran).toHaveLength(2); // retried
		expect(store.current(id)?.status).toBe("done"); // the retry completed it.
	});

	it("a STALE lease from a crashed worker (no complete/fail) is reaped and re-leasable", async () => {
		const clock = manualClock();
		const store = new InMemoryJobs();
		const queue = makeQueue(clock, store);

		await queue.enqueue({ kind: "memory_extraction", payload: { content: "raw" } });

		// Lease the job directly (simulating a worker that grabbed it) ...
		const leased = await queue.lease();
		expect(leased).not.toBeNull();
		expect(store.current(leased?.id ?? "")?.status).toBe("leased");

		// ... then the worker CRASHES: it never calls complete/fail. The lease goes
		// stale. Advance past the 5min lease window and run the queue's reaper (the
		// SAME sweep the bootstrap timer fires) — it reclaims the job to `queued`.
		// We invoke reapExpiredLeases directly so the async sweep is awaited
		// deterministically (the start() timer callback is fire-and-forget).
		const reaper = queue as JobQueueService & { reapExpiredLeases(): Promise<number> };
		clock.advance(6 * 60 * 1_000);
		const reclaimed = await reaper.reapExpiredLeases();

		expect(reclaimed).toBe(1);
		const afterReap = store.current(leased?.id ?? "");
		expect(afterReap?.status).toBe("queued"); // reclaimed for retry (a-AC-6).
		// And it is leasable again (attempts not consumed by a reap).
		const released = await queue.lease();
		expect(released?.id).toBe(leased?.id);
	});
});

describe("stage-worker observability: start emits stage.worker.started (job-observability)", () => {
	it("start() emits stage.worker.started with the leaseKinds the loop leases", () => {
		const clock = manualClock();
		const store = new InMemoryJobs();
		const queue = makeQueue(clock, store);
		const { handlers } = makeHandlers();
		const events: { name: string; fields?: Record<string, unknown> }[] = [];
		const worker = createStageWorker({
			queue,
			handlers,
			logger: { event: (name, fields) => events.push({ name, fields }) },
		});

		worker.start();
		worker.stop();

		const started = events.find((e) => e.name === "stage.worker.started");
		expect(started).toBeDefined();
		// Default leaseKinds are the five pipeline kinds — the backlogged `memory_extraction` must be one,
		// so its ABSENCE from a live daemon's logs would mean the loop never started (the real bug signal).
		expect(started?.fields?.leaseKinds).toContain("memory_extraction");
	});
});
