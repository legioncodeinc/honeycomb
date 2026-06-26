/**
 * PRD-060a — Token & Cache Usage Capture: the PERSIST half (capture write path).
 *
 *   - a-AC-5 — token counts persist on the SAME append-only INSERT as the turn
 *     (no second write, no row mutation); the count is queryable on the row.
 *   - a-AC-6 — a turn WITHOUT usage, or with absent counts, writes NO token column
 *     (the nullable column stays SQL NULL = "token data absent"), never a silent 0;
 *     a genuine measured 0 IS written.
 *   - a-AC-7 — every Claude-Code-captured row carries `source_tool='claude-code'`.
 *   - a-AC-4 — a dataset missing the columns degrades gracefully: capture proceeds
 *     and heals the columns WITHOUT throwing.
 *
 * In-process via `daemon.app.request(...)` against the PRD-002 fake transport, the
 * same posture as `capture-handler.test.ts`. The written SQL is asserted against
 * `fake.requests` (the exact INSERT that went out).
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
import { createCaptureHandler } from "../../../../src/daemon/runtime/capture/capture-handler.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const ORG = "fake-org";
const WORKSPACE = "fake-ws";

function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false, ...over };
}

function sessionHeaders(): Record<string, string> {
	return {
		"content-type": "application/json",
		"x-honeycomb-runtime-path": "plugin",
		"x-honeycomb-session": "sess-1",
		"x-honeycomb-org": ORG,
		"x-honeycomb-workspace": WORKSPACE,
	};
}

class RecordingQueue implements JobQueueService {
	readonly enqueued: JobInput[] = [];
	async enqueue(job: JobInput): Promise<string> {
		this.enqueued.push(job);
		return `job-${this.enqueued.length}`;
	}
	async lease(): Promise<LeasedJob | null> {
		return null;
	}
	async complete(): Promise<void> {}
	async fail(): Promise<void> {}
	start(): void {}
	stop(): void {}
}

function responderFor(opts: { failFirstInsertWith?: string } = {}) {
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
			return healTargetFor("sessions").columns.map((c) => ({ column_name: c.name }));
		}
		if (/^\s*CREATE\s+TABLE/i.test(sql) || /^\s*ALTER\s+TABLE/i.test(sql)) return [];
		if (/^\s*SELECT/i.test(sql)) return [];
		return [];
	};
}

function buildDaemon(opts: { responder?: (req: TransportRequest) => Record<string, unknown>[] } = {}): {
	daemon: Daemon;
	fake: FakeDeepLakeTransport;
} {
	const fake = new FakeDeepLakeTransport(opts.responder ?? responderFor());
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const daemon = createDaemon({
		config: cfg(),
		storage,
		logger: createRequestLogger({ silent: true }),
		services: { runtimePath: createRuntimePathService() },
	});
	const handler = createCaptureHandler({
		storage,
		sessionsTarget: healTargetFor("sessions"),
		queue: new RecordingQueue(),
	});
	handler.register(daemon);
	return { daemon, fake };
}

/**
 * An assistant-turn capture body, optionally carrying a NORMALIZED `usage` block.
 * The capture body is the POST-shim shape, so usage keys are the contract's
 * normalized names (`input`/`output`/`cacheRead`/`cacheCreation`), not the
 * snake_case transcript field names the shim lowers from.
 */
function assistantBody(usage?: Partial<Record<"input" | "output" | "cacheRead" | "cacheCreation", number>>) {
	return {
		event: { kind: "assistant_message", text: "done", ...(usage !== undefined ? { usage } : {}) },
		metadata: {
			sessionId: "sess-1",
			path: "conversations/sess-1",
			cwd: "/repo",
			permissionMode: "default",
			hookEventName: "Stop",
			agentId: "agent-7",
			org: ORG,
			workspace: WORKSPACE,
			agent: "claude-code",
			pluginVersion: "0.1.0",
		},
	};
}

async function post(daemon: Daemon, body: unknown): Promise<Response> {
	return daemon.app.request("/api/hooks/capture", {
		method: "POST",
		headers: sessionHeaders(),
		body: JSON.stringify(body),
	});
}

function insertSql(fake: FakeDeepLakeTransport): string {
	const insert = fake.requests.find((r) => /^\s*INSERT\s+INTO\s+"sessions"/i.test(r.sql));
	expect(insert).toBeDefined();
	return insert?.sql ?? "";
}

describe("PRD-060a a-AC-5: token counts persist on the SAME append-only INSERT as the turn", () => {
	it("a-AC-5 the four counts ride the one INSERT — no second write, no UPDATE", async () => {
		const { daemon, fake } = buildDaemon();
		const res = await post(
			daemon,
			assistantBody({ input: 1200, output: 350, cacheRead: 8000, cacheCreation: 64 }),
		);
		expect(res.status).toBe(201);

		const inserts = fake.requests.filter((r) => /^\s*INSERT\s+INTO\s+"sessions"/i.test(r.sql));
		expect(inserts.length, "exactly one INSERT carries the counts").toBe(1);
		const updates = fake.requests.filter((r) => /^\s*UPDATE\s+"sessions"/i.test(r.sql));
		expect(updates.length, "append-only: never an UPDATE to attach counts").toBe(0);

		const sql = inserts[0].sql;
		// The four token columns AND their values are on the single INSERT, queryable on the row.
		expect(sql).toMatch(/input_tokens/);
		expect(sql).toMatch(/output_tokens/);
		expect(sql).toMatch(/cache_read_input_tokens/);
		expect(sql).toMatch(/cache_creation_input_tokens/);
		expect(sql).toContain("1200");
		expect(sql).toContain("350");
		expect(sql).toContain("8000");
		expect(sql).toContain("64");
	});

	it("a-AC-6 a genuine measured 0 IS written (zero ≠ absent)", async () => {
		const { daemon, fake } = buildDaemon();
		await post(daemon, assistantBody({ input: 100, output: 50, cacheRead: 0, cacheCreation: 0 }));
		const sql = insertSql(fake);
		// The cache columns are present and carry the literal 0 (a real measurement), NOT NULL/absent.
		expect(sql).toMatch(/cache_read_input_tokens/);
		expect(sql).toMatch(/cache_creation_input_tokens/);
		// Pull the VALUES tuple and assert the measured zeros are inlined.
		expect(sql).toMatch(/VALUES\s*\(.*\b0\b.*\)/s);
	});
});

describe("PRD-060a a-AC-6: absent usage → NULL token columns, never a silent 0", () => {
	it("a-AC-6 an assistant turn with NO usage writes NO token columns (they default to NULL)", async () => {
		const { daemon, fake } = buildDaemon();
		const res = await post(daemon, assistantBody());
		expect(res.status).toBe(201);
		const sql = insertSql(fake);
		// None of the four token columns appear in the INSERT column list → they stay SQL NULL.
		expect(sql).not.toMatch(/input_tokens/);
		expect(sql).not.toMatch(/output_tokens/);
		expect(sql).not.toMatch(/cache_read_input_tokens/);
		expect(sql).not.toMatch(/cache_creation_input_tokens/);
	});

	it("a-AC-6 a partial usage block writes ONLY the present counts, omitting the absent ones", async () => {
		const { daemon, fake } = buildDaemon();
		await post(daemon, assistantBody({ input: 42, output: 7 }));
		const sql = insertSql(fake);
		expect(sql).toMatch(/input_tokens/);
		expect(sql).toMatch(/output_tokens/);
		// The absent cache counts are NOT written (stay NULL), never zero-filled.
		expect(sql).not.toMatch(/cache_read_input_tokens/);
		expect(sql).not.toMatch(/cache_creation_input_tokens/);
		expect(sql).toContain("42");
	});

	it("a-AC-6 a non-assistant turn (user_message) carries no token columns", async () => {
		const { daemon, fake } = buildDaemon();
		await post(daemon, {
			event: { kind: "user_message", text: "hi" },
			metadata: assistantBody().metadata,
		});
		const sql = insertSql(fake);
		expect(sql).not.toMatch(/input_tokens/);
		expect(sql).not.toMatch(/cache_read_input_tokens/);
	});
});

describe("PRD-060a a-AC-7: every Claude-Code-captured row carries source_tool='claude-code'", () => {
	it("a-AC-7 the source_tool discriminant is written from the canonical harness token", async () => {
		const { daemon, fake } = buildDaemon();
		await post(daemon, assistantBody({ input: 1 }));
		const sql = insertSql(fake);
		expect(sql).toMatch(/source_tool/);
		expect(sql).toContain("claude-code");
	});
});

describe("PRD-060a a-AC-4: a dataset missing the columns degrades gracefully (heal, not throw)", () => {
	it("a-AC-4 capture proceeds and heals on a missing-column/table error without throwing", async () => {
		const { daemon, fake } = buildDaemon({
			responder: responderFor({ failFirstInsertWith: 'relation "sessions" does not exist' }),
		});
		const res = await post(daemon, assistantBody({ input: 5, cacheRead: 0 }));
		// Capture still succeeds after the heal-and-retry — the daemon never threw.
		expect(res.status).toBe(201);
		const creates = fake.requests.filter((r) => /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"sessions"/i.test(r.sql));
		expect(creates.length, "missing table healed (the new columns ride the CREATE)").toBe(1);
		// The healed CREATE carries the additive token + source_tool columns from the single source.
		expect(creates[0].sql).toMatch(/cache_read_input_tokens BIGINT/);
		expect(creates[0].sql).toMatch(/source_tool TEXT NOT NULL DEFAULT ''/);
		// Exactly two INSERT attempts: the failing first + the retried one.
		const inserts = fake.requests.filter((r) => /^\s*INSERT\s+INTO\s+"sessions"/i.test(r.sql));
		expect(inserts.length).toBe(2);
	});
});
