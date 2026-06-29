import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { assembleDaemon, type AssembledDaemon } from "../../src/daemon/runtime/assemble.js";
import { type RuntimeConfig } from "../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../src/daemon/runtime/logger.js";
import {
	controlledWriteFanOut,
	createFakeModelClient,
	createPipelineHandlers,
	createStageWorker,
	decisionFanOut,
	extractionFanOut,
	PipelineConfigSchema,
} from "../../src/daemon/runtime/pipeline/index.js";
import type { EmbedClient } from "../../src/daemon/runtime/services/embed-client.js";
import { noopEmbedSupervisor } from "../../src/daemon/runtime/services/embed-supervisor.js";
import { DEFAULT_LOCAL_JOB_KINDS, createHybridJobQueueService } from "../../src/daemon/runtime/services/hybrid-job-queue.js";
import type { JobQueueService, JobInput, LeasedJob } from "../../src/daemon/runtime/services/job-queue.js";
import { openLocalJobQueue } from "../../src/daemon/runtime/services/local-job-queue.js";
import {
	createStorageClient,
	buildCreateTableSql,
	defaultCredentialProvider,
	isOk,
	minRowCount,
	QueryMeter,
	readConverged,
	resolveStorageConfig,
	sqlIdent,
	type StorageClient,
	type ColumnDef,
} from "../../src/daemon/storage/index.js";
import type { QueryOptions, QueryScope } from "../../src/daemon/storage/client.js";
import type { MeterSnapshot } from "../../src/daemon/storage/query-meter.js";
import { MEMORIES_COLUMNS } from "../../src/daemon/storage/catalog/index.js";

const HAS_SHARED_CREDENTIAL_FILE = existsSync(join(process.env.USERPROFILE ?? process.env.HOME ?? "", ".deeplake", "credentials.json"));
const IDLE_WINDOW_MS = 1_500;
const MEMORIES_VERSION_COLUMN: ColumnDef = { name: "version", sql: "BIGINT NOT NULL DEFAULT 1" };

const runtimeConfig: RuntimeConfig = {
	host: "127.0.0.1",
	port: 0,
	mode: "local",
	widened: false,
};

interface StartedProbe {
	readonly assembled: AssembledDaemon;
	readonly meter: QueryMeter;
	readonly storage: StorageClient;
	readonly runtimeDir: string;
	readonly workspaceDir: string;
	readonly originalEnv: Record<string, string | undefined>;
}

const started: StartedProbe[] = [];

afterEach(async () => {
	while (started.length > 0) {
		const probe = started.pop();
		if (probe === undefined) continue;
		await probe.assembled.shutdown();
		restoreEnv(probe.originalEnv);
		rmSync(probe.runtimeDir, { recursive: true, force: true });
		rmSync(probe.workspaceDir, { recursive: true, force: true });
	}
});

describe.skipIf(!HAS_SHARED_CREDENTIAL_FILE)("PRD-066 live idle query-meter proof", () => {
	it("shared queue idle discovery produces poll reads, while local queue mode produces zero DeepLake coordination reads", async () => {
		const shared = await startMeteredDaemon({ localQueueEnabled: false });
		shared.meter.reset();
		await sleep(IDLE_WINDOW_MS);
		await shared.assembled.daemon.services.queue.lease(["summary"]);
		const sharedSnap = shared.meter.snapshot();

		expect(pollReads(sharedSnap)).toBeGreaterThan(0);

		await shared.assembled.shutdown();

		const local = await startMeteredDaemon({ localQueueEnabled: true });
		local.meter.reset();
		await sleep(IDLE_WINDOW_MS);
		await local.assembled.daemon.services.queue.lease(["summary"]);
		const localSnap = local.meter.snapshot();

		console.info(
			`[prd-066-idle-meter] shared_poll_reads=${pollReads(sharedSnap)} shared_poll_writes=${pollWrites(sharedSnap)} ` +
				`local_poll_reads=${pollReads(localSnap)} local_poll_writes=${pollWrites(localSnap)}`,
		);

		expect(pollReads(localSnap)).toBe(0);
		expect(pollWrites(localSnap)).toBe(0);
	});

	it("a local-queue memory pipeline job still performs real DeepLake memory/graph work", async ({ skip }) => {
		const provider = defaultCredentialProvider();
		const config = resolveStorageConfig(provider);
		const scope: QueryScope = { org: config.org, workspace: config.workspace };
		const meter = new QueryMeter();
		const storage = createStorageClient({ provider, meter });
		const workspaceDir = mkdtempSync(join(tmpdir(), "hc-066-pipeline-workspace-"));
		const run = makeRunId();
		const tables = {
			memories: `ci_066_${run}_memories`,
			memory_history: `ci_066_${run}_history`,
			entities: `ci_066_${run}_entities`,
			entity_dependencies: `ci_066_${run}_deps`,
			memory_entity_mentions: `ci_066_${run}_mentions`,
		};
		const proxy = tableRewriteStorage(storage, tables);
		const local = openLocalJobQueue({ baseDir: workspaceDir });
		const queue = createHybridJobQueueService({
			local,
			shared: throwingSharedQueue(),
			config: { enabled: true, drainSharedLocalKinds: false, localKinds: new Set(DEFAULT_LOCAL_JOB_KINDS) },
		});

		try {
			const createdMemories = await storage.query(
				buildCreateTableSql(tables.memories, [...MEMORIES_COLUMNS, MEMORIES_VERSION_COLUMN]),
				scope,
			);
			if (isInsufficientBalance(createdMemories)) skip("DeepLake live write proof requires a funded account");
			expect(isOk(createdMemories), "created throwaway memories table for the live dedup probe").toBe(true);

			queue.start();
			const pipelineConfig = PipelineConfigSchema.parse({
				enabled: true,
				extractionProvider: "fake",
				minFactConfidenceForWrite: 0.5,
				graph: { enabled: true, extractionWritesEnabled: true },
				autonomous: { enabled: true },
			});
			const model = createFakeModelClient({
				memory_extraction:
					'{"facts":[{"content":"the PRD-066 local queue writes through to DeepLake","type":"fact","confidence":0.95}],' +
					'"entities":[{"source":"LocalQueue","relationship":"writes_to","target":"DeepLake"}]}',
			});
			const nullEmbed: EmbedClient = { async embed(): Promise<readonly number[] | null> { return null; } };
			const handlers = createPipelineHandlers({
				extraction: { config: pipelineConfig, model, onResult: extractionFanOut(queue) },
				decision: { storage: proxy, scope, model, config: pipelineConfig, embed: nullEmbed, onDecisions: decisionFanOut(queue) },
				controlledWrite: { storage: proxy, config: pipelineConfig, embed: nullEmbed, onOutcome: controlledWriteFanOut(queue) },
				graphPersist: { storage: proxy, scope, config: pipelineConfig },
				retention: { storage: proxy, scope, config: pipelineConfig },
			});
			const stageEvents: Array<{ readonly name: string; readonly fields?: Record<string, unknown> }> = [];
			const worker = createStageWorker({
				queue,
				handlers,
				logger: { event: (name, fields) => stageEvents.push({ name, fields }) },
			});

			meter.reset();
			await queue.enqueue({
				kind: "memory_extraction",
				payload: {
					org: scope.org,
					workspace: scope.workspace,
					agent_id: "default",
					content: "the PRD-066 local queue writes through to DeepLake",
				},
			});

			for (let step = 0; step < 30; step++) {
				const processed = await worker.runOnce();
				if (!processed) break;
			}

			const activeSnap = meter.snapshot();
			console.info(
				`[prd-066-active-meter] poll_reads=${pollReads(activeSnap)} poll_writes=${pollWrites(activeSnap)} ` +
					`total_reads=${activeSnap.totalReads} total_writes=${activeSnap.totalWrites}`,
			);
			expect(pollReads(activeSnap)).toBe(0);
			expect(pollWrites(activeSnap)).toBe(0);
			expect(activeSnap.totalWrites).toBeGreaterThan(0);
			expect(stageEvents.filter((event) => event.name === "stage.failed")).toHaveLength(0);
			expect(stageEvents.map((event) => event.fields?.kind)).toContain("memory_controlled_write");

			const memories = await readConverged(
				storage,
				`SELECT id FROM "${sqlIdent(tables.memories)}"`,
				scope,
				minRowCount(1),
			);
			expect(isOk(memories) && memories.rows.length >= 1, "memory row persisted through the local queue pipeline").toBe(true);

			const entities = await readConverged(
				storage,
				`SELECT id FROM "${sqlIdent(tables.entities)}"`,
				scope,
				minRowCount(1),
			);
			expect(isOk(entities) && entities.rows.length >= 1, "graph entity persisted through the local queue pipeline").toBe(true);
		} finally {
			queue.stop();
			for (const table of Object.values(tables).reverse()) {
				await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(table)}"`, scope);
			}
			rmSync(workspaceDir, { recursive: true, force: true });
		}
	}, 180_000);
});

async function startMeteredDaemon(options: { readonly localQueueEnabled: boolean }): Promise<StartedProbe> {
	const runtimeDir = mkdtempSync(join(tmpdir(), "hc-066-runtime-"));
	const workspaceDir = mkdtempSync(join(tmpdir(), "hc-066-workspace-"));
	const originalEnv = setEnvForProbe(workspaceDir, options.localQueueEnabled);
	const meter = new QueryMeter();
	const storage = createStorageClient({ meter });
	const assembled = assembleDaemon({
		config: runtimeConfig,
		storage,
		logger: createRequestLogger({ silent: true }),
		runtimeDir,
		workspaceDir,
		healthProbeIntervalMs: 60_000,
		embedSupervisor: noopEmbedSupervisor,
	});
	await assembled.start();
	const probe = { assembled, meter, storage, runtimeDir, workspaceDir, originalEnv };
	started.push(probe);
	return probe;
}

function setEnvForProbe(workspaceDir: string, localQueueEnabled: boolean): Record<string, string | undefined> {
	const keys = [
		"HONEYCOMB_WORKSPACE",
		"HONEYCOMB_LOCAL_QUEUE_ENABLED",
		"HONEYCOMB_LOCAL_QUEUE_DRAIN_SHARED",
		"HONEYCOMB_EMBEDDINGS",
		"HONEYCOMB_POLLINATING_ENABLED",
		"HONEYCOMB_GRAPH_PUSH",
	] as const;
	const original = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
	process.env.HONEYCOMB_WORKSPACE = workspaceDir;
	process.env.HONEYCOMB_LOCAL_QUEUE_ENABLED = localQueueEnabled ? "true" : "false";
	process.env.HONEYCOMB_LOCAL_QUEUE_DRAIN_SHARED = "false";
	process.env.HONEYCOMB_EMBEDDINGS = "false";
	process.env.HONEYCOMB_POLLINATING_ENABLED = "false";
	process.env.HONEYCOMB_GRAPH_PUSH = "0";
	return original;
}

function restoreEnv(original: Record<string, string | undefined>): void {
	for (const [key, value] of Object.entries(original)) {
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
}

function pollReads(snapshot: MeterSnapshot): number {
	return sourceCount(snapshot, "poll-lease", "reads") + sourceCount(snapshot, "poll-reaper", "reads");
}

function pollWrites(snapshot: MeterSnapshot): number {
	return sourceCount(snapshot, "poll-lease", "writes") + sourceCount(snapshot, "poll-reaper", "writes");
}

function sourceCount(snapshot: MeterSnapshot, source: string, key: "reads" | "writes"): number {
	return snapshot.perSource.find((entry) => entry.source === source)?.[key] ?? 0;
}

function isInsufficientBalance(result: unknown): boolean {
	if (result === null || typeof result !== "object") return false;
	const record = result as Record<string, unknown>;
	return record.kind === "query_error" && (record.status === 402 || /insufficient balance/i.test(String(record.message ?? "")));
}

async function sleep(ms: number): Promise<void> {
	await new Promise((resolve) => setTimeout(resolve, ms));
}

function makeRunId(): string {
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

function tableRewriteStorage(storage: StorageClient, tables: Record<string, string>): Pick<StorageClient, "query"> {
	return {
		query(sql: string, scope: QueryScope, options?: QueryOptions) {
			let patched = sql;
			for (const [canonical, throwaway] of Object.entries(tables)) {
				patched = patched
					.replace(new RegExp(`"${canonical}"`, "g"), `"${throwaway}"`)
					.replace(new RegExp(`\\b${canonical}\\b`, "g"), throwaway);
			}
			return storage.query(patched, scope, options);
		},
	};
}

function throwingSharedQueue(): JobQueueService {
	return {
		async enqueue(_job: JobInput): Promise<string> {
			throw new Error("shared queue should not receive local PRD-066 jobs");
		},
		async lease(): Promise<LeasedJob | null> {
			throw new Error("shared queue should not be polled for local PRD-066 jobs");
		},
		async complete(id: string): Promise<void> {
			throw new Error(`shared queue should not complete local PRD-066 job ${id}`);
		},
		async fail(id: string): Promise<void> {
			throw new Error(`shared queue should not fail local PRD-066 job ${id}`);
		},
		start(): void {
			throw new Error("shared queue should not start in local-only PRD-066 mode");
		},
		stop(): void {
			/* stop is always safe during hybrid shutdown */
		},
	};
}
