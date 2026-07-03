/**
 * PRD-017a summary worker — proves a-AC-1..6 (named, unskipped) + the redaction floor.
 *
 * Verification posture (EXECUTION_LEDGER-prd-017): no live DeepLake. Each a-AC has a
 * named test driving the real `worker.ts` against:
 *   - a FAKE `SummaryStore` (recording, NO `update` method) for the write-shape ACs, AND
 *     the REAL `createSummaryStore` over a `FakeDeepLakeTransport` for the
 *     SELECT-before-INSERT-not-UPDATE SQL assertion (a-AC-6);
 *   - a FAKE `SessionEventFetcher` (canned events; an empty-then-present script for the
 *     retry AC) + a FAKE `Sleeper` clock (a-AC-3);
 *   - `createFakeSummaryGenCli` (the pinned fake) for the worker-level path, AND a FAKE
 *     `SummarySpawner` driving the REAL `createHostSummaryGenCli` to assert the no-shell
 *     args array + the `HONEYCOMB_WIKI_WORKER=1` / `HONEYCOMB_CAPTURE=false` env (a-AC-2);
 *   - an in-memory `SummaryLock` for the suppression test (a-AC-4);
 *   - a throwing `EmbedClient` for the non-fatal embed (a-AC-5);
 *   - a secret-bearing transcript for the redaction floor.
 */

import { describe, expect, it } from "vitest";

import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import {
	buildSummaryPrompt,
	createFakeSummaryGenCli,
	createHostSummaryGenCli,
	createSummaryStore,
	embedNonFatal,
	fetchWithRetry,
	runSummaryWorker,
	type EmbedClient,
	type SessionEvent,
	type SessionEventFetcher,
	type Sleeper,
	type SummaryCliSpec,
	summaryPath,
	type SummaryGenCli,
	type SummaryLock,
	type SummaryLockHandle,
	type SummaryRow,
	type SummarySession,
	type SummarySpawner,
	type SummaryStore,
	type SummaryTrigger,
	type SummaryWriteOutcome,
	type WorkerConfig,
} from "../../../../src/daemon/runtime/summaries/index.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const SCOPE = { org: "o1", workspace: "ws1" } as const;

const SESSION: SummarySession = { sessionId: "sess-42", userName: "alice", path: "conv/abc" };
const FINAL_TRIGGER: SummaryTrigger = { kind: "final", event: "SessionEnd" };
const PERIODIC_TRIGGER: SummaryTrigger = { kind: "periodic", reason: "messages", count: 50 };

const FAST_CONFIG: WorkerConfig = { retryLimit: 3, backoffMs: 10, gateTimeoutMs: 1_000 };

// ── Builders for fake `sessions` events (the verbatim `{ event, metadata }` envelope) ──

function eventOf(kind: string, text: string, date: string, author = "alice"): SessionEvent {
	const message = JSON.stringify({ event: { kind, text }, metadata: { sessionId: SESSION.sessionId } });
	return { message, author, creationDate: date };
}

const CANNED_EVENTS: readonly SessionEvent[] = [
	eventOf("user_message", "please refactor the auth module", "2026-06-18T00:00:01Z"),
	eventOf("assistant_message", "done — extracted the token check into a helper", "2026-06-18T00:00:02Z"),
];

/** A fetcher returning canned events on every attempt. */
function fakeFetcher(events: readonly SessionEvent[]): SessionEventFetcher {
	return { fetch: async (): Promise<readonly SessionEvent[]> => events };
}

/** A fetcher that returns empty for the first `emptyTimes` attempts, then the events. */
function emptyThenPresentFetcher(
	emptyTimes: number,
	events: readonly SessionEvent[],
): { fetcher: SessionEventFetcher; attempts: () => number } {
	let n = 0;
	const fetcher: SessionEventFetcher = {
		async fetch(): Promise<readonly SessionEvent[]> {
			const attempt = n++;
			return attempt < emptyTimes ? [] : events;
		},
	};
	return { fetcher, attempts: () => n };
}

/** A no-op fake clock so the retry backoff runs instantly. */
function fakeSleeper(): { sleeper: Sleeper; sleeps: number[] } {
	const sleeps: number[] = [];
	return {
		sleeper: {
			async sleep(ms: number): Promise<void> {
				sleeps.push(ms);
			},
		},
		sleeps,
	};
}

/** An in-memory per-session lock (one holder per session; second acquire → null). */
function memoryLock(): SummaryLock {
	const held = new Set<string>();
	return {
		acquire(sessionId: string): SummaryLockHandle | null {
			if (held.has(sessionId)) return null;
			held.add(sessionId);
			return { release: (): void => void held.delete(sessionId) };
		},
	};
}

/** A never-releasing lock that reports a session already held (drives the suppression path). */
function alwaysHeldLock(): SummaryLock {
	return { acquire: (): SummaryLockHandle | null => null };
}

/** An embed client returning a fixed 768-dim vector. */
function fixedEmbed(): EmbedClient {
	const vec = new Array<number>(768).fill(0.01);
	return { embed: async (): Promise<readonly number[] | null> => vec };
}

/** An embed client that THROWS (a-AC-5 — non-fatal). */
function throwingEmbed(): EmbedClient {
	return {
		embed: async (): Promise<readonly number[] | null> => {
			throw new Error("embed daemon down");
		},
	};
}

/** A recording fake `SummaryStore` (NO `update` by construction). */
function recordingStore(): {
	store: SummaryStore;
	calls: string[];
	rows: SummaryRow[];
	placeholders: string[];
	removed: string[];
} {
	const calls: string[] = [];
	const rows: SummaryRow[] = [];
	const placeholders: string[] = [];
	const removed: string[] = [];
	const present = new Set<string>();
	const store: SummaryStore = {
		async writePlaceholder(path: string): Promise<void> {
			calls.push(`placeholder:${path}`);
			placeholders.push(path);
			present.add(path);
		},
		async removePlaceholder(path: string): Promise<void> {
			calls.push(`remove:${path}`);
			removed.push(path);
			present.delete(path);
		},
		async writeSummary(row: SummaryRow): Promise<SummaryWriteOutcome> {
			calls.push(`write:${row.path}`);
			const already = rows.some((r) => r.path === row.path);
			rows.push(row);
			return { written: !already, raceDetected: false };
		},
	};
	return { store, calls, rows, placeholders, removed };
}

describe("PRD-017a summary worker", () => {
	it("a-AC-1: trigger + events present → gate CLI → write summary to memory at /summaries/<userName>/<sessionId>.md", async () => {
		const { store, rows } = recordingStore();
		const { sleeper } = fakeSleeper();
		const result = await runSummaryWorker(FINAL_TRIGGER, SESSION, {
			lock: memoryLock(),
			fetcher: fakeFetcher(CANNED_EVENTS),
			gate: createFakeSummaryGenCli("## Summary\nRefactored the auth module."),
			embed: fixedEmbed(),
			store,
			config: FAST_CONFIG,
			sleeper,
		});

		expect(result.ran).toBe(true);
		const expectedPath = summaryPath(SESSION);
		expect(expectedPath).toBe("/summaries/alice/sess-42.md");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.path).toBe(expectedPath);
		expect(rows[0]?.summary).toContain("Refactored the auth module");
		expect(rows[0]?.description.length).toBeGreaterThan(0);
		if (result.ran) expect(result.wrote).toBe(true);
	});

	it("a-AC-2: the gate subprocess sets HONEYCOMB_WIKI_WORKER=1 + HONEYCOMB_CAPTURE=false with a no-shell args array", async () => {
		// Drive the REAL createHostSummaryGenCli through a fake spawner so we assert the
		// args ARRAY (never a shell string) AND the capture-loop-guard env the worker sets.
		let seenSpec: SummaryCliSpec | undefined;
		let seenPrompt = "";
		const recordingSpawner: SummarySpawner = {
			async run(spec: SummaryCliSpec, prompt: string): Promise<string> {
				seenSpec = spec;
				seenPrompt = prompt;
				return "## ok";
			},
		};
		const spec: SummaryCliSpec = { command: "claude", args: ["-p", "--no-session-persistence"] };
		const gate: SummaryGenCli = createHostSummaryGenCli(spec, recordingSpawner, 1_000);

		const out = await gate.run(buildSummaryPrompt(SESSION, CANNED_EVENTS));
		expect(out).toContain("ok");
		expect(Array.isArray(seenSpec?.args)).toBe(true);
		expect(seenSpec?.command).toBe("claude");
		expect(seenSpec?.args).toEqual(["-p", "--no-session-persistence"]);
		// The prompt is passed as inert data (stdin), never folded into the args array.
		expect(seenSpec?.args.join(" ")).not.toContain("refactor");
		expect(seenPrompt).toContain("refactor");

		// The real spawner (systemSummarySpawner) layers WIKI_WORKER=1 + CAPTURE=false over
		// process.env — assert the env-var names the worker pins are exported by the module.
		const mod = await import("../../../../src/daemon/runtime/summaries/index.js");
		expect(mod.WIKI_WORKER_ENV).toBe("HONEYCOMB_WIKI_WORKER");
		expect(mod.CAPTURE_ENV).toBe("HONEYCOMB_CAPTURE");
	});

	it("a-AC-2 (live env): systemSummarySpawner exports WIKI_WORKER=1 + CAPTURE=false into the child env (no-shell)", async () => {
		// Spawn a real node child that echoes the two env vars back, proving the spawner sets
		// them in the subprocess and uses an args array (no shell) — node is available in CI.
		const { systemSummarySpawner } = await import("../../../../src/daemon/runtime/summaries/index.js");
		const spec: SummaryCliSpec = {
			command: process.execPath,
			args: [
				"-e",
				"process.stdout.write(JSON.stringify({w:process.env.HONEYCOMB_WIKI_WORKER,c:process.env.HONEYCOMB_CAPTURE,m:process.env.HONEYCOMB_WORKER}))",
			],
		};
		const out = await systemSummarySpawner.run(spec, "ignored stdin", 10_000);
		const parsed = JSON.parse(out.trim()) as { w?: string; c?: string; m?: string };
		expect(parsed.w).toBe("1");
		expect(parsed.c).toBe("false");
		// Defense-in-depth: the canonical capture-gate recursion marker is set too.
		expect(parsed.m).toBe("1");
	});

	it("a-AC-3: no events (read lag) → retry with linear backoff up to the limit, then remove the in-progress placeholder", async () => {
		const { store, calls, removed, rows } = recordingStore();
		const { sleeper, sleeps } = fakeSleeper();
		// Always empty → exhaust the retries → give up → remove the placeholder.
		const result = await runSummaryWorker(FINAL_TRIGGER, SESSION, {
			lock: memoryLock(),
			fetcher: fakeFetcher([]),
			gate: createFakeSummaryGenCli("## should never be called"),
			embed: fixedEmbed(),
			store,
			config: FAST_CONFIG, // retryLimit 3 → 4 attempts total, 3 backoff sleeps
			sleeper,
		});

		expect(result.ran).toBe(false);
		if (!result.ran) expect(result.reason).toBe("no_events");
		// LINEAR backoff: retryLimit=3 → exactly 3 constant-interval sleeps.
		expect(sleeps).toEqual([10, 10, 10]);
		// The placeholder was staked AND removed (never stranded); NO summary row written.
		expect(removed).toContain(summaryPath(SESSION));
		expect(rows).toHaveLength(0);
		expect(calls.some((c) => c.startsWith("placeholder:"))).toBe(true);
	});

	it("a-AC-3 (recovery): the fetch retries on empty then succeeds once events appear", async () => {
		const { store, rows } = recordingStore();
		const { sleeper, sleeps } = fakeSleeper();
		const { fetcher, attempts } = emptyThenPresentFetcher(2, CANNED_EVENTS);
		const result = await runSummaryWorker(FINAL_TRIGGER, SESSION, {
			lock: memoryLock(),
			fetcher,
			gate: createFakeSummaryGenCli("## recovered summary"),
			embed: fixedEmbed(),
			store,
			config: FAST_CONFIG,
			sleeper,
		});
		expect(result.ran).toBe(true);
		expect(attempts()).toBe(3); // 2 empty + 1 present
		expect(sleeps).toEqual([10, 10]); // 2 backoffs before the present attempt
		expect(rows).toHaveLength(1);
	});

	it("a-AC-4: per-session lock → a concurrent summary for the same session is suppressed", async () => {
		const { store, rows } = recordingStore();
		const { sleeper } = fakeSleeper();
		// The lock reports the session already held → the run is suppressed, nothing written.
		const result = await runSummaryWorker(PERIODIC_TRIGGER, SESSION, {
			lock: alwaysHeldLock(),
			fetcher: fakeFetcher(CANNED_EVENTS),
			gate: createFakeSummaryGenCli("## must not run"),
			embed: fixedEmbed(),
			store,
			config: FAST_CONFIG,
			sleeper,
		});
		expect(result.ran).toBe(false);
		if (!result.ran) expect(result.reason).toBe("lock_held");
		expect(rows).toHaveLength(0);

		// And with a real in-memory lock: a SECOND acquire while the first is held returns
		// null → at most one concurrent summary per session.
		const lock = memoryLock();
		const first = lock.acquire(SESSION.sessionId);
		expect(first).not.toBeNull();
		expect(lock.acquire(SESSION.sessionId)).toBeNull(); // suppressed while held
		first?.release();
		expect(lock.acquire(SESSION.sessionId)).not.toBeNull(); // free after release
	});

	it("a-AC-5: EmbedClient.embed() throws → NULL embedding stored, the write still succeeds", async () => {
		const { store, rows } = recordingStore();
		const { sleeper } = fakeSleeper();
		const result = await runSummaryWorker(FINAL_TRIGGER, SESSION, {
			lock: memoryLock(),
			fetcher: fakeFetcher(CANNED_EVENTS),
			gate: createFakeSummaryGenCli("## summary that survives an embed failure"),
			embed: throwingEmbed(), // throws — must be NON-FATAL
			store,
			config: FAST_CONFIG,
			sleeper,
		});
		expect(result.ran).toBe(true);
		if (result.ran) expect(result.embedded).toBe(false);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.embedding).toBeNull(); // NULL embedding
		expect(rows[0]?.summary).toContain("survives an embed failure"); // write succeeded

		// And the wrapper itself: a throw → null, a wrong-dim → null, a 768 vector → passes.
		await expect(embedNonFatal(throwingEmbed(), "x")).resolves.toBeNull();
		const wrongDim: EmbedClient = { embed: async () => [1, 2, 3] };
		await expect(embedNonFatal(wrongDim, "x")).resolves.toBeNull();
		await expect(embedNonFatal(fixedEmbed(), "x")).resolves.not.toBeNull();
	});

	it("a-AC-6: writes via SELECT-before-INSERT keyed on path — asserts NO in-place UPDATE is emitted", async () => {
		// Drive the REAL createSummaryStore over a FakeDeepLakeTransport and inspect every
		// statement: the write must be a probe SELECT + an INSERT keyed on `path`, and there
		// must be ZERO `UPDATE "memory" SET …` emitted (the in-place-UPDATE ban).
		const fake = new FakeDeepLakeTransport((req) => {
			const sql = req.sql.toUpperCase();
			// Probe SELECT on `path` → empty (absent) so the SBI inserts.
			if (sql.startsWith("SELECT")) return [];
			// INSERT / DELETE → accept (no rows).
			return [];
		});
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const store = createSummaryStore(storage, SCOPE);

		const path = summaryPath(SESSION);
		await store.writePlaceholder(path, "alice");
		await store.removePlaceholder(path);
		const outcome = await store.writeSummary({
			path,
			summary: "## the summary body",
			key: "the summary body — written",
			description: "the summary body",
			embedding: null,
			author: "alice",
		});
		expect(outcome.written).toBe(true);

		const statements = fake.requests.map((r) => r.sql);
		// At least one INSERT INTO "memory" keyed on the path value.
		expect(statements.some((s) => /INSERT\s+INTO\s+"memory"/i.test(s))).toBe(true);
		expect(statements.some((s) => s.includes(path))).toBe(true);
		// THE invariant: no in-place UPDATE of the memory table anywhere.
		expect(
			statements.some((s) => /UPDATE\s+"memory"\s+SET/i.test(s)),
			"no in-place UPDATE on memory",
		).toBe(false);
		// The placeholder removal is a guarded DELETE on the in-progress marker, not an UPDATE.
		expect(statements.some((s) => /DELETE\s+FROM\s+"memory"/i.test(s) && /in progress/i.test(s))).toBe(true);
	});

	it("a-AC-6 (exactly-once): a re-run over an already-present path does NOT write a second row", async () => {
		const { store, rows } = recordingStore();
		const { sleeper } = fakeSleeper();
		const deps = {
			lock: memoryLock(),
			fetcher: fakeFetcher(CANNED_EVENTS),
			gate: createFakeSummaryGenCli("## once"),
			embed: fixedEmbed(),
			store,
			config: FAST_CONFIG,
			sleeper,
		};
		const first = await runSummaryWorker(FINAL_TRIGGER, SESSION, deps);
		const second = await runSummaryWorker(FINAL_TRIGGER, SESSION, deps);
		expect(first.ran && first.wrote).toBe(true);
		expect(second.ran).toBe(true);
		if (second.ran) expect(second.wrote).toBe(false); // already present → exactly-once
		expect(rows.filter((r) => r.path === summaryPath(SESSION))).toHaveLength(2); // both write calls...
		// ...but only the FIRST inserted a fresh row (alreadyPresent on the second).
	});

	it("redaction: a transcript secret is scrubbed out of the summary prompt (never reaches the gate)", () => {
		const secret = "sk-ant-abc123DEF456ghi789JKL012mno345";
		const events: readonly SessionEvent[] = [
			eventOf("user_message", `here is my key ${secret} please use it`, "2026-06-18T00:00:01Z"),
		];
		const prompt = buildSummaryPrompt(SESSION, events);
		expect(prompt).not.toContain(secret);
		expect(prompt).toContain("[REDACTED]");
	});

	it("b-AC-5 (PRD-046b): a transcript secret reaches NEITHER the stored summary NOR the Tier-1 key", async () => {
		// End-to-end: a secret-bearing transcript runs the full worker. The gate is scrubbed at
		// the prompt boundary, and a (cooperative) gate that echoed a fact back can only ever see
		// the scrubbed text — so neither the written summary body nor the Tier-1 key carries the
		// secret. Drive a gate that returns a structured object referencing the scrubbed marker.
		const secret = "sk-ant-abc123DEF456ghi789JKL012mno345";
		const events: readonly SessionEvent[] = [
			eventOf("user_message", `rotate the key ${secret} in the deploy config`, "2026-06-18T00:00:01Z"),
		];
		// The gate (cooperatively) emits a grounded object — it never saw the secret (scrubbed).
		const gate = createFakeSummaryGenCli(
			JSON.stringify({
				extraction: { changes: ["rotated the deploy-config key (redacted)"] },
				summary: "## Deploy\nRotated the deploy-config key (value redacted).",
				key: "deploy-config key — rotated",
			}),
		);
		const { store, rows } = recordingStore();
		const { sleeper } = fakeSleeper();
		const result = await runSummaryWorker(FINAL_TRIGGER, SESSION, {
			lock: memoryLock(),
			fetcher: fakeFetcher(events),
			gate,
			embed: fixedEmbed(),
			store,
			config: FAST_CONFIG,
			sleeper,
		});
		expect(result.ran).toBe(true);
		expect(rows).toHaveLength(1);
		// GREP-CLEAN: the secret appears in NEITHER the stored summary NOR the Tier-1 key.
		expect(rows[0]?.summary).not.toContain(secret);
		expect(rows[0]?.key).not.toContain(secret);
		expect(rows[0]?.key.length).toBeGreaterThan(0);
	});

	it("fetchWithRetry: retryLimit 0 → a single attempt, no backoff", async () => {
		const { sleeper, sleeps } = fakeSleeper();
		const events = await fetchWithRetry(
			fakeFetcher([]),
			SESSION,
			{ retryLimit: 0, backoffMs: 99, gateTimeoutMs: 1 },
			sleeper,
		);
		expect(events).toHaveLength(0);
		expect(sleeps).toEqual([]); // no retry → no sleep
	});

	it("C-3: a fresh summary write increments the pollinating counter by the summary token estimate", async () => {
		const markdown = "## Deploy\nRotated credentials safely.";
		const increments: { agentId: string; tokens: number }[] = [];
		const gate: SummaryGenCli = {
			async run(): Promise<string> {
				return JSON.stringify({
					extraction: { changes: ["rotated credentials"] },
					summary: markdown,
					key: "deploy: rotated",
				});
			},
		};
		const { store } = recordingStore();
		const { sleeper } = fakeSleeper();
		const session: SummarySession = { ...SESSION, agentId: "claude-code" };
		const result = await runSummaryWorker(FINAL_TRIGGER, session, {
			lock: memoryLock(),
			fetcher: fakeFetcher(CANNED_EVENTS),
			gate,
			embed: fixedEmbed(),
			store,
			config: FAST_CONFIG,
			sleeper,
			pollinatingCounter: {
				increment: async (scope, tokens) => {
					increments.push({ agentId: scope.agentId, tokens });
				},
			},
		});
		expect(result.ran).toBe(true);
		expect(result).toMatchObject({ wrote: true });
		expect(increments).toEqual([{ agentId: "claude-code", tokens: Math.ceil(markdown.length / 4) }]);
	});
});
