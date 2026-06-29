/**
 * PRD-066b hybrid queue router.
 *
 * The existing daemon expects one `JobQueueService`. This adapter keeps that seam
 * stable while routing local-only job kinds to the daemon-local SQLite queue and
 * leaving shared/unknown kinds on the existing DeepLake-backed queue.
 */

import type { JobInput, JobQueueService, LeasedJob } from "./job-queue.js";

export const HONEYCOMB_LOCAL_QUEUE_ENABLED = "HONEYCOMB_LOCAL_QUEUE_ENABLED" as const;
export const HONEYCOMB_LOCAL_QUEUE_DRAIN_SHARED = "HONEYCOMB_LOCAL_QUEUE_DRAIN_SHARED" as const;

export const DEFAULT_LOCAL_JOB_KINDS = Object.freeze([
	"memory_extraction",
	"memory_decision",
	"memory_controlled_write",
	"memory_graph_persist",
	"memory_retention",
	"summary",
	"skillify",
	"pollinating",
	"source_index",
	"document_ingest",
] as const);

export interface HybridJobQueueConfig {
	readonly enabled: boolean;
	/**
	 * Migration-only compatibility mode. When true, a worker for local-classified
	 * kinds tries the local queue first, then falls back to the shared queue so old
	 * DeepLake `memory_jobs` rows can drain. Turn this off to reach zero idle
	 * DeepLake coordination reads once migration is clear.
	 */
	readonly drainSharedLocalKinds: boolean;
	readonly localKinds: ReadonlySet<string>;
}

export interface HybridJobQueueDeps {
	readonly local: JobQueueService & { readonly persistent?: boolean };
	readonly shared: JobQueueService;
	readonly config: HybridJobQueueConfig;
}

export function resolveHybridJobQueueConfig(env: NodeJS.ProcessEnv = process.env): HybridJobQueueConfig {
	return {
		enabled: parseBooleanFlag(env[HONEYCOMB_LOCAL_QUEUE_ENABLED]),
		drainSharedLocalKinds: parseBooleanFlag(env[HONEYCOMB_LOCAL_QUEUE_DRAIN_SHARED]),
		localKinds: new Set(DEFAULT_LOCAL_JOB_KINDS),
	};
}

export function createHybridJobQueueService(deps: HybridJobQueueDeps): JobQueueService {
	if (!deps.config.enabled || deps.local.persistent === false) return deps.shared;
	return new HybridJobQueueServiceImpl(deps);
}

class HybridJobQueueServiceImpl implements JobQueueService {
	private readonly local: JobQueueService;
	private readonly shared: JobQueueService;
	private readonly config: HybridJobQueueConfig;
	private readonly localIds = new Set<string>();

	constructor(deps: HybridJobQueueDeps) {
		this.local = deps.local;
		this.shared = deps.shared;
		this.config = deps.config;
	}

	async enqueue(job: JobInput): Promise<string> {
		if (this.isLocalKind(job.kind)) {
			const id = await this.local.enqueue(job);
			this.localIds.add(id);
			return id;
		}
		return this.shared.enqueue(job);
	}

	async lease(kinds?: readonly string[]): Promise<LeasedJob | null> {
		const classified = this.classifyKinds(kinds);

		if (classified.localKinds.length > 0) {
			const local = await this.local.lease(classified.localKinds);
			if (local !== null) {
				this.localIds.add(local.id);
				return local;
			}
		}

		const sharedKinds = this.sharedLeaseKinds(classified);
		if (sharedKinds === null) return null;
		return this.shared.lease(sharedKinds);
	}

	async complete(id: string, leaseAttempt?: number): Promise<void> {
		if (this.localIds.has(id)) {
			await this.local.complete(id, leaseAttempt);
			this.localIds.delete(id);
			return;
		}
		await this.shared.complete(id);
	}

	async fail(id: string, reason: string, leaseAttempt?: number): Promise<void> {
		if (this.localIds.has(id)) {
			await this.local.fail(id, reason, leaseAttempt);
			this.localIds.delete(id);
			return;
		}
		await this.shared.fail(id, reason);
	}

	start(): void {
		// Non-drain mode deliberately leaves the shared reaper stopped: callers can
		// still lease shared work on demand, but idle local-only daemons do not resume
		// DeepLake polling just because the adapter exists.
		if (this.config.drainSharedLocalKinds) this.shared.start();
		this.local.start();
	}

	stop(): void {
		this.local.stop();
		this.shared.stop();
	}

	private isLocalKind(kind: string): boolean {
		return this.config.localKinds.has(kind);
	}

	private classifyKinds(kinds: readonly string[] | undefined): {
		readonly localKinds: readonly string[];
		readonly sharedKinds: readonly string[];
		readonly originalKinds: readonly string[] | undefined;
	} {
		if (kinds === undefined) {
			return { localKinds: [...this.config.localKinds], sharedKinds: [], originalKinds: undefined };
		}
		const localKinds: string[] = [];
		const sharedKinds: string[] = [];
		for (const kind of kinds) {
			if (this.isLocalKind(kind)) localKinds.push(kind);
			else sharedKinds.push(kind);
		}
		return { localKinds, sharedKinds, originalKinds: kinds };
	}

	private sharedLeaseKinds(classified: {
		readonly localKinds: readonly string[];
		readonly sharedKinds: readonly string[];
		readonly originalKinds: readonly string[] | undefined;
	}): readonly string[] | undefined | null {
		if (classified.originalKinds === undefined) {
			return undefined;
		}
		if (this.config.drainSharedLocalKinds) return classified.originalKinds;
		if (classified.sharedKinds.length === 0) return null;
		return classified.sharedKinds;
	}
}

function parseBooleanFlag(raw: string | undefined): boolean {
	if (raw === undefined) return false;
	const normalized = raw.trim().toLowerCase();
	return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
