/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE document-worker SMOKE — OPT-IN, MUTATES A REAL DEEPLAKE BACKEND.   ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-013b: run the real document worker against a REAL DeepLake backend  ║
 * ║  end-to-end —                                                            ║
 * ║    1. submit(url) → the document + its chunks are written, status `done`;║
 * ║    2. submit(url) AGAIN → DEDUP: the SAME id, deduped=true, no re-ingest  ║
 * ║       (b-AC-1);                                                          ║
 * ║    3. remove(id) → the document + its linked chunks SOFT-DELETED via a    ║
 * ║       status advance (append a `deleted` version), files untouched        ║
 * ║       (b-AC-5) — and the rows fall out of recall while history remains.   ║
 * ║                                                                          ║
 * ║  GATED + ISOLATED exactly like sources-purge-live.itest.ts:             ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = skip.    ║
 * ║    - `.itest.ts` suffix keeps it OUT of `npm run test` / `npm run ci`.  ║
 * ║      Only `npm run test:integration` runs it.                            ║
 * ║    - Per-run throwaway `ci_doc_<runid>_*` tables routed NATIVELY via the  ║
 * ║      worker's `resolveTable` seam (the heal CREATEs the physical name),   ║
 * ║      DROPped in afterAll. Never touches the real artifact tables.         ║
 * ║                                                                          ║
 * ║  POLL-CONVERGENT read-backs: this backend serves a read from segments of ║
 * ║  differing freshness that flap non-monotonically, so an immediate read of ║
 * ║  just-written rows can under-report. Per-id current-state reads take the   ║
 * ║  MAX(version) across polls; a scan can miss a row but never invents one.  ║
 * ║                                                                          ║
 * ║  Do NOT run locally (no creds in this env) — the orchestrator runs it.  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createStorageClient,
	envCredentialProvider,
	isOk,
	resolveStorageConfig,
	sLiteral,
	sqlIdent,
	type StorageClient,
} from "../../src/daemon/storage/index.js";
import type { QueryScope } from "../../src/daemon/storage/client.js";
import {
	DOCUMENT_CHUNK_TABLE,
	DOCUMENT_MEMORIES_TABLE,
	MEMORY_ARTIFACTS_TABLE,
} from "../../src/daemon/storage/catalog/sources.js";
import {
	ARTIFACT_ACTIVE,
	ARTIFACT_DELETED,
	createDocumentWorker,
	type DocumentSubmission,
	documentIdForUrl,
} from "../../src/daemon/runtime/sources/index.js";
import type { EmbedClient } from "../../src/daemon/runtime/services/embed-client.js";
import type { JobInput, JobQueueService, LeasedJob } from "../../src/daemon/runtime/services/job-queue.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
const TBL_ARTIFACTS = `ci_doc_${RUN_ID}_artifacts`;
const TBL_CHUNKS = `ci_doc_${RUN_ID}_chunks`;
const TBL_LINKS = `ci_doc_${RUN_ID}_links`;

/** Poll budget — exhausted in full (the flap can serve the same stale segment twice). */
const SCAN_POLLS = 20;

/** A no-op durable queue (we drive the worker's lifecycle synchronously here). */
function liveQueue(): JobQueueService {
	return {
		async enqueue(_job: JobInput): Promise<string> {
			return "live-doc-job";
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

/** Embeddings OFF for the smoke (fail-soft path): null vector → keyword-searchable chunk (b-AC-2). */
const offEmbed: EmbedClient = {
	async embed(): Promise<readonly number[] | null> {
		return null;
	},
};

/**
 * Poll a by-id highest-version read {@link SCAN_POLLS} times; return the `status` of
 * the row with the MAX `version` observed (a stale segment under-reports the version,
 * never over-reports, so the max converges UP to the durable current state).
 */
async function currentStatus(store: StorageClient, table: string, id: string, scope: QueryScope): Promise<string | null> {
	const sql = `SELECT status, version FROM "${sqlIdent(table)}" WHERE id = ${sLiteral(id)} ORDER BY version DESC LIMIT 1`;
	let best: { status: string; version: number } | null = null;
	for (let poll = 0; poll < SCAN_POLLS; poll++) {
		const res = await store.query(sql, scope);
		if (isOk(res) && res.rows.length > 0) {
			const row = res.rows[0];
			const version = Number(row.version ?? 0);
			if (best === null || version > best.version) best = { status: String(row.status ?? ""), version };
		}
	}
	return best?.status ?? null;
}

describe.skipIf(!HAS_TOKEN)("live document-worker smoke (opt-in, real backend, dedup + append-only soft-delete)", () => {
	let storage: StorageClient;
	let scope: QueryScope;

	beforeAll(() => {
		const raw = envCredentialProvider().read();
		const provider = {
			read: () => ({
				...raw,
				workspace: process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "honeycomb_ci",
				queryTimeoutMs: 120_000,
			}),
		};
		const config = resolveStorageConfig(provider);
		scope = { org: config.org, workspace: config.workspace };
		storage = createStorageClient({ provider });
	});

	afterAll(async () => {
		if (!storage) return;
		// DROP is the reliable teardown on this backend (DELETE does not dependably remove rows).
		for (const tbl of [TBL_LINKS, TBL_CHUNKS, TBL_ARTIFACTS]) {
			const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(tbl)}"`, scope);
			if (!isOk(res)) console.warn(`[ci-cleanup] could not drop ${tbl}: ${JSON.stringify(res)}`);
		}
	});

	it("submit → done; identical URL → dedup (b-AC-1); remove → doc + chunks soft-deleted (b-AC-5)", async () => {
		// Route the canonical table names to per-run throwaway tables NATIVELY via the
		// worker's `resolveTable` seam — the heal CREATEs the physical throwaway table
		// directly (the proven recall-authz/graph-persist/sources-purge isolation
		// technique; a SQL-string proxy races the heal and corrupts a fresh table).
		const CI_TABLES: Record<string, string> = {
			[MEMORY_ARTIFACTS_TABLE]: TBL_ARTIFACTS,
			[DOCUMENT_CHUNK_TABLE]: TBL_CHUNKS,
			[DOCUMENT_MEMORIES_TABLE]: TBL_LINKS,
		};
		const resolveTable = (canonical: string): string => CI_TABLES[canonical] ?? canonical;

		const worker = createDocumentWorker({
			storage,
			scope,
			queue: liveQueue(),
			embed: offEmbed,
			// A small window so a representative document produces multiple linked chunks.
			chunkConfig: { chunkSize: 16, chunkOverlap: 4 },
			resolveTable,
		});

		const url = `https://example.com/${RUN_ID}/a-reasonably-long-document-body-for-chunking`;
		const submission: DocumentSubmission = { url, org: scope.org, workspace: scope.workspace ?? "default" };
		const documentId = documentIdForUrl(submission.org, submission.workspace, url);

		// 1. submit → the document indexes to `done` (status advances to `active`).
		const first = await worker.submit(submission);
		expect(first.documentId).toBe(documentId);
		expect(first.deduped).toBe(false);
		expect(first.status).toBe("done");
		expect(await currentStatus(storage, TBL_ARTIFACTS, documentId, scope)).toBe(ARTIFACT_ACTIVE);

		// 2. submit the IDENTICAL url AGAIN → dedup to the existing record (b-AC-1).
		const second = await worker.submit(submission);
		expect(second.documentId).toBe(documentId);
		expect(second.deduped).toBe(true);

		// 3. remove → the document + its linked chunks soft-delete via a status advance.
		const removed = await worker.remove(documentId, scope);
		expect(removed.documentDeleted).toBe(true);
		expect(removed.chunksDeleted).toBeGreaterThan(0);

		// The document's current row reads `deleted` (poll-convergent) — out of recall,
		// history retained (the active versions stay on disk).
		expect(await currentStatus(storage, TBL_ARTIFACTS, documentId, scope)).toBe(ARTIFACT_DELETED);
	});
});
