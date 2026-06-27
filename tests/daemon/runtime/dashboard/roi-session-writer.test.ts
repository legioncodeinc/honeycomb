/**
 * PRD-060e / PRD-060f — the per-session ROI-metric WRITE call-site (module AC-11 / f-AC-2 in
 * practice). Proves the writer fires ONCE at summary/skillify completion with INTEGER-cents fields
 * and the gated/resolved identity columns (`user_id` stays '' with no env/OS fallback; `team_id`
 * resolved at write time), writes `cost_basis: 'none'` (the documented honest unallocated option),
 * and is FAIL-SOFT (never throws, so it never blocks completion). Also proves the skillify worker
 * fires it exactly once on a successful run.
 */

import { describe, expect, it } from "vitest";

import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import type { QueryScope } from "../../../../src/daemon/storage/client.js";
import { createRoiSessionWriter } from "../../../../src/daemon/runtime/dashboard/roi-session-writer.js";
import { createSkillifyJobWorker } from "../../../../src/daemon/runtime/skillify/worker.js";
import {
	createFakeGateCli,
	type GateVerdict,
	type SessionFetcher,
	type SessionRow,
	type Skill,
	type SkillStore,
} from "../../../../src/daemon/runtime/skillify/index.js";
import type {
	RoiSessionWriter,
	RoiSessionWriteInput,
} from "../../../../src/daemon/runtime/dashboard/roi-session-writer.js";
import {
	type JobInput,
	type JobQueueService,
	type LeasedJob,
} from "../../../../src/daemon/runtime/services/job-queue.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const SCOPE: QueryScope = { org: "o1", workspace: "ws1" };
const CLOCK = { now: () => Date.parse("2026-06-26T12:00:00Z") };

function client(transport: FakeDeepLakeTransport) {
	return createStorageClient({ transport, provider: stubProvider(fakeCredentialRecord()) });
}

/** A transport that answers the session-turns SELECT with canned token rows + the team lookup + INSERT. */
function writeTransport(turnRows: Record<string, unknown>[], teamRow: Record<string, unknown>[] = []) {
	return new FakeDeepLakeTransport((req: TransportRequest) => {
		if (/FROM\s+"sessions"/i.test(req.sql)) return turnRows;
		if (/SELECT team_id FROM "teams"/i.test(req.sql)) return teamRow;
		return []; // INSERT INTO "roi_metrics" ok.
	});
}

describe("PRD-060e/060f per-session ROI writer (the summary/skillify completion call-site)", () => {
	// ── module AC-11: the write fires once with integer-cents fields + gated/resolved identity ─────
	it("appends ONE roi_metrics row with integer-cents measured savings, user_id gated to '', team_id resolved", async () => {
		// Two turns with a measured cache-read → a real, billed savings figure (integer cents).
		const fake = writeTransport(
			[
				{ input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 4000, cache_creation_input_tokens: 0, source_tool: "claude-code" },
				{ input_tokens: 800, output_tokens: 400, cache_read_input_tokens: 2000, cache_creation_input_tokens: 0, source_tool: "claude-code" },
			],
			[{ team_id: "team-alpha" }], // the roster resolves a team for the writing agent.
		);
		const writer = createRoiSessionWriter({ storage: client(fake), scope: SCOPE, clock: CLOCK });
		await writer.writeForSession({ sessionId: "sess-1", path: "conv/sess-1", agentId: "agent-A", projectId: "proj-X" });

		// Exactly ONE INSERT into roi_metrics (one immutable row per session).
		const inserts = fake.requests.filter((r) => /^INSERT INTO "roi_metrics"/.test(r.sql));
		expect(inserts).toHaveLength(1);
		const sql = inserts[0].sql;

		// The money columns are present and INTEGER cents — the VALUES tuple carries NO float literal.
		expect(sql).toMatch(/measured_cache_savings_cents/);
		const values = sql.slice(sql.indexOf("VALUES"));
		const floats = values.match(/(?<![\w'])-?\d+\.\d+(?![\w'])/g) ?? [];
		expect(floats, "money is integer cents (no float literal)").toHaveLength(0);

		// IDENTITY: user_id is GATED to '' (no verified claim → no person identity; never $USER/git-email).
		expect(sql).toMatch(/user_id/);
		// team_id resolved at write time (the roster returned team-alpha).
		expect(sql).toMatch(/'team-alpha'/);
		// cost_basis is the honest UNallocated 'none' (no per-session infra share fabricated).
		expect(sql).toMatch(/'none'/);
		// org/workspace identity columns stamped from the scope (tenant-scoped, queryable).
		expect(sql).toMatch(/'o1'/);
		expect(sql).toMatch(/'ws1'/);
	});

	// ── transcript-model fix: the ledger WRITE prices at the captured model's rate, not Sonnet ────
	it("prices the ledger row at the captured model's rate (Opus), not the Sonnet default", async () => {
		// One Opus turn with 1,000,000 cache-read tokens. The write path now reads `sessions.model` and
		// resolves the per-turn rate (parity with the dashboard read path), so the shared ledger is NOT
		// underpriced for Opus sessions.
		const fake = writeTransport([
			{ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1_000_000, cache_creation_input_tokens: 0, source_tool: "claude-code", model: "claude-opus-4-8" },
		]);
		const writer = createRoiSessionWriter({ storage: client(fake), scope: SCOPE, clock: CLOCK });
		await writer.writeForSession({ sessionId: "sess-opus", path: "conv/sess-opus", agentId: "agent-A" });
		const sql = fake.requests.find((r) => /^INSERT INTO "roi_metrics"/.test(r.sql))?.sql ?? "";
		const values = sql.slice(sql.indexOf("VALUES"));
		// 1,000,000 × (Opus input 1500 − cache-read 150)/1e6 = 1350 cents (the OPUS rate). At the Sonnet
		// default it would be 270 — so finding 1350 proves the captured model gated the rate.
		expect(values, "the row is priced at the Opus rate (1350c), not the Sonnet default (270c)").toMatch(/\b1350\b/);
	});

	// ── absent capture → measured savings is 0 (status absent upstream), still one honest row ─────
	it("a session with absent (NULL) token columns writes measured savings 0 — never a fabricated figure", async () => {
		const fake = writeTransport([
			{ input_tokens: null, output_tokens: null, cache_read_input_tokens: null, cache_creation_input_tokens: null, source_tool: "claude-code" },
		]);
		const writer = createRoiSessionWriter({ storage: client(fake), scope: SCOPE, clock: CLOCK });
		await writer.writeForSession({ sessionId: "sess-2", path: "conv/sess-2", agentId: "agent-A" });
		const insert = fake.requests.find((r) => /^INSERT INTO "roi_metrics"/.test(r.sql))?.sql ?? "";
		// One row is still written (honest), with a 0 measured figure (NULL counts contributed nothing).
		expect(insert).toMatch(/^INSERT INTO "roi_metrics"/);
		// The numeric VALUES (the integer-cents + token columns) are bare integers — no float-cents.
		// (We inspect the VALUES tuple, NOT the ISO `created_at` whose `.000Z` is not a money field.)
		const values = insert.slice(insert.indexOf("VALUES"));
		const numericLiterals = values.match(/(?<![\w'])-?\d+\.\d+(?![\w'])/g) ?? [];
		expect(numericLiterals, "no float numeric literal (money is integer cents)").toHaveLength(0);
	});

	// ── FAIL-SOFT: a storage throw never propagates out of the writer (never blocks completion) ───
	it("is fail-soft: a thrown storage error never propagates (the skillify job is never blocked)", async () => {
		const throwing = new FakeDeepLakeTransport(() => {
			throw new Error("deeplake flap");
		});
		const writer = createRoiSessionWriter({ storage: client(throwing), scope: SCOPE, clock: CLOCK });
		// Resolves (does not reject) — the write degraded silently.
		await expect(writer.writeForSession({ sessionId: "s", path: "p", agentId: "a" })).resolves.toBeUndefined();
	});

	// ── blank session key → skip (never an unscoped read of the whole table) ──────────────────────
	it("skips the write when there is no session key (never reads the whole table unscoped)", async () => {
		const fake = new FakeDeepLakeTransport(() => []);
		const writer = createRoiSessionWriter({ storage: client(fake), scope: SCOPE, clock: CLOCK });
		await writer.writeForSession({ sessionId: "", path: "", agentId: "a" });
		// No session read and no INSERT — the writer skipped cleanly.
		expect(fake.requests.filter((r) => /^INSERT INTO "roi_metrics"/.test(r.sql))).toHaveLength(0);
		expect(fake.requests.filter((r) => /FROM\s+"sessions"/i.test(r.sql))).toHaveLength(0);
	});

	// Finding (path-fallback): the turns read filters the `path` column. A BLANK path -- even with a
	// non-blank sessionId -- must SKIP + log, NEVER fall back to querying WHERE path = '<sessionId>'.
	it("skips (logs roi.write.skipped) when path is blank even if sessionId is present -- never an unscoped read", async () => {
		const events: { name: string; fields?: Record<string, unknown> }[] = [];
		const fake = new FakeDeepLakeTransport(() => []);
		const writer = createRoiSessionWriter({
			storage: client(fake),
			scope: SCOPE,
			clock: CLOCK,
			logger: { event: (name, fields) => events.push({ name, fields }) },
		});
		// Non-blank sessionId, BLANK path.
		await writer.writeForSession({ sessionId: "sess-only", path: "", agentId: "a" });
		// NO sessions read (the writer never queried WHERE path = 'sess-only') and NO INSERT.
		expect(fake.requests.filter((r) => /FROM\s+"sessions"/i.test(r.sql))).toHaveLength(0);
		expect(fake.requests.filter((r) => /^INSERT INTO "roi_metrics"/.test(r.sql))).toHaveLength(0);
		// It logged the skip with the blank-path reason.
		const skip = events.find((e) => e.name === "roi.write.skipped");
		expect(skip, "roi.write.skipped emitted").toBeDefined();
		expect(skip?.fields?.reason).toBe("blank path");
	});

	// ── the skillify worker fires the writer EXACTLY ONCE on a successful run ──────────────────────
	it("the skillify worker fires the ROI writer once at completion (with the session's id/path/agent)", async () => {
		const calls: RoiSessionWriteInput[] = [];
		const fakeRoiWriter: RoiSessionWriter = {
			async writeForSession(input: RoiSessionWriteInput): Promise<void> {
				calls.push(input);
			},
		};

		const queue = fakeQueue();
		const store = fakeSkillStore();
		await queue.enqueue(skillifyJob("sess-W", "conv-W"));

		const worker = createSkillifyJobWorker({
			queue,
			storage: UNUSED_STORAGE,
			scope: SCOPE,
			gateSpec: { command: "noop", args: [] },
			lock: { acquire: () => ({ release: () => {} }) },
			watermark: { read: () => null, advance: () => null },
			author: "agent-A",
			gateOverride: createFakeGateCli(keepVerdict()),
			fetcherOverride: fakeFetcher(sixPairs("conv-W", "sess-W")),
			storeOverride: store,
			roiWriter: fakeRoiWriter,
		});

		const processed = await worker.runOnce();
		expect(processed).toBe(true);
		// The job completed (a successful run) and the ROI writer fired EXACTLY once for the session.
		expect(queue.completed).toHaveLength(1);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.sessionId).toBe("sess-W");
		expect(calls[0]?.path).toBe("conv-W");
		expect(calls[0]?.agentId).toBe("agent-A");
	});

	// Finding (worker-trycatch): a THROWING roiWriter must NOT fail the skillify job. The skill write +
	// watermark advance already succeeded, so the job COMPLETES and the throw is caught + logged.
	it("a throwing roiWriter does NOT fail the skillify job (the job still completes)", async () => {
		const events: string[] = [];
		const throwingRoiWriter: RoiSessionWriter = {
			async writeForSession(): Promise<void> {
				throw new Error("roi ledger flap");
			},
		};
		const queue = fakeQueue();
		const store = fakeSkillStore();
		await queue.enqueue(skillifyJob("sess-T", "conv-T"));

		const worker = createSkillifyJobWorker({
			queue,
			storage: UNUSED_STORAGE,
			scope: SCOPE,
			gateSpec: { command: "noop", args: [] },
			lock: { acquire: () => ({ release: () => {} }) },
			watermark: { read: () => null, advance: () => null },
			author: "agent-A",
			gateOverride: createFakeGateCli(keepVerdict()),
			fetcherOverride: fakeFetcher(sixPairs("conv-T", "sess-T")),
			storeOverride: store,
			roiWriter: throwingRoiWriter,
			logger: { event: (name) => events.push(name) },
		});

		const processed = await worker.runOnce();
		expect(processed).toBe(true);
		// The job COMPLETED (not failed) despite the ROI-write throw -- it was caught + logged.
		expect(queue.completed).toHaveLength(1);
		expect(queue.failed).toHaveLength(0);
		expect(events).toContain("skillify.worker.roi_write_failed");
		// The skill was still written (the real work succeeded before the ROI write).
		expect(store.rows.length).toBeGreaterThan(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Skillify-worker test doubles (mirrors tests/daemon/runtime/skillify/worker.test.ts).
// ════════════════════════════════════════════════════════════════════════════

/** A storage stub the seam-overridden worker never touches (the ROI writer is also injected). */
const UNUSED_STORAGE = {
	query: async () => {
		throw new Error("storage must not be touched when fetcher/store/roiWriter are overridden");
	},
} as never;

function keepVerdict(): GateVerdict {
	return { decision: "KEEP", name: "u", body: "## u\nbody", description: "d", triggerText: "t" };
}

function skillifyJob(sessionId: string, path: string): JobInput {
	return { kind: "skillify", payload: { sessionId, path, count: 5 } };
}

function row(path: string, session: string, kind: string, text: string, date: string): SessionRow {
	return {
		path,
		sessionId: session,
		message: JSON.stringify({ event: { kind, text }, metadata: { sessionId: session, path } }),
		author: "alice",
		creationDate: date,
	};
}

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

function fakeFetcher(rows: readonly SessionRow[]): SessionFetcher {
	return { fetch: async (): Promise<readonly SessionRow[]> => rows };
}

/** An in-memory append-only skill store mirroring `createSkillStore`'s contract (worker.test.ts parity). */
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
			rows.push(skill);
			return skill.provenance.version;
		},
	};
}

/** A recording fake queue (worker.test.ts parity): enqueue → kind-filtered lease → complete/fail. */
function fakeQueue(): JobQueueService & { readonly completed: string[]; readonly failed: { id: string; reason: string }[] } {
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
