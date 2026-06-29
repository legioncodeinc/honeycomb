import { describe, expect, it } from "vitest";
import {
	buildLocalQueueUpgradeDiagnostics,
	countPendingSharedLocalJobs,
	resolveLocalQueueTopology,
} from "../../../../src/daemon/runtime/services/local-queue-diagnostics.js";
import { DEFAULT_LOCAL_JOB_KINDS, type HybridJobQueueConfig } from "../../../../src/daemon/runtime/services/hybrid-job-queue.js";
import { openLocalJobQueue } from "../../../../src/daemon/runtime/services/local-job-queue.js";
import { ok, queryError, type QueryResult } from "../../../../src/daemon/storage/result.js";
import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";

const scope: QueryScope = { org: "org", workspace: "workspace" };

function config(overrides: Partial<HybridJobQueueConfig> = {}): HybridJobQueueConfig {
	return {
		enabled: true,
		drainSharedLocalKinds: false,
		localKinds: new Set(DEFAULT_LOCAL_JOB_KINDS),
		...overrides,
	};
}

describe("PRD-066e local queue diagnostics", () => {
	it("AC-6/AC-7: rollback reports local work that will not process and requires no migrations/deletes", async () => {
		const localQueue = openLocalJobQueue({ memory: true });
		await localQueue.enqueue({ kind: "summary", payload: { sessionId: "s1" } });

		const diagnostics = await buildLocalQueueUpgradeDiagnostics({
			config: config({ enabled: false }),
			localQueue,
			topology: resolveLocalQueueTopology({ HONEYCOMB_TOPOLOGY: "single-machine" }),
		});

		expect(diagnostics.rollback).toMatchObject({
			flagEnabled: false,
			sharedQueuePathActive: true,
			requiresDeepLakeMigration: false,
			requiresLocalDbDeletion: false,
			localWorkWillNotProcess: true,
			localQueuedWork: 1,
		});
		expect(diagnostics.rollback.warning).toContain(".daemon/local-queue.db");
		localQueue.stop();
	});

	it("AC-8: single-machine topology is eligible for default-on", () => {
		const topology = resolveLocalQueueTopology({ HONEYCOMB_TOPOLOGY: "single-machine" });

		expect(topology).toMatchObject({
			mode: "single_machine",
			eligibleForDefaultOn: true,
		});
	});

	it("AC-9: fleet, multi-device, and unknown topologies are blocked without explicit opt-in", () => {
		for (const value of ["fleet", "multi-device", undefined]) {
			const topology = resolveLocalQueueTopology({ HONEYCOMB_TOPOLOGY: value });
			expect(topology.eligibleForDefaultOn).toBe(false);
		}
	});

	it("AC-9: explicit opt-in can override a non-single-machine topology", () => {
		const topology = resolveLocalQueueTopology({
			HONEYCOMB_TOPOLOGY: "fleet",
			HONEYCOMB_LOCAL_QUEUE_EXPLICIT_OPT_IN: "true",
		});

		expect(topology).toMatchObject({
			mode: "fleet",
			source: "explicit-opt-in",
			eligibleForDefaultOn: true,
		});
	});

	it("AC-10: diagnostics include local counts, drain mode, and pending old shared jobs", async () => {
		const localQueue = openLocalJobQueue({ memory: true });
		await localQueue.enqueue({ kind: "summary", payload: { sessionId: "s1" } });

		const diagnostics = await buildLocalQueueUpgradeDiagnostics({
			config: config({ drainSharedLocalKinds: true }),
			localQueue,
			pendingSharedLocalJobs: async () => ({
				available: true,
				total: 2,
				byStatus: { queued: 1, failed: 1 },
				byKind: { summary: 2 },
				source: "deeplake",
			}),
		});

		expect(diagnostics.localQueue.drainSharedLocalKinds).toBe(true);
		expect(diagnostics.localQueue.counts.byStatus.queued).toBe(1);
		expect(diagnostics.pendingSharedLocalJobs).toMatchObject({
			available: true,
			total: 2,
			byKind: { summary: 2 },
		});
		localQueue.stop();
	});
});

describe("PRD-066e pending shared local-job count", () => {
	it("counts current DeepLake-backed local-kind jobs by status and kind", async () => {
		const queries: string[] = [];
		const storage: StorageQuery = {
			async query(sql: string): Promise<QueryResult> {
				queries.push(sql);
				return ok(
					[
						{ status: "queued", type: "summary", count: 2 },
						{ status: "leased", type: "skillify", count: 1 },
					],
					1,
				);
			},
		};

		const pending = await countPendingSharedLocalJobs({
			storage,
			scope,
			localKinds: new Set(["summary", "skillify"]),
		});

		expect(pending).toMatchObject({
			available: true,
			total: 3,
			byStatus: { queued: 2, leased: 1 },
			byKind: { summary: 2, skillify: 1 },
		});
		expect(queries[0]).toContain("MAX(version)");
		expect(queries[0]).toContain("'summary'");
		expect(queries[0]).toContain("'skillify'");
	});

	it("reports unavailable instead of throwing when the shared table cannot be read", async () => {
		const storage: StorageQuery = {
			async query(): Promise<QueryResult> {
				return queryError("missing memory_jobs");
			},
		};

		const pending = await countPendingSharedLocalJobs({
			storage,
			scope,
			localKinds: new Set(["summary"]),
		});

		expect(pending).toMatchObject({
			available: false,
			total: null,
			source: "unavailable",
			message: "missing memory_jobs",
		});
	});
});
