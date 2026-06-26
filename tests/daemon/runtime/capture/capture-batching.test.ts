/**
 * PRD-062c — capture write batching + envelope trimming, at the handler level.
 *
 * Verification posture (mirrors capture-handler.test.ts): in-process
 * `daemon.app.request(...)` against the PRD-002 fake transport, with the capture
 * handler attached via `createCaptureHandler(...).register(daemon)`. The flush
 * window is driven by an INJECTED clock — NO real sleep (the orchestrator hard
 * constraint). Each test maps to an acceptance criterion:
 *
 *   - AC-62c.1.1  N(<25) events in a window → exactly ONE multi-row append.
 *   - AC-62c.1.2  shutdown (`flush()`) drains the buffer (nothing lost).
 *   - AC-62c.2.1  a multi-MB tool response is persisted within budget + marker.
 *   - AC-62c.2.3  parity: the fields the extractor + recall read survive trimming.
 *   - AC-9        flags OFF → one INSERT per event, full untrimmed envelope.
 */

import { describe, expect, it } from "vitest";

import { healTargetFor } from "../../../../src/daemon/storage/catalog/index.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import { createRuntimePathService } from "../../../../src/daemon/runtime/middleware/runtime-path.js";
import type { JobInput, JobQueueService, LeasedJob } from "../../../../src/daemon/runtime/services/job-queue.js";
import {
	type CaptureHandler,
	createCaptureHandler,
} from "../../../../src/daemon/runtime/capture/capture-handler.js";
import type { CaptureConfig } from "../../../../src/daemon/runtime/capture/capture-config.js";
import { type BufferClock, type TimerHandle } from "../../../../src/daemon/runtime/capture/capture-buffer.js";
import { truncationMarker } from "../../../../src/daemon/runtime/capture/budgeted-stringify.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const ORG = "fake-org";
const WORKSPACE = "fake-ws";

/** A fake clock for the flush window: the timer fires only when the test advances past its deadline. */
class FakeClock implements BufferClock {
	private millis = 0;
	private pending: { id: number; fireAt: number; fn: () => void } | null = null;
	private nextId = 1;
	now(): number {
		return this.millis;
	}
	setTimer(fn: () => void, ms: number): TimerHandle {
		const id = this.nextId++;
		this.pending = { id, fireAt: this.millis + ms, fn };
		return id;
	}
	clearTimer(handle: TimerHandle): void {
		if (this.pending !== null && this.pending.id === handle) this.pending = null;
	}
	advance(ms: number): void {
		this.millis += ms;
		if (this.pending !== null && this.millis >= this.pending.fireAt) {
			const { fn } = this.pending;
			this.pending = null;
			fn();
		}
	}
}

function cfg(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
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

class NoopQueue implements JobQueueService {
	async enqueue(_job: JobInput): Promise<string> {
		return "j";
	}
	async lease(): Promise<LeasedJob | null> {
		return null;
	}
	async complete(): Promise<void> {}
	async fail(): Promise<void> {}
	start(): void {}
	stop(): void {}
}

/** A transport that records every statement; INSERT/CREATE/ALTER succeed, SELECT returns []. */
function responder() {
	return (req: TransportRequest): Record<string, unknown>[] => {
		if (/information_schema\.columns/i.test(req.sql)) {
			return healTargetFor("sessions").columns.map((c) => ({ column_name: c.name }));
		}
		return [];
	};
}

function buildDaemon(config: CaptureConfig, clock?: BufferClock): { daemon: Daemon; fake: FakeDeepLakeTransport; handler: CaptureHandler } {
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
		queue: new NoopQueue(),
		captureConfig: config,
		...(clock !== undefined ? { bufferClock: clock } : {}),
	});
	handler.register(daemon);
	return { daemon, fake, handler };
}

function userBody(text: string) {
	return {
		event: { kind: "user_message", text },
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
		},
	};
}

function toolBody(response: string) {
	return {
		event: { kind: "tool_call", tool: "Bash", input: { cmd: "ls" }, response },
		metadata: userBody("").metadata,
	};
}

function insertSqls(fake: FakeDeepLakeTransport): string[] {
	return fake.requests.filter((r) => /^\s*INSERT\s+INTO\s+"sessions"/i.test(r.sql)).map((r) => r.sql);
}

const BATCH_ON: CaptureConfig = { batch: true, windowMs: 1_000, maxEvents: 25, envelopeBudgetBytes: 16_384 };

describe("AC-62c.1.1: N events within the window produce ONE multi-row append", () => {
	it("buffers 5 within-window events and flushes them as a single INSERT", async () => {
		const clock = new FakeClock();
		const { daemon, fake } = buildDaemon(BATCH_ON, clock);

		for (let i = 0; i < 5; i++) {
			const res = await daemon.app.request("/api/hooks/capture", {
				method: "POST",
				headers: sessionHeaders(),
				body: JSON.stringify(userBody(`turn ${i}`)),
			});
			expect(res.status).toBe(201);
		}
		// Before the window elapses, NOTHING has been written.
		expect(insertSqls(fake).length, "no INSERT before the window closes").toBe(0);

		clock.advance(1_000);
		await Promise.resolve();
		await Promise.resolve();

		const inserts = insertSqls(fake);
		expect(inserts.length, "5 events → exactly ONE append").toBe(1);
		// It is a multi-row VALUES statement carrying all 5 rows.
		expect(inserts[0].match(/VALUES/gi)?.length).toBe(1);
		expect(inserts[0].match(/\),\s*\(/g)?.length, "4 tuple separators for 5 rows").toBe(4);
	});

	it("the size cap forces a flush at maxEvents before the window elapses", async () => {
		const clock = new FakeClock();
		const { daemon, fake } = buildDaemon({ ...BATCH_ON, maxEvents: 3 }, clock);

		for (let i = 0; i < 3; i++) {
			await daemon.app.request("/api/hooks/capture", {
				method: "POST",
				headers: sessionHeaders(),
				body: JSON.stringify(userBody(`turn ${i}`)),
			});
		}
		// Let the size-triggered flush settle (no clock advance needed — the cap fired it).
		await Promise.resolve();
		await Promise.resolve();
		const inserts = insertSqls(fake);
		expect(inserts.length, "the 3rd event hit the cap → one append").toBe(1);
	});
});

describe("AC-62c.1.2: shutdown drains the buffer (nothing lost)", () => {
	it("flush() writes the buffered window on a clean stop", async () => {
		const clock = new FakeClock();
		const { daemon, fake, handler } = buildDaemon(BATCH_ON, clock);

		for (let i = 0; i < 4; i++) {
			await daemon.app.request("/api/hooks/capture", {
				method: "POST",
				headers: sessionHeaders(),
				body: JSON.stringify(userBody(`turn ${i}`)),
			});
		}
		expect(insertSqls(fake).length, "buffered, not yet written").toBe(0);

		await handler.flush(); // graceful shutdown drain

		const inserts = insertSqls(fake);
		expect(inserts.length, "shutdown drained the buffer to one append").toBe(1);
		expect(inserts[0].match(/\),\s*\(/g)?.length, "3 separators for 4 rows").toBe(3);
	});

	it("flush() is a no-op when batching is off (no buffer)", async () => {
		const { handler } = buildDaemon({ batch: false, windowMs: 1_000, maxEvents: 25, envelopeBudgetBytes: 0 });
		await expect(handler.flush()).resolves.toBeUndefined();
	});
});

describe("AC-62c.2.1: a multi-MB tool response is persisted within budget with a marker", () => {
	it("caps the response in the persisted envelope", async () => {
		const clock = new FakeClock();
		const { daemon, fake } = buildDaemon(BATCH_ON, clock);
		const huge = "y".repeat(2_000_000); // ~2 MB

		await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify(toolBody(huge)),
		});
		clock.advance(1_000);
		await Promise.resolve();
		await Promise.resolve();

		const inserts = insertSqls(fake);
		expect(inserts.length).toBe(1);
		// The 2 MB blob is NOT in the statement; the marker IS.
		expect(inserts[0].includes(huge), "the megabyte blob is not shipped").toBe(false);
		expect(inserts[0].includes(truncationMarker(JSON.stringify(huge).length))).toBe(true);
		// The whole statement is small (no megabytes), well under a few KB of overhead + budget.
		expect(inserts[0].length).toBeLessThan(20_000);
	});
});

describe("AC-62c.2.3: parity — fields the extractor + recall read survive trimming", () => {
	it("keeps event.text, event.kind, event.tool and metadata.sessionId after trimming", async () => {
		const clock = new FakeClock();
		const { daemon, fake } = buildDaemon(BATCH_ON, clock);

		// A user_message (its text is recall + skillify + summary signal) and a tool_call with a
		// huge response (the trimmed field) in the same window.
		await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify(userBody("a kept prompt body")),
		});
		await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify(toolBody("z".repeat(1_000_000))),
		});
		clock.advance(1_000);
		await Promise.resolve();
		await Promise.resolve();

		const sql = insertSqls(fake)[0];
		// The user_message text survives verbatim (recall/skillify/summary read event.text).
		expect(sql.includes("a kept prompt body")).toBe(true);
		// The kinds + tool name survive (skillify miner + summary worker read event.kind; the tool name is signal).
		expect(sql.includes("user_message")).toBe(true);
		expect(sql.includes("tool_call")).toBe(true);
		expect(sql.includes("Bash")).toBe(true);
		// metadata.sessionId survives in the envelope (the skillify miner reads it from there — no dedicated column).
		expect(sql.includes("sess-1")).toBe(true);
	});
});

describe("AC-9: flags OFF reproduces pre-PRD behavior", () => {
	it("one INSERT per event, no batching, full untrimmed envelope", async () => {
		const OFF: CaptureConfig = { batch: false, windowMs: 1_000, maxEvents: 25, envelopeBudgetBytes: 0 };
		const { daemon, fake } = buildDaemon(OFF);
		const huge = "h".repeat(500_000);

		for (let i = 0; i < 3; i++) {
			const res = await daemon.app.request("/api/hooks/capture", {
				method: "POST",
				headers: sessionHeaders(),
				body: JSON.stringify(i === 2 ? toolBody(huge) : userBody(`turn ${i}`)),
			});
			expect(res.status).toBe(201);
		}
		const inserts = insertSqls(fake);
		// One INSERT per event, synchronously (no buffer).
		expect(inserts.length, "3 events → 3 INSERTs").toBe(3);
		// Each is a single-row VALUES (no batched tuples).
		for (const sql of inserts) expect(sql.match(/\),\s*\(/g)).toBeNull();
		// The full untrimmed envelope is written: the big tool response is present, no marker.
		const toolInsert = inserts[2];
		expect(toolInsert.includes(huge), "the full untrimmed response is persisted").toBe(true);
		expect(toolInsert.includes("[truncated"), "no truncation marker when budget is 0").toBe(false);
	});
});
