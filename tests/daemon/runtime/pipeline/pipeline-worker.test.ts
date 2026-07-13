/**
 * PRD-045a memory-pipeline worker — the WIRED chain end-to-end (deterministic).
 *
 * This is the deterministic proof of the wiring the live itest proves against the real
 * backend: a single `memory_extraction` ENTRY job (what capture enqueues, a-AC-2) driven
 * through the daemon-resident stage worker fans out to decision → controlled-write →
 * graph-persist, producing a PERSISTED fact (an INSERT INTO "memories") and PERSISTED
 * edges (INSERTs into the knowledge-graph tables) — a-AC-3 + a-AC-4. It also proves the
 * four formerly-stub stages each produce real output, that retention runs and produces
 * output, and that a stage error fails the job (dead-letters) without crashing the
 * worker (a-AC-5).
 *
 * Verification posture (mirrors stage-worker.test.ts):
 *   - The worker runs against the REAL durable queue (`createJobQueueService`) over a
 *     SQL-aware fake transport wrapped in a real `StorageClient`, so lease/complete/fail
 *     is the queue's actual behaviour. The SAME transport also answers the stages'
 *     `memories` / `memory_history` / graph reads+writes, so the chain's persistence is
 *     real SQL through the real write primitives (`appendVersionBumped` / `withHeal`).
 *   - The model is a `createFakeModelClient` returning canned extraction JSON.
 *   - Time is the real clock; the worker is driven via `runOnce()` (no poll loop), so the
 *     chain is deterministic: each `runOnce()` leases + runs the next queued stage.
 *   - No `.skip` / `.only`; `vitest run` is CI.
 */

import { describe, expect, it } from "vitest";

import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { QueryScope, StorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import {
	FakeDeepLakeTransport,
	fakeCredentialRecord,
	stubProvider,
} from "../../../helpers/fake-deeplake.js";
import {
	createJobQueueService,
	type JobQueueService,
} from "../../../../src/daemon/runtime/services/job-queue.js";
import type { EmbedClient } from "../../../../src/daemon/runtime/services/embed-client.js";
import {
	controlledWriteFanOut,
	createFakeModelClient,
	createPipelineHandlers,
	createStageWorker,
	decisionFanOut,
	extractionFanOut,
	PipelineConfigSchema,
	type StageWorker,
} from "../../../../src/daemon/runtime/pipeline/index.js";

const SCOPE: QueryScope = { org: "org-1", workspace: "ws-1" };

type Row = Record<string, unknown>;

/**
 * A SQL-aware fake backend that answers BOTH the durable queue's `memory_jobs` reads
 * (append-only, highest-version per id) AND the stages' table reads/writes. It records
 * every INSERT'd table so the test asserts which tables the chain durably wrote to.
 *
 * Behaviour:
 *   - `information_schema.columns` → a non-empty stub so the heal path never CREATEs.
 *   - `memory_jobs` reads → the append-only highest-version-per-id resolution.
 *   - every other SELECT (dedup probe, graph presence probe) → empty (so an ADD inserts
 *     and a graph upsert appends — the "novel" path that produces output).
 *   - INSERT/UPDATE/DELETE → recorded + empty rows (success).
 */
class FakeBackend {
	readonly jobs: Row[] = [];
	/** Every table an INSERT landed on, in order. */
	readonly inserts: string[] = [];

	responder = (req: TransportRequest): Row[] => {
		const sql = req.sql.trim();
		if (/information_schema\.columns/i.test(sql)) return [{ column_name: "id" }];
		if (/CREATE TABLE/i.test(sql)) return [];

		const isJobs = /"memory_jobs"/i.test(sql) || /\bmemory_jobs\b/i.test(sql);
		if (/^INSERT INTO/i.test(sql)) {
			const table = this.tableOf(sql);
			this.inserts.push(table);
			if (isJobs) this.applyJobInsert(sql);
			return [];
		}
		if (/^DELETE FROM/i.test(sql)) {
			if (isJobs) {
				const id = this.eq(sql, "id");
				if (id !== undefined) for (let i = this.jobs.length - 1; i >= 0; i--) if (String(this.jobs[i].id) === id) this.jobs.splice(i, 1);
			}
			return [];
		}
		if (/^UPDATE /i.test(sql)) return [];
		if (/^SELECT/i.test(sql)) {
			if (isJobs) return this.applyJobSelect(sql);
			return []; // dedup probe / graph presence probe → absent → write proceeds.
		}
		return [];
	};

	private tableOf(sql: string): string {
		const m = sql.match(/INSERT INTO\s+"?([A-Za-z0-9_]+)"?/i);
		return m ? m[1] : "?";
	}
	private eq(sql: string, column: string): string | undefined {
		const m = sql.match(new RegExp(`${column}\\s*=\\s*'([^']*)'`));
		return m ? m[1] : undefined;
	}
	private current(id: string): Row | undefined {
		let best: Row | undefined;
		for (const r of this.jobs) {
			if (String(r.id) !== id) continue;
			if (best === undefined || Number(r.version) > Number(best.version)) best = r;
		}
		return best;
	}
	private applyJobInsert(sql: string): void {
		const m = sql.match(/\(([^)]*)\)\s*VALUES\s*\(([\s\S]*)\)\s*$/i);
		if (!m) return;
		const cols = m[1].split(",").map((c) => c.trim().replace(/"/g, ""));
		const vals = this.splitTopLevel(m[2]).map((s) => s.trim());
		const row: Row = {};
		cols.forEach((c, i) => {
			row[c] = this.coerce(vals[i]);
		});
		this.jobs.push(row);
	}
	private applyJobSelect(sql: string): Row[] {
		if (/SELECT\s+DISTINCT\s+"?id"?\s+FROM/i.test(sql)) {
			const ids = new Set(this.jobs.map((r) => String(r.id)));
			return [...ids].map((id) => ({ id }));
		}
		if (/WHERE\s+"?id"?\s*=/i.test(sql) && /ORDER\s+BY\s+"?version"?\s+DESC/i.test(sql)) {
			const id = this.eq(sql, "id");
			const row = id !== undefined ? this.current(id) : undefined;
			return row ? [{ ...row }] : [];
		}
		// Paginated full-column scan (discoverIds): SELECT <cols> FROM ... ORDER BY id,version LIMIT N OFFSET M.
		if (!/WHERE/i.test(sql) && /LIMIT\s+\d+\s+OFFSET\s+\d+/i.test(sql)) {
			const limit = Number(sql.match(/LIMIT\s+(\d+)/i)?.[1] ?? "0");
			const offset = Number(sql.match(/OFFSET\s+(\d+)/i)?.[1] ?? "0");
			const sorted = [...this.jobs].sort((a, b) => {
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

/** A storage client over the fake backend (records every statement). */
function makeStorage(backend: FakeBackend): StorageClient {
	const transport = new FakeDeepLakeTransport(backend.responder);
	return createStorageClient({
		transport,
		provider: stubProvider(fakeCredentialRecord({ org: SCOPE.org, workspace: SCOPE.workspace })),
	});
}

/** A fake embed client that always returns null (lexical-only path; never a throw). */
const nullEmbed: EmbedClient = { async embed(): Promise<readonly number[] | null> { return null; } };

/** A pipeline config with every stage gate ON so the wired chain produces output. */
function enabledConfig() {
	return PipelineConfigSchema.parse({
		enabled: true,
		extractionProvider: "fake",
		minFactConfidenceForWrite: 0.5,
		// minFactChars: 0 — the canned end-to-end fact is short; the ISS-025 substance
		// floor has its own coverage in extraction.test.ts.
		extraction: { minFactChars: 0 },
		graph: { enabled: true, extractionWritesEnabled: true },
		autonomous: { enabled: true },
	});
}

/** Build the worker exactly as the daemon does (real handlers + fan-out chain). */
function buildWorker(queue: JobQueueService, storage: StorageClient): StageWorker {
	const config = enabledConfig();
	const model = createFakeModelClient({
		// Extraction returns one high-confidence fact + one entity triple.
		memory_extraction:
			'{"facts":[{"content":"the daemon binds port 3850","type":"fact","confidence":0.95}],' +
			'"entities":[{"source":"daemon","relationship":"binds","target":"port"}]}',
		// Decision: with no candidates the stage short-circuits to `add` WITHOUT a model
		// call, so this is only used if candidates appear (they will not on the empty fake).
		memory_decision: '{"action":"add","confidence":0.95,"reason":"novel"}',
	});
	const handlers = createPipelineHandlers({
		extraction: { config, model, onResult: extractionFanOut(queue) },
		decision: { storage, scope: SCOPE, model, config, embed: nullEmbed, onDecisions: decisionFanOut(queue) },
		controlledWrite: { storage, config, embed: nullEmbed, onOutcome: controlledWriteFanOut(queue) },
		graphPersist: { storage, scope: SCOPE, config },
		retention: { storage, scope: SCOPE, config },
	});
	return createStageWorker({ queue, handlers });
}

/** Drive `runOnce()` until the queue is drained (bounded so a bug can't hang the suite). */
async function drain(worker: StageWorker, maxSteps = 20): Promise<number> {
	let steps = 0;
	while (steps < maxSteps) {
		const processed = await worker.runOnce();
		if (!processed) break;
		steps += 1;
	}
	return steps;
}

describe("PRD-045a: the wired pipeline turns a capture entry into persisted facts + edges", () => {
	it("a memory_extraction entry job fans out through every stage and persists a memory + graph edges", async () => {
		const backend = new FakeBackend();
		const storage = makeStorage(backend);
		const queue = createJobQueueService({ storage, scope: SCOPE, config: { owner: "pipeline-A" } });
		await queue.start();
		const worker = buildWorker(queue, storage);

		// a-AC-2: capture's entry job — exactly what makePipelineEntryEnqueuer enqueues.
		await queue.enqueue({
			kind: "memory_extraction",
			payload: { org: SCOPE.org, workspace: SCOPE.workspace, agent_id: "default", content: "the daemon binds port 3850 in local mode" },
		});

		await drain(worker);

		// a-AC-3 / a-AC-4: the chain reached controlled-write (a memory persisted) AND
		// graph-persist (entity/edge rows persisted) — proven by the tables the chain INSERTed into.
		expect(backend.inserts).toContain("memories"); // the fact persisted (controlled-write ADD).
		expect(backend.inserts).toContain("memory_history"); // decision recorded its proposal.
		expect(backend.inserts).toContain("entities"); // graph entity persisted.
		expect(backend.inserts).toContain("entity_dependencies"); // graph edge persisted.
		expect(backend.inserts).toContain("memory_entity_mentions"); // memory↔entity mention linked.
		queue.stop();
	});

	it("retention runs as a leased stage and produces output (a-AC-4)", async () => {
		const backend = new FakeBackend();
		const storage = makeStorage(backend);
		const queue = createJobQueueService({ storage, scope: SCOPE, config: { owner: "pipeline-B" } });
		await queue.start();
		const worker = buildWorker(queue, storage);

		// A retention sweep is a scheduled job (not in the per-turn chain). Enqueue one directly
		// and prove the leased worker runs the gated, ordered sweep to completion.
		const id = await queue.enqueue({
			kind: "memory_retention",
			payload: { org: SCOPE.org, workspace: SCOPE.workspace, agent_id: "default" },
		});

		const processed = await worker.runOnce();
		expect(processed).toBe(true);
		// The retention sweep completed the job (it ran its ordered steps — decay/graph_links/…
		// — against the backend and returned; the worker marked it done).
		const done = backend.jobs.filter((r) => String(r.id) === id).sort((a, b) => Number(b.version) - Number(a.version))[0];
		expect(done?.status).toBe("done");
		queue.stop();
	});

	it("a stage error fails the job (dead-letters) and never crashes the worker (a-AC-5)", async () => {
		const backend = new FakeBackend();
		const storage = makeStorage(backend);
		// max_attempts=1 so the first failure walks the job straight to `dead` (dead-letter).
		const queue = createJobQueueService({ storage, scope: SCOPE, config: { owner: "pipeline-C", maxAttempts: 1 } });
		await queue.start();

		// A worker whose decision handler THROWS (a genuine stage failure, e.g. a storage outage
		// the handler could not absorb). We build a minimal handler set with a throwing decision.
		const config = enabledConfig();
		const model = createFakeModelClient({});
		const handlers = createPipelineHandlers({ extraction: { config, model } });
		handlers.memory_decision = async () => {
			throw new Error("simulated decision stage failure");
		};
		const worker = createStageWorker({ queue, handlers });

		const id = await queue.enqueue({ kind: "memory_decision", payload: { org: SCOPE.org, workspace: SCOPE.workspace } });

		// The worker does NOT throw out of runOnce — it routes the throw to queue.fail.
		const processed = await worker.runOnce();
		expect(processed).toBe(true);

		const current = backend.jobs.filter((r) => String(r.id) === id).sort((a, b) => Number(b.version) - Number(a.version))[0];
		expect(current?.status).toBe("dead"); // dead-lettered per the queue contract (a-AC-5).

		// The worker is still usable after the failure (it never crashed): another runOnce is a no-op.
		expect(await worker.runOnce()).toBe(false);
		queue.stop();
	});
});
