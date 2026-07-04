/**
 * PRD-072c US-072c.3 — the device identity survives the move to the fleet root.
 *
 * `loadOrCreateDevice` reads new-first (`~/.apiary/device.json`) then legacy
 * (`~/.honeycomb/device.json`), honoring an existing legacy id (never re-minting), and mints at the
 * fleet root only when neither exists. Driven against a temp HOME.
 */

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { deviceFilePath, loadOrCreateDevice } from "../../../../src/daemon/runtime/assets/device.js";

let home: string;
const ENV = {} as NodeJS.ProcessEnv;
const PLATFORM: NodeJS.Platform = "linux";

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "hc-device-mig-"));
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("PRD-072c AC-072c.3.1 — a legacy device id is honored, never re-minted", () => {
	it("AC-072c.3.1 an existing legacy ~/.honeycomb/device.json id is returned unchanged", () => {
		mkdirSync(join(home, ".honeycomb"), { recursive: true });
		writeFileSync(
			join(home, ".honeycomb", "device.json"),
			JSON.stringify({ device_id: "dev-legacy-42", label: "box", createdAt: "t" }),
		);
		const rec = loadOrCreateDevice({ homeDir: home, env: ENV, platform: PLATFORM, mintId: () => "SHOULD-NOT-MINT" });
		expect(rec.device_id).toBe("dev-legacy-42");
	});
});

describe("PRD-072c AC-072c.3.2 — a fresh device id is minted at the fleet root only", () => {
	it("AC-072c.3.2 with neither path present, the record is minted at ~/.apiary/device.json", () => {
		const rec = loadOrCreateDevice({ homeDir: home, env: ENV, platform: PLATFORM, mintId: () => "dev-new-1" });
		expect(rec.device_id).toBe("dev-new-1");
		expect(existsSync(deviceFilePath({ home, env: ENV, platform: PLATFORM }))).toBe(true);
		expect(deviceFilePath({ home, env: ENV, platform: PLATFORM })).toBe(join(home, ".apiary", "device.json"));
		// Not written to the legacy path.
		expect(existsSync(join(home, ".honeycomb", "device.json"))).toBe(false);
	});

	it("the new fleet-root record wins over a legacy one when both exist", () => {
		mkdirSync(join(home, ".honeycomb"), { recursive: true });
		writeFileSync(
			join(home, ".honeycomb", "device.json"),
			JSON.stringify({ device_id: "dev-legacy", label: "l", createdAt: "t" }),
		);
		mkdirSync(join(home, ".apiary"), { recursive: true });
		writeFileSync(
			join(home, ".apiary", "device.json"),
			JSON.stringify({ device_id: "dev-new", label: "l", createdAt: "t" }),
		);
		const rec = loadOrCreateDevice({ homeDir: home, env: ENV, platform: PLATFORM });
		expect(rec.device_id).toBe("dev-new");
	});
});
