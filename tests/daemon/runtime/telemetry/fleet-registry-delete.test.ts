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
 * PRD-003b b-AC-3 — `unregisterHoneycombFromDoctor` deletes honeycomb's registry entry by name,
 * leaving every other daemon's entry and every unknown top-level key intact.
 *
 * Driven against a temp HOME (registry files live under it) so no real `~/.apiary` /
 * `~/.honeycomb` is touched. Proves the delete-by-name, the preserve-others invariant, that the
 * write is byte-clean (still parses as `{ daemons: [...] }`), and that a missing / entry-less file
 * is a friendly no-op.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	fleetRegistryPath,
	legacyRegistryPath,
	registerHoneycombWithDoctor,
	unregisterHoneycombFromDoctor,
} from "../../../../src/daemon/runtime/telemetry/fleet-registry.js";

let home: string;

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "hc-registry-del-"));
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

/** Seed the fleet-root registry.json with the given daemons + optional extra top-level keys. */
function seedFleetRegistry(daemons: Array<Record<string, unknown>>, extra: Record<string, unknown> = {}): string {
	const path = fleetRegistryPath({ home });
	mkdirSync(join(home, ".apiary"), { recursive: true });
	writeFileSync(path, `${JSON.stringify({ ...extra, daemons }, null, 2)}\n`);
	return path;
}

function readDaemons(path: string): Array<Record<string, unknown>> {
	return (JSON.parse(readFileSync(path, "utf8")) as { daemons: Array<Record<string, unknown>> }).daemons;
}

describe("PRD-003b b-AC-3 — unregisterHoneycombFromDoctor deletes honeycomb, keeps the rest", () => {
	it("b-AC-3 removes the honeycomb entry and leaves every other daemon entry intact", () => {
		const path = seedFleetRegistry([
			{ name: "hive", healthUrl: "http://127.0.0.1:3853/health" },
			{ name: "honeycomb", healthUrl: "http://127.0.0.1:3850/health" },
			{ name: "nectar", healthUrl: "http://127.0.0.1:3852/health" },
		]);
		const result = unregisterHoneycombFromDoctor({ homeDir: home });
		expect(result.removed).toBe(true);
		expect(result.registryPaths).toContain(path);
		const daemons = readDaemons(path);
		expect(daemons.map((d) => d.name)).toEqual(["hive", "nectar"]);
	});

	it("b-AC-3 preserves unknown top-level keys (only the daemons array is rewritten)", () => {
		const path = seedFleetRegistry([{ name: "honeycomb" }, { name: "hive" }], { schemaVersion: 2, note: "keep me" });
		unregisterHoneycombFromDoctor({ homeDir: home });
		const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		expect(doc.schemaVersion).toBe(2);
		expect(doc.note).toBe("keep me");
		expect((doc.daemons as Array<{ name: string }>).map((d) => d.name)).toEqual(["hive"]);
	});

	it("b-AC-3 a full register→unregister round-trip leaves NO honeycomb entry (idempotent delete)", () => {
		// Use the real writer so the entry shape is production-accurate. It picks the fleet-root file
		// when `~/.apiary` exists, else the legacy file — read back the path it actually wrote.
		const { registryPath: path } = registerHoneycombWithDoctor({ homeDir: home });
		expect(readDaemons(path).some((d) => d.name === "honeycomb")).toBe(true);
		const first = unregisterHoneycombFromDoctor({ homeDir: home });
		expect(first.removed).toBe(true);
		expect(readDaemons(path).some((d) => d.name === "honeycomb")).toBe(false);
		// A second delete is a friendly no-op (nothing left to remove).
		const second = unregisterHoneycombFromDoctor({ homeDir: home });
		expect(second.removed).toBe(false);
	});

	it("b-AC-3 removes the entry from the LEGACY doctor.daemons.json when it lives there", () => {
		const legacy = legacyRegistryPath(home);
		mkdirSync(join(home, ".honeycomb"), { recursive: true });
		writeFileSync(legacy, `${JSON.stringify({ daemons: [{ name: "honeycomb" }, { name: "doctor" }] }, null, 2)}\n`);
		const result = unregisterHoneycombFromDoctor({ homeDir: home });
		expect(result.removed).toBe(true);
		expect(readDaemons(legacy).map((d) => d.name)).toEqual(["doctor"]);
	});

	it("b-AC-3 a missing registry (nothing installed) is a friendly no-op, never a throw or a created file", () => {
		const result = unregisterHoneycombFromDoctor({ homeDir: home });
		expect(result.removed).toBe(false);
		expect(result.registryPaths).toEqual([]);
	});
});
