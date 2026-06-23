/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE recall-AUTHORIZATION SMOKE — OPT-IN, SEEDS A REAL DEEPLAKE BACKEND. ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-007c / PRD-045b: the authorization boundary (the scope re-query) is    ║
 * ║  the retained `buildScopeClause` chokepoint. The dormant five-phase engine  ║
 * ║  (and its `recall/authorization.ts` re-query builder) was de-scoped; this    ║
 * ║  suite proves the SAME `buildScopeClause` predicate — ANDed into an IDs-only ║
 * ║  re-query built inline here — authorizes REAL rows on a REAL                ║
 * ║  `memories`-shaped table on this DeepLake store:                          ║
 * ║                                                                          ║
 * ║    - Two agents seeded into ONE throwaway table: agent A (isolated) owns   ║
 * ║      two rows; agent B owns one row. All under the SAME org/workspace      ║
 * ║      partition.                                                            ║
 * ║    - The isolated re-query for agent A (over the collected candidate IDs   ║
 * ║      of BOTH agents) returns ONLY agent A's own rows; agent B's row is     ║
 * ║      EXCLUDED — IDs only, no content column.                               ║
 * ║    - An archived (is_deleted=1) row of agent A is ALSO excluded.           ║
 * ║                                                                          ║
 * ║  These are the SAME builders the authorization phase emits, re-pointed at  ║
 * ║  a THROWAWAY table seeded from the single-sourced MEMORIES_COLUMNS, DROPped║
 * ║  in afterAll (exactly like recall-collection-live.itest.ts).              ║
 * ║                                                                          ║
 * ║  GATED + ISOLATED:                                                        ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = whole       ║
 * ║      suite skips, run exits 0.                                            ║
 * ║    - `.itest.ts` suffix keeps it OUT of `npm run test` / `npm run ci`.     ║
 * ║      Run only via `npm run test:integration`.                            ║
 * ║    - Seeds a per-run THROWAWAY table (`ci_authz_<run-id>`) and DROPs it.   ║
 * ║                                                                          ║
 * ║  SECRETS: the token is read ONLY from the env via the storage layer's    ║
 * ║  `envCredentialProvider`. Never hardcoded, logged, or echoed.            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	appendOnlyInsert,
	createStorageClient,
	envCredentialProvider,
	isOk,
	resolveStorageConfig,
	type RowValues,
	sLiteral,
	sqlIdent,
	type StorageClient,
	val,
} from "../../src/daemon/storage/index.js";
import { MEMORIES_COLUMNS, NOT_SOFT_DELETED, SOFT_DELETED } from "../../src/daemon/storage/catalog/index.js";
import type { HealTarget } from "../../src/daemon/storage/heal.js";
import { buildScopeClause, type ScopeClause } from "../../src/daemon/runtime/recall/index.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
const CI_TABLE = `ci_authz_${RUN_ID}`;
const AGENT_A = "ci-authz-agent-a";
const AGENT_B = "ci-authz-agent-b";

const ID_A_1 = `authz_${RUN_ID}_a1`;
const ID_A_2 = `authz_${RUN_ID}_a2`;
const ID_A_ARCHIVED = `authz_${RUN_ID}_a_arch`;
const ID_B_1 = `authz_${RUN_ID}_b1`;

/** The throwaway `memories`-shaped HealTarget (single-sourced MEMORIES_COLUMNS). */
const ciTarget: HealTarget = { table: CI_TABLE, columns: [...MEMORIES_COLUMNS] };

/** Build a seed `memories` row (IDs-only authorization reads it; we seed scope columns). */
function seedRow(args: { id: string; agent: string; content: string; archived: boolean; now: string }): RowValues {
	return [
		["id", val.str(args.id)],
		["type", val.str("fact")],
		["content", val.text(args.content)],
		["normalized_content", val.text(args.content.toLowerCase())],
		["content_hash", val.str(`hash-${args.id}`)],
		["is_deleted", val.num(args.archived ? SOFT_DELETED : NOT_SOFT_DELETED)],
		["agent_id", val.str(args.agent)],
		["visibility", val.str("global")],
		["created_at", val.str(args.now)],
		["updated_at", val.str(args.now)],
	];
}

function describeResult(r: { kind: string }): string {
	return r.kind;
}

/**
 * Build the IDs-only authorization re-query inline (PRD-045b): `SELECT id ... FROM
 * <CI table> WHERE id IN (<candidates>) AND (<scope clause>)`. This is the exact
 * shape the (now de-scoped) authorization phase emitted — a guarded IDs-only SELECT
 * that ANDs in the retained `buildScopeClause` predicate. Every candidate id routes
 * through `sLiteral`; the table + columns through `sqlIdent` (audit-safe). Returns ""
 * for an empty candidate set (the phase short-circuited rather than emit `IN ()`).
 */
function buildAuthzRequery(candidateIds: readonly string[], clause: ScopeClause): string {
	if (candidateIds.length === 0) return "";
	const tbl = sqlIdent(CI_TABLE);
	const idCol = sqlIdent("id");
	const inList = candidateIds.map((id) => sLiteral(id)).join(", ");
	return `SELECT ${idCol} AS id FROM "${tbl}" WHERE ${idCol} IN (${inList}) AND (${clause.sql})`;
}

/**
 * How many times the authorization re-query is polled, unioning the ids it observes.
 * WHY (and why this is NOT a security crutch): this backend serves a bare scan from
 * segments of differing freshness that flap NON-MONOTONICALLY, so a SINGLE immediate
 * re-query of just-seeded rows can return a STALE subset (live evidence: agent A owns
 * two durable rows but one immediate read returned only `[a2]` — the failure that kept
 * main's gated integration job red across PR #9/#10/#11). This is the same fact behind
 * `graph-persist-live.itest.ts`'s `scanDistinct` and `services/job-queue.ts`'s polled
 * `discoverIds`. A scan can MISS a row on a stale segment but NEVER INVENTS one, so
 * unioning across polls converges UP to the durable truth — it can only turn a
 * false-absent into a true-present. Crucially the union stays STRICT for the boundary:
 * the authorization clause can only ever return rows that satisfy it, so a cross-agent
 * or archived leak on ANY poll would land in the union and fail the exclusion asserts.
 * Convergence makes the exact-set assertion MEANINGFUL rather than flaky; it does not
 * weaken it.
 */
const SCAN_POLLS = 20;

/**
 * Poll an authorization re-query {@link SCAN_POLLS} times and return the UNION of the
 * ids observed. Also asserts IDs-only (no `content` column) on EVERY observed row, so
 * the "content never loads pre-authorization" guarantee is checked on every poll.
 */
async function pollAuthorizedIds(
	storage: StorageClient,
	sql: string,
	scope: { org: string; workspace: string },
): Promise<Set<string>> {
	const seen = new Set<string>();
	for (let poll = 0; poll < SCAN_POLLS; poll++) {
		const res = await storage.query(sql, scope);
		expect(res.kind, `authz re-query must succeed: ${describeResult(res)}`).toBe("ok");
		if (isOk(res)) {
			for (const row of res.rows) {
				// IDs only — no content column may come back from an authorization read.
				expect(row.content).toBeUndefined();
				seen.add(String(row.id));
			}
		}
	}
	return seen;
}

describe.skipIf(!HAS_TOKEN)("live recall-authorization smoke (opt-in, real backend)", () => {
	let storage: StorageClient;
	let org: string;
	let workspace: string;

	beforeAll(async () => {
		const raw = envCredentialProvider().read();
		const provider = {
			read: () => ({
				...raw,
				workspace: process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "honeycomb_ci",
				// First-touch on a fresh throwaway table lazily heals (CREATE TABLE + retry),
				// which can exceed the 10s default. Give the live round-trip room.
				queryTimeoutMs: 120_000,
			}),
		};
		const config = resolveStorageConfig(provider);
		org = config.org;
		workspace = config.workspace;
		storage = createStorageClient({ provider });

		const scope = { org, workspace };
		const now = "2026-06-17T00:00:00.000Z";
		// Agent A: two live rows + one archived row. Agent B: one live row. ALL same partition.
		const seeds: RowValues[] = [
			seedRow({ id: ID_A_1, agent: AGENT_A, content: `agent A note one ${RUN_ID}`, archived: false, now }),
			seedRow({ id: ID_A_2, agent: AGENT_A, content: `agent A note two ${RUN_ID}`, archived: false, now }),
			seedRow({ id: ID_A_ARCHIVED, agent: AGENT_A, content: `agent A archived ${RUN_ID}`, archived: true, now }),
			seedRow({ id: ID_B_1, agent: AGENT_B, content: `agent B note ${RUN_ID}`, archived: false, now }),
		];
		for (const [i, row] of seeds.entries()) {
			const r = await appendOnlyInsert(storage, ciTarget, scope, row);
			expect(r.kind, `seed ${i} must succeed: ${describeResult(r)}`).toBe("ok");
		}
	});

	afterAll(async () => {
		if (!storage) return;
		const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(CI_TABLE)}"`, { org, workspace });
		if (!isOk(res)) console.warn(`[ci-cleanup] could not drop ${CI_TABLE} in ${workspace}: ${describeResult(res)}`);
	});

	it("an isolated agent A re-query over BOTH agents' candidate IDs returns ONLY agent A's own live rows", async () => {
		const scope = { org, workspace };
		// The collected candidate pool (post collection/traversal) includes EVERY agent's ids
		// — collection is unauthorized by design (a-AC). Authorization is the boundary.
		const candidateIds = [ID_A_1, ID_A_2, ID_A_ARCHIVED, ID_B_1];

		// The SAME clause the authorization phase compiles for an isolated agent A.
		const clause = buildScopeClause({
			agentId: AGENT_A,
			readPolicy: "isolated",
			org,
			workspace,
		});
		expect(clause.policyApplied).toBe("isolated");

		// The IDs-only re-query: candidate IN-list ANDed with the retained scope clause.
		const sql = buildAuthzRequery(candidateIds, clause);
		expect(sql).not.toBe("");

		// Poll-union the re-query: converges UP to agent A's two durable rows while the
		// authorization clause keeps the set STRICT (B's row + the archived row can never
		// satisfy it, so they can never enter the union).
		const seen = await pollAuthorizedIds(storage, sql, scope);
		const ids = [...seen].sort();
		// Only agent A's own LIVE rows survive.
		expect(ids).toEqual([ID_A_1, ID_A_2].sort());
		// Agent B's row is EXCLUDED — the isolated boundary does not leak cross-agent.
		expect(seen.has(ID_B_1)).toBe(false);
		// The archived row of agent A is EXCLUDED (is_deleted = 0 conjunct).
		expect(seen.has(ID_A_ARCHIVED)).toBe(false);
	});

	it("a different agent B re-query returns ONLY agent B's row, never agent A's", async () => {
		const scope = { org, workspace };
		const candidateIds = [ID_A_1, ID_A_2, ID_B_1];
		const clause = buildScopeClause({ agentId: AGENT_B, readPolicy: "isolated", org, workspace });
		const sql = buildAuthzRequery(candidateIds, clause);
		const seen = await pollAuthorizedIds(storage, sql, scope);
		expect([...seen]).toEqual([ID_B_1]);
		expect(seen.has(ID_A_1)).toBe(false);
		expect(seen.has(ID_A_2)).toBe(false);
	});
});
