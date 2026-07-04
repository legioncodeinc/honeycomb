/**
 * PRD-072b US-072b.1 + PRD-072 index AC-1/AC-2/AC-3/AC-7/AC-9/AC-10 — the per-family movers driven
 * end-to-end by `runHoneycombStateMigration` against a temp HOME with a seeded legacy `~/.honeycomb`.
 *
 * Proves: every family lands at the new `~/.apiary/honeycomb/` path with identical content (device at
 * the fleet root); the machine key is byte-preserved and a pre-migration secret still decrypts; the
 * regenerable graph cache is NOT copied; `~/.deeplake/` is untouched; a second run is a no-op; a
 * blocked destination leaves the legacy file intact (additive, never destructive); and honeycomb
 * writes only inside its own subdir + the fleet-root device file.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { decrypt, deriveKey, encrypt } from "../../../../src/daemon/runtime/secrets/crypto.js";
import { buildStateFamilyMovers } from "../../../../src/daemon/runtime/state-migration/families.js";
import { runHoneycombStateMigration } from "../../../../src/daemon/runtime/state-migration/index.js";
import { runStateMigration } from "../../../../src/daemon/runtime/state-migration/migrate.js";

let home: string;
const ENV = {} as NodeJS.ProcessEnv;
const PLATFORM: NodeJS.Platform = "linux";

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "hc-families-"));
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

function legacy(...segs: string[]): string {
	return join(home, ".honeycomb", ...segs);
}
function apiary(...segs: string[]): string {
	return join(home, ".apiary", ...segs);
}
function newHc(...segs: string[]): string {
	return join(home, ".apiary", "honeycomb", ...segs);
}
function write(path: string, content: string): void {
	mkdirSync(join(path, ".."), { recursive: true });
	writeFileSync(path, content);
}

/** Seed a populated legacy `~/.honeycomb` layout across every migrated family. */
function seedLegacyLayout(): void {
	write(legacy("registry.json"), '[{"honeycombId":"skill--ada"}]');
	write(legacy("telemetry", "honeycomb.sqlite"), "SQLITE-BYTES");
	write(legacy("state", "skillify", "config.json"), '{"scope":"team"}');
	write(legacy("graph-ignore.json"), '{"ignore":["vendor/"]}');
	write(legacy("notifications-state.json"), '{"seen":{"welcome":{}}}');
	write(legacy("device.json"), '{"device_id":"dev-legacy","label":"box","createdAt":"t"}');
	// Regenerable graph cache: seeded to prove it is NOT migrated.
	write(legacy("graphs", "repo", "snapshots", "s.json"), "{}");
}

describe("PRD-072 AC-1 — a fresh install creates nothing under ~/.honeycomb via migration", () => {
	it("AC-1 with no legacy state, every family is skipped and no ~/.honeycomb file is created", () => {
		const report = runHoneycombStateMigration({ home, env: ENV, platform: PLATFORM });
		for (const outcome of Object.values(report.outcomes)) expect(outcome).toBe("skipped");
		// Only the marker exists under the new root; the legacy dir was never populated.
		expect(existsSync(legacy("registry.json"))).toBe(false);
		expect(existsSync(legacy("device.json"))).toBe(false);
	});
});

describe("PRD-072b AC-072b.1.1 / AC-2 — every family migrates once to the new root, then no-op", () => {
	it("AC-072b.1.1 each family is readable at the new path with identical content", () => {
		seedLegacyLayout();
		runHoneycombStateMigration({ home, env: ENV, platform: PLATFORM });

		expect(readFileSync(newHc("registry.json"), "utf8")).toBe('[{"honeycombId":"skill--ada"}]');
		expect(readFileSync(newHc("telemetry", "honeycomb.sqlite"), "utf8")).toBe("SQLITE-BYTES");
		expect(readFileSync(newHc("state", "skillify", "config.json"), "utf8")).toBe('{"scope":"team"}');
		expect(readFileSync(newHc("graph-ignore.json"), "utf8")).toBe('{"ignore":["vendor/"]}');
		expect(readFileSync(newHc("notifications-state.json"), "utf8")).toBe('{"seen":{"welcome":{}}}');
		// device.json lands at the FLEET ROOT, not the honeycomb subdir (AC-072c.3.1 / AC-9).
		expect(readFileSync(apiary("device.json"), "utf8")).toContain("dev-legacy");
		expect(existsSync(newHc("device.json"))).toBe(false);
	});

	it("AC-2 the migrated legacy files are removed and a second run is a pure no-op (idempotent)", () => {
		seedLegacyLayout();
		runHoneycombStateMigration({ home, env: ENV, platform: PLATFORM });
		// Migrated legacy files are gone (moved, not copied).
		expect(existsSync(legacy("registry.json"))).toBe(false);
		expect(existsSync(legacy("device.json"))).toBe(false);

		const second = runHoneycombStateMigration({ home, env: ENV, platform: PLATFORM });
		for (const outcome of Object.values(second.outcomes)) expect(outcome).toBe("already");
	});

	it("the regenerable graph CACHE is NOT copied (rebuilt lazily); its legacy copy is left intact", () => {
		seedLegacyLayout();
		runHoneycombStateMigration({ home, env: ENV, platform: PLATFORM });
		expect(existsSync(newHc("graphs", "repo", "snapshots", "s.json"))).toBe(false);
		expect(existsSync(legacy("graphs", "repo", "snapshots", "s.json"))).toBe(true);
	});
});

describe("PRD-072 AC-9 — honeycomb writes only inside its own subdir + the fleet-root device file", () => {
	it("AC-9 no other product subdirectory is created under the fleet root", () => {
		seedLegacyLayout();
		runHoneycombStateMigration({ home, env: ENV, platform: PLATFORM });
		expect(existsSync(apiary("nectar"))).toBe(false);
		expect(existsSync(apiary("doctor"))).toBe(false);
		expect(existsSync(apiary("hive"))).toBe(false);
	});
});

describe("PRD-072 AC-10 — ~/.deeplake/ is never touched by the migration", () => {
	it("AC-10 a seeded ~/.deeplake/credentials.json survives the migration untouched", () => {
		write(join(home, ".deeplake", "credentials.json"), '{"token":"keep-me"}');
		seedLegacyLayout();
		runHoneycombStateMigration({ home, env: ENV, platform: PLATFORM });
		expect(readFileSync(join(home, ".deeplake", "credentials.json"), "utf8")).toBe('{"token":"keep-me"}');
	});
});

describe("PRD-072b AC-072b.1.2 / index AC-3 — additive, never destructive on a mover failure", () => {
	it("AC-3 a blocked destination leaves the legacy file intact and reports failed", () => {
		// Drive the movers directly with a honeycombDir whose parent is a FILE, so mkdir/rename fails.
		const blocker = join(home, "blocker");
		writeFileSync(blocker, ""); // a file where a directory is needed
		write(legacy("registry.json"), "LEGACY-CONTENT");
		const movers = buildStateFamilyMovers({
			honeycombDir: join(blocker, "honeycomb"), // parent is a file → every move fails
			legacyDir: join(home, ".honeycomb"),
			fleetRoot: join(blocker, "root"),
		});
		const report = runStateMigration({ stateDir: mkdtempSync(join(tmpdir(), "hc-marker-")), movers });
		expect(report.outcomes["asset-registry"]).toBe("failed");
		// The legacy file is untouched (never deleted when the move did not land).
		expect(readFileSync(legacy("registry.json"), "utf8")).toBe("LEGACY-CONTENT");
	});
});

describe("PRD-072 AC-7 / PRD-072b AC-072b.1.3 — machine key byte-preserved; secret still decrypts", () => {
	it("AC-7 the migrated .machine-key is byte-identical and a pre-migration secret decrypts", () => {
		const keyHex = "a".repeat(64); // 32 bytes as hex
		write(legacy(".machine-key"), keyHex);
		const scope = { org: "o", workspace: "w" };
		// Encrypt BEFORE migration, using the key the way the store derives it (`file:<hex>`). The
		// plaintext deliberately does NOT resemble a provider key prefix so secret scanners never
		// flag this fixture as a leaked credential.
		const record = encrypt("not-a-real-secret-123", deriveKey(`file:${keyHex}`, scope));

		runHoneycombStateMigration({ home, env: ENV, platform: PLATFORM });

		// Byte identity: the new key file equals the legacy bytes exactly (never re-minted).
		expect(readFileSync(newHc(".machine-key"), "utf8")).toBe(keyHex);
		expect(existsSync(legacy(".machine-key"))).toBe(false);

		// The secret encrypted pre-migration decrypts with the migrated key bytes.
		const migratedHex = readFileSync(newHc(".machine-key"), "utf8").trim();
		const result = decrypt(record, deriveKey(`file:${migratedHex}`, scope));
		expect(result).toEqual({ ok: true, value: "not-a-real-secret-123" });
	});
});
