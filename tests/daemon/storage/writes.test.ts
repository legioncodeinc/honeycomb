/**
 * PRD-002d Write Patterns — proves d-AC-1..7.
 *
 * Asserts the EMITTED SQL via `fake.requests` (version N+1 append, ORDER BY
 * version DESC, append-supersede, sessions single-row append, escaping applied)
 * and heal-on-missing-column via the Responder. Each AC has a named test.
 */

import { describe, expect, it } from "vitest";
import {
	FIXTURE_CODEBASE_COLUMNS,
	FIXTURE_MEMORY_COLUMNS,
	FIXTURE_SESSIONS_COLUMNS,
	FIXTURE_SKILLS_COLUMNS,
} from "../../../src/daemon/storage/examples/fixture-tables.js";
import type { HealTarget } from "../../../src/daemon/storage/heal.js";
import { createStorageClient } from "../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../src/daemon/storage/transport.js";
import { TransportError } from "../../../src/daemon/storage/transport.js";
import {
	appendOnlyInsert,
	appendVersionBumped,
	readAppendOrdered,
	readLatestVersion,
	selectBeforeInsert,
	updateOrInsertByKey,
	val,
} from "../../../src/daemon/storage/writes.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../helpers/fake-deeplake.js";

const SCOPE = { org: "o1", workspace: "ws1" } as const;

const SESSIONS: HealTarget = { table: "sessions", columns: FIXTURE_SESSIONS_COLUMNS };
const SKILLS: HealTarget = { table: "skills", columns: FIXTURE_SKILLS_COLUMNS };
const MEMORY: HealTarget = { table: "memory", columns: FIXTURE_MEMORY_COLUMNS };
const CODEBASE: HealTarget = { table: "codebase", columns: FIXTURE_CODEBASE_COLUMNS };

function clientWith(responder?: (req: TransportRequest) => unknown) {
	const fake = new FakeDeepLakeTransport(responder as never);
	const client = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	return { client, fake };
}

describe("PRD-002d write patterns", () => {
	it("d-AC-1 version-bumped INSERTs N+1; reader takes ORDER BY version DESC LIMIT 1", async () => {
		const { client, fake } = clientWith((req) => {
			if (/SELECT version FROM "skills"/.test(req.sql)) return [{ version: 4 }]; // current max
			return [];
		});
		const { version, result } = await appendVersionBumped(client, SKILLS, SCOPE, {
			keyColumn: "skill_id",
			keyValue: "s1",
			row: [
				["id", val.str("row-1")],
				["skill_id", val.str("s1")],
				["body", val.text("hello")],
				["status", val.str("active")],
				["created_at", val.str("2026-06-17")],
			],
		});
		expect(result.kind).toBe("ok");
		expect(version).toBe(5); // 4 + 1
		const insert = fake.requests.find((r) => /^INSERT INTO "skills"/.test(r.sql));
		expect(insert?.sql).toMatch(/version\)/); // version column present in the INSERT
		expect(insert?.sql).toMatch(/, 5\)/); // bumped value inlined
		// The read convention.
		await readLatestVersion(client, SKILLS, SCOPE, "skill_id", "s1");
		const read = fake.requests.find((r) => /SELECT \* FROM "skills"/.test(r.sql));
		expect(read?.sql).toMatch(/ORDER BY version DESC LIMIT 1/);
	});

	it("d-AC-2 SELECT-before-INSERT re-verifies after insert so a race is observable", async () => {
		let probeCalls = 0;
		const { client, fake } = clientWith((req) => {
			// The primitive SELECTs the KEY column (commit_sha), not id.
			if (/SELECT commit_sha FROM "codebase".*LIMIT 1/.test(req.sql)) {
				probeCalls++;
				return []; // absent on the pre-insert probe
			}
			if (/^INSERT INTO "codebase"/.test(req.sql)) return [];
			// The post-insert re-verification (no LIMIT 1): a race doubled the row.
			if (/SELECT commit_sha FROM "codebase"/.test(req.sql)) return [{ commit_sha: "a" }, { commit_sha: "b" }];
			return [];
		});
		const out = await selectBeforeInsert(client, CODEBASE, SCOPE, {
			keyColumn: "commit_sha",
			keyValue: "abc123",
			row: [
				["id", val.str("a")],
				["commit_sha", val.str("abc123")],
				["snapshot_jsonb", val.text("{}")],
				["created_at", val.str("2026-06-17")],
			],
		});
		expect(out.alreadyPresent).toBe(false);
		expect(out.raceDetected).toBe(true); // observable, not silent
		// A pre-insert probe AND a post-insert re-verification both ran.
		expect(probeCalls).toBe(1);
		expect(fake.requests.filter((r) => /SELECT commit_sha FROM "codebase"/.test(r.sql)).length).toBe(2);
	});

	it("d-AC-3 two rapid version-bumped edits both persist; highest reads as current", async () => {
		// Simulate a monotonically advancing MAX(version) across two edits.
		let currentMax = 1;
		const { client, fake } = clientWith((req) => {
			if (/SELECT version FROM "skills"/.test(req.sql)) return [{ version: currentMax }];
			if (/^INSERT INTO "skills"/.test(req.sql)) {
				currentMax++; // the appended row advances the max
				return [];
			}
			return [];
		});
		const first = await appendVersionBumped(client, SKILLS, SCOPE, {
			keyColumn: "skill_id",
			keyValue: "s1",
			row: [
				["id", val.str("r1")],
				["skill_id", val.str("s1")],
				["body", val.text("a")],
			],
		});
		const second = await appendVersionBumped(client, SKILLS, SCOPE, {
			keyColumn: "skill_id",
			keyValue: "s1",
			row: [
				["id", val.str("r2")],
				["skill_id", val.str("s1")],
				["body", val.text("b")],
			],
		});
		expect(first.version).toBe(2);
		expect(second.version).toBe(3); // both persisted; highest is current
		expect(fake.requests.filter((r) => /^INSERT INTO "skills"/.test(r.sql)).length).toBe(2);
	});

	it("d-AC-4 sessions write appends one row, never concatenates; read orders by creation_date", async () => {
		const { client, fake } = clientWith(() => []);
		await appendOnlyInsert(client, SESSIONS, SCOPE, [
			["id", val.str("e1")],
			["path", val.str("p/1")],
			["message", val.text('{"role":"user"}')],
			["creation_date", val.str("2026-06-17T00:00:00Z")],
		]);
		const insert = fake.requests.find((r) => /^INSERT INTO "sessions"/.test(r.sql));
		expect(insert).toBeDefined();
		// One INSERT, no UPDATE/concat.
		expect(fake.requests.filter((r) => /^INSERT INTO "sessions"/.test(r.sql)).length).toBe(1);
		expect(fake.requests.some((r) => /^UPDATE "sessions"/.test(r.sql))).toBe(false);
		// Read convention orders by creation_date.
		await readAppendOrdered(client, SESSIONS, SCOPE, "p/1");
		const read = fake.requests.find((r) => /SELECT \* FROM "sessions"/.test(r.sql));
		expect(read?.sql).toMatch(/ORDER BY creation_date ASC/);
	});

	it("PERF a bounded read caps to most-recent-N (DESC LIMIT) and reverses back to chronological", async () => {
		// The transport returns newest-first (as the DESC query would); the reader
		// must reverse the rows so the caller still sees oldest→newest.
		const { client, fake } = clientWith((req) =>
			/SELECT \* FROM "sessions"/.test(req.sql)
				? [{ message: "newest" }, { message: "middle" }, { message: "oldest" }]
				: [],
		);
		const result = await readAppendOrdered(client, SESSIONS, SCOPE, "p/1", "*", 2000);
		// Emitted a bounded, newest-first scan — never the unbounded ASC read.
		const read = fake.requests.find((r) => /SELECT \* FROM "sessions"/.test(r.sql));
		expect(read?.sql).toMatch(/ORDER BY creation_date DESC LIMIT 2000/);
		expect(read?.sql).not.toMatch(/ORDER BY creation_date ASC/);
		// Returned rows are reversed to chronological order.
		expect(result.kind).toBe("ok");
		if (result.kind === "ok") {
			expect(result.rows.map((r) => r.message)).toEqual(["oldest", "middle", "newest"]);
		}
	});

	it("PERF an out-of-range bounded limit clamps into [1, MAX_SESSION_TURNS]", async () => {
		const { client, fake } = clientWith(() => []);
		await readAppendOrdered(client, SESSIONS, SCOPE, "p/1", "*", 10_000_000); // over the cap
		await readAppendOrdered(client, SESSIONS, SCOPE, "p/2", "*", 0); // under the floor
		const reads = fake.requests.filter((r) => /SELECT \* FROM "sessions"/.test(r.sql));
		expect(reads[0]?.sql).toMatch(/LIMIT 2000/); // clamped down to the cap
		expect(reads[1]?.sql).toMatch(/LIMIT 1/); // clamped up to the floor
	});

	it("d-AC-5 supersede appends a new version + marks prior superseded, no in-place mutate", async () => {
		const { client, fake } = clientWith((req) => {
			if (/SELECT version FROM "skills"/.test(req.sql)) return [{ version: 7 }];
			return [];
		});
		const { version } = await appendVersionBumped(client, SKILLS, SCOPE, {
			keyColumn: "skill_id",
			keyValue: "s1",
			row: [
				["id", val.str("r-new")],
				["skill_id", val.str("s1")],
				["status", val.str("superseded")], // the supersede marker on the appended row
				["body", val.text("old body preserved")],
			],
		});
		expect(version).toBe(8);
		const insert = fake.requests.find((r) => /^INSERT INTO "skills"/.test(r.sql));
		expect(insert?.sql).toMatch(/'superseded'/);
		// No UPDATE of the prior row — supersede is append-only.
		expect(fake.requests.some((r) => /^UPDATE "skills"/.test(r.sql))).toBe(false);
	});

	it("d-AC-6 every value routes through the helpers; E'...' for escape-bearing bodies", async () => {
		const { client, fake } = clientWith(() => []);
		await appendOnlyInsert(client, SESSIONS, SCOPE, [
			["id", val.str("e'1")], // embedded quote → doubled
			["message", val.text("line1\nline2 with 'quote'")], // body → E'...'
		]);
		const sql = fake.requests.find((r) => /^INSERT INTO "sessions"/.test(r.sql))?.sql ?? "";
		// The string value's quote is doubled inside a plain literal.
		expect(sql).toMatch(/'e''1'/);
		// The escape-bearing body uses the E'...' form with doubled inner quotes.
		expect(sql).toMatch(/E'line1\nline2 with ''quote'''/);
	});

	it("d-AC-7 a missing-column write heals via 002c and retries once", async () => {
		let insertAttempts = 0;
		const altered: string[] = [];
		const { client, fake } = clientWith((req) => {
			if (/^INSERT INTO "memory"/.test(req.sql)) {
				insertAttempts++;
				if (insertAttempts === 1) throw new TransportError("query", 'column "summary" does not exist', 400);
				return [];
			}
			if (/SELECT path FROM "memory".*LIMIT 1/.test(req.sql)) return []; // not present → INSERT path
			if (/information_schema\.columns/.test(req.sql)) {
				// `summary` missing; the rest present.
				return FIXTURE_MEMORY_COLUMNS.filter((c) => c.name !== "summary").map((c) => ({ column_name: c.name }));
			}
			if (/^ALTER TABLE "memory"/.test(req.sql)) {
				altered.push(req.sql);
				return [];
			}
			return [];
		});
		const res = await updateOrInsertByKey(client, MEMORY, SCOPE, {
			keyColumn: "path",
			keyValue: "p/1",
			row: [
				["id", val.str("m1")],
				["path", val.str("p/1")],
				["summary", val.text("a summary")],
			],
		});
		expect(res.kind).toBe("ok");
		expect(insertAttempts).toBe(2); // original + one retry after heal
		expect(altered.some((s) => /ADD COLUMN summary/.test(s))).toBe(true);
		expect(fake).toBeDefined();
	});
});
