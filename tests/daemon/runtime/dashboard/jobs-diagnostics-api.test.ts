/**
 * Job-observability endpoint suite — `GET /api/diagnostics/jobs`.
 *
 * Verification posture (mirrors the pollinate seam suite): the endpoint is mounted on a REAL daemon
 * (`createDaemon` with a `local`-mode config so the `/api/diagnostics` group's permission middleware
 * is open) and exercised in-process via `daemon.app.request(...)` — no socket, no live DeepLake. A
 * FAKE {@link JobQueueService} scripts `stats()`, so each test proves the wiring + the fail-soft
 * contract without touching the real durable queue.
 *
 * The cases prove:
 *  - the mounted read returns the queue's `{ byKind, total }` snapshot at 200 verbatim;
 *  - the FAIL-SOFT path: a `stats()` throw returns 200 with `{ byKind: [], total: 0, error:
 *    "unavailable" }` — NEVER a 500;
 *  - the attach is a no-op when the `/api/diagnostics` group is absent (unknown daemon shape).
 */

import { describe, expect, it } from "vitest";

import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import {
	type JobsDiagnosticsBody,
	mountJobsDiagnosticsApi,
} from "../../../../src/daemon/runtime/dashboard/jobs-diagnostics-api.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import type {
	JobInput,
	JobQueueService,
	JobQueueStats,
	LeasedJob,
} from "../../../../src/daemon/runtime/services/job-queue.js";

/** A resolved config for the daemon under test (local mode → open diagnostics middleware). */
function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false, ...over };
}

/** A minimal fake storage client — the jobs read never touches it (it only calls `queue.stats()`). */
const fakeStorage = { async query() { return { kind: "ok", rows: [], durationMs: 0 }; } } as never;

/**
 * A JobQueueService fake whose `stats()` either returns a scripted snapshot or throws (to drive the
 * fail-soft path). Every other method is inert — the endpoint only ever calls `stats()`.
 */
class FakeQueue implements JobQueueService {
	constructor(private readonly onStats: () => JobQueueStats) {}
	async enqueue(_job: JobInput): Promise<string> {
		return "fake-job";
	}
	async lease(_kinds?: readonly string[]): Promise<LeasedJob | null> {
		return null;
	}
	async stats(): Promise<JobQueueStats> {
		return this.onStats();
	}
	async complete(): Promise<void> {}
	async fail(): Promise<void> {}
	start(): void {}
	stop(): void {}
}

/** Mount the jobs read on a fresh local-mode daemon with the supplied queue fake. */
function daemonWithQueue(queue: JobQueueService): Daemon {
	const daemon = createDaemon({ config: cfg(), storage: fakeStorage, logger: createRequestLogger({ silent: true }) });
	mountJobsDiagnosticsApi(daemon, { queue });
	return daemon;
}

/** GET the jobs endpoint and return the parsed body + status. */
async function getJobs(daemon: Daemon): Promise<{ status: number; body: JobsDiagnosticsBody }> {
	const res = await daemon.app.request("/api/diagnostics/jobs");
	const body = (await res.json()) as JobsDiagnosticsBody;
	return { status: res.status, body };
}

describe("GET /api/diagnostics/jobs returns the queue's CURRENT-status snapshot", () => {
	it("returns the injected queue's { byKind, total } at 200", async () => {
		const snapshot: JobQueueStats = {
			byKind: [
				{ kind: "memory_extraction", queued: 400, leased: 0, done: 12, failed: 0, dead: 3, total: 415 },
				{ kind: "summary", queued: 0, leased: 1, done: 5, failed: 0, dead: 0, total: 6 },
			],
			total: 421,
		};
		const daemon = daemonWithQueue(new FakeQueue(() => snapshot));

		const { status, body } = await getJobs(daemon);

		expect(status).toBe(200);
		expect(body).toEqual({ byKind: snapshot.byKind, total: 421 });
		expect(body.error).toBeUndefined();
	});

	it("FAIL-SOFT: a stats() throw returns 200 with an empty snapshot + error:'unavailable' (never a 500)", async () => {
		const daemon = daemonWithQueue(
			new FakeQueue(() => {
				throw new Error("queue unreachable");
			}),
		);

		const { status, body } = await getJobs(daemon);

		expect(status).toBe(200);
		expect(body).toEqual({ byKind: [], total: 0, error: "unavailable" });
	});
});

describe("mountJobsDiagnosticsApi is a no-op when the /api/diagnostics group is absent", () => {
	it("does not throw when daemon.group returns undefined", () => {
		const stub = { group: () => undefined } as unknown as Daemon;
		// No group → the attach silently no-ops; a later request would 404, but the mount itself
		// must never throw (matches the sibling diagnostics mounts).
		expect(() => mountJobsDiagnosticsApi(stub, { queue: new FakeQueue(() => ({ byKind: [], total: 0 })) })).not.toThrow();
	});
});
