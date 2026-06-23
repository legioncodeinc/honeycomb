/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE memory-pipeline CHAIN SMOKE — OPT-IN, MUTATES A REAL DEEPLAKE.      ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-045a (a-AC-3): proves the WIRED pipeline chain end-to-end on the     ║
 * ║  real backend — a single `memory_extraction` ENTRY job (what capture     ║
 * ║  enqueues) leased by the daemon-resident stage worker fans out through    ║
 * ║  decision → controlled-write → graph-persist and produces ≥1 PERSISTED   ║
 * ║  fact (a `memories` row) AND ≥1 PERSISTED edge (an `entities` /          ║
 * ║  `entity_dependencies` / mention row) under the scope.                    ║
 * ║                                                                          ║
 * ║  It drives the SAME `createStageWorker` + `createPipelineHandlers` +     ║
 * ║  fan-out enqueuers + real `createJobQueueService` the daemon assembles   ║
 * ║  (`buildPipelineWorker`), so the chain under test is the production wiring║
 * ║  — only the MODEL is a `createFakeModelClient` (the live LLM key is not  ║
 * ║  a CI dependency; the wiring + persistence is what this proves, mirroring ║
 * ║  graph-persist-live / controlled-writes-live which drive the stage cores  ║
 * ║  against live storage with a fake model).                                ║
 * ║                                                                          ║
 * ║  GATED + ISOLATED exactly like graph-persist-live.itest.ts:             ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = skip.    ║
 * ║    - `.itest.ts` + `tests/integration/**` exclusion keep it OUT of      ║
 * ║      `npm run test` / `npm run ci`; only `npm run test:integration`.    ║
 * ║    - Authorized workspace (`HONEYCOMB_DEEPLAKE_WORKSPACE`, default       ║
 * ║      `honeycomb_ci`); an invented partition is 403-rejected.            ║
 * ║    - Per-run THROWAWAY table names (the queue's own `tableName` knob for ║
 * ║      `memory_jobs`; a storage proxy rewrites the engine tables), DROPped ║
 * ║      in afterAll. Never touches a real `memory_jobs`/`memories`/graph.   ║
 * ║                                                                          ║
 * ║  SECRETS: the token is read ONLY from env via the storage layer's       ║
 * ║  `envCredentialProvider`. Never hardcoded, logged, or echoed.          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createStorageClient,
	envCredentialProvider,
	isOk,
	minRowCount,
	readConverged,
	resolveStorageConfig,
	type StorageClient,
	sqlIdent,
} from "../../src/daemon/storage/index.js";
import type { QueryScope } from "../../src/daemon/storage/client.js";
import { createJobQueueService } from "../../src/daemon/runtime/services/job-queue.js";
import type { EmbedClient } from "../../src/daemon/runtime/services/embed-client.js";
import {
	controlledWriteFanOut,
	createFakeModelClient,
	createPipelineHandlers,
	createStageWorker,
	decisionFanOut,
	extractionFanOut,
	PipelineConfigSchema,
} from "../../src/daemon/runtime/pipeline/index.js";
import { neutralizeIfInfraDegraded } from "./_infra-skip.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
// Throwaway tables — never collide with production tables.
const TBL_JOBS = `ci_pipe_${RUN_ID}_jobs`;
const TBL_MEMORIES = `ci_pipe_${RUN_ID}_memories`;
const TBL_HISTORY = `ci_pipe_${RUN_ID}_history`;
const TBL_ENTITIES = `ci_pipe_${RUN_ID}_entities`;
const TBL_DEPS = `ci_pipe_${RUN_ID}_deps`;
const TBL_MENTIONS = `ci_pipe_${RUN_ID}_mentions`;

/** Canonical → throwaway table rewrite map for the engine tables the stages touch. */
const TABLE_MAP: Record<string, string> = {
	memories: TBL_MEMORIES,
	memory_history: TBL_HISTORY,
	entities: TBL_ENTITIES,
	entity_dependencies: TBL_DEPS,
	memory_entity_mentions: TBL_MENTIONS,
};

/** A fake embed client (lexical-only path; the live chain proof does not need vectors). */
const nullEmbed: EmbedClient = { async embed(): Promise<readonly number[] | null> { return null; } };

function enabledConfig() {
	return PipelineConfigSchema.parse({
		enabled: true,
		extractionProvider: "fake",
		minFactConfidenceForWrite: 0.5,
		graph: { enabled: true, extractionWritesEnabled: true },
		autonomous: { enabled: true },
	});
}

describe.skipIf(!HAS_TOKEN)("live memory-pipeline chain smoke (opt-in, real backend)", () => {
	let storage: StorageClient;
	let proxy: { query(sql: string, s: QueryScope): ReturnType<StorageClient["query"]> };
	let scope: QueryScope;

	beforeAll(() => {
		const raw = envCredentialProvider().read();
		const provider = {
			read: () => ({ ...raw, workspace: process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "honeycomb_ci" }),
		};
		const config = resolveStorageConfig(provider);
		scope = { org: config.org, workspace: config.workspace };
		storage = createStorageClient({ provider });
		// Rewrite canonical engine-table identifiers to the throwaway names so the stages'
		// hard-coded `"memories"`/graph HealTargets land on per-run tables (mirrors graph-persist-live).
		proxy = {
			async query(sql: string, s: QueryScope) {
				let patched = sql;
				for (const [canonical, throwaway] of Object.entries(TABLE_MAP)) {
					patched = patched
						.replace(new RegExp(`"${canonical}"`, "g"), `"${throwaway}"`)
						.replace(new RegExp(`\\b${canonical}\\b`, "g"), throwaway);
				}
				return storage.query(patched, s);
			},
		};
	});

	afterAll(async () => {
		if (!storage) return;
		// DROP is the reliable teardown on this backend (DELETE does not dependably remove rows).
		for (const tbl of [TBL_MENTIONS, TBL_DEPS, TBL_ENTITIES, TBL_HISTORY, TBL_MEMORIES, TBL_JOBS]) {
			const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(tbl)}"`, scope);
			if (!isOk(res)) console.warn(`[ci-cleanup] could not drop ${tbl}: ${JSON.stringify(res)}`);
		}
	});

	it("capture entry → extraction → decision → controlled-write → graph-persist persists a fact + edge", async ({ skip }) => {
		await neutralizeIfInfraDegraded("pipeline-chain-live:preflight", () => storage.connect(scope), skip);

		// The REAL durable queue, pointed at a throwaway `memory_jobs` table.
		const queue = createJobQueueService({ storage, scope, config: { owner: `pipe-${RUN_ID}`, tableName: TBL_JOBS } });
		await queue.start();

		// The REAL stage handlers + the fan-out chain — the SAME wiring buildPipelineWorker
		// assembles, with storage routed through the table-rewriting proxy and a fake model.
		const config = enabledConfig();
		const model = createFakeModelClient({
			memory_extraction:
				'{"facts":[{"content":"the live daemon binds the ephemeral port","type":"fact","confidence":0.95}],' +
				'"entities":[{"source":"LiveDaemon","relationship":"binds","target":"EphemeralPort"}]}',
		});
		const handlers = createPipelineHandlers({
			extraction: { config, model, onResult: extractionFanOut(queue) },
			decision: { storage: proxy, scope, model, config, embed: nullEmbed, onDecisions: decisionFanOut(queue) },
			controlledWrite: { storage: proxy, config, embed: nullEmbed, onOutcome: controlledWriteFanOut(queue) },
			graphPersist: { storage: proxy, scope, config },
			retention: { storage: proxy, scope, config },
		});
		const worker = createStageWorker({ queue, handlers });

		// a-AC-2: capture's entry job.
		await queue.enqueue({
			kind: "memory_extraction",
			payload: { org: scope.org, workspace: scope.workspace, agent_id: "default", content: "the live daemon binds the ephemeral port" },
		});

		// Drive the chain to drain. The queue is poll-convergent over the real backend, so a
		// just-completed stage's downstream enqueue is reliably leasable on the next runOnce.
		for (let step = 0; step < 30; step++) {
			const processed = await worker.runOnce();
			if (!processed) break;
		}
		queue.stop();

		// a-AC-3: a fact persisted (a `memories` row) under the scope. Read CONVERGENT —
		// a single immediate scan of a just-written row can land on a stale segment.
		const mem = await readConverged(storage, `SELECT id FROM "${sqlIdent(TBL_MEMORIES)}"`, scope, minRowCount(1));
		expect(isOk(mem) && mem.rows.length >= 1, "≥1 memory row persisted by the wired chain").toBe(true);

		// a-AC-3: an edge persisted (a graph entity row) under the scope.
		const ents = await readConverged(storage, `SELECT id FROM "${sqlIdent(TBL_ENTITIES)}"`, scope, minRowCount(1));
		expect(isOk(ents) && ents.rows.length >= 1, "≥1 graph entity persisted by the wired chain").toBe(true);
	});
});
