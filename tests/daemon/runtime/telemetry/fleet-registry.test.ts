/**
 * PRD-071 Contract A — the hivedoctor static registry writer (`fleet-registry.ts`).
 *
 * Runs against a temp HOME dir — never the real `~/.honeycomb`. Covers AC-1, AC-071a.1.1,
 * AC-071a.1.2 (idempotent upsert, preserves other entries), and the pinned Contract-A shape.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	buildHoneycombRegistryEntry,
	createNodeRegistryFs,
	HONEYCOMB_REGISTRY_HEALTH_URL,
	HONEYCOMB_REGISTRY_NAME,
	HONEYCOMB_REGISTRY_PID_PATH,
	HONEYCOMB_REGISTRY_TELEMETRY_DB_PATH,
	hivedoctorRegistryPath,
	honeycombRegistryHealthUrl,
	type RegistryFs,
	registerHoneycombWithHivedoctor,
} from "../../../../src/daemon/runtime/telemetry/fleet-registry.js";

let homeDir: string;

beforeEach(() => {
	homeDir = mkdtempSync(join(tmpdir(), "hc-fleet-registry-"));
});

afterEach(() => {
	rmSync(homeDir, { recursive: true, force: true });
});

function readRegistry(path: string): { daemons: Array<Record<string, unknown>> } {
	return JSON.parse(readFileSync(path, "utf8")) as { daemons: Array<Record<string, unknown>> };
}

describe("PRD-071 Contract A: buildHoneycombRegistryEntry", () => {
	it("matches the pinned Contract-A shape exactly", () => {
		expect(buildHoneycombRegistryEntry()).toEqual({
			name: "honeycomb",
			healthUrl: "http://127.0.0.1:3850/health",
			pidPath: "~/.honeycomb/daemon.pid",
			probeIntervalMs: 30000,
			startupGraceMs: 60000,
			restartGiveUpThreshold: 3,
			restartCooldownMs: 5000,
			telemetryDbPath: "~/.honeycomb/telemetry/honeycomb.sqlite",
		});
		expect(HONEYCOMB_REGISTRY_NAME).toBe("honeycomb");
		expect(HONEYCOMB_REGISTRY_HEALTH_URL).toBe("http://127.0.0.1:3850/health");
		expect(HONEYCOMB_REGISTRY_PID_PATH).toBe("~/.honeycomb/daemon.pid");
		expect(HONEYCOMB_REGISTRY_TELEMETRY_DB_PATH).toBe("~/.honeycomb/telemetry/honeycomb.sqlite");
	});

	it("a resolved non-default bind is advertised in healthUrl (defaults apply when absent)", () => {
		expect(honeycombRegistryHealthUrl()).toBe("http://127.0.0.1:3850/health");
		expect(honeycombRegistryHealthUrl({ host: "127.0.0.1", port: 4850 })).toBe("http://127.0.0.1:4850/health");
		expect(buildHoneycombRegistryEntry({ host: "localhost", port: 4850 })).toMatchObject({
			healthUrl: "http://localhost:4850/health",
		});
	});
});

describe("PRD-071 Contract A: registerHoneycombWithHivedoctor", () => {
	it("AC-1 / AC-071a.1.1 creates the registry file with honeycomb's entry when none existed (ENOENT-tolerant)", () => {
		const result = registerHoneycombWithHivedoctor({ homeDir });
		expect(existsSync(result.registryPath)).toBe(true);
		expect(result.registryPath).toBe(hivedoctorRegistryPath(homeDir));
		expect(result.updatedExistingEntry).toBe(false);
		const doc = readRegistry(result.registryPath);
		expect(doc.daemons).toHaveLength(1);
		expect(doc.daemons[0]).toMatchObject({ name: "honeycomb" });
	});

	it("AC-071a.1.2 a re-install REPLACES the existing entry in place rather than duplicating it", () => {
		const first = registerHoneycombWithHivedoctor({ homeDir });
		expect(first.updatedExistingEntry).toBe(false);
		const second = registerHoneycombWithHivedoctor({ homeDir });
		expect(second.updatedExistingEntry).toBe(true);
		const doc = readRegistry(second.registryPath);
		expect(doc.daemons.filter((d) => d.name === "honeycomb")).toHaveLength(1);
	});

	it("preserves every OTHER daemon's entry untouched (e.g. hivedoctor's own or the-hive's)", () => {
		const path = hivedoctorRegistryPath(homeDir);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(
			path,
			JSON.stringify({
				daemons: [
					{ name: "thehive", healthUrl: "http://127.0.0.1:3853/health", pidPath: "~/.honeycomb/thehive.pid" },
					{ name: "hivedoctor", healthUrl: "http://127.0.0.1:3851/health", pidPath: "~/.honeycomb/hivedoctor.pid" },
				],
			}),
			"utf8",
		);

		registerHoneycombWithHivedoctor({ homeDir });
		const doc = readRegistry(path);
		expect(doc.daemons).toHaveLength(3);
		expect(doc.daemons.find((d) => d.name === "thehive")).toMatchObject({ healthUrl: "http://127.0.0.1:3853/health" });
		expect(doc.daemons.find((d) => d.name === "hivedoctor")).toMatchObject({
			healthUrl: "http://127.0.0.1:3851/health",
		});
		expect(doc.daemons.find((d) => d.name === "honeycomb")).toMatchObject({
			healthUrl: "http://127.0.0.1:3850/health",
		});
	});

	it("degrades a malformed pre-existing file to an empty daemon list rather than throwing", () => {
		const path = hivedoctorRegistryPath(homeDir);
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(path, "{ not valid json", "utf8");
		expect(() => registerHoneycombWithHivedoctor({ homeDir })).not.toThrow();
		const doc = readRegistry(path);
		expect(doc.daemons).toHaveLength(1);
		expect(doc.daemons[0]?.name).toBe("honeycomb");
	});

	it("the DB path convention stays stable across a re-install", () => {
		registerHoneycombWithHivedoctor({ homeDir });
		registerHoneycombWithHivedoctor({ homeDir });
		const doc = readRegistry(hivedoctorRegistryPath(homeDir));
		expect(doc.daemons[0]?.telemetryDbPath).toBe("~/.honeycomb/telemetry/honeycomb.sqlite");
	});

	it("a resolved bind threads through to the persisted entry's healthUrl", () => {
		registerHoneycombWithHivedoctor({ homeDir, bind: { host: "127.0.0.1", port: 4850 } });
		const doc = readRegistry(hivedoctorRegistryPath(homeDir));
		expect(doc.daemons[0]).toMatchObject({ name: "honeycomb", healthUrl: "http://127.0.0.1:4850/health" });
	});

	it("re-merges when a concurrent writer's rename lands between our write and our verify read", () => {
		const path = hivedoctorRegistryPath(homeDir);
		const real = createNodeRegistryFs();
		// Simulate a lost update: right AFTER our first atomic rename commits, a competitor's
		// document (read BEFORE our write, so missing our entry) lands and clobbers the file.
		let competitorWrites = 0;
		const racingFs: RegistryFs = {
			...real,
			rename(from: string, to: string): void {
				real.rename(from, to);
				if (to === path && competitorWrites === 0) {
					competitorWrites += 1;
					real.writeFile(
						path,
						`${JSON.stringify({ daemons: [{ name: "thehive", healthUrl: "http://127.0.0.1:3853/health" }] }, null, 2)}\n`,
					);
				}
			},
		};

		registerHoneycombWithHivedoctor({ homeDir, fs: racingFs });
		const doc = readRegistry(path);
		expect(doc.daemons.find((d) => d.name === "honeycomb")).toMatchObject({
			healthUrl: "http://127.0.0.1:3850/health",
		});
		expect(doc.daemons.find((d) => d.name === "thehive")).toMatchObject({
			healthUrl: "http://127.0.0.1:3853/health",
		});
	});
});
