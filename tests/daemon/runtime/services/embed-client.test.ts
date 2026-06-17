/**
 * PRD-005b Embedding Attachment — b-AC-1..b-AC-5.
 *
 * Verification posture (EXECUTION_LEDGER-prd-005): against a FAKE embed client
 * (the real embed daemon is NOT built here — consumed, not built). The attach
 * UPDATE is asserted via `FakeDeepLakeTransport.requests` so the exact SQL + scope
 * are verifiable without a live endpoint.
 *
 * Each test is named after the AC it proves (one-to-one ledger map):
 *   b-AC-1  enabled → 768-dim vector computed + single attach UPDATE emitted
 *   b-AC-2  disabled → embed() returns null, no UPDATE, capture row still present
 *   b-AC-3  embed throws/unreachable → logged, null, no UPDATE, capture unaffected
 *   b-AC-4  non-blocking → capture HTTP response returns before embed settles
 *   b-AC-5  returned vector length ≠ 768 → rejected → null, no UPDATE
 *
 * Test layout:
 *   §1  EmbedClient — DaemonEmbedClient unit (mocked fetch)
 *   §2  EmbeddingAttacher — StorageEmbeddingAttacher unit (FakeDeepLakeTransport)
 *   §3  Integration — createEmbedAttachment factory end-to-end
 *   §4  Non-blocking — through the capture handler's onEmbedSettled hook (b-AC-4)
 */

import { describe, expect, it, vi, afterEach } from "vitest";

import { EMBEDDING_DIMS } from "../../../../src/daemon/storage/vector.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { QueryScope } from "../../../../src/daemon/storage/client.js";
import { healTargetFor } from "../../../../src/daemon/storage/catalog/index.js";
import { TransportError, type TransportRequest } from "../../../../src/daemon/storage/transport.js";
import {
	createEmbedAttachment,
	noopEmbedAttachment,
	resolveEmbedClientOptions,
	type EmbedAttachmentDeps,
	type EmbedClientOptions,
	type EmbedLogger,
} from "../../../../src/daemon/runtime/services/embed-client.js";
import {
	createCaptureHandler,
	type CaptureHandlerDeps,
} from "../../../../src/daemon/runtime/capture/capture-handler.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import { createRuntimePathService } from "../../../../src/daemon/runtime/middleware/runtime-path.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import type { RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import type { JobInput, JobQueueService, LeasedJob } from "../../../../src/daemon/runtime/services/job-queue.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

// ── Shared constants ─────────────────────────────────────────────────────────

const SCOPE: QueryScope = { org: "fake-org", workspace: "fake-ws" };
const FAKE_ID = "sess-test-001";
/** A valid 768-dim vector for use across tests. */
const VALID_VECTOR: readonly number[] = new Array(EMBEDDING_DIMS).fill(0.1) as number[];

// ── Helpers ──────────────────────────────────────────────────────────────────

/** A recording logger that captures event calls for assertion. */
class RecordingLogger implements EmbedLogger {
	readonly events: Array<{ name: string; fields?: Record<string, unknown> }> = [];
	event(name: string, fields?: Record<string, unknown>): void {
		this.events.push({ name, fields });
	}
	/** True when at least one event with the given name was logged. */
	logged(name: string): boolean {
		return this.events.some((e) => e.name === name);
	}
}

/** Build a minimal FakeDeepLakeTransport that accepts UPDATE statements as success. */
function makeUpdateAcceptingTransport(): FakeDeepLakeTransport {
	return new FakeDeepLakeTransport((req: TransportRequest) => {
		// Accept any UPDATE or INSERT; any SELECT returns empty.
		if (/^\s*(UPDATE|INSERT|CREATE|ALTER)/i.test(req.sql)) return [];
		if (/information_schema\.columns/i.test(req.sql)) {
			return healTargetFor("sessions").columns.map((c) => ({ column_name: c.name }));
		}
		return [];
	});
}

/**
 * Build a fake global fetch that returns a resolved embed response with the
 * supplied vector (or throws/returns non-200 when `opts` says so).
 */
function mockFetch(opts: {
	vector?: readonly number[];
	status?: number;
	throw?: Error;
	malformed?: boolean;
}): typeof globalThis.fetch {
	return async (_input: RequestInfo | URL, _init?: RequestInit): Promise<Response> => {
		if (opts.throw !== undefined) throw opts.throw;
		const status = opts.status ?? 200;
		let body: unknown;
		if (opts.malformed === true) {
			body = { not_a_vector: true };
		} else {
			body = { vector: opts.vector ?? VALID_VECTOR };
		}
		return new Response(JSON.stringify(body), {
			status,
			headers: { "content-type": "application/json" },
		});
	};
}

/** An inert job queue for capture handler tests. */
class NoopQueue implements JobQueueService {
	async enqueue(_job: JobInput): Promise<string> {
		return "job-0";
	}
	async lease(): Promise<LeasedJob | null> {
		return null;
	}
	async complete(): Promise<void> {}
	async fail(): Promise<void> {}
	start(): void {}
	stop(): void {}
}

/** Build a local-mode daemon + capture handler for the non-blocking test (b-AC-4). */
function buildCaptureDaemon(embedDeps: Omit<EmbedAttachmentDeps, "storage">) {
	const fake = makeUpdateAcceptingTransport();
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const embed = createEmbedAttachment({ storage, ...embedDeps });
	const config: RuntimeConfig = { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
	const daemon = createDaemon({
		config,
		storage,
		logger: createRequestLogger({ silent: true }),
		services: { runtimePath: createRuntimePathService() },
	});
	const captureHandler = createCaptureHandler({
		storage,
		sessionsTarget: healTargetFor("sessions"),
		queue: new NoopQueue(),
		embed,
	});
	captureHandler.register(daemon);
	return { daemon, fake };
}

/** Standard session headers for a capture POST. */
function sessionHeaders(): Record<string, string> {
	return {
		"content-type": "application/json",
		"x-honeycomb-runtime-path": "plugin",
		"x-honeycomb-session": "sess-1",
		"x-honeycomb-org": SCOPE.org,
		"x-honeycomb-workspace": SCOPE.workspace ?? "fake-ws",
	};
}

// ── §1 EmbedClient — unit tests (mocked fetch) ──────────────────────────────

describe("b-AC-1 enabled → 768-dim vector returned by EmbedClient.embed()", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns the 768-dim vector when enabled and daemon responds correctly", async () => {
		const logger = new RecordingLogger();
		const options: EmbedClientOptions = {
			enabled: true,
			url: "http://127.0.0.1:3851",
			timeoutMs: 5_000,
		};
		// Use a transport-only storage — EmbedClient doesn't need it, attacher does.
		const fake = makeUpdateAcceptingTransport();
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const attachment = createEmbedAttachment({ storage, options, logger });

		vi.stubGlobal("fetch", mockFetch({ vector: VALID_VECTOR }));

		const result = await attachment.client.embed("hello world");
		expect(result).not.toBeNull();
		expect(result?.length).toBe(EMBEDDING_DIMS);
		// No failure events logged.
		expect(logger.logged("embed.failed")).toBe(false);
		expect(logger.logged("embed.dim_rejected")).toBe(false);
	});
});

describe("b-AC-2 disabled → embed() returns null, no UPDATE issued", () => {
	it("returns null immediately when HONEYCOMB_EMBEDDINGS is not set (default disabled)", async () => {
		const opts = resolveEmbedClientOptions({});
		expect(opts.enabled).toBe(false);
	});

	it("resolveEmbedClientOptions enables when HONEYCOMB_EMBEDDINGS=true", () => {
		const opts = resolveEmbedClientOptions({ HONEYCOMB_EMBEDDINGS: "true" });
		expect(opts.enabled).toBe(true);
	});

	it("resolveEmbedClientOptions enables when HONEYCOMB_EMBEDDINGS=1", () => {
		const opts = resolveEmbedClientOptions({ HONEYCOMB_EMBEDDINGS: "1" });
		expect(opts.enabled).toBe(true);
	});

	it("embed() returns null when disabled — no HTTP call, no UPDATE", async () => {
		const logger = new RecordingLogger();
		const fake = makeUpdateAcceptingTransport();
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const attachment = createEmbedAttachment({
			storage,
			options: { enabled: false, url: "http://127.0.0.1:3851", timeoutMs: 5_000 },
			logger,
		});

		// A real fetch spy to assert no HTTP call goes out.
		const fetchSpy = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
		vi.stubGlobal("fetch", fetchSpy);

		const result = await attachment.client.embed("some text");
		expect(result).toBeNull();
		expect(fetchSpy).not.toHaveBeenCalled();

		// Attacher is not called when client returns null (the handler gates on null).
		// Assert no UPDATE went to the transport.
		const updates = fake.requests.filter((r) => /^\s*UPDATE/i.test(r.sql));
		expect(updates.length).toBe(0);

		vi.restoreAllMocks();
	});
});

describe("b-AC-3 embed fails/unreachable → logged, null returned, no UPDATE", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("returns null + logs embed.failed when the daemon is unreachable (throws)", async () => {
		const logger = new RecordingLogger();
		const fake = makeUpdateAcceptingTransport();
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const attachment = createEmbedAttachment({
			storage,
			options: { enabled: true, url: "http://127.0.0.1:3851", timeoutMs: 5_000 },
			logger,
		});

		vi.stubGlobal("fetch", mockFetch({ throw: new Error("ECONNREFUSED") }));

		const result = await attachment.client.embed("hello");
		expect(result).toBeNull();
		expect(logger.logged("embed.failed")).toBe(true);

		// The attacher is not called; no UPDATE went out.
		const updates = fake.requests.filter((r) => /^\s*UPDATE/i.test(r.sql));
		expect(updates.length).toBe(0);
	});

	it("returns null + logs embed.failed on non-200 HTTP status", async () => {
		const logger = new RecordingLogger();
		const fake = makeUpdateAcceptingTransport();
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const attachment = createEmbedAttachment({
			storage,
			options: { enabled: true, url: "http://127.0.0.1:3851", timeoutMs: 5_000 },
			logger,
		});

		vi.stubGlobal("fetch", mockFetch({ status: 503 }));

		const result = await attachment.client.embed("hello");
		expect(result).toBeNull();
		expect(logger.logged("embed.failed")).toBe(true);
	});

	it("returns null + logs embed.failed on malformed daemon response", async () => {
		const logger = new RecordingLogger();
		const fake = makeUpdateAcceptingTransport();
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const attachment = createEmbedAttachment({
			storage,
			options: { enabled: true, url: "http://127.0.0.1:3851", timeoutMs: 5_000 },
			logger,
		});

		vi.stubGlobal("fetch", mockFetch({ malformed: true }));

		const result = await attachment.client.embed("hello");
		expect(result).toBeNull();
		expect(logger.logged("embed.failed")).toBe(true);
	});

	it("StorageEmbeddingAttacher: attacher UPDATE failure is logged, never throws (fail-soft)", async () => {
		const logger = new RecordingLogger();
		// Transport that rejects every UPDATE.
		const errorTransport = new FakeDeepLakeTransport((req: TransportRequest) => {
			if (/^\s*UPDATE/i.test(req.sql)) throw new TransportError("query", "update failed", 500);
			return [];
		});
		const storage = createStorageClient({ transport: errorTransport, provider: stubProvider(fakeCredentialRecord()) });
		const attachment = createEmbedAttachment({ storage, options: { enabled: true, url: "", timeoutMs: 5_000 }, logger });

		// The attacher must not throw even though the storage fails.
		await expect(attachment.attacher.attach({ id: FAKE_ID, scope: SCOPE }, VALID_VECTOR)).resolves.toBeUndefined();
		expect(logger.logged("attach.update_failed")).toBe(true);
	});
});

// ── §2 EmbeddingAttacher — unit tests ──────────────────────────────────────

describe("b-AC-1 enabled → single attach UPDATE emitted with correct SQL shape", () => {
	it("emits exactly one UPDATE sessions SET message_embedding … WHERE id = <id>", async () => {
		const fake = makeUpdateAcceptingTransport();
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const attachment = createEmbedAttachment({
			storage,
			options: { enabled: true, url: "http://127.0.0.1:3851", timeoutMs: 5_000 },
		});

		await attachment.attacher.attach({ id: FAKE_ID, scope: SCOPE }, VALID_VECTOR);

		const updates = fake.requests.filter((r) => /^\s*UPDATE\s+"sessions"/i.test(r.sql));
		expect(updates.length, "exactly one UPDATE for the attach").toBe(1);

		const sql = updates[0].sql;
		// Must reference message_embedding.
		expect(sql).toMatch(/SET\s+message_embedding\s*=/i);
		// Must carry ARRAY[…]::float4[] tensor literal.
		expect(sql).toMatch(/ARRAY\[/);
		expect(sql).toMatch(/::float4\[\]/);
		// Must scope to the exact row id.
		expect(sql).toContain(FAKE_ID);
		// The WHERE clause uses the id column.
		expect(sql).toMatch(/WHERE\s+id\s*=/i);

		// Scope reaches the wire.
		expect(updates[0].org).toBe(SCOPE.org);
		expect(updates[0].workspace).toBe(SCOPE.workspace);
	});
});

describe("b-AC-5 returned vector ≠ 768-dim → rejected, column left null, no UPDATE", () => {
	it("EmbedClient returns null for a 512-dim vector (wrong dim from daemon)", async () => {
		const logger = new RecordingLogger();
		const fake = makeUpdateAcceptingTransport();
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const attachment = createEmbedAttachment({
			storage,
			options: { enabled: true, url: "http://127.0.0.1:3851", timeoutMs: 5_000 },
			logger,
		});

		// Daemon returns a 512-dim vector (wrong).
		const wrongVector = new Array(512).fill(0.5);
		vi.stubGlobal("fetch", mockFetch({ vector: wrongVector }));

		const result = await attachment.client.embed("hello");
		expect(result).toBeNull();
		expect(logger.logged("embed.dim_rejected")).toBe(true);

		// No UPDATE should be issued (the handler gates on null).
		const updates = fake.requests.filter((r) => /^\s*UPDATE/i.test(r.sql));
		expect(updates.length).toBe(0);

		vi.restoreAllMocks();
	});

	it("EmbedClient returns null for a 769-dim vector (one element too many)", async () => {
		const logger = new RecordingLogger();
		const fake = makeUpdateAcceptingTransport();
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const attachment = createEmbedAttachment({
			storage,
			options: { enabled: true, url: "http://127.0.0.1:3851", timeoutMs: 5_000 },
			logger,
		});

		const wrongVector = new Array(769).fill(0.1);
		vi.stubGlobal("fetch", mockFetch({ vector: wrongVector }));

		const result = await attachment.client.embed("hello");
		expect(result).toBeNull();
		expect(logger.logged("embed.dim_rejected")).toBe(true);

		vi.restoreAllMocks();
	});

	it("StorageEmbeddingAttacher rejects a non-768 vector and emits no UPDATE", async () => {
		const logger = new RecordingLogger();
		const fake = makeUpdateAcceptingTransport();
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const attachment = createEmbedAttachment({ storage, options: { enabled: true, url: "", timeoutMs: 5_000 }, logger });

		const wrongVector = new Array(512).fill(0.1);
		await attachment.attacher.attach({ id: FAKE_ID, scope: SCOPE }, wrongVector);

		const updates = fake.requests.filter((r) => /^\s*UPDATE/i.test(r.sql));
		expect(updates.length).toBe(0);
		expect(logger.logged("attach.dim_rejected")).toBe(true);
	});
});

// ── §3 Integration — createEmbedAttachment end-to-end ───────────────────────

describe("b-AC-1 integration: enabled → attach UPDATE written for the correct row id", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("end-to-end: client returns 768-dim vector → attacher emits the single UPDATE", async () => {
		const logger = new RecordingLogger();
		const fake = makeUpdateAcceptingTransport();
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const attachment = createEmbedAttachment({
			storage,
			options: { enabled: true, url: "http://127.0.0.1:3851", timeoutMs: 5_000 },
			logger,
		});

		vi.stubGlobal("fetch", mockFetch({ vector: VALID_VECTOR }));

		const vector = await attachment.client.embed("embed this text");
		expect(vector).not.toBeNull();
		expect(vector?.length).toBe(EMBEDDING_DIMS);

		await attachment.attacher.attach({ id: "row-e2e", scope: SCOPE }, vector!);

		const updates = fake.requests.filter((r) => /^\s*UPDATE\s+"sessions"/i.test(r.sql));
		expect(updates.length).toBe(1);
		expect(updates[0].sql).toContain("row-e2e");
		expect(updates[0].sql).toMatch(/ARRAY\[/);
	});
});

// ── §4 Non-blocking — b-AC-4 via the capture handler's onEmbedSettled hook ──

describe("b-AC-4 non-blocking: capture HTTP response returns before embed settles", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("the 201 response is returned before the embed continuation resolves", async () => {
		// Arrange: an embed that takes a detectable amount of "time" (we use a promise
		// latch to control ordering without arbitrary sleeps).
		let resolveEmbed!: (v: readonly number[] | null) => void;
		const embedLatch = new Promise<readonly number[] | null>((res) => {
			resolveEmbed = res;
		});

		// Stub fetch so the embed call waits on the latch (simulating a slow daemon).
		vi.stubGlobal("fetch", async (_input: RequestInfo | URL, _init?: RequestInit) => {
			const vector = await embedLatch;
			const body = vector !== null ? { vector } : { error: "disabled" };
			return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
		});

		const settledPromises: Array<Promise<void>> = [];
		const fake = makeUpdateAcceptingTransport();
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const embed = createEmbedAttachment({
			storage,
			options: { enabled: true, url: "http://127.0.0.1:3851", timeoutMs: 30_000 },
		});

		const config: RuntimeConfig = { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
		const daemon = createDaemon({
			config,
			storage,
			logger: createRequestLogger({ silent: true }),
			services: { runtimePath: createRuntimePathService() },
		});

		const deps: CaptureHandlerDeps = {
			storage,
			sessionsTarget: healTargetFor("sessions"),
			queue: new NoopQueue(),
			embed,
			onEmbedSettled: (p) => settledPromises.push(p),
		};
		createCaptureHandler(deps).register(daemon);

		// Act: POST the capture event — expect the response BEFORE the embed resolves.
		const res = await daemon.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify({
				event: { kind: "user_message", text: "non-blocking test" },
				metadata: {
					sessionId: "sess-1",
					path: "conversations/sess-1",
					cwd: "/repo",
					permissionMode: "default",
					hookEventName: "UserPromptSubmit",
					agentId: "agent-7",
					org: SCOPE.org,
					workspace: SCOPE.workspace,
					agent: "claude-code",
					pluginVersion: "0.1.0",
				},
			}),
		});

		// The HTTP response must be 201 even though the embed latch has NOT fired yet.
		expect(res.status, "capture returns 201 before embed settles").toBe(201);
		expect(settledPromises.length).toBe(1);

		// Now unblock the embed and await the continuation — should not throw.
		resolveEmbed(VALID_VECTOR);
		await expect(Promise.all(settledPromises)).resolves.toBeDefined();

		// After settling, the attach UPDATE should have been issued.
		const updates = fake.requests.filter((r) => /^\s*UPDATE\s+"sessions"/i.test(r.sql));
		expect(updates.length).toBe(1);
	});

	it("a failing embed never breaks the capture: response is 201 and continuation resolves cleanly", async () => {
		// This test also validates b-AC-3 at the integration level.
		vi.stubGlobal("fetch", mockFetch({ throw: new Error("ECONNREFUSED: embed daemon is down") }));

		const settledPromises: Array<Promise<void>> = [];
		const { daemon } = buildCaptureDaemon({
			options: { enabled: true, url: "http://127.0.0.1:3851", timeoutMs: 5_000 },
		});

		// Patch in the onEmbedSettled hook — we need a fresh daemon for this.
		const fake2 = makeUpdateAcceptingTransport();
		const storage2 = createStorageClient({ transport: fake2, provider: stubProvider(fakeCredentialRecord()) });
		const embed2 = createEmbedAttachment({
			storage: storage2,
			options: { enabled: true, url: "http://127.0.0.1:3851", timeoutMs: 5_000 },
		});
		const config2: RuntimeConfig = { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
		const daemon2 = createDaemon({
			config: config2,
			storage: storage2,
			logger: createRequestLogger({ silent: true }),
			services: { runtimePath: createRuntimePathService() },
		});
		createCaptureHandler({
			storage: storage2,
			sessionsTarget: healTargetFor("sessions"),
			queue: new NoopQueue(),
			embed: embed2,
			onEmbedSettled: (p) => settledPromises.push(p),
		}).register(daemon2);

		const res = await daemon2.app.request("/api/hooks/capture", {
			method: "POST",
			headers: sessionHeaders(),
			body: JSON.stringify({
				event: { kind: "user_message", text: "fail-soft test" },
				metadata: {
					sessionId: "sess-1",
					path: "conversations/sess-1",
					cwd: "/repo",
					permissionMode: "default",
					hookEventName: "UserPromptSubmit",
					agentId: "agent-7",
					org: SCOPE.org,
					workspace: SCOPE.workspace,
					agent: "claude-code",
					pluginVersion: "0.1.0",
				},
			}),
		});
		expect(res.status, "capture still 201 when embed fails").toBe(201);
		// The continuation must resolve without throwing even though fetch threw.
		await expect(Promise.all(settledPromises)).resolves.toBeDefined();
		// No UPDATE should have been emitted (embed returned null).
		const updates = fake2.requests.filter((r) => /^\s*UPDATE/i.test(r.sql));
		expect(updates.length).toBe(0);
		void daemon;
	});
});

// ── §5 resolveEmbedClientOptions: env knob coverage ──────────────────────────

describe("resolveEmbedClientOptions env resolution", () => {
	it("uses DEFAULT_EMBED_URL when HONEYCOMB_EMBED_URL is unset", () => {
		const opts = resolveEmbedClientOptions({});
		expect(opts.url).toBe("http://127.0.0.1:3851");
	});

	it("uses HONEYCOMB_EMBED_URL when set", () => {
		const opts = resolveEmbedClientOptions({ HONEYCOMB_EMBED_URL: "http://embed.internal:9000" });
		expect(opts.url).toBe("http://embed.internal:9000");
	});

	it("uses DEFAULT_EMBED_TIMEOUT_MS when HONEYCOMB_EMBED_TIMEOUT_MS is unset", () => {
		const opts = resolveEmbedClientOptions({});
		expect(opts.timeoutMs).toBe(5_000);
	});

	it("uses HONEYCOMB_EMBED_TIMEOUT_MS when set to a valid number", () => {
		const opts = resolveEmbedClientOptions({ HONEYCOMB_EMBED_TIMEOUT_MS: "8000" });
		expect(opts.timeoutMs).toBe(8_000);
	});

	it("falls back to default timeout for a non-numeric HONEYCOMB_EMBED_TIMEOUT_MS", () => {
		const opts = resolveEmbedClientOptions({ HONEYCOMB_EMBED_TIMEOUT_MS: "banana" });
		expect(opts.timeoutMs).toBe(5_000);
	});
});
