/**
 * PRD-045 W1 remediation — the URL fetcher is WIRED end-to-end.
 *
 * Two proofs the unit fetcher test cannot give:
 *   1. INJECTION: `buildSourcesApiDeps` constructs a document worker whose ingest
 *      chunks the FETCHED body (not the URL string). Driven against an IN-PROCESS
 *      loopback server with the real fetcher under the test escape hatch + the 013a
 *      FakeArtifactStore, then asserting the written chunk content is the body.
 *   2. API 400: a BLOCKED url surfaces out of `worker.submit` and `mountDocumentsApi`
 *      maps it to a clean 400 (caller error), never a 5xx stack — proven by mounting
 *      the real route over a worker whose fetcher throws an SsrfBlockedError.
 *
 * No public-internet access: the loopback server uses `allowLoopbackForTest`; the
 * 400-mapping test injects a throwing fetcher and never opens a socket.
 */

import { createServer, type Server } from "node:http";
import { type AddressInfo } from "node:net";

import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";

import { buildSourcesApiDeps } from "../../../../src/daemon/runtime/sources/registry.js";
import {
	createDocumentWorker,
	type DocumentContentFetcher,
} from "../../../../src/daemon/runtime/sources/document-worker.js";
import { createUrlDocumentFetcher, SsrfBlockedError } from "../../../../src/daemon/runtime/sources/url-fetcher.js";
import { mountDocumentsApi, type SourcesApiDeps } from "../../../../src/daemon/runtime/sources/api.js";
import {
	ARTIFACT_ACTIVE,
	DOCUMENT_CHUNK_TABLE,
} from "../../../../src/daemon/storage/catalog/sources.js";
import type { EmbedClient } from "../../../../src/daemon/runtime/services/embed-client.js";
import type { JobInput, JobQueueService, LeasedJob } from "../../../../src/daemon/runtime/services/job-queue.js";
import { FakeArtifactStore } from "../../../helpers/fake-artifact-store.js";

const SCOPE = { org: "local", workspace: "default" } as const;
const HEADERS = { "x-honeycomb-org": "local", "x-honeycomb-workspace": "default", "content-type": "application/json" };

/** Embeddings off → null-vector, no embed daemon. */
const noEmbed: EmbedClient = { async embed(): Promise<readonly number[] | null> { return null; } };

/** A minimal in-memory queue. */
function fakeQueue(): JobQueueService {
	let seq = 0;
	return {
		async enqueue(_job: JobInput): Promise<string> { seq += 1; return `job-${seq}`; },
		async lease(): Promise<LeasedJob | null> { return null; },
		async complete(): Promise<void> {},
		async fail(): Promise<void> {},
		start(): void {},
		stop(): void {},
	};
}

async function startServer(body: string): Promise<{ base: string; close: () => Promise<void> }> {
	const server: Server = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
		res.end(body);
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const { port } = server.address() as AddressInfo;
	return { base: `http://127.0.0.1:${port}`, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe("PRD-045 W1 — document URL fetcher wired end-to-end", () => {
	let srv: { base: string; close: () => Promise<void> } | undefined;
	afterEach(async () => {
		if (srv) await srv.close();
		srv = undefined;
	});

	it("INJECTION: the worker chunks the FETCHED body, not the URL string", async () => {
		srv = await startServer("THE ACTUAL DOCUMENT BODY that recall should index");
		const store = new FakeArtifactStore();
		// Build the deps exactly as the composition root does, but inject a fetcher with the
		// loopback hatch so the in-process server is reachable (production blocks loopback).
		const deps = buildSourcesApiDeps({
			storage: store,
			scope: SCOPE,
			queue: fakeQueue(),
			embed: noEmbed,
			fetcher: createUrlDocumentFetcher({ allowLoopbackForTest: true }),
		});
		const result = await deps.documentWorker!.submit({ url: `${srv.base}/d`, org: SCOPE.org, workspace: SCOPE.workspace });
		expect(result.status).toBe("done");

		const chunks = store.rowsOf(DOCUMENT_CHUNK_TABLE).filter((r) => r.status === ARTIFACT_ACTIVE);
		expect(chunks.length).toBeGreaterThan(0);
		const allContent = chunks.map((c) => String(c.content)).join("");
		// The decisive W1 assertion: the chunk content is the BODY, NOT the url string.
		expect(allContent).toContain("THE ACTUAL DOCUMENT BODY");
		expect(allContent).not.toContain(srv.base);
	});

	it("INJECTION DEFAULT: buildSourcesApiDeps with NO fetcher wires the real (loopback-blocking) one", async () => {
		// With no injected fetcher the assembly uses the real SSRF-safe one, which BLOCKS
		// loopback — so a submit to a loopback url fails its job cleanly (status `failed`)
		// rather than echoing the URL as content. (We use a loopback url because we cannot
		// reach the public internet in CI; the block is the observable signal the REAL
		// fetcher — not the echo stub — is wired.)
		srv = await startServer("unreachable under production guard");
		const store = new FakeArtifactStore();
		const deps = buildSourcesApiDeps({ storage: store, scope: SCOPE, queue: fakeQueue(), embed: noEmbed });
		// A blocked url throws out of submit (caller error) — proving the real guard is wired,
		// NOT the echo fetcher (which would have returned status `done` with the url as content).
		await expect(
			deps.documentWorker!.submit({ url: `${srv.base}/d`, org: SCOPE.org, workspace: SCOPE.workspace }),
		).rejects.toBeInstanceOf(SsrfBlockedError);
		// And NO chunk carries the url string as content (the echo-stub bug is gone).
		const chunks = store.rowsOf(DOCUMENT_CHUNK_TABLE);
		for (const c of chunks) expect(String(c.content)).not.toContain(srv.base);
	});

	it("API 400: a blocked url maps to a clean 400, never a 5xx stack", async () => {
		const blockingFetcher: DocumentContentFetcher = {
			async fetch(): Promise<{ content: string }> {
				throw new SsrfBlockedError("blocked address range");
			},
		};
		const store = new FakeArtifactStore();
		const worker = createDocumentWorker({ storage: store, scope: SCOPE, queue: fakeQueue(), embed: noEmbed, fetcher: blockingFetcher });
		const deps: SourcesApiDeps = {
			storage: store,
			queue: fakeQueue(),
			registry: { async register() { return ""; }, async get() { return null; }, async remove() {}, async list() { return []; } },
			providers: { resolve() { return null; } },
			documentWorker: worker,
		};
		const app = new Hono();
		mountDocumentsApi(app, deps);

		const res = await app.request("/", {
			method: "POST",
			headers: HEADERS,
			body: JSON.stringify({ url: "http://169.254.169.254/latest/meta-data/" }),
		});
		expect(res.status).toBe(400); // a clear 4xx caller error, NOT a 500.
		const json = (await res.json()) as { error?: string; reason?: string };
		expect(json.error).toBe("bad_request");
		// The reason names no internal IP (no topology leak through the API).
		expect(JSON.stringify(json)).not.toContain("169.254.169.254");
	});

	it("API still 202s for an allowed url (the 400 mapping does not break the happy path)", async () => {
		srv = await startServer("happy body");
		const store = new FakeArtifactStore();
		const worker = createDocumentWorker({
			storage: store,
			scope: SCOPE,
			queue: fakeQueue(),
			embed: noEmbed,
			fetcher: createUrlDocumentFetcher({ allowLoopbackForTest: true }),
		});
		const deps: SourcesApiDeps = {
			storage: store,
			queue: fakeQueue(),
			registry: { async register() { return ""; }, async get() { return null; }, async remove() {}, async list() { return []; } },
			providers: { resolve() { return null; } },
			documentWorker: worker,
		};
		const app = new Hono();
		mountDocumentsApi(app, deps);
		const res = await app.request("/", { method: "POST", headers: HEADERS, body: JSON.stringify({ url: `${srv.base}/ok` }) });
		expect(res.status).toBe(202);
		const json = (await res.json()) as { status?: string; documentId?: string };
		expect(json.documentId).toBeTypeOf("string");
		expect(json.status).toBe("done");
	});
});
