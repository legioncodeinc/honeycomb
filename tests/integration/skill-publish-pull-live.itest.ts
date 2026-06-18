/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE skill-publish/select SMOKE — OPT-IN, MUTATES A REAL DEEPLAKE BACKEND.║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-018a a-AC-1 / a-AC-5 / a-AC-6 / D-7: the daemon-side publish/select    ║
 * ║  endpoint is APPEND-ONLY, VERSION-BUMPED, and select-newer resolves the    ║
 * ║  HIGHEST version per (name, author) POLL-CONVERGENTLY. This suite publishes ║
 * ║  a skill at v1 through the endpoint, republishes at v2, then                ║
 * ║  selectNewerForOrgUsers() and asserts it resolves v2 (not v1) — proving the ║
 * ║  team read converges LIVE on the durable highest version.                  ║
 * ║                                                                          ║
 * ║  GATED + NATIVELY ISOLATED (modeled on skills-write-live / synthesis-live):║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = whole suite  ║
 * ║      skips, run exits 0.                                                  ║
 * ║    - `.itest.ts` suffix keeps it OUT of `npm run test` / `npm run ci`;      ║
 * ║      only `npm run test:integration` runs it.                            ║
 * ║    - Throwaway-table isolation is NATIVE: the endpoint's `resolveTable`     ║
 * ║      seam routes the canonical `skills` name to a per-run `ci_skills_<id>`  ║
 * ║      table, which the heal CREATEs DIRECTLY on first write (NOT a SQL-      ║
 * ║      string proxy, which races the heal). DROPped in afterAll.            ║
 * ║    - `queryTimeoutMs: 120_000`.                                          ║
 * ║                                                                          ║
 * ║  POLL-CONVERGENT read-backs: a single immediate read on this backend can   ║
 * ║  under-report a version; the endpoint polls and takes the MAX, converging  ║
 * ║  UP to the durable v2 (a read can miss a version but never invents one).   ║
 * ║                                                                          ║
 * ║  SECRETS: the token is read ONLY from the env via `envCredentialProvider`. ║
 * ║  Never hardcoded, logged, or echoed.                                     ║
 * ║                                                                          ║
 * ║  Do NOT run this locally (no creds) — the orchestrator runs it.           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createStorageClient,
	envCredentialProvider,
	isOk,
	type QueryScope,
	resolveStorageConfig,
	sqlIdent,
	type StorageClient,
} from "../../src/daemon/storage/index.js";
import {
	createSkillPublishEndpoint,
	type Skill,
	skillLogicalId,
} from "../../src/daemon/runtime/skillify/index.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
/** The per-run THROWAWAY table — the `skills` shape, isolated, DROPped in teardown. */
const TBL_SKILLS = `ci_skills_${RUN_ID}`;

const AUTHOR = "ci-publisher";
const NAME = "ci-shared-skill";

function skillAt(version: number, body: string): Skill {
	return {
		id: skillLogicalId(NAME, AUTHOR),
		name: NAME,
		author: AUTHOR,
		description: "a ci team skill",
		triggerText: "when CI runs",
		body,
		install: "global",
		provenance: { sourceSessions: [`ci-sess-${version}`], version, createdBy: AUTHOR, scope: "team" },
	};
}

describe.skipIf(!HAS_TOKEN)("live skill publish/select smoke (opt-in, real backend, append-only highest-version)", () => {
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
		const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(TBL_SKILLS)}"`, scope);
		if (!isOk(res)) console.warn(`[ci-cleanup] could not drop ${TBL_SKILLS}: ${JSON.stringify(res)}`);
	});

	it("publishes v1 then v2 through the daemon endpoint; select-newer resolves the HIGHEST version (v2)", async () => {
		// Route the canonical `skills` name to the per-run throwaway table NATIVELY via the
		// endpoint's `resolveTable` seam — the heal CREATEs the physical throwaway table
		// directly (the proven skills-write-live / synthesis-live isolation technique).
		const resolveTable = (canonical: string): string => (canonical === "skills" ? TBL_SKILLS : canonical);
		const endpoint = createSkillPublishEndpoint(storage, scope, resolveTable);

		// Publish v1 (first write lazily CREATEs the throwaway table from the skills ColumnDef).
		const v1 = await endpoint.publish(skillAt(1, "## version one body"));
		expect(v1).toBe(1);

		// Republish at v2 — a NEW version row, never an in-place UPDATE of v1.
		const v2 = await endpoint.publish(skillAt(2, "## version two body"));
		expect(v2).toBe(2);

		// select-newer-for-org-users resolves the HIGHEST version per (name, author),
		// poll-convergently → v2 (the durable current row), not the stale v1.
		const skills = await endpoint.selectNewerForOrgUsers();
		const mine = skills.find((s) => s.name === NAME && s.author === AUTHOR);
		expect(mine, "the published skill resolved").toBeDefined();
		expect(mine?.version).toBe(2);
		expect(mine?.body).toContain("version two body");
	});
});
