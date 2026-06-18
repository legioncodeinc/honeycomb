/**
 * PRD-013b document worker — proves b-AC-1..6 against the 013a fake append-only
 * store + a fake embed seam + a fake queue + a fake progress recorder.
 *
 * Verification posture (EXECUTION_LEDGER-prd-013): no live DeepLake here. The real
 * worker ({@link createDocumentWorker}) is driven against `FakeArtifactStore` (in-
 * memory, append-only, highest-version reads — the same contract the live backend
 * gives), a fake `EmbedClient` (counts calls + can be forced to fail), a fake
 * `JobQueueService` (records enqueue/complete/fail), and a fake `DocumentJobProgress`
 * (records the document-state sequence). The decisive assertions:
 *   - b-AC-1 URL dedup: same URL → same id, ONE record (no re-ingest);
 *   - b-AC-3 the job state machine advances queued→extracting→chunking→embedding→
 *     indexing→done, every transition version-bumped (an append), NO in-place UPDATE;
 *   - b-AC-2 embed-fail → the chunk is STILL written + keyword-searchable + the job
 *     reaches `done` (not `failed`);
 *   - b-AC-4 two docs with an IDENTICAL chunk → ONE embedding keyed by content_hash
 *     (the embed seam is called once for that hash; the second doc reuses it);
 *   - b-AC-5 delete → the document + ALL linked chunks soft-deleted (status advance)
 *     + history retained, NO in-place UPDATE;
 *   - b-AC-6 chunk size/overlap from `pipeline.*` → the configured window is applied.
 *
 * The load-bearing cross-cut: `store.emittedUpdate()` is asserted false after EVERY
 * mutating path — the whole subsystem is append-only.
 */

import { describe, expect, it } from "vitest";

import {
	chunkText,
	createDocumentWorker,
	DEFAULT_CHUNK_OVERLAP,
	DEFAULT_CHUNK_SIZE,
	type DocumentChunkConfig,
	type DocumentJobProgress,
	DOCUMENT_INGEST_JOB,
	type DocumentProgressState,
	type DocumentSubmission,
	type DocumentWorkerDeps,
	documentIdForUrl,
	resolveDocumentChunkConfig,
} from "../../../../src/daemon/runtime/sources/document-worker.js";
import { contentHash } from "../../../../src/daemon/runtime/sources/lifecycle.js";
import {
	ARTIFACT_ACTIVE,
	ARTIFACT_DELETED,
	DOCUMENT_CHUNK_TABLE,
	DOCUMENT_MEMORIES_TABLE,
	MEMORY_ARTIFACTS_TABLE,
} from "../../../../src/daemon/storage/catalog/sources.js";
import type { EmbedClient } from "../../../../src/daemon/runtime/services/embed-client.js";
import type { JobInput, JobQueueService, LeasedJob } from "../../../../src/daemon/runtime/services/job-queue.js";
import { FakeArtifactStore } from "../../../helpers/fake-artifact-store.js";

const SCOPE = { org: "acme", workspace: "backend" } as const;
const DIMS = 768;

/** A fixed 768-dim vector so the embed seam returns a schema-valid embedding. */
function vec(seed: number): number[] {
	return Array.from({ length: DIMS }, (_, i) => ((i + seed) % 7) / 7);
}

/** A fake embed client that counts calls per distinct text (b-AC-4) + can fail (b-AC-2). */
function fakeEmbed(options: { fail?: boolean } = {}): EmbedClient & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		async embed(text: string): Promise<readonly number[] | null> {
			calls.push(text);
			if (options.fail === true) return null; // b-AC-2: embedder unavailable → null.
			return vec(text.length);
		},
	};
}

/** A fake queue recording every enqueue + the terminal transition. */
function fakeQueue(): JobQueueService & { enqueued: JobInput[]; completed: string[]; failed: string[] } {
	const enqueued: JobInput[] = [];
	const completed: string[] = [];
	const failed: string[] = [];
	let seq = 0;
	return {
		enqueued,
		completed,
		failed,
		async enqueue(job: JobInput): Promise<string> {
			enqueued.push(job);
			seq += 1;
			return `job-${seq}`;
		},
		async lease(): Promise<LeasedJob | null> {
			return null;
		},
		async complete(id: string): Promise<void> {
			completed.push(id);
		},
		async fail(id: string): Promise<void> {
			failed.push(id);
		},
		start(): void {},
		stop(): void {},
	};
}

/** A fake progress recorder capturing the document-state sequence (b-AC-3). */
function fakeProgress(): DocumentJobProgress & { states: DocumentProgressState[] } {
	const states: DocumentProgressState[] = [];
	return {
		states,
		async advance(_jobId: string, state: DocumentProgressState): Promise<void> {
			states.push(state);
		},
	};
}

/** Build the worker + its fakes for a test, with optional dep overrides. */
function buildWorker(overrides: Partial<DocumentWorkerDeps> = {}) {
	const store = new FakeArtifactStore();
	const queue = fakeQueue();
	const embed = overrides.embed ?? fakeEmbed();
	const progress = fakeProgress();
	const worker = createDocumentWorker({
		storage: store,
		scope: SCOPE,
		queue,
		embed,
		progress,
		...overrides,
	});
	return { worker, store, queue, embed: embed as ReturnType<typeof fakeEmbed>, progress };
}

const submission = (url: string): DocumentSubmission => ({ url, org: SCOPE.org, workspace: SCOPE.workspace });

describe("PRD-013b document worker", () => {
	it("b-AC-1 POST /api/documents URL → id + status; an identical URL returns the EXISTING record (dedup, no re-ingest)", async () => {
		const { worker, store, queue } = buildWorker();

		const first = await worker.submit(submission("https://x.com/doc"));
		expect(first.documentId.startsWith("doc_")).toBe(true);
		expect(first.deduped).toBe(false);
		expect(first.status).toBe("done");

		const enqueuedAfterFirst = queue.enqueued.length;
		const docRowsAfterFirst = store.rowsOf(MEMORY_ARTIFACTS_TABLE).filter((r) => r.id === first.documentId).length;

		// Re-submit the IDENTICAL URL → the EXISTING record, NOT a re-ingest (b-AC-1).
		const second = await worker.submit(submission("https://x.com/doc"));
		expect(second.documentId).toBe(first.documentId);
		expect(second.deduped).toBe(true);

		// No second job enqueued + no new document-artifact version written on the re-submit.
		expect(queue.enqueued.length).toBe(enqueuedAfterFirst);
		const docRowsAfterSecond = store.rowsOf(MEMORY_ARTIFACTS_TABLE).filter((r) => r.id === first.documentId).length;
		expect(docRowsAfterSecond).toBe(docRowsAfterFirst);

		// The id is the deterministic dedup key over (org, workspace, url).
		expect(first.documentId).toBe(documentIdForUrl(SCOPE.org, SCOPE.workspace, "https://x.com/doc"));
		expect(store.emittedUpdate()).toBe(false);
	});

	it("b-AC-3 the document's job advances queued→extracting→chunking→embedding→indexing→done, version-bumped (append), NO in-place UPDATE", async () => {
		const { worker, store, queue, progress } = buildWorker();
		const result = await worker.submit(submission("https://x.com/lifecycle"));

		// The full progression in order (queued is the enqueue; the recorder captures the rest).
		expect(progress.states).toEqual(["extracting", "chunking", "embedding", "indexing", "done"]);
		expect(result.status).toBe("done");

		// The durable job was enqueued (queued) + completed (done).
		expect(queue.enqueued).toHaveLength(1);
		expect(queue.enqueued[0].kind).toBe(DOCUMENT_INGEST_JOB);
		expect(queue.completed).toHaveLength(1);
		expect(queue.failed).toHaveLength(0);

		// The document-artifact status advanced append-only: multiple physical versions,
		// the current (highest) one `active`, and NO in-place UPDATE ever emitted.
		const docRows = store.rowsOf(MEMORY_ARTIFACTS_TABLE).filter((r) => r.id === result.documentId);
		expect(docRows.length).toBeGreaterThan(1); // extracting → active = ≥2 appended versions
		expect(store.currentOf(MEMORY_ARTIFACTS_TABLE, result.documentId)?.status).toBe(ARTIFACT_ACTIVE);
		expect(store.emittedUpdate()).toBe(false);
	});

	it("b-AC-2 a chunk whose embedding FAILS is still written + keyword-searchable, and the job is NOT failed", async () => {
		const { worker, store, queue, embed, progress } = buildWorker({ embed: fakeEmbed({ fail: true }) });
		const result = await worker.submit(submission("https://x.com/embed-fail"));

		// The embed seam was called (and returned null), but the job still reached done.
		expect(embed.calls.length).toBeGreaterThan(0);
		expect(result.status).toBe("done");
		expect(progress.states).toContain("done");
		expect(progress.states).not.toContain("failed");
		expect(queue.completed).toHaveLength(1);
		expect(queue.failed).toHaveLength(0);

		// The chunk row exists (keyword-searchable content) with a NULL/absent embedding.
		const chunkRows = store.rowsOf(DOCUMENT_CHUNK_TABLE);
		expect(chunkRows.length).toBeGreaterThan(0);
		for (const chunk of chunkRows) {
			expect(typeof chunk.content).toBe("string");
			expect(String(chunk.content).length).toBeGreaterThan(0); // keyword-searchable
			// embedding left unset → recall degrades to lexical (b-AC-2).
			expect(chunk.chunk_embedding === undefined || chunk.chunk_embedding === null).toBe(true);
		}
		expect(store.emittedUpdate()).toBe(false);
	});

	it("b-AC-4 two documents with an IDENTICAL chunk share ONE embedding keyed by content_hash (embedded once)", async () => {
		// A chunk config small enough that the shared sentence is its own distinct chunk.
		const shared = "the same paragraph appears in both documents verbatim";
		const config: DocumentChunkConfig = { chunkSize: shared.length, chunkOverlap: 0 };
		const { worker, store, embed } = buildWorker({ chunkConfig: config });

		// Doc A: content is exactly the shared chunk.
		await worker.submit(submission(shared));
		const callsAfterA = embed.calls.length;
		expect(callsAfterA).toBe(1); // the shared content embedded once for doc A.

		// Doc B: a DIFFERENT url but byte-identical content → the chunk's content_hash
		// matches doc A's, so the worker REUSES the stored embedding (no re-embed).
		const before = embed.calls.length;
		await worker.submit({ url: shared, org: SCOPE.org, workspace: "frontend" });
		expect(embed.calls.length).toBe(before); // ZERO new embed calls — reused by content_hash (b-AC-4).

		// Both documents' chunks carry the SAME content_hash + the SAME stored embedding.
		const hash = contentHash(shared);
		const chunksWithHash = store.rowsOf(DOCUMENT_CHUNK_TABLE).filter((r) => r.content_hash === hash);
		expect(chunksWithHash.length).toBeGreaterThanOrEqual(2); // one per document
		for (const c of chunksWithHash) {
			expect(c.chunk_embedding).toBeDefined();
			expect(c.chunk_embedding).not.toBeNull();
		}
		expect(store.emittedUpdate()).toBe(false);
	});

	it("b-AC-5 a document delete soft-deletes the document + ALL linked chunk memories (status advance) + retains history; NO in-place UPDATE", async () => {
		// Force several chunks so the delete fans out across multiple linked chunks.
		const config: DocumentChunkConfig = { chunkSize: 10, chunkOverlap: 0 };
		const longUrl = "https://x.com/" + "abcdefghij".repeat(5); // > several 10-char chunks
		const { worker, store } = buildWorker({ chunkConfig: config });

		const { documentId } = await worker.submit(submission(longUrl));
		const activeChunkIds = store
			.rowsOf(DOCUMENT_CHUNK_TABLE)
			.filter((r) => r.status === ARTIFACT_ACTIVE)
			.map((r) => String(r.id));
		expect(activeChunkIds.length).toBeGreaterThan(1);

		const outcome = await worker.remove(documentId, SCOPE);
		expect(outcome.documentDeleted).toBe(true);
		expect(outcome.chunksDeleted).toBe(activeChunkIds.length);

		// The document's current row reads `deleted` (status advance — out of recall).
		expect(store.currentOf(MEMORY_ARTIFACTS_TABLE, documentId)?.status).toBe(ARTIFACT_DELETED);

		// EVERY linked chunk's current row reads `deleted`; and the LINK rows too.
		for (const chunkId of new Set(activeChunkIds)) {
			expect(store.currentOf(DOCUMENT_CHUNK_TABLE, chunkId)?.status).toBe(ARTIFACT_DELETED);
		}
		for (const link of store.rowsOf(DOCUMENT_MEMORIES_TABLE)) {
			if (link.document_id === documentId) {
				expect(store.currentOf(DOCUMENT_MEMORIES_TABLE, String(link.id))?.status).toBe(ARTIFACT_DELETED);
			}
		}

		// HISTORY retained: a soft-deleted chunk still has its prior ACTIVE version on disk.
		const someChunkId = activeChunkIds[0];
		const versions = store.rowsOf(DOCUMENT_CHUNK_TABLE).filter((r) => r.id === someChunkId);
		expect(versions.length).toBeGreaterThan(1); // v1 active + v2 deleted
		expect(versions.some((r) => r.status === ARTIFACT_ACTIVE)).toBe(true);

		// THE load-bearing assertion: the soft-delete is an append, NOT an in-place UPDATE.
		expect(store.emittedUpdate()).toBe(false);

		// A second remove is idempotent (already deleted → no-op, no UPDATE).
		const again = await worker.remove(documentId, SCOPE);
		expect(again.documentDeleted).toBe(false);
		expect(store.emittedUpdate()).toBe(false);
	});

	it("b-AC-6 a chunk size/overlap override under pipeline.* is applied when chunking", async () => {
		// 50-char content, size 20 overlap 5 → stride 15 → windows start at 0,15,30
		// (30+20≥50 ends it) = 3 chunks, the last running to the end.
		const content = "x".repeat(50);
		const config = resolveDocumentChunkConfig({ chunkSize: 20, chunkOverlap: 5 });
		expect(config.chunkSize).toBe(20);
		expect(config.chunkOverlap).toBe(5);

		const chunks = chunkText(content, config);
		expect(chunks).toHaveLength(3);
		expect(chunks[0]).toHaveLength(20);
		// Adjacent chunks share `overlap` trailing chars: chunk1 starts at stride=15,
		// so its first 5 chars are chunk0's chars [15,20).
		expect(chunks[1].slice(0, 5)).toBe(chunks[0].slice(15, 20));
		// The window honours the override, not the ~2000 default (which would yield 1 chunk).
		expect(chunks.length).toBeGreaterThan(1);

		// The configured window flows end-to-end: the worker writes exactly those chunks.
		const { worker, store } = buildWorker({ chunkConfig: config });
		const { documentId } = await worker.submit(submission(content));
		const written = store
			.rowsOf(DOCUMENT_CHUNK_TABLE)
			.filter((r) => r.artifact_id === documentId && r.status === ARTIFACT_ACTIVE);
		expect(written).toHaveLength(3);
		expect(store.emittedUpdate()).toBe(false);
	});

	it("b-AC-6 default chunk config is ~2000 chars / 200 overlap, clamped on a fat-fingered value", () => {
		const def = resolveDocumentChunkConfig();
		expect(def.chunkSize).toBe(DEFAULT_CHUNK_SIZE);
		expect(def.chunkOverlap).toBe(DEFAULT_CHUNK_OVERLAP);

		// A non-numeric knob falls back to the default (tuning noise, never a crash).
		const typo = resolveDocumentChunkConfig({ chunkSize: "huge", chunkOverlap: -5 });
		expect(typo.chunkSize).toBe(DEFAULT_CHUNK_SIZE);
		expect(typo.chunkOverlap).toBe(0); // clamped up to the floor

		// An over-large overlap is clamped below the size so the window always advances.
		const clamped = resolveDocumentChunkConfig({ chunkSize: 10, chunkOverlap: 100 });
		expect(clamped.chunkOverlap).toBeLessThan(clamped.chunkSize);
	});
});
