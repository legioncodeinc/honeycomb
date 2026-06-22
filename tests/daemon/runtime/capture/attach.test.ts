/**
 * PRD-019b daemon-side attach suite — the `/api/hooks/*` handler attach step.
 *
 * `attachHooksHandlers` is the single named seam the daemon assembly calls after
 * `createDaemon(...)` to wire `capture-handler.ts` onto the already-mounted
 * `/api/hooks` route group. This suite proves: BEFORE the attach the group answers
 * the 501 scaffold; AFTER the attach `/api/hooks/capture` is LIVE (201) and inherits
 * the runtime-path + permission middleware with no re-wiring. It defaults the
 * `sessions` heal target so the assembly only injects storage + queue.
 */

import { describe, expect, it } from "vitest";

import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import { createRuntimePathService } from "../../../../src/daemon/runtime/middleware/runtime-path.js";
import type { JobInput, JobQueueService, LeasedJob } from "../../../../src/daemon/runtime/services/job-queue.js";
import { healTargetFor } from "../../../../src/daemon/storage/catalog/index.js";
import { attachHooksHandlers } from "../../../../src/daemon/runtime/capture/attach.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const ORG = "fake-org";
const WORKSPACE = "fake-ws";

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

/** A SQL-aware responder: introspection reports the full sessions columns; writes/reads succeed. */
function responder() {
	return (req: TransportRequest): Record<string, unknown>[] => {
		if (/information_schema\.columns/i.test(req.sql)) {
			return healTargetFor("sessions").columns.map((c) => ({ column_name: c.name }));
		}
		return [];
	};
}

function body() {
	return {
		event: { kind: "user_message", text: "hello" },
		metadata: {
			sessionId: "sess-1",
			path: "conversations/sess-1",
			org: ORG,
			workspace: WORKSPACE,
		},
	};
}

describe("PRD-019b attachHooksHandlers wires /api/hooks/* onto the route group", () => {
	it("BEFORE attach: /api/hooks/capture answers the 501 scaffold", async () => {
		const daemon = createDaemon({ config: cfg(), logger: createRequestLogger({ silent: true }), services: { runtimePath: createRuntimePathService() } });
		const res = await daemon.app.request("/api/hooks/capture", { method: "POST", headers: sessionHeaders(), body: JSON.stringify(body()) });
		expect(res.status).toBe(501);
	});

	it("AFTER attach: /api/hooks/capture is live (201) inheriting the group middleware", async () => {
		const fake = new FakeDeepLakeTransport(responder());
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const queue = new RecordingQueue();
		const daemon = createDaemon({
			config: cfg(),
			storage,
			logger: createRequestLogger({ silent: true }),
			services: { runtimePath: createRuntimePathService() },
		});

		// The attach seam — storage + queue only; the sessions target is defaulted.
		const handler = attachHooksHandlers(daemon, { storage, queue });
		expect(handler.counters).toBeDefined();

		const res = await daemon.app.request("/api/hooks/capture", { method: "POST", headers: sessionHeaders(), body: JSON.stringify(body()) });
		expect(res.status).toBe(201);
		const json = (await res.json()) as Record<string, unknown>;
		expect(json.ok).toBe(true);
		// The append-only INSERT reached the wire (one sessions row).
		expect(fake.requests.some((r) => /^\s*INSERT\s+INTO\s+"sessions"/i.test(r.sql))).toBe(true);
	});

	// PRD-046a (FINAL trigger): session-end enqueues a `summary` final job into memory_jobs.
	it("FINAL trigger: POST /api/hooks/session-end enqueues a summary final job (sessionId+path+userName)", async () => {
		const fake = new FakeDeepLakeTransport(responder());
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const queue = new RecordingQueue();
		const daemon = createDaemon({
			config: cfg(),
			storage,
			logger: createRequestLogger({ silent: true }),
			services: { runtimePath: createRuntimePathService() },
		});
		attachHooksHandlers(daemon, { storage, queue });

		const res = await daemon.app.request("/api/hooks/session-end", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify({
				intents: ["mark-ended", "record-usage", "skillify"],
				meta: { sessionId: "sess-1", path: "conversations/sess-1", agentId: "claude-code" },
			}),
		});
		// The ack still composes the lifecycle (PRD-021c).
		expect(res.status).toBe(200);
		expect(((await res.json()) as Record<string, unknown>).ok).toBe(true);

		// The FINAL trigger enqueued exactly one summary job with the session identity.
		const summaryJobs = queue.enqueued.filter((j) => j.kind === "summary");
		expect(summaryJobs).toHaveLength(1);
		expect(summaryJobs[0].payload).toMatchObject({
			sessionId: "sess-1",
			path: "conversations/sess-1",
			userName: ORG, // resolved from the x-honeycomb-org header
			agentId: "claude-code",
			triggerKind: "final",
			reason: "SessionEnd",
		});
	});

	// FINAL trigger is fail-soft: a session-end with no usable meta still acks and enqueues nothing.
	it("FINAL trigger: a session-end with no sessionId/path acks 200 and enqueues no summary job", async () => {
		const fake = new FakeDeepLakeTransport(responder());
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const queue = new RecordingQueue();
		const daemon = createDaemon({
			config: cfg(),
			storage,
			logger: createRequestLogger({ silent: true }),
			services: { runtimePath: createRuntimePathService() },
		});
		attachHooksHandlers(daemon, { storage, queue });

		const res = await daemon.app.request("/api/hooks/session-end", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify({ intents: ["mark-ended"] }), // no meta
		});
		expect(res.status).toBe(200);
		expect(queue.enqueued.filter((j) => j.kind === "summary")).toHaveLength(0);
	});
});
