import { describe, expect, it, vi } from "vitest";
import {
	DEFAULT_LOCAL_JOB_KINDS,
	type HybridJobQueueConfig,
} from "../../../../src/daemon/runtime/services/hybrid-job-queue.js";
import { openLocalJobQueue } from "../../../../src/daemon/runtime/services/local-job-queue.js";
import {
	buildLocalQueueUpgradeDiagnostics,
	countPendingSharedLocalJobs,
	resolveLocalQueueTopology,
} from "../../../../src/daemon/runtime/services/local-queue-diagnostics.js";
import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult, queryError } from "../../../../src/daemon/storage/result.js";

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
		try {
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
		} finally {
			localQueue.stop();
		}
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

	it("labels unrecognized topology env values as env-sourced unknowns", () => {
		const topology = resolveLocalQueueTopology({ HONEYCOMB_TOPOLOGY: "shared-workstation" });

		expect(topology).toMatchObject({
			mode: "unknown",
			source: "env",
			eligibleForDefaultOn: false,
		});
	});

	it("AC-8: install topology fallback is eligible for default-on", () => {
		const topology = resolveLocalQueueTopology({ HONEYCOMB_INSTALL_TOPOLOGY: "single-machine" });

		expect(topology).toMatchObject({
			mode: "single_machine",
			eligibleForDefaultOn: true,
		});
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
		try {
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
		} finally {
			localQueue.stop();
		}
	});

	it("bounds pending shared-job diagnostics when DeepLake does not answer", async () => {
		vi.useFakeTimers();
		const localQueue = openLocalJobQueue({ memory: true });
		try {
			const diagnosticsPromise = buildLocalQueueUpgradeDiagnostics({
				config: config(),
				localQueue,
				pendingSharedLocalJobs: async () => new Promise(() => undefined),
			});

			await vi.advanceTimersByTimeAsync(5_000);
			const diagnostics = await diagnosticsPromise;

			expect(diagnostics.pendingSharedLocalJobs).toMatchObject({
				available: false,
				total: null,
				source: "unavailable",
				message: "shared DeepLake job count timed out after 5000ms",
			});
		} finally {
			localQueue.stop();
			vi.useRealTimers();
		}
	});

	it("includes the live storage query-meter snapshot when the daemon provides one", async () => {
		const localQueue = openLocalJobQueue({ memory: true });
		try {
			const diagnostics = await buildLocalQueueUpgradeDiagnostics({
				config: config(),
				localQueue,
				queryMeter: () => ({
					snapshot: {
						perSource: [{ source: "recall-arm", reads: 2, writes: 0 }],
						totalReads: 2,
						totalWrites: 0,
					},
					logLine: "[query-meter] total_reads=2 total_writes=0 recall-arm=r:2/w:0",
				}),
			});

			expect(diagnostics.queryMeter).toMatchObject({
				snapshot: { totalReads: 2, totalWrites: 0 },
				logLine: "[query-meter] total_reads=2 total_writes=0 recall-arm=r:2/w:0",
			});
		} finally {
			localQueue.stop();
		}
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
