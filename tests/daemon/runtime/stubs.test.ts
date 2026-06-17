/**
 * PRD-004a bootstrap-seam stubs — compile + inert-behaviour proof.
 *
 * Proves the three Wave-2 stub services (job queue 004b, file watcher 004c,
 * runtime-path 004d) satisfy their interfaces and behave inertly, so the daemon
 * compiles and runs in Wave 1 and a Wave-2 Bee has a known-good baseline to swap.
 * These do NOT assert Wave-2 behaviour (that is each Bee's own test file).
 */

import { describe, expect, it } from "vitest";
import { noopRuntimePathService } from "../../../src/daemon/runtime/middleware/runtime-path.js";
import { createNoopFileWatcherService, noopFileWatcherService } from "../../../src/daemon/runtime/services/file-watcher.js";
import { noopJobQueueService } from "../../../src/daemon/runtime/services/job-queue.js";

describe("004b job-queue stub is inert and lifecycle-safe", () => {
	it("enqueue returns a synthetic id and lease yields nothing to do", async () => {
		expect(await noopJobQueueService.enqueue({ kind: "x", payload: {} })).toBe("noop-job");
		expect(await noopJobQueueService.lease()).toBeNull();
	});

	it("start/stop are no-op safe", async () => {
		await noopJobQueueService.start();
		await noopJobQueueService.stop();
	});
});

describe("004c file-watcher stub reports active across start/stop (c-AC-7 wiring)", () => {
	it("a fresh watcher is inactive until started, active after start, inactive after stop", () => {
		const w = createNoopFileWatcherService();
		expect(w.active).toBe(false);
		w.start();
		expect(w.active).toBe(true);
		w.stop();
		expect(w.active).toBe(false);
	});

	it("exports a default stub instance", () => {
		expect(noopFileWatcherService).toBeDefined();
	});
});

describe("004d runtime-path stub claims nothing and conflicts with nothing", () => {
	it("claim always succeeds and activePath is undefined (pass-through)", () => {
		expect(noopRuntimePathService.claim("s", "plugin").ok).toBe(true);
		expect(noopRuntimePathService.activePath("s")).toBeUndefined();
	});

	it("start/stop are no-op safe", async () => {
		await noopRuntimePathService.start();
		await noopRuntimePathService.stop();
	});
});
