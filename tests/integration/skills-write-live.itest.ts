/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE skills-write SMOKE — OPT-IN, MUTATES A REAL DEEPLAKE BACKEND.       ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-016b b-AC-1: a skills edit is APPEND-ONLY, VERSION-BUMPED — the       ║
 * ║  active skill is the HIGHEST version per (name, author). This suite        ║
 * ║  appends TWO versions of one skill to the REAL backend through the SAME    ║
 * ║  `createSkillStore` path the daemon uses, then asserts the highest-version ║
 * ║  read returns v2 — proving the append-only-never-UPDATE write converges    ║
 * ║  LIVE (the v1 row is retained on disk; the read resolves v2 as current).   ║
 * ║                                                                          ║
 * ║  GATED + NATIVELY ISOLATED (modeled on sources-purge-live / graph-persist):║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = whole        ║
 * ║      suite skips, run exits 0.                                            ║
 * ║    - `.itest.ts` suffix keeps it OUT of `npm run test` / `npm run ci`.     ║
 * ║      Only `npm run test:integration` runs it.                            ║
 * ║    - Throwaway-table isolation is NATIVE: `createSkillStore`'s             ║
 * ║      `resolveTable` seam routes the canonical `skills` name to a per-run   ║
 * ║      `ci_skills_<runid>` table, which the heal CREATEs DIRECTLY on first   ║
 * ║      write (its real ColumnDef shape) — NOT a SQL-string proxy (which      ║
 * ║      races the heal's CREATE/introspect/ALTER and corrupts a fresh table). ║
 * ║      DROPped in afterAll. Never touches the real `skills` table.          ║
 * ║    - `queryTimeoutMs: 120_000`.                                          ║
 * ║                                                                          ║
 * ║  POLL-CONVERGENT read-backs: this backend serves a read from segments of  ║
 * ║  differing freshness that flap NON-MONOTONICALLY, so a SINGLE immediate    ║
 * ║  read of a just-written row can under-report the version. The store's      ║
 * ║  highest-version read polls and takes the MAX — a read can miss a version  ║
 * ║  but never invents one, so polling converges UP to the durable v2.        ║
 * ║                                                                          ║
 * ║  SECRETS: the token is read ONLY from the env via the storage layer's     ║
 * ║  `envCredentialProvider`. Never hardcoded, logged, or echoed.            ║
 * ║                                                                          ║
 * ║  Do NOT run this locally (no creds) — the orchestrator runs it.           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	type ConvergeBudgetOverride,
	createStorageClient,
	envCredentialProvider,
	isOk,
	minVersion,
	type QueryScope,
	readConverged,
	resolveStorageConfig,
	sLiteral,
	sqlIdent,
	type StorageClient,
} from "../../src/daemon/storage/index.js";
import {
	createSkillStore,
	type Skill,
	skillLogicalId,
} from "../../src/daemon/runtime/skillify/index.js";
import { neutralizeIfInfraDegraded } from "./_infra-skip.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
/** The per-run THROWAWAY table — the `skills` shape, isolated, DROPped in teardown. */
const TBL_SKILLS = `ci_skills_${RUN_ID}`;

const AUTHOR = "ci-author";

function skillAt(version: number, body: string): Skill {
	const name = "ci-skill";
	return {
		id: skillLogicalId(name, AUTHOR),
		name,
		author: AUTHOR,
		description: "a ci skill",
		triggerText: "when CI runs",
		body,
		install: "project",
		provenance: { sourceSessions: [`ci-sess-${version}`], version, createdBy: AUTHOR, scope: "me" },
	};
}

describe.skipIf(!HAS_TOKEN)("live skills-write smoke (opt-in, real backend, append-only version-bumped)", () => {
	let storage: StorageClient;
	let scope: QueryScope;

	beforeAll(() => {
		const raw = envCredentialProvider().read();
		const provider = {
			read: () => ({
				...raw,
				workspace: process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "honeycomb_ci",
				queryTimeoutMs: 120_000,
			}),
		};
		const config = resolveStorageConfig(provider);
		scope = { org: config.org, workspace: config.workspace };
		storage = createStorageClient({ provider });
	});

	afterAll(async () => {
		if (!storage) return;
		// DROP is the reliable teardown on this backend (DELETE does not dependably remove rows).
		const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(TBL_SKILLS)}"`, scope);
		if (!isOk(res)) console.warn(`[ci-cleanup] could not drop ${TBL_SKILLS}: ${JSON.stringify(res)}`);
	});

	it("appends v1 then v2 of one skill; the highest-version read returns v2 (poll-convergent)", async ({ skip }) => {
		// INFRA-DEGRADED preflight (PRD-034a FR-4 / a-AC-3): if the backend is sustained-down
		// (a liveness probe flaps transient AFTER the client's retry), resolve NEUTRAL via a
		// SKIP + the run-level sentinel rather than red-ing the append-only proof on DeepLake
		// weather. A non-transient failure (real defect) or an ok probe continues with full teeth.
		await neutralizeIfInfraDegraded("skills-write-live:preflight", () => storage.connect(scope), skip);

		// Route the canonical `skills` name to the per-run throwaway table NATIVELY via the
		// store's `resolveTable` seam — the heal CREATEs the physical throwaway table
		// directly (the proven sources-purge / graph-persist isolation technique). A
		// SQL-string proxy was tried first elsewhere and FAILED: rewriting the table name
		// inside the heal's CREATE/introspect/ALTER races the fresh-table propagation and
		// corrupts it ("column id already exists"), so writes silently never landed.
		const resolveTable = (canonical: string): string => (canonical === "skills" ? TBL_SKILLS : canonical);
		const store = createSkillStore(storage, scope, resolveTable);
		const id = skillLogicalId("ci-skill", AUTHOR);

		// Append v1 (first write lazily CREATEs the throwaway table from the skills ColumnDef).
		const v1 = (await store.maxVersion(id)) + 1;
		expect(v1).toBe(1);
		await store.appendVersion(skillAt(v1, "## version one body"));

		// Append v2 — a NEW version row, never an in-place UPDATE of v1.
		const v2 = (await store.maxVersion(id)) + 1;
		expect(v2).toBe(2);
		await store.appendVersion(skillAt(v2, "## version two body"));

		// The ACTIVE skill is the highest version — poll-convergent read returns v2.
		const active = await store.readActive(id);
		expect(active, "active skill resolved").not.toBeNull();
		expect(active?.provenance.version).toBe(2);
		expect(active?.body).toContain("version two body");

		// The v1 row is RETAINED on disk (append-only): a direct count sees both versions.
		const countSql =
			`SELECT version FROM "${sqlIdent(TBL_SKILLS)}" ` +
			`WHERE ${sqlIdent("id")} = ${sLiteral(id)} ` +
			`ORDER BY version DESC`;
		// Poll-convergent through the ONE shared `readConverged` seam (PRD-028 D-4; PRD-034a
		// immediacy relaxation — no bespoke no-backoff loop). Converged once a segment serves
		// version ≥ 2 (the v2 append landed); the budget is generous + jittered so a slow
		// coalesce on a HEALTHY backend is not red-ed. The CORRECTNESS bar is untouched: the
		// converged result must carry BOTH v1 (retained, append-only) and v2 (present).
		const SKILLS_BUDGET: ConvergeBudgetOverride = { maxAttempts: 40, maxWallClockMs: 20_000, backoffBaseMs: 150, backoffCapMs: 1_000 };
		const res = await readConverged(storage, countSql, scope, minVersion("version", 2), { budget: SKILLS_BUDGET });
		const seen = new Set<number>();
		if (isOk(res)) {
			for (const row of res.rows) {
				const n = Number(row.version);
				if (Number.isFinite(n)) seen.add(n);
			}
		}
		expect(seen.has(1), "v1 retained on disk (append-only)").toBe(true);
		expect(seen.has(2), "v2 present").toBe(true);
	});
});
