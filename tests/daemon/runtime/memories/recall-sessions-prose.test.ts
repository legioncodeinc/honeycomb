/**
 * PRD-074 sessions-arm COALESCE suite — L-C1 / m-AC-2 / a-AC-6.
 *
 * The lexical `sessions` arm (`buildSessionsArmSql`) used to cast `message::text` and
 * ship the JSONB blob. PRD-074 swaps BOTH the projection AND the `ILIKE` predicate to a
 * shared `COALESCE(NULLIF(prose, ''), message::text)` expression so:
 *   - NEW rows (non-empty `prose`) match + return on the clean prose.
 *   - LEGACY rows (empty `prose`, healed in before the column existed) fall through to
 *     `message::text` and stay matchable.
 *
 * This suite proves BOTH paths:
 *   1. SQL shape — the COALESCE appears in projection AND predicate (cannot drift).
 *   2. End-to-end — a NEW row matches on prose (clean text reaches the harness); a
 *      LEGACY row matches on the JSONB fallback; both surface in one recall query.
 *   3. The single-quote injection guard + per-arm LIMIT still hold (the COALESCE
 *      doesn't weaken the sqlLike/sqlIdent discipline).
 *
 * Posture mirrors `recall.test.ts`: a fake `StorageQuery` whose `query(sql, scope)`
 * returns scripted rows keyed off the arm the SQL targets. No live DeepLake.
 */

import { describe, expect, it } from "vitest";
import type { QueryScope, StorageQuery, QueryOptions } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import { buildSessionsArmSql, recallMemories } from "../../../../src/daemon/runtime/memories/recall.js";

const SCOPE: QueryScope = { org: "fake-org", workspace: "fake-ws" };

/** A `sessions`-arm row, shaped as the arm SELECT projects it. */
function sessionsRow(id: string, text: string): StorageRow {
	return { source: "sessions", id, text };
}

/** True when `sql` is the lexical sessions arm (the `'sessions' AS source` tag + FROM "sessions"). */
function isSessionsArm(sql: string): boolean {
	return /'sessions'\s+AS\s+source/i.test(sql) && /FROM\s+"sessions"/i.test(sql);
}

/**
 * A fake storage that resolves the sessions arm to a caller-supplied QueryResult and
 * every other arm to empty. Captures every sessions-arm statement for shape assertions.
 */
function fakeStorage(sessions: QueryResult): { storage: StorageQuery; sessionsSqls: string[] } {
	const sessionsSqls: string[] = [];
	const storage: StorageQuery = {
		async query(sql: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
			if (isSessionsArm(sql)) {
				sessionsSqls.push(sql);
				return sessions;
			}
			return ok([], 0);
		},
	};
	return { storage, sessionsSqls };
}

// ── SQL shape — the COALESCE lives in projection AND predicate ────────────────

describe("L-C1 / m-AC-2 — buildSessionsArmSql emits the COALESCE in projection AND predicate", () => {
	it("the projection is `COALESCE(NULLIF(prose, ''), message::text) AS text`", () => {
		const sql = buildSessionsArmSql("term", 5);
		// The SELECT projection reads the COALESCE — the clean `prose` for new rows, the JSONB
		// fallback for legacy rows — aliased to the uniform `text` the mapper reads.
		expect(sql).toContain("COALESCE(NULLIF(prose, ''), message::text) AS text");
		// The bare `message::text AS text` projection (the pre-074 shape) is GONE.
		expect(sql).not.toMatch(/SELECT\s+'sessions'\s+AS\s+source,\s+"path"\s+AS\s+id,\s+"message"::text\s+AS\s+text/);
	});

	it("the ILIKE predicate matches the SAME COALESCE (projection + predicate cannot drift)", () => {
		const sql = buildSessionsArmSql("term", 5);
		// The match expression appears TWICE — once as the projection, once as the ILIKE subject.
		const matches = sql.match(/COALESCE\(NULLIF\(prose, ''\), message::text\)/g);
		expect(matches?.length, "projection + predicate = exactly two occurrences").toBe(2);
		// The predicate is `WHERE <matchExpr> ILIKE '<pattern>'` — never `message::text ILIKE` alone.
		expect(sql).toContain("WHERE COALESCE(NULLIF(prose, ''), message::text) ILIKE");
		expect(sql).not.toMatch(/WHERE\s+"message"::text\s+ILIKE/);
	});

	it("the per-arm LIMIT, FROM clauses, and source tag are preserved (no collateral drift)", () => {
		const sql = buildSessionsArmSql("term", 5);
		expect(sql).toContain('FROM "sessions"');
		expect(sql).toContain("'sessions' AS source");
		// sqlIdent renders the bare validated identifier (path, creation_date — no quotes).
		expect(sql).toContain("path AS id");
		expect(sql).toContain("creation_date::text AS created_at");
		expect(sql).toMatch(/LIMIT 5\s*$/);
	});

	it("a single-quote injection in the term cannot break out of the literal (sqlLike preserved)", () => {
		// The COALESCE swap must NOT weaken the SQL-guard discipline. A `'; DROP TABLE` term is
		// still escaped by sqlLike so the injected quote is doubled inert text inside the literal.
		const evil = "x'; DROP TABLE sessions; --";
		const sql = buildSessionsArmSql(evil, 1);
		expect(sql).toContain("x''; DROP TABLE sessions; --");
		expect(sql).not.toMatch(/'%x';\s*DROP TABLE/i);
	});

	it("a project clause is ANDed in unchanged (PRD-049b project isolation preserved)", () => {
		const sql = buildSessionsArmSql("term", 5, " AND project_id = 'proj-7'");
		expect(sql).toContain("AND project_id = 'proj-7'");
		// The COALESCE is still in BOTH places — the project clause is additive, not a replacement.
		expect(sql.match(/COALESCE\(NULLIF\(prose, ''\), message::text\)/g)?.length).toBe(2);
	});
});

// ── End-to-end — new rows match on prose, legacy rows fall through to message::text ─

describe("L-C1 / a-AC-6 — recall surfaces BOTH new (prose) and legacy (message::text) sessions rows", () => {
	it("a NEW row (populated prose) surfaces via the lexical sessions arm — clean text reaches the harness", async () => {
		// The fake returns a row whose `text` is the COALESCE result for a NEW row — i.e. the
		// clean prose, NOT the JSONB blob. (The DeepLake engine evaluates the COALESCE; we model
		// the post-evaluation row the harness would receive.)
		const { storage, sessionsSqls } = fakeStorage(
			ok([sessionsRow("conversations/s1", "Read → web/pages/dashboard.tsx:175-250\n// 'healthReasons' is no longer polled here")], 1),
		);

		const result = await recallMemories({ query: "healthReasons", scope: SCOPE }, { storage });

		// The session surfaced — its `text` is the clean prose (no escaped JSON nesting).
		expect(result.hits.some((h) => h.source === "sessions" && h.id === "conversations/s1")).toBe(true);
		const hit = result.hits.find((h) => h.id === "conversations/s1");
		expect(hit?.text).toContain("Read → web/pages/dashboard.tsx");
		expect(hit?.text).toContain("'healthReasons' is no longer polled here");
		// The escaped JSON structure NEVER reaches the harness.
		expect(hit?.text).not.toContain('{"event":');
		expect(hit?.text).not.toContain('\\"kind\\"');
		// The COALESCE SQL was the statement that surfaced it.
		expect(sessionsSqls[0]).toContain("COALESCE(NULLIF(prose, ''), message::text)");
	});

	it("a LEGACY row (empty prose → NULLIF → COALESCE falls through) still matches on message::text", async () => {
		// A legacy row whose `prose` healed in as '' (PRD-060a posture). The COALESCE evaluates
		// NULLIF('', '') → NULL → falls back to message::text. We model the post-evaluation row:
		// the `text` the harness receives is the JSONB cast (the old bloat, the documented trade).
		const { storage, sessionsSqls } = fakeStorage(
			ok([sessionsRow("conversations/legacy", '{"event":{"kind":"user_message","text":"legacy row matched on the jsonb fallback"}}')], 1),
		);

		const result = await recallMemories({ query: "legacy", scope: SCOPE }, { storage });

		// The legacy session STILL surfaces — the COALESCE fallback kept it matchable. Its text
		// is the JSONB cast (acceptable legacy bloat; new rows are clean, old rows stay on the
		// fallback until the corpus turns over).
		expect(result.hits.some((h) => h.id === "conversations/legacy")).toBe(true);
		const hit = result.hits.find((h) => h.id === "conversations/legacy");
		expect(hit?.text).toContain("legacy row matched on the jsonb fallback");
		// The same COALESCE SQL surfaced it (a single scan handles BOTH new + legacy rows).
		expect(sessionsSqls[0]).toContain("COALESCE(NULLIF(prose, ''), message::text) ILIKE");
	});

	it("NEW + LEGACY rows surface TOGETHER in one recall query (single coherent scan)", async () => {
		// The point of COALESCE-in-SQL (vs a per-row mapper fallback): ONE lexical scan returns
		// a coherent mix of new (prose) + legacy (message::text) hits without a per-row round-trip.
		const { storage } = fakeStorage(
			ok(
				[
					sessionsRow("conversations/new", "Read → web/pages/dashboard.tsx\nthe clean prose path"),
					sessionsRow("conversations/legacy", '{"event":{"kind":"user_message","text":"the legacy jsonb fallback path"}}'),
				],
				1,
			),
		);

		const result = await recallMemories({ query: "path", scope: SCOPE }, { storage });

		// Both surface — new on prose, legacy on the JSONB fallback, fused in one result set.
		const ids = result.hits.filter((h) => h.source === "sessions").map((h) => h.id);
		expect(ids).toEqual(expect.arrayContaining(["conversations/new", "conversations/legacy"]));
	});

	it("the row-to-hit mapper reads the uniform `text` alias — agnostic to which column filled it", async () => {
		// rowsToRankedArm reads row.text (the SQL alias). Whether the COALESCE filled it from
		// `prose` or `message::text`, the alias is `text` either way — the mapper is unchanged.
		const { storage } = fakeStorage(ok([sessionsRow("conversations/x", "any text the COALESCE produced")], 1));

		const result = await recallMemories({ query: "text", scope: SCOPE }, { storage });

		const hit = result.hits.find((h) => h.id === "conversations/x");
		expect(hit?.text).toBe("any text the COALESCE produced");
		expect(hit?.source).toBe("sessions");
		expect(hit?.kind).toBe("session"); // the provenance tag the surface renders off.
	});
});
