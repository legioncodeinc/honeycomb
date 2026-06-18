/**
 * VERTICAL-SLICE COMPOSITION TEST — the hook→daemon→storage capture round-trip.
 *
 * ── WHY THIS FILE EXISTS ─────────────────────────────────────────────────────
 * The entire 001–020 build was constructed-and-tested BEHIND SEAMS, with runtime
 * ASSEMBLY deferred. Every surface was proven against a *fake of its neighbor*:
 * the hook core against `createFakeDaemonHookClient`, the daemon capture handler
 * against a hand-rolled request body. NOTHING proved the REAL surfaces COMPOSE.
 *
 * This is that proof — ONE honest end-to-end slice with every unit REAL except the
 * two allowed fakes: storage (a `FakeDeepLakeTransport`, the same double the
 * daemon's own suites use) and the transport adapter
 * (`tests/composition/daemon-hook-client.ts`), which IS the documented deferred
 * transport glue. The chain:
 *
 *   native Claude-Code event
 *     → REAL `createClaudeCodeShim()` + `src/hooks/normalize.ts` engine  (normalize)
 *     → REAL `runCapture(input, deps, env)`  (`src/hooks/shared/capture.ts`)
 *     → REAL authored `DaemonHookClient` → `daemon.app.request("/api/hooks/capture")`
 *     → REAL runtime-path + permission middleware (in-process, no socket)
 *     → REAL `attachHooksHandlers(daemon, { storage, queue })` capture handler
 *     → REAL `appendOnlyInsert` → REAL storage (fake transport)
 *     → read the row back via the REAL `/api/hooks/conversation` route.
 *
 * ── WHAT IS ASSERTED (composition facts no unit test covers) ─────────────────
 *  1. A Claude-Code `UserPromptSubmit` native event, run through the real shim +
 *     core, causes the real handler to write exactly ONE real `sessions` row
 *     carrying the normalized fields (session id, hook event name, cwd, the
 *     message payload), and reading it back BY PATH returns the captured turn.
 *  2. The `x-honeycomb-runtime-path: legacy` header the shim stamps reached the
 *     handler end-to-end (the 019b→daemon header contract composes).
 *  3. A SECOND runtime path (`plugin`) on the SAME session is rejected 409 by the
 *     REAL runtime-path middleware firing end-to-end — a composition fact no unit
 *     test covers (the unit suites use the no-op claim service).
 *
 * This file is a normal `*.test.ts` under `tests/composition/` → included by the
 * default `tests/**​/*.test.ts` glob, NOT excluded (only `tests/integration/**`
 * is), so it runs under `npm run ci`. It imports NOTHING from `daemon/storage`
 * into a hooks/shim module — the thin-client invariant stays green.
 */

import { describe, expect, it } from "vitest";

import { createStorageClient } from "../../src/daemon/storage/index.js";
import type { StorageRow } from "../../src/daemon/storage/result.js";
import type { TransportRequest } from "../../src/daemon/storage/transport.js";
import { SESSIONS_COLUMNS } from "../../src/daemon/storage/catalog/sessions-summaries.js";
import { healTargetFor } from "../../src/daemon/storage/catalog/index.js";
import type { HealTarget } from "../../src/daemon/storage/heal.js";
import { type RuntimeConfig } from "../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../src/daemon/runtime/server.js";
import { createRuntimePathService } from "../../src/daemon/runtime/middleware/runtime-path.js";
import type { JobInput, JobQueueService, LeasedJob } from "../../src/daemon/runtime/services/job-queue.js";
import { attachHooksHandlers } from "../../src/daemon/runtime/capture/attach.js";

import { createClaudeCodeShim } from "../../src/hooks/claude-code/shim.js";
import { runCapture } from "../../src/hooks/shared/index.js";
import type { CaptureGateEnv, HookCoreDeps, HookSessionMeta } from "../../src/hooks/shared/index.js";

import { createDaemonHookClient } from "./daemon-hook-client.js";

const ORG = "fake-org";
const WORKSPACE = "fake-ws";

function cfg(): RuntimeConfig {
	// `local` mode: the permission middleware is open (loopback single-user), so the
	// slice exercises the REAL runtime-path middleware (the part under test) without
	// needing a real authenticator. This mirrors the daemon's own attach + live suites.
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
}

/** A recording queue (the real handler enqueues per-turn cues into it). */
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

// ─────────────────────────────────────────────────────────────────────────────
// A round-trip storage double: a SQL-aware `FakeDeepLakeTransport` responder that
// answers introspection (so the table "exists" → no heal), STORES each real
// `sessions` INSERT it sees by parsing its `(cols) VALUES (vals)`, and serves the
// stored rows back on the `readAppendOrdered` SELECT — so the capture genuinely
// ROUND-TRIPS through the real INSERT + read-back path, not just reaches the wire.
// ─────────────────────────────────────────────────────────────────────────────

import { FakeDeepLakeTransport } from "../helpers/fake-deeplake.js";

/** Reverse the `sqlStr` escaping (`''`→`'`, `\\`→`\`) so a stored value round-trips. */
function unescapeSqlBody(body: string): string {
	let out = "";
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (ch === "'" && body[i + 1] === "'") {
			out += "'";
			i++;
		} else if (ch === "\\" && body[i + 1] === "\\") {
			out += "\\";
			i++;
		} else {
			out += ch;
		}
	}
	return out;
}

/** Split a SQL VALUES tuple into its top-level comma-separated items, respecting quotes. */
function splitValues(vals: string): string[] {
	const items: string[] = [];
	let depth = 0;
	let inStr = false;
	let cur = "";
	for (let i = 0; i < vals.length; i++) {
		const ch = vals[i];
		if (inStr) {
			cur += ch;
			if (ch === "'") {
				if (vals[i + 1] === "'") {
					cur += "'";
					i++;
				} else {
					inStr = false;
				}
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
			items.push(cur.trim());
			cur = "";
		} else {
			cur += ch;
		}
	}
	if (cur.trim().length > 0) items.push(cur.trim());
	return items;
}

/** Parse one SQL value token (`'…'`, `E'…'`, or a bare number) back to a JS value. */
function parseValue(token: string): string | number {
	if (token.startsWith("E'") && token.endsWith("'")) {
		return unescapeSqlBody(token.slice(2, -1));
	}
	if (token.startsWith("'") && token.endsWith("'")) {
		return unescapeSqlBody(token.slice(1, -1));
	}
	const n = Number(token);
	return Number.isFinite(n) ? n : token;
}

/** Parse an `INSERT INTO "sessions" (cols) VALUES (vals)` into a column→value row. */
function parseInsert(sql: string): StorageRow | null {
	const m = /INSERT\s+INTO\s+"[^"]+"\s*\(([^)]*)\)\s*VALUES\s*\((.*)\)\s*$/is.exec(sql.trim());
	if (m === null) return null;
	const cols = m[1].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
	const vals = splitValues(m[2]);
	const row: Record<string, unknown> = {};
	cols.forEach((col, i) => {
		row[col] = i < vals.length ? parseValue(vals[i]) : null;
	});
	return row as StorageRow;
}

/** Build the round-trip responder + the backing in-memory `sessions` rows. */
function roundTripStorage(): { transport: FakeDeepLakeTransport; rows: StorageRow[] } {
	const rows: StorageRow[] = [];
	const responder = (req: TransportRequest): StorageRow[] => {
		const sql = req.sql;
		// Introspection: report the full sessions columns so the table "exists" and the
		// first INSERT does NOT trigger a CREATE/heal (keeps the slice deterministic).
		if (/information_schema\.columns/i.test(sql)) {
			return SESSIONS_COLUMNS.map((c) => ({ column_name: c.name }) as StorageRow);
		}
		// The real append-only INSERT: store the parsed row.
		if (/^\s*INSERT\s+INTO\s+"sessions"/i.test(sql)) {
			const row = parseInsert(sql);
			if (row !== null) rows.push(row);
			return [];
		}
		// The real read-back SELECT (`readAppendOrdered`): serve stored rows for the path.
		if (/^\s*SELECT\b.*\bFROM\s+"sessions"/i.test(sql)) {
			const pathMatch = /WHERE\s+path\s*=\s*'((?:[^']|'')*)'/i.exec(sql);
			if (pathMatch !== null) {
				const wanted = unescapeSqlBody(pathMatch[1]);
				return rows.filter((r) => r.path === wanted);
			}
			return [...rows];
		}
		return [];
	};
	return { transport: new FakeDeepLakeTransport(responder), rows };
}

// ─────────────────────────────────────────────────────────────────────────────
// Slice harness: build the REAL daemon + REAL attached handler + the authored
// REAL transport client, and the REAL hook-core deps it drives.
// ─────────────────────────────────────────────────────────────────────────────

function buildSlice() {
	const { transport, rows } = roundTripStorage();
	const storage = createStorageClient({
		transport,
		provider: { read: () => ({ endpoint: "https://fake.test", token: "t", org: ORG, workspace: WORKSPACE }) },
	});
	const queue = new RecordingQueue();
	const daemon = createDaemon({
		config: cfg(),
		storage,
		logger: createRequestLogger({ silent: true }),
		services: { runtimePath: createRuntimePathService() },
	});
	// The REAL daemon-side attach step (the deferred daemon-assembly seam). Before it
	// the `/api/hooks/capture` route 501s; after it the handler serves.
	const sessionsTarget: HealTarget = healTargetFor("sessions");
	const handler = attachHooksHandlers(daemon, { storage, queue, sessionsTarget });

	// The authored transport adapter (the deferred glue) → in-process daemon dispatch.
	const daemonClient = createDaemonHookClient(daemon, { org: ORG, workspace: WORKSPACE });
	const deps: HookCoreDeps = {
		daemon: daemonClient,
		// These two seams are NOT exercised by the capture path; supply minimal inert
		// impls (the credential read is never hit by `runCapture`, only session-start).
		credentials: { async read() { return undefined; } },
		context: { async render() { return ""; } },
	};
	return { daemon, handler, queue, rows, deps };
}

/** A Claude-Code `UserPromptSubmit` native hook event (the real native payload shape). */
function userPromptSubmitEvent(prompt: string) {
	return { name: "UserPromptSubmit", payload: { prompt } };
}

/** The session metadata the harness threads onto the turn (the shim's own shape). */
function meta(sessionId: string, path: string): HookSessionMeta {
	return {
		sessionId,
		path,
		cwd: "/repo/honeycomb",
		permissionMode: "default",
		agentId: "claude-code-agent",
		agent: "claude-code",
	};
}

/** Default capture env: permissive gate (capture enabled, no worker marker). */
const CAPTURE_ENV: CaptureGateEnv = {};

describe("COMPOSITION: real Claude-Code hook → real core → real daemon handler → real storage round-trip", () => {
	it("normalizes + captures one real sessions row carrying the normalized fields, and reads it back by path", async () => {
		const { daemon, rows, deps } = buildSlice();
		const shim = createClaudeCodeShim();
		const sessionId = "sess-compose-1";
		const path = "conversations/sess-compose-1";
		const prompt = "compose: does the real slice round-trip?";

		// REAL shim + REAL normalize engine: native event → normalized HookInput.
		const input = shim.normalize(userPromptSubmitEvent(prompt), meta(sessionId, path));
		expect(input, "the real shim normalized the native UserPromptSubmit event").toBeDefined();
		// The shim mapped to the logical user_message and stamped the legacy runtime path.
		expect(input?.event).toBe("user_message");
		expect(input?.runtimePath).toBe("legacy");
		expect(input?.data).toEqual({ kind: "user_message", text: prompt });
		// hookEventName provenance is the native name (threaded by the normalize engine).
		expect(input?.meta.hookEventName).toBe("UserPromptSubmit");

		// REAL runCapture → authored transport → REAL daemon handler → REAL storage.
		const result = await runCapture(input!, deps, CAPTURE_ENV);
		expect(result.ok, "the real capture path completed end-to-end").toBe(true);

		// Exactly ONE real append-only sessions row was written through the real handler.
		expect(rows.length, "exactly one sessions row written").toBe(1);
		const stored = rows[0];
		// The dedicated columns carry the normalized metadata onto the row.
		expect(stored.path).toBe(path);
		expect(stored.filename, "hook event name → filename column").toBe("UserPromptSubmit");
		expect(stored.project, "cwd → project column").toBe("/repo/honeycomb");
		expect(stored.agent).toBe("claude-code");
		// The JSONB message stores the verbatim normalized envelope (event + metadata).
		const messageText = typeof stored.message === "string" ? stored.message : JSON.stringify(stored.message);
		expect(messageText, "the captured prompt survived intact in the JSONB message").toContain(prompt);
		expect(messageText).toContain("user_message");
		expect(messageText, "the session id rides in the envelope metadata").toContain(sessionId);

		// Read the turn back BY PATH through the REAL /api/hooks/conversation route.
		const readback = await daemon.app.request(`/api/hooks/conversation?path=${encodeURIComponent(path)}`, {
			headers: {
				"x-honeycomb-runtime-path": "legacy",
				"x-honeycomb-session": sessionId,
				"x-honeycomb-org": ORG,
				"x-honeycomb-workspace": WORKSPACE,
			},
		});
		expect(readback.status).toBe(200);
		const conversation = (await readback.json()) as { path: string; rows: Record<string, unknown>[] };
		expect(conversation.rows.length, "exactly one append-only row read back for this path").toBe(1);
		const back = conversation.rows[0];
		expect(back.id, "the read-back row is the row we wrote").toBe(stored.id);
		const backMessage = typeof back.message === "string" ? back.message : JSON.stringify(back.message);
		expect(backMessage).toContain(prompt);
	});

	it("the x-honeycomb-runtime-path: legacy header reaches the handler end-to-end (the 019b→daemon contract composes)", async () => {
		// Prove the header the shim stamps actually drives the daemon's runtime-path
		// middleware: a request with NO runtime-path header is rejected 400 by that
		// middleware BEFORE the handler — so the 201 above can only have happened
		// because the authored client stamped `legacy`. This is the negative control.
		const { daemon } = buildSlice();
		const noHeaderBody = JSON.stringify({
			event: { kind: "user_message", text: "no header" },
			metadata: { sessionId: "sess-x", path: "conversations/sess-x", org: ORG, workspace: WORKSPACE },
		});
		const missing = await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-honeycomb-session": "sess-x",
				"x-honeycomb-org": ORG,
				"x-honeycomb-workspace": WORKSPACE,
			},
			body: noHeaderBody,
		});
		expect(missing.status, "no runtime-path header → real middleware 400s before the handler").toBe(400);

		// And WITH the legacy header (exactly what the authored client stamps) it is served.
		const withHeader = await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-honeycomb-runtime-path": "legacy",
				"x-honeycomb-session": "sess-x",
				"x-honeycomb-org": ORG,
				"x-honeycomb-workspace": WORKSPACE,
			},
			body: noHeaderBody,
		});
		expect(withHeader.status, "legacy runtime-path header → handler serves (201)").toBe(201);
	});

	it("a SECOND runtime path on the same session is rejected 409 by the real runtime-path middleware (end-to-end)", async () => {
		const { daemon, rows, deps } = buildSlice();
		const shim = createClaudeCodeShim();
		const sessionId = "sess-compose-409";
		const path = "conversations/sess-compose-409";

		// First capture on the `legacy` path: the real middleware CLAIMS the session.
		const first = shim.normalize(userPromptSubmitEvent("first turn on legacy"), meta(sessionId, path));
		const firstResult = await runCapture(first!, deps, CAPTURE_ENV);
		expect(firstResult.ok).toBe(true);
		expect(rows.length).toBe(1);

		// Now a SECOND runtime path (`plugin`) claims the SAME session id → conflict.
		// We dispatch through the authored client with a plugin-stamped request so the
		// REAL runtime-path middleware fires its 409 ahead of the handler (no second row).
		const pluginClient = createDaemonHookClient(daemon, { org: ORG, workspace: WORKSPACE });
		const conflict = await pluginClient.send({
			endpoint: "capture",
			body: {
				event: { kind: "user_message", text: "second turn on plugin" },
				metadata: { sessionId, path },
			},
			meta: { sessionId, path },
			runtimePath: "plugin",
		});
		expect(conflict.status, "the real runtime-path middleware rejects the second path 409").toBe(409);
		// The conflicting request never reached the handler → no second sessions row.
		expect(rows.length, "the 409 fired before any write (fail-closed)").toBe(1);
	});
});
