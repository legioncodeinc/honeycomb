/**
 * PRD-060 ROI capture fix — the END-TO-END test that would have caught the bug.
 *
 * Drives the REAL Claude Code shim from a REAL on-disk transcript (NOT an injected capture body —
 * that injection is exactly what masked the bug), then POSTs the shim's normalized event through the
 * in-process daemon capture handler and asserts the persisted `sessions` INSERT carries BOTH the
 * cache_read tokens AND the model id. Before the fix, the `Stop` payload carried neither, the shim
 * read `usage` off the (empty) payload, and the row persisted NULL token columns + no model — the
 * dashboard's ZERO measured savings. This test fails on that regression.
 *
 * In-process via `daemon.app.request(...)` against the PRD-002 fake transport, the same posture as
 * `capture-token-usage.test.ts`. The written SQL is asserted against `fake.requests`.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createClaudeCodeShim, type HookInput } from "../../../../src/hooks/index.js";
import { healTargetFor } from "../../../../src/daemon/storage/catalog/index.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
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
		"x-honeycomb-runtime-path": "legacy",
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

function responder() {
	return (req: TransportRequest): Record<string, unknown>[] => {
		const sql = req.sql;
		if (/^\s*INSERT\s+INTO/i.test(sql)) return [];
		if (/information_schema\.columns/i.test(sql)) {
			return healTargetFor("sessions").columns.map((c) => ({ column_name: c.name }));
		}
		if (/^\s*CREATE\s+TABLE/i.test(sql) || /^\s*ALTER\s+TABLE/i.test(sql)) return [];
		return [];
	};
}

function buildDaemon(): { daemon: Daemon; fake: FakeDeepLakeTransport } {
	const fake = new FakeDeepLakeTransport(responder());
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
		// Pin batching off so the single synchronous INSERT is assertable (parity with the 060a suite).
		captureConfig: { batch: false, windowMs: 1_000, maxEvents: 25, envelopeBudgetBytes: 0 },
	});
	handler.register(daemon);
	return { daemon, fake };
}

/** Parse an INSERT INTO "sessions" (cols) VALUES (vals) into a column->value map (slot-precise asserts). */
function insertColumnValues(sql: string): Record<string, string> {
	const m = /INSERT INTO "sessions" \(([^)]*)\) VALUES \((.*)\)\s*$/s.exec(sql);
	if (m === null) return {};
	const cols = m[1].split(",").map((c) => c.trim());
	const vals: string[] = [];
	let depth = 0;
	let inStr = false;
	let cur = "";
	const body = m[2];
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch === "'") {
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

const reference = createClaudeCodeShim();
let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "hc-transcript-"));
});
afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

/**
 * Write a real Claude Code transcript JSONL to disk and return its path. Two Opus assistant entries
 * under one user prompt (a tool-use round + the final), exactly the multi-entry-per-turn shape.
 */
function writeOpusTranscript(): string {
	const path = join(tmpDir, "transcript.jsonl");
	const lines = [
		JSON.stringify({ type: "user", message: { role: "user", content: "refactor the rate table" } }),
		JSON.stringify({
			type: "assistant",
			message: {
				model: "claude-opus-4-8",
				usage: { input_tokens: 1200, output_tokens: 40, cache_read_input_tokens: 5000, cache_creation_input_tokens: 64 },
			},
		}),
		JSON.stringify({
			type: "assistant",
			message: {
				model: "claude-opus-4-8",
				usage: { input_tokens: 300, output_tokens: 110, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 },
			},
		}),
	];
	writeFileSync(path, lines.join("\n"), "utf8");
	return path;
}

/** The metadata a Stop-hook capture carries (the daemon-side `CaptureMetadata` shape). */
function metadataFor(transcriptPath: string) {
	return {
		sessionId: "sess-1",
		path: transcriptPath, // the binary driver groups by `transcript_path` → this is `meta.path`.
		cwd: "/repo",
		permissionMode: "default",
		hookEventName: "Stop",
		agentId: "agent-7",
		org: ORG,
		workspace: WORKSPACE,
		agent: "claude-code",
		pluginVersion: "0.1.0",
	};
}

async function post(daemon: Daemon, body: unknown): Promise<Response> {
	return daemon.app.request("/api/hooks/capture", {
		method: "POST",
		headers: sessionHeaders(),
		body: JSON.stringify(body),
	});
}

describe("PRD-060 end-to-end: a transcript-backed Stop persists cache_read tokens + model", () => {
	it("drives the REAL shim from a REAL transcript → the row carries summed cache_read + the Opus model", async () => {
		const transcriptPath = writeOpusTranscript();
		const { daemon, fake } = buildDaemon();

		// Drive the REAL Claude Code shim: a `Stop` payload with NO usage/model (the real hook shape).
		// `meta.path` is the transcript path the binary driver derived, so the shim reads usage+model
		// from the TRANSCRIPT — not the payload. This is the production path the bug lived on.
		const input = reference.normalize(
			{ name: "Stop", payload: { text: "done" } },
			{ sessionId: "sess-1", path: transcriptPath },
		) as HookInput;

		// The shim produced a capture event carrying the SUMMED usage + the last entry's model.
		expect(input.data).toEqual({
			kind: "assistant_message",
			text: "done",
			usage: { input: 1500, output: 150, cacheRead: 8000, cacheCreation: 64 },
			model: "claude-opus-4-8",
		});

		// Persist it through the daemon exactly as the hook runtime would (event + metadata).
		const res = await post(daemon, { event: input.data, metadata: metadataFor(transcriptPath) });
		expect(res.status).toBe(201);

		const insert = fake.requests.find((r) => /^\s*INSERT\s+INTO\s+"sessions"/i.test(r.sql));
		expect(insert).toBeDefined();
		const cv = insertColumnValues(insert?.sql ?? "");
		// The headline lever: cache_read tokens are PRESENT and carry the summed value (not NULL).
		expect(cv.cache_read_input_tokens, "cache_read_input_tokens slot carries 8000").toBe("8000");
		expect(cv.input_tokens).toBe("1500");
		expect(cv.output_tokens).toBe("150");
		// A measured 0 cache_creation survives across the two entries (64 + 0 = 64).
		expect(cv.cache_creation_input_tokens).toBe("64");
		// The model column carries the real Opus id (so the dashboard prices at the Opus rate).
		expect(cv.model, "model slot carries the Opus id").toBe("'claude-opus-4-8'");
		expect(cv.source_tool).toBe("'claude-code'");
	});

	it("a Stop whose transcript is missing degrades to NO usage + blank model (fail-soft, capture proceeds)", async () => {
		const { daemon, fake } = buildDaemon();
		// `meta.path` points at a path that is NOT a real transcript file (the in-process grouping key).
		const input = reference.normalize(
			{ name: "Stop", payload: { text: "done" } },
			{ sessionId: "sess-1", path: "conversations/sess-1" },
		) as HookInput;
		// No usage, no model — the field is ABSENT, not zero-filled (the pre-fix degrade, preserved).
		expect(input.data).toEqual({ kind: "assistant_message", text: "done" });

		const res = await post(daemon, { event: input.data, metadata: metadataFor("conversations/sess-1") });
		expect(res.status).toBe(201);
		const insert = fake.requests.find((r) => /^\s*INSERT\s+INTO\s+"sessions"/i.test(r.sql));
		const sql = insert?.sql ?? "";
		// a-AC-6 reversed: absent usage zero-fills the token columns (non-nullable scalar); model
		// writes the '' default (model unknown).
		const cv = insertColumnValues(sql);
		expect(cv.cache_read_input_tokens, "absent cache_read → 0").toBe("0");
		expect(cv.model, "absent model writes the '' default").toBe("''");
	});
});
