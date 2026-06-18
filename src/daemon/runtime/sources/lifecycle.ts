/**
 * Source lifecycle engine — PRD-013a Wave 1 (connect / index / update / health /
 * purge), proving a-AC-1..7.
 *
 * This is the provider-agnostic engine the source-artifact contract runs on. A
 * provider ({@link SourceProvider}) READS an external knowledge base and yields
 * {@link SourceArtifact}s; this engine turns each into durable rows
 * (`memory_artifacts` + native graph rows + provenanced `document_chunk` rows),
 * answers health, and — on disconnect — purges everything a source produced. The
 * source FILES are NEVER modified: a provider's `index()` is read-only and purge
 * touches only the store.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE NON-NEGOTIABLE MECHANIC — append-only soft-delete via STATUS ADVANCE
 * ════════════════════════════════════════════════════════════════════════════
 * a-AC-4 LITERALLY requires "status advance, not in-place UPDATE". Every removal
 * in this engine — a removed/renamed file ({@link updateInPlace}, a-AC-4) and a
 * disconnect purge ({@link purge}, a-AC-2) — is a STATUS ADVANCE: it reads the
 * row's CURRENT (highest-version) state and APPENDS a NEW version carrying the
 * SAME `id`, the prior `version` + 1, and `status` advanced to `deleted`, every
 * other column copied forward INTACT. The row's current state is its highest
 * version, so once that reads `deleted` the row falls out of recall — while full
 * history stays on disk. This is an INSERT, never an in-place UPDATE.
 *
 * Why never an in-place UPDATE / hard DELETE: this backend coalesces rapid UPDATEs
 * and serves reads from segments of differing freshness that flap non-monotonically
 * (a by-id SET can never converge), and a hard DELETE can leave rows (PRD-004 /
 * PRD-006e D-8). The append-only version-bump is the SAME mechanism `memory_jobs`,
 * `graph-persist.ts`, and `supersede.ts` all proved live: versions only ever
 * INCREASE and a higher version is never fictitious, so resolving a row by
 * MAX(version) across a bounded UNION of polled reads CONVERGES monotonically to
 * the true current state. The {@link SourceArtifactStore} below implements exactly
 * that: deterministic ids (sha256 incl. `source_id`), version-bumped appends,
 * poll-convergent highest-version reads, and poll-and-union multi-row scans.
 *
 * ── Deterministic ids → a clean scoped purge (D-1 / a-AC-2) ──────────────────
 * Every artifact / chunk / graph id is a sha256 that INCLUDES the `source_id`, so
 * a re-index resolves the SAME id (idempotent) and a purge selects EVERY row a
 * source produced by its `source_id` and NOTHING else. Another source's rows are
 * untouched (a-AC-2).
 *
 * ── Partial failure → FAILURE ARTIFACT, never a deletion (D-4 / a-AC-7) ──────
 * An artifact carrying a `failure` marker is written as a `status: 'failure'` row
 * ALONGSIDE the existing corpus and reported; no existing row is deleted. A failure
 * is a data point, not a removal.
 *
 * ── Lazy table create (D-5 / a-AC-5) ────────────────────────────────────────
 * The first write to a non-existent `memory_artifacts` / `document_chunk` table
 * heals (CREATE-from-ColumnDef) via the 002d write primitives' `withHeal` wrapper —
 * no prior migration. A new source kind just writes.
 *
 * ── SQL safety (FR-4 / a-AC-7) ──────────────────────────────────────────────
 * Every value routes through the 002d `val.*` constructors (→ `sLiteral`/`eLiteral`)
 * and every append through the heal-aware `appendOnlyInsert` (→ guarded
 * `buildInsert`); reads build their SELECT through `sqlIdent`/`sLiteral`. No value
 * is hand-quoted; no raw fetch. `npm run audit:sql` scans `src/daemon`.
 */

import crypto from "node:crypto";

import { healTargetFor } from "../../storage/catalog/index.js";
import {
	ARTIFACT_ACTIVE,
	ARTIFACT_DELETED,
	ARTIFACT_FAILURE,
	DOCUMENT_CHUNK_TABLE,
	DOCUMENT_MEMORIES_TABLE,
	MEMORY_ARTIFACTS_TABLE,
} from "../../storage/catalog/sources.js";
import type { HealTarget } from "../../storage/heal.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import { appendOnlyInsert, type RowValues, val } from "../../storage/writes.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import type { JobQueueService } from "../services/job-queue.js";
import type {
	IndexScope,
	Provenance,
	SourceArtifact,
	SourceChunk,
	SourceConfig,
	SourceProvider,
} from "./contracts.js";

/**
 * How many times a current-state / scan read is polled before taking the
 * MAX(version) / UNION it observed. Mirrors `services/job-queue.ts`'s
 * `RESOLVE_POLLS` + `graph-persist.ts`'s scan polling: this backend serves a read
 * from segments of differing freshness, so a single read can UNDER-report (a stale
 * lower version, a missed row) but NEVER over-reports — polling converges UP to the
 * durable truth. On the deterministic fake the first poll is authoritative.
 */
export const RESOLVE_POLLS = 8;

/**
 * The purge discovery scan (`scanIdsForSource`) is NOT on the write hot path, and a
 * just-indexed source's rows may not yet be query-visible on every segment when a
 * purge fires soon after an index — so a back-to-back poll burst (which spans only
 * milliseconds) can union to the EMPTY set and silently UNDER-PURGE, leaving orphaned
 * source rows. (This is the same propagation-window bug the `routing-history-live`
 * fix addressed.) The discovery scan therefore SPACES its polls so the budget spans
 * real wall-clock for fresh writes to propagate, with an early break once the id
 * union has been NON-EMPTY and stable for {@link DISCOVERY_STABLE_BREAK} consecutive
 * polls — so a production purge of long-propagated rows still returns in ~1s while a
 * purge soon after an index reliably converges. A scan never invents a row, so the
 * union only ever grows toward the true set.
 */
export const DISCOVERY_POLLS = 20;
/** Delay between purge-discovery polls so the budget spans ~8s (fresh-write propagation). */
export const DISCOVERY_POLL_DELAY_MS = 400;
/** Break discovery early once the id union is non-empty and unchanged for this many polls. */
export const DISCOVERY_STABLE_BREAK = 4;

/** Resolve after `ms`. Used only by the off-hot-path purge discovery scan. */
function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** ISO timestamp for `created_at` / `updated_at`. */
function nowIso(): string {
	return new Date().toISOString();
}

/** A lowercase-hex sha256 over the material, truncated to 24 chars. Pure. */
function hash24(material: string): string {
	return crypto.createHash("sha256").update(material).digest("hex").slice(0, 24);
}

/** sha256 over content (full, for the fingerprint + shared-embedding key). Pure. */
export function contentHash(content: string): string {
	return crypto.createHash("sha256").update(content, "utf8").digest("hex");
}

/**
 * Derive the deterministic `memory_artifacts.id` for a source unit (D-1). INCLUDES
 * the `source_id` so a purge is a clean scoped sweep and a re-index resolves the
 * SAME id (idempotent). Prefixed `art_`. Pure.
 */
export function artifactId(sourceId: string, sourcePath: string): string {
	return `art_${hash24(`${sourceId}:${sourcePath}`)}`;
}

/**
 * Derive the deterministic `document_chunk.id` for a chunk (D-1). INCLUDES the
 * `source_id` + the parent artifact id + the chunk ordinal/content so a re-index is
 * idempotent and the chunk is purgeable by `source_id`. Prefixed `chk_`. Pure.
 */
export function chunkId(sourceId: string, artifactRowId: string, ordinal: number, content: string): string {
	return `chk_${hash24(`${sourceId}:${artifactRowId}:${ordinal}:${contentHash(content)}`)}`;
}

/** Derive the deterministic `document_memories.id` for a doc→chunk link. Pure. */
export function linkId(sourceId: string, documentId: string, chunkRowId: string): string {
	return `lnk_${hash24(`${sourceId}:${documentId}:${chunkRowId}`)}`;
}

/** A structured-log sink the lifecycle reports lifecycle events to (optional). */
export interface SourceLifecycleLogger {
	/** Record a structured event (e.g. `source.indexed`, `source.purged`). */
	event(name: string, fields?: Record<string, unknown>): void;
}

/** The outcome of an index run, for the caller's audit + the health report. */
export interface IndexOutcome {
	/** The source id indexed. */
	readonly sourceId: string;
	/** Active artifacts written this run. */
	readonly artifactsWritten: number;
	/** Provenanced chunks written this run. */
	readonly chunksWritten: number;
	/** Native graph triples carried this run. */
	readonly graphTriplesWritten: number;
	/** Failure artifacts written this run (D-4 / a-AC-7). */
	readonly failuresWritten: number;
}

/** The outcome of a connect, for the API + the CLI. */
export interface ConnectOutcome {
	/** The registered source id. */
	readonly sourceId: string;
	/** The enqueued index job id (a-AC-1). */
	readonly jobId: string;
	/** The provider's initial health. */
	readonly health: Awaited<ReturnType<SourceProvider["health"]>>;
}

/** The outcome of a purge, for the API + the CLI (a-AC-2). */
export interface PurgeOutcome {
	/** The source id purged. */
	readonly sourceId: string;
	/** Artifacts soft-deleted (status advanced to `deleted`). */
	readonly artifactsPurged: number;
	/** Chunks soft-deleted. */
	readonly chunksPurged: number;
	/** Doc→chunk links soft-deleted. */
	readonly linksPurged: number;
	/** Whether the provider's connection was closed (d-AC-4). */
	readonly providerClosed: boolean;
}

/** A source's health report (FR-9 / a-AC-1). */
export interface SourceHealth {
	/** The source id. */
	readonly sourceId: string;
	/** The provider's reported health. */
	readonly provider: Awaited<ReturnType<SourceProvider["health"]>>;
	/** Active (non-deleted) artifact count. */
	readonly activeArtifacts: number;
	/** Active chunk count. */
	readonly activeChunks: number;
	/** Failure-artifact count (D-4). */
	readonly failures: number;
	/** Coarse derived status: `degraded` when the provider degrades or failures exist. */
	readonly status: "ok" | "degraded";
}

// ════════════════════════════════════════════════════════════════════════════
// SourceArtifactStore — the append-only, version-bumped, poll-convergent store the
// engine writes through. This is the live-correctness core (the same shape proven
// by memory_jobs / graph-persist / supersede). It is a class so a test can drive
// it directly and the engine composes it.
// ════════════════════════════════════════════════════════════════════════════

/** A row's resolved current state — its highest-version row, or null when absent. */
type CurrentRow = StorageRow | null;

/**
 * The append-only artifact store. Every write is a version-bumped APPEND; every
 * read that needs current state resolves the HIGHEST version per id; every multi-row
 * scan polls-and-unions. NO in-place UPDATE, NO hard DELETE.
 */
export class SourceArtifactStore {
	constructor(
		private readonly storage: StorageQuery,
		private readonly scope: QueryScope,
		/**
		 * Maps a canonical catalog table name to the PHYSICAL table to read/write.
		 * Identity in production (the canonical name IS the physical table). A live
		 * itest injects a per-run prefix so it reads/writes real throwaway tables
		 * NATIVELY — the heal CREATEs the physical name directly — instead of
		 * rewriting SQL strings after the fact (a SQL-string proxy races the heal's
		 * CREATE/introspect/ALTER and corrupts a fresh table; passing the physical
		 * name through the HealTarget is the proven isolation technique).
		 */
		private readonly resolveTable: (canonical: string) => string = (t) => t,
		/**
		 * Delay between purge-discovery polls. Defaults to {@link DISCOVERY_POLL_DELAY_MS}
		 * (production: spans the fresh-write propagation window). A unit test on the
		 * deterministic fake injects `0` — the fake is authoritative on the first poll,
		 * so the spacing is pure wall-clock waste that would push a purge test toward
		 * the vitest default timeout.
		 */
		private readonly discoveryPollDelayMs: number = DISCOVERY_POLL_DELAY_MS,
	) {}

	private target(table: string): HealTarget {
		const canonical = healTargetFor(table);
		const physical = this.resolveTable(table);
		return physical === table ? canonical : { ...canonical, table: physical };
	}

	/**
	 * Resolve a row's CURRENT (highest-version) state for an `id` in a table,
	 * poll-convergent. A single read can land on a stale segment (lower version);
	 * the MAX across {@link RESOLVE_POLLS} polls converges UP to the durable current
	 * version. Returns the row, or null when no row is readable.
	 */
	async resolveCurrent(table: string, id: string): Promise<CurrentRow> {
		const tbl = sqlIdent(this.resolveTable(table));
		const idCol = sqlIdent("id");
		const versionCol = sqlIdent("version");
		const sql =
			`SELECT * FROM "${tbl}" ` +
			`WHERE ${idCol} = ${sLiteral(id)} ` +
			`ORDER BY ${versionCol} DESC LIMIT 1`;
		let best: CurrentRow = null;
		let bestVersion = -Infinity;
		for (let poll = 0; poll < RESOLVE_POLLS; poll++) {
			const res = await this.storage.query(sql, this.scope);
			if (isOk(res) && res.rows.length > 0) {
				const row = res.rows[0] as StorageRow;
				const v = typeof row.version === "number" ? row.version : Number(row.version);
				const ver = Number.isFinite(v) ? v : 0;
				if (ver >= bestVersion) {
					bestVersion = ver;
					best = row;
				}
			}
		}
		return best;
	}

	/**
	 * Poll-and-union the DISTINCT `id`s of rows in a table matching a `source_id`
	 * whose CURRENT state is NOT `deleted`. A bare scan can MISS an id on a stale
	 * segment but never invents one (graph-persist's `scanDistinct`), so the union
	 * across polls converges UP to the true id set. The caller then resolves each
	 * id's current state. Returns the union of observed ids.
	 */
	async scanIdsForSource(table: string, sourceId: string): Promise<Set<string>> {
		const tbl = sqlIdent(this.resolveTable(table));
		const idCol = sqlIdent("id");
		const srcCol = sqlIdent("source_id");
		const sql =
			`SELECT DISTINCT ${idCol} FROM "${tbl}" ` +
			`WHERE ${srcCol} = ${sLiteral(sourceId)}`;
		const ids = new Set<string>();
		// Spaced polls so the budget spans real wall-clock (fresh-write propagation),
		// with an early break once the union is non-empty and stable — see
		// DISCOVERY_POLLS. Exhausting a back-to-back burst here would under-purge.
		let stable = 0;
		let lastSize = -1;
		for (let poll = 0; poll < DISCOVERY_POLLS; poll++) {
			const res = await this.storage.query(sql, this.scope);
			if (isOk(res)) {
				for (const row of res.rows as StorageRow[]) {
					const id = row.id;
					if (typeof id === "string" && id !== "") ids.add(id);
				}
			}
			if (ids.size > 0 && ids.size === lastSize) {
				stable += 1;
				if (stable >= DISCOVERY_STABLE_BREAK) break;
			} else {
				stable = 0;
			}
			lastSize = ids.size;
			if (poll < DISCOVERY_POLLS - 1) await sleep(this.discoveryPollDelayMs);
		}
		return ids;
	}

	/** Read the current MAX(version) for an id; 0 when absent. Poll-convergent. */
	async maxVersion(table: string, id: string): Promise<number> {
		const current = await this.resolveCurrent(table, id);
		if (current === null) return 0;
		const v = typeof current.version === "number" ? current.version : Number(current.version);
		return Number.isFinite(v) ? v : 0;
	}

	/** APPEND a version-bumped row (heal-aware → lazy create). Returns success. */
	async append(table: string, id: string, version: number, row: RowValues): Promise<boolean> {
		const full: RowValues = [...row, ["version", val.num(version)] as const];
		const res = await appendOnlyInsert(this.storage, this.target(table), this.scope, [["id", val.str(id)], ...full]);
		return isOk(res);
	}

	/**
	 * STATUS ADVANCE a row to `deleted` (a-AC-2 / a-AC-4) — the append-only soft-
	 * delete. Reads the row's current state, copies every column forward INTACT, and
	 * APPENDs a new version with `status='deleted'` + `updated_at` bumped. NEVER an
	 * in-place UPDATE. A no-op (returns false) when the row is already absent or
	 * already `deleted` — idempotent, so a re-run of a purge double-marks nothing.
	 */
	async softDelete(table: string, id: string): Promise<boolean> {
		const current = await this.resolveCurrent(table, id);
		if (current === null) return false;
		if (current.status === ARTIFACT_DELETED) return false;
		const version = (typeof current.version === "number" ? current.version : Number(current.version)) || 0;
		const row = this.copyForwardWithStatus(current, ARTIFACT_DELETED);
		return this.append(table, id, version + 1, row);
	}

	/**
	 * Copy a current row's columns forward INTACT, overriding only `status` and
	 * `updated_at`. Excludes `id` (the caller prepends it) and `version` (the append
	 * supplies the next). Every value is re-wrapped through the guarded `val.*`
	 * constructors — numbers as `num`, everything else as `str` — so no value is
	 * hand-quoted. Unknown/extra columns from a scan are skipped.
	 */
	private copyForwardWithStatus(current: StorageRow, status: string): RowValues {
		const out: Array<readonly [string, ReturnType<typeof val.str>]> = [];
		for (const [key, raw] of Object.entries(current)) {
			if (key === "id" || key === "version") continue;
			if (key === "status") continue;
			if (key === "updated_at") continue;
			if (raw === null || raw === undefined) continue;
			if (typeof raw === "number") {
				out.push([key, val.num(raw)]);
			} else if (typeof raw === "boolean") {
				out.push([key, val.num(raw ? 1 : 0)]);
			} else if (typeof raw === "string") {
				out.push([key, val.str(raw)]);
			}
			// Else (an array / object: a JSONB `metadata` column or a FLOAT4[]
			// `chunk_embedding`) is SKIPPED — never stringified. `val.str(String(arr))`
			// would write `"[object Object]"` / a stringified vector into a typed
			// column and the re-insert would FAIL, silently aborting the soft-delete
			// (the live purge bug: artifacts/chunks never status-advanced while the
			// scalar-only links table did). A tombstone only needs `status='deleted'`
			// at the highest version with its scalar provenance/scope intact; the heavy
			// columns keep their column DEFAULT on the deleted version — the active
			// history versions retain the full content.
		}
		out.push(["status", val.str(status)]);
		out.push(["updated_at", val.str(nowIso())]);
		return out;
	}
}

// ════════════════════════════════════════════════════════════════════════════
// The lifecycle engine — the public API the source registry / API / CLI call.
// ════════════════════════════════════════════════════════════════════════════

/** The source-config registry seam — registers + reads + lists source configs. */
export interface SourceRegistry {
	/** Register a source config; returns the assigned source id. */
	register(config: SourceConfig): Promise<string>;
	/** Read a registered config by source id, or null. */
	get(sourceId: string): Promise<SourceConfig | null>;
	/** Remove a config (the config-only half of a disconnect / daemon-down remove). */
	remove(sourceId: string): Promise<void>;
	/** List registered source ids. */
	list(): Promise<readonly string[]>;
}

/** Construction deps for the lifecycle engine (injected — CONVENTIONS §1). */
export interface SourceLifecycleDeps {
	/** Run every statement through this — never a raw fetch. */
	readonly storage: StorageQuery;
	/** The resolved `{ org, workspace }` partition for the source's rows. */
	readonly scope: QueryScope;
	/** The durable job queue — connect enqueues an index job (a-AC-1). */
	readonly queue: JobQueueService;
	/** The source-config registry (register / get / remove / list). */
	readonly registry: SourceRegistry;
	/** Optional structured-log sink. */
	readonly logger?: SourceLifecycleLogger;
	/**
	 * Optional canonical→physical table-name resolver (identity in production). A
	 * live itest injects a per-run prefix so it reads/writes real throwaway tables
	 * NATIVELY (the heal CREATEs the physical name), instead of a SQL-string proxy.
	 */
	readonly resolveTable?: (canonical: string) => string;
	/** Delay (ms) between purge-discovery polls; unit tests on the fake pass 0. Default 400. */
	readonly discoveryPollDelayMs?: number;
}

/** The job kind connect enqueues onto `memory_jobs` (a-AC-1). */
export const SOURCE_INDEX_JOB = "source_index" as const;

/**
 * The source lifecycle engine. Construct via {@link createSourceLifecycle}; the
 * API + CLI call its methods. Every removal is an append-only status advance.
 */
export class SourceLifecycle {
	private readonly store: SourceArtifactStore;

	constructor(private readonly deps: SourceLifecycleDeps) {
		this.store = new SourceArtifactStore(deps.storage, deps.scope, deps.resolveTable, deps.discoveryPollDelayMs);
	}

	/**
	 * CONNECT (a-AC-1): register the source config + enqueue an index job. The daemon
	 * owns the queue + the DeepLake connection; the client calls the daemon, never
	 * the store. Returns the source id, the enqueued job id, and the provider's
	 * initial health.
	 */
	async connect(provider: SourceProvider, config: SourceConfig): Promise<ConnectOutcome> {
		const sourceId = await this.deps.registry.register(config);
		const health = await provider.connect(config);
		const jobId = await this.deps.queue.enqueue({
			kind: SOURCE_INDEX_JOB,
			payload: { sourceId, kind: config.kind },
		});
		this.deps.logger?.event("source.connected", { sourceId, kind: config.kind, jobId });
		return { sourceId, jobId, health };
	}

	/**
	 * INDEX (a-AC-1 / a-AC-3 / a-AC-7): consume the provider's artifacts and write
	 * `memory_artifacts` rows + provenanced `document_chunk` rows (+ doc→chunk links),
	 * provenance on EVERY derived row. A normal artifact lands `status='active'`; an
	 * artifact carrying a `failure` marker lands `status='failure'` and NEVER deletes
	 * an existing row (D-4 / a-AC-7). Each write is a version-bumped append; the first
	 * write lazily creates the table (a-AC-5). Native graph triples are returned in the
	 * outcome for the graph layer to mount with provenance (carried, not persisted here
	 * — the ontology mount is out of 013a scope; the provenance is on the triple).
	 */
	async index(provider: SourceProvider, sourceId: string, scope: IndexScope = {}): Promise<IndexOutcome> {
		let artifactsWritten = 0;
		let chunksWritten = 0;
		let graphTriplesWritten = 0;
		let failuresWritten = 0;

		for await (const artifact of provider.index(scope)) {
			if (artifact.failure !== undefined) {
				await this.writeFailureArtifact(artifact);
				failuresWritten += 1;
				this.deps.logger?.event("source.failure_artifact", {
					sourceId,
					path: artifact.provenance.sourcePath,
					reason: artifact.failure.reason,
				});
				continue;
			}
			const rowId = await this.writeArtifact(artifact);
			artifactsWritten += 1;
			for (const chunk of artifact.chunks ?? []) {
				await this.writeChunk(rowId, artifact, chunk);
				chunksWritten += 1;
			}
			graphTriplesWritten += artifact.graphTriples?.length ?? 0;
		}

		this.deps.logger?.event("source.indexed", {
			sourceId,
			artifactsWritten,
			chunksWritten,
			graphTriplesWritten,
			failuresWritten,
		});
		return { sourceId, artifactsWritten, chunksWritten, graphTriplesWritten, failuresWritten };
	}

	/**
	 * UPDATE-IN-PLACE (a-AC-4): a changed or removed source unit. A REMOVED unit →
	 * SOFT-DELETE its artifact row via a STATUS ADVANCE (append a `deleted` version,
	 * NOT an in-place UPDATE) + purge its chunks (also status-advanced). A CHANGED
	 * unit → re-index it (a fresh active version) — handled by re-running {@link index}
	 * over the narrowed scope; this method owns the REMOVAL half. A rename is treated
	 * conservatively upstream as a delete + an add (013c-AC-5): the delete half lands
	 * here, the add half through index.
	 */
	async updateInPlace(sourceId: string, removedPath: string): Promise<{ artifactDeleted: boolean; chunksDeleted: number }> {
		const rowId = artifactId(sourceId, removedPath);
		const artifactDeleted = await this.store.softDelete(MEMORY_ARTIFACTS_TABLE, rowId);
		// Purge the unit's chunks: every chunk whose owning artifact is this rowId.
		const chunksDeleted = await this.softDeleteChunksForArtifact(sourceId, rowId);
		this.deps.logger?.event("source.unit_removed", { sourceId, path: removedPath, artifactDeleted, chunksDeleted });
		return { artifactDeleted, chunksDeleted };
	}

	/**
	 * HEALTH (FR-9 / a-AC-1): report the provider's health + the live store footprint
	 * (active artifacts/chunks, failure count). Degrades when the provider degrades OR
	 * any failure artifact exists. Counts are resolved by poll-and-union scan then a
	 * per-id current-state check, so a stale segment never under-reports the footprint.
	 */
	async health(provider: SourceProvider, sourceId: string): Promise<SourceHealth> {
		const providerHealth = await provider.health();
		const activeArtifacts = await this.countActive(MEMORY_ARTIFACTS_TABLE, sourceId);
		const activeChunks = await this.countActive(DOCUMENT_CHUNK_TABLE, sourceId);
		const failures = await this.countByStatus(MEMORY_ARTIFACTS_TABLE, sourceId, ARTIFACT_FAILURE);
		const status: "ok" | "degraded" =
			providerHealth.state !== "connected" || failures > 0 ? "degraded" : "ok";
		return { sourceId, provider: providerHealth, activeArtifacts, activeChunks, failures, status };
	}

	/**
	 * PURGE (a-AC-2): disconnect → remove the config + SOFT-DELETE (status advance)
	 * EVERY `memory_artifacts` + `document_chunk` + `document_memories` row for this
	 * `source_id`. The rows fall out of recall; the source FILES are untouched (purge
	 * only writes the store). Another source's rows remain (deterministic ids include
	 * `source_id`, so the scan is scoped). The provider's connection is CLOSED (d-AC-4:
	 * a gateway-tail purge closes the gateway). Idempotent: a re-run soft-deletes
	 * nothing already-deleted.
	 *
	 * Order: links → chunks → artifacts (dependent structure first), then config, then
	 * close — so nothing is orphaned and a partial purge resumes cleanly.
	 */
	async purge(provider: SourceProvider, sourceId: string): Promise<PurgeOutcome> {
		const linksPurged = await this.softDeleteAllForSource(DOCUMENT_MEMORIES_TABLE, sourceId);
		const chunksPurged = await this.softDeleteAllForSource(DOCUMENT_CHUNK_TABLE, sourceId);
		const artifactsPurged = await this.softDeleteAllForSource(MEMORY_ARTIFACTS_TABLE, sourceId);

		await this.deps.registry.remove(sourceId);
		await provider.close();

		this.deps.logger?.event("source.purged", { sourceId, artifactsPurged, chunksPurged, linksPurged });
		return { sourceId, artifactsPurged, chunksPurged, linksPurged, providerClosed: true };
	}

	// ── internals ──────────────────────────────────────────────────────────────

	/** Write (version-bump append) an active artifact; returns the deterministic id. */
	private async writeArtifact(artifact: SourceArtifact): Promise<string> {
		const p = artifact.provenance;
		const rowId = artifactId(p.sourceId, p.sourcePath);
		const version = (await this.store.maxVersion(MEMORY_ARTIFACTS_TABLE, rowId)) + 1;
		const now = nowIso();
		await this.store.append(MEMORY_ARTIFACTS_TABLE, rowId, version, [
			...provenanceRow(p),
			["kind", val.str(artifact.kind)],
			["status", val.str(ARTIFACT_ACTIVE)],
			["title", val.str(artifact.title)],
			["content", val.text(artifact.content)],
			["summary", val.text(artifact.summary ?? "")],
			["content_hash", val.str(contentHash(artifact.content))],
			["failure_reason", val.str("")],
			["metadata", metadataValue(artifact.metadata)],
			["superseded_by", val.str("")],
			["created_at", val.str(now)],
			["updated_at", val.str(now)],
		]);
		return rowId;
	}

	/** Write a FAILURE ARTIFACT (D-4 / a-AC-7) — never deletes an existing row. */
	private async writeFailureArtifact(artifact: SourceArtifact): Promise<void> {
		const p = artifact.provenance;
		// A failure artifact gets its OWN id keyed off the path + a `failure` tag, so it
		// never collides with (or supersedes) the unit's active row — both coexist.
		const rowId = `art_fail_${hash24(`${p.sourceId}:${p.sourcePath}`)}`;
		const version = (await this.store.maxVersion(MEMORY_ARTIFACTS_TABLE, rowId)) + 1;
		const now = nowIso();
		await this.store.append(MEMORY_ARTIFACTS_TABLE, rowId, version, [
			...provenanceRow(p),
			["kind", val.str(artifact.kind)],
			["status", val.str(ARTIFACT_FAILURE)],
			["title", val.str(artifact.title)],
			["content", val.text(artifact.content)],
			["summary", val.text("")],
			["content_hash", val.str("")],
			["failure_reason", val.text(artifact.failure?.reason ?? "unknown failure")],
			["metadata", metadataValue(artifact.failure?.detail)],
			["superseded_by", val.str("")],
			["created_at", val.str(now)],
			["updated_at", val.str(now)],
		]);
	}

	/** Write (version-bump append) a provenanced chunk + its doc→chunk link. */
	private async writeChunk(artifactRowId: string, artifact: SourceArtifact, chunk: SourceChunk): Promise<void> {
		const p = chunk.provenance;
		const rowId = chunkId(p.sourceId, artifactRowId, chunk.ordinal, chunk.content);
		const version = (await this.store.maxVersion(DOCUMENT_CHUNK_TABLE, rowId)) + 1;
		const now = nowIso();
		await this.store.append(DOCUMENT_CHUNK_TABLE, rowId, version, [
			["artifact_id", val.str(artifactRowId)],
			...provenanceRow(p),
			["kind", val.str("chunk")],
			["status", val.str(ARTIFACT_ACTIVE)],
			["content", val.text(chunk.content)],
			["content_hash", val.str(contentHash(chunk.content))],
			["ordinal", val.num(chunk.ordinal)],
			["metadata", metadataValue(chunk.metadata)],
			// chunk_embedding intentionally omitted (NULL) — the embed seam (013b)
			// attaches it later; a null embedding stays keyword-searchable (b-AC-2).
			["superseded_by", val.str("")],
			["created_at", val.str(now)],
			["updated_at", val.str(now)],
		]);

		// The doc→chunk link (013b uses it to soft-delete chunks with a document, b-AC-5).
		const link = linkId(p.sourceId, artifactRowId, rowId);
		const linkVersion = (await this.store.maxVersion(DOCUMENT_MEMORIES_TABLE, link)) + 1;
		await this.store.append(DOCUMENT_MEMORIES_TABLE, link, linkVersion, [
			["document_id", val.str(artifactRowId)],
			["chunk_id", val.str(rowId)],
			...provenanceRow(p),
			["ordinal", val.num(chunk.ordinal)],
			["status", val.str(ARTIFACT_ACTIVE)],
			["created_at", val.str(now)],
			["updated_at", val.str(now)],
		]);
	}

	/** Soft-delete (status advance) every non-deleted row for a source_id in a table. */
	private async softDeleteAllForSource(table: string, sourceId: string): Promise<number> {
		const ids = await this.store.scanIdsForSource(table, sourceId);
		let purged = 0;
		for (const id of ids) {
			if (await this.store.softDelete(table, id)) purged += 1;
		}
		return purged;
	}

	/** Soft-delete every chunk whose owning artifact is `artifactRowId` for a source. */
	private async softDeleteChunksForArtifact(sourceId: string, artifactRowId: string): Promise<number> {
		const ids = await this.store.scanIdsForSource(DOCUMENT_CHUNK_TABLE, sourceId);
		let purged = 0;
		for (const id of ids) {
			const current = await this.store.resolveCurrent(DOCUMENT_CHUNK_TABLE, id);
			if (current === null) continue;
			if (current.artifact_id !== artifactRowId) continue;
			if (await this.store.softDelete(DOCUMENT_CHUNK_TABLE, id)) purged += 1;
		}
		return purged;
	}

	/** Count rows for a source whose current state is `active`. */
	private async countActive(table: string, sourceId: string): Promise<number> {
		return this.countByStatus(table, sourceId, ARTIFACT_ACTIVE);
	}

	/** Count rows for a source whose current (highest-version) state has `status`. */
	private async countByStatus(table: string, sourceId: string, status: string): Promise<number> {
		const ids = await this.store.scanIdsForSource(table, sourceId);
		let count = 0;
		for (const id of ids) {
			const current = await this.store.resolveCurrent(table, id);
			if (current !== null && current.status === status) count += 1;
		}
		return count;
	}
}

/** Build the provenance-column `RowValues` fragment for a derived row (a-AC-3). */
function provenanceRow(p: Provenance): RowValues {
	return [
		["source_id", val.str(p.sourceId)],
		["source_kind", val.str(p.sourceKind)],
		["source_path", val.str(p.sourcePath)],
		["source_root", val.str(p.sourceRoot)],
		["org_id", val.str(p.org)],
		["workspace_id", val.str(p.workspace)],
	];
}

/** Render a schemaless metadata blob into the JSONB column value (text JSON). */
function metadataValue(metadata: Record<string, unknown> | undefined): ReturnType<typeof val.text> {
	return val.text(JSON.stringify(metadata ?? {}));
}

/** Build the source lifecycle engine. */
export function createSourceLifecycle(deps: SourceLifecycleDeps): SourceLifecycle {
	return new SourceLifecycle(deps);
}
