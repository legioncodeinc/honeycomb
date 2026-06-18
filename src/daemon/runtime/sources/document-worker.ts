/**
 * Document worker — PRD-013b HARNESS (Wave 1 scaffold; Wave 2 fills the body).
 *
 * The lighter ad-hoc document path: `POST /api/documents` submits a URL, and this
 * worker runs the per-document lifecycle as `memory_jobs`:
 *
 *     queued → extracting → chunking → embedding → indexing → done
 *
 * 013a ships the SHAPE — the {@link DocumentWorker} contract, the lifecycle state
 * machine enum, the URL-dedup seam, and the content-hash-shared-embedding seam —
 * with the chunk/embed/index STEPS as honest `// WAVE 2 (013b)` stubs. The 013b Bee
 * fills `extract`/`chunk`/`embed`/`index` against the SAME contract with zero
 * shared-file contention. The reusable mechanics it inherits:
 *
 *   - URL-DEDUP (b-AC-1): an identical URL returns the EXISTING document record
 *     rather than creating a second. The dedup key is a deterministic id over
 *     (org, workspace, url) — {@link documentIdForUrl} — so a re-submit resolves
 *     the same id. 013a scaffolds the check; 013b wires it to the real `memory_jobs`
 *     + `memory_artifacts` lookup.
 *   - CONTENT-HASH-SHARED EMBEDDING (b-AC-4): two documents whose chunk content is
 *     byte-identical share ONE embedding keyed by the chunk's `content_hash`
 *     (`document_chunk.content_hash`). The chunk write checks for an existing
 *     embedding under that hash before computing a new one. 013b owns the lookup;
 *     the seam is declared here.
 *   - EMBED FAIL-SOFT (b-AC-2): a chunk whose embedding fails is still written
 *     (keyword-searchable), and the job is NOT failed. The embed seam
 *     (`services/embed-client.ts`) returns null on failure; the worker proceeds.
 *   - SOFT-DELETE ON REMOVE (b-AC-5): a document delete soft-deletes the document
 *     artifact + every linked `document_chunk` via STATUS ADVANCE (the lifecycle
 *     engine's `softDelete`), never an in-place UPDATE — same mechanism as 013a.
 *   - CHUNK SIZE FROM `pipeline.*` (b-AC-6): the chunk size + overlap are read from
 *     the pipeline config (`pipeline.chunkSize` / `pipeline.chunkOverlap`), not
 *     hard-coded. The seam ({@link DocumentChunkConfig}) is declared; 013b reads it.
 *
 * ── What 013b MUST NOT touch ────────────────────────────────────────────────
 * 013b fills THIS file's stubbed methods + its own test. It does NOT edit the
 * catalog (`catalog/sources.ts` — the columns are final), the lifecycle engine
 * (`lifecycle.ts` — the soft-delete mechanism is final + reused), the contracts
 * (`contracts.ts`), or `server.ts`. The document worker writes through the SAME
 * `SourceLifecycle` + `SourceArtifactStore` 013a built — append-only, version-
 * bumped, deterministic-id — so it inherits the live-correct write path for free.
 */

import crypto from "node:crypto";

import { z } from "zod";

import {
	ARTIFACT_ACTIVE,
	ARTIFACT_DELETED,
	DOCUMENT_CHUNK_TABLE,
	DOCUMENT_MEMORIES_TABLE,
	MEMORY_ARTIFACTS_TABLE,
} from "../../storage/catalog/sources.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import { type ColumnValue, type RowValues, val } from "../../storage/writes.js";
import type { EmbedClient } from "../services/embed-client.js";
import type { JobQueueService } from "../services/job-queue.js";
import {
	artifactId,
	chunkId,
	contentHash,
	linkId,
	SourceArtifactStore,
} from "./lifecycle.js";
import type { Provenance } from "./contracts.js";

/**
 * The document lifecycle states (b-AC-3). A document's `memory_jobs` row advances
 * through these in order; `done` is terminal-success, `failed` is terminal-failure.
 * Frozen so the worker + the test read the SAME literals.
 */
export const DOCUMENT_STATES = Object.freeze([
	"queued",
	"extracting",
	"chunking",
	"embedding",
	"indexing",
	"done",
	"failed",
] as const);
/** A document lifecycle state. */
export type DocumentState = (typeof DOCUMENT_STATES)[number];

/** A document submission (the `POST /api/documents` body, scope-injected). */
export interface DocumentSubmission {
	/** The document URL to ingest. */
	readonly url: string;
	/** The org to mount the document into. */
	readonly org: string;
	/** The workspace to mount the document into. */
	readonly workspace: string;
}

/** The result of a submit (b-AC-1). `deduped` true → an identical URL existed. */
export interface SubmitResult {
	/** The document's id (deterministic over org/workspace/url). */
	readonly documentId: string;
	/** The current lifecycle status. */
	readonly status: DocumentState;
	/** True when an identical URL returned the EXISTING record (b-AC-1). */
	readonly deduped: boolean;
}

/** A document's view (the `GET /api/documents/:id` response). */
export interface DocumentView {
	/** The document id. */
	readonly documentId: string;
	/** The current lifecycle status. */
	readonly status: DocumentState;
	/** The source url. */
	readonly url: string;
}

/** The outcome of a document remove (b-AC-5). */
export interface DocumentRemoveOutcome {
	/** The document id. */
	readonly documentId: string;
	/** Whether the document artifact was soft-deleted. */
	readonly documentDeleted: boolean;
	/** How many linked chunks were soft-deleted. */
	readonly chunksDeleted: number;
}

/** Chunk size + overlap from `pipeline.*` (b-AC-6 seam). 013b reads the real config. */
export interface DocumentChunkConfig {
	/** Target chunk size (characters/tokens — 013b decides). From `pipeline.chunkSize`. */
	readonly chunkSize: number;
	/** Chunk overlap. From `pipeline.chunkOverlap`. */
	readonly chunkOverlap: number;
}

// ────────────────────────────────────────────────────────────────────────────
// pipeline.* chunk config (b-AC-6 / FR-3). Character-based chunking with a
// default of ~2000 chars and 200 overlap, configurable under `pipeline.*` in
// agent.yaml. Mirrors `pipeline/config.ts`: a raw-record provider seam, one zod
// boundary, and coerce/clamp the knobs rather than rejecting on a typo.
// ────────────────────────────────────────────────────────────────────────────

/** Default chunk size in characters (FR-3 — "roughly 2000 characters"). */
export const DEFAULT_CHUNK_SIZE = 2_000;
/** Default chunk overlap in characters (FR-3 — "200 characters of overlap"). */
export const DEFAULT_CHUNK_OVERLAP = 200;

/**
 * A positive-integer chunk knob: a non-numeric value falls back to the default, a
 * value below `min` is clamped up. A fat-fingered size is tuning noise, never a
 * config failure (mirrors `pipeline/config.ts` `ClampedInt`).
 */
function clampedChunkInt(def: number, min: number) {
	return z.preprocess((raw) => {
		const n = typeof raw === "number" ? raw : Number(raw);
		if (!Number.isFinite(n)) return def;
		return Math.max(min, Math.trunc(n));
	}, z.number().int());
}

/**
 * The validated chunk config the worker reads (b-AC-6). `chunkSize` is the target
 * character window; `chunkOverlap` is how many trailing characters the next chunk
 * re-includes. Both live under `pipeline.*` in `agent.yaml`.
 */
export const DocumentChunkConfigSchema = z
	.object({
		chunkSize: clampedChunkInt(DEFAULT_CHUNK_SIZE, 1).default(DEFAULT_CHUNK_SIZE),
		chunkOverlap: clampedChunkInt(DEFAULT_CHUNK_OVERLAP, 0).default(DEFAULT_CHUNK_OVERLAP),
	})
	// Overlap must be strictly LESS than the size or the window never advances; clamp
	// an over-large overlap down to size-1 rather than rejecting (tuning, not failure).
	.transform((cfg) => ({
		chunkSize: cfg.chunkSize,
		chunkOverlap: Math.min(cfg.chunkOverlap, Math.max(0, cfg.chunkSize - 1)),
	}));

/** The raw, un-validated `pipeline.*` chunk record the provider seam yields. */
export interface RawDocumentChunkConfig {
	/** Target chunk size from `pipeline.chunkSize`. */
	readonly chunkSize?: unknown;
	/** Chunk overlap from `pipeline.chunkOverlap`. */
	readonly chunkOverlap?: unknown;
}

/**
 * Resolve a raw `pipeline.*` chunk record into a validated {@link DocumentChunkConfig}
 * (b-AC-6). The schema clamps every knob, so resolution succeeds for nearly any
 * input and a typo falls back to the documented default. This is the single boundary
 * where the untrusted `pipeline.*` config crosses into the typed chunk config.
 */
export function resolveDocumentChunkConfig(raw: RawDocumentChunkConfig = {}): DocumentChunkConfig {
	return DocumentChunkConfigSchema.parse(raw);
}

/**
 * Split `content` into character-based chunks honoring the configured size + overlap
 * (b-AC-6 / FR-3). Each chunk is a `chunkSize`-character window; the next window
 * starts `chunkSize - chunkOverlap` characters along, so adjacent chunks share
 * `chunkOverlap` trailing characters. Pure + deterministic. An empty string yields a
 * single empty chunk so even an empty document produces one keyword-searchable row.
 */
export function chunkText(content: string, config: DocumentChunkConfig): string[] {
	const { chunkSize, chunkOverlap } = config;
	if (content.length <= chunkSize) return [content];
	const stride = Math.max(1, chunkSize - chunkOverlap);
	const out: string[] = [];
	for (let start = 0; start < content.length; start += stride) {
		out.push(content.slice(start, start + chunkSize));
		if (start + chunkSize >= content.length) break;
	}
	return out;
}

/**
 * The document worker contract (b-AC-1..6). 013a ships the contract + an honest
 * harness ({@link createDocumentWorkerHarness}); 013b fills the real worker behind
 * THIS interface so the API (`api.ts`) is untouched.
 */
export interface DocumentWorker {
	/** Submit a document → id + status; identical URL → existing record (b-AC-1). */
	submit(submission: DocumentSubmission): Promise<SubmitResult>;
	/** Read a document's view (id + status + url), or null when absent. */
	get(documentId: string, scope: QueryScope): Promise<DocumentView | null>;
	/** Soft-delete a document + its linked chunks via status advance (b-AC-5). */
	remove(documentId: string, scope: QueryScope): Promise<DocumentRemoveOutcome>;
}

/**
 * Derive the deterministic document id for a URL (b-AC-1 dedup key). INCLUDES the
 * org + workspace so the dedup is scoped, and the URL so an identical URL resolves
 * the SAME id (the dedup mechanism). Prefixed `doc_`. Pure.
 */
export function documentIdForUrl(org: string, workspace: string, url: string): string {
	const material = `${org}:${workspace}:${url.trim()}`;
	const hash = crypto.createHash("sha256").update(material).digest("hex").slice(0, 24);
	return `doc_${hash}`;
}

// ────────────────────────────────────────────────────────────────────────────
// The document-lifecycle progression seam (b-AC-3). A document's `memory_jobs`
// row advances queued→extracting→chunking→embedding→indexing→done — a
// version-bumped STATUS ADVANCE, reusing the job-queue's append-only transition
// shape, NEVER an in-place UPDATE. The worker drives this seam at each stage; the
// default records the progression append-only onto the durable `memory_jobs` row,
// and a test injects a fake that records the exact sequence.
// ────────────────────────────────────────────────────────────────────────────

/** The non-terminal + terminal document states the progress recorder advances through. */
export type DocumentProgressState = Exclude<DocumentState, "queued">;

/**
 * Records a document job's lifecycle-state advance (b-AC-3). Each call APPENDs a
 * new version of the job row carrying the advanced document state — an append, never
 * an in-place UPDATE — so the job's CURRENT state is its highest-version row and the
 * full progression stays on disk. The worker calls `advance` once per stage.
 */
export interface DocumentJobProgress {
	/** Append a version-bumped row advancing the job to `state` (b-AC-3). */
	advance(jobId: string, state: DocumentProgressState): Promise<void>;
}

/** A no-op progress recorder (the recorder is optional; absence means "don't record"). */
export const noopDocumentJobProgress: DocumentJobProgress = {
	async advance(): Promise<void> {
		/* no-op — a worker without a recorder still runs the lifecycle */
	},
};

/**
 * Build the 013b HARNESS document worker (Wave 1). It implements the dedup-by-URL +
 * submit→id+status shape with an IN-MEMORY map so the API surface is honest +
 * testable today (a resubmit of the same URL returns the existing record, b-AC-1),
 * and leaves the real lifecycle steps as `notImplemented`-shaped stubs that 013b
 * fills against the durable `memory_jobs` + `document_chunk` path.
 *
 * The harness is deliberately NOT wired into the daemon by default (`api.ts`
 * defaults `documentWorker: undefined` → the document routes return an honest 501),
 * so 013a ships no half-real document persistence. A TEST injects this harness to
 * exercise the dedup contract; 013b swaps in the real worker.
 */
export function createDocumentWorkerHarness(): DocumentWorker {
	// In-memory registry keyed by the deterministic document id (the dedup key).
	const docs = new Map<string, DocumentView>();

	return {
		async submit(submission: DocumentSubmission): Promise<SubmitResult> {
			const documentId = documentIdForUrl(submission.org, submission.workspace, submission.url);
			const existing = docs.get(documentId);
			if (existing !== undefined) {
				// b-AC-1: identical URL → return the EXISTING record (dedup).
				return { documentId, status: existing.status, deduped: true };
			}
			const view: DocumentView = { documentId, status: "queued", url: submission.url.trim() };
			docs.set(documentId, view);
			// WAVE 2 (013b): enqueue a `memory_jobs` document job and advance
			// queued → extracting → chunking → embedding → indexing → done (b-AC-3),
			// reading chunk size/overlap from `pipeline.*` (b-AC-6), sharing one
			// embedding per content_hash (b-AC-4), and keeping a chunk keyword-
			// searchable when its embedding fails (b-AC-2).
			return { documentId, status: "queued", deduped: false };
		},

		async get(documentId: string): Promise<DocumentView | null> {
			// WAVE 2 (013b): resolve the document's CURRENT status from the highest-
			// version `memory_jobs` row for this document id (poll-convergent).
			return docs.get(documentId) ?? null;
		},

		async remove(documentId: string): Promise<DocumentRemoveOutcome> {
			// WAVE 2 (013b): soft-delete (STATUS ADVANCE) the document artifact + every
			// linked `document_chunk` via the lifecycle engine's `softDelete` + the
			// `document_memories` links, never an in-place UPDATE (b-AC-5).
			const existed = docs.delete(documentId);
			return { documentId, documentDeleted: existed, chunksDeleted: 0 };
		},
	};
}

// ════════════════════════════════════════════════════════════════════════════
// The REAL 013b document worker (Wave 2). Fills the harness's stubbed body against
// the durable `memory_artifacts` + `document_chunk` + `document_memories` path,
// reusing the 013a `SourceArtifactStore` so it inherits the append-only, version-
// bumped, poll-convergent, deterministic-id write path for FREE. It NEVER edits the
// lifecycle engine, the catalog, the contracts, or `api.ts` (CONVENTIONS §7).
// ════════════════════════════════════════════════════════════════════════════

/** The job kind the document worker enqueues onto `memory_jobs` (b-AC-3). */
export const DOCUMENT_INGEST_JOB = "document_ingest" as const;

/** The artifact `kind` a submitted document row carries. */
const DOCUMENT_ARTIFACT_KIND = "document" as const;

/**
 * Fetches the canonical text of a submitted URL/file/text (the extract step). A
 * SEAM so the worker stays free of fetch/IO knowledge and a test injects fixed
 * content. The real daemon injects a fetcher that reads the URL; a null/throw is
 * surfaced as an extraction failure (the job fails — distinct from an embed failure,
 * which is non-fatal, b-AC-2).
 */
export interface DocumentContentFetcher {
	/** Fetch the document's canonical text + an optional title for a submission. */
	fetch(submission: DocumentSubmission): Promise<{ readonly content: string; readonly title?: string }>;
}

/**
 * A document's content hashed under its URL — the default fetcher echoes the URL as
 * content so the worker is runnable + testable with no network. The real daemon
 * swaps in a URL fetcher.
 */
export const echoDocumentContentFetcher: DocumentContentFetcher = {
	async fetch(submission: DocumentSubmission): Promise<{ content: string; title?: string }> {
		return { content: submission.url, title: submission.url };
	},
};

/** Construction deps for the real document worker (everything injected — CONVENTIONS §1). */
export interface DocumentWorkerDeps {
	/** Run every statement through this storage client — never a raw fetch. */
	readonly storage: StorageQuery;
	/** The resolved `{ org, workspace }` partition the document's rows are written under. */
	readonly scope: QueryScope;
	/** The durable job queue — submit enqueues a `document_ingest` job (b-AC-3). */
	readonly queue: JobQueueService;
	/** The embed seam — fail-soft; a null vector leaves the chunk keyword-searchable (b-AC-2). */
	readonly embed: EmbedClient;
	/** The chunk size + overlap from `pipeline.*` (b-AC-6). Defaults to the documented knobs. */
	readonly chunkConfig?: DocumentChunkConfig;
	/** The job-state progression recorder (b-AC-3). Defaults to {@link noopDocumentJobProgress}. */
	readonly progress?: DocumentJobProgress;
	/** Optional canonical→physical table resolver (identity in prod; a live itest injects a prefix). */
	readonly resolveTable?: (canonical: string) => string;
	/** The content fetcher (extract step). Defaults to {@link echoDocumentContentFetcher}. */
	readonly fetcher?: DocumentContentFetcher;
}

/** ISO now. */
function docNowIso(): string {
	return new Date().toISOString();
}

/** Serialize a 768-dim vector into a `ARRAY[...]::float4[]` SQL fragment (trusted numeric). */
function embeddingFragment(vector: readonly number[]): string {
	// Every element is a finite number (the embed seam already guards this); we render
	// a pure numeric literal — no string interpolation, so it is injection-free.
	const inner = vector.map((n) => (Number.isFinite(n) ? String(n) : "0")).join(", ");
	return `ARRAY[${inner}]::float4[]`;
}

/**
 * The real document worker (b-AC-1..6). Construct via {@link createDocumentWorker};
 * the daemon assembly injects it into `mountDocumentsApi` so `/api/documents` runs
 * the durable lifecycle. Every write goes through the 013a {@link SourceArtifactStore}
 * (append-only, version-bumped, deterministic-id) — so a re-submit is idempotent, a
 * delete is a status advance, and NO in-place UPDATE is ever emitted.
 */
class DurableDocumentWorker implements DocumentWorker {
	private readonly store: SourceArtifactStore;
	private readonly chunkConfig: DocumentChunkConfig;
	private readonly progress: DocumentJobProgress;
	private readonly fetcher: DocumentContentFetcher;

	constructor(private readonly deps: DocumentWorkerDeps) {
		this.store = new SourceArtifactStore(deps.storage, deps.scope, deps.resolveTable);
		this.chunkConfig = deps.chunkConfig ?? resolveDocumentChunkConfig();
		this.progress = deps.progress ?? noopDocumentJobProgress;
		this.fetcher = deps.fetcher ?? echoDocumentContentFetcher;
	}

	/**
	 * SUBMIT (b-AC-1): a URL → id + status; an IDENTICAL URL returns the EXISTING
	 * record (dedup by the deterministic {@link documentIdForUrl}) rather than
	 * re-ingesting. Resolves the document's CURRENT (highest-version) `memory_artifacts`
	 * row first; a non-deleted hit short-circuits with `deduped: true`. A miss enqueues
	 * a durable `document_ingest` job and runs the chunk/embed/index lifecycle.
	 */
	async submit(submission: DocumentSubmission): Promise<SubmitResult> {
		const url = submission.url.trim();
		const documentId = documentIdForUrl(submission.org, submission.workspace, url);

		// b-AC-1 dedup: a non-deleted document row under this id already exists → return it.
		const existing = await this.store.resolveCurrent(MEMORY_ARTIFACTS_TABLE, documentId);
		if (existing !== null && existing.status !== ARTIFACT_DELETED) {
			return { documentId, status: this.readState(existing), deduped: true };
		}

		// Enqueue the durable job (b-AC-3) — `queued` is its initial state.
		const jobId = await this.deps.queue.enqueue({
			kind: DOCUMENT_INGEST_JOB,
			payload: { documentId, url, org: submission.org, workspace: submission.workspace },
		});

		// Run the lifecycle synchronously here (the daemon's queue runner could instead
		// lease + run it; the worker exposes the steps so the contract test drives the
		// full progression deterministically). queued→extracting→chunking→embedding→
		// indexing→done — each an append-only status advance (b-AC-3).
		const status = await this.ingest(documentId, submission, url, jobId);
		return { documentId, status, deduped: false };
	}

	/**
	 * GET: resolve the document's CURRENT (highest-version) status from its
	 * `memory_artifacts` row, poll-convergent. Null when the document is absent or its
	 * current row is `deleted` (a removed document is not "found").
	 */
	async get(documentId: string, _scope: QueryScope): Promise<DocumentView | null> {
		const row = await this.store.resolveCurrent(MEMORY_ARTIFACTS_TABLE, documentId);
		if (row === null || row.status === ARTIFACT_DELETED) return null;
		return { documentId, status: this.readState(row), url: this.readUrl(row) };
	}

	/**
	 * REMOVE (b-AC-5): soft-delete the document + EVERY linked `document_chunk` via a
	 * STATUS ADVANCE (append a `deleted` version), and append a `deleted` version of
	 * each `document_memories` link — mirroring the lifecycle engine's append-only
	 * soft-delete. NEVER an in-place UPDATE. The link rows are the source of truth for
	 * "which chunks belong to this document", so chunk discovery is link-driven (a
	 * by-id resolve per link, not the spaced purge-discovery scan). History entries
	 * are retained: the prior active versions stay on disk; only the highest version
	 * reads `deleted`.
	 */
	async remove(documentId: string, _scope: QueryScope): Promise<DocumentRemoveOutcome> {
		// Resolve the document artifact's current state; absent/already-deleted → no-op.
		const docRow = await this.store.resolveCurrent(MEMORY_ARTIFACTS_TABLE, documentId);
		if (docRow === null || docRow.status === ARTIFACT_DELETED) {
			return { documentId, documentDeleted: false, chunksDeleted: 0 };
		}

		// Soft-delete every linked chunk via its link row (b-AC-5). Each link carries the
		// chunk id; we status-advance the chunk AND the link, both append-only.
		const linkIds = await this.linkIdsForDocument(documentId);
		let chunksDeleted = 0;
		for (const lnkId of linkIds) {
			const link = await this.store.resolveCurrent(DOCUMENT_MEMORIES_TABLE, lnkId);
			if (link === null || link.status === ARTIFACT_DELETED) continue;
			const chunkRowId = typeof link.chunk_id === "string" ? link.chunk_id : "";
			if (chunkRowId !== "" && (await this.store.softDelete(DOCUMENT_CHUNK_TABLE, chunkRowId))) {
				chunksDeleted += 1;
			}
			// Soft-delete the link itself so the edge falls out alongside its endpoints.
			await this.store.softDelete(DOCUMENT_MEMORIES_TABLE, lnkId);
		}

		// Soft-delete the document artifact LAST (dependent structure first).
		const documentDeleted = await this.store.softDelete(MEMORY_ARTIFACTS_TABLE, documentId);
		return { documentId, documentDeleted, chunksDeleted };
	}

	// ── internals ──────────────────────────────────────────────────────────────

	/**
	 * Run the per-document lifecycle (b-AC-3): extracting → chunking → embedding →
	 * indexing → done, recording each advance append-only (b-AC-2/b-AC-4/b-AC-6 happen
	 * inside the embedding/indexing steps). Returns the terminal state. An extraction
	 * failure fails the job (`failed`); an EMBED failure does NOT (b-AC-2).
	 */
	private async ingest(documentId: string, submission: DocumentSubmission, url: string, jobId: string): Promise<DocumentState> {
		const prov = this.provenanceFor(documentId, submission, url);

		// extracting — fetch the canonical content. A fetch failure is fatal to the job.
		await this.progress.advance(jobId, "extracting");
		let content: string;
		let title: string;
		try {
			const fetched = await this.fetcher.fetch(submission);
			content = fetched.content;
			title = fetched.title ?? url;
		} catch {
			await this.deps.queue.fail(jobId, "document extraction failed");
			await this.writeDocumentArtifact(documentId, prov, url, "failed", "");
			await this.progress.advance(jobId, "failed");
			return "failed";
		}

		// Write the document artifact at `extracting`-complete so `get` resolves a row.
		await this.writeDocumentArtifact(documentId, prov, url, "extracting", title);

		// chunking — character-based split honoring pipeline.* size + overlap (b-AC-6).
		await this.progress.advance(jobId, "chunking");
		const chunks = chunkText(content, this.chunkConfig);

		// embedding — compute one embedding per DISTINCT content hash (b-AC-4), fail-soft (b-AC-2).
		await this.progress.advance(jobId, "embedding");
		const embeddingByHash = await this.embedDistinct(chunks);

		// indexing — write each chunk + its doc→chunk link (append-only, version-bumped).
		await this.progress.advance(jobId, "indexing");
		await this.writeChunks(documentId, prov, chunks, embeddingByHash);

		// done — advance the artifact to `active` (recall-eligible) and complete the job.
		await this.writeDocumentArtifact(documentId, prov, url, ARTIFACT_ACTIVE, title);
		await this.deps.queue.complete(jobId);
		await this.progress.advance(jobId, "done");
		return "done";
	}

	/**
	 * Compute one embedding per DISTINCT chunk content hash (b-AC-4): identical chunks
	 * — within ONE document or ACROSS two — share a single embedding keyed by
	 * `content_hash`, so duplicate content is embedded ONCE. Before computing for a
	 * hash, probes any EXISTING `document_chunk` row carrying that hash and reuses its
	 * stored embedding (cross-document sharing). A null (embed disabled / failed) is
	 * cached too, so a failed hash is not retried per duplicate — and the chunk stays
	 * keyword-searchable (b-AC-2).
	 */
	private async embedDistinct(chunks: readonly string[]): Promise<Map<string, readonly number[] | null>> {
		const byHash = new Map<string, readonly number[] | null>();
		for (const content of chunks) {
			const hash = contentHash(content);
			if (byHash.has(hash)) continue; // already embedded this distinct content once (b-AC-4).
			// Cross-document reuse: an existing chunk with this hash already has a vector.
			const reused = await this.findStoredEmbedding(hash);
			if (reused !== undefined) {
				byHash.set(hash, reused);
				continue;
			}
			// Fail-soft (b-AC-2): a null vector (disabled / unreachable / wrong-dim) leaves
			// the column null; the chunk is still written + keyword-searchable.
			const vector = await this.embedSafely(content);
			byHash.set(hash, vector);
		}
		return byHash;
	}

	/** Embed one chunk, fail-soft: any throw resolves to null (the seam already returns null on the expected failures). */
	private async embedSafely(content: string): Promise<readonly number[] | null> {
		try {
			return await this.deps.embed.embed(content);
		} catch {
			return null; // b-AC-2: an unexpected throw is still non-fatal.
		}
	}

	/**
	 * Probe an existing `document_chunk` row sharing `content_hash` for a stored,
	 * non-null embedding (b-AC-4 cross-document reuse). Returns the vector when found,
	 * `undefined` when no prior row carries a usable embedding (so the caller computes
	 * one). Reads at most one row — the shared embedding is identical across duplicates.
	 */
	private async findStoredEmbedding(hash: string): Promise<readonly number[] | null | undefined> {
		const tbl = sqlIdent(this.deps.resolveTable ? this.deps.resolveTable(DOCUMENT_CHUNK_TABLE) : DOCUMENT_CHUNK_TABLE);
		const hashCol = sqlIdent("content_hash");
		const embCol = sqlIdent("chunk_embedding");
		const sql =
			`SELECT ${embCol} FROM "${tbl}" ` +
			`WHERE ${hashCol} = ${sLiteral(hash)} AND ${embCol} IS NOT NULL LIMIT 1`;
		const res = await this.deps.storage.query(sql, this.deps.scope);
		if (!isOk(res) || res.rows.length === 0) return undefined;
		const raw = (res.rows[0] as StorageRow).chunk_embedding;
		const vec = this.coerceVector(raw);
		return vec ?? undefined;
	}

	/** Coerce a stored embedding column back into a number[] — array, JSON string, or `ARRAY[...]` literal — else null. */
	private coerceVector(raw: unknown): readonly number[] | null {
		if (Array.isArray(raw) && raw.every((n) => typeof n === "number")) return raw as number[];
		if (typeof raw !== "string" || raw.length === 0) return null;
		// The column may come back as the `ARRAY[a, b, c]::float4[]` literal we wrote;
		// extract the bracketed numeric list (b-AC-4 reuse on a backend that echoes it).
		const arrayMatch = /^ARRAY\[(.*)\]/s.exec(raw);
		if (arrayMatch !== null) {
			const nums = arrayMatch[1]
				.split(",")
				.map((s) => Number(s.trim()))
				.filter((n) => Number.isFinite(n));
			return nums.length > 0 ? nums : null;
		}
		try {
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed) && parsed.every((n) => typeof n === "number")) return parsed as number[];
		} catch {
			return null; // an unrecognized literal is not reusable here — recompute.
		}
		return null;
	}

	/**
	 * Write the document's `memory_artifacts` row at the next version (b-AC-3 status
	 * advance). The document IS a `memory_artifacts` row of kind `document`; its
	 * `status` carries the document lifecycle state, advanced append-only. The `summary`
	 * column carries the canonical url so `get` can echo it.
	 */
	private async writeDocumentArtifact(documentId: string, prov: Provenance, url: string, status: string, title: string): Promise<void> {
		const version = (await this.store.maxVersion(MEMORY_ARTIFACTS_TABLE, documentId)) + 1;
		const now = docNowIso();
		await this.store.append(MEMORY_ARTIFACTS_TABLE, documentId, version, [
			...provenanceRowFor(prov),
			["kind", val.str(DOCUMENT_ARTIFACT_KIND)],
			["status", val.str(status)],
			["title", val.str(title)],
			["content", val.text(url)],
			["summary", val.text(url)],
			["content_hash", val.str(contentHash(url))],
			["failure_reason", val.str("")],
			["superseded_by", val.str("")],
			["created_at", val.str(now)],
			["updated_at", val.str(now)],
		]);
	}

	/**
	 * Write each chunk as a `document_chunk` row + a `document_memories` link (b-AC-4
	 * shared embedding attached, b-AC-2 fail-soft null embedding). Append-only +
	 * version-bumped + deterministic-id (idempotent re-index). The chunk embedding is
	 * the shared vector for the chunk's `content_hash`; a null leaves the column
	 * unset (keyword-searchable).
	 */
	private async writeChunks(
		documentId: string,
		prov: Provenance,
		chunks: readonly string[],
		embeddingByHash: Map<string, readonly number[] | null>,
	): Promise<void> {
		let ordinal = 0;
		for (const content of chunks) {
			const hash = contentHash(content);
			const rowId = chunkId(prov.sourceId, documentId, ordinal, content);
			const vector = embeddingByHash.get(hash) ?? null;
			const version = (await this.store.maxVersion(DOCUMENT_CHUNK_TABLE, rowId)) + 1;
			const now = docNowIso();
			const chunkRow: Array<readonly [string, ColumnValue]> = [
				["artifact_id", val.str(documentId)],
				...provenanceRowFor(prov),
				["kind", val.str("chunk")],
				["status", val.str(ARTIFACT_ACTIVE)],
				["content", val.text(content)],
				["content_hash", val.str(hash)],
				["ordinal", val.num(ordinal)],
				["superseded_by", val.str("")],
				["created_at", val.str(now)],
				["updated_at", val.str(now)],
			];
			// b-AC-2/b-AC-4: attach the shared embedding when present; a null leaves the
			// column at its DEFAULT (null) so the chunk stays keyword-searchable.
			if (vector !== null) {
				chunkRow.push(["chunk_embedding", val.raw(embeddingFragment(vector))]);
			}
			await this.store.append(DOCUMENT_CHUNK_TABLE, rowId, version, chunkRow);

			// The doc→chunk link (b-AC-5 uses it to soft-delete chunks with the document).
			const lnk = linkId(prov.sourceId, documentId, rowId);
			const linkVersion = (await this.store.maxVersion(DOCUMENT_MEMORIES_TABLE, lnk)) + 1;
			await this.store.append(DOCUMENT_MEMORIES_TABLE, lnk, linkVersion, [
				["document_id", val.str(documentId)],
				["chunk_id", val.str(rowId)],
				...provenanceRowFor(prov),
				["ordinal", val.num(ordinal)],
				["status", val.str(ARTIFACT_ACTIVE)],
				["created_at", val.str(now)],
				["updated_at", val.str(now)],
			]);
			ordinal += 1;
		}
	}

	/**
	 * Discover the link ids for a document (b-AC-5). Scans `document_memories` for the
	 * document's source_id, then filters to links whose `document_id` is this document.
	 * Link discovery uses the deterministic `linkId`, so a re-scan is stable; we union
	 * the ids the scan observes.
	 */
	private async linkIdsForDocument(documentId: string): Promise<string[]> {
		const ids = await this.store.scanIdsForSource(DOCUMENT_MEMORIES_TABLE, documentId);
		const matched: string[] = [];
		for (const id of ids) {
			const link = await this.store.resolveCurrent(DOCUMENT_MEMORIES_TABLE, id);
			if (link !== null && link.document_id === documentId) matched.push(id);
		}
		return matched;
	}

	/** The provenance for a document (its `source_id` IS the document id — self-rooted). */
	private provenanceFor(documentId: string, submission: DocumentSubmission, url: string): Provenance {
		return {
			sourceId: documentId,
			sourceKind: DOCUMENT_ARTIFACT_KIND,
			sourcePath: url,
			sourceRoot: url,
			org: submission.org,
			workspace: submission.workspace,
		};
	}

	/** Read the document lifecycle state off a `memory_artifacts` row (active → done). */
	private readState(row: StorageRow): DocumentState {
		const status = typeof row.status === "string" ? row.status : "";
		if (status === ARTIFACT_ACTIVE) return "done"; // an active document has finished ingesting.
		if ((DOCUMENT_STATES as readonly string[]).includes(status)) return status as DocumentState;
		return "queued";
	}

	/** Read the document url off a `memory_artifacts` row (`summary` carries it). */
	private readUrl(row: StorageRow): string {
		if (typeof row.summary === "string" && row.summary !== "") return row.summary;
		return typeof row.content === "string" ? row.content : "";
	}
}

/** Build the provenance-column `RowValues` fragment for a derived document row (a-AC-3). */
function provenanceRowFor(p: Provenance): RowValues {
	return [
		["source_id", val.str(p.sourceId)],
		["source_kind", val.str(p.sourceKind)],
		["source_path", val.str(p.sourcePath)],
		["source_root", val.str(p.sourceRoot)],
		["org_id", val.str(p.org)],
		["workspace_id", val.str(p.workspace)],
	];
}

/**
 * Build the real 013b document worker (Wave 2). The daemon assembly injects it into
 * `mountDocumentsApi` (CONVENTIONS §9) so `POST /api/documents` runs the durable
 * chunk/embed/index lifecycle; a test constructs it with a fake store + fake embed +
 * fake queue and drives the b-AC-1..6 contract.
 */
export function createDocumentWorker(deps: DocumentWorkerDeps): DocumentWorker {
	return new DurableDocumentWorker(deps);
}
