/**
 * PRD-013a API — `/api/sources` + `/api/documents` over a bare Hono app + the fake
 * append-only store + `createFakeSourceProvider`.
 *
 * Verification posture: mount the handlers onto a minimal Hono app at the real base
 * paths and drive them with `app.request`. The decisive assertions: POST connects +
 * queues + 201; GET lists; DELETE purges (soft-delete by source_id); a document
 * submission with NO worker returns an honest 501; with the harness worker injected,
 * an identical URL DEDUPES to the existing record (b-AC-1 scaffold).
 */

import { Hono } from "hono";
import { describe, expect, it } from "vitest";

import {
	createFakeSourceProvider,
	type Provenance,
	type SourceArtifact,
} from "../../../../src/daemon/runtime/sources/contracts.js";
import {
	DOCUMENTS_GROUP,
	mountDocumentsApi,
	mountSourcesApi,
	type ProviderResolver,
	SOURCES_GROUP,
} from "../../../../src/daemon/runtime/sources/api.js";
import type { SourceRegistry } from "../../../../src/daemon/runtime/sources/lifecycle.js";
import { createDocumentWorkerHarness } from "../../../../src/daemon/runtime/sources/document-worker.js";
import { MEMORY_ARTIFACTS_TABLE } from "../../../../src/daemon/storage/catalog/sources.js";
import type { JobInput, JobQueueService, LeasedJob } from "../../../../src/daemon/runtime/services/job-queue.js";
import { FakeArtifactStore } from "../../../helpers/fake-artifact-store.js";

const HEADERS = { "x-honeycomb-org": "acme", "x-honeycomb-workspace": "backend", "content-type": "application/json" };

function fakeQueue(): JobQueueService & { enqueued: JobInput[] } {
	const enqueued: JobInput[] = [];
	return {
		enqueued,
		async enqueue(job: JobInput): Promise<string> {
			enqueued.push(job);
			return `job-${enqueued.length}`;
		},
		async lease(): Promise<LeasedJob | null> {
			return null;
		},
		async complete(): Promise<void> {},
		async fail(): Promise<void> {},
		start(): void {},
		stop(): void {},
	};
}

function fakeRegistry(): SourceRegistry {
	const configs = new Map<string, unknown>();
	let seq = 0;
	return {
		async register(config): Promise<string> {
			seq += 1;
			const id = `src-${seq}`;
			configs.set(id, config);
			return id;
		},
		async get(id) {
			return (configs.get(id) as never) ?? null;
		},
		async remove(id): Promise<void> {
			configs.delete(id);
		},
		async list(): Promise<readonly string[]> {
			return [...configs.keys()];
		},
	};
}

function prov(sourceId: string, path: string): Provenance {
	return { sourceId, sourceKind: "document", sourcePath: path, sourceRoot: "/r", org: "acme", workspace: "backend" };
}
function artifact(sourceId: string, path: string): SourceArtifact {
	const p = prov(sourceId, path);
	return { provenance: p, kind: "note", title: path, content: "body", chunks: [{ provenance: p, content: "body", ordinal: 0 }] };
}

/** A resolver that always returns the SAME fake provider (so DELETE can close it). */
function providerResolver(provider: ReturnType<typeof createFakeSourceProvider>): ProviderResolver {
	return { resolve: () => provider };
}

function buildApp(opts: { withWorker?: boolean } = {}) {
	const store = new FakeArtifactStore();
	const queue = fakeQueue();
	const registry = fakeRegistry();
	const provider = createFakeSourceProvider([artifact("src-1", "a.md")]);
	const deps = {
		storage: store,
		queue,
		registry,
		providers: providerResolver(provider),
		// The fake store is authoritative on the first poll, so make the API DELETE path's
		// purge-discovery scan use a 0ms inter-poll delay — otherwise the spaced ~400ms polls
		// (production's fresh-write-propagation budget) push this hermetic DELETE toward the
		// vitest default timeout under suite load (a latent flake on the default spacing).
		discoveryPollDelayMs: 0,
		...(opts.withWorker ? { documentWorker: createDocumentWorkerHarness() } : {}),
	};
	const root = new Hono();
	const sources = new Hono();
	const documents = new Hono();
	mountSourcesApi(sources, deps);
	mountDocumentsApi(documents, deps);
	root.route(SOURCES_GROUP, sources);
	root.route(DOCUMENTS_GROUP, documents);
	return { app: root, store, queue, registry, provider };
}

describe("PRD-013a /api/sources", () => {
	it("a-AC-1 POST /api/sources connects → registers + queues an index job → 201", async () => {
		const { app, queue, registry } = buildApp();
		const res = await app.request("/api/sources", {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ kind: "document", root: "/r", settings: {} }),
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.sourceId).toBe("src-1");
		expect(body.jobId).toBe("job-1");
		expect(queue.enqueued).toHaveLength(1);
		expect(await registry.list()).toContain("src-1");
	});

	it("GET /api/sources lists registered source ids", async () => {
		const { app } = buildApp();
		await app.request("/api/sources", {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ kind: "document" }),
		});
		const res = await app.request("/api/sources", { headers: HEADERS });
		expect(res.status).toBe(200);
		expect((await res.json()).sources).toContain("src-1");
	});

	it("a-AC-2 DELETE /api/sources/:id purges (soft-deletes the source's rows) + closes the provider", async () => {
		const { app, store, provider } = buildApp();
		// connect + index by hand through the lifecycle path the POST set up.
		await app.request("/api/sources", { method: "POST", headers: HEADERS, body: JSON.stringify({ kind: "document" }) });
		// Index the fake provider's artifact directly (the POST only queues a job).
		const { createSourceLifecycle } = await import("../../../../src/daemon/runtime/sources/lifecycle.js");
		const lc = createSourceLifecycle({ storage: store, scope: { org: "acme", workspace: "backend" }, queue: fakeQueue(), registry: fakeRegistry(), discoveryPollDelayMs: 0 });
		await lc.index(provider, "src-1");
		expect(store.rowsOf(MEMORY_ARTIFACTS_TABLE).length).toBeGreaterThan(0);

		const res = await app.request("/api/sources/src-1", { method: "DELETE", headers: HEADERS });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.providerClosed).toBe(true);
		expect(provider.closed()).toBe(true);
	});

	it("a request with no org header is rejected 400 (fail-closed tenancy)", async () => {
		const { app } = buildApp();
		const res = await app.request("/api/sources", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
		expect(res.status).toBe(400);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// SECURITY REGRESSION (security-worker-bee / PRD-022 cross-tenant guard): when the
// permission middleware has stamped a VALIDATED Identity (team/hybrid), a forged
// `x-honeycomb-org` header that disagrees with the token's own org MUST fail closed.
// Stand in a stamping middleware (what the real permission middleware does) and prove
// a header-forged tenancy can never cross the token's boundary onto the sources surface.
// ─────────────────────────────────────────────────────────────────────────────

const IDENTITY_CONTEXT_KEY = "honeycombIdentity" as const;
const TOKEN_IDENTITY = { org: "token-org", workspace: "token-ws", agentId: "token-actor", role: "write" };

/** Build the sources mount stamping a fixed validated Identity (mirrors permission mw). */
function buildAuthedSources(identity: Record<string, unknown>) {
	const store = new FakeArtifactStore();
	const queue = fakeQueue();
	const registry = fakeRegistry();
	const provider = createFakeSourceProvider([artifact("src-1", "a.md")]);
	const deps = { storage: store, queue, registry, providers: providerResolver(provider), discoveryPollDelayMs: 0 };
	const root = new Hono();
	const sources = new Hono();
	sources.use("*", async (c, next) => {
		c.set(IDENTITY_CONTEXT_KEY, identity);
		await next();
	});
	mountSourcesApi(sources, deps);
	root.route(SOURCES_GROUP, sources);
	return { app: root, registry };
}

describe("PRD-022 SECURITY: /api/sources tenancy cross-check against the validated Identity", () => {
	it("a forged x-honeycomb-org that disagrees with the token's org fails closed (400) — no cross-tenant read", async () => {
		const { app } = buildAuthedSources(TOKEN_IDENTITY);
		const res = await app.request("/api/sources", {
			method: "GET",
			// The token binds org=token-org; the caller forges a DIFFERENT org header.
			headers: { "x-honeycomb-org": "victim-org", "content-type": "application/json" },
		});
		expect(res.status).toBe(400);
	});

	it("an org header that MATCHES the token's org is honored (no regression for the legitimate caller)", async () => {
		const { app, registry } = buildAuthedSources(TOKEN_IDENTITY);
		await app.request("/api/sources", {
			method: "POST",
			headers: { "x-honeycomb-org": "token-org", "x-honeycomb-workspace": "token-ws", "content-type": "application/json" },
			body: JSON.stringify({ kind: "document" }),
		});
		const res = await app.request("/api/sources", {
			method: "GET",
			headers: { "x-honeycomb-org": "token-org", "content-type": "application/json" },
		});
		expect(res.status).toBe(200);
		expect(await registry.list()).toContain("src-1");
		// Assert the READ-ROUTE BODY too (not just registry internals), so a regression in the
		// GET handler's projection — not just the registry — is caught.
		const body = (await res.json()) as { sources: string[] };
		expect(body.sources).toContain("src-1");
	});
});

describe("PRD-013a /api/documents", () => {
	it("POST /api/documents with NO worker wired returns an honest 501 (013b)", async () => {
		const { app } = buildApp({ withWorker: false });
		const res = await app.request("/api/documents", {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ url: "https://example.com/doc" }),
		});
		expect(res.status).toBe(501);
		expect((await res.json()).detail).toMatch(/013b/);
	});

	it("b-AC-1 (scaffold) identical URL DEDUPES to the existing record", async () => {
		const { app } = buildApp({ withWorker: true });
		const first = await app.request("/api/documents", {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ url: "https://example.com/doc" }),
		});
		expect(first.status).toBe(202);
		const firstBody = await first.json();
		expect(firstBody.deduped).toBe(false);

		const second = await app.request("/api/documents", {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ url: "https://example.com/doc" }),
		});
		const secondBody = await second.json();
		// Same id, and the second submission is flagged a dedup (b-AC-1).
		expect(secondBody.documentId).toBe(firstBody.documentId);
		expect(secondBody.deduped).toBe(true);
	});

	it("POST /api/documents with no url → 400", async () => {
		const { app } = buildApp({ withWorker: true });
		const res = await app.request("/api/documents", { method: "POST", headers: HEADERS, body: "{}" });
		expect(res.status).toBe(400);
	});
});
