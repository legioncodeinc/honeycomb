/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

/**
 * PRD-003a a-AC-1 (health half) + a-AC-2 — the deferring daemon serves 503 degraded while storage is
 * unreachable (pre-login) and transitions to healthy on /health WITHOUT a restart once storage
 * becomes reachable (the fleet case: Hive-side login writes the shared credential and the next
 * background `SELECT 1` probe succeeds).
 *
 * This VERIFIES the existing 15s cached-health probe (`assemble.ts` refreshHealth/armHealthProbe)
 * delivers no-restart recovery, rather than rebuilding it: a mutable fake storage flips from an
 * unreachable result to `ok`, the probe interval is shortened, and /health is polled from 503 to 200
 * across the SAME running daemon (never a shutdown/start).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assembleDaemon } from "../../../src/daemon/runtime/assemble.js";
import type { RuntimeConfig } from "../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../src/daemon/runtime/logger.js";
import { noopEmbedSupervisor } from "../../../src/daemon/runtime/services/embed-supervisor.js";
import type { StorageClient } from "../../../src/daemon/storage/client.js";
import type { QueryResult } from "../../../src/daemon/storage/result.js";

const OK_RESULT: QueryResult = { kind: "ok", rows: [{ "?column?": 1 }], durationMs: 1 };
const ERR_RESULT: QueryResult = { kind: "connection_error", message: "storage unreachable (pre-login)" };

function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false, ...over };
}

/** A fake storage whose `SELECT 1` result is mutable, so we can flip degraded → ok mid-run. */
function mutableStorage(): { storage: StorageClient; setResult: (r: QueryResult) => void } {
	let result: QueryResult = ERR_RESULT;
	const storage = {
		get endpoint() {
			return "https://example.invalid";
		},
		async connect() {
			return result;
		},
		async query() {
			return result;
		},
	} as unknown as StorageClient;
	return {
		storage,
		setResult: (r: QueryResult): void => {
			result = r;
		},
	};
}

/** Poll /health until it returns `status`, or the budget is spent. */
async function waitForHealthStatus(
	request: (path: string) => Promise<Response>,
	status: number,
	budgetMs = 2000,
): Promise<number> {
	const deadline = Date.now() + budgetMs;
	let last = 0;
	while (Date.now() < deadline) {
		const res = await request("/health");
		last = res.status;
		if (res.status === status) return status;
		await new Promise((r) => setTimeout(r, 15));
	}
	return last;
}

let runtimeDir: string;
beforeEach(() => {
	runtimeDir = mkdtempSync(join(tmpdir(), "hc-fleet-health-"));
	// The 503-degraded ↔ 200-healthy transition is driven by the live storage probe, which runs only
	// on the shared-queue path (in local-queue mode the probe is off per PRD-066's zero-idle-reads
	// boundary). Pin to the shared queue so the default-on local queue does not silence the probe.
	vi.stubEnv("HONEYCOMB_LOCAL_QUEUE_ENABLED", "false");
});
afterEach(() => {
	rmSync(runtimeDir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

describe("PRD-003a a-AC-2 — fleet defer: 503 degraded → healthy on /health with no restart", () => {
	it("a-AC-1/a-AC-2 serves 503 while storage is unreachable, then 200 once it recovers (same daemon)", async () => {
		const { storage, setResult } = mutableStorage();
		const assembled = assembleDaemon({
			config: cfg(),
			storage,
			logger: createRequestLogger({ silent: true }),
			runtimeDir,
			embedSupervisor: noopEmbedSupervisor,
			// Shorten the cached-health refresh so the recovery lands within the test budget.
			healthProbeIntervalMs: 25,
			// This test exercises the degraded → ok RECOVERY transition, not the FIX 2 debounce. Pin the
			// degrade threshold to 1 so the single pre-login boot probe deterministically reports 503;
			// the 2-consecutive-failure tolerance is proven in assemble.test.ts + the health tracker suite.
			healthDegradeAfter: 1,
		});
		await assembled.start();
		try {
			// Pre-login posture: storage unreachable → /health is 503 degraded (a-AC-1 health half).
			const before = await assembled.daemon.app.request("/health");
			expect(before.status).toBe(503);
			expect((await before.json()).status).toBe("degraded");

			// Hive-side login writes the shared credential → the next background SELECT 1 succeeds.
			setResult(OK_RESULT);

			// a-AC-2: the SAME running daemon flips to healthy on /health, with NO restart.
			const recovered = await waitForHealthStatus((p) => assembled.daemon.app.request(p), 200);
			expect(recovered).toBe(200);
			const after = await assembled.daemon.app.request("/health");
			expect((await after.json()).status).toBe("ok");
		} finally {
			await assembled.shutdown();
		}
	});
});
