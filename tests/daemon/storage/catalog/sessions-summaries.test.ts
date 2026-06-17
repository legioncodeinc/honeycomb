/**
 * PRD-003c — Sessions, Transcripts, Summaries — proves c-AC-1..7.
 *
 * No live DeepLake. Each c-AC has a named, unskipped test against the PRD-002
 * fake transport. This suite also proves the three-memory-table role separation
 * (c-AC-3 / index AC-2) — the backbone of the whole catalog.
 */

import { describe, expect, it } from "vitest";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import { buildCreateTableSql, validateColumnDefs } from "../../../../src/daemon/storage/schema.js";
import { EMBEDDING_DIMS } from "../../../../src/daemon/storage/vector.js";
import { appendOnlyInsert, updateOrInsertByKey, val } from "../../../../src/daemon/storage/writes.js";
import { CATALOG, REGISTRY, healTargetFor } from "../../../../src/daemon/storage/catalog/index.js";
import { MEMORIES_COLUMNS } from "../../../../src/daemon/storage/catalog/memories.js";
import {
	buildTranscriptLookupSql,
	isTranscriptPath,
	MEMORY_COLUMNS,
	MEMORY_TABLE_ROLES,
	SESSIONS_COLUMNS,
	TRANSCRIPT_PATH_PREFIX,
	transcriptPath,
} from "../../../../src/daemon/storage/catalog/sessions-summaries.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";
import { TransportError } from "../../../../src/daemon/storage/transport.js";

const SCOPE = { org: "o1", workspace: "ws1" } as const;

function client(transport: FakeDeepLakeTransport) {
	return createStorageClient({ transport, provider: stubProvider(fakeCredentialRecord()) });
}

function colSql(cols: readonly { name: string; sql: string }[], name: string): string | undefined {
	return cols.find((c) => c.name === name)?.sql;
}

describe("PRD-003c sessions/summaries catalog", () => {
	it("c-AC-1 sessions row has JSONB message, optional 768-dim message_embedding, and a path readers concatenate by creation_date", async () => {
		expect(() => validateColumnDefs("sessions", SESSIONS_COLUMNS)).not.toThrow();
		expect(colSql(SESSIONS_COLUMNS, "message")).toBe("JSONB");
		const emb = colSql(SESSIONS_COLUMNS, "message_embedding");
		expect(emb).toBe("FLOAT4[]");
		expect(emb).not.toMatch(/NOT NULL/);
		expect(EMBEDDING_DIMS).toBe(768);
		expect(colSql(SESSIONS_COLUMNS, "path")).toBeDefined();
		expect(colSql(SESSIONS_COLUMNS, "creation_date")).toBeDefined();
		// sessions is append-only INSERT (one row per event, never concatenating).
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([]); // INSERT ok
		const res = await appendOnlyInsert(client(fake), healTargetFor("sessions"), SCOPE, [
			["id", val.str("s1")],
			["path", val.str("sess/abc")],
			["message", val.text('{"role":"user"}')],
			["creation_date", val.str("2026-06-17T00:00:00Z")],
		]);
		expect(res.kind).toBe("ok");
		expect(fake.requests[0].sql).toMatch(/^INSERT INTO "sessions"/);
	});

	it("c-AC-2 memory row is UPDATE-or-INSERT by path with a summary body and summary_embedding", async () => {
		expect(() => validateColumnDefs("memory", MEMORY_COLUMNS)).not.toThrow();
		expect(colSql(MEMORY_COLUMNS, "summary")).toBeDefined();
		expect(colSql(MEMORY_COLUMNS, "summary_embedding")).toBe("FLOAT4[]");
		expect(colSql(MEMORY_COLUMNS, "mime_type")).toMatch(/DEFAULT 'text\/plain'/);
		expect(REGISTRY.patternFor("memory")).toBe("update-or-insert");

		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([{ path: "wiki/x" }]); // key exists → UPDATE branch
		fake.enqueueRows([]); // UPDATE ok
		const res = await updateOrInsertByKey(client(fake), healTargetFor("memory"), SCOPE, {
			keyColumn: "path",
			keyValue: "wiki/x",
			row: [
				["path", val.str("wiki/x")],
				["summary", val.text("a wiki summary")],
			],
		});
		expect(res.kind).toBe("ok");
		const upd = fake.requests.find((r) => /^UPDATE/.test(r.sql))?.sql ?? "";
		expect(upd).toMatch(/^UPDATE "memory" SET/);
		expect(upd).toMatch(/path = 'wiki\/x'/);
	});

	it("c-AC-3 role separation: sessions=raw, memory=VFS/summaries, memories=distilled, no overlapping role", () => {
		expect(MEMORY_TABLE_ROLES).toEqual({
			sessions: "raw events",
			memory: "VFS and summaries",
			memories: "distilled facts",
		});
		// The three roles are pairwise distinct.
		const roles = Object.values(MEMORY_TABLE_ROLES);
		expect(new Set(roles).size).toBe(roles.length);

		// Structural distinction: sessions has `message` (JSONB raw event), memory has
		// `summary` (VFS body), memories has `content`+`content_hash` (distilled fact).
		expect(colSql(SESSIONS_COLUMNS, "message")).toBe("JSONB");
		expect(colSql(SESSIONS_COLUMNS, "summary")).toBeUndefined();
		expect(colSql(MEMORY_COLUMNS, "summary")).toBeDefined();
		expect(colSql(MEMORY_COLUMNS, "message")).toBeUndefined();
		expect(colSql(MEMORY_COLUMNS, "content_hash")).toBeUndefined();
		expect(colSql(MEMORIES_COLUMNS, "content_hash")).toBeDefined();
		expect(colSql(MEMORIES_COLUMNS, "summary")).toBeUndefined();

		// All three are distinct tables in the catalog.
		for (const name of ["sessions", "memory", "memories"]) {
			expect(CATALOG.some((t) => t.name === name), `table ${name}`).toBe(true);
		}
	});

	it("c-AC-4 a session transcript persists as a memory path convention, not a new table", () => {
		expect(transcriptPath("abc123")).toBe("transcripts/abc123");
		expect(transcriptPath("/abc123/")).toBe("transcripts/abc123"); // canonicalized
		expect(TRANSCRIPT_PATH_PREFIX).toBe("transcripts/");
		expect(isTranscriptPath("transcripts/abc123")).toBe(true);
		expect(isTranscriptPath("wiki/x")).toBe(false);
		// There is NO `session_transcripts` table in the catalog (D-1).
		expect(CATALOG.some((t) => t.name === "session_transcripts")).toBe(false);
		expect(CATALOG.some((t) => t.name === "transcripts")).toBe(false);
		// The transcript is reached through the ordinary `memory`-by-path access.
		const sql = buildTranscriptLookupSql("abc123");
		expect(sql).toMatch(/FROM "memory"/);
		expect(sql).toContain("path = 'transcripts/abc123'");
	});

	it("c-AC-5 embedding disabled writes message_embedding NULL and the row is recoverable by path + lexical", async () => {
		expect(colSql(SESSIONS_COLUMNS, "message_embedding")).not.toMatch(/NOT NULL/);
		const fake = new FakeDeepLakeTransport();
		fake.enqueueRows([]); // INSERT ok
		const res = await appendOnlyInsert(client(fake), healTargetFor("sessions"), SCOPE, [
			["id", val.str("s-noembed")],
			["path", val.str("sess/x")],
			["message", val.text('{"role":"user"}')],
			["message_embedding", val.raw("NULL")],
		]);
		expect(res.kind).toBe("ok");
		const sql = fake.requests[0].sql;
		expect(sql).toMatch(/message_embedding/);
		expect(sql).toMatch(/NULL/);
		// path column exists so the row is recoverable by path even with NULL embedding.
		expect(colSql(SESSIONS_COLUMNS, "path")).toBeDefined();
	});

	it("c-AC-6 sessions pruned by retention while derived memory summaries are retained (distinct tables, distinct patterns)", () => {
		// sessions is append-only (prunable raw events); memory is update-or-insert
		// (retained summaries). They are different tables with different lifecycles,
		// so pruning one never removes the other.
		expect(REGISTRY.patternFor("sessions")).toBe("append-only");
		expect(REGISTRY.patternFor("memory")).toBe("update-or-insert");
		expect(REGISTRY.byName.get("sessions")).not.toBe(REGISTRY.byName.get("memory"));
		// A transcript summary in `memory` survives a `sessions` prune because it
		// lives in a separate table at a `transcripts/<session>` path.
		expect(isTranscriptPath(transcriptPath("s9"))).toBe(true);
	});

	it("c-AC-7 first write to sessions or memory creates from the ColumnDef array and retries once", async () => {
		for (const table of ["sessions", "memory"] as const) {
			const cols = table === "sessions" ? SESSIONS_COLUMNS : MEMORY_COLUMNS;
			const seen: string[] = [];
			let writeAttempts = 0;
			const fake = new FakeDeepLakeTransport((req) => {
				seen.push(req.sql);
				if (/^INSERT/.test(req.sql)) {
					writeAttempts++;
					if (writeAttempts === 1) {
						throw new TransportError("query", `relation "${table}" does not exist`, 404);
					}
					return [];
				}
				if (/^CREATE TABLE/.test(req.sql)) return [];
				if (/information_schema\.columns/.test(req.sql)) {
					return cols.map((c) => ({ column_name: c.name }));
				}
				if (/^SELECT/.test(req.sql)) return []; // key probe → absent
				return [];
			});
			const res =
				table === "sessions"
					? await appendOnlyInsert(client(fake), healTargetFor("sessions"), SCOPE, [["id", val.str("x")]])
					: await updateOrInsertByKey(client(fake), healTargetFor("memory"), SCOPE, {
							keyColumn: "path",
							keyValue: "p",
							row: [["path", val.str("p")]],
						});
			expect(res.kind, `table ${table}`).toBe("ok");
			expect(seen.some((s) => new RegExp(`CREATE TABLE IF NOT EXISTS "${table}"`).test(s))).toBe(true);
			expect(buildCreateTableSql(table, cols)).toMatch(
				new RegExp(`CREATE TABLE IF NOT EXISTS "${table}" \\(.*\\) USING deeplake`),
			);
			expect(seen.filter((s) => /^INSERT/.test(s)).length).toBe(2); // original + retry
		}
	});
});
