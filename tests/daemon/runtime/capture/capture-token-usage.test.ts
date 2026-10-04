/**
 * PRD-060a — Token & Cache Usage Capture: the PERSIST half (capture write path).
 *
 *   - a-AC-5 — token counts persist on the SAME append-only INSERT as the turn
 *     (no second write, no row mutation); the count is queryable on the row.
 *   - a-AC-6 (REVERSED 2026-07-16) — the storage scalar is non-nullable, so EVERY row
 *     writes all four token columns: the measured value when present, else 0. An absent
 *     count collapses to 0 (a measured 0 and an absent count are indistinguishable).
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
		// PRD-062c (merged after 060a) defaults capture write-batching ON (rows buffer and
		// flush as a multi-row append). These a-AC-* tests assert the per-turn token columns
		// ride ONE synchronous append-only INSERT — the pre-062c / flags-OFF parity path
		// (AC-9), identical token-column behavior. Pin batching off so the single-INSERT
		// assertions hold (same pattern as capture-handler.test.ts).
		captureConfig: { batch: false, windowMs: 1_000, maxEvents: 25, envelopeBudgetBytes: 0 },
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

/**
 * Parse an INSERT INTO "sessions" (cols) VALUES (vals) into a column->value map so a test can tie an
 * assertion to a SPECIFIC column slot (not a free-floating substring an unrelated value could satisfy).
 */
function insertColumnValues(sql: string): Record<string, string> {
	const m = /INSERT INTO "sessions" \(([^)]*)\) VALUES \((.*)\)\s*$/s.exec(sql);
	if (m === null) return {};
	const cols = m[1].split(",").map((c) => c.trim());
	const vals: string[] = [];
	let depth = 0;
	let inStr = false; // inside a single-quoted SQL string literal (skip commas there)
	let cur = "";
	const body = m[2];
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch === "'") {
			// A doubled '' is an escaped quote INSIDE the string, not a terminator.
			if (inStr && body[i + 1] === "'") {
				cur += "''";
				i++;
				continue;
			}
			inStr = !inStr;
			cur += ch;
			continue;
		}
		if (!inStr && ch === "(") depth++;
		if (!inStr && ch === ")") depth--;
		if (!inStr && ch === "," && depth === 0) {
			vals.push(cur.trim());
			cur = "";
		} else {
			cur += ch;
		}
	}
	if (cur.trim() !== "") vals.push(cur.trim());
	const out: Record<string, string> = {};
	cols.forEach((c, i) => {
		out[c] = vals[i] ?? "";
	});
	return out;
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

	it("a-AC-6 a measured 0 is written as the literal 0", async () => {
		const { daemon, fake } = buildDaemon();
		await post(daemon, assistantBody({ input: 100, output: 50, cacheRead: 0, cacheCreation: 0 }));
		const sql = insertSql(fake);
		// The cache columns are present and carry the literal 0 (a real measurement), NOT NULL/absent.
		expect(sql).toMatch(/cache_read_input_tokens/);
		expect(sql).toMatch(/cache_creation_input_tokens/);
		// Finding (zero-assert): tie the measured-zero to the SPECIFIC cache column slots. The old
		// VALUES(...0...) match could false-pass on an unrelated 0 (e.g. the "0.1.0" pluginVersion).
		const cv = insertColumnValues(sql);
		expect(cv.cache_read_input_tokens, "cache_read slot carries a literal 0").toBe("0");
		expect(cv.cache_creation_input_tokens, "cache_creation slot carries a literal 0").toBe("0");
	});
});

describe("PRD-060a a-AC-6: absent usage → SQL NULL columns, kept distinct from a measured 0", () => {
	it("an assistant turn with NO usage writes all four token columns as NULL", async () => {
		const { daemon, fake } = buildDaemon();
		const res = await post(daemon, assistantBody());
		expect(res.status).toBe(201);
		// All four token columns are present on the INSERT (batch-consistent) and carry NULL.
		const cv = insertColumnValues(insertSql(fake));
		expect(cv.input_tokens, "input_tokens absent → NULL").toBe("NULL");
		expect(cv.output_tokens, "output_tokens absent → NULL").toBe("NULL");
		expect(cv.cache_read_input_tokens, "cache_read absent → NULL").toBe("NULL");
		expect(cv.cache_creation_input_tokens, "cache_creation absent → NULL").toBe("NULL");
	});

	it("a partial usage block writes the present counts and NULLs the absent ones", async () => {
		const { daemon, fake } = buildDaemon();
		await post(daemon, assistantBody({ input: 42, output: 7 }));
		const cv = insertColumnValues(insertSql(fake));
		expect(cv.input_tokens, "measured input").toBe("42");
		expect(cv.output_tokens, "measured output").toBe("7");
		// The absent cache counts are SQL NULL (the column is nullable), never a silent 0.
		expect(cv.cache_read_input_tokens, "absent cache_read → NULL").toBe("NULL");
		expect(cv.cache_creation_input_tokens, "absent cache_creation → NULL").toBe("NULL");
	});

	// An EMPTY usage block (usage: {}) carries no counts; every column is absent → NULL,
	// kept distinct from a measured 0.
	it("empty-usage: an empty usage block NULLs all four token columns", async () => {
		const { daemon, fake } = buildDaemon();
		const res = await post(daemon, assistantBody({}));
		expect(res.status).toBe(201);
		const cv = insertColumnValues(insertSql(fake));
		expect(cv.input_tokens).toBe("NULL");
		expect(cv.output_tokens).toBe("NULL");
		expect(cv.cache_read_input_tokens).toBe("NULL");
		expect(cv.cache_creation_input_tokens).toBe("NULL");
	});

	it("a non-assistant turn (user_message) also NULLs the token columns", async () => {
		const { daemon, fake } = buildDaemon();
		await post(daemon, {
			event: { kind: "user_message", text: "hi" },
			metadata: assistantBody().metadata,
		});
		const cv = insertColumnValues(insertSql(fake));
		expect(cv.input_tokens, "non-assistant input_tokens → NULL").toBe("NULL");
		expect(cv.cache_read_input_tokens, "non-assistant cache_read → NULL").toBe("NULL");
	});
});

describe("PRD-060a a-AC-7: every Claude-Code-captured row carries source_tool='claude-code'", () => {
	it("a-AC-7 the source_tool discriminant is written from the canonical harness token", async () => {
		const { daemon, fake } = buildDaemon();
		await post(daemon, assistantBody({ input: 1 }));
		const sql = insertSql(fake);
		expect(sql).toMatch(/source_tool/);
		// Finding (source-tool-assert): tie the value to the source_tool COLUMN slot. The `agent`
		// metadata value is ALSO "claude-code", so a bare toContain passes even if source_tool were
		// never written -- assert the source_tool slot specifically carries the discriminant.
		const cv = insertColumnValues(sql);
		expect(cv.source_tool, "source_tool slot carries the claude-code discriminant").toBe("'claude-code'");
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
