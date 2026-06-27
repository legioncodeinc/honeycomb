/**
 * Incident-tail tests (PRD-064f `logs`): tail the last N NDJSON lines; a missing file
 * is an empty list, never a throw.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createIncidentsTail } from "../../src/cli/incidents-tail.js";

describe("createIncidentsTail", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "hivedoctor-logs-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("returns an empty list when no incident file exists", async () => {
		expect(await createIncidentsTail(dir)(20)).toEqual([]);
	});

	it("returns the last N lines", async () => {
		const lines = Array.from({ length: 5 }, (_, i) => `{"id":${i}}`).join("\n");
		writeFileSync(join(dir, "incidents.ndjson"), `${lines}\n`, "utf8");
		const tail = createIncidentsTail(dir);
		expect(await tail(2)).toEqual(['{"id":3}', '{"id":4}']);
	});

	it("ignores blank lines", async () => {
		writeFileSync(join(dir, "incidents.ndjson"), '{"id":1}\n\n{"id":2}\n', "utf8");
		expect(await createIncidentsTail(dir)(10)).toEqual(['{"id":1}', '{"id":2}']);
	});

	it("falls back to a sane limit for a non-positive request", async () => {
		writeFileSync(join(dir, "incidents.ndjson"), '{"id":1}\n', "utf8");
		expect(await createIncidentsTail(dir)(0)).toEqual(['{"id":1}']);
	});
});
