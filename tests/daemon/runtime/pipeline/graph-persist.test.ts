/**
 * PRD-006d Graph Persistence — d-AC-1..d-AC-5 (Wave 2).
 *
 * Verification posture (EXECUTION_LEDGER-prd-006 / pipeline CONVENTIONS §5):
 *   - All assertions run against a FAKE DeepLake transport
 *     (`FakeDeepLakeTransport`) wrapped in a real `StorageClient`. No live
 *     network. No `.skip` / `.only`; `vitest run` is CI.
 *   - Each `describe` block is named after the AC it proves (one-to-one map).
 *   - Tests call `persistGraphEntities` (the pure core) or the handler factory
 *     directly, mirroring the extraction-stage test split.
 *   - The fake transport's `requests` array captures every SQL statement issued,
 *     letting us assert the exact write path without a live backend.
 *
 * d-AC-1 Committed memory → entities upsert by canonical name; relationships by
 *         (source, target, type); mentions insert-or-ignore.
 * d-AC-2 Same memory reprocessed → NO duplicate rows (idempotent).
 * d-AC-3 Graph persistence fails → warning logged, handler resolves, no throw.
 * d-AC-4 `graph.enabled` OR `graph.extractionWritesEnabled` off → no writes.
 * d-AC-5 Every graph write carries org/workspace/agent scope.
 */

import { describe, expect, it } from "vitest";

import {
	createStorageClient,
	type StorageQuery,
	type QueryScope,
} from "../../../../src/daemon/storage/index.js";
import { PipelineConfigSchema, type PipelineConfig } from "../../../../src/daemon/runtime/pipeline/config.js";
import type { EntityTriple } from "../../../../src/daemon/runtime/pipeline/contracts.js";
import type { StageJob } from "../../../../src/daemon/runtime/pipeline/stage-worker.js";
import {
	createGraphPersistHandler,
	type GraphPersistHandlerDeps,
	type GraphPersistLogger,
	type InlineLinker,
	noopGraphPersistHandler,
	persistGraphEntities,
} from "../../../../src/daemon/runtime/pipeline/graph-persist.js";
import { controlledWriteFanOut } from "../../../../src/daemon/runtime/pipeline/fan-out.js";
import type { JobInput, JobQueueService, LeasedJob } from "../../../../src/daemon/runtime/services/job-queue.js";
import {
	FakeDeepLakeTransport,
	fakeCredentialRecord,
	stubProvider,
} from "../../../helpers/fake-deeplake.js";

// ── Config fixture ─────────────────────────────────────────────────────────────

function enabledGraphConfig(overrides: Record<string, unknown> = {}): PipelineConfig {
	return PipelineConfigSchema.parse({
		enabled: true,
		extractionProvider: "fake",
		graph: { enabled: true, extractionWritesEnabled: true },
		...overrides,
	});
}

// ── Scope fixture ─────────────────────────────────────────────────────────────

const TEST_SCOPE: QueryScope = { org: "test-org", workspace: "test-ws" };

// ── Logger spy ────────────────────────────────────────────────────────────────

function makeLogSpy(): { logger: GraphPersistLogger; warns: string[]; infos: string[] } {
	const warns: string[] = [];
	const infos: string[] = [];
	const logger: GraphPersistLogger = {
		warn(name) { warns.push(name); },
		info(name) { infos.push(name); },
	};
	return { logger, warns, infos };
}

// ── SQL-aware fake responder helpers ─────────────────────────────────────────
//
// The graph stage issues probe SELECTs (to test for entity / dependency /
// mention presence) then INSERT or UPDATE. We build a responder that:
//   - answers information_schema SELECTs (for heal) with the expected columns
//   - answers probe SELECTs with no rows (not yet present)
//   - answers all mutations with empty rows (success)
//
// For idempotency tests we also need a responder that returns a hit on the
// probe SELECT, proving the second pass inserts nothing.

import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import type { StorageRow } from "../../../../src/daemon/storage/result.js";

/** Returns empty rows for every call — the "all new" scenario. */
function allNewResponder(): (req: TransportRequest) => StorageRow[] {
	return (_req) => [];
}

/**
 * A no-op inline linker (PRD-045c) — used by tests that ISOLATE graph-persist's OWN
 * entity/dependency/mention write-path shape from the linker's separate by-name entity
 * resolution. The linker's live invocation + idempotency are proven in their own block
 * (`PRD-045c inline linker invocation`) and in `ontology/entity-model.test.ts`.
 */
const noopLinker: InlineLinker = async () => ({ mentions: [], candidateCount: 0 });

/** Returns a hit row for any SELECT probe, empty rows for everything else. */
function alreadyPresentResponder(): (req: TransportRequest) => StorageRow[] {
	return (req) => {
		const sql = req.sql.toUpperCase();
		if (sql.startsWith("SELECT")) {
			// Return a row so the probe sees the record as present.
			return [{ id: "existing-id" }];
		}
		return [];
	};
}

// ── Build a storage client from a responder ───────────────────────────────────

function buildStorage(responder: (req: TransportRequest) => StorageRow[]): {
	storage: StorageQuery;
	transport: FakeDeepLakeTransport;
} {
	const transport = new FakeDeepLakeTransport(responder);
	const storage = createStorageClient({
		provider: stubProvider(fakeCredentialRecord()),
		transport,
	});
	return { storage, transport };
}

// ── Sample triples ─────────────────────────────────────────────────────────────

const TRIPLE_A: EntityTriple = { source: "Daemon", relationship: "binds", target: "Port 3850" };
const TRIPLE_B: EntityTriple = { source: "Hivemind", relationship: "owns", target: "Daemon" };

// ── Stage job fixture ─────────────────────────────────────────────────────────

function makeJob(memoryId: string, entities: EntityTriple[]): StageJob {
	return {
		id: "job-001",
		kind: "memory_graph_persist",
		attempt: 1,
		scope: { org: "test-org", workspace: "test-ws", agentId: "test-agent" },
		payload: { memoryId, entities },
	};
}

// ═════════════════════════════════════════════════════════════════════════════
// d-AC-1: entities upsert by canonical name; relationships by (source,target,type);
//          mentions insert-or-ignore
// ═════════════════════════════════════════════════════════════════════════════

describe("d-AC-1 entities upsert by canonical name; relationships; mentions insert-or-ignore", () => {
	it("issues entity dedup-probe + version-bumped INSERT, dependency probe + INSERT, mention probe + INSERT for one triple", async () => {
		const { storage, transport } = buildStorage(allNewResponder());
		const { logger, warns } = makeLogSpy();

		await persistGraphEntities(
			storage,
			TEST_SCOPE,
			enabledGraphConfig(),
			"mem-001",
			[TRIPLE_A],
			logger,
		);

		expect(warns).toHaveLength(0);
		const sqls = transport.requests.map((r) => r.sql.toUpperCase());

		// Entity upserts (live-deterministic pattern): each entity triggers a
		// poll-convergent by-id dedup probe (`SELECT id FROM entities WHERE id=…`) +,
		// when absent, an append-only version-bumped INSERT (which itself reads
		// MAX(version) first). So there are SELECTs and at least one INSERT per entity.
		const selectEntityCount = sqls.filter((s) => s.includes("SELECT") && s.includes("ENTITIES")).length;
		expect(selectEntityCount, "entity dedup-probe SELECTs (source + target)").toBeGreaterThanOrEqual(2);
		const entityInserts = sqls.filter((s) => s.startsWith("INSERT") && s.includes("ENTITIES")).length;
		expect(entityInserts, "entity version-bumped INSERTs (source + target)").toBeGreaterThanOrEqual(2);

		// The entity write is APPEND-ONLY version-bumped now, never an in-place UPDATE
		// (an UPDATE coalesces/drops live). Prove no UPDATE is emitted, and that the
		// INSERT carries the `version` column.
		const entityUpdates = sqls.filter((s) => s.startsWith("UPDATE") && s.includes("ENTITIES")).length;
		expect(entityUpdates, "no in-place UPDATE on entities").toBe(0);
		expect(
			sqls.some((s) => s.startsWith("INSERT") && s.includes("ENTITIES") && s.includes("VERSION")),
			"entity INSERT carries the version column",
		).toBe(true);

		// Dependency probe SELECT + INSERT.
		const depSelects = sqls.filter((s) => s.includes("SELECT") && s.includes("ENTITY_DEPENDENCIES")).length;
		expect(depSelects, "dependency probe SELECT").toBeGreaterThanOrEqual(1);
		const depInserts = sqls.filter((s) => s.includes("INSERT") && s.includes("ENTITY_DEPENDENCIES")).length;
		expect(depInserts, "dependency INSERT").toBeGreaterThanOrEqual(1);

		// Mention probe SELECT + INSERT (one per entity = 2 for one triple).
		const mentionInserts = sqls.filter((s) => s.includes("INSERT") && s.includes("MEMORY_ENTITY_MENTIONS")).length;
		expect(mentionInserts, "mention INSERTs for source and target").toBeGreaterThanOrEqual(2);
	});

	it("entity / dependency / mention dedup probes are by deterministic id (poll-convergent), not by name", async () => {
		// The live-determinism fix keys every dedup probe on the deterministic id so a
		// stale-segment read can be re-polled to convergence. Prove the probe shape: a
		// `WHERE id = …` SELECT against each table (NOT a `WHERE name = …` probe, which
		// the old updateOrInsertByKey used and which a stale scan defeated live).
		const { storage, transport } = buildStorage(allNewResponder());
		const { logger } = makeLogSpy();

		// Inject the no-op linker so this assertion isolates graph-persist's OWN dedup-probe
		// shape; the inline linker's by-name entity RESOLUTION (a separate, read-only concern)
		// is proven in the `PRD-045c inline linker invocation` block + the entity-model suite.
		await persistGraphEntities(storage, TEST_SCOPE, enabledGraphConfig(), "mem-probe", [TRIPLE_A], logger, "", noopLinker);

		const sqls = transport.requests.map((r) => r.sql.toUpperCase());
		expect(
			sqls.some((s) => s.startsWith("SELECT") && s.includes("ENTITIES") && /WHERE\s+ID\s*=/.test(s)),
			"entity dedup probe is by id",
		).toBe(true);
		expect(
			sqls.some((s) => s.startsWith("SELECT") && s.includes("ENTITY_DEPENDENCIES") && /WHERE\s+ID\s*=/.test(s)),
			"dependency dedup probe is by id",
		).toBe(true);
		expect(
			sqls.some((s) => s.startsWith("SELECT") && s.includes("MEMORY_ENTITY_MENTIONS") && /WHERE\s+ID\s*=/.test(s)),
			"mention dedup probe is by id",
		).toBe(true);
		// The old by-name entity probe must be gone (it is the live idempotency break).
		expect(
			sqls.some((s) => s.startsWith("SELECT") && s.includes("ENTITIES") && /WHERE\s+NAME\s*=/.test(s)),
			"no by-name entity probe (the stale-read duplicate-insert trap)",
		).toBe(false);
	});

	it("canonical name normalises the source/target to lowercase + trimmed form in the upsert key", async () => {
		const { storage, transport } = buildStorage(allNewResponder());
		const { logger } = makeLogSpy();

		const mixedCase: EntityTriple = { source: "  The Daemon  ", relationship: "runs", target: "  PORT 3850  " };

		await persistGraphEntities(storage, TEST_SCOPE, enabledGraphConfig(), "mem-002", [mixedCase], logger);

		// The entity INSERT writes `name = '<canonical>'` — the lowercased, trimmed
		// form, never the raw mixed-case. (The dedup probe + MAX(version) read key on
		// the deterministic `id`, so the canonical name surfaces in the INSERT body.)
		const entitySqls = transport.requests
			.filter((r) => r.sql.toUpperCase().includes("ENTITIES"))
			.map((r) => r.sql);
		expect(entitySqls.some((s) => s.includes("the daemon")), "canonical 'the daemon'").toBe(true);
		expect(entitySqls.some((s) => s.includes("port 3850")), "canonical 'port 3850'").toBe(true);
		// The raw mixed-case should NOT appear in entity queries.
		expect(entitySqls.some((s) => s.includes("The Daemon")), "raw form absent").toBe(false);
	});

	it("all rows carry scope (org/workspace are on every request)", async () => {
		const { storage, transport } = buildStorage(allNewResponder());
		const { logger } = makeLogSpy();

		await persistGraphEntities(storage, TEST_SCOPE, enabledGraphConfig(), "mem-003", [TRIPLE_A], logger);

		// Every single request reaches the transport with the test scope.
		for (const req of transport.requests) {
			expect(req.org, `request org`).toBe("test-org");
			expect(req.workspace, `request workspace`).toBe("test-ws");
		}
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// d-AC-2: same memory reprocessed → no duplicate rows
// ═════════════════════════════════════════════════════════════════════════════

describe("d-AC-2 same memory reprocessed → no duplicate entities/relationships/mentions", () => {
	it("second pass of the same triple emits no INSERT when the probe SELECT returns a hit", async () => {
		const { storage, transport } = buildStorage(alreadyPresentResponder());
		const { logger, warns } = makeLogSpy();

		await persistGraphEntities(
			storage,
			TEST_SCOPE,
			enabledGraphConfig(),
			"mem-001",
			[TRIPLE_A],
			logger,
		);

		expect(warns).toHaveLength(0);
		const sqls = transport.requests.map((r) => r.sql.toUpperCase());

		// Every mutation should be absent — the poll-convergent dedup probes all return
		// a hit, so no row is appended on ANY table. With the deterministic-id append-
		// only design there is NO UPDATE path either: a present entity is a clean no-op,
		// not an in-place UPDATE (which would coalesce/drop live). So the second pass
		// emits zero INSERTs and zero UPDATEs across all three tables.
		const inserts = sqls.filter((s) => s.startsWith("INSERT")).length;
		const updates = sqls.filter((s) => s.startsWith("UPDATE")).length;
		expect(inserts, "no INSERT on a fully-deduped second pass").toBe(0);
		expect(updates, "no in-place UPDATE on a fully-deduped second pass").toBe(0);
	});

	it("deterministic entity id: same source name + same agent produces same entity id across two calls", async () => {
		// Two separate calls with the same triple; we capture the SQL and
		// extract the entity id from the first SELECT to prove it is the same id
		// both times (deterministic → no collision).
		const capturedIds: string[] = [];

		// Responder that extracts the probed id from SELECT ... WHERE id = '<id>' LIMIT 1
		const idCapturingResponder = (req: TransportRequest): StorageRow[] => {
			const m = /WHERE\s+\w+\s*=\s*'([^']+)'\s+LIMIT/i.exec(req.sql);
			if (m) capturedIds.push(m[1]);
			return []; // not present, so INSERT proceeds
		};

		const { storage: s1 } = buildStorage(idCapturingResponder);
		const { logger: l1 } = makeLogSpy();
		await persistGraphEntities(s1, TEST_SCOPE, enabledGraphConfig(), "mem-X", [TRIPLE_A], l1);

		const firstRunIds = [...capturedIds];
		capturedIds.length = 0;

		const { storage: s2 } = buildStorage(idCapturingResponder);
		const { logger: l2 } = makeLogSpy();
		await persistGraphEntities(s2, TEST_SCOPE, enabledGraphConfig(), "mem-X", [TRIPLE_A], l2);

		const secondRunIds = [...capturedIds];

		// Both runs should have produced the exact same probe ids.
		expect(firstRunIds.sort()).toEqual(secondRunIds.sort());
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// d-AC-3: graph persistence fails → warning logged, handler resolves, no throw
// ═════════════════════════════════════════════════════════════════════════════

/**
 * A StorageQuery that throws a plain Error on every `query()` call, bypassing
 * the StorageClient's result-union classifier. This triggers the handler's
 * catch block directly — the only path that would NOT be caught is if the
 * storage layer returns a typed `query_error` result (which the handler does
 * not re-throw). Using a raw throw here exercises the d-AC-3 contract:
 * unexpected errors (e.g. logic bugs, bad HealTarget) are caught by the handler.
 */
function throwingStorageQuery(): StorageQuery {
	return {
		async query(_sql, _scope) {
			throw new Error("injected storage failure for d-AC-3");
		},
	};
}

describe("d-AC-3 graph persistence fails → warning logged, handler resolves normally (non-fatal)", () => {
	it("handler catches an unexpected storage error and returns normally (does not throw)", async () => {
		const storage = throwingStorageQuery();
		const { logger, warns } = makeLogSpy();

		const deps: GraphPersistHandlerDeps = {
			storage,
			scope: TEST_SCOPE,
			config: enabledGraphConfig(),
			logger,
		};
		const handler = createGraphPersistHandler(deps);
		const job = makeJob("mem-err", [TRIPLE_A]);

		// Must NOT throw — the handler must resolve even when storage throws.
		await expect(handler(job)).resolves.toBeUndefined();

		// Must log a warning identifying the failure.
		expect(warns, "warning logged on failure").toContain("graph_persist.storage_error");
	});

	it("already-committed facts are not reverted: the handler resolves even when every query throws", async () => {
		// Inject a storage that throws on every call.
		const storage = throwingStorageQuery();
		const { logger, warns } = makeLogSpy();

		const deps: GraphPersistHandlerDeps = { storage, scope: TEST_SCOPE, config: enabledGraphConfig(), logger };
		const handler = createGraphPersistHandler(deps);

		// Should resolve (not throw) even when every query throws.
		await expect(handler(makeJob("mem-fatal", [TRIPLE_B]))).resolves.toBeUndefined();
		expect(warns).toContain("graph_persist.storage_error");
	});

	it("noopGraphPersistHandler resolves without touching storage", async () => {
		// The noop (Wave 1 default) should simply resolve with no side effects.
		const job = makeJob("mem-noop", [TRIPLE_A]);
		await expect(noopGraphPersistHandler(job)).resolves.toBeUndefined();
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// d-AC-4: graph.enabled or graph.extractionWritesEnabled off → no writes
// ═════════════════════════════════════════════════════════════════════════════

describe("d-AC-4 graph.enabled or graph.extractionWritesEnabled off → no graph rows written", () => {
	it("graph.enabled=false → no requests issued", async () => {
		const { storage, transport } = buildStorage(allNewResponder());
		const { logger, warns } = makeLogSpy();

		const config = enabledGraphConfig({ graph: { enabled: false, extractionWritesEnabled: true } });

		await persistGraphEntities(storage, TEST_SCOPE, config, "mem-gate", [TRIPLE_A], logger);

		expect(transport.requests, "no storage calls when graph.enabled=false").toHaveLength(0);
		expect(warns).toHaveLength(0);
	});

	it("graph.extractionWritesEnabled=false → no requests issued", async () => {
		const { storage, transport } = buildStorage(allNewResponder());
		const { logger } = makeLogSpy();

		const config = enabledGraphConfig({ graph: { enabled: true, extractionWritesEnabled: false } });

		await persistGraphEntities(storage, TEST_SCOPE, config, "mem-gate2", [TRIPLE_A], logger);

		expect(transport.requests, "no storage calls when extractionWritesEnabled=false").toHaveLength(0);
	});

	it("both flags off → no requests issued", async () => {
		const { storage, transport } = buildStorage(allNewResponder());
		const { logger } = makeLogSpy();

		const config = enabledGraphConfig({ graph: { enabled: false, extractionWritesEnabled: false } });

		await persistGraphEntities(storage, TEST_SCOPE, config, "mem-gate3", [TRIPLE_B], logger);

		expect(transport.requests).toHaveLength(0);
	});

	it("handler created with no deps → returns noopGraphPersistHandler (resolves, no writes)", async () => {
		const handler = createGraphPersistHandler(undefined);
		expect(handler).toBe(noopGraphPersistHandler);
		await expect(handler(makeJob("mem-noop2", [TRIPLE_A]))).resolves.toBeUndefined();
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// d-AC-5: every graph write carries org/workspace/agent scope
// ═════════════════════════════════════════════════════════════════════════════

describe("d-AC-5 every graph write carries org/workspace/agent scope", () => {
	it("every request to the transport carries the injected org and workspace", async () => {
		const customScope: QueryScope = { org: "my-org-123", workspace: "my-ws-456" };
		const { storage, transport } = buildStorage(allNewResponder());
		const { logger } = makeLogSpy();

		await persistGraphEntities(storage, customScope, enabledGraphConfig(), "mem-scope", [TRIPLE_A], logger);

		expect(transport.requests.length, "at least one request").toBeGreaterThan(0);
		for (const req of transport.requests) {
			expect(req.org, "org threaded on every request").toBe("my-org-123");
			expect(req.workspace, "workspace threaded on every request").toBe("my-ws-456");
		}
	});

	it("agent_id derived from scope.workspace appears in entity INSERT SQL", async () => {
		const capturedSqls: string[] = [];
		const capturingResponder = (req: TransportRequest): StorageRow[] => {
			capturedSqls.push(req.sql);
			return [];
		};
		const { storage } = buildStorage(capturingResponder);
		const { logger } = makeLogSpy();
		const customScope: QueryScope = { org: "org-a", workspace: "ws-agent-99" };

		await persistGraphEntities(storage, customScope, enabledGraphConfig(), "mem-ag", [TRIPLE_A], logger);

		// The agent_id column in INSERT rows should carry the workspace value.
		const insertSqls = capturedSqls.filter((s) => s.toUpperCase().startsWith("INSERT"));
		expect(
			insertSqls.some((s) => s.includes("ws-agent-99")),
			"agent_id = workspace in INSERT SQL",
		).toBe(true);
	});

	it("multiple triples: every entity/dependency/mention write is scoped", async () => {
		const { storage, transport } = buildStorage(allNewResponder());
		const { logger } = makeLogSpy();
		const scope: QueryScope = { org: "scoped-org", workspace: "scoped-ws" };

		await persistGraphEntities(
			storage,
			scope,
			enabledGraphConfig(),
			"mem-multi",
			[TRIPLE_A, TRIPLE_B],
			logger,
		);

		// All requests on this transport should have the correct scope.
		for (const req of transport.requests) {
			expect(req.org).toBe("scoped-org");
			expect(req.workspace).toBe("scoped-ws");
		}
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// Handler integration: verify the full createGraphPersistHandler path
// ═════════════════════════════════════════════════════════════════════════════

describe("createGraphPersistHandler full handler path", () => {
	it("reads memoryId and entities off job.payload and calls persistGraphEntities", async () => {
		const capturedSqls: string[] = [];
		const { storage, transport } = buildStorage((req) => {
			capturedSqls.push(req.sql);
			return [];
		});
		const { logger } = makeLogSpy();

		const handler = createGraphPersistHandler({ storage, scope: TEST_SCOPE, config: enabledGraphConfig(), logger });
		const job = makeJob("mem-handler-01", [TRIPLE_A]);

		await expect(handler(job)).resolves.toBeUndefined();
		expect(transport.requests.length, "handler issued storage calls").toBeGreaterThan(0);
	});

	it("empty entities list → no INSERT statements (nothing to write)", async () => {
		const { storage, transport } = buildStorage(allNewResponder());
		const { logger } = makeLogSpy();

		const handler = createGraphPersistHandler({ storage, scope: TEST_SCOPE, config: enabledGraphConfig(), logger });
		await handler(makeJob("mem-empty", []));

		// No INSERTs expected for an empty entity list.
		const inserts = transport.requests.filter((r) => r.sql.toUpperCase().startsWith("INSERT"));
		expect(inserts).toHaveLength(0);
	});

	it("empty memoryId → no graph writes (guard against orphaned rows)", async () => {
		const { storage, transport } = buildStorage(allNewResponder());
		const { logger } = makeLogSpy();

		const handler = createGraphPersistHandler({ storage, scope: TEST_SCOPE, config: enabledGraphConfig(), logger });
		// Payload with a missing memoryId.
		const job: StageJob = {
			id: "job-empty-id",
			kind: "memory_graph_persist",
			attempt: 1,
			scope: { org: "test-org", workspace: "test-ws", agentId: "agent-x" },
			payload: { memoryId: "", entities: [TRIPLE_A] },
		};
		await expect(handler(job)).resolves.toBeUndefined();
		expect(transport.requests).toHaveLength(0);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// PRD-045c: the inline linker is INVOKED on the live graph-persist write path
//            (c-AC-1), idempotently and non-fatally.
// ═════════════════════════════════════════════════════════════════════════════

describe("PRD-045c inline linker invocation (c-AC-1)", () => {
	it("invokes the injected linker with the committed memory id, agent, and forwarded content", async () => {
		const { storage } = buildStorage(allNewResponder());
		const { logger } = makeLogSpy();
		const calls: Array<{ agentId: string; memoryId: string; content: string }> = [];
		const spyLinker: InlineLinker = async (_s, _scope, args) => {
			calls.push({ agentId: args.agentId, memoryId: args.memoryId, content: args.content });
			return { mentions: [{ entityId: "ent_x", canonicalName: "daemon", mentionId: "mention_x" }], candidateCount: 1 };
		};

		await persistGraphEntities(
			storage,
			TEST_SCOPE,
			enabledGraphConfig(),
			"mem-link",
			[TRIPLE_A],
			logger,
			"The Daemon binds Port 3850 on boot.",
			spyLinker,
		);

		expect(calls, "the linker is invoked exactly once on the live path").toHaveLength(1);
		expect(calls[0]?.memoryId).toBe("mem-link");
		// agent_id derives from scope.workspace (the engine-scope inner ring).
		expect(calls[0]?.agentId).toBe("test-ws");
		expect(calls[0]?.content).toContain("Daemon");
	});

	it("falls back to triple-derived text when no content is forwarded (pre-045c payload)", async () => {
		const { storage } = buildStorage(allNewResponder());
		const { logger } = makeLogSpy();
		let seenContent = "";
		const spyLinker: InlineLinker = async (_s, _scope, args) => {
			seenContent = args.content;
			return { mentions: [], candidateCount: 0 };
		};

		await persistGraphEntities(storage, TEST_SCOPE, enabledGraphConfig(), "mem-nofw", [TRIPLE_A], logger, "", spyLinker);

		// With no forwarded content, the stage synthesises scan text from the triple names so the
		// linker can still resolve+link the just-created entities.
		expect(seenContent).toContain("Daemon");
		expect(seenContent).toContain("Port 3850");
	});

	it("the handler forwards payload.content to the linker (the live wire)", async () => {
		const { storage } = buildStorage(allNewResponder());
		const { logger } = makeLogSpy();
		let seenContent = "";
		const spyLinker: InlineLinker = async (_s, _scope, args) => {
			seenContent = args.content;
			return { mentions: [], candidateCount: 0 };
		};

		const handler = createGraphPersistHandler({
			storage,
			scope: TEST_SCOPE,
			config: enabledGraphConfig(),
			logger,
			linkMemory: spyLinker,
		});
		await handler({
			id: "job-link",
			kind: "memory_graph_persist",
			attempt: 1,
			scope: { org: "test-org", workspace: "test-ws", agentId: "test-agent" },
			payload: { memoryId: "mem-h", entities: [TRIPLE_A], content: "Daemon owns the pipeline." },
		});

		expect(seenContent).toBe("Daemon owns the pipeline.");
	});

	it("a linker throw is NON-FATAL: the handler still resolves (c-AC-5 / d-AC-3)", async () => {
		const { storage } = buildStorage(allNewResponder());
		const { logger, warns } = makeLogSpy();
		const throwingLinker: InlineLinker = async () => {
			throw new Error("linker boom");
		};

		const handler = createGraphPersistHandler({
			storage,
			scope: TEST_SCOPE,
			config: enabledGraphConfig(),
			logger,
			linkMemory: throwingLinker,
		});
		await expect(
			handler({
				id: "job-boom",
				kind: "memory_graph_persist",
				attempt: 1,
				scope: { org: "test-org", workspace: "test-ws", agentId: "test-agent" },
				payload: { memoryId: "mem-boom", entities: [TRIPLE_A], content: "x" },
			}),
		).resolves.toBeUndefined();
		// The non-fatal swallow logged a warning rather than crashing the job.
		expect(warns).toContain("graph_persist.storage_error");
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// ISS-002: ONE resolved boolean drives the stage — the live unified gate
// (`graphEnabled`) overrides the config snapshot, and the handler reads it
// PER JOB so a reload-published settings flip gates the very next job.
// ═════════════════════════════════════════════════════════════════════════════

describe("ISS-002 unified graph gate: the live resolved boolean drives the stage", () => {
	it("graphEnabled=true overrides a both-flags-off config snapshot → rows are written", async () => {
		const { storage, transport } = buildStorage(allNewResponder());
		const { logger, warns } = makeLogSpy();
		const config = enabledGraphConfig({ graph: { enabled: false, extractionWritesEnabled: false } });

		await persistGraphEntities(storage, TEST_SCOPE, config, "mem-live-on", [TRIPLE_A], logger, "", noopLinker, true);

		expect(warns).toHaveLength(0);
		const sqls = transport.requests.map((r) => r.sql.toUpperCase());
		expect(
			sqls.some((s) => s.startsWith("INSERT") && s.includes("ENTITIES")),
			"entity rows written under the live gate",
		).toBe(true);
		expect(
			sqls.some((s) => s.includes("INSERT") && s.includes("ENTITY_DEPENDENCIES")),
			"dependency rows written under the live gate",
		).toBe(true);
	});

	it("graphEnabled=false overrides a both-flags-on config snapshot → gated_off event only, no writes", async () => {
		const { storage, transport } = buildStorage(allNewResponder());
		const { logger, infos, warns } = makeLogSpy();

		await persistGraphEntities(
			storage,
			TEST_SCOPE,
			enabledGraphConfig(),
			"mem-live-off",
			[TRIPLE_A],
			logger,
			"",
			noopLinker,
			false,
		);

		expect(transport.requests, "no storage calls when the live gate is off").toHaveLength(0);
		expect(infos).toContain("graph_persist.gated_off");
		expect(warns).toHaveLength(0);
	});

	it("the handler reads the live probe PER JOB: a mid-run flip gates the very next job (the #304 reload application)", async () => {
		const { storage, transport } = buildStorage(allNewResponder());
		const { logger, infos } = makeLogSpy();
		// The mutable cell stands in for the worker's `graphEnabledLive`, which the reload
		// closure republishes on a vault `graph.enabled` / `memory.enabled` write.
		let live = false;
		const handler = createGraphPersistHandler({
			storage,
			scope: TEST_SCOPE,
			// The config snapshot says ON — proving the probe (not the snapshot) decides.
			config: enabledGraphConfig(),
			logger,
			linkMemory: noopLinker,
			graphEnabled: () => live,
		});

		await handler(makeJob("mem-flip-1", [TRIPLE_A]));
		expect(transport.requests, "gate off → gated_off only").toHaveLength(0);
		expect(infos).toContain("graph_persist.gated_off");

		live = true; // the reload seam publishes the flipped vault setting…
		await handler(makeJob("mem-flip-2", [TRIPLE_A]));
		const sqls = transport.requests.map((r) => r.sql.toUpperCase());
		expect(
			sqls.some((s) => s.startsWith("INSERT") && s.includes("ENTITIES")),
			"…and the very next job writes entity rows",
		).toBe(true);
		expect(
			sqls.some((s) => s.includes("INSERT") && s.includes("ENTITY_DEPENDENCIES")),
			"…and dependency rows",
		).toBe(true);
	});

	it("pure-config callers keep the legacy two-flag conjunction when no live gate is supplied (d-AC-4 back-compat)", async () => {
		const { storage, transport } = buildStorage(allNewResponder());
		const { logger } = makeLogSpy();
		const config = enabledGraphConfig({ graph: { enabled: true, extractionWritesEnabled: false } });

		await persistGraphEntities(storage, TEST_SCOPE, config, "mem-legacy", [TRIPLE_A], logger, "", noopLinker);

		expect(transport.requests, "legacy conjunction still gates config-only callers").toHaveLength(0);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// ISS-002 producer chain: the EXACT payload `controlledWriteFanOut` enqueues for
// a committed, entity-bearing memory drives the graph-persist handler under the
// unified gate → rows land in BOTH tables (`entities` + `entity_dependencies`).
// This pins the seam (fan-out payload shape ↔ handler payload reader) so neither
// side can drift silently.
// ═════════════════════════════════════════════════════════════════════════════

describe("ISS-002 producer chain: committed memory → fan-out payload → graph rows in both tables", () => {
	it("gate ON: the fan-out-enqueued payload produces entity + dependency + mention writes", async () => {
		// (1) The controlled-write stage commits a memory and the fan-out enqueues the graph job.
		const enqueued: JobInput[] = [];
		const queue: JobQueueService = {
			async enqueue(job: JobInput): Promise<string> {
				enqueued.push(job);
				return "job-chain-1";
			},
			async lease(): Promise<LeasedJob | null> {
				return null;
			},
			async complete(): Promise<void> {},
			async fail(): Promise<void> {},
			start(): void {},
			stop(): void {},
		};
		const upstream: StageJob = {
			id: "cw-1",
			kind: "memory_controlled_write",
			attempt: 1,
			scope: { org: "test-org", workspace: "test-ws", agentId: "test-agent" },
			payload: {
				entities: [{ source: "Daemon", relationship: "binds", target: "Port 3850" }],
				content: "The Daemon binds Port 3850.",
			},
		};
		await controlledWriteFanOut(queue)(upstream, { action: "inserted", memoryId: "mem-chain" });
		expect(enqueued).toHaveLength(1);
		expect(enqueued[0].kind).toBe("memory_graph_persist");

		// (2) The SAME payload rides into the graph-persist handler with the unified gate ON.
		const { storage, transport } = buildStorage(allNewResponder());
		const { logger, warns } = makeLogSpy();
		const handler = createGraphPersistHandler({
			storage,
			scope: TEST_SCOPE,
			config: enabledGraphConfig({ graph: { enabled: false, extractionWritesEnabled: false } }),
			logger,
			linkMemory: noopLinker,
			graphEnabled: () => true, // the resolved unified gate (vault-first / follows memory)
		});
		await handler({
			id: "gp-1",
			kind: "memory_graph_persist",
			attempt: 1,
			scope: { org: "test-org", workspace: "test-ws", agentId: "test-agent" },
			payload: enqueued[0].payload,
		});

		expect(warns).toHaveLength(0);
		const sqls = transport.requests.map((r) => r.sql.toUpperCase());
		expect(
			sqls.some((s) => s.startsWith("INSERT") && s.includes('"ENTITIES"')),
			"entities table written from the fan-out payload",
		).toBe(true);
		expect(
			sqls.some((s) => s.includes("INSERT") && s.includes("ENTITY_DEPENDENCIES")),
			"entity_dependencies table written from the fan-out payload",
		).toBe(true);
		expect(
			sqls.some((s) => s.includes("INSERT") && s.includes("MEMORY_ENTITY_MENTIONS")),
			"mention link written for the committed memory",
		).toBe(true);
	});

	it("gate OFF: the same chain produces the gated_off event only — no rows", async () => {
		const { storage, transport } = buildStorage(allNewResponder());
		const { logger, infos, warns } = makeLogSpy();
		const handler = createGraphPersistHandler({
			storage,
			scope: TEST_SCOPE,
			config: enabledGraphConfig(),
			logger,
			linkMemory: noopLinker,
			graphEnabled: () => false,
		});
		await handler(makeJob("mem-chain-off", [TRIPLE_A]));
		expect(transport.requests).toHaveLength(0);
		expect(infos).toContain("graph_persist.gated_off");
		expect(warns).toHaveLength(0);
	});
});
