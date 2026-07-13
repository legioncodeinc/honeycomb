/**
 * ISS-006 — search operates over the EXACT corpus the memories list shows.
 *
 * THE CONTRACT THIS SUITE ENCODES (the user-stated acceptance criteria):
 *
 *   1. CORPUS PARITY — any memory visible in the pre-search list must be findable by
 *      search when the query matches its content, UNDER THE SAME SCOPE INPUT: same
 *      table, same scope semantics, tokenization on top. Pre-fix the two surfaces
 *      resolved the SAME input to DIFFERENT corpora (degraded list → whole workspace;
 *      degraded recall → inbox-only) and `__unsorted__` inbox rows were invisible to
 *      every project-scoped list AND search.
 *
 *   2. PRESENTATION PARITY (the daemon's half) — every `memories`-source recall hit
 *      carries ACTIONABLE memory identity (`memoryId`, plus the `memoryType` badge
 *      field), matching a row the list endpoint returns under the same scope input,
 *      so the dashboard can render a search hit as the SAME interactive card
 *      (open / edit / forget) the pre-search list renders.
 *
 * HARNESS: the real HTTP surface (`mountMemoriesApi` on a real daemon) over a
 * STATEFUL SQL-aware fake transport that models a tiny `memories` table:
 *   - rows are seeded through the REAL write path (`POST /api/memories`) — the fake
 *     captures the engine's `INSERT INTO "memories"` and materializes the row;
 *   - the list read evaluates the REAL generated project predicate against the rows;
 *   - the recall `memories` lexical arm evaluates the REAL generated ILIKE patterns
 *     (whole-phrase OR all-token conjuncts — the ISS-006 tokenized fallback) plus the
 *     REAL project predicate against the same rows.
 * So what is asserted is the behavior of the DAEMON-GENERATED SQL over one corpus —
 * exactly the parity the acceptance criterion demands. Embeddings are absent (no
 * embed client), so recall runs the lexical floor — the live posture the ISS-006
 * investigation proved (semantic dead → every natural query rode the lexical arm).
 */

import { describe, expect, it } from "vitest";

import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import type { RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import { mountMemoriesApi } from "../../../../src/daemon/runtime/memories/index.js";
import {
	buildLexicalMatchSql,
	MAX_LEXICAL_MATCH_TOKENS,
	MAX_LEXICAL_PHRASE_LENGTH,
	MAX_LEXICAL_TOKEN_LENGTH,
} from "../../../../src/daemon/runtime/memories/recall.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const ORG = "iss006-org";
const WORKSPACE = "iss006-ws";
const SESSION = "sess-iss006";

/** One materialized row of the fake `memories` table. */
interface FakeMemoryRow {
	id: string;
	type: string;
	content: string;
	confidence: number;
	agent_id: string;
	is_deleted: number;
	created_at: string;
	updated_at: string;
	project_id: string;
	visibility: string;
	source_type: string;
	source_id: string;
	version: number;
	content_embedding: null;
}

/** Split a SQL fragment on TOP-LEVEL commas (respecting single-quoted strings + parens). */
function splitTopLevel(fragment: string): string[] {
	const parts: string[] = [];
	let depth = 0;
	let inQuote = false;
	let current = "";
	for (let i = 0; i < fragment.length; i += 1) {
		const ch = fragment[i]!;
		if (inQuote) {
			current += ch;
			if (ch === "'") {
				// A doubled '' is an escaped quote INSIDE the literal; consume the pair.
				if (fragment[i + 1] === "'") {
					current += "'";
					i += 1;
				} else {
					inQuote = false;
				}
			}
			continue;
		}
		if (ch === "'") {
			inQuote = true;
			current += ch;
			continue;
		}
		if (ch === "(" || ch === "[") depth += 1;
		if (ch === ")" || ch === "]") depth -= 1;
		if (ch === "," && depth === 0) {
			parts.push(current.trim());
			current = "";
			continue;
		}
		current += ch;
	}
	if (current.trim() !== "") parts.push(current.trim());
	return parts;
}

/**
 * Un-quote a SQL value token: a plain `'x''y'` (sLiteral) OR an escaped `E'x''y'`
 * (eLiteral, whose body ALSO doubles backslashes via sqlStr) → the raw value.
 * A bare token (numbers, NULL) returns as-is.
 */
function unquote(token: string): string {
	let t = token.trim();
	const escaped = /^E'/i.test(t);
	if (escaped) t = t.slice(1);
	if (t.startsWith("'") && t.endsWith("'")) {
		const body = t.slice(1, -1).replace(/''/g, "'");
		return escaped ? body.replace(/\\\\/g, "\\") : body;
	}
	return t;
}

/**
 * Materialize an engine `INSERT INTO "memories" (cols) VALUES (vals)` into a row.
 * Returns null for a non-memories insert (telemetry/audit tables the flow also touches).
 */
function parseMemoriesInsert(sql: string): FakeMemoryRow | null {
	const m = /^INSERT INTO "memories"\s*\(([^)]*)\)\s*VALUES\s*\((.*)\)\s*$/is.exec(sql);
	if (m === null) return null;
	const cols = m[1]!.split(",").map((c) => c.trim().replace(/"/g, ""));
	const vals = splitTopLevel(m[2]!);
	const cell = new Map<string, string>();
	cols.forEach((c, i) => cell.set(c, vals[i] ?? ""));
	const num = (key: string, fallback: number): number => {
		const raw = cell.get(key);
		const n = raw === undefined ? Number.NaN : Number(unquote(raw));
		return Number.isFinite(n) ? n : fallback;
	};
	const str = (key: string, fallback = ""): string => {
		const raw = cell.get(key);
		return raw === undefined || raw.toUpperCase() === "NULL" ? fallback : unquote(raw);
	};
	return {
		id: str("id"),
		type: str("type", "fact"),
		content: str("content"),
		confidence: num("confidence", 1),
		agent_id: str("agent_id", "default"),
		is_deleted: num("is_deleted", 0),
		created_at: str("created_at"),
		updated_at: str("updated_at"),
		project_id: str("project_id"),
		visibility: str("visibility", "global"),
		source_type: str("source_type"),
		source_id: str("source_id"),
		version: num("version", 1),
		content_embedding: null,
	};
}

/**
 * Evaluate the daemon-generated project predicate found in `sql` against a row.
 * NO predicate in the statement → NO filter (the whole-workspace corpus — exactly
 * how a real backend treats a WHERE with no project conjunct).
 */
function admittedByProjectPredicate(sql: string, row: FakeMemoryRow): boolean {
	const admitted = [...sql.matchAll(/project_id = '((?:[^']|'')*)'/g)].map((m) => m[1]!.replace(/''/g, "'"));
	if (admitted.length === 0) return true; // no project predicate → workspace-wide.
	if (admitted.includes(row.project_id)) return true;
	// The `project_id IS NULL` arm admits a NULL cell; the fake always materializes a string,
	// so '' rides the `project_id = ''` disjunct instead (same "unset/legacy" class).
	return false;
}

/**
 * Evaluate the recall `memories` arm's tokenized ILIKE semantics against a row:
 * the FIRST extracted pattern is the whole phrase; any remaining patterns are the
 * per-token conjuncts (`buildLexicalMatchSql`: phrase OR (t1 AND t2 AND …)).
 */
function admittedByLexicalMatch(sql: string, content: string): boolean {
	const patterns = [...sql.matchAll(/ILIKE '%((?:[^']|'')*)%'/g)].map((m) => m[1]!.replace(/''/g, "'"));
	if (patterns.length === 0) return false;
	const haystack = content.toLowerCase();
	const phrase = patterns[0]!.toLowerCase();
	if (haystack.includes(phrase)) return true;
	const tokens = patterns.slice(1);
	return tokens.length > 0 && tokens.every((t) => haystack.includes(t.toLowerCase()));
}

/** The stateful fake: a memories table + the SQL-aware responder over it. */
function makeFakeWorld() {
	const table: FakeMemoryRow[] = [];
	const responder = (req: TransportRequest): Record<string, unknown>[] => {
		const sql = req.sql;
		// The real write path lands here: materialize the engine's INSERT.
		const inserted = parseMemoriesInsert(sql);
		if (inserted !== null) {
			table.push(inserted);
			return [];
		}
		if (sql.startsWith("INSERT")) return []; // telemetry / audit / history appends.
		// The LIST read (buildListSql): the has_embedding projection + created_at ordering.
		if (/FROM "memories"/i.test(sql) && /has_embedding/i.test(sql) && /ORDER BY created_at DESC/i.test(sql)) {
			return table
				.filter((row) => row.is_deleted === 0 && admittedByProjectPredicate(sql, row))
				.map((row) => ({ ...row, has_embedding: false }));
		}
		// The recall `memories` LEXICAL arm: tokenized ILIKE + soft-delete + project predicate.
		if (/'memories' AS source/i.test(sql) && /ILIKE/i.test(sql)) {
			return table
				.filter(
					(row) =>
						row.is_deleted === 0 &&
						admittedByLexicalMatch(sql, row.content) &&
						admittedByProjectPredicate(sql, row),
				)
				.map((row) => ({
					source: "memories",
					id: row.id,
					text: row.content,
					created_at: row.created_at,
					memory_type: row.type,
				}));
		}
		// Every sibling arm (memory / sessions / hive_graph), dedup probes, KPI reads → empty.
		return [];
	};
	return { table, responder };
}

function cfg(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
}

/** Session-group headers; `project` stamps the dashboard's selected-project header. */
function headersFor(project?: string): Record<string, string> {
	return {
		"x-honeycomb-org": ORG,
		"x-honeycomb-workspace": WORKSPACE,
		"x-honeycomb-runtime-path": "legacy",
		"x-honeycomb-session": SESSION,
		"content-type": "application/json",
		...(project !== undefined ? { "x-honeycomb-project": project } : {}),
	};
}

/** Build the daemon + mount over one shared fake world. */
function makeWorld() {
	const world = makeFakeWorld();
	const fake = new FakeDeepLakeTransport(world.responder);
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const daemon = createDaemon({ config: cfg(), storage, logger: createRequestLogger({ silent: true }) });
	mountMemoriesApi(daemon, { storage });
	return { daemon, world };
}

/** POST /api/memories through the REAL write path, under the given scope header. */
async function seed(daemon: ReturnType<typeof makeWorld>["daemon"], content: string, project?: string): Promise<void> {
	const res = await daemon.app.request("/api/memories", {
		method: "POST",
		headers: headersFor(project),
		body: JSON.stringify({ content }),
	});
	expect(res.status).toBe(201);
}

interface ListedMemory {
	id: string;
	content: string;
	type: string;
}

async function listUnder(daemon: ReturnType<typeof makeWorld>["daemon"], project?: string): Promise<ListedMemory[]> {
	const res = await daemon.app.request("/api/memories", { headers: headersFor(project) });
	expect(res.status).toBe(200);
	const body = (await res.json()) as { memories: ListedMemory[] };
	return body.memories;
}

interface RecallHitWire {
	source: string;
	id: string;
	text: string;
	memoryId?: string;
	memoryType?: string;
}

async function recallUnder(
	daemon: ReturnType<typeof makeWorld>["daemon"],
	query: string,
	project?: string,
): Promise<RecallHitWire[]> {
	const res = await daemon.app.request("/api/memories/recall", {
		method: "POST",
		headers: headersFor(project),
		body: JSON.stringify({ query }),
	});
	expect(res.status).toBe(200);
	const body = (await res.json()) as { hits: RecallHitWire[] };
	return body.hits;
}

/** A distinctive single-token query term per seeded memory (each unique to its content). */
function distinctiveTerm(content: string): string {
	return content.split(/\s+/)[0]!;
}

/**
 * THE ACCEPTANCE-CRITERION LOOP: for EVERY memory the list returns under a scope
 * input, a recall with a distinctive term from that memory's content — under the
 * SAME scope input — must return it, and the returning hit must carry the
 * actionable identity (`memoryId` === the listed row's id) + the type badge field.
 */
async function assertListSearchParity(
	daemon: ReturnType<typeof makeWorld>["daemon"],
	project: string | undefined,
	expectedContents: readonly string[],
): Promise<void> {
	const listed = await listUnder(daemon, project);
	// The scope input shows exactly the expected corpus (order-independent).
	expect(listed.map((m) => m.content).sort()).toEqual([...expectedContents].sort());
	const listedIds = new Set(listed.map((m) => m.id));
	for (const memory of listed) {
		const hits = await recallUnder(daemon, distinctiveTerm(memory.content), project);
		const match = hits.find((h) => h.source === "memories" && h.memoryId === memory.id);
		expect(
			match,
			`memory ${memory.id} ("${memory.content}") is visible in the list under project=${project ?? "(none)"} but was NOT returned by a recall for "${distinctiveTerm(memory.content)}" under the same scope input`,
		).toBeDefined();
		// Presentation parity: the hit carries the same badge field the list row renders.
		expect(match!.memoryType).toBe(memory.type);
		// Every memories-source hit in every response carries an actionable id that the list
		// under the SAME scope input also returned (no phantom identities, no missing ids).
		for (const hit of hits) {
			if (hit.source !== "memories") continue;
			expect(hit.memoryId).toBeDefined();
			expect(listedIds.has(hit.memoryId!)).toBe(true);
		}
	}
}

const M1 = "quokka ledger reconciliation quirk for the alpha project";
const M2 = "xylophone canyon watermark note for the beta project";
const M3 = "gargoyle orchard sync ritual captured without any project";
const M4 = "hummingbird legacy convention recorded before project scoping";

/** Seed the canonical four-corpus fixture through the REAL write paths. */
async function seedFixture(daemon: ReturnType<typeof makeWorld>["daemon"], world: ReturnType<typeof makeWorld>["world"]): Promise<void> {
	await seed(daemon, M1, "proj-A"); // bound: the dashboard's selected project A.
	await seed(daemon, M2, "proj-B"); // another project's row — never crosses into A's views.
	await seed(daemon, M3); // no header, no cwd (the MCP memory_store / dashboard Add shape) → the __unsorted__ inbox.
	// The pre-049b legacy row (project_id ''): no HTTP write path can produce it anymore, so it
	// is materialized directly — the documented "unset/legacy" class every scope admits (D5).
	world.table.push({
		id: "mem-legacy-1",
		type: "fact",
		content: M4,
		confidence: 1,
		agent_id: "default",
		is_deleted: 0,
		created_at: "2026-01-01T00:00:00.000Z",
		updated_at: "2026-01-01T00:00:00.000Z",
		project_id: "",
		visibility: "global",
		source_type: "",
		source_id: "",
		version: 1,
		content_embedding: null,
	});
	// The write path landed M3 in the inbox (the invisible-rows bug class ISS-006 fixes).
	const inboxRow = world.table.find((r) => r.content === M3);
	expect(inboxRow?.project_id).toBe("__unsorted__");
	// And M1/M2 landed segmented by their selected projects (the real 049b/049e write seam).
	expect(world.table.find((r) => r.content === M1)?.project_id).toBe("proj-A");
	expect(world.table.find((r) => r.content === M2)?.project_id).toBe("proj-B");
}

describe("ISS-006 — the pre-search list and the search corpus are the SAME set (acceptance criterion)", () => {
	it("BOUND project scope: list shows project + inbox + legacy rows; every one is findable by search; project-B never leaks", async () => {
		const { daemon, world } = makeWorld();
		await seedFixture(daemon, world);
		// ISS-006 piece B: the inbox row (M3) and the legacy row (M4) are REACHABLE from the
		// bound-project view — pre-fix they were invisible to both surfaces.
		await assertListSearchParity(daemon, "proj-A", [M1, M3, M4]);
		// Cross-project isolation is preserved: a recall for M2's distinctive term under proj-A
		// returns nothing from project B (49b-AC-2 still holds after the inbox widening).
		const crossHits = await recallUnder(daemon, distinctiveTerm(M2), "proj-A");
		expect(crossHits.filter((h) => h.source === "memories")).toEqual([]);
	});

	it("EXPLICIT INBOX scope: list shows inbox + legacy rows; every one is findable by search", async () => {
		const { daemon, world } = makeWorld();
		await seedFixture(daemon, world);
		await assertListSearchParity(daemon, "__unsorted__", [M3, M4]);
	});

	it("DEGRADED scope (no header, no cwd): list AND search BOTH run workspace-wide (ISS-006 piece A — pre-fix they resolved to opposite corpora)", async () => {
		const { daemon, world } = makeWorld();
		await seedFixture(daemon, world);
		// The unified semantic: degraded resolution → the whole-workspace corpus on BOTH surfaces.
		await assertListSearchParity(daemon, undefined, [M1, M2, M3, M4]);
	});

	it("TOKENIZED fallback (piece C): a multi-word natural query whose words are non-adjacent in the content still finds the memory", async () => {
		const { daemon, world } = makeWorld();
		await seedFixture(daemon, world);
		// "quokka reconciliation" — both words in M1's content, NOT adjacent. Pre-fix the lexical
		// arm matched `content ILIKE '%quokka reconciliation%'` (the whole query as ONE substring)
		// → 0 hits despite every word being present (the live-proven ISS-006 regression).
		const hits = await recallUnder(daemon, "quokka reconciliation", "proj-A");
		const m1 = world.table.find((r) => r.content === M1)!;
		expect(hits.some((h) => h.source === "memories" && h.memoryId === m1.id)).toBe(true);
	});
});

describe("ISS-006 — buildLexicalMatchSql (the tokenized predicate)", () => {
	it("a single usable token emits the byte-identical pre-fix single ILIKE", () => {
		expect(buildLexicalMatchSql('"content"::text', "quokka")).toBe(`"content"::text ILIKE '%quokka%'`);
	});

	it("a multi-word query emits whole-phrase OR the AND-of-tokens conjunction", () => {
		const sql = buildLexicalMatchSql('"content"::text', "alpha ledger quirk");
		expect(sql).toBe(
			`("content"::text ILIKE '%alpha ledger quirk%' OR ` +
				`("content"::text ILIKE '%alpha%' AND "content"::text ILIKE '%ledger%' AND "content"::text ILIKE '%quirk%'))`,
		);
	});

	it("stopword-length (<= 1 char) tokens are dropped; a query of ONLY short tokens keeps the phrase match", () => {
		const sql = buildLexicalMatchSql('"content"::text', "a b c");
		expect(sql).toBe(`"content"::text ILIKE '%a b c%'`);
	});

	it("duplicate tokens are de-duped and the conjunct count is capped", () => {
		const words = Array.from({ length: 20 }, (_, i) => `token${i}`).join(" ");
		const sql = buildLexicalMatchSql('"content"::text', words);
		const conjuncts = sql.match(/ILIKE/g) ?? [];
		// 1 whole-phrase + at most MAX_LEXICAL_MATCH_TOKENS per-term conjuncts.
		expect(conjuncts.length).toBe(1 + MAX_LEXICAL_MATCH_TOKENS);
		const dupSql = buildLexicalMatchSql('"content"::text', "same same different");
		expect((dupSql.match(/%same%/g) ?? []).length).toBe(1);
	});

	it("every token routes through the sqlLike guard (quotes + LIKE metacharacters escaped)", () => {
		const sql = buildLexicalMatchSql('"content"::text', "o'brien 100%");
		expect(sql).toContain("o''brien"); // quote doubled — never a raw ' in the pattern.
		expect(sql).not.toMatch(/[^']'%o'brien/); // no unescaped literal boundary.
		expect(sql).toContain("100\\%"); // the LIKE wildcard is escaped, not live.
	});
});

describe("ISS-006 hardening — pre-interpolation shaping + the colSql fragment contract", () => {
	it("the statement size stays bounded for a pathological multi-megabyte query", () => {
		// One 2MB blob token + a long multi-token tail: pre-hardening this interpolated the whole
		// blob into the phrase pattern (and up to 8 token copies) — unbounded amplification.
		const blob = "z".repeat(2 * 1024 * 1024);
		const sql = buildLexicalMatchSql('"content"::text', blob);
		expect(sql.length).toBeLessThan(MAX_LEXICAL_PHRASE_LENGTH + 200);

		const manyLong = Array.from({ length: 40 }, (_, i) => `tok${i}${"y".repeat(5000)}`).join(" ");
		const multi = buildLexicalMatchSql('"content"::text', manyLong);
		// Bounded by construction: phrase cap + (token cap × conjunct cap) + fixed SQL glue.
		expect(multi.length).toBeLessThan(MAX_LEXICAL_PHRASE_LENGTH + MAX_LEXICAL_MATCH_TOKENS * (MAX_LEXICAL_TOKEN_LENGTH + 40) + 200);
	});

	it("over-long tokens are TRUNCATED in the conjuncts (widen-only — a prefix pattern admits a superset)", () => {
		const longToken = `needle${"x".repeat(500)}`;
		const sql = buildLexicalMatchSql('"content"::text', `${longToken} anchor`);
		// The CONJUNCT pattern carries the truncated prefix (the phrase arm keeps the full term —
		// it rides under its own MAX_LEXICAL_PHRASE_LENGTH cap, and 506 chars is inside it).
		expect(sql).toContain(`ILIKE '%${longToken.slice(0, MAX_LEXICAL_TOKEN_LENGTH)}%' AND `);
		// The full 506-char token is interpolated ONCE (the phrase), never again as a conjunct.
		expect(sql.split(longToken).length - 1).toBe(1);
		expect(sql).toContain("%anchor%"); // the normal sibling token is untouched.
	});

	it("control characters are stripped from the interpolated patterns (defense-in-depth over sqlLike)", () => {
		const sql = buildLexicalMatchSql('"content"::text', "alpha\u0001beta gamma\u001fdelta");
		expect(sql).toContain("%alphabeta%");
		expect(sql).toContain("%gammadelta%");
		expect(sql).not.toMatch(/[\u0000-\u001f\u007f]/);
	});

	it("a normal query under the caps emits BYTE-IDENTICAL SQL to the unshaped form (no live behavior change)", () => {
		expect(buildLexicalMatchSql('"content"::text', "quokka")).toBe(`"content"::text ILIKE '%quokka%'`);
		expect(buildLexicalMatchSql('"content"::text', "alpha ledger quirk")).toBe(
			`("content"::text ILIKE '%alpha ledger quirk%' OR ` +
				`("content"::text ILIKE '%alpha%' AND "content"::text ILIKE '%ledger%' AND "content"::text ILIKE '%quirk%'))`,
		);
	});

	it("the colSql tamper canary throws on a fragment carrying a statement separator or comment token", () => {
		expect(() => buildLexicalMatchSql('"content"::text; DROP TABLE memories', "quokka")).toThrow(/compile-time-constant/);
		expect(() => buildLexicalMatchSql('"content"::text -- comment', "quokka")).toThrow(/compile-time-constant/);
		expect(() => buildLexicalMatchSql('"content"::text /* c */', "quokka")).toThrow(/compile-time-constant/);
		// The real call-site shapes stay accepted (memories/memory/sessions/hive-graph arms).
		expect(() => buildLexicalMatchSql('"content"::text', "quokka")).not.toThrow();
		expect(() => buildLexicalMatchSql(`COALESCE(NULLIF("prose", ''), "message"::text)`, "quokka")).not.toThrow();
		expect(() => buildLexicalMatchSql('v."title"::text', "quokka")).not.toThrow();
	});
});
