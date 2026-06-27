/**
 * The auto-update transaction engine (PRD-064e AC-064e.1 / .3 / .5 / .6). Every npm /
 * registry / CDN / health call runs through a fake seam -- NO test runs npm or hits the
 * network. The real install-lock runs against a temp workspace so AC-064e.6 (serialized
 * with rung 2) is proven on the SAME mutex the supervisor uses.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createInstallLock } from "../../src/install-lock.js";
import { silentLogger } from "../../src/logger.js";
import type { BlessedFetchResult } from "../../src/update/blessed-channel.js";
import { createUpdateEngine, PRIMARY_PACKAGE, type UpdateEngineDeps } from "../../src/update/update-engine.js";
import type { UpdateEmit, UpdateTelemetryEvent } from "../../src/update/update-telemetry.js";
import { createFakeRunner, type FakeRunner } from "../helpers/fake-runner.js";

const DEVICE = "device-abc";
const INSTALLED = "0.1.7";
const BLESSED = "0.1.9";

/** A blessed-channel fetch stub that returns a fixed manifest (no network). */
function blessedFetch(version: string): UpdateEngineDeps["blessedOptions"] {
	return {
		url: "https://cdn.test/blessed-version.json",
		fetch: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ version }) }),
	};
}

/** A recording update-emit seam so AC-064e.5 can assert from/to/outcome. */
function recordingEmit(): { emit: UpdateEmit; events: UpdateTelemetryEvent[] } {
	const events: UpdateTelemetryEvent[] = [];
	return {
		events,
		emit: async (event) => {
			events.push(event);
		},
	};
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hivedoctor-update-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function lock() {
	return createInstallLock({ workspaceDir: dir, logger: silentLogger });
}

/** Build an engine with sensible defaults that each test overrides as needed. */
function buildEngine(overrides: Partial<UpdateEngineDeps>): {
	deps: UpdateEngineDeps;
	runner: FakeRunner;
	events: UpdateTelemetryEvent[];
} {
	const runner = overrides.runner ? (overrides.runner as FakeRunner) : createFakeRunner();
	const rec = recordingEmit();
	const deps: UpdateEngineDeps = {
		runner,
		installLock: overrides.installLock ?? lock(),
		readLatestVersion: overrides.readLatestVersion ?? (async () => BLESSED),
		readInstalledVersion: overrides.readInstalledVersion ?? (async () => INSTALLED),
		restartDaemon: overrides.restartDaemon ?? (async () => undefined),
		verifyHealthy: overrides.verifyHealthy ?? (async () => true),
		blessedOptions: overrides.blessedOptions ?? blessedFetch(BLESSED),
		optOut: overrides.optOut ?? { autoUpdateDisabled: false },
		deviceId: overrides.deviceId ?? DEVICE,
		emit: overrides.emit ?? rec.emit,
		logger: overrides.logger ?? silentLogger,
		now: overrides.now ?? (() => 1_700_000_000_000),
		...(overrides.installTimeoutMs !== undefined ? { installTimeoutMs: overrides.installTimeoutMs } : {}),
	};
	return { deps, runner, events: rec.events };
}

describe("update transaction happy path (AC-064e.1)", () => {
	it("installs the blessed version, restarts, verifies healthy, and reports updated", async () => {
		const restartDaemon = vi.fn(async () => undefined);
		const verifyHealthy = vi.fn(async () => true);
		const { deps, runner, events } = buildEngine({ restartDaemon, verifyHealthy });

		const engine = createUpdateEngine(deps);
		const result = await engine.runUpdateTransaction();

		expect(result.status).toBe("updated");
		expect(result.fromVersion).toBe(INSTALLED);
		expect(result.toVersion).toBe(BLESSED);
		// It ran exactly `npm install -g @legioncodeinc/honeycomb@<blessed>` (AC-064e.1).
		expect(runner.calls).toEqual([{ command: "npm", args: ["install", "-g", `${PRIMARY_PACKAGE}@${BLESSED}`] }]);
		expect(restartDaemon).toHaveBeenCalledTimes(1);
		expect(verifyHealthy).toHaveBeenCalledTimes(1);
		// A single update telemetry event, from/to/outcome (AC-064e.5).
		expect(events).toEqual([
			{
				kind: "update",
				fromVersion: INSTALLED,
				toVersion: BLESSED,
				outcome: "updated",
				deviceId: DEVICE,
				timestampMs: 1_700_000_000_000,
			},
		]);
	});

	it("does not update when @latest is newer but NOT blessed (gate holds, AC-064e.2)", async () => {
		const { deps, runner } = buildEngine({
			readLatestVersion: async () => "0.2.0", // newer than blessed 0.1.9
			blessedOptions: blessedFetch(BLESSED),
		});
		const result = await createUpdateEngine(deps).runUpdateTransaction();
		expect(result.status).toBe("no_update");
		expect(result.noUpdateReason).toBe("latest_not_blessed");
		expect(runner.calls).toHaveLength(0); // npm never touched
	});

	it("fails closed (no update) when the blessed channel is unreachable (AC-064e.2)", async () => {
		const { deps, runner } = buildEngine({
			blessedOptions: {
				url: "https://cdn.test/blessed-version.json",
				fetch: async () => {
					throw new Error("ECONNREFUSED");
				},
			},
		});
		const result = await createUpdateEngine(deps).runUpdateTransaction();
		expect(result.status).toBe("no_update");
		expect(result.noUpdateReason).toBe("blessed_unavailable");
		expect(runner.calls).toHaveLength(0);
	});
});

describe("rollback on failed post-update health (AC-064e.3)", () => {
	it("reinstalls the prior version, restarts, and recovers healthy on the old version", async () => {
		// First /health (post-update) fails; second /health (post-rollback) succeeds.
		const healthSeq = [false, true];
		const verifyHealthy = vi.fn(async () => healthSeq.shift() ?? true);
		const restartDaemon = vi.fn(async () => undefined);
		const { deps, runner, events } = buildEngine({ verifyHealthy, restartDaemon });

		const result = await createUpdateEngine(deps).runUpdateTransaction();

		expect(result.status).toBe("rolled_back");
		// Two installs: the forward install to blessed, then the rollback to the prior version.
		expect(runner.calls).toEqual([
			{ command: "npm", args: ["install", "-g", `${PRIMARY_PACKAGE}@${BLESSED}`] },
			{ command: "npm", args: ["install", "-g", `${PRIMARY_PACKAGE}@${INSTALLED}`] },
		]);
		// Restart fired for both the update and the rollback; health checked twice.
		expect(restartDaemon).toHaveBeenCalledTimes(2);
		expect(verifyHealthy).toHaveBeenCalledTimes(2);
		// Both an update (the failed forward) and a rollback event were emitted (AC-064e.5).
		const kinds = events.map((e) => e.outcome);
		expect(kinds).toContain("rolled_back");
		const rollbackEvent = events.find((e) => e.kind === "rollback");
		expect(rollbackEvent).toMatchObject({ fromVersion: BLESSED, toVersion: INSTALLED, outcome: "rolled_back" });
	});

	it("reports rollback_failed when even the prior version cannot be restored", async () => {
		const verifyHealthy = vi.fn(async () => false); // never healthy
		const { deps, events } = buildEngine({ verifyHealthy });
		const result = await createUpdateEngine(deps).runUpdateTransaction();
		expect(result.status).toBe("rollback_failed");
		const rollbackEvent = events.find((e) => e.kind === "rollback");
		expect(rollbackEvent?.outcome).toBe("rollback_failed");
	});

	it("emits install_failed (and does not restart) when the forward npm install fails", async () => {
		const restartDaemon = vi.fn(async () => undefined);
		const runner = createFakeRunner(() => ({ ok: false, code: 1, stdout: "", stderr: "EACCES", detail: "EACCES" }));
		const { deps, events } = buildEngine({ runner, restartDaemon });
		const result = await createUpdateEngine(deps).runUpdateTransaction();
		expect(result.status).toBe("install_failed");
		expect(restartDaemon).not.toHaveBeenCalled();
		expect(events).toEqual([
			expect.objectContaining({ kind: "update", outcome: "install_failed", fromVersion: INSTALLED, toVersion: BLESSED }),
		]);
	});
});

describe("opt-out + pin (AC-064e.4)", () => {
	it("does not update (and never polls npm) when auto-update is disabled", async () => {
		const { deps, runner } = buildEngine({ optOut: { autoUpdateDisabled: true } });
		const result = await createUpdateEngine(deps).runUpdateTransaction();
		expect(result.status).toBe("no_update");
		expect(result.noUpdateReason).toBe("opted_out");
		expect(runner.calls).toHaveLength(0);
	});

	it("does not update when a version is pinned", async () => {
		const { deps, runner } = buildEngine({ optOut: { autoUpdateDisabled: false, pinnedVersion: INSTALLED } });
		const result = await createUpdateEngine(deps).runUpdateTransaction();
		expect(result.status).toBe("no_update");
		expect(result.noUpdateReason).toBe("pinned");
		expect(runner.calls).toHaveLength(0);
	});
});

describe("telemetry from/to/outcome (AC-064e.5)", () => {
	it("records from-version, to-version, and outcome on a successful update", async () => {
		const { deps, events } = buildEngine({});
		await createUpdateEngine(deps).runUpdateTransaction();
		expect(events).toHaveLength(1);
		const e = events[0];
		expect(e?.fromVersion).toBe(INSTALLED);
		expect(e?.toVersion).toBe(BLESSED);
		expect(e?.outcome).toBe("updated");
	});
});

describe("serialization with the watch loop's rung 2 (AC-064e.6)", () => {
	it("skips when the shared install lock is already held (no concurrent npm install)", async () => {
		const shared = lock();
		// Simulate rung 2's reinstall holding the lock when the poll tick fires.
		const held = shared.acquire("reinstall");
		expect(held).not.toBeNull();

		const { deps, runner } = buildEngine({ installLock: shared });
		const result = await createUpdateEngine(deps).runUpdateTransaction();

		expect(result.status).toBe("skipped_lock_held");
		expect(result.detail).toBe("install-lock-held");
		// Crucially, the auto-update engine did NOT run npm while rung 2 held the lock.
		expect(runner.calls).toHaveLength(0);
	});

	it("releases the lock after a successful update so rung 2 can later acquire it", async () => {
		const shared = lock();
		const { deps } = buildEngine({ installLock: shared });
		await createUpdateEngine(deps).runUpdateTransaction();
		// The auto-update transaction freed the mutex; rung 2 can now take it.
		const after = shared.acquire("reinstall");
		expect(after).not.toBeNull();
	});
});

describe("crash-safety / unknown installed version", () => {
	it("refuses to update when the installed version is unknown (no rollback target)", async () => {
		const { deps, runner } = buildEngine({ readInstalledVersion: async () => null });
		const result = await createUpdateEngine(deps).runUpdateTransaction();
		expect(result.status).toBe("no_update");
		expect(runner.calls).toHaveLength(0);
	});

	it("an unexpected throw in a seam resolves to a failed result, never a thrown error", async () => {
		const { deps } = buildEngine({
			readLatestVersion: async () => {
				throw new Error("registry exploded");
			},
		});
		const result = await createUpdateEngine(deps).runUpdateTransaction();
		expect(result.status).toBe("install_failed");
		expect(result.detail).toBe("registry exploded");
	});
});
