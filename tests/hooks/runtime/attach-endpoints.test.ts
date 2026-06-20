/**
 * PRD-021c c-AC-3 — the two missing hook endpoints attach ALONGSIDE capture.
 *
 * BEFORE the attach: POSTing to `/api/hooks/context` / `/api/hooks/session-end` is
 * NOT served (the scaffolded group's catch-all returns 501 "not wired in this build").
 * AFTER `attachHooksHandlers`: all THREE (`/capture`, `/context`, `/session-end`) are
 * served, inheriting the SAME runtime-path + permission middleware as capture (a
 * request with no runtime-path header is rejected by that middleware before the
 * handler — proving the two new endpoints joined the protected group).
 */

import { describe, expect, it } from "vitest";

import { type RuntimeConfig } from "../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../src/daemon/runtime/server.js";
import { createRuntimePathService } from "../../../src/daemon/runtime/middleware/runtime-path.js";
import { createStorageClient } from "../../../src/daemon/storage/index.js";
import { FakeDeepLakeTransport } from "../../helpers/fake-deeplake.js";
import { SESSIONS_COLUMNS } from "../../../src/daemon/storage/catalog/sessions-summaries.js";
import type { StorageRow } from "../../../src/daemon/storage/result.js";
import type { TransportRequest } from "../../../src/daemon/storage/transport.js";
import {
	attachHooksHandlers,
	CONTEXT_PATH,
	SESSION_END_PATH,
} from "../../../src/daemon/runtime/capture/attach.js";
import type { JobInput, JobQueueService, LeasedJob } from "../../../src/daemon/runtime/services/job-queue.js";

const ORG = "fake-org";
const WORKSPACE = "fake-ws";

function cfg(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
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

/** A storage double that reports the sessions table exists (no heal needed for attach). */
function fakeStorage() {
	const responder = (req: TransportRequest): StorageRow[] => {
		if (/information_schema\.columns/i.test(req.sql)) {
			return SESSIONS_COLUMNS.map((c) => ({ column_name: c.name }) as StorageRow);
		}
		return [];
	};
	return createStorageClient({
		transport: new FakeDeepLakeTransport(responder),
		provider: { read: () => ({ endpoint: "https://fake.test", token: "t", org: ORG, workspace: WORKSPACE }) },
	});
}

function buildDaemon() {
	return createDaemon({
		config: cfg(),
		storage: fakeStorage(),
		logger: createRequestLogger({ silent: true }),
		services: { runtimePath: createRuntimePathService() },
	});
}

const SCOPED_HEADERS = {
	"content-type": "application/json",
	"x-honeycomb-runtime-path": "legacy",
	"x-honeycomb-session": "sess-attach",
	"x-honeycomb-org": ORG,
	"x-honeycomb-workspace": WORKSPACE,
};

describe("c-AC-3 attach: /api/hooks/context + /api/hooks/session-end attach alongside /capture", () => {
	it("BEFORE attach: /api/hooks/context and /api/hooks/session-end are NOT served (501 not-wired)", async () => {
		const daemon = buildDaemon();
		const ctx = await daemon.app.request(`/api/hooks${CONTEXT_PATH}`, {
			method: "POST",
			headers: SCOPED_HEADERS,
			body: JSON.stringify({ meta: { sessionId: "sess-attach" } }),
		});
		const end = await daemon.app.request(`/api/hooks${SESSION_END_PATH}`, {
			method: "POST",
			headers: SCOPED_HEADERS,
			body: JSON.stringify({ intents: ["mark-ended"] }),
		});
		// The scaffolded group's catch-all returns 501 "not wired in this build" for an
		// unregistered route — the BEFORE state the attach flips to served.
		expect(ctx.status, "context endpoint is not yet attached").toBe(501);
		expect(end.status, "session-end endpoint is not yet attached").toBe(501);
	});

	it("AFTER attach: all three endpoints are served (context 200, session-end 200)", async () => {
		const daemon = buildDaemon();
		attachHooksHandlers(daemon, { storage: fakeStorage(), queue: new RecordingQueue() });

		const ctx = await daemon.app.request(`/api/hooks${CONTEXT_PATH}`, {
			method: "POST",
			headers: SCOPED_HEADERS,
			body: JSON.stringify({ meta: { sessionId: "sess-attach" } }),
		});
		expect(ctx.status, "context endpoint is now served").toBe(200);
		const ctxBody = (await ctx.json()) as { additionalContext?: string };
		expect(ctxBody).toHaveProperty("additionalContext");

		const end = await daemon.app.request(`/api/hooks${SESSION_END_PATH}`, {
			method: "POST",
			headers: SCOPED_HEADERS,
			body: JSON.stringify({ intents: ["mark-ended", "record-usage", "skillify"] }),
		});
		expect(end.status, "session-end endpoint is now served").toBe(200);
		const endBody = (await end.json()) as { ok?: boolean };
		expect(endBody.ok).toBe(true);
	});

	it("the new endpoints inherit the runtime-path middleware (no header → rejected before the handler)", async () => {
		const daemon = buildDaemon();
		attachHooksHandlers(daemon, { storage: fakeStorage(), queue: new RecordingQueue() });
		// No x-honeycomb-runtime-path header → the session-scoped group's middleware rejects
		// it (400) before the handler, proving /context joined the SAME protected group.
		const noPath = await daemon.app.request(`/api/hooks${CONTEXT_PATH}`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-honeycomb-session": "sess-attach",
				"x-honeycomb-org": ORG,
				"x-honeycomb-workspace": WORKSPACE,
			},
			body: JSON.stringify({ meta: { sessionId: "sess-attach" } }),
		});
		expect(noPath.status, "no runtime-path header → middleware rejects before the handler").toBe(400);
	});

	it("a custom contextHandler / sessionEndHandler (021d/021e seam) replaces the default", async () => {
		const daemon = buildDaemon();
		attachHooksHandlers(daemon, {
			storage: fakeStorage(),
			queue: new RecordingQueue(),
			contextHandler: (c) => c.json({ additionalContext: "RULES: be kind." }, 200),
			sessionEndHandler: (c) => c.json({ ok: true, summarized: true }, 200),
		});
		const ctx = await daemon.app.request(`/api/hooks${CONTEXT_PATH}`, {
			method: "POST",
			headers: SCOPED_HEADERS,
			body: JSON.stringify({ meta: { sessionId: "sess-attach" } }),
		});
		const body = (await ctx.json()) as { additionalContext: string };
		expect(body.additionalContext).toBe("RULES: be kind.");
	});
});
