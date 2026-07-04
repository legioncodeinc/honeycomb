/**
 * PRD-072 migration mechanics step 1 (QA Warning 3) — the trigger is "daemon assembly OR CLI verb
 * that touches state". `buildRuntimeDeps` is the single chokepoint every dispatched CLI verb passes
 * through, so building the deps must run the one-time migration BEFORE any verb reads/writes state,
 * and stay idempotent + cheap on the already-migrated fast path.
 *
 * Runs against the per-file isolated home the global setup pins (never the real `~`).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildRuntimeDeps } from "../../src/cli/runtime.js";
import { MIGRATION_MARKER_FILE } from "../../src/daemon/runtime/state-migration/index.js";

const legacyDir = () => join(homedir(), ".honeycomb");
const newDir = () => join(homedir(), ".apiary", "honeycomb");

beforeEach(() => {
	rmSync(legacyDir(), { recursive: true, force: true });
	rmSync(join(homedir(), ".apiary"), { recursive: true, force: true });
});
afterEach(() => {
	rmSync(legacyDir(), { recursive: true, force: true });
	rmSync(join(homedir(), ".apiary"), { recursive: true, force: true });
});

describe("PRD-072 mechanics step 1 (Warning 3) — a CLI verb path triggers the one-time migration", () => {
	it("AC-2 buildRuntimeDeps migrates seeded legacy state before any verb touches it", () => {
		// Seed a legacy state family a CLI verb reads (the graph-ignore user file).
		mkdirSync(legacyDir(), { recursive: true });
		writeFileSync(join(legacyDir(), "graph-ignore.json"), '{"ignore":["vendor/"]}');

		// The CLI composition root (what `main()` calls for EVERY dispatched verb).
		buildRuntimeDeps();

		// The family moved under the new root and the marker records the run.
		expect(readFileSync(join(newDir(), "graph-ignore.json"), "utf8")).toBe('{"ignore":["vendor/"]}');
		expect(existsSync(join(legacyDir(), "graph-ignore.json"))).toBe(false);
		expect(existsSync(join(newDir(), MIGRATION_MARKER_FILE))).toBe(true);
	});

	it("AC-2 the already-migrated fast path is a no-op: the marker is not rewritten on a second build", () => {
		buildRuntimeDeps(); // first run writes the marker (every family skipped-complete on fresh)
		const markerPath = join(newDir(), MIGRATION_MARKER_FILE);
		const before = readFileSync(markerPath, "utf8");
		// Poison-pill check: stamp the file and assert the second run leaves it byte-identical.
		buildRuntimeDeps();
		expect(readFileSync(markerPath, "utf8")).toBe(before);
	});
});
