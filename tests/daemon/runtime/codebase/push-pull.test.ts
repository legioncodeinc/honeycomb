/**
 * PRD-014c Push / Pull — c-AC-1..6 against a SQL-aware FAKE StorageQuery.
 *
 * Verification posture (EXECUTION_LEDGER-prd-014 / codebase CONVENTIONS §9/§10):
 *   - No live DeepLake, no network. The `codebase`-table push/pull is driven
 *     against a fake `StorageQuery` (`FakeStore`) that RECORDS every statement and
 *     answers SELECTs from an in-memory row set keyed on the SQL. This lets each AC
 *     assert the exact write path — crucially, that a DRIFT push emits NO INSERT.
 *   - Each `describe` block is named after the c-AC it proves (one-to-one).
 *   - Snapshots + their hashes are REAL: built via `buildAggregateSnapshot` +
 *     `finalizeSnapshot` from source fixtures, so the pull hash-revalidation is a
 *     genuine `computeSnapshotSha256` round-trip (a tampered payload truly mismatches).
 *   - `verifyPolls: 1` — the fake is authoritative on the first poll, so the live
 *     poll-convergence budget is collapsed to one read in unit tests.
 *
 * c-AC-1 existing row, matching hash → already-current (no-op); differing hash →
 *        log drift + REFUSE overwrite (NO INSERT emitted).
 * c-AC-2 pulled payload → recomputed hash must == claimed or REFUSED (tampered jsonb).
 * c-AC-3 no auth / no commit / HONEYCOMB_GRAPH_PUSH=0 → push skipped silently.
 * c-AC-4 push storage failure → logs, does NOT throw, returns `failed` (non-blocking).
 * c-AC-5 >1 row after insert → inserted-with-duplicate-race.
 * c-AC-6 older commit checked out locally → pull (not "local newer").
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	buildAggregateSnapshot,
	finalizeSnapshot,
} from "../../../../src/daemon/runtime/codebase/snapshot.js";
import type { Snapshot, SnapshotIdentity } from "../../../../src/daemon/runtime/codebase/contracts.js";
import {
	type PushPullContext,
	type PushPullLogger,
	pullSnapshot,
	pushSnapshot,
} from "../../../../src/daemon/runtime/codebase/push-pull.js";
import type { QueryScope } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult, queryError, type StorageRow } from "../../../../src/daemon/storage/result.js";

// ── Identity + scope fixtures ──────────────────────────────────────────────────

const IDENTITY: SnapshotIdentity = {
	org: "acme",
	workspace: "default",
	repo: "honeycomb",
	user: "u1",
	worktree: "wt1",
	commit: "commit-abc",
};
const SCOPE: QueryScope = { org: "acme", workspace: "default" };

// ── A real snapshot + its real hash (so pull revalidation is genuine) ──────────

let cacheDir: string;
beforeEach(() => {
	cacheDir = mkdtempSync(join(tmpdir(), "hc-pushpull-"));
});
afterEach(() => {
	rmSync(cacheDir, { recursive: true, force: true });
	delete process.env.HONEYCOMB_GRAPH_PUSH;
});

function fixtureDeps(files: Record<string, string>) {
	return {
		gitLsFiles: () => Object.keys(files).join("\0"),
		readFile: (abs: string) => {
			const key = Object.keys(files).find((k) => abs.replace(/\\/g, "/").endsWith(k));
			if (key === undefined) throw new Error(`no fixture for ${abs}`);
			return files[key];
		},
		cacheBaseDir: cacheDir,
		noCache: true as const,
	};
}

/** Build a real finalized snapshot + its canonical hash for a fixture repo. */
async function realSnapshot(
	identity: SnapshotIdentity = IDENTITY,
	files: Record<string, string> = {
		"src/a.ts": "import { b } from './b';\nexport function a(){ b(); }\n",
		"src/b.ts": "export function b(){}\n",
	},
): Promise<{ snapshot: Snapshot; sha256: string }> {
	const build = await buildAggregateSnapshot("/repo", identity, fixtureDeps(files));
	return finalizeSnapshot(build);
}

// ── A SQL-aware fake StorageQuery ──────────────────────────────────────────────
//
// Records every statement. SELECTs are answered from an in-memory row set; an
// INSERT appends a row parsed from its column list. A per-instance `failOn`
// predicate drives c-AC-4 (a storage failure).

interface FakeRow extends StorageRow {
	snapshot_sha256: string;
	snapshot_jsonb: string;
	created_at: string;
	commit_sha: string;
}

class FakeStore {
	readonly statements: string[] = [];
	rows: FakeRow[] = [];
	/** When set and it returns true for a statement, that query returns a query_error. */
	failOn: ((sql: string) => boolean) | null = null;

	async query(sql: string, _scope: QueryScope): Promise<QueryResult> {
		this.statements.push(sql);
		if (this.failOn && this.failOn(sql)) {
			return queryError("simulated backend failure", 500);
		}
		const head = sql.trimStart().slice(0, 6).toUpperCase();
		if (head.startsWith("SELECT")) {
			// All SELECTs in push/pull filter by the row set; return every row (the
			// WHERE is satisfied by construction in these single-identity tests). For
			// ORDER BY created_at DESC LIMIT 1 (pull) return the freshest.
			if (/ORDER BY/i.test(sql)) {
				const sorted = [...this.rows].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
				return ok(sorted.slice(0, 1), 1);
			}
			if (/LIMIT 1/i.test(sql)) return ok(this.rows.slice(0, 1), 1);
			return ok([...this.rows], 1);
		}
		if (head.startsWith("INSERT")) {
			this.rows.push(parseInsertRow(sql));
			return ok([], 1);
		}
		return ok([], 1);
	}

	/** Count INSERT statements emitted (drift must emit ZERO). */
	insertCount(): number {
		return this.statements.filter((s) => s.trimStart().toUpperCase().startsWith("INSERT")).length;
	}
}

/** Pull the column→value pairs out of a guarded INSERT so the fake can store a row. */
function parseInsertRow(sql: string): FakeRow {
	const m = /INSERT INTO "[^"]+" \((.+)\) VALUES \((.+)\)$/s.exec(sql.trim());
	if (!m) throw new Error(`fake could not parse INSERT: ${sql}`);
	const cols = m[1].split(",").map((c) => c.trim());
	const vals = splitTopLevel(m[2]);
	const row: Record<string, unknown> = {};
	cols.forEach((c, i) => {
		row[c] = unliteral(vals[i]);
	});
	return row as FakeRow;
}

/** Split a VALUES list on top-level commas (respecting single-quoted literals). */
function splitTopLevel(s: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let inStr = false;
	let cur = "";
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (inStr) {
			cur += ch;
			if (ch === "'" && s[i + 1] === "'") {
				cur += s[++i];
			} else if (ch === "'") {
				inStr = false;
			}
			continue;
		}
		if (ch === "'") {
			inStr = true;
			cur += ch;
		} else if (ch === "(") {
			depth++;
			cur += ch;
		} else if (ch === ")") {
			depth--;
			cur += ch;
		} else if (ch === "," && depth === 0) {
			out.push(cur.trim());
			cur = "";
		} else {
			cur += ch;
		}
	}
	if (cur.trim() !== "") out.push(cur.trim());
	return out;
}

/** Undo a guarded literal: strip `E'`/`'` wrappers + un-double quotes/backslashes. */
function unliteral(v: string): unknown {
	let s = v.trim();
	if (s.startsWith("E'")) s = s.slice(2);
	else if (s.startsWith("'")) s = s.slice(1);
	else return /^-?\d+$/.test(s) ? Number(s) : s; // bare number
	if (s.endsWith("'")) s = s.slice(0, -1);
	return s.replace(/''/g, "'").replace(/\\\\/g, "\\");
}

function fakeLogger(): { logger: PushPullLogger; warns: string[]; infos: string[] } {
	const warns: string[] = [];
	const infos: string[] = [];
	return {
		warns,
		infos,
		logger: {
			warn: (e) => warns.push(e),
			info: (e) => infos.push(e),
		},
	};
}

function ctxFor(store: FakeStore, over: Partial<PushPullContext> = {}): PushPullContext {
	return {
		storage: store,
		scope: SCOPE,
		authenticated: true,
		verifyPolls: 1,
		...over,
	};
}

/** Seed the fake with an existing row for the identity carrying a given hash + jsonb. */
function seedRow(store: FakeStore, snapshot: Snapshot, sha256: string, createdAt = "2026-01-01T00:00:00.000Z"): void {
	store.rows.push({
		snapshot_sha256: sha256,
		snapshot_jsonb: JSON.stringify(snapshot),
		created_at: createdAt,
		commit_sha: IDENTITY.commit,
	});
}

// ════════════════════════════════════════════════════════════════════════════
// c-AC-1 — already-current no-op + drift refuse (NO INSERT).
// ════════════════════════════════════════════════════════════════════════════

describe("c-AC-1 push drift detection (already-current no-op; drift refuses overwrite)", () => {
	it("matching snapshot_sha256 for the identity → already-current no-op, no INSERT", async () => {
		const { snapshot, sha256 } = await realSnapshot();
		const store = new FakeStore();
		seedRow(store, snapshot, sha256);

		const outcome = await pushSnapshot(snapshot, sha256, IDENTITY, ctxFor(store));

		expect(outcome.kind).toBe("already-current");
		expect(store.insertCount(), "an already-current push writes nothing").toBe(0);
	});

	it("DIFFERING hash for the same identity → drift, logged, REFUSES to overwrite (no INSERT)", async () => {
		const { snapshot, sha256 } = await realSnapshot();
		const store = new FakeStore();
		// A row already exists for the identity with a DIFFERENT stored hash.
		seedRow(store, snapshot, "sha-stored-different");
		const { logger, warns } = fakeLogger();

		const outcome = await pushSnapshot(snapshot, sha256, IDENTITY, ctxFor(store, { logger }));

		expect(outcome.kind).toBe("drift");
		if (outcome.kind === "drift") {
			expect(outcome.storedSha256).toBe("sha-stored-different");
			expect(outcome.incomingSha256).toBe(sha256);
		}
		expect(warns).toContain("push-drift");
		// THE load-bearing assertion: drift NEVER clobbers — zero INSERT statements.
		expect(store.insertCount(), "drift must not overwrite the stored row").toBe(0);
		// And the stored row is untouched.
		expect(store.rows).toHaveLength(1);
		expect(store.rows[0].snapshot_sha256).toBe("sha-stored-different");
	});

	it("no existing row → INSERT lands and reports inserted", async () => {
		const { snapshot, sha256 } = await realSnapshot();
		const store = new FakeStore();

		const outcome = await pushSnapshot(snapshot, sha256, IDENTITY, ctxFor(store));

		expect(outcome.kind).toBe("inserted");
		expect(store.insertCount()).toBe(1);
		expect(store.rows[0].snapshot_sha256).toBe(sha256);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// c-AC-2 — pull hash revalidation refuses a tampered payload.
// ════════════════════════════════════════════════════════════════════════════

describe("c-AC-2 pull hash revalidation (recomputed hash must == claimed or REFUSED)", () => {
	it("a faithful row → pulled (recomputed hash matches the claimed snapshot_sha256)", async () => {
		const { snapshot, sha256 } = await realSnapshot();
		const store = new FakeStore();
		seedRow(store, snapshot, sha256);

		const outcome = await pullSnapshot(IDENTITY, ctxFor(store), { headCommit: IDENTITY.commit });

		expect(outcome.kind).toBe("pulled");
		if (outcome.kind === "pulled") expect(outcome.sha256).toBe(sha256);
	});

	it("a TAMPERED snapshot_jsonb (stable field mutated) → REFUSED, never enters the cache", async () => {
		const { snapshot, sha256 } = await realSnapshot();
		const store = new FakeStore();
		// Poison the payload: mutate a STABLE field (a node name) but keep the CLAIMED
		// hash. The recomputed stable-field hash now differs → must be refused.
		const tampered: Snapshot = {
			...snapshot,
			nodes: snapshot.nodes.map((n, i) => (i === 0 ? { ...n, name: `${n.name}-TAMPERED` } : n)),
		};
		seedRow(store, tampered, sha256); // claims the ORIGINAL hash
		const { logger, warns } = fakeLogger();

		const outcome = await pullSnapshot(IDENTITY, ctxFor(store, { logger }), { headCommit: IDENTITY.commit });

		expect(outcome.kind).toBe("refused");
		if (outcome.kind === "refused") expect(outcome.reason).toBe("hash-mismatch");
		expect(warns).toContain("pull-hash-mismatch");
	});

	it("a structurally malformed jsonb → REFUSED (malformed-payload)", async () => {
		const store = new FakeStore();
		store.rows.push({
			snapshot_sha256: "whatever",
			snapshot_jsonb: '{"not":"a snapshot"}',
			created_at: "2026-01-01T00:00:00.000Z",
			commit_sha: IDENTITY.commit,
		});

		const outcome = await pullSnapshot(IDENTITY, ctxFor(store), { headCommit: IDENTITY.commit });

		expect(outcome.kind).toBe("refused");
		if (outcome.kind === "refused") expect(outcome.reason).toBe("malformed-payload");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// c-AC-3 — push skipped silently (no auth / no commit / env disabled).
// ════════════════════════════════════════════════════════════════════════════

describe("c-AC-3 push skipped silently (no auth / no commit / HONEYCOMB_GRAPH_PUSH=0)", () => {
	it("no auth → skipped, nothing queried", async () => {
		const { snapshot, sha256 } = await realSnapshot();
		const store = new FakeStore();

		const outcome = await pushSnapshot(snapshot, sha256, IDENTITY, ctxFor(store, { authenticated: false }));

		expect(outcome.kind).toBe("skipped");
		if (outcome.kind === "skipped") expect(outcome.reason).toBe("no-auth");
		expect(store.statements, "a skipped push touches storage zero times").toHaveLength(0);
	});

	it("no commit context → skipped", async () => {
		const { snapshot, sha256 } = await realSnapshot({ ...IDENTITY, commit: "" });
		const store = new FakeStore();

		const outcome = await pushSnapshot(snapshot, sha256, { ...IDENTITY, commit: "  " }, ctxFor(store));

		expect(outcome.kind).toBe("skipped");
		if (outcome.kind === "skipped") expect(outcome.reason).toBe("no-commit");
		expect(store.statements).toHaveLength(0);
	});

	it("HONEYCOMB_GRAPH_PUSH=0 → skipped (disabled-env)", async () => {
		const { snapshot, sha256 } = await realSnapshot();
		const store = new FakeStore();
		process.env.HONEYCOMB_GRAPH_PUSH = "0";

		const outcome = await pushSnapshot(snapshot, sha256, IDENTITY, ctxFor(store));

		expect(outcome.kind).toBe("skipped");
		if (outcome.kind === "skipped") expect(outcome.reason).toBe("disabled-env");
		expect(store.statements).toHaveLength(0);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// c-AC-4 — push failure is non-blocking (logs, does NOT throw).
// ════════════════════════════════════════════════════════════════════════════

describe("c-AC-4 push failure is non-blocking (logs, no throw, local stays authoritative)", () => {
	it("a SELECT storage error → failed outcome, no throw", async () => {
		const { snapshot, sha256 } = await realSnapshot();
		const store = new FakeStore();
		store.failOn = (sql) => sql.trimStart().toUpperCase().startsWith("SELECT");
		const { logger, warns } = fakeLogger();

		const outcome = await pushSnapshot(snapshot, sha256, IDENTITY, ctxFor(store, { logger }));

		expect(outcome.kind).toBe("failed");
		expect(warns).toContain("push-select-failed");
	});

	it("an INSERT storage error → failed outcome, no throw", async () => {
		const { snapshot, sha256 } = await realSnapshot();
		const store = new FakeStore();
		store.failOn = (sql) => sql.trimStart().toUpperCase().startsWith("INSERT");
		const { logger, warns } = fakeLogger();

		const outcome = await pushSnapshot(snapshot, sha256, IDENTITY, ctxFor(store, { logger }));

		expect(outcome.kind).toBe("failed");
		expect(warns).toContain("push-insert-failed");
	});

	it("does not reject the promise on a backend failure", async () => {
		const { snapshot, sha256 } = await realSnapshot();
		const store = new FakeStore();
		store.failOn = () => true;
		const spy = vi.fn();

		await pushSnapshot(snapshot, sha256, IDENTITY, ctxFor(store)).then(spy);

		expect(spy).toHaveBeenCalledOnce();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// c-AC-5 — >1 row after insert → inserted-with-duplicate-race.
// ════════════════════════════════════════════════════════════════════════════

describe("c-AC-5 duplicate race after insert (>1 row → inserted-with-duplicate-race)", () => {
	it("a concurrent writer doubled the row → inserted-with-duplicate-race", async () => {
		const { snapshot, sha256 } = await realSnapshot();
		const store = new FakeStore();
		// Simulate a race: the post-insert re-verify count SELECT (no LIMIT) sees TWO
		// rows. We pre-seed one phantom row that only the COUNT scan returns, while the
		// presence probe (LIMIT 1) returns empty first so the INSERT path is taken.
		let insertSeen = false;
		const racingStore = new FakeStore();
		racingStore.query = async (sql: string, scope: QueryScope): Promise<QueryResult> => {
			racingStore.statements.push(sql);
			const head = sql.trimStart().slice(0, 6).toUpperCase();
			if (head.startsWith("INSERT")) {
				insertSeen = true;
				return ok([], 1);
			}
			if (head.startsWith("SELECT")) {
				if (/LIMIT 1/i.test(sql)) return ok([], 1); // presence probe: absent → take INSERT
				// the count re-verify (no LIMIT): after insert, a race shows TWO rows
				const two = [
					{ snapshot_sha256: sha256 },
					{ snapshot_sha256: sha256 },
				] as StorageRow[];
				return ok(insertSeen ? two : [], 1);
			}
			return ok([], 1);
		};
		const { logger, warns } = fakeLogger();

		const outcome = await pushSnapshot(snapshot, sha256, IDENTITY, {
			storage: racingStore,
			scope: SCOPE,
			authenticated: true,
			verifyPolls: 1,
			logger,
		});

		expect(outcome.kind).toBe("inserted-with-duplicate-race");
		if (outcome.kind === "inserted-with-duplicate-race") expect(outcome.rowCount).toBe(2);
		expect(warns).toContain("push-duplicate-race");
		expect(store).toBeDefined();
	});
});

// ════════════════════════════════════════════════════════════════════════════
// c-AC-6 — older commit checked out locally → pull (not "local newer").
// ════════════════════════════════════════════════════════════════════════════

describe("c-AC-6 commit-ordering (older commit checked out → pull, not local-newer)", () => {
	it("local snapshot is for a DIFFERENT (older) commit than HEAD → pulls", async () => {
		const { snapshot, sha256 } = await realSnapshot();
		const store = new FakeStore();
		seedRow(store, snapshot, sha256);

		// HEAD is at IDENTITY.commit; the local snapshot was built for an OLDER commit.
		const outcome = await pullSnapshot(IDENTITY, ctxFor(store), {
			localCommit: "older-commit",
			headCommit: IDENTITY.commit,
		});

		expect(outcome.kind, "an older local commit must PULL, not claim local-newer").toBe("pulled");
	});

	it("local snapshot is for the SAME commit as HEAD → local-newer (skip the fetch)", async () => {
		const { snapshot, sha256 } = await realSnapshot();
		const store = new FakeStore();
		seedRow(store, snapshot, sha256);

		const outcome = await pullSnapshot(IDENTITY, ctxFor(store), {
			localCommit: IDENTITY.commit,
			headCommit: IDENTITY.commit,
		});

		expect(outcome.kind).toBe("local-newer");
		expect(store.statements, "local-newer short-circuits before any query").toHaveLength(0);
	});

	it("no local snapshot at all → pulls", async () => {
		const { snapshot, sha256 } = await realSnapshot();
		const store = new FakeStore();
		seedRow(store, snapshot, sha256);

		const outcome = await pullSnapshot(IDENTITY, ctxFor(store), { headCommit: IDENTITY.commit });

		expect(outcome.kind).toBe("pulled");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// READ-PATH GUARD (PRD-002c) — a read against a not-yet-created `codebase` table
// must NEVER issue a SELECT against it (which the backend logs as 42P01) and must
// NEVER create it from the read. Creation stays on the WRITE (INSERT) path.
//
// Regression for the production 42P01 storm: the codebase push/pull reads were
// routed through `withHeal`, so the very first SELECT against an absent table hit
// the backend as `relation "codebase" does not exist` (logged) BEFORE the heal
// created it. The fix probes `information_schema.tables` first and skips the read
// when the table is absent.
// ════════════════════════════════════════════════════════════════════════════

/**
 * A catalog-aware fake that models table EXISTENCE explicitly. The existence
 * probe (`information_schema.tables`) is answered from `exists`; a SELECT against
 * the `codebase` table while it does NOT exist models the backend 42P01 — the
 * branch the fix must make unreachable. An INSERT/CREATE flips `exists` true.
 */
class CatalogFake {
	readonly statements: string[] = [];
	rows: FakeRow[] = [];
	constructor(public exists: boolean) {}

	async query(sql: string, _scope: QueryScope): Promise<QueryResult> {
		this.statements.push(sql);
		const head = sql.trimStart().slice(0, 6).toUpperCase();
		if (head.startsWith("SELECT")) {
			if (/information_schema\.tables/i.test(sql)) {
				return ok(this.exists ? [{ "1": 1 } as StorageRow] : [], 1);
			}
			// A real read against the table. If the table is absent this is the
			// backend 42P01 — the WHOLE POINT of the fix is that this never runs.
			if (!this.exists) return queryError('relation "codebase" does not exist', 500);
			if (/ORDER BY/i.test(sql)) {
				const sorted = [...this.rows].sort((a, b) => (a.created_at < b.created_at ? 1 : -1));
				return ok(sorted.slice(0, 1), 1);
			}
			if (/LIMIT 1/i.test(sql)) return ok(this.rows.slice(0, 1), 1);
			return ok([...this.rows], 1);
		}
		if (head.startsWith("INSERT")) {
			this.exists = true;
			this.rows.push(parseInsertRow(sql));
			return ok([], 1);
		}
		if (head.startsWith("CREATE")) {
			this.exists = true;
			return ok([], 1);
		}
		return ok([], 1);
	}

	/** SELECTs that touch the real table (the ones that would 42P01 on an absent table). */
	tableSelects(): string[] {
		return this.statements.filter((s) => /SELECT/i.test(s) && /FROM "codebase"/.test(s));
	}

	probeCount(): number {
		return this.statements.filter((s) => /information_schema\.tables/i.test(s)).length;
	}

	createCount(): number {
		return this.statements.filter((s) => s.trimStart().toUpperCase().startsWith("CREATE")).length;
	}

	firstIndex(pred: (s: string) => boolean): number {
		return this.statements.findIndex(pred);
	}
}

describe("read-path guard (a read never SELECTs — nor creates — an absent table)", () => {
	it("pull against an ABSENT table → not-found, probes the catalog, issues NO table SELECT and NO CREATE", async () => {
		const store = new CatalogFake(false);

		const outcome = await pullSnapshot(IDENTITY, ctxFor(store), { headCommit: IDENTITY.commit });

		expect(outcome.kind, "an absent table is a clean miss, not a failure").toBe("not-found");
		expect(store.probeCount(), "the read consults information_schema first").toBeGreaterThan(0);
		expect(store.tableSelects(), "NO SELECT is issued against the absent table (the 42P01 source)").toHaveLength(0);
		expect(store.createCount(), "a read must NEVER create the table").toBe(0);
	});

	it("pull against a PRESENT table → reads it (probe says exists, then the table SELECT runs)", async () => {
		const { snapshot, sha256 } = await realSnapshot();
		const store = new CatalogFake(true);
		seedRow(store, snapshot, sha256);

		const outcome = await pullSnapshot(IDENTITY, ctxFor(store), { headCommit: IDENTITY.commit });

		expect(outcome.kind).toBe("pulled");
		expect(store.tableSelects().length, "a present table IS read").toBeGreaterThan(0);
	});

	it("push against an ABSENT table → inserts, with NO pre-INSERT SELECT against the table", async () => {
		const { snapshot, sha256 } = await realSnapshot();
		const store = new CatalogFake(false);

		const outcome = await pushSnapshot(snapshot, sha256, IDENTITY, ctxFor(store));

		expect(outcome.kind, "a fresh push inserts the row").toBe("inserted");
		// The create stays on the WRITE path: any table SELECT (the post-insert
		// re-verify) only happens AFTER the INSERT, never before it as a probe.
		const firstInsert = store.firstIndex((s) => s.trimStart().toUpperCase().startsWith("INSERT"));
		const firstTableSelect = store.firstIndex((s) => /SELECT/i.test(s) && /FROM "codebase"/.test(s));
		expect(firstInsert, "the push must INSERT").toBeGreaterThanOrEqual(0);
		expect(
			firstTableSelect === -1 || firstTableSelect > firstInsert,
			"no SELECT against the table precedes the INSERT (no 42P01 probe)",
		).toBe(true);
	});
});
