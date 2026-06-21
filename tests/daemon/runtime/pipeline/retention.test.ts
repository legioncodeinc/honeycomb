/**
 * PRD-006e Retention — e-AC-1..e-AC-6 (the batched, idempotent, gated sweep).
 *
 * Verification posture (CONVENTIONS §5 / EXECUTION_LEDGER-prd-006):
 *   - The sweep runs against the PRD-002 fake transport (`FakeDeepLakeTransport`)
 *     wrapped in a REAL `StorageClient` — byte-identical to production, no network.
 *   - A small SQL-aware {@link InMemoryTables} responder emulates the engine tables
 *     (`memories` / `memory_history` / `memory_entity_mentions`) so the REAL SQL the
 *     sweep emits (SELECT-id windowed, UPDATE tombstone, NULL-embedding, DELETE) is
 *     exercised and asserted via `fake.requests` — not a hand-mocked method.
 *   - Time is driven through the injected {@link RetentionClock}: a manual clock sets
 *     `now()` so the age windows are deterministic without `vi.useFakeTimers()`.
 *   - The pipeline config is resolved through the REAL `resolvePipelineConfig` from a
 *     stub provider, so the gate flags (`autonomous.enabled` / `frozen`) and windows
 *     (D-5) are the real validated config a stage reads.
 *   - Each test is named after the AC it proves (one-to-one ledger map).
 *   - No `.skip` / `.only`; `vitest run` is CI.
 *
 * Test layout:
 *   e-AC-1  ordered sweep purges in the fixed order within the batch limit
 *   e-AC-2  an interrupted run re-runs idempotently — no double-purge
 *   e-AC-3  a purged memory's embedding is retired WITH the row (no orphan vector)
 *   e-AC-4  autonomous.enabled off → no run, no storage touched
 *   e-AC-5  autonomous.frozen set → halt, no purges
 *   e-AC-6  the sweep reaching the per-run batch limit stops and yields
 */

import { describe, expect, it } from "vitest";

import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { QueryScope, StorageClient } from "../../../../src/daemon/storage/index.js";
import { TransportError, type TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { fakeCredentialRecord, FakeDeepLakeTransport, stubProvider } from "../../../helpers/fake-deeplake.js";
import {
	type PipelineConfig,
	type RawPipelineConfig,
	resolvePipelineConfig,
} from "../../../../src/daemon/runtime/pipeline/config.js";
import {
	createRetentionHandler,
	type JobPurger,
	RETENTION_STEP_ORDER,
	type RetentionClock,
	type RetentionHandlerDeps,
	runRetentionSweep,
} from "../../../../src/daemon/runtime/pipeline/retention.js";
import type { StageJob } from "../../../../src/daemon/runtime/pipeline/stage-worker.js";

const SCOPE: QueryScope = { org: "fake-org", workspace: "fake-ws" };
const AGENT = "default";

// ── A manual clock: `now()` only moves when a test sets it. ──────────────────
function manualClock(nowMs: number): RetentionClock & { set(ms: number): void } {
	let cur = nowMs;
	return { now: () => cur, set: (ms) => (cur = ms) };
}

// ── A `memory_retention` StageJob carrying the tenancy scope (006a FR-10). ───
function retentionJob(agentId = AGENT): StageJob {
	return {
		id: "ret-1",
		kind: "memory_retention",
		attempt: 1,
		scope: { org: SCOPE.org, workspace: SCOPE.workspace ?? "", agentId },
		payload: { org: SCOPE.org, workspace: SCOPE.workspace, agent_id: agentId },
	};
}

// ── Resolve the REAL pipeline config from a stub provider, overriding flags. ──
function config(raw: RawPipelineConfig): PipelineConfig {
	return resolvePipelineConfig({ read: () => raw });
}

/** A seed row for the in-memory `memories` table. */
interface MemRow {
	id: string;
	is_deleted: number;
	agent_id: string;
	importance: number;
	updated_at: string;
	content_embedding: unknown;
}

/**
 * A SQL-aware in-memory store for the engine tables the sweep touches. It parses
 * exactly the statement shapes the sweep emits — windowed `SELECT id`, `UPDATE …
 * SET is_deleted` / `SET content_embedding = NULL`, and `DELETE … WHERE` — so the
 * tests assert behaviour against the REAL emitted SQL, not a mock. It is NOT a
 * general SQL engine; it understands only the sweep's statements.
 */
class InMemoryTables {
	memories: MemRow[] = [];
	history: Array<{ id: string; created_at: string }> = [];
	mentions: Array<{ id: string; memory_id: string; agent_id: string }> = [];
	/** Statements observed, for order/assertion (mirror of fake.requests, parsed). */
	readonly ops: string[] = [];
	/**
	 * When > 0, the next this-many memories-DELETEs are SILENTLY dropped: the
	 * statement returns `ok` but the row is NOT removed — the genuine D-8 reality
	 * on this backend (an eventual-consistency store ACKNOWLEDGES the delete yet a
	 * stale segment keeps serving the row a beat later). This is deliberately an
	 * OK-but-didn't-remove drop, NOT a transient `connection_error`: a reported
	 * transport flap on an idempotent DELETE is now retried IN-PASS by the storage
	 * client (the write-retry hardening), so it would complete within one sweep and
	 * could never model a cross-sweep leftover. A SILENT non-removal reports success
	 * (so the storage layer cannot know to retry it — and correctly does not), which
	 * is exactly the leftover the NEXT sweep must re-select and re-purge. The sweep
	 * therefore re-runs idempotently (set-based on tombstone state) with no double-
	 * purge: the already-gone row is never re-deleted, the still-present one is.
	 */
	dropNextMemoryDeletes = 0;

	responder = (req: TransportRequest): Record<string, unknown>[] => {
		const sql = req.sql.trim();

		if (/CREATE TABLE/i.test(sql)) return [];
		if (/information_schema\.columns/i.test(sql)) return [];

		if (/^SELECT/i.test(sql)) return this.applySelect(sql);
		if (/^UPDATE/i.test(sql)) {
			this.applyUpdate(sql);
			return [];
		}
		if (/^DELETE FROM/i.test(sql)) {
			this.applyDelete(sql);
			return [];
		}
		return [];
	};

	private eq(sql: string, col: string): string | undefined {
		// Word-boundary on the column so `id` does not match inside `agent_id`.
		const m = sql.match(new RegExp(`(?:^|[\\s(])${col}\\s*=\\s*'([^']*)'`));
		return m ? m[1] : undefined;
	}

	/** Extract the `<col> <= '<value>'` cutoff literal a windowed SELECT carries. */
	private le(sql: string, col: string): string | undefined {
		const m = sql.match(new RegExp(`(?:^|[\\s(])${col}\\s*<=\\s*'([^']*)'`));
		return m ? m[1] : undefined;
	}

	private table(sql: string): string {
		const m = sql.match(/(?:FROM|INTO|UPDATE)\s+"([a-z_]+)"/i);
		return m ? m[1] : "";
	}

	private applySelect(sql: string): Record<string, unknown>[] {
		const tbl = this.table(sql);
		const limit = Number(sql.match(/LIMIT\s+(\d+)/i)?.[1] ?? "1000000");
		if (tbl === "memories") {
			const cutoff = this.le(sql, "updated_at") ?? "";
			// Tombstone-purge select: is_deleted = 1.
			if (/is_deleted\s*=\s*1/.test(sql)) {
				return this.memories
					.filter((r) => r.is_deleted === 1 && r.agent_id === AGENT && r.updated_at !== "" && r.updated_at <= cutoff)
					.slice(0, limit)
					.map((r) => ({ id: r.id }));
			}
			// Decay select: is_deleted = 0 AND importance < ceiling.
			return this.memories
				.filter(
					(r) =>
						r.is_deleted === 0 &&
						r.agent_id === AGENT &&
						r.updated_at !== "" &&
						r.updated_at <= cutoff &&
						r.importance < 0.5,
				)
				.slice(0, limit)
				.map((r) => ({ id: r.id }));
		}
		if (tbl === "memory_history") {
			const cutoff = this.le(sql, "created_at") ?? "";
			return this.history
				.filter((r) => r.created_at !== "" && r.created_at <= cutoff)
				.slice(0, limit)
				.map((r) => ({ id: r.id }));
		}
		return [];
	}

	private applyUpdate(sql: string): void {
		const id = this.eq(sql, "id");
		const row = this.memories.find((r) => r.id === id);
		if (!row) return;
		if (/is_deleted\s*=\s*1/.test(sql)) {
			row.is_deleted = 1;
			this.ops.push(`tombstone:${id}`);
		}
		if (/content_embedding\s*=\s*NULL/i.test(sql)) {
			row.content_embedding = null;
			this.ops.push(`nullemb:${id}`);
		}
	}

	private applyDelete(sql: string): void {
		const tbl = this.table(sql);
		if (tbl === "memories") {
			if (this.dropNextMemoryDeletes > 0) {
				this.dropNextMemoryDeletes -= 1;
				// SILENT D-8 drop: report success (return ok by NOT throwing) but do NOT
				// splice the row, so the tombstone stays selectable for the next sweep.
				// We still record the issued op so the count reflects the attempt. Because
				// the result is `ok`, the storage client's idempotent-write retry does NOT
				// fire (it cannot know the row was not removed) — the cross-sweep re-run is
				// what reclaims it, which is the property under test (e-AC-2 / FR-4).
				const droppedId = this.eq(sql, "id");
				this.ops.push(`del-mem:${droppedId}`);
				return;
			}
			const id = this.eq(sql, "id");
			this.memories = this.memories.filter((r) => r.id !== id);
			this.ops.push(`del-mem:${id}`);
		} else if (tbl === "memory_history") {
			const id = this.eq(sql, "id");
			this.history = this.history.filter((r) => r.id !== id);
			this.ops.push(`del-hist:${id}`);
		} else if (tbl === "memory_entity_mentions") {
			const memId = this.eq(sql, "memory_id");
			this.mentions = this.mentions.filter((r) => r.memory_id !== memId);
			this.ops.push(`del-mention:${memId}`);
		}
	}
}

// ── Fixture: storage over the in-memory tables + a deps bundle. ──────────────
function makeDeps(opts: {
	store: InMemoryTables;
	cfg: PipelineConfig;
	clock: RetentionClock;
	jobs?: JobPurger;
}): { deps: RetentionHandlerDeps; fake: FakeDeepLakeTransport } {
	const fake = new FakeDeepLakeTransport(opts.store.responder);
	const storage: StorageClient = createStorageClient({
		transport: fake,
		provider: stubProvider(fakeCredentialRecord()),
	});
	const deps: RetentionHandlerDeps = {
		storage,
		scope: SCOPE,
		config: opts.cfg,
		clock: opts.clock,
		jobs: opts.jobs,
	};
	return { deps, fake };
}

const NOW = Date.parse("2026-06-17T00:00:00.000Z");
const DAY = 24 * 60 * 60 * 1_000;
/** An ISO timestamp `days` before NOW (well past every window when days is large). */
const ago = (days: number): string => new Date(NOW - days * DAY).toISOString();

describe("e-AC-4 autonomous.enabled off → retention does not run", () => {
	it("gates FIRST: no storage statement is issued and the sweep reports disabled", async () => {
		const store = new InMemoryTables();
		store.memories.push({ id: "m1", is_deleted: 1, agent_id: AGENT, importance: 0.1, updated_at: ago(60), content_embedding: [1] });
		// enabled defaults false → autonomous.enabled false too.
		const { deps, fake } = makeDeps({ store, cfg: config({}), clock: manualClock(NOW) });

		const outcome = await runRetentionSweep(deps, retentionJob());

		expect(outcome.ran).toBe(false);
		expect(outcome.skippedReason).toBe("disabled");
		expect(outcome.purged).toBe(0);
		// The gate is checked BEFORE any storage call — nothing went to the wire.
		expect(fake.requests).toHaveLength(0);
		// And the row was NOT purged.
		expect(store.memories).toHaveLength(1);
	});
});

describe("e-AC-5 autonomous.frozen set → halt, no further purges", () => {
	it("frozen supersedes enabled: the sweep halts and issues no statement", async () => {
		const store = new InMemoryTables();
		store.memories.push({ id: "m1", is_deleted: 1, agent_id: AGENT, importance: 0.1, updated_at: ago(60), content_embedding: [1] });
		const cfg = config({ autonomous: { enabled: true, frozen: true } });
		const { deps, fake } = makeDeps({ store, cfg, clock: manualClock(NOW) });

		const outcome = await runRetentionSweep(deps, retentionJob());

		expect(outcome.ran).toBe(false);
		expect(outcome.skippedReason).toBe("frozen");
		expect(fake.requests).toHaveLength(0);
		expect(store.memories).toHaveLength(1);
	});
});

describe("e-AC-1 ordered sweep purges in the fixed order within the batch limit", () => {
	it("runs decay → graph_links → embeddings_tombstones → history → jobs, and purges past-window rows", async () => {
		const store = new InMemoryTables();
		// A tombstoned, past-window memory (purge target) with a mention link + embedding.
		store.memories.push({ id: "tomb1", is_deleted: 1, agent_id: AGENT, importance: 0.9, updated_at: ago(60), content_embedding: [0.1, 0.2] });
		store.mentions.push({ id: "men1", memory_id: "tomb1", agent_id: AGENT });
		// A past-window history row (purge target).
		store.history.push({ id: "h1", created_at: ago(120) });
		// A fresh memory that must NOT be touched.
		store.memories.push({ id: "fresh", is_deleted: 0, agent_id: AGENT, importance: 0.9, updated_at: ago(1), content_embedding: [0.5] });

		const purged: string[] = [];
		const jobs: JobPurger = {
			async purgeRetained() {
				purged.push("jobs");
				return { doneDeleted: true, deadDeleted: true };
			},
		};
		const cfg = config({ autonomous: { enabled: true } });
		const { deps } = makeDeps({ store, cfg, clock: manualClock(NOW), jobs });

		const outcome = await runRetentionSweep(deps, retentionJob());

		expect(outcome.ran).toBe(true);
		// The steps executed in the fixed order (e-AC-1 / FR-2).
		expect(outcome.steps).toEqual([...RETENTION_STEP_ORDER]);
		// graph-link purge happened BEFORE the owning-row purge (no orphan).
		const mentionIdx = store.ops.indexOf("del-mention:tomb1");
		const rowIdx = store.ops.indexOf("del-mem:tomb1");
		expect(mentionIdx).toBeGreaterThanOrEqual(0);
		expect(rowIdx).toBeGreaterThan(mentionIdx);
		// History purged; jobs purge delegated to the queue seam.
		expect(store.history).toHaveLength(0);
		expect(purged).toEqual(["jobs"]);
		// The fresh memory survived.
		expect(store.memories.map((r) => r.id)).toEqual(["fresh"]);
	});
});

describe("e-AC-3 a purged memory's embedding is retired WITH the row (no orphan vector)", () => {
	it("nulls content_embedding before deleting the owning row, in that order", async () => {
		const store = new InMemoryTables();
		store.memories.push({ id: "tomb1", is_deleted: 1, agent_id: AGENT, importance: 0.9, updated_at: ago(60), content_embedding: [0.1, 0.2, 0.3] });
		const cfg = config({ autonomous: { enabled: true } });
		const { deps } = makeDeps({ store, cfg, clock: manualClock(NOW) });

		await runRetentionSweep(deps, retentionJob());

		// The embedding was nulled, then the row deleted — same step, owning row.
		const nullIdx = store.ops.indexOf("nullemb:tomb1");
		const delIdx = store.ops.indexOf("del-mem:tomb1");
		expect(nullIdx).toBeGreaterThanOrEqual(0);
		expect(delIdx).toBeGreaterThan(nullIdx);
		// No row, hence no orphaned vector, remains.
		expect(store.memories).toHaveLength(0);
	});
});

describe("e-AC-6 the sweep reaching the per-run batch limit stops and yields", () => {
	it("a batchLimit of 1 purges one row then stops mid-order without reaching later steps", async () => {
		const store = new InMemoryTables();
		// Two tombstoned past-window memories; with batchLimit 1 only one is purged.
		store.memories.push({ id: "tomb1", is_deleted: 1, agent_id: AGENT, importance: 0.9, updated_at: ago(60), content_embedding: [1] });
		store.memories.push({ id: "tomb2", is_deleted: 1, agent_id: AGENT, importance: 0.9, updated_at: ago(60), content_embedding: [1] });
		// A history row that must NOT be reached because the budget is exhausted first.
		store.history.push({ id: "h1", created_at: ago(120) });

		let jobsPurged = false;
		const jobs: JobPurger = {
			async purgeRetained() {
				jobsPurged = true;
				return { doneDeleted: true, deadDeleted: true };
			},
		};
		const cfg = config({ autonomous: { enabled: true }, retention: { batchLimit: 1 } });
		const { deps } = makeDeps({ store, cfg, clock: manualClock(NOW), jobs });

		const outcome = await runRetentionSweep(deps, retentionJob());

		expect(outcome.ran).toBe(true);
		expect(outcome.stoppedAtLimit).toBe(true);
		expect(outcome.purged).toBe(1);
		// Exactly one memory remains (the budget stopped the second purge).
		expect(store.memories).toHaveLength(1);
		// The later steps were never reached: history untouched, jobs never purged.
		expect(store.history).toHaveLength(1);
		expect(jobsPurged).toBe(false);
		expect(outcome.steps).not.toContain("history");
		expect(outcome.steps).not.toContain("completed_jobs");
	});
});

describe("e-AC-2 an interrupted retention re-runs idempotently — no double-purge", () => {
	it("a delete the backend did not remove (D-8) is re-purged next run, with no double-purge", async () => {
		const store = new InMemoryTables();
		store.memories.push({ id: "tomb1", is_deleted: 1, agent_id: AGENT, importance: 0.9, updated_at: ago(60), content_embedding: [1] });
		store.memories.push({ id: "tomb2", is_deleted: 1, agent_id: AGENT, importance: 0.9, updated_at: ago(60), content_embedding: [1] });
		// The FIRST memories-DELETE is dropped (the backend did not actually remove the
		// row — the D-8 reality); the second lands. So one row survives the first run.
		store.dropNextMemoryDeletes = 1;

		const cfg = config({ autonomous: { enabled: true } });
		const { deps } = makeDeps({ store, cfg, clock: manualClock(NOW) });

		// First run: one delete dropped, one lands → one row survives. The sweep does
		// NOT throw — a non-ok delete is "not purged this run", left for the next sweep.
		const first = await runRetentionSweep(deps, retentionJob());
		expect(first.ran).toBe(true);
		expect(store.memories).toHaveLength(1);
		const survivingId = store.memories[0].id;
		const delOpsBefore = store.ops.filter((o) => o.startsWith("del-mem:")).length;

		// Re-run — set-based on tombstone state, so it re-selects ONLY the still-present
		// tombstone and purges it. The already-removed row is gone, so it is never
		// re-deleted: no double-purge (e-AC-2 / FR-4).
		const outcome = await runRetentionSweep(deps, retentionJob());

		expect(outcome.ran).toBe(true);
		expect(store.memories).toHaveLength(0);
		// The re-run issued exactly ONE more memories-delete — the surviving row only.
		const delOpsAfter = store.ops.filter((o) => o.startsWith("del-mem:")).length;
		expect(delOpsAfter - delOpsBefore).toBe(1);
		expect(store.ops).toContain(`del-mem:${survivingId}`);

		// A THIRD run over the now-empty set is a clean no-op (idempotent steady state).
		const noop = await runRetentionSweep(deps, retentionJob());
		expect(noop.ran).toBe(true);
		expect(noop.purged).toBe(0);
	});
});

describe("createRetentionHandler wraps the sweep as a StageHandler", () => {
	it("with no deps returns the no-op handler (safe default for the unwired stage)", async () => {
		const handler = createRetentionHandler();
		// The no-op resolves without touching anything.
		await expect(handler(retentionJob())).resolves.toBeUndefined();
	});

	it("with deps runs the gated sweep and returns (the worker then completes the job)", async () => {
		const store = new InMemoryTables();
		store.memories.push({ id: "tomb1", is_deleted: 1, agent_id: AGENT, importance: 0.9, updated_at: ago(60), content_embedding: [1] });
		const cfg = config({ autonomous: { enabled: true } });
		const { deps } = makeDeps({ store, cfg, clock: manualClock(NOW) });

		const handler = createRetentionHandler(deps);
		await expect(handler(retentionJob())).resolves.toBeUndefined();
		expect(store.memories).toHaveLength(0);
	});
});
