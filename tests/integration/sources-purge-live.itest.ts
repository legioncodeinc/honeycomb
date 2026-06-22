/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE sources-purge SMOKE — OPT-IN, MUTATES A REAL DEEPLAKE BACKEND.     ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-013a: write source-artifact + chunk rows for source A AND source B  ║
 * ║  to the REAL DeepLake backend, then purge(A) → assert A's rows are       ║
 * ║  SOFT-DELETED (status advance — gone from recall) while B's rows REMAIN  ║
 * ║  active. Proves the append-only purge-by-source_id converges LIVE.      ║
 * ║                                                                          ║
 * ║  GATED + ISOLATED exactly like graph-persist-live.itest.ts:              ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = skip.    ║
 * ║    - `.itest.ts` suffix keeps it OUT of `npm run test` / `npm run ci`.  ║
 * ║      Only `npm run test:integration` runs it.                            ║
 * ║    - Authorised workspace (`HONEYCOMB_DEEPLAKE_WORKSPACE`, default       ║
 * ║      `honeycomb_ci`). Per-run throwaway `ci_src_<runid>_*` tables,       ║
 * ║      DROPped in afterAll. Never touches the real artifact tables.        ║
 * ║    - `queryTimeoutMs: 120_000`.                                          ║
 * ║                                                                          ║
 * ║  POLL-CONVERGENT read-backs (the bug that kept main CI red): this        ║
 * ║  backend serves a scan from segments of differing freshness that flap    ║
 * ║  NON-MONOTONICALLY, so a SINGLE immediate read of just-written rows can   ║
 * ║  under-report. Multi-row read-backs MUST poll-and-union; a per-id        ║
 * ║  current-state read MUST take the MAX(version) across polls. A scan can   ║
 * ║  miss a row but never invents one, so polling converges UP to the truth. ║
 * ║                                                                          ║
 * ║  Do NOT run locally (no creds in this env) — the orchestrator runs it.  ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	type ConvergeBudgetOverride,
	createStorageClient,
	envCredentialProvider,
	isOk,
	type QueryResult,
	readConverged,
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
	createFakeSourceProvider,
	type Provenance,
	type SourceArtifact,
} from "../../src/daemon/runtime/sources/index.js";
import {
	artifactId,
	createSourceLifecycle,
	type SourceRegistry,
} from "../../src/daemon/runtime/sources/lifecycle.js";
import type { JobInput, JobQueueService, LeasedJob } from "../../src/daemon/runtime/services/job-queue.js";
import { neutralizeIfInfraDegraded } from "./_infra-skip.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
const TBL_ARTIFACTS = `ci_src_${RUN_ID}_artifacts`;
const TBL_CHUNKS = `ci_src_${RUN_ID}_chunks`;
const TBL_LINKS = `ci_src_${RUN_ID}_links`;

/**
 * The GENEROUS convergence budget the status read-back honors, routed through the ONE
 * shared `readConverged` seam (PRD-028 D-4 — no bespoke poll loop). PRD-034a (FR-3):
 * the old bespoke `SCAN_POLLS=20` loop had NO backoff and inherited the suite's 60s
 * per-test default, so under backend latency it could exhaust before the soft-delete
 * status advance coalesced into the served segments — a HEALTHY purge red-ing on
 * weather. This widened budget (≈30s / 40 attempts, jittered backoff) gives the status
 * advance room to converge; it only governs HOW LONG we wait, never WHAT we assert.
 */
const STATUS_BUDGET: ConvergeBudgetOverride = {
	maxAttempts: 40,
	maxWallClockMs: 30_000,
	backoffBaseMs: 150,
	backoffCapMs: 1_000,
};

/** A generous per-test ceiling (FR-3) — a safety net above the convergence budget, not the bar. */
const GENEROUS_TEST_CEILING_MS = 120_000;

/** A no-op queue + registry for the live lifecycle (we drive index/purge directly). */
function liveQueue(): JobQueueService {
	return {
		async enqueue(_job: JobInput): Promise<string> {
			return "live-job";
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
function liveRegistry(): SourceRegistry {
	const ids = new Set<string>();
	return {
		async register(): Promise<string> {
			return "live-src";
		},
		async get() {
			return { kind: "document" } as never;
		},
		async remove(id): Promise<void> {
			ids.delete(id);
		},
		async list(): Promise<readonly string[]> {
			return [...ids];
		},
	};
}

function prov(sourceId: string, path: string, org: string, workspace: string): Provenance {
	return { sourceId, sourceKind: "document", sourcePath: path, sourceRoot: `/root/${sourceId}`, org, workspace };
}
function artifact(sourceId: string, path: string, org: string, ws: string): SourceArtifact {
	const p = prov(sourceId, path, org, ws);
	return { provenance: p, kind: "note", title: path, content: `body ${path}`, chunks: [{ provenance: p, content: `body ${path}`, ordinal: 0 }] };
}

/**
 * Read a by-id highest-version `status` POLL-CONVERGENTLY through the ONE shared
 * `readConverged` seam (PRD-028 D-4 — no bespoke poll loop; PRD-034a immediacy
 * relaxation). The purge writes an append-only status ADVANCE (a new highest-version
 * row whose `status` is `deleted`); on this stale-flapping backend a single read can
 * land on a segment that still serves the prior `active` version. `status` advances
 * are monotone within a logical lifecycle, so polling for the EXPECTED target status
 * converges UP to the durable current state without ever over-reporting.
 *
 * The predicate converges once the top-by-version row carries `expectStatus` — the
 * soft-delete (or the untouched-active) advance the test asserts. The budget only
 * governs HOW LONG we wait; on exhaustion `readConverged` returns the last real read,
 * so a genuine WRONG status (e.g. B drifted to deleted) surfaces and the assertion RES
 * — the bar is never weakened. Returns the converged highest-version status, or null.
 */
async function currentStatus(
	store: StorageClient,
	table: string,
	id: string,
	scope: QueryScope,
	expectStatus: string,
): Promise<string | null> {
	const sql = `SELECT status, version FROM "${sqlIdent(table)}" WHERE id = ${sLiteral(id)} ORDER BY version DESC LIMIT 1`;
	// Converged when the top-by-version row's status is the expected target. A non-ok
	// read is never fresh (the budget governs, fail-soft); a stale `active` segment is
	// simply "not fresh yet" so the poll waits past it to the durable `deleted` advance.
	const reachedExpected = (res: QueryResult): boolean =>
		isOk(res) && res.rows.length > 0 && String(res.rows[0].status ?? "") === expectStatus;
	const res = await readConverged(store, sql, scope, reachedExpected, { budget: STATUS_BUDGET });
	if (isOk(res) && res.rows.length > 0) return String(res.rows[0].status ?? "");
	return null;
}

describe.skipIf(!HAS_TOKEN)("live sources purge smoke (opt-in, real backend, append-only status advance)", () => {
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

	it("purge(A) soft-deletes A's rows (status advance) while B's rows remain active", async ({ skip }) => {
		// INFRA-DEGRADED preflight (PRD-034a FR-4 / a-AC-3): a trivial liveness probe routed
		// through the shared infra-skip seam. If the backend is sustained-down (the probe
		// flaps transient AFTER the client's own retry), the run resolves NEUTRAL via a SKIP
		// + the run-level sentinel — never a hard red on our code, never a false green of the
		// purge correctness assertions. A non-transient failure (real defect) or an ok probe
		// continues to the strict correctness assertions below with full teeth.
		await neutralizeIfInfraDegraded("sources-purge-live:preflight", () => storage.connect(scope), skip);

		// Route the canonical table names to per-run throwaway tables NATIVELY via the
		// lifecycle's `resolveTable` seam — so the heal CREATEs the physical throwaway
		// table directly (the proven recall-authz/graph-persist isolation technique).
		// A SQL-string proxy was tried first and FAILED: rewriting table names inside
		// the heal's CREATE/introspect/ALTER races the fresh-table propagation and
		// corrupts it ("column id already exists"), so writes silently never landed.
		const CI_TABLES: Record<string, string> = {
			[MEMORY_ARTIFACTS_TABLE]: TBL_ARTIFACTS,
			[DOCUMENT_CHUNK_TABLE]: TBL_CHUNKS,
			[DOCUMENT_MEMORIES_TABLE]: TBL_LINKS,
		};
		const resolveTable = (canonical: string): string => CI_TABLES[canonical] ?? canonical;

		const lifecycle = createSourceLifecycle({ storage, scope, queue: liveQueue(), registry: liveRegistry(), resolveTable });
		const provA = createFakeSourceProvider([artifact("sA", "a1.md", scope.org, scope.workspace ?? "default"), artifact("sA", "a2.md", scope.org, scope.workspace ?? "default")]);
		const provB = createFakeSourceProvider([artifact("sB", "b1.md", scope.org, scope.workspace ?? "default")]);

		// Index both sources into the SAME (throwaway) tables.
		await lifecycle.index(provA, "sA");
		await lifecycle.index(provB, "sB");

		// Purge source A → append-only soft-delete (status advance) over A's rows.
		const outcome = await lifecycle.purge(provA, "sA");
		expect(outcome.artifactsPurged).toBeGreaterThanOrEqual(2);
		expect(provA.closed()).toBe(true);

		// Read-back (poll-convergent via readConverged): A's artifact rows converge to
		// `deleted` (the soft-delete advance); B's converge to `active` (untouched). The
		// EXPECTED-status predicate waits past a stale prior segment; the correctness bar
		// — A deleted, B still active — is asserted strictly on the converged read.
		const aStatus1 = await currentStatus(storage, TBL_ARTIFACTS, artifactId("sA", "a1.md"), scope, ARTIFACT_DELETED);
		const aStatus2 = await currentStatus(storage, TBL_ARTIFACTS, artifactId("sA", "a2.md"), scope, ARTIFACT_DELETED);
		const bStatus = await currentStatus(storage, TBL_ARTIFACTS, artifactId("sB", "b1.md"), scope, ARTIFACT_ACTIVE);

		expect(aStatus1, "source A a1 soft-deleted").toBe(ARTIFACT_DELETED);
		expect(aStatus2, "source A a2 soft-deleted").toBe(ARTIFACT_DELETED);
		expect(bStatus, "source B remains active (another source untouched)").toBe(ARTIFACT_ACTIVE);
	}, GENEROUS_TEST_CEILING_MS);
});
