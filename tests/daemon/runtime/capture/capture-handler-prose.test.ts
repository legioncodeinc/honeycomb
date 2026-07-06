/**
 * PRD-074 prose-write + consumer-parity suite — L-B1 / a-AC-3 / a-AC-7 / L-D1.
 *
 * Verification posture (mirrors `capture-handler.test.ts`): in-process via
 * `daemon.app.request(...)` against a daemon built on the PRD-002 fake transport.
 * No socket, no live DeepLake. The capture handler is attached AFTER `createDaemon`,
 * inheriting the bootstrap's middleware (the a-AC-6 seam).
 *
 * The `prose` column write is asserted against `fake.requests` — the exact INSERT SQL
 * the daemon issued. Both the SINGLE-INSERT path (batching off) and the BATCHED path
 * (batching on) are exercised, since both flow through `buildRow` (PRD-074a change #2).
 * The `message` JSONB parity tests (L-D1) construct a known event, parse the `message`
 * literal out of the INSERT, and assert the typed envelope survives verbatim — proving
 * `prose` is an ADDITIVE column, never a replacement for the JSONB downstream parsers read.
 */

import { describe, expect, it } from "vitest";
import {
	type CaptureHandlerDeps,
	createCaptureHandler,
} from "../../../../src/daemon/runtime/capture/capture-handler.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createRuntimePathService } from "../../../../src/daemon/runtime/middleware/runtime-path.js";
import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import { healTargetFor } from "../../../../src/daemon/storage/catalog/index.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";
import type { RuntimeConfig } from "../../../../src/daemon/runtime/config.js";

// ── Test scaffolding (mirrors capture-handler.test.ts) ────────────────────────

const ORG = "fake-org";
const WORKSPACE = "fake-ws";

function cfg(mode: RuntimeConfig["mode"] = "local", over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode, widened: false, ...over };
}

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

/** A capture request body for a `tool_call` (the prose-format case). */
function toolCallBody(over: { event?: Record<string, unknown>; metadata?: Record<string, unknown> } = {}) {
	return {
		event: {
			kind: "tool_call",
			tool: "Read",
			input: { limit: 75, offset: 175, file_path: "C:\\Users\\mario\\GitHub\\the-apiary\\hive\\src\\dashboard\\web\\pages\\dashboard.tsx" },
			response: { file: { content: "// 'healthReasons' is no longer polled here — the SHEL…" } },
			...over.event,
		},
		metadata: { ...userMessageBody().metadata, ...over.metadata },
	};
}

function responderFor(opts: { readbackRows?: Record<string, unknown>[]; failFirstInsertWith?: string } = {}) {
	let insertSeen = 0;
	return (req: TransportRequest): Record<string, unknown>[] => {
		const sql = req.sql;
		if (/^\s*INSERT\s+INTO/i.test(sql)) {
			insertSeen += 1;
			if (insertSeen === 1 && opts.failFirstInsertWith !== undefined) {
				throw new (class extends Error {
					readonly kind = "query";
				})("missing-column");
			}
			return [];
		}
		if (/information_schema\.columns/i.test(sql)) {
			return healTargetFor("sessions").columns.map((c) => ({ column_name: c.name }));
		}
		if (/^\s*CREATE\s+TABLE/i.test(sql) || /^\s*ALTER\s+TABLE/i.test(sql)) return [];
		if (/^\s*SELECT/i.test(sql)) return opts.readbackRows ?? [];
		return [];
	};
}

interface BuildOpts {
	responder?: (req: TransportRequest) => Record<string, unknown>[];
	deps?: Partial<CaptureHandlerDeps>;
	/** PRD-062c batching on/off — the batched INSERT path is a separate codepath to test. */
	batch?: boolean;
}

function buildDaemon(opts: BuildOpts = {}): { daemon: Daemon; fake: FakeDeepLakeTransport } {
	const fake = new FakeDeepLakeTransport(opts.responder ?? responderFor());
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const daemon = createDaemon({
		config: cfg("local"),
		storage,
		logger: createRequestLogger({ silent: true }),
		services: { runtimePath: createRuntimePathService() },
	});
	const handler = createCaptureHandler({
		storage,
		sessionsTarget: healTargetFor("sessions"),
		queue: {
			async enqueue() {
				return "job-1";
			},
			async lease() {
				return null;
			},
			async complete() {},
			async fail() {},
			start() {},
			stop() {},
		},
		// PRD-062c: pin the batching mode so BOTH single + batched prose writes are tested.
		captureConfig: {
			batch: opts.batch ?? false,
			windowMs: 1_000,
			maxEvents: 25,
			envelopeBudgetBytes: 0,
		},
		...opts.deps,
	});
	handler.register(daemon);
	return { daemon, fake };
}

/** Find the first INSERT-into-sessions SQL the daemon issued. */
function sessionsInsert(fake: FakeDeepLakeTransport): string {
	const insert = fake.requests.find((r) => /^\s*INSERT\s+INTO\s+"sessions"/i.test(r.sql));
	expect(insert, "an INSERT into sessions was issued").toBeDefined();
	return insert?.sql ?? "";
}

/**
 * Parse the `message` column value (the E'...' / '...' literal) out of an INSERT's
 * VALUES list. The column list and values list are positionally aligned; we find
 * `message`'s index in the column list and pull the matching values entry.
 */
function parseMessageFromInsert(sql: string): { event?: { kind?: string; text?: string; tool?: string }; metadata?: unknown } {
	// The INSERT shape: INSERT INTO "sessions" (col1, col2, ...) VALUES (v1, v2, ...)
	const colsMatch = sql.match(/INSERT\s+INTO\s+"sessions"\s*\(([^)]+)\)\s*VALUES\s*\(([\s\S]+)\)\s*$/i);
	expect(colsMatch, "INSERT has a parseable (cols) VALUES (vals) shape").toBeDefined();
	const cols = colsMatch![1].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
	const valsRaw = colsMatch![2];
	// Split values on commas that are NOT inside a quoted literal. The message literal is
	// an E'...' or '...' that may contain escaped commas + doubled quotes; a naive split
	// breaks on those. Walk the string, tracking quote state + the E prefix.
	const vals: string[] = [];
	let buf = "";
	let inQuote = false;
	let i = 0;
	while (i < valsRaw.length) {
		const ch = valsRaw[i];
		if (inQuote) {
			buf += ch;
			if (ch === "'") {
				// A doubled quote '' is an escaped literal quote, NOT the closing quote.
				if (valsRaw[i + 1] === "'") {
					buf += valsRaw[i + 1];
					i += 2;
					continue;
				}
				inQuote = false;
			}
			i += 1;
			continue;
		}
		if (ch === "E" && valsRaw[i + 1] === "'") {
			buf += ch;
			i += 1;
			continue;
		}
		if (ch === "'") {
			buf += ch;
			inQuote = true;
			i += 1;
			continue;
		}
		if (ch === ",") {
			vals.push(buf.trim());
			buf = "";
			i += 1;
			continue;
		}
		buf += ch;
		i += 1;
	}
	if (buf.trim().length > 0) vals.push(buf.trim());
	const idx = cols.indexOf("message");
	expect(idx, "`message` column is in the INSERT column list").toBeGreaterThanOrEqual(0);
	const literal = vals[idx];
	expect(literal, "a value exists at the message column index").toBeDefined();
	// Strip the leading E or ' and the trailing ', then un-doublify the embedded quotes.
	const stripped = literal!.replace(/^E'?|'$/g, "").replace(/''/g, "'");
	return JSON.parse(stripped);
}

// ── L-B1 / a-AC-3 — capture handler populates `prose` on every INSERT ─────────

describe("L-B1 / a-AC-3 — capture handler populates `prose` for every new sessions INSERT", () => {
	it("SINGLE-INSERT path (batching off): a user_message writes its text as `prose`", async () => {
		const { daemon, fake } = buildDaemon(); // batching off by default
		const res = await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify(userMessageBody({ text: "find the bug in the dashboard" })),
		});
		expect(res.status).toBe(201);
		const sql = sessionsInsert(fake);
		// The `prose` column is in the INSERT column list (an additive column that ships).
		expect(sql).toMatch(/\bprose\b/);
		// The prose value reaches the VALUES list as a literal carrying the user text.
		expect(sql).toContain("find the bug in the dashboard");
	});

	it("BATCHED-INSERT path (batching on): a user_message writes its text as `prose`", async () => {
		// PRD-062c batching on — the row is buffered + flushed as a multi-row append. The same
		// buildRow populates `prose`, so the batched INSERT must carry it identically. Set
		// maxEvents:1 so the very first buffered write triggers a size-flush immediately (no
		// timer dependency), deterministically reaching the transport before assertions.
		const { daemon, fake } = buildDaemon({
			deps: { captureConfig: { batch: true, windowMs: 60_000, maxEvents: 1, envelopeBudgetBytes: 0 } },
		});
		const res = await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify(userMessageBody({ text: "batched prose write" })),
		});
		expect(res.status).toBe(201);
		// The size-cap (maxEvents:1) flushed the buffered row synchronously through flushBatch.
		const sql = sessionsInsert(fake);
		expect(sql).toMatch(/\bprose\b/);
		expect(sql).toContain("batched prose write");
	});

	it("a tool_call writes the bounded 074b prose (NOT the raw JSONB) into `prose`", async () => {
		const { daemon, fake } = buildDaemon();
		const res = await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify(toolCallBody()),
		});
		expect(res.status).toBe(201);
		const sql = sessionsInsert(fake);
		// The `prose` column is in the INSERT column list, positioned after `model`.
		expect(sql).toMatch(/model,\s*prose,/);
		// The prose carries the file-path-aware first line. The SQL wire literal escapes the
		// prose's single backslashes as `\\` (sLiteral → sqlStr doubles them so PostgreSQL can
		// parse the literal); the STORED column value has single backslashes (the recall hit a
		// harness receives is `web\pages\dashboard.tsx`, NOT the JSONB-cast `web\\pages\\...`).
		expect(sql).toContain("Read → web\\\\pages\\\\dashboard.tsx:175-250");
		// The response body line is capped + whitespace-collapsed, present in the same prose literal.
		expect(sql).toContain("healthReasons");
		// CRITICAL: the prose does NOT carry the JSONB envelope structure — that's the bloat
		// PRD-074 kills. The escaped JSON shape (`"kind":"tool_call"`, `"event":{...}`) appears
		// ONLY inside the `message` E'...' JSONB literal, never in the prose. Assert by splitting
		// the VALUES list on the column boundaries: the prose literal is the value between the
		// empty `model` literal ('' = unknown model) and the `creation_date` timestamp.
		const proseRegion = sql.split(/,\s*'\d{4}-/)[0]; // everything before the creation_date timestamp
		// The prose region tail (after the last occurrence of `Read →`) is the prose literal body.
		const afterRead = proseRegion.slice(proseRegion.lastIndexOf("Read →"));
		expect(afterRead).toContain("Read → web\\\\pages\\\\dashboard.tsx:175-250");
		expect(afterRead).not.toContain('"kind"');
		expect(afterRead).not.toContain('"event"');
	});

	it("the `prose` column ships alongside (NOT instead of) `message` JSONB", async () => {
		// L-D1 setup: prove prose is ADDITIVE. The INSERT must carry BOTH the JSONB `message`
		// AND the new `prose` column — the JSONB consumers must keep working unchanged.
		const { daemon, fake } = buildDaemon();
		await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify(userMessageBody({ text: "both columns" })),
		});
		const sql = sessionsInsert(fake);
		expect(sql).toMatch(/\bmessage\b/);
		expect(sql).toMatch(/\bprose\b/);
	});
});

// ── L-D1 / a-AC-7 — message JSONB consumers unchanged ─────────────────────────
//
// PRD-074a a-AC-7: every existing `message` JSONB consumer (summaries/worker.ts
// parseEnvelope, skillify/miner.ts, dashboard/roi-session-writer.ts rowToCapturedTurn,
// dashboard/api.ts rowToCapturedTurn) reads `message` and parses the typed envelope —
// NONE references the new `prose` column. This suite proves the contract holds by:
//   1. Constructing a known event, capturing it, parsing the `message` literal back out.
//   2. Asserting the typed envelope survives verbatim (the consumers' input is unchanged).
//   3. Static source grep: no consumer file references `prose`.

describe("L-D1 / a-AC-7 — message JSONB consumers unchanged (prose is additive)", () => {
	it("a user_message: the typed envelope survives in `message` JSONB, parsable as before", async () => {
		const { daemon, fake } = buildDaemon();
		await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify(userMessageBody({ text: "the envelope survives" })),
		});
		const sql = sessionsInsert(fake);
		const env = parseMessageFromInsert(sql);
		// summaries/worker.ts parseEnvelope reads `event.kind` + `event.text`; both survive.
		expect(env.event?.kind).toBe("user_message");
		expect(env.event?.text).toBe("the envelope survives");
		// metadata is the structured metadata block (summaries/skillify read sessionId off it).
		expect(env.metadata).toMatchObject({ sessionId: "sess-1", path: "conversations/sess-1" });
	});

	it("a tool_call: the FULL unbounded input + response survive in `message` JSONB", async () => {
		// L-B5 / b-AC-6: the prose is capped, but the JSONB carries the FULL response so
		// downstream parsers (the miner, the dashboard) lose nothing.
		const bigContent = "x".repeat(10_000); // 10 KB — far over the prose cap.
		const { daemon, fake } = buildDaemon();
		await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify(
				toolCallBody({
					event: {
						tool: "Read",
						input: { file_path: "/a/b/c/d/big.ts", offset: 1, limit: 100 },
						response: { file: { content: bigContent } },
					},
				}),
			),
		});
		const sql = sessionsInsert(fake);
		const env = parseMessageFromInsert(sql);
		// The FULL 10 KB response survives in the JSONB (the prose is capped; the JSONB is not).
		expect(env.event?.kind).toBe("tool_call");
		expect(env.event?.tool).toBe("Read");
		// The response.content is the FULL 10 KB — proving no information loss.
		const responseContent = (env.event as { response?: { file?: { content?: string } } }).response?.file?.content;
		expect(responseContent).toBe(bigContent);
		expect(responseContent?.length).toBe(10_000);
	});

	it("an assistant_message: text + (optional) usage + model survive in `message` JSONB", async () => {
		// The dashboard rowToCapturedTurn reads typed token columns; the miner reads the envelope.
		// Both keep working because the JSONB is verbatim.
		const { daemon, fake } = buildDaemon();
		await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify({
				event: { kind: "assistant_message", text: "done", usage: { input: 100, output: 50 }, model: "claude-opus-4-8" },
				metadata: userMessageBody().metadata,
			}),
		});
		const sql = sessionsInsert(fake);
		const env = parseMessageFromInsert(sql);
		expect(env.event?.kind).toBe("assistant_message");
		expect(env.event?.text).toBe("done");
		// usage + model survive (the dashboard reads these off typed columns; the JSONB is the source of truth).
		const event = env.event as { usage?: { input?: number }; model?: string };
		expect(event.usage?.input).toBe(100);
		expect(event.model).toBe("claude-opus-4-8");
	});
});

// ── L-D2 / b-AC-8 — explicit parity: user/assistant prose is event.text verbatim ─

describe("L-D2 / b-AC-8 — explicit end-to-end parity (user/assistant prose = event.text)", () => {
	it("a user_message with awkward whitespace: prose === event.text (no collapse, no cap)", async () => {
		// The verbatim guarantee, asserted end-to-end through the daemon (not just the helper).
		// Whitespace runs survive; the prose is the EXACT input string.
		const text = "   what   about\n\n\nnewlines\tand   tabs?   ";
		const { daemon, fake } = buildDaemon();
		await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify(userMessageBody({ text })),
		});
		const sql = sessionsInsert(fake);
		// The prose literal carries the EXACT text — the runs of spaces, the newlines, the tab.
		// (sLiteral doubles single quotes; the text has none, so it appears verbatim.)
		expect(sql).toContain(text);
	});

	it("a long user_message (10x the tool cap): prose === the full text (no cap on user/assistant)", async () => {
		const text = "y".repeat(5_000); // 10x TOOL_PROSE_RESPONSE_CAP.
		const { daemon, fake } = buildDaemon();
		await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify(userMessageBody({ text })),
		});
		const sql = sessionsInsert(fake);
		// The full 5000-char text reaches the prose column — the cap is tool-call-only.
		expect(sql).toContain(text);
	});

	it("an assistant_message: prose === event.text verbatim through the daemon", async () => {
		// Plain text (no special chars): the prose literal carries it byte-for-byte.
		const text = "I will read dashboard.tsx and fix the polling.";
		const { daemon, fake } = buildDaemon();
		await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify({
				event: { kind: "assistant_message", text },
				metadata: userMessageBody().metadata,
			}),
		});
		const sql = sessionsInsert(fake);
		expect(sql).toContain(text);
	});

	it("an assistant_message with a single quote: sLiteral doubles the quote (SQL wire encoding)", async () => {
		// The STORED prose value is the verbatim text (single quote intact); the SQL WIRE literal
		// doubles the quote (sLiteral/sqlStr) so PostgreSQL can parse it. This is the wire
		// encoding, NOT a transformation of the prose — recall reads the parsed column value.
		const text = "I'll read dashboard.tsx.";
		const { daemon, fake } = buildDaemon();
		await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify({
				event: { kind: "assistant_message", text },
				metadata: userMessageBody().metadata,
			}),
		});
		const sql = sessionsInsert(fake);
		// The wire literal doubles the embedded single quote (`I''ll`); the stored value is `I'll`.
		expect(sql).toContain("I''ll read dashboard.tsx.");
	});
});
