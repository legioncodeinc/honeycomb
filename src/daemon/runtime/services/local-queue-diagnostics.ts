/**
 * PRD-066e local-queue upgrade/rollback diagnostics.
 *
 * This module is intentionally pure except for the optional request-time DeepLake
 * pending-job count. It never runs on an idle timer, so the idle-cost fix remains
 * intact while operators can deliberately inspect upgrade/rollback state.
 */

import { JOB_FAILED, JOB_LEASED, JOB_QUEUED, MEMORY_JOBS_TABLE } from "../../storage/catalog/index.js";
import type { QueryScope, StorageQuery } from "../../storage/client.js";
import type { MeterSnapshot } from "../../storage/query-meter.js";
import { isOk, type StorageRow } from "../../storage/result.js";
import { sLiteral, sqlIdent } from "../../storage/sql.js";
import type { HybridJobQueueConfig } from "./hybrid-job-queue.js";
import type { LocalJobQueueService, LocalQueueCounts } from "./local-job-queue.js";

const PENDING_SHARED_LOCAL_JOBS_TIMEOUT_MS = 5_000;

export type LocalQueueTopologyMode = "single_machine" | "multi_device" | "fleet" | "unknown";
export type LocalQueueTopologySource = "env" | "explicit-opt-in" | "default";

interface ResolvedTopologyMode {
	readonly mode: LocalQueueTopologyMode;
	readonly source: Exclude<LocalQueueTopologySource, "explicit-opt-in">;
}

export interface LocalQueueTopology {
	readonly mode: LocalQueueTopologyMode;
	readonly source: LocalQueueTopologySource;
	readonly eligibleForDefaultOn: boolean;
	readonly reason: string;
}

export interface LocalQueueRollbackStatus {
	readonly flagEnabled: boolean;
	readonly sharedQueuePathActive: boolean;
	readonly requiresDeepLakeMigration: boolean;
	readonly requiresLocalDbDeletion: boolean;
	readonly localWorkWillNotProcess: boolean;
	readonly localQueuedWork: number;
	readonly warning: string | null;
}

export interface PendingSharedLocalJobs {
	readonly available: boolean;
	readonly total: number | null;
	readonly byStatus: Readonly<Record<string, number>>;
	readonly byKind: Readonly<Record<string, number>>;
	readonly source: "deeplake" | "not-checked" | "unavailable";
	readonly message?: string;
}

export interface QueryMeterDiagnostics {
	readonly snapshot: MeterSnapshot;
	readonly logLine: string;
}

export interface LocalQueueUpgradeDiagnostics {
	readonly localQueue: {
		readonly enabled: boolean;
		readonly persistent: boolean;
		readonly drainSharedLocalKinds: boolean;
		readonly localKinds: readonly string[];
		readonly counts: LocalQueueCounts;
	};
	readonly topology: LocalQueueTopology;
	readonly rollback: LocalQueueRollbackStatus;
	readonly pendingSharedLocalJobs: PendingSharedLocalJobs;
	readonly queryMeter: QueryMeterDiagnostics | null;
}

export interface BuildLocalQueueUpgradeDiagnosticsOptions {
	readonly config: HybridJobQueueConfig;
	readonly localQueue: Pick<LocalJobQueueService, "persistent" | "counts">;
	readonly topology?: LocalQueueTopology;
	readonly pendingSharedLocalJobs?: () => Promise<PendingSharedLocalJobs>;
	readonly queryMeter?: () => QueryMeterDiagnostics;
}

export function resolveLocalQueueTopology(env: NodeJS.ProcessEnv = process.env): LocalQueueTopology {
	const explicitOptIn = parseBooleanFlag(env.HONEYCOMB_LOCAL_QUEUE_EXPLICIT_OPT_IN);
	const topologyMode = resolveTopologyMode(env);

	if (explicitOptIn) {
		return {
			mode: topologyMode.mode,
			source: "explicit-opt-in",
			eligibleForDefaultOn: true,
			reason: "explicit local-queue opt-in overrides topology default-on guard",
		};
	}

	if (topologyMode.mode === "single_machine") {
		return {
			mode: topologyMode.mode,
			source: "env",
			eligibleForDefaultOn: true,
			reason: "single-machine/local topology is eligible for local queue default-on",
		};
	}

	if (topologyMode.mode === "multi_device" || topologyMode.mode === "fleet") {
		return {
			mode: topologyMode.mode,
			source: "env",
			eligibleForDefaultOn: false,
			reason: "multi-device and fleet topologies stay on the shared queue unless explicitly opted in",
		};
	}

	return {
		mode: topologyMode.mode,
		source: topologyMode.source,
		eligibleForDefaultOn: false,
		reason: "unknown topology is not eligible for local queue default-on without explicit opt-in",
	};
}

export async function buildLocalQueueUpgradeDiagnostics(
	options: BuildLocalQueueUpgradeDiagnosticsOptions,
): Promise<LocalQueueUpgradeDiagnostics> {
	const counts = await options.localQueue.counts();
	const topology = options.topology ?? resolveLocalQueueTopology();
	const pending =
		options.pendingSharedLocalJobs === undefined
			? notCheckedPendingSharedLocalJobs()
			: await withPendingSharedLocalJobsTimeout(options.pendingSharedLocalJobs, PENDING_SHARED_LOCAL_JOBS_TIMEOUT_MS);
	const localQueuedWork =
		statusCount(counts, "queued") + statusCount(counts, "retrying") + statusCount(counts, "leased");
	const localWorkWillNotProcess = !options.config.enabled && localQueuedWork > 0;

	return {
		localQueue: {
			enabled: options.config.enabled,
			persistent: options.localQueue.persistent,
			drainSharedLocalKinds: options.config.drainSharedLocalKinds,
			localKinds: [...options.config.localKinds].sort(),
			counts,
		},
		topology,
		rollback: {
			flagEnabled: options.config.enabled,
			sharedQueuePathActive: !options.config.enabled,
			requiresDeepLakeMigration: false,
			requiresLocalDbDeletion: false,
			localWorkWillNotProcess,
			localQueuedWork,
			warning: localWorkWillNotProcess
				? "local queued work remains in .daemon/local-queue.db and will not be processed while rollback disables the local queue"
				: null,
		},
		pendingSharedLocalJobs: pending,
		queryMeter: options.queryMeter === undefined ? null : options.queryMeter(),
	};
}

async function withPendingSharedLocalJobsTimeout(
	readPending: () => Promise<PendingSharedLocalJobs>,
	timeoutMs: number,
): Promise<PendingSharedLocalJobs> {
	let timeout: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			readPending(),
			new Promise<PendingSharedLocalJobs>((resolve) => {
				timeout = setTimeout(() => {
					resolve({
						available: false,
						total: null,
						byStatus: {},
						byKind: {},
						source: "unavailable",
						message: `shared DeepLake job count timed out after ${timeoutMs}ms`,
					});
				}, timeoutMs);
			}),
		]);
	} finally {
		if (timeout !== undefined) clearTimeout(timeout);
	}
}

export function notCheckedPendingSharedLocalJobs(): PendingSharedLocalJobs {
	return {
		available: false,
		total: null,
		byStatus: {},
		byKind: {},
		source: "not-checked",
		message: "shared DeepLake job count was not requested",
	};
}

export interface CountPendingSharedLocalJobsOptions {
	readonly storage: StorageQuery;
	readonly scope: QueryScope;
	readonly localKinds: ReadonlySet<string>;
	readonly tableName?: string;
}

export async function countPendingSharedLocalJobs(
	options: CountPendingSharedLocalJobsOptions,
): Promise<PendingSharedLocalJobs> {
	const kinds = [...options.localKinds].sort();
	if (kinds.length === 0) {
		return { available: true, total: 0, byStatus: {}, byKind: {}, source: "deeplake" };
	}
	const table = sqlIdent(options.tableName ?? MEMORY_JOBS_TABLE);
	const statuses = [JOB_QUEUED, JOB_FAILED, JOB_LEASED];
	const sql =
		`SELECT ${sqlIdent("status")}, ${sqlIdent("type")}, COUNT(*) AS ${sqlIdent("count")} ` +
		`FROM ${table} ${sqlIdent("job")} ` +
		`JOIN (SELECT ${sqlIdent("id")}, MAX(${sqlIdent("version")}) AS ${sqlIdent("version")} ` +
		`FROM ${table} GROUP BY ${sqlIdent("id")}) ${sqlIdent("latest")} ` +
		`ON ${sqlIdent("job")}.${sqlIdent("id")} = ${sqlIdent("latest")}.${sqlIdent("id")} ` +
		`AND ${sqlIdent("job")}.${sqlIdent("version")} = ${sqlIdent("latest")}.${sqlIdent("version")} ` +
		`WHERE ${sqlIdent("job")}.${sqlIdent("type")} IN (${kinds.map((kind) => sLiteral(kind)).join(", ")}) ` +
		`AND ${sqlIdent("job")}.${sqlIdent("status")} IN (${statuses.map((status) => sLiteral(status)).join(", ")}) ` +
		`GROUP BY ${sqlIdent("status")}, ${sqlIdent("type")}`;
	const result = await options.storage.query(sql, options.scope, { source: "other" });
	if (!isOk(result)) {
		return {
			available: false,
			total: null,
			byStatus: {},
			byKind: {},
			source: "unavailable",
			message: result.message,
		};
	}
	return pendingFromRows(result.rows);
}

function pendingFromRows(rows: readonly StorageRow[]): PendingSharedLocalJobs {
	const byStatus: Record<string, number> = {};
	const byKind: Record<string, number> = {};
	let total = 0;
	for (const row of rows) {
		const status = String(row.status ?? "");
		const kind = String(row.type ?? "");
		const count = Number(row.count ?? 0);
		if (!Number.isFinite(count) || count <= 0) continue;
		byStatus[status] = (byStatus[status] ?? 0) + count;
		byKind[kind] = (byKind[kind] ?? 0) + count;
		total += count;
	}
	return { available: true, total, byStatus, byKind, source: "deeplake" };
}

function statusCount(counts: LocalQueueCounts, status: string): number {
	return Number(counts.byStatus[status as keyof typeof counts.byStatus] ?? 0);
}

function resolveTopologyMode(env: NodeJS.ProcessEnv): ResolvedTopologyMode {
	const raw = env.HONEYCOMB_TOPOLOGY ?? env.HONEYCOMB_INSTALL_TOPOLOGY;
	if (raw === undefined || raw.trim().length === 0) {
		return { mode: "unknown", source: "default" };
	}
	return { mode: normalizeMode(raw), source: "env" };
}

function normalizeMode(raw: string): LocalQueueTopologyMode {
	const normalized = raw.trim().toLowerCase().replace(/[-\s]+/g, "_");
	if (normalized === "single" || normalized === "single_machine" || normalized === "local") return "single_machine";
	if (normalized === "multi" || normalized === "multi_device" || normalized === "team" || normalized === "hybrid") {
		return "multi_device";
	}
	if (normalized === "fleet" || normalized === "orchestrated") return "fleet";
	if (normalized === "unknown") return "unknown";
	return "unknown";
}

function parseBooleanFlag(raw: string | undefined): boolean {
	if (raw === undefined) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
