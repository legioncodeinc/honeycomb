/**
 * PRD-062b L-X (062a labeling, poll-path half) — the lease/reaper reads carry the
 * right `source` so the 062a query meter attributes the idle-poll baseline.
 *
 * Verification posture:
 *   - A real {@link StorageClient} over the PRD-002 fake transport, with a SHARED
 *     {@link QueryMeter} injected, so the source labels the job-queue threads through
 *     `StorageClient.query(sql, scope, { source })` are observed at the real choke
 *     point — not a mock. The meter is a pure observer (PRD-062a), so labeling never
 *     changes the queue's behavior; this test asserts only the attribution.
 *   - Maps to the poll-path half of 062a's labeling: lease discovery → `poll-lease`,
 *     the reaper sweep → `poll-reaper`. The retention purge stays `other`.
 *   - No `.skip` / `.only`; `vitest run` is CI.
 */

import { describe, expect, it } from "vitest";

import { MEMORY_JOBS_COLUMNS } from "../../../../src/daemon/storage/catalog/index.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { QueryScope } from "../../../../src/daemon/storage/index.js";
import { QueryMeter } from "../../../../src/daemon/storage/query-meter.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { fakeCredentialRecord, FakeDeepLakeTransport, stubProvider } from "../../../helpers/fake-deeplake.js";
import {
	createJobQueueService,
	type JobQueueClock,
	type JobQueueService,
} from "../../../../src/daemon/runtime/services/job-queue.js";

const SCOPE: QueryScope = { org: "fake-org", workspace: "fake-ws" };

/** A manual clock so lease-expiry + the reaper sweep are deterministic. */
function manualClock(startMs = 1_000_000_000_000): JobQueueClock & { advance(ms: number): void } {
	let nowMs = startMs;
	return {
		now: () => nowMs,
		setTimer: () => 0,
		clearTimer: () => {},
		advance: (ms) => {
			nowMs += ms;
		},
	};
}

/** Read a meter snapshot's reads for one source (0 when the source never fired). */
function readsFor(meter: QueryMeter, source: string): number {
	const entry = meter.snapshot().perSource.find((e) => e.source === source);
	return entry?.reads ?? 0;
}

/**
 * A minimal append-only `memory_jobs` responder — just enough to drive one lease +
 * one reaper sweep. Distinct from the broader job-queue suite's store (this test only
 * needs the discovery scan + by-id resolve + insert to round-trip).
 */
class TinyJobs {
	readonly rows: Record<string, unknown>[] = [];
	current(id: string): Record<string, unknown> | undefined {
		let best: Record<string, unknown> | undefined;
		for (const r of this.rows) {
			if (String(r.id) !== id) continue;
			if (best === undefined || Number(r.version) > Number(best.version)) best = r;
		}
		return best;
	}
	responder = (req: TransportRequest): Record<string, unknown>[] => {
		const sql = req.sql.trim();
		if (/CREATE TABLE/i.test(sql)) return [];
		if (/information_schema\.columns/i.test(sql)) return MEMORY_JOBS_COLUMNS.map((c) => ({ column_name: c.name }));
		if (/^INSERT INTO/i.test(sql)) {
			this.applyInsert(sql);
			return [];
		}
		if (/SELECT\s+DISTINCT\s+id\s+FROM/i.test(sql)) {
			return [...new Set(this.rows.map((r) => String(r.id)))].map((id) => ({ id }));
		}
		if (/WHERE\s+id\s*=/i.test(sql) && /ORDER\s+BY\s+version\s+DESC/i.test(sql)) {
			const m = sql.match(/id\s*=\s*'([^']*)'/);
			const row = m ? this.current(m[1]) : undefined;
			return row ? [{ ...row }] : [];
		}
		return [];
	};
	private applyInsert(sql: string): void {
		const m = sql.match(/\(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\)\s*$/i);
		if (!m) return;
		const cols = m[1].split(",").map((c) => c.trim());
		const vals = this.splitTop(m[2]).map((s) => s.trim());
		const row: Record<string, unknown> = {};
		cols.forEach((c, i) => {
			row[c] = this.coerce(vals[i]);
		});
		this.rows.push(row);
	}
	private splitTop(list: string): string[] {
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

function makeQueue(): { queue: JobQueueService; meter: QueryMeter; clock: ReturnType<typeof manualClock> } {
	const store = new TinyJobs();
	const clock = manualClock();
	const meter = new QueryMeter();
	const storage = createStorageClient({
		transport: new FakeDeepLakeTransport(store.responder),
		provider: stubProvider(fakeCredentialRecord()),
		meter,
	});
	const queue = createJobQueueService({ storage, scope: SCOPE, config: { owner: "owner-A" }, clock });
	return { queue, meter, clock };
}

describe("PRD-062b: poll-path source labels feed the 062a meter", () => {
	it("the lease discovery path attributes its reads to `poll-lease`", async () => {
		const { queue, meter } = makeQueue();
		await queue.enqueue({ kind: "memory_extraction", payload: {} });

		await queue.lease(["memory_extraction"]);

		// The lease path issued reads (the discovery scan + per-id resolves), all tagged
		// `poll-lease`. The enqueue was a WRITE (not counted as a read of any source).
		expect(readsFor(meter, "poll-lease")).toBeGreaterThan(0);
		expect(readsFor(meter, "poll-reaper")).toBe(0);
	});

	it("the reaper sweep attributes its reads to `poll-reaper`", async () => {
		const { queue, meter, clock } = makeQueue();
		await queue.enqueue({ kind: "memory_extraction", payload: {} });
		await queue.lease(["memory_extraction"]); // take a lease so the reaper has something to find.

		const before = readsFor(meter, "poll-reaper");
		clock.advance(10 * 60 * 1_000); // past the 5min lease window.
		const reaper = queue as JobQueueService & { reapExpiredLeases(): Promise<number> };
		await reaper.reapExpiredLeases();

		// The reaper sweep's discovery + resolve reads are all tagged `poll-reaper`.
		expect(readsFor(meter, "poll-reaper")).toBeGreaterThan(before);
	});
});
