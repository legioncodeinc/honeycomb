/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  PRD-045f f-AC-2 — the daemon-resident SKILLIFY WORKER, end to end.        ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  f-AC-2 (the wiring proof PRD-016 left open): a `skillify` job ENQUEUED     ║
 * ║  by capture (session-end / turn-counter) is LEASED by a worker, MINED      ║
 * ║  (gate → KEEP), and lands as an APPEND-ONLY `skills` row READABLE via the   ║
 * ║  SAME highest-version-per-id read `/api/skills` serves (`fetchSkills`).    ║
 * ║  Before 045f no worker leased `["skillify"]`, so the job piled up           ║
 * ║  unprocessed and `/api/skills` stayed empty.                              ║
 * ║                                                                          ║
 * ║  TWO proofs, ONE file:                                                    ║
 * ║                                                                          ║
 * ║   1. DETERMINISTIC, ALWAYS-RUN (no token, no host CLI, no DeepLake):       ║
 * ║      the REAL `createSkillifyJobWorker` over a FAKE `JobQueueService` +     ║
 * ║      injected deterministic gate/fetcher/store seams proves the WIRING:    ║
 * ║        - the worker leases ONLY `["skillify"]` — a foreign `summary` job   ║
 * ║          enqueued alongside is NEVER touched (f-AC-1);                     ║
 * ║        - a KEEP verdict APPENDS a `skills` row (provenance present);       ║
 * ║        - the row is READABLE via the highest-version read (/api/skills);   ║
 * ║        - the job is COMPLETEd, never failed.                               ║
 * ║      This is the host-here proof (no DeepLake token in this environment).  ║
 * ║                                                                          ║
 * ║   2. TOKEN-GATED LIVE (opt-in, real backend, modeled on                    ║
 * ║      skills-write-live.itest): the REAL durable `JobQueueService` over a   ║
 * ║      throwaway `ci_memory_jobs_<run>` table + the REAL `createSkillStore`  ║
 * ║      over a throwaway `ci_skills_<run>` table + the REAL worker, only the  ║
 * ║      GATE faked KEEP (a live host-CLI gate is non-deterministic + absent   ║
 * ║      in CI). Enqueue → `runOnce()` → the append-only row lands + reads     ║
 * ║      back as current. `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)`.        ║
 * ║                                                                          ║
 * ║  `.itest.ts` keeps BOTH suites out of `npm run test` / `npm run ci`; only  ║
 * ║  `npm run test:integration` runs them.                                    ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { QueryScope, StorageQuery } from "../../src/daemon/storage/client.js";
import {
	createStorageClient,
	envCredentialProvider,
	isOk,
	resolveStorageConfig,
	sqlIdent,
	type StorageClient,
} from "../../src/daemon/storage/index.js";
import {
	createJobQueueService,
	type JobInput,
	type JobQueueService,
	type LeasedJob,
} from "../../src/daemon/runtime/services/job-queue.js";
import {
	createFakeGateCli,
	createSkillStore,
	createWatermarkStore,
	type GateVerdict,
	type SessionFetcher,
	type SessionRow,
	type Skill,
	type SkillStore,
	skillLogicalId,
} from "../../src/daemon/runtime/skillify/index.js";
import { createSkillifyJobWorker } from "../../src/daemon/runtime/skillify/worker.js";
import { neutralizeIfInfraDegraded } from "./_infra-skip.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);
const SCOPE: QueryScope = { org: "o-skf", workspace: "ws-skf" };

/** A KEEP verdict the faked gate returns — drives the append-only write. */
function keepVerdict(): GateVerdict {
	return {
		decision: "KEEP",
		name: "ci-mined-skill",
		body: "## Mined\nReuse this workflow.",
		description: "a mined ci skill",
		triggerText: "when the ci flow recurs",
	};
}

/** The skillify-cue payload capture enqueues (turn-counters' `MemoryCue` shape). */
function skillifyJob(sessionId: string, path: string): JobInput {
	return { kind: "skillify", payload: { sessionId, path, count: 5 } };
}

/** A `sessions`-row envelope (the verbatim `{ event, metadata }` JSONB). */
function row(path: string, session: string, kind: string, text: string, date: string): SessionRow {
	return {
		path,
		sessionId: session,
		message: JSON.stringify({ event: { kind, text }, metadata: { sessionId: session, path } }),
		author: "alice",
		creationDate: date,
	};
}

/** Six rows = three prompt/answer pairs, clearing the KEEP ≥3-exchange floor. */
function sixPairs(path: string, session: string): readonly SessionRow[] {
	return [
		row(path, session, "user_message", "how do I retry?", "2026-01-01T00:00:00Z"),
		row(path, session, "assistant_message", "wrap it in withRetry()", "2026-01-01T00:00:01Z"),
		row(path, session, "user_message", "and the backoff?", "2026-01-01T00:00:02Z"),
		row(path, session, "assistant_message", "exponential, capped", "2026-01-01T00:00:03Z"),
		row(path, session, "user_message", "where do I put it?", "2026-01-01T00:00:04Z"),
		row(path, session, "assistant_message", "the storage client wrapper", "2026-01-01T00:00:05Z"),
	];
}

/** A fetcher returning canned rows (the mine extracts pairs from these). */
function fakeFetcher(rows: readonly SessionRow[]): SessionFetcher {
	return { fetch: async (): Promise<readonly SessionRow[]> => rows };
}

/** A storage stub that should never be hit when all three worker seams are overridden. */
const UNUSED_STORAGE: StorageQuery = {
	query: async () => {
		throw new Error("storage must not be touched when fetcher/store are overridden");
	},
};

// ════════════════════════════════════════════════════════════════════════════
// PROOF 1 — DETERMINISTIC, ALWAYS-RUN: the REAL worker over fake queue/store/gate.
// ════════════════════════════════════════════════════════════════════════════

/** A recording fake queue: enqueue → kind-filtered lease → complete/fail (in-memory). */
function fakeQueue(): JobQueueService & {
	readonly completed: string[];
	readonly failed: { id: string; reason: string }[];
} {
	const jobs = new Map<string, { job: LeasedJob; status: "queued" | "leased" }>();
	const completed: string[] = [];
	const failed: { id: string; reason: string }[] = [];
	let seq = 0;
	return {
		completed,
		failed,
		async enqueue(job: JobInput): Promise<string> {
			const id = `fake-job-${++seq}`;
			jobs.set(id, { job: { id, kind: job.kind, payload: job.payload, attempt: 1 }, status: "queued" });
			return id;
		},
		async lease(kinds?: readonly string[]): Promise<LeasedJob | null> {
			for (const [, entry] of jobs) {
				if (entry.status !== "queued") continue;
				// The kind filter IS the f-AC-1 guarantee — a foreign kind is NEVER leased here.
				if (kinds !== undefined && !kinds.includes(entry.job.kind)) continue;
				entry.status = "leased";
				return entry.job;
			}
			return null;
		},
		async complete(id: string): Promise<void> {
			completed.push(id);
		},
		async fail(id: string, reason: string): Promise<void> {
			failed.push({ id, reason });
		},
		start(): void {},
		stop(): void {},
	};
}

/** An in-memory append-only skill store mirroring `createSkillStore`'s contract. */
function fakeSkillStore(): SkillStore & { readonly rows: Skill[] } {
	const rows: Skill[] = [];
	return {
		rows,
		async maxVersion(id: string): Promise<number> {
			return rows.filter((s) => s.id === id).reduce((m, s) => Math.max(m, s.provenance.version), 0);
		},
		async readActive(id: string): Promise<Skill | null> {
			const mine = rows.filter((s) => s.id === id);
			if (mine.length === 0) return null;
			return mine.reduce((a, b) => (b.provenance.version >= a.provenance.version ? b : a));
		},
		async appendVersion(skill: Skill): Promise<number> {
			rows.push(skill); // APPEND — never an in-place update.
			return skill.provenance.version;
		},
	};
}

describe("PRD-045f f-AC-2 — the skillify worker mines an enqueued job into an append-only skills row (deterministic)", () => {
	it("leases ONLY skillify (skips a foreign summary job), mines KEEP, appends a readable row, completes the job", async () => {
		const queue = fakeQueue();
		const store = fakeSkillStore();
		const tmp = mkdtempSync(join(tmpdir(), "skf-"));

		// A foreign `summary` job is enqueued ALONGSIDE the skillify job. The worker must NEVER
		// touch it (f-AC-1: lease ONLY `["skillify"]`).
		await queue.enqueue({ kind: "summary", payload: { foreign: true } });
		const skillifyId = await queue.enqueue(skillifyJob("sess-1", "proj-A"));

		const worker = createSkillifyJobWorker({
			queue,
			storage: UNUSED_STORAGE,
			scope: SCOPE,
			gateSpec: { command: "noop", args: [] },
			lock: { acquire: () => ({ release: () => {} }) },
			watermark: createWatermarkStore(join(tmp, "wm")),
			installDirs: { projectDir: join(tmp, "proj"), globalDir: join(tmp, "home") },
			author: "alice",
			gateOverride: createFakeGateCli(keepVerdict()),
			fetcherOverride: fakeFetcher(sixPairs("proj-A", "sess-1")),
			storeOverride: store,
		});

		const processed = await worker.runOnce();
		expect(processed, "a job was processed").toBe(true);

		// The skillify job was COMPLETEd (never failed).
		expect(queue.completed).toContain(skillifyId);
		expect(queue.failed).toHaveLength(0);

		// The foreign summary job was NEVER leased/touched (f-AC-1): a second runOnce finds
		// nothing leasable because the worker leases ONLY skillify.
		const second = await worker.runOnce();
		expect(second, "the foreign summary job is left untouched").toBe(false);

		// A KEEP appended exactly one provenance-carrying skills row (b-AC-1 / f-AC-2).
		expect(store.rows).toHaveLength(1);
		const id = skillLogicalId("ci-mined-skill", "alice");
		const active = await store.readActive(id);
		expect(active, "the mined row is readable via the highest-version read (/api/skills)").not.toBeNull();
		expect(active?.provenance.version).toBe(1);
		expect(active?.provenance.sourceSessions).toContain("sess-1");
	});

	it("fail-soft (f-AC-4): a gate error FAILS the job, never throws past runOnce / crashes the worker", async () => {
		const queue = fakeQueue();
		const store = fakeSkillStore();
		const tmp = mkdtempSync(join(tmpdir(), "skf-err-"));
		const id = await queue.enqueue(skillifyJob("sess-err", "proj-err"));

		// A gate that throws (a model/CLI error). It must route to queue.fail, not crash.
		const throwingGate = {
			run: async (): Promise<GateVerdict> => {
				throw new Error("gate model unavailable");
			},
		};

		const worker = createSkillifyJobWorker({
			queue,
			storage: UNUSED_STORAGE,
			scope: SCOPE,
			gateSpec: { command: "noop", args: [] },
			lock: { acquire: () => ({ release: () => {} }) },
			watermark: createWatermarkStore(join(tmp, "wm")),
			installDirs: { projectDir: join(tmp, "proj"), globalDir: join(tmp, "home") },
			author: "alice",
			gateOverride: throwingGate,
			fetcherOverride: fakeFetcher(sixPairs("proj-err", "sess-err")),
			storeOverride: store,
		});

		// runOnce RESOLVES (does not reject) — the daemon is never crashed (f-AC-4).
		const processed = await worker.runOnce();
		expect(processed).toBe(true);
		// The job was FAILED with the gate's reason; no skill row was written.
		expect(queue.failed.map((f) => f.id)).toContain(id);
		expect(queue.failed[0]?.reason).toMatch(/gate model unavailable/);
		expect(store.rows).toHaveLength(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// PROOF 2 — TOKEN-GATED LIVE: real queue + real store + real worker, gate faked.
// ════════════════════════════════════════════════════════════════════════════

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}
const RUN_ID = runId();
const TBL_JOBS = `ci_memory_jobs_${RUN_ID}`;
const TBL_SKILLS = `ci_skills_${RUN_ID}`;

describe.skipIf(!HAS_TOKEN)("live skillify worker smoke (opt-in, real backend): enqueue → mine → append-only row → readable", () => {
	let storage: StorageClient;
	let scope: QueryScope;

	beforeAll(() => {
		const raw = envCredentialProvider().read();
		const provider = {
			read: () => ({
				...raw,
				workspace: process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "honeycomb_ci",
				queryTimeoutMs: 120_000,
			}),
		};
		const config = resolveStorageConfig(provider);
		scope = { org: config.org, workspace: config.workspace };
		storage = createStorageClient({ provider });
	});

	afterAll(async () => {
		if (!storage) return;
		for (const tbl of [TBL_JOBS, TBL_SKILLS]) {
			const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(tbl)}"`, scope);
			if (!isOk(res)) console.warn(`[ci-cleanup] could not drop ${tbl}: ${JSON.stringify(res)}`);
		}
	});

	it("the worker leases the enqueued skillify job, mines KEEP, and the row reads back as current", async ({ skip }) => {
		await neutralizeIfInfraDegraded("skillify-worker-live:preflight", () => storage.connect(scope), skip);

		// REAL durable queue over a throwaway memory_jobs table.
		const queue = createJobQueueService({ storage, scope, config: { tableName: TBL_JOBS } });
		await queue.start();
		try {
			// REAL append-only skill store over a throwaway skills table (native heal-create isolation).
			const resolveTable = (canonical: string): string => (canonical === "skills" ? TBL_SKILLS : canonical);
			const store = createSkillStore(storage, scope, resolveTable);

			const tmp = mkdtempSync(join(tmpdir(), "skf-live-"));

			const worker = createSkillifyJobWorker({
				queue,
				storage,
				scope,
				gateSpec: { command: "noop", args: [] },
				lock: { acquire: () => ({ release: () => {} }) },
				watermark: createWatermarkStore(join(tmp, "wm")),
				installDirs: { projectDir: join(tmp, "proj"), globalDir: join(tmp, "home") },
				author: "alice",
				gateOverride: createFakeGateCli(keepVerdict()),
				fetcherOverride: fakeFetcher(sixPairs("proj-live", "sess-live")),
				storeOverride: store,
			});

			// ENQUEUE the same skillify cue capture enqueues at session-end.
			await queue.enqueue(skillifyJob("sess-live", "proj-live"));

			// Drive the lease+mine+write once (the deterministic unit a test asserts against).
			const processed = await worker.runOnce();
			expect(processed, "the worker leased + processed the skillify job").toBe(true);

			// READABLE via the SAME highest-version-per-id read /api/skills serves (the store's
			// readActive uses the identical resolve shape `fetchSkills` builds, pointed at the
			// throwaway table by the resolveTable seam so the real `skills` table is untouched).
			const id = skillLogicalId("ci-mined-skill", "alice");
			const active = await store.readActive(id);
			expect(active, "the mined skill row landed + reads back as current").not.toBeNull();
			expect(active?.provenance.version).toBe(1);
		} finally {
			// Stop the queue's reaper/poll timers even if an assertion above throws — a leaked
			// queue keeps a live interval open and can hang the test runner's teardown.
			queue.stop();
		}
	});
});
