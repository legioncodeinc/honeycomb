/**
 * PRD-080b — the controlled-write RE-DRIVE (b-AC-4 + b-AC-5 non-regression).
 *
 * Two verification layers:
 *   1. THE READER (`readTerminalControlledWriteJobs`) — reads TERMINAL (`status = failed`)
 *      `memory_controlled_write` job payloads off a REAL home-anchored `local-queue.db` (seeded via
 *      `openLocalJobQueue`), excluding non-terminal + other-kind jobs; fail-soft to `[]` when the db
 *      does not exist.
 *   2. THE ORCHESTRATOR (`runMemoryRedrive` + `redriveControlledWritePayload`) — re-runs seeded terminal
 *      job payloads through the SINGLE-SOURCED controlled-write path: a degraded window defers them into
 *      the durable outbox → the drainer commits them on recovery → the memories are present with NO
 *      duplicate on a repeat re-drive (idempotent via `content_hash`); a daemon-down / empty run reports a
 *      clean `{ redriven: 0, skipped: 0 }`; one unparseable row is skipped without aborting the others.
 *
 * `vitest run` passes `--experimental-sqlite` to the worker (vitest.config.ts), so `node:sqlite` is live.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type ControlledWriteHandlerDeps,
	redriveControlledWritePayload,
} from "../../../../src/daemon/runtime/pipeline/controlled-writes.js";
import {
	type OutboxClock,
	openMemoryOutbox,
} from "../../../../src/daemon/runtime/pipeline/memory-outbox.js";
import {
	readTerminalControlledWriteJobs,
	runMemoryRedrive,
} from "../../../../src/daemon/runtime/pipeline/memory-redrive.js";
import { PipelineConfigSchema } from "../../../../src/daemon/runtime/pipeline/config.js";
import { openLocalJobQueue } from "../../../../src/daemon/runtime/services/local-job-queue.js";
import type { EmbedClient } from "../../../../src/daemon/runtime/services/embed-client.js";
import type { QueryOptions, QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult, timeoutResult } from "../../../../src/daemon/storage/result.js";

// ── SQL shape probes (mirror memory-outbox.test) ─────────────────────────────────

function isDedupProbe(sql: string): boolean {
	return /content_hash\s*=/.test(sql);
}
/** PRD-080c: the BATCHED dedup probe the coalesced drainer issues (`content_hash IN (...)`). */
function isBatchProbe(sql: string): boolean {
	return /content_hash\s+IN\s*\(/i.test(sql);
}
function isVersionRead(sql: string): boolean {
	return /SELECT\s+version\b/i.test(sql) && /ORDER\s+BY\s+version/i.test(sql);
}
function isInsert(sql: string): boolean {
	return /INSERT\s+INTO\s+"memories"/i.test(sql);
}

const nullEmbed: EmbedClient = {
	async embed(): Promise<readonly number[] | null> {
		return null;
	},
};

/** A controllable clock so the drainer never sleeps for real. */
function fakeClock(startMs: number): OutboxClock & { advance(ms: number): void } {
	let nowMs = startMs;
	return {
		now: () => nowMs,
		setInterval: () => 1,
		clearInterval: () => {},
		advance(ms: number): void {
			nowMs += ms;
		},
	};
}

/** A monotonically-incrementing id generator so each re-driven ADD gets a DISTINCT outbox row (PK). */
function mkIdGen(): () => string {
	let n = 0;
	return () => `mem_redrive_${(n += 1)}`;
}

/**
 * A `memories` backend stub that MODELS the `content_hash` table so idempotency is real across BOTH the
 * per-row commit AND the PRD-080c coalesced drain: the dedup probe (single `content_hash = …` OR batched
 * `content_hash IN (…)`) returns a hit for every hash already committed and remembers the probed-ABSENT
 * hashes so the subsequent INSERT (single OR multi-row) commits exactly those — the same probe-then-append
 * handshake the real commit performs. A `fail` mode makes the probe + INSERT return a transient timeout (a
 * degraded window), so a re-driven write DEFERS into the outbox instead of committing.
 */
function memoriesBackend(): {
	storage: StorageQuery;
	setMode(m: "fail" | "ok"): void;
	get committed(): readonly string[];
} {
	const st = { mode: "ok" as "fail" | "ok", committed: [] as string[], pendingInsert: [] as string[] };
	const allHashes = (sql: string): string[] => [...sql.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
	const storage: StorageQuery = {
		async query(sql: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
			if (isBatchProbe(sql)) {
				if (st.mode === "fail") return timeoutResult(10_000);
				const hashes = allHashes(sql);
				st.pendingInsert = hashes.filter((h) => !st.committed.includes(h)); // the next multi-row INSERT commits these.
				return ok(hashes.filter((h) => st.committed.includes(h)).map((h) => ({ content_hash: h })), 1);
			}
			if (isDedupProbe(sql)) {
				if (st.mode === "fail") return timeoutResult(10_000);
				const hash = /content_hash\s*=\s*'([^']+)'/.exec(sql)?.[1] ?? "";
				if (st.committed.includes(hash)) return ok([{ id: `existing-${hash}` }], 1);
				st.pendingInsert = [hash]; // the next INSERT commits THIS hash.
				return ok([], 1);
			}
			if (isVersionRead(sql)) return ok([], 1);
			if (isInsert(sql)) {
				if (st.mode === "fail") return timeoutResult(10_000);
				for (const h of st.pendingInsert) if (!st.committed.includes(h)) st.committed.push(h);
				st.pendingInsert = [];
				return ok([], 1);
			}
			return ok([], 1);
		},
	};
	return {
		storage,
		setMode: (m) => {
			st.mode = m;
		},
		get committed() {
			return st.committed;
		},
	};
}

/** Build controlled-write deps over a backend storage + an injected outbox + a distinct-id generator. */
function redriveDeps(storage: StorageQuery, over: Partial<ControlledWriteHandlerDeps> = {}): ControlledWriteHandlerDeps {
	return {
		storage,
		config: PipelineConfigSchema.parse({}),
		embed: nullEmbed,
		now: () => new Date("2026-07-11T00:00:00.000Z"),
		newId: mkIdGen(),
		...over,
	};
}

/** A TERMINAL `memory_controlled_write` job payload (the single-proposal wire shape) for `content`. */
function termJob(content: string): Record<string, unknown> {
	return {
		org: "org-1",
		workspace: "ws-1",
		proposal: { action: "add", confidence: 0.9, reason: "" },
		content,
		normalized_content: content,
		fact_confidence: 0.9,
	};
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-memory-redrive-"));
});
afterEach(() => {
	try {
		rmSync(dir, { recursive: true, force: true });
	} catch {
		// best-effort temp cleanup
	}
});

// ── b-AC-4: the terminal-job reader ──────────────────────────────────────────────

describe("b-AC-4: readTerminalControlledWriteJobs reads only TERMINAL memory_controlled_write jobs", () => {
	it("reads failed memory_controlled_write payloads, excluding non-terminal + other-kind jobs", async () => {
		const queue = openLocalJobQueue({ baseDir: dir });
		// A TERMINAL memory_controlled_write job (maxAttempts 1 → one lease + fail = `failed`).
		await queue.enqueue({ kind: "memory_controlled_write", payload: termJob("terminal fact"), maxAttempts: 1 });
		const leased = await queue.lease(["memory_controlled_write"]);
		await queue.fail(leased!.id, "degraded window", leased!.attempt);
		// A still-QUEUED memory_controlled_write job (never leased) must be EXCLUDED (not terminal).
		await queue.enqueue({ kind: "memory_controlled_write", payload: termJob("still queued") });
		// A TERMINAL job of a DIFFERENT kind must be EXCLUDED.
		await queue.enqueue({ kind: "memory_extraction", payload: { content: "other kind" }, maxAttempts: 1 });
		const other = await queue.lease(["memory_extraction"]);
		await queue.fail(other!.id, "x", other!.attempt);
		queue.close();

		const jobs = readTerminalControlledWriteJobs({ baseDir: dir });
		expect(jobs).toHaveLength(1);
		expect(jobs[0]!.content).toBe("terminal fact");
	});

	it("returns [] when the local-queue.db does not exist yet (read-through fail-soft)", () => {
		// The temp dir has no `.daemon/local-queue.db` — the reader must NOT fabricate one.
		expect(readTerminalControlledWriteJobs({ baseDir: dir })).toEqual([]);
	});
});

// ── b-AC-4: the orchestrator — re-drive → defer → drain → present, no duplicates ──

describe("b-AC-4: runMemoryRedrive recovers dropped memories idempotently", () => {
	it("re-drives seeded terminal jobs into the outbox during a degraded window, then drains to memories with no duplicates", async () => {
		const backend = memoriesBackend();
		const clock = fakeClock(Date.parse("2026-07-11T00:00:00.000Z"));
		const outbox = openMemoryOutbox({ storage: backend.storage, memory: true, clock });
		const deps = redriveDeps(backend.storage, { memoryOutbox: outbox });
		const jobs = [termJob("recovered fact one"), termJob("recovered fact two")];

		// A still-degraded backend at re-drive time → the two writes DEFER into the durable outbox.
		backend.setMode("fail");
		const first = await runMemoryRedrive({
			readJobs: () => jobs,
			redriveOne: (payload) => redriveControlledWritePayload(payload, deps),
		});
		expect(first).toEqual({ redriven: 2, skipped: 0 });
		expect(outbox.counts().pending).toBe(2);
		expect(backend.committed.length, "nothing committed during the degraded window").toBe(0);

		// The backend recovers → the drainer commits both distilled memories.
		backend.setMode("ok");
		clock.advance(10 * 60 * 1000);
		const drain = await outbox.drainDue();
		expect(drain.drained).toBe(2);
		expect(backend.committed.length, "both dropped memories are now present").toBe(2);

		// IDEMPOTENT: a repeat re-drive re-reads the SAME jobs → the content_hash dedup returns them as
		// already-present (`deduped`) → NO duplicate `memories` row is written (b-AC-4 / D-4).
		const second = await runMemoryRedrive({
			readJobs: () => jobs,
			redriveOne: (payload) => redriveControlledWritePayload(payload, deps),
		});
		expect(second.redriven, "a repeat re-drive re-recovers (deduped), never skips").toBe(2);
		expect(backend.committed.length, "no duplicate memories on a repeat re-drive").toBe(2);
		outbox.close();
	});

	it("commits directly on a healthy backend (no outbox needed) and is a clean no-op when there are no terminal jobs", async () => {
		const backend = memoriesBackend(); // healthy
		const outbox = openMemoryOutbox({ storage: backend.storage, memory: true });
		const deps = redriveDeps(backend.storage, { memoryOutbox: outbox });

		const done = await runMemoryRedrive({
			readJobs: () => [termJob("directly recovered")],
			redriveOne: (payload) => redriveControlledWritePayload(payload, deps),
		});
		expect(done).toEqual({ redriven: 1, skipped: 0 });
		expect(outbox.counts().pending, "a healthy backend commits directly — nothing left in the outbox").toBe(0);
		expect(backend.committed.length).toBe(1);

		// Daemon-down / no terminal jobs → a clean report, never a throw.
		const empty = await runMemoryRedrive({ readJobs: () => [], redriveOne: async () => ({ redriven: 0, skipped: 0 }) });
		expect(empty).toEqual({ redriven: 0, skipped: 0 });
		outbox.close();
	});
});

// ── b-AC-5: one bad row is skipped without aborting the pass (non-regression) ─────

describe("b-AC-5: re-drive is fail-soft per row — one bad payload never aborts the others", () => {
	it("skips an unparseable payload and still recovers the valid one", async () => {
		const backend = memoriesBackend(); // healthy
		const deps = redriveDeps(backend.storage);
		// An unparseable proposal (not an object) → the fact is `skipped`, never a throw out of the pass.
		const badJob: Record<string, unknown> = { org: "org-1", workspace: "ws-1", proposal: "not-a-proposal" };

		const res = await runMemoryRedrive({
			readJobs: () => [badJob, termJob("the good one")],
			redriveOne: (payload) => redriveControlledWritePayload(payload, deps),
		});
		expect(res).toEqual({ redriven: 1, skipped: 1 });
		expect(backend.committed.length, "the valid fact still committed despite the bad sibling").toBe(1);
	});
});
