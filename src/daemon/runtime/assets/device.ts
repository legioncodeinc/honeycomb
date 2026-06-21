/**
 * PRD-033a — Stable device identity (FR-3 / a-AC-4 / D-1).
 *
 * A `Device`-tier artifact syncs to the SAME user's OTHER devices and nobody
 * else's. That needs a stable per-machine identity:
 *
 *   - `device_id`: a generated UUIDv4 persisted at `~/.honeycomb/device.json`
 *     (`{device_id, label, createdAt}`), stable per machine, sitting BESIDE the
 *     existing `~/.honeycomb/.machine-key` (D-1). It is DELIBERATELY a generated
 *     UUID, NOT the raw OS machine-id — for privacy (the OS machine-id is a
 *     cross-application fingerprint) and stability (the OS id can change under a
 *     reimage / VM clone while our file persists).
 *
 *   - the "my devices" set: a per-AUTHOR set of `device_id`s. A `Device`-tier
 *     pull is keyed by author identity + this set, so a row addressed to the
 *     author's devices lands on every one of them and on no other user's machine
 *     (a-AC-4).
 *
 * Pure + local (D-6): this module reads/writes ONLY `~/.honeycomb/device.json`
 * under an INJECTABLE home dir (so a test points it at a temp dir). It opens no
 * DeepLake and no network. The daemon later threads the resolved `device_id`
 * into the `AssetScope` that crosses to storage.
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, hostname } from "node:os";
import { dirname, join } from "node:path";

/** The on-disk device record (D-1). `{device_id, label, createdAt}`. */
export interface DeviceRecord {
	/** The stable per-machine UUIDv4 (generated once, then persisted). */
	readonly device_id: string;
	/** A human label (defaults to the OS hostname) so a device list reads clearly. */
	readonly label: string;
	/** ISO timestamp the record was first generated. */
	readonly createdAt: string;
}

/** The `~/.honeycomb` root (mirrors `machineKeyFilePath`'s parent). Home is injectable. */
export function honeycombHomeDir(homeDir: string = homedir()): string {
	return join(homeDir, ".honeycomb");
}

/** Where the device record lives — `~/.honeycomb/device.json`, BESIDE `.machine-key` (D-1). */
export function deviceFilePath(homeDir: string = homedir()): string {
	return join(honeycombHomeDir(homeDir), "device.json");
}

/** A clock seam so a test pins `createdAt` deterministically. */
export type DeviceClock = () => Date;

/** Options for {@link loadOrCreateDevice} — all injectable for deterministic tests. */
export interface DeviceStoreOptions {
	/** The home dir the record is rooted under (default real `~`). */
	readonly homeDir?: string;
	/** The clock for `createdAt` (default real `Date`). */
	readonly clock?: DeviceClock;
	/** The label generator (default the OS hostname). */
	readonly label?: () => string;
	/** The id generator (default `randomUUID`) — injectable so a test pins the id. */
	readonly mintId?: () => string;
}

/**
 * Load the persisted {@link DeviceRecord}, GENERATING + persisting one on first
 * run (a-AC-4 / D-1). Stable thereafter: subsequent calls read the same file and
 * return the same `device_id`. A garbled/partial file is repaired in place (a
 * missing/invalid `device_id` mints a fresh record) rather than throwing — the
 * device identity must never be the thing that takes the daemon down.
 *
 * Generate-once semantics mirror the `.machine-key` fallback that lives beside it.
 */
export function loadOrCreateDevice(options: DeviceStoreOptions = {}): DeviceRecord {
	const homeDir = options.homeDir ?? homedir();
	const clock = options.clock ?? (() => new Date());
	const label = options.label ?? (() => hostname());
	const mintId = options.mintId ?? (() => randomUUID());
	const filePath = deviceFilePath(homeDir);

	const existing = readDeviceRecord(filePath);
	if (existing !== null) return existing;

	const record: DeviceRecord = {
		device_id: mintId(),
		label: label(),
		createdAt: clock().toISOString(),
	};
	mkdirSync(dirname(filePath), { recursive: true });
	writeFileSync(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf-8");
	return record;
}

/** Read + validate the on-disk record, or `null` when absent/garbled. Never throws. */
function readDeviceRecord(filePath: string): DeviceRecord | null {
	try {
		const parsed = JSON.parse(readFileSync(filePath, "utf-8")) as unknown;
		if (typeof parsed !== "object" || parsed === null) return null;
		const r = parsed as Record<string, unknown>;
		if (typeof r.device_id !== "string" || r.device_id === "") return null;
		return {
			device_id: r.device_id,
			label: typeof r.label === "string" ? r.label : "",
			createdAt: typeof r.createdAt === "string" ? r.createdAt : "",
		};
	} catch {
		return null;
	}
}

// ── "My devices" set (per-author, a-AC-4) ────────────────────────────────────

/**
 * Add this machine's `device_id` to the author's "my devices" set and return the
 * resulting set (a-AC-4). The set is keyed by AUTHOR (a `Device`-tier audience is
 * author identity + device set), deduplicated, and order-stable. This is the pure
 * set operation the daemon uses to assemble the `deviceSet` a `Device`-tier
 * publish addresses; the durable set itself lives in the registry / `synced_assets`
 * `device_set` column (the daemon's job, 033b/033c).
 *
 * The returned set ALWAYS contains `deviceId` — registering "my device" is the
 * point — and never duplicates an already-present id.
 */
export function addDeviceToSet(existing: readonly string[], deviceId: string): readonly string[] {
	if (deviceId === "") return [...existing];
	if (existing.includes(deviceId)) return [...existing];
	return [...existing, deviceId];
}

/** True when `deviceId` is in the author's device set (the Device-audience membership test). */
export function deviceInSet(set: readonly string[], deviceId: string): boolean {
	return deviceId !== "" && set.includes(deviceId);
}
