/**
 * PRD-009a Dreaming Token-Budget Trigger — a-AC-1..6 (Wave 1).
 *
 * Verification posture (EXECUTION_LEDGER-prd-009 / dreaming CONVENTIONS):
 *   - All assertions run against a STATEFUL fake DeepLake transport that models the
 *     `dreaming_state` table's append-only version-bump semantics in memory (INSERT
 *     appends a version row; the highest-version row for an (id, agent_id) is the
 *     current state). No live network. No `.skip` / `.only`; `vitest run` is CI.
 *   - The job queue is a FAKE recording `enqueue` calls (a-AC-2/a-AC-3).
 *   - Each `describe` is named after the AC it proves (one-to-one ledger map).
 *
 * a-AC-1 session-summary write → counter += token count.
 * a-AC-2 threshold + tick → exactly one job enqueued + counter resets (SUBTRACT).
 * a-AC-3 pass pending → no 2nd job until terminal.
 * a-AC-4 disabled → counter still grows, no job queued.
 * a-AC-5 daemon restart → counter reflects all committed writes (durable highest-version).
 * a-AC-6 two agent_ids → independent counters.
 */

import { describe, expect, it } from "vitest";

import { createStorageClient, type QueryScope, type StorageQuery } from "../../../../src/daemon/storage/index.js";
import type { StorageRow } from "../../../../src/daemon/storage/result.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";
import { DreamingConfigSchema, type DreamingConfig } from "../../../../src/daemon/runtime/dreaming/config.js";
import {
	createDreamingTrigger,
	dreamingStateId,
	type DreamingJobEnqueuer,
	type DreamingScope,
} from "../../../../src/daemon/runtime/dreaming/trigger.js";
import { DREAMING_JOB_KIND, parseDreamingJobPayload } from "../../../../src/daemon/runtime/dreaming/contracts.js";

const SCOPE: QueryScope = { org: "test-org", workspace: "test-ws" };

function config(overrides: Partial<DreamingConfig> = {}): DreamingConfig {
	return DreamingConfigSchema.parse({ enabled: true, tokenThreshold: 100, ...overrides });
}

// ── A stateful in-memory dreaming_state store + responder ─────────────────────

interface StoredRow {
	id: string;
	agent_id: string;
	tokens_since_last_pass: number;
	last_pass_at: string;
	pending_job_id: string;
	version: number;
}

/**
 * Models the `dreaming_state` append-only table in memory. An INSERT appends a row;
 * a `SELECT ... ORDER BY version DESC LIMIT 1` returns the highest-version row for the
 * matched (id, agent_id). This is the byte-shape the trigger's `appendVersionBumped`
 * (MAX-version read + INSERT N+1) and `readState` (highest-version read) issue.
 */
class DreamingStore {
	readonly rows: StoredRow[] = [];

	responder(): (req: TransportRequest) => StorageRow[] {
		return (req) => this.handle(req.sql);
	}

	private handle(sql: string): StorageRow[] {
		const s = sql.trim();
		if (/^INSERT/i.test(s)) {
			this.applyInsert(s);
			return [];
		}
		if (/^SELECT/i.test(s)) {
			return this.applySelect(s);
		}
		// Heal introspection / other — answer empty (the table "exists").
		return [];
	}

	/** Parse the `INSERT ... (cols) VALUES (vals)` the writes.ts builder emits. */
	private applyInsert(sql: string): void {
		const m = sql.match(/\(([^)]*)\)\s*VALUES\s*\((.*)\)\s*$/is);
		if (!m) return;
		const cols = m[1].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
		const vals = splitTopLevel(m[2]);
		const get = (name: string): string => {
			const i = cols.indexOf(name);
			return i === -1 ? "" : unquote(vals[i]);
		};
		this.rows.push({
			id: get("id"),
			agent_id: get("agent_id"),
			tokens_since_last_pass: Number(get("tokens_since_last_pass")) || 0,
			last_pass_at: get("last_pass_at"),
			pending_job_id: get("pending_job_id"),
			version: Number(get("version")) || 1,
		});
	}

	/** Return the highest-version row matching the id (+ agent_id when present). */
	private applySelect(sql: string): StorageRow[] {
		const id = matchLiteral(sql, /id"?\s*=\s*'([^']*)'/i);
		const agent = matchLiteral(sql, /agent_id"?\s*=\s*'([^']*)'/i);
		let candidates = this.rows.filter((r) => r.id === id);
		if (agent !== null) candidates = candidates.filter((r) => r.agent_id === agent);
		if (candidates.length === 0) return [];
		const top = candidates.reduce((a, b) => (b.version > a.version ? b : a));
		return [{ ...top } as StorageRow];
	}
}

/** Split a VALUES list on top-level commas (ignores commas inside quotes). */
function splitTopLevel(s: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let inStr = false;
	let cur = "";
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (inStr) {
			cur += ch;
			if (ch === "'" && s[i + 1] !== "'") inStr = false;
			else if (ch === "'" && s[i + 1] === "'") {
				cur += s[++i];
			}
			continue;
		}
		if (ch === "'") {
			inStr = true;
			cur += ch;
		} else if (ch === "(") {
			depth++;
			cur += ch;
		} else if (ch === ")") {
			depth--;
			cur += ch;
		} else if (ch === "," && depth === 0) {
			out.push(cur.trim());
			cur = "";
		} else cur += ch;
	}
	if (cur.trim() !== "") out.push(cur.trim());
	return out;
}

/** Unwrap a `'...'` / `E'...'` literal to its inner text (un-doubling quotes); numbers pass through. */
function unquote(v: string): string {
	const t = v.trim().replace(/^E'/i, "'");
	if (t.startsWith("'") && t.endsWith("'")) {
		return t.slice(1, -1).replace(/''/g, "'");
	}
	return t;
}

function matchLiteral(sql: string, re: RegExp): string | null {
	const m = sql.match(re);
	return m ? m[1] : null;
}

// ── A fake job queue recording enqueues ───────────────────────────────────────

class FakeQueue implements DreamingJobEnqueuer {
	readonly calls: { kind: string; payload: Record<string, unknown> }[] = [];
	private seq = 0;
	async enqueue(job: { kind: string; payload: Record<string, unknown> }): Promise<string> {
		this.calls.push(job);
		this.seq += 1;
		return `job-${this.seq}`;
	}
}

function storageOf(store: DreamingStore): StorageQuery {
	const transport = new FakeDeepLakeTransport(store.responder());
	return createStorageClient({ provider: stubProvider(fakeCredentialRecord()), transport });
}

const AGENT: DreamingScope = { agentId: "agent-alpha" };

// ═════════════════════════════════════════════════════════════════════════════
// a-AC-1 — increment by the summary's token count
// ═════════════════════════════════════════════════════════════════════════════

describe("a-AC-1 session-summary write increments tokens_since_last_pass by the token count", () => {
	it("two increments accumulate the running token count (append-only)", async () => {
		const store = new DreamingStore();
		const trigger = createDreamingTrigger({
			storage: storageOf(store),
			scope: SCOPE,
			config: config(),
			enqueuer: new FakeQueue(),
		});

		expect(await trigger.incrementDreamingCounter(AGENT, 30)).toBe(30);
		expect(await trigger.incrementDreamingCounter(AGENT, 12)).toBe(42);

		const state = await trigger.readState(AGENT);
		expect(state.tokensSinceLastPass).toBe(42);
		// append-only: each increment is a NEW version, never an in-place UPDATE.
		expect(store.rows.length).toBe(2);
		expect(store.rows.map((r) => r.version)).toEqual([1, 2]);
	});

	it("a negative/garbage token count floors to 0 (a summary never decrements)", async () => {
		const store = new DreamingStore();
		const trigger = createDreamingTrigger({
			storage: storageOf(store),
			scope: SCOPE,
			config: config(),
			enqueuer: new FakeQueue(),
		});
		await trigger.incrementDreamingCounter(AGENT, 50);
		expect(await trigger.incrementDreamingCounter(AGENT, -999)).toBe(50);
		expect(await trigger.incrementDreamingCounter(AGENT, Number.NaN)).toBe(50);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// a-AC-2 — threshold + tick → exactly one job + reset SUBTRACTS the threshold
// ═════════════════════════════════════════════════════════════════════════════

describe("a-AC-2 threshold crossed → exactly one dreaming job enqueued + counter resets (SUBTRACT)", () => {
	it("enqueues one job, records pending_job_id, and SUBTRACTS the threshold (not hard-zero)", async () => {
		const store = new DreamingStore();
		const queue = new FakeQueue();
		const trigger = createDreamingTrigger({
			storage: storageOf(store),
			scope: SCOPE,
			config: config({ tokenThreshold: 100 }),
			enqueuer: queue,
		});

		// Push the counter to 130 (over the 100 threshold).
		await trigger.incrementDreamingCounter(AGENT, 130);

		const result = await trigger.checkAndEnqueueDreaming(AGENT);
		expect(result.decision).toBe("enqueued");
		expect(result.jobId).toBe("job-1");

		// Exactly one enqueue, of the dreaming kind, carrying the mode + agent scope.
		expect(queue.calls).toHaveLength(1);
		expect(queue.calls[0].kind).toBe(DREAMING_JOB_KIND);
		const payload = parseDreamingJobPayload(queue.calls[0].payload);
		expect(payload?.mode).toBe("incremental");
		expect(payload?.agentId).toBe("agent-alpha");

		// Reset SUBTRACTS the threshold: 130 - 100 = 30 (NOT zero — FR-5).
		const state = await trigger.readState(AGENT);
		expect(state.tokensSinceLastPass).toBe(30);
		expect(state.pendingJobId).toBe("job-1");
	});

	it("a summary write between the threshold read and the reset is not lost (SUBTRACT carries overflow)", async () => {
		const store = new DreamingStore();
		const queue = new FakeQueue();
		const trigger = createDreamingTrigger({
			storage: storageOf(store),
			scope: SCOPE,
			config: config({ tokenThreshold: 100 }),
			enqueuer: queue,
		});
		// 250 accumulated → enqueue subtracts 100 → 150 carried toward the next pass.
		await trigger.incrementDreamingCounter(AGENT, 250);
		await trigger.checkAndEnqueueDreaming(AGENT);
		expect((await trigger.readState(AGENT)).tokensSinceLastPass).toBe(150);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// a-AC-3 — pass pending → no 2nd job until terminal
// ═════════════════════════════════════════════════════════════════════════════

describe("a-AC-3 a pending pass blocks a second enqueue until the prior job is terminal", () => {
	it("a second tick at threshold enqueues NOTHING while a job is pending", async () => {
		const store = new DreamingStore();
		const queue = new FakeQueue();
		const trigger = createDreamingTrigger({
			storage: storageOf(store),
			scope: SCOPE,
			config: config({ tokenThreshold: 100 }),
			enqueuer: queue,
			// default pendingTerminal → never terminal.
		});

		await trigger.incrementDreamingCounter(AGENT, 130);
		await trigger.checkAndEnqueueDreaming(AGENT); // enqueues job-1, pending set.

		// More summaries push back over threshold, but a pass is pending.
		await trigger.incrementDreamingCounter(AGENT, 200);
		const second = await trigger.checkAndEnqueueDreaming(AGENT);

		expect(second.decision).toBe("skipped");
		expect(second.reason).toBe("pending");
		expect(queue.calls).toHaveLength(1); // STILL exactly one enqueue.
	});

	it("once the pending job is terminal, the guard clears and a later tick can enqueue again", async () => {
		const store = new DreamingStore();
		const queue = new FakeQueue();
		let terminal = false;
		const trigger = createDreamingTrigger({
			storage: storageOf(store),
			scope: SCOPE,
			config: config({ tokenThreshold: 100 }),
			enqueuer: queue,
			pendingTerminal: () => Promise.resolve(terminal),
		});

		await trigger.incrementDreamingCounter(AGENT, 130);
		await trigger.checkAndEnqueueDreaming(AGENT); // job-1.

		// The prior job reaches a terminal state; first tick CLEARS the guard.
		terminal = true;
		const cleared = await trigger.checkAndEnqueueDreaming(AGENT);
		expect(cleared.decision).toBe("skipped");
		expect(cleared.reason).toBe("pending-cleared");
		expect((await trigger.readState(AGENT)).pendingJobId).toBe("");

		// Counter (30 after the first reset) is below threshold; push it over + tick again.
		await trigger.incrementDreamingCounter(AGENT, 100);
		const again = await trigger.checkAndEnqueueDreaming(AGENT);
		expect(again.decision).toBe("enqueued");
		expect(queue.calls).toHaveLength(2);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// a-AC-4 — disabled → counter grows, no job queued
// ═════════════════════════════════════════════════════════════════════════════

describe("a-AC-4 dreaming.enabled false → counter still grows but no job is enqueued", () => {
	it("increments past the threshold but a tick enqueues nothing", async () => {
		const store = new DreamingStore();
		const queue = new FakeQueue();
		const trigger = createDreamingTrigger({
			storage: storageOf(store),
			scope: SCOPE,
			config: config({ enabled: false, tokenThreshold: 100 }),
			enqueuer: queue,
		});

		await trigger.incrementDreamingCounter(AGENT, 500); // well over threshold.
		const result = await trigger.checkAndEnqueueDreaming(AGENT);

		expect(result.decision).toBe("disabled");
		expect(queue.calls).toHaveLength(0);
		// Counter is preserved so re-enabling resumes from the accrued total.
		expect((await trigger.readState(AGENT)).tokensSinceLastPass).toBe(500);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// a-AC-5 — durable across restart (highest-version read of committed writes)
// ═════════════════════════════════════════════════════════════════════════════

describe("a-AC-5 a daemon restart reads back the counter from committed writes (durable)", () => {
	it("a fresh trigger over the SAME store reads the accumulated counter", async () => {
		const store = new DreamingStore();
		const t1 = createDreamingTrigger({
			storage: storageOf(store),
			scope: SCOPE,
			config: config(),
			enqueuer: new FakeQueue(),
		});
		await t1.incrementDreamingCounter(AGENT, 40);
		await t1.incrementDreamingCounter(AGENT, 35); // committed = 75 across two versions.

		// "Restart": a brand-new trigger + storage client over the SAME committed rows.
		const t2 = createDreamingTrigger({
			storage: storageOf(store),
			scope: SCOPE,
			config: config(),
			enqueuer: new FakeQueue(),
		});
		expect((await t2.readState(AGENT)).tokensSinceLastPass).toBe(75);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// a-AC-6 — two agent_ids → independent counters
// ═════════════════════════════════════════════════════════════════════════════

describe("a-AC-6 two agent_ids under one workspace accumulate independent counters", () => {
	it("each agent's counter is isolated by the agent_id ring + a distinct row id", async () => {
		const store = new DreamingStore();
		const trigger = createDreamingTrigger({
			storage: storageOf(store),
			scope: SCOPE,
			config: config(),
			enqueuer: new FakeQueue(),
		});
		const alpha: DreamingScope = { agentId: "agent-alpha" };
		const beta: DreamingScope = { agentId: "agent-beta" };

		await trigger.incrementDreamingCounter(alpha, 100);
		await trigger.incrementDreamingCounter(beta, 7);

		expect((await trigger.readState(alpha)).tokensSinceLastPass).toBe(100);
		expect((await trigger.readState(beta)).tokensSinceLastPass).toBe(7);
		// Distinct deterministic ids (a-AC-6).
		expect(dreamingStateId(alpha)).not.toBe(dreamingStateId(beta));
	});
});
