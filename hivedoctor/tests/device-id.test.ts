/**
 * Tests for the shared device-id resolution (PRD-064d / PRD-033 convergence).
 *
 * `resolveDeviceId` must:
 *   - return the persisted device_id when ~/.honeycomb/device.json carries a valid one;
 *   - mint AND persist a fresh UUID (in the daemon's {device_id,label,createdAt} shape)
 *     when the file is absent or garbled;
 *   - on an unwritable dir, return the freshly-minted id WITHOUT persisting and NEVER throw.
 *
 * Every test injects fs seams (read/makeDir/write) + a fixed clock/id so nothing real is
 * touched and the assertions are deterministic. Mirrors the injected-seam style of the
 * existing telemetry tests.
 */

import { describe, expect, it } from "vitest";

import { deviceFilePath, resolveDeviceId, type ResolveDeviceIdDeps } from "../src/device-id.js";

const HOME = "/home/test";
const FIXED_ID = "11111111-2222-3333-4444-555555555555";
const FIXED_DATE = new Date("2026-01-01T00:00:00.000Z");

/** A read seam returning a fixed string body (for the "file present" cases). */
function readReturning(body: string): (path: string) => string {
	return () => body;
}

/** A read seam that always throws ENOENT (the "no file" case). */
function readThrowingMissing(): (path: string) => string {
	return () => {
		throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
	};
}

/** A write recorder: captures the path + data written, and reports whether it was called. */
function writeRecorder(): {
	deps: Pick<ResolveDeviceIdDeps, "makeDir" | "writeFile">;
	writes: Array<{ path: string; data: string }>;
	dirs: string[];
} {
	const writes: Array<{ path: string; data: string }> = [];
	const dirs: string[] = [];
	return {
		writes,
		dirs,
		deps: {
			makeDir: (p: string) => {
				dirs.push(p);
			},
			writeFile: (p: string, data: string) => {
				writes.push({ path: p, data });
			},
		},
	};
}

describe("resolveDeviceId (PRD-064d / PRD-033 convergence)", () => {
	it("returns the persisted device_id when device.json carries a valid one", () => {
		const persisted = JSON.stringify({
			device_id: "existing-uuid-aaaa",
			label: "my-host",
			createdAt: "2025-12-01T00:00:00.000Z",
		});
		const rec = writeRecorder();
		const id = resolveDeviceId({
			homeDir: HOME,
			readFile: readReturning(persisted),
			...rec.deps,
		});

		expect(id).toBe("existing-uuid-aaaa");
		// A valid existing record means NOTHING is written (we do not churn the file).
		expect(rec.writes).toHaveLength(0);
		expect(rec.dirs).toHaveLength(0);
	});

	it("mints AND persists a fresh record (daemon shape) when the file is absent", () => {
		const rec = writeRecorder();
		const id = resolveDeviceId({
			homeDir: HOME,
			readFile: readThrowingMissing(),
			clock: () => FIXED_DATE,
			label: () => "test-box",
			mintId: () => FIXED_ID,
			...rec.deps,
		});

		expect(id).toBe(FIXED_ID);
		// Persisted exactly once, to ~/.honeycomb/device.json.
		expect(rec.writes).toHaveLength(1);
		expect(rec.writes[0]?.path).toBe(deviceFilePath(HOME));

		// The on-disk shape is the daemon's exact {device_id,label,createdAt} (so the daemon
		// reads OUR file and both processes converge on one id).
		const written = JSON.parse(rec.writes[0]?.data ?? "{}") as Record<string, unknown>;
		expect(written).toEqual({
			device_id: FIXED_ID,
			label: "test-box",
			createdAt: FIXED_DATE.toISOString(),
		});
	});

	it("treats a garbled file (no device_id) as absent and mints a fresh one", () => {
		const rec = writeRecorder();
		const id = resolveDeviceId({
			homeDir: HOME,
			readFile: readReturning('{"label":"orphan","createdAt":"x"}'), // no device_id
			mintId: () => FIXED_ID,
			clock: () => FIXED_DATE,
			label: () => "h",
			...rec.deps,
		});

		expect(id).toBe(FIXED_ID);
		expect(rec.writes).toHaveLength(1);
	});

	it("treats non-JSON content as absent and mints a fresh one", () => {
		const rec = writeRecorder();
		const id = resolveDeviceId({
			homeDir: HOME,
			readFile: readReturning("not json at all {{{"),
			mintId: () => FIXED_ID,
			clock: () => FIXED_DATE,
			label: () => "h",
			...rec.deps,
		});

		expect(id).toBe(FIXED_ID);
		expect(rec.writes).toHaveLength(1);
	});

	it("on an unwritable dir, returns the freshly-minted id WITHOUT persisting and never throws", () => {
		const writeThrew: string[] = [];
		const id = resolveDeviceId({
			homeDir: HOME,
			readFile: readThrowingMissing(),
			mintId: () => FIXED_ID,
			clock: () => FIXED_DATE,
			label: () => "h",
			makeDir: () => {
				writeThrew.push("mkdir");
				throw Object.assign(new Error("EACCES"), { code: "EACCES" });
			},
			writeFile: () => {
				throw new Error("should not reach writeFile when makeDir threw");
			},
		});

		// The id is still usable for the life of the process, just not persisted.
		expect(id).toBe(FIXED_ID);
		expect(writeThrew).toEqual(["mkdir"]);
	});

	it("swallows a writeFile failure too (mkdir ok, write throws) and still returns the id", () => {
		const id = resolveDeviceId({
			homeDir: HOME,
			readFile: readThrowingMissing(),
			mintId: () => FIXED_ID,
			clock: () => FIXED_DATE,
			label: () => "h",
			makeDir: () => undefined,
			writeFile: () => {
				throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
			},
		});

		expect(id).toBe(FIXED_ID);
	});

	it("deviceFilePath resolves to ~/.honeycomb/device.json (same path as the daemon)", () => {
		expect(deviceFilePath(HOME).replace(/\\/g, "/")).toBe(`${HOME}/.honeycomb/device.json`);
	});
});
