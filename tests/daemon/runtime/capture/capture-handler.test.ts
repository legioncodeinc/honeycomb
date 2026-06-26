/**
 * PRD-005a capture-endpoint suite — a-AC-1..a-AC-6 (FR-1..10).
 *
 * Verification posture (EXECUTION_LEDGER-prd-005): in-process via
 * `daemon.app.request(...)` against a daemon constructed with the PRD-002 fake
 * transport. No socket is bound. The capture handler is attached AFTER
 * `createDaemon(...)` via `createCaptureHandler(...).register(daemon)` — the
 * a-AC-6 seam — so it inherits the bootstrap's runtime-path + permission
 * middleware with no re-wiring. Each test is named after the AC it proves so the
 * ledger maps one-to-one to a passing test.
 *
 * The sessions write is asserted against `fake.requests` (the exact SQL + scope
 * that went out) — one append-only INSERT per event, the JSONB message, the
 * scope/metadata columns, heal-once, and NEVER an UPDATE/concat. The per-turn
 * cue enqueue is asserted against a recording fake queue (NO worker is ever run
 * inline). Read-back ordering/scoping is asserted against the SQL the handler
 * builds + the rows the fake returns.
 */

import { describe, expect, it } from "vitest";

import { healTargetFor } from "../../../../src/daemon/storage/catalog/index.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { TransportError } from "../../../../src/daemon/storage/transport.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import { createRuntimePathService } from "../../../../src/daemon/runtime/middleware/runtime-path.js";
import type { JobInput, JobQueueService, LeasedJob } from "../../../../src/daemon/runtime/services/job-queue.js";
import {
	createCaptureHandler,
	type CaptureHandlerDeps,
} from "../../../../src/daemon/runtime/capture/capture-handler.js";
import { TurnCounters } from "../../../../src/daemon/runtime/capture/turn-counters.js";
import type {
	EmbedAttachment,
	EmbeddingTarget,
} from "../../../../src/daemon/runtime/services/embed-client.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

// ── Test scaffolding ─────────────────────────────────────────────────────────

const ORG = "fake-org";
const WORKSPACE = "fake-ws";

/** Build a resolved local-mode config (permission open; capture is the focus). */
function cfg(mode: RuntimeConfig["mode"] = "local", over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode, widened: false, ...over };
}

/** The `x-honeycomb-*` headers a session-scoped POST needs (runtime-path 004d). */
function sessionHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return {
		"content-type": "application/json",
		"x-honeycomb-runtime-path": "plugin",
		"x-honeycomb-session": "sess-1",
		"x-honeycomb-org": ORG,
		"x-honeycomb-workspace": WORKSPACE,
		...extra,
	};
}

/** A recording fake queue: records every enqueue; lease/complete/fail are inert. */
class RecordingQueue implements JobQueueService {
	readonly enqueued: JobInput[] = [];
	leaseCalls = 0;
	async enqueue(job: JobInput): Promise<string> {
		this.enqueued.push(job);
		return `job-${this.enqueued.length}`;
	}
	async lease(): Promise<LeasedJob | null> {
		this.leaseCalls += 1;
		return null;
	}
	async complete(): Promise<void> {}
	async fail(): Promise<void> {}
	start(): void {}
	stop(): void {}
}

/**
 * A SQL-aware responder for the fake transport: INSERTs/UPDATEs/DELETEs succeed
 * with no rows; a SELECT against `sessions` returns the scripted read-back rows.
 * The optional `failFirstInsertWith` drives the heal path: the first INSERT
 * returns a missing-table query_error, after which CREATE + the retried INSERT
 * succeed (a-AC-4).
 */
function responderFor(opts: { readbackRows?: Record<string, unknown>[]; failFirstInsertWith?: string } = {}) {
	let insertSeen = 0;
	return (req: TransportRequest): Record<string, unknown>[] => {
		const sql = req.sql;
		if (/^\s*INSERT\s+INTO/i.test(sql)) {
			insertSeen += 1;
			if (insertSeen === 1 && opts.failFirstInsertWith !== undefined) {
				throw new TransportError("query", opts.failFirstInsertWith, 404);
			}
			return [];
		}
		if (/information_schema\.columns/i.test(sql)) {
			// Heal introspection: report the full sessions column set as present so the
			// add-only-missing diff is a no-op after CREATE.
			return healTargetFor("sessions").columns.map((c) => ({ column_name: c.name }));
		}
		if (/^\s*CREATE\s+TABLE/i.test(sql) || /^\s*ALTER\s+TABLE/i.test(sql)) return [];
		if (/^\s*SELECT/i.test(sql)) return opts.readbackRows ?? [];
		return [];
	};
}

/** Build a daemon + capture handler over the fake transport. Returns the pieces a test asserts on. */
function buildDaemon(opts: {
	responder?: (req: TransportRequest) => Record<string, unknown>[];
	queue?: JobQueueService;
	embed?: EmbedAttachment;
	counters?: TurnCounters;
	deps?: Partial<CaptureHandlerDeps>;
	mode?: RuntimeConfig["mode"];
} = {}): { daemon: Daemon; fake: FakeDeepLakeTransport; queue: RecordingQueue | JobQueueService } {
	const fake = new FakeDeepLakeTransport(opts.responder ?? responderFor());
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const queue = opts.queue ?? new RecordingQueue();
	const daemon = createDaemon({
		config: cfg(opts.mode ?? "local"),
		storage,
		logger: createRequestLogger({ silent: true }),
		// The real 004d runtime-path service so the session-scoped /api/hooks group
		// is genuinely behind a claim (capture is session-scoped — ledger).
		services: { runtimePath: createRuntimePathService() },
	});
	const handler = createCaptureHandler({
		storage,
		sessionsTarget: healTargetFor("sessions"),
		queue,
		embed: opts.embed,
		counters: opts.counters,
		// PRD-062c: these a-AC-* tests assert the pre-062c write contract (ONE synchronous
		// append-only INSERT per event, full untrimmed envelope) — i.e. the flags-OFF parity
		// path (AC-9). Pin batching off + trimming off here so the existing single-INSERT
		// assertions hold; the new batching/trim behavior is proven in its own suites. A
		// caller may override via `opts.deps.captureConfig`.
		captureConfig: { batch: false, windowMs: 1_000, maxEvents: 25, envelopeBudgetBytes: 0 },
		...opts.deps,
	});
	handler.register(daemon);
	return { daemon, fake, queue };
}

/** A capture request body for a `user_message` (the common case). */
function userMessageBody(over: { text?: string; metadata?: Record<string, unknown> } = {}) {
	return {
		event: { kind: "user_message", text: over.text ?? "hello world" },
		metadata: {
			sessionId: "sess-1",
			path: "conversations/sess-1",
			cwd: "/repo",
			permissionMode: "default",
			hookEventName: "UserPromptSubmit",
			agentId: "agent-7",
			org: ORG,
			workspace: WORKSPACE,
			agent: "claude-code",
			pluginVersion: "0.1.0",
			...over.metadata,
		},
	};
}

// ── a-AC-1 ───────────────────────────────────────────────────────────────────

describe("a-AC-1 one sessions INSERT with a JSONB message + a path grouping the conversation", () => {
	it("INSERTs exactly one sessions row carrying the JSONB message and the path", async () => {
		const { daemon, fake } = buildDaemon();
		const res = await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify(userMessageBody({ text: "find the bug" })),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as Record<string, unknown>;
		expect(body.ok).toBe(true);
		expect(body.path).toBe("conversations/sess-1");

		const inserts = fake.requests.filter((r) => /^\s*INSERT\s+INTO\s+"sessions"/i.test(r.sql));
		expect(inserts.length, "exactly one INSERT for one event").toBe(1);
		const sql = inserts[0].sql;
		// JSONB message column present (bare identifier in the column list) and the
		// event is serialized into it as an E'...' literal.
		expect(sql).toMatch(/\(\s*id,\s*path,\s*filename,\s*message\b/);
		expect(sql).toContain("find the bug");
		expect(sql).toContain("user_message");
		// The path grouping column carries the conversation path.
		expect(sql).toContain("conversations/sess-1");
		// Scope reached the wire.
		expect(inserts[0].org).toBe(ORG);
		expect(inserts[0].workspace).toBe(WORKSPACE);
	});

	it("escapes the attacker-controllable message via E'...' (eLiteral) so it cannot break out (FR-9)", async () => {
		const { daemon, fake } = buildDaemon();
		// A prompt that tries to close the literal and inject a second statement.
		const evil = "'; DROP TABLE sessions; --";
		const res = await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify(userMessageBody({ text: evil })),
		});
		expect(res.status).toBe(201);
		const insert = fake.requests.find((r) => /^\s*INSERT\s+INTO\s+"sessions"/i.test(r.sql));
		expect(insert).toBeDefined();
		// The message column is an E'...' literal (eLiteral) and the embedded quote is
		// DOUBLED — so the injected `DROP TABLE` is inert text inside one literal.
		expect(insert?.sql).toContain("E'");
		expect(insert?.sql).toContain("''; DROP TABLE sessions; --");
		// There is no second statement: the only INSERT is the sessions row.
		expect(insert?.sql.match(/INSERT\s+INTO/gi)?.length).toBe(1);
	});
});

// ── a-AC-2 ───────────────────────────────────────────────────────────────────

describe("a-AC-2 N events in a turn → N rows, never concatenated", () => {
	it("each of three events becomes its own INSERT; never an UPDATE/concat", async () => {
		const { daemon, fake } = buildDaemon();
		const events = [
			userMessageBody({ text: "one" }),
			{
				event: { kind: "tool_call", tool: "grep", input: { q: "needle" }, response: { hits: 2 } },
				metadata: userMessageBody().metadata,
			},
			{ event: { kind: "assistant_message", text: "done" }, metadata: userMessageBody().metadata },
		];
		for (const body of events) {
			const res = await daemon.app.request("/api/hooks/capture", {
				method: "POST",
				headers: sessionHeaders(),
				body: JSON.stringify(body),
			});
			expect(res.status).toBe(201);
		}
		const inserts = fake.requests.filter((r) => /^\s*INSERT\s+INTO\s+"sessions"/i.test(r.sql));
		expect(inserts.length, "three events → three INSERTs").toBe(3);
		// No row mutation: capture never UPDATEs an existing sessions row.
		const updates = fake.requests.filter((r) => /^\s*UPDATE\s+"sessions"/i.test(r.sql));
		expect(updates.length, "append-only: never an UPDATE").toBe(0);
		// Each INSERT carries a DISTINCT id (its own row, not a concat into one).
		const ids = new Set(inserts.map((r) => r.sql.match(/'(sess-[^']+)'/)?.[1]));
		expect(ids.size).toBe(3);
	});
});

// ── a-AC-3 ───────────────────────────────────────────────────────────────────

describe("a-AC-3 the row carries session id, cwd, permission mode, hook event, agent_id, org, workspace", () => {
	it("threads all scope + metadata onto the written row", async () => {
		const { daemon, fake } = buildDaemon();
		await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify(
				userMessageBody({
					metadata: {
						sessionId: "sess-xyz",
						cwd: "/work/proj",
						permissionMode: "acceptEdits",
						hookEventName: "Stop",
						agentId: "agent-42",
					},
				}),
			),
		});
		const insert = fake.requests.find((r) => /^\s*INSERT\s+INTO\s+"sessions"/i.test(r.sql));
		expect(insert).toBeDefined();
		const sql = insert?.sql ?? "";
		// agent_id (engine-table scope), cwd (project), permission mode + hook event,
		// and session id are all present on the row or in the JSONB message.
		expect(sql).toContain("agent-42"); // agent_id / author
		expect(sql).toContain("/work/proj"); // project (cwd)
		expect(sql).toContain("Stop"); // hook event name → filename
		expect(sql).toContain("sess-xyz"); // session id (row id stem + message)
		expect(sql).toContain("acceptEdits"); // permission mode (preserved in JSONB metadata? — see note)
		// org/workspace reached the wire as the partition scope.
		expect(insert?.org).toBe(ORG);
		expect(insert?.workspace).toBe(WORKSPACE);
	});

	it("records the harness identity into the `agent` column so the Harnesses page can attribute it", async () => {
		// The harness-turns regression: the Harnesses page GROUPs BY `sessions.agent`, so a captured
		// turn is only attributed if `metadata.agent` (stamped upstream by the shim with the canonical
		// harness token) reaches the row's `agent` column. Prove the daemon writes it through.
		const { daemon, fake } = buildDaemon();
		await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify(userMessageBody({ metadata: { agent: "claude-code", agentId: "alice" } })),
		});
		const insert = fake.requests.find((r) => /^\s*INSERT\s+INTO\s+"sessions"/i.test(r.sql));
		expect(insert).toBeDefined();
		const sql = insert?.sql ?? "";
		// The canonical harness token lands on the row (the column the page counts) …
		expect(sql).toContain("claude-code");
		// … distinct from the per-user engine-scope agent_id (which carries `alice`).
		expect(sql).toContain("alice");
	});

	it("parameterized: each canonical harness token written upstream is recorded on the row", async () => {
		// One capture per harness, each stamping its own canonical token (as the shims now do). Each
		// must reach `sessions.agent` verbatim so the page's GROUP BY attributes it to that harness.
		for (const harness of ["claude-code", "codex", "cursor", "hermes", "pi", "openclaw"]) {
			const { daemon, fake } = buildDaemon();
			await daemon.app.request("/api/hooks/capture", {
				method: "POST",
				headers: sessionHeaders(),
				body: JSON.stringify(userMessageBody({ metadata: { agent: harness } })),
			});
			const insert = fake.requests.find((r) => /^\s*INSERT\s+INTO\s+"sessions"/i.test(r.sql));
			expect(insert?.sql, `${harness} reaches the agent column`).toContain(harness);
		}
	});
});

// ── a-AC-4 ───────────────────────────────────────────────────────────────────

describe("a-AC-4 missing sessions table → create + retry the INSERT once", () => {
	it("heals on a missing-table error, then the retried INSERT succeeds", async () => {
		const { daemon, fake } = buildDaemon({
			responder: responderFor({ failFirstInsertWith: 'relation "sessions" does not exist' }),
		});
		const res = await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify(userMessageBody()),
		});
		expect(res.status, "capture succeeds after the heal-and-retry").toBe(201);
		// The heal path issued a CREATE TABLE … USING deeplake between the two INSERTs.
		const creates = fake.requests.filter((r) => /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"sessions"/i.test(r.sql));
		expect(creates.length, "missing table healed via CREATE").toBe(1);
		// Exactly two INSERT attempts: the failing first + the retried one (FR-7: retry once).
		const inserts = fake.requests.filter((r) => /^\s*INSERT\s+INTO\s+"sessions"/i.test(r.sql));
		expect(inserts.length, "original INSERT + exactly one retry").toBe(2);
	});
});

// ── a-AC-5 ───────────────────────────────────────────────────────────────────

describe("a-AC-5 turn-terminating event → counters bumped + cue enqueued, NO worker run inline", () => {
	it("enqueues a skillify cue at the turn threshold WITHOUT running a worker inline", async () => {
		// skillifyEveryTurns=1 so the first turn-terminating event crosses immediately.
		const counters = new TurnCounters({ skillifyEveryTurns: 1, summaryEveryMessages: 1000 });
		const queue = new RecordingQueue();
		const { daemon } = buildDaemon({ queue, counters });
		const res = await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify(userMessageBody({ metadata: { hookEventName: "Stop", isTurnTerminating: true } })),
		});
		expect(res.status).toBe(201);
		// A skillify cue was ENQUEUED to memory_jobs (not run).
		const kinds = queue.enqueued.map((j) => j.kind);
		expect(kinds).toContain("skillify");
		// The cue carries the session + path so the worker can act later.
		const skillify = queue.enqueued.find((j) => j.kind === "skillify");
		expect(skillify?.payload).toMatchObject({ sessionId: "sess-1", path: "conversations/sess-1" });
		// NO worker ran inline: the queue's lease() (how a worker would pick up work)
		// was never called by the capture path.
		expect(queue.leaseCalls, "capture must not run a worker inline").toBe(0);
	});

	it("a mid-turn event below thresholds enqueues nothing", async () => {
		const counters = new TurnCounters({ skillifyEveryTurns: 10, summaryEveryMessages: 20 });
		const queue = new RecordingQueue();
		const { daemon } = buildDaemon({ queue, counters });
		await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify(userMessageBody()),
		});
		expect(queue.enqueued.length).toBe(0);
	});

	it("crosses the summary threshold after N messages and enqueues a summary cue", async () => {
		const counters = new TurnCounters({ summaryEveryMessages: 3, skillifyEveryTurns: 1000 });
		const queue = new RecordingQueue();
		const { daemon } = buildDaemon({ queue, counters });
		for (let i = 0; i < 3; i++) {
			await daemon.app.request("/api/hooks/capture", {
				method: "POST",
				headers: sessionHeaders(),
				body: JSON.stringify(userMessageBody({ text: `m${i}` })),
			});
		}
		expect(queue.enqueued.map((j) => j.kind)).toContain("summary");
		expect(queue.leaseCalls).toBe(0);
	});
});

// ── a-AC-6 ───────────────────────────────────────────────────────────────────

describe("a-AC-6 conversation read-back ordered by creation_date + scoped to org/workspace", () => {
	it("reads rows for a path ordered by creation_date, scoped to the requester's tenancy", async () => {
		const rows = [
			{ id: "a", path: "conversations/sess-1", creation_date: "2026-06-17T00:00:01.000Z" },
			{ id: "b", path: "conversations/sess-1", creation_date: "2026-06-17T00:00:02.000Z" },
		];
		const { daemon, fake } = buildDaemon({ responder: responderFor({ readbackRows: rows }) });
		const res = await daemon.app.request(
			`/api/hooks/conversation?path=${encodeURIComponent("conversations/sess-1")}`,
			{ headers: sessionHeaders() },
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as { path: string; rows: Record<string, unknown>[] };
		expect(body.rows.map((r) => r.id)).toEqual(["a", "b"]);
		// The read-back SQL orders by creation_date and filters by the path (FR-6).
		const select = fake.requests.find((r) => /^\s*SELECT/i.test(r.sql) && /FROM\s+"sessions"/i.test(r.sql));
		expect(select?.sql).toMatch(/ORDER\s+BY\s+creation_date\s+ASC/i);
		expect(select?.sql).toContain("conversations/sess-1");
		// Scoped to the requesting org/workspace (the partition the query went out under).
		expect(select?.org).toBe(ORG);
		expect(select?.workspace).toBe(WORKSPACE);
	});

	it("rejects a read-back missing the org scope with 400 (no unscoped read)", async () => {
		const { daemon } = buildDaemon();
		const res = await daemon.app.request("/api/hooks/conversation?path=conversations/sess-1", {
			headers: {
				"x-honeycomb-runtime-path": "plugin",
				"x-honeycomb-session": "sess-1",
				// no x-honeycomb-org
			},
		});
		expect(res.status).toBe(400);
	});
});

// ── Boundary + seam tests ──────────────────────────────────────────────────────

describe("boundary validation + seams", () => {
	it("rejects a malformed event at the zod boundary with 400", async () => {
		const { daemon, fake } = buildDaemon();
		const res = await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			// kind is not one of the three normalized kinds.
			body: JSON.stringify({ event: { kind: "nope", text: "x" }, metadata: userMessageBody().metadata }),
		});
		expect(res.status).toBe(400);
		// No write went out for an invalid event.
		expect(fake.requests.filter((r) => /INSERT/i.test(r.sql)).length).toBe(0);
	});

	it("rejects capture missing the runtime-path claim (session-scoped, 400 before the handler)", async () => {
		const { daemon, fake } = buildDaemon();
		const res = await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: { "content-type": "application/json", "x-honeycomb-org": ORG },
			body: JSON.stringify(userMessageBody()),
		});
		// 004d runtime-path middleware rejects (no x-honeycomb-runtime-path) BEFORE the handler.
		expect(res.status).toBe(400);
		expect(fake.requests.filter((r) => /INSERT/i.test(r.sql)).length).toBe(0);
	});

	it("calls the embed seam non-blocking after the INSERT (D-3 / b-AC-4 seam)", async () => {
		const attached: Array<{ target: EmbeddingTarget; vector: readonly number[] }> = [];
		let embedCalledWith = "";
		const settledPromises: Promise<void>[] = [];
		const embed: EmbedAttachment = {
			client: {
				async embed(text: string): Promise<readonly number[] | null> {
					embedCalledWith = text;
					return new Array(768).fill(0.1);
				},
			},
			attacher: {
				async attach(target: EmbeddingTarget, vector: readonly number[]): Promise<void> {
					attached.push({ target, vector });
				},
			},
		};
		const { daemon } = buildDaemon({
			embed,
			deps: { onEmbedSettled: (p) => settledPromises.push(p) },
		});
		const res = await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify(userMessageBody({ text: "embed me" })),
		});
		// The response returned WITHOUT awaiting the embed (the continuation settles after).
		expect(res.status).toBe(201);
		// Now drain the fire-and-forget continuation the handler exposed to the test.
		await Promise.all(settledPromises);
		expect(embedCalledWith).toBe("embed me");
		expect(attached.length, "005b's attach is called with the row id + vector").toBe(1);
		expect(attached[0].vector.length).toBe(768);
		expect(attached[0].target.scope.org).toBe(ORG);
	});

	it("a failing embed never breaks the capture (fail-soft seam, b-AC-3)", async () => {
		const settledPromises: Promise<void>[] = [];
		const embed: EmbedAttachment = {
			client: {
				async embed(): Promise<readonly number[] | null> {
					throw new Error("embed daemon unreachable");
				},
			},
			attacher: { async attach(): Promise<void> {} },
		};
		const { daemon } = buildDaemon({ embed, deps: { onEmbedSettled: (p) => settledPromises.push(p) } });
		const res = await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify(userMessageBody()),
		});
		expect(res.status, "capture still succeeds even though embed throws").toBe(201);
		// The continuation rejects internally but is caught — awaiting it never throws.
		await expect(Promise.all(settledPromises)).resolves.toBeDefined();
	});
});
