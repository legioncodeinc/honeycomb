/**
 * PRD-080a a-AC-8 — VERIFIED-by-mechanism (QA close-out, quality-worker-bee).
 *
 * a-AC-8 is a LIVE dogfood criterion: during an observed DeepLake degraded window a distilled
 * controlled-write lands in `memory_outbox` (pending > 0), and on recovery the drainer commits it
 * (pending → 0) with the `memories` row present + no duplicate. A natural degraded window cannot be
 * induced on demand and there is no live workspace in CI, so this test proves the exact MECHANISM
 * end-to-end through the REAL controlled-write path (`applyControlledWrite`) + the REAL SQLite outbox
 * (`openMemoryOutbox`) via controlled fault injection at the storage seam:
 *
 *   1. Fault ON (degraded window)  → the live write DEFERS: `action: "deferred"` (the job ACKs, does
 *      NOT throw / does NOT burn attempts), the resolved write lands in the outbox (pending = 1), and
 *      NOTHING is committed to `memories`.
 *   2. Fault OFF (backend recovers) + drain → the outbox re-commits: pending → 0, the memory is now
 *      present in the backend, exactly ONE INSERT of that row.
 *   3. Idempotency → a further drain / a replay of the same write is `deduped` (content_hash) → the
 *      INSERT count NEVER climbs past 1 (no duplicate `memories` row).
 *
 * The storage stub sits at the SAME `StorageQuery` boundary the production HTTP transport occupies and
 * is SHARED by both the live stage and the outbox drainer, so the whole path under test (transient
 * classification → enqueue → durable replay → dedup) is real production code.
 */

import { describe, expect, it } from "vitest";

import {
	applyControlledWrite,
	type ControlledWriteHandlerDeps,
	type ControlledWriteInput,
} from "../../../../src/daemon/runtime/pipeline/controlled-writes.js";
import { type OutboxClock, openMemoryOutbox } from "../../../../src/daemon/runtime/pipeline/memory-outbox.js";
import { PipelineConfigSchema } from "../../../../src/daemon/runtime/pipeline/config.js";
import type { EmbedClient } from "../../../../src/daemon/runtime/services/embed-client.js";
import type { QueryOptions, QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult, timeoutResult } from "../../../../src/daemon/storage/result.js";

const SCOPE: QueryScope = { org: "org-1", workspace: "ws-1" };
const nullEmbed: EmbedClient = { async embed(): Promise<readonly number[] | null> { return null; } };

function isDedupProbe(sql: string): boolean { return /content_hash\s*=/.test(sql); }
function isVersionRead(sql: string): boolean { return /SELECT\s+version\b/i.test(sql) && /ORDER\s+BY\s+version/i.test(sql); }
function isInsert(sql: string): boolean { return /INSERT\s+INTO\s+"memories"/i.test(sql); }

function fakeClock(startMs: number): OutboxClock & { advance(ms: number): void } {
	let nowMs = startMs;
	return { now: () => nowMs, setInterval: () => 1, clearInterval: () => {}, advance(ms: number): void { nowMs += ms; } };
}

/**
 * A `memories` backend that MODELS `content_hash` so idempotency is REAL: a degraded window (`fail`)
 * makes the dedup probe + INSERT return a transient timeout; on recovery (`ok`) the probe reports an
 * already-committed hash as a dedup HIT and the INSERT records the committed hash. Records every INSERT
 * so the test can assert the duplicate-free property (exactly one INSERT of the deferred row).
 */
function backend(): { storage: StorageQuery; setMode(m: "fail" | "ok"): void; get inserts(): number } {
	const st = { mode: "fail" as "fail" | "ok", committed: [] as string[], pending: "" , inserts: 0 };
	const storage: StorageQuery = {
		async query(sql: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
			if (isDedupProbe(sql)) {
				if (st.mode === "fail") return timeoutResult(10_000); // transient degraded-window flap
				const hash = /content_hash\s*=\s*'([^']+)'/.exec(sql)?.[1] ?? "";
				if (st.committed.includes(hash)) return ok([{ id: `existing-${hash}` }], 1); // dedup HIT
				st.pending = hash;
				return ok([], 1);
			}
			if (isVersionRead(sql)) return ok([], 1);
			if (isInsert(sql)) {
				if (st.mode === "fail") return timeoutResult(10_000);
				st.inserts += 1;
				if (st.pending && !st.committed.includes(st.pending)) st.committed.push(st.pending);
				st.pending = "";
				return ok([], 1);
			}
			return ok([], 1);
		},
	};
	return {
		storage,
		setMode: (m) => { st.mode = m; },
		get inserts() { return st.inserts; },
		get committed(): readonly string[] { return st.committed; },
	};
}

function deps(storage: StorageQuery, over: Partial<ControlledWriteHandlerDeps> = {}): ControlledWriteHandlerDeps {
	return {
		storage,
		config: PipelineConfigSchema.parse({}),
		embed: nullEmbed,
		now: () => new Date("2026-07-11T00:00:00.000Z"),
		newId: () => "mem_a_ac_8",
		...over,
	};
}

const input: ControlledWriteInput = {
	proposal: { action: "add", confidence: 0.9, reason: "" },
	content: "a distilled fact formed during a degraded window",
	normalizedContent: "a distilled fact formed during a degraded window",
	factConfidence: 0.9,
};

describe("a-AC-8 (mechanism): degraded window → outbox → recovery drain → present, no duplicate", () => {
	it("defers on the degraded window, drains to committed on recovery, and never duplicates", async () => {
		const be = backend(); // starts degraded (fail)
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const outbox = openMemoryOutbox({ storage: be.storage, memory: true, clock });

		// ── (1) Degraded window: the LIVE controlled-write path defers (no throw), the write lands in the outbox.
		const out = await applyControlledWrite(input, SCOPE, deps(be.storage, { memoryOutbox: outbox }));
		expect(out.action, "the job ACKs with deferred, never throws / burns attempts").toBe("deferred");
		expect(out.memoryId).toBe("mem_a_ac_8");
		expect(outbox.counts().pending, "the resolved write is durable in memory_outbox").toBe(1);
		expect(be.inserts, "nothing committed during the degraded window").toBe(0);

		// ── (2) Recovery: drive the drainer → the deferred write commits, pending → 0, memory present.
		be.setMode("ok");
		clock.advance(10 * 60 * 1000); // past the backoff so the row is due
		const drain = await outbox.drainDue();
		expect(drain.drained).toBe(1);
		expect(outbox.counts().pending, "the backlog cleared on recovery").toBe(0);
		expect(be.inserts, "the distilled memory is now committed exactly once").toBe(1);
		// Assert the COMMITTED STATE, not only the INSERT count — the backend actually recorded the hash.
		expect(be.committed, "exactly one memory hash is durably committed after recovery").toHaveLength(1);

		// ── (3) Idempotency: replaying the SAME write is deduped (content_hash) — the INSERT count never climbs.
		const replay = await applyControlledWrite(input, SCOPE, deps(be.storage, { memoryOutbox: outbox }));
		expect(replay.action, "the already-landed memory is deduped, never re-inserted").toBe("deduped");
		expect(be.inserts, "no duplicate memories row on replay").toBe(1);
		expect(be.committed, "replay adds no new committed hash — the dedup HIT is a real recorded row").toHaveLength(1);
		expect(outbox.counts().pending).toBe(0);
		outbox.close();
	});
});
