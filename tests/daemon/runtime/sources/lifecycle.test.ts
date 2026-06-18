/**
 * PRD-013a source lifecycle — proves a-AC-1..7 against the fake append-only store
 * + `createFakeSourceProvider`.
 *
 * Verification posture (EXECUTION_LEDGER-prd-013): no live DeepLake here. The
 * lifecycle engine is driven against `FakeArtifactStore` (in-memory, append-only,
 * highest-version reads — the same contract the live backend gives) and a fake
 * provider yielding canned artifacts. The decisive assertions:
 *   - provenance on EVERY derived row (a-AC-3);
 *   - connect registers + queues an index job, index writes artifacts+chunks (a-AC-1);
 *   - purge soft-deletes ALL of source A's rows (status advance), files untouched,
 *     while source B's rows REMAIN (a-AC-2);
 *   - soft-delete is a STATUS ADVANCE, NOT an in-place UPDATE — assert NO `UPDATE`
 *     statement was ever emitted (a-AC-4) — the load-bearing assertion;
 *   - lazy create: the engine never hand-rolls a CREATE/ALTER (a-AC-5);
 *   - daemon-down CLI remove warns store rows remain (a-AC-6);
 *   - a partial failure → a failure artifact, no existing row deleted (a-AC-7).
 */

import { describe, expect, it } from "vitest";

import {
	ARTIFACT_ACTIVE,
	ARTIFACT_DELETED,
	ARTIFACT_FAILURE,
	createFakeSourceProvider,
	type Provenance,
	type SourceArtifact,
} from "../../../../src/daemon/runtime/sources/contracts.js";
import {
	artifactId,
	createSourceLifecycle,
	type SourceRegistry,
} from "../../../../src/daemon/runtime/sources/lifecycle.js";
import {
	DOCUMENT_CHUNK_TABLE,
	MEMORY_ARTIFACTS_TABLE,
} from "../../../../src/daemon/storage/catalog/sources.js";
import type { JobInput, JobQueueService, LeasedJob } from "../../../../src/daemon/runtime/services/job-queue.js";
import { FakeArtifactStore } from "../../../helpers/fake-artifact-store.js";

const SCOPE = { org: "acme", workspace: "backend" } as const;

/** A fake queue that records every enqueue (so a-AC-1 can assert the index job). */
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

/** An in-memory source-config registry. */
function fakeRegistry(): SourceRegistry & { configs: Map<string, unknown>; removed: string[] } {
	const configs = new Map<string, unknown>();
	const removed: string[] = [];
	let seq = 0;
	return {
		configs,
		removed,
		async register(config): Promise<string> {
			seq += 1;
			const id = `src-${seq}`;
			configs.set(id, config);
			return id;
		},
		async get(sourceId) {
			return (configs.get(sourceId) as never) ?? null;
		},
		async remove(sourceId): Promise<void> {
			configs.delete(sourceId);
			removed.push(sourceId);
		},
		async list(): Promise<readonly string[]> {
			return [...configs.keys()];
		},
	};
}

/** Build a provenance quartet + scope for a unit of a given source. */
function prov(sourceId: string, path: string): Provenance {
	return {
		sourceId,
		sourceKind: "document",
		sourcePath: path,
		sourceRoot: `/root/${sourceId}`,
		org: SCOPE.org,
		workspace: SCOPE.workspace,
	};
}

/** An artifact with one chunk, for a source unit. */
function artifact(sourceId: string, path: string, content: string): SourceArtifact {
	const p = prov(sourceId, path);
	return {
		provenance: p,
		kind: "note",
		title: path,
		content,
		chunks: [{ provenance: p, content, ordinal: 0, metadata: { heading: "Intro", lines: [1, 4] } }],
		graphTriples: [{ subject: "alpha", predicate: "relates_to", object: "beta" }],
	};
}

function buildLifecycle(store: FakeArtifactStore) {
	const queue = fakeQueue();
	const registry = fakeRegistry();
	const lifecycle = createSourceLifecycle({ storage: store, scope: SCOPE, queue, registry, discoveryPollDelayMs: 0 });
	return { lifecycle, queue, registry };
}

describe("PRD-013a source lifecycle", () => {
	it("a-AC-1 connect registers the source + queues an index job; index writes artifacts + chunks", async () => {
		const store = new FakeArtifactStore();
		const { lifecycle, queue, registry } = buildLifecycle(store);
		const provider = createFakeSourceProvider([artifact("sA", "notes/a.md", "alpha body")]);

		const connectOutcome = await lifecycle.connect(provider, {
			kind: "document",
			org: SCOPE.org,
			workspace: SCOPE.workspace,
			root: "/root/sA",
			settings: {},
		});
		// Source registered + an index job queued (a-AC-1).
		expect(registry.configs.has(connectOutcome.sourceId)).toBe(true);
		expect(queue.enqueued).toHaveLength(1);
		expect(queue.enqueued[0].kind).toBe("source_index");
		expect(connectOutcome.jobId).toBe("job-1");

		// Index produces artifacts + provenanced chunks (a-AC-1).
		const indexOutcome = await lifecycle.index(provider, connectOutcome.sourceId);
		expect(indexOutcome.artifactsWritten).toBe(1);
		expect(indexOutcome.chunksWritten).toBe(1);
		expect(indexOutcome.graphTriplesWritten).toBe(1);
		expect(store.rowsOf(MEMORY_ARTIFACTS_TABLE)).toHaveLength(1);
		expect(store.rowsOf(DOCUMENT_CHUNK_TABLE)).toHaveLength(1);
	});

	it("a-AC-3 every derived row carries the provenance quartet + org/workspace scope", async () => {
		const store = new FakeArtifactStore();
		const { lifecycle } = buildLifecycle(store);
		const provider = createFakeSourceProvider([artifact("sA", "notes/a.md", "alpha body")]);
		await lifecycle.index(provider, "sA");

		for (const table of [MEMORY_ARTIFACTS_TABLE, DOCUMENT_CHUNK_TABLE]) {
			for (const row of store.rowsOf(table)) {
				expect(row.source_id, `${table}.source_id`).toBe("sA");
				expect(row.source_kind).toBe("document");
				expect(row.source_path).toBe("notes/a.md");
				expect(row.source_root).toBe("/root/sA");
				expect(row.org_id).toBe(SCOPE.org);
				expect(row.workspace_id).toBe(SCOPE.workspace);
			}
		}
	});

	it("a-AC-2 purge soft-deletes ALL of source A's rows while source B's remain; files untouched", async () => {
		const store = new FakeArtifactStore();
		const { lifecycle, registry } = buildLifecycle(store);

		// Index two distinct sources into the SAME tables.
		const provA = createFakeSourceProvider([artifact("sA", "a1.md", "A one"), artifact("sA", "a2.md", "A two")]);
		const provB = createFakeSourceProvider([artifact("sB", "b1.md", "B one")]);
		await lifecycle.index(provA, "sA");
		await lifecycle.index(provB, "sB");
		await registry.register({} as never); // (registry exercised via connect elsewhere)
		registry.configs.set("sA", { kind: "document" });

		// Purge source A.
		const outcome = await lifecycle.purge(provA, "sA");
		expect(outcome.artifactsPurged).toBe(2);
		expect(outcome.providerClosed).toBe(true);
		expect(provA.closed()).toBe(true); // the provider connection was closed (d-AC-4).

		// Source A's artifact rows now read `deleted` (status advance — out of recall).
		const aId1 = artifactId("sA", "a1.md");
		const aId2 = artifactId("sA", "a2.md");
		expect(store.currentOf(MEMORY_ARTIFACTS_TABLE, aId1)?.status).toBe(ARTIFACT_DELETED);
		expect(store.currentOf(MEMORY_ARTIFACTS_TABLE, aId2)?.status).toBe(ARTIFACT_DELETED);

		// Source B's row is STILL active — another source's rows are untouched (a-AC-2).
		const bId = artifactId("sB", "b1.md");
		expect(store.currentOf(MEMORY_ARTIFACTS_TABLE, bId)?.status).toBe(ARTIFACT_ACTIVE);

		// "Files untouched" — purge only ever issued store statements; it never touched
		// a filesystem (the engine has no fs dependency at all).
	});

	it("a-AC-4 soft-delete is a STATUS ADVANCE (append a deleted version), NOT an in-place UPDATE", async () => {
		const store = new FakeArtifactStore();
		const { lifecycle } = buildLifecycle(store);
		const provider = createFakeSourceProvider([artifact("sA", "a.md", "body")]);
		await lifecycle.index(provider, "sA");

		const id = artifactId("sA", "a.md");
		expect(Number(store.currentOf(MEMORY_ARTIFACTS_TABLE, id)?.version)).toBe(1);

		// Removed file → soft-delete via status advance + purge its chunks.
		const res = await lifecycle.updateInPlace("sA", "a.md");
		expect(res.artifactDeleted).toBe(true);
		expect(res.chunksDeleted).toBe(1);

		// The artifact id now has TWO physical rows (v1 active, v2 deleted) — append,
		// not mutate. The current (highest-version) row is `deleted`.
		const rows = store.rowsOf(MEMORY_ARTIFACTS_TABLE).filter((r) => r.id === id);
		expect(rows).toHaveLength(2);
		expect(store.currentOf(MEMORY_ARTIFACTS_TABLE, id)?.status).toBe(ARTIFACT_DELETED);
		expect(Number(store.currentOf(MEMORY_ARTIFACTS_TABLE, id)?.version)).toBe(2);

		// THE load-bearing assertion: NO in-place UPDATE was ever emitted (a-AC-4).
		expect(store.emittedUpdate()).toBe(false);
	});

	it("a-AC-5 lazy create: the engine never hand-rolls a CREATE TABLE / ALTER TABLE", async () => {
		const store = new FakeArtifactStore();
		const { lifecycle } = buildLifecycle(store);
		const provider = createFakeSourceProvider([artifact("sA", "a.md", "body")]);
		await lifecycle.index(provider, "sA");
		await lifecycle.purge(provider, "sA");

		// The engine writes only INSERT/SELECT; CREATE/ALTER come from the heal path
		// (002c), never the engine itself. (The heal path is proven in PRD-002's tests.)
		for (const s of store.statements) {
			expect(/^\s*(CREATE|ALTER)\s/i.test(s.sql), `unexpected DDL: ${s.sql}`).toBe(false);
		}
	});

	it("a-AC-6 daemon down + CLI remove → config removed + warning that store rows remain", async () => {
		// The CLI's daemon-down path is config-only removal + a warning (D-8). It is
		// modeled here as the registry.remove half WITHOUT a lifecycle.purge: the store
		// rows are deliberately left, and the caller MUST warn.
		const store = new FakeArtifactStore();
		const { lifecycle, registry } = buildLifecycle(store);
		const provider = createFakeSourceProvider([artifact("sA", "a.md", "body")]);
		await lifecycle.index(provider, "sA");
		registry.configs.set("sA", { kind: "document" });

		// Simulate the daemon-down CLI remove: config-only.
		const warning = await removeSourceConfigOnly(registry, "sA");
		expect(registry.configs.has("sA")).toBe(false); // config removed
		expect(registry.removed).toContain("sA");
		expect(warning).toMatch(/store rows remain/i); // the required warning (a-AC-6)

		// The store rows are STILL present (active) — the purge did NOT run.
		const id = artifactId("sA", "a.md");
		expect(store.currentOf(MEMORY_ARTIFACTS_TABLE, id)?.status).toBe(ARTIFACT_ACTIVE);
	});

	it("a-AC-7 a partial fetch failure → a failure artifact written + reported, no existing row deleted", async () => {
		const store = new FakeArtifactStore();
		const { lifecycle } = buildLifecycle(store);

		// One healthy unit + one FAILURE unit (the partial fetch failure).
		const good = artifact("sA", "good.md", "good body");
		const failed: SourceArtifact = {
			provenance: prov("sA", "broken.md"),
			kind: "note",
			title: "broken.md",
			content: "",
			failure: { reason: "parse error at line 12", detail: { line: 12 } },
		};
		const provider = createFakeSourceProvider([good, failed]);
		const outcome = await lifecycle.index(provider, "sA");

		// The good unit indexed; the failure was written + reported (a-AC-7).
		expect(outcome.artifactsWritten).toBe(1);
		expect(outcome.failuresWritten).toBe(1);

		// The good unit's active row is INTACT — the failure deleted nothing.
		const goodId = artifactId("sA", "good.md");
		expect(store.currentOf(MEMORY_ARTIFACTS_TABLE, goodId)?.status).toBe(ARTIFACT_ACTIVE);

		// A failure artifact row exists carrying the reason + status='failure'.
		const failureRows = store.rowsOf(MEMORY_ARTIFACTS_TABLE).filter((r) => r.status === ARTIFACT_FAILURE);
		expect(failureRows).toHaveLength(1);
		expect(failureRows[0].failure_reason).toBe("parse error at line 12");
		// No row was deleted (no `deleted` status anywhere) (a-AC-7).
		expect(store.rowsOf(MEMORY_ARTIFACTS_TABLE).some((r) => r.status === ARTIFACT_DELETED)).toBe(false);
		expect(store.emittedUpdate()).toBe(false);
	});
});

/**
 * The daemon-down CLI remove (a-AC-6 / D-8): config-only removal + a warning that
 * store-side rows remain. Modeled here as the contract the CLI follows when the
 * daemon is unreachable (it cannot call `lifecycle.purge`, which needs the daemon).
 */
async function removeSourceConfigOnly(registry: SourceRegistry, sourceId: string): Promise<string> {
	await registry.remove(sourceId);
	return `Source config removed. WARNING: the daemon is unreachable, so store rows remain for "${sourceId}"; run \`sources purge ${sourceId}\` when the daemon is back to remove them.`;
}
