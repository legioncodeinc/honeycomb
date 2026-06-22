/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE summary-worker FINAL-TRIGGER SMOKE — OPT-IN, MUTATES A REAL BACKEND.║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-046a a-AC-2: a FINAL-trigger summary job, dispatched through the      ║
 * ║  daemon-resident summary worker (the mount PRD-017 left deferred), drives  ║
 * ║  `runSummaryWorker` to write a `memory` summary row at                     ║
 * ║  `/summaries/<userName>/<sessionId>.md` — proven LIVE with a poll-         ║
 * ║  convergent read-back. This is the END-TO-END proof that the wiring        ║
 * ║  (enqueue → lease → runSummaryWorker → SELECT-before-INSERT write) lands a ║
 * ║  summary on a real backend.                                                ║
 * ║                                                                          ║
 * ║  GATED + NATIVELY ISOLATED (modeled on summary-write-live / memory-jobs-  ║
 * ║  live):                                                                   ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = whole       ║
 * ║      suite skips, run exits 0.                                            ║
 * ║    - `.itest.ts` suffix keeps it OUT of `npm run test` / `npm run ci`.     ║
 * ║    - Throwaway-table isolation is NATIVE: the queue points at a per-run    ║
 * ║      `ci_sumjobs_<runid>` table (its `tableName` seam); the summary store  ║
 * ║      + the sessions fetcher are routed to per-run `ci_summem_<runid>` /    ║
 * ║      `ci_sumsess_<runid>` tables via the worker's `buildDeps` override —   ║
 * ║      the heal CREATEs each DIRECTLY (its real ColumnDef shape). DROPped in ║
 * ║      afterAll. NEVER touches the real `memory` / `sessions` / `memory_jobs`║
 * ║      tables.                                                              ║
 * ║    - The host-CLI gate is FAKED (`createFakeSummaryGenCli`) — there is no  ║
 * ║      host agent CLI in CI; the worker's gate seam makes that injectable.   ║
 * ║      The a-AC-4 safety-env proof lives in the unit suite (the assembled    ║
 * ║      DEFAULT spawner). This live test proves the WRITE lands.             ║
 * ║    - `queryTimeoutMs: 120_000`. POLL-CONVERGENT read-backs.               ║
 * ║                                                                          ║
 * ║  SECRETS: the token is read ONLY from the env via the storage layer's     ║
 * ║  `envCredentialProvider`. Never hardcoded, logged, or echoed.            ║
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
	sLiteral,
	sqlIdent,
	type StorageClient,
} from "../../src/daemon/storage/index.js";
import { createJobQueueService } from "../../src/daemon/runtime/services/job-queue.js";
import { buildInsert, val } from "../../src/daemon/storage/writes.js";
import { healTargetFor } from "../../src/daemon/storage/catalog/index.js";
import { withHeal } from "../../src/daemon/storage/heal.js";
import {
	createFakeSummaryGenCli,
	createSummaryStore,
	createSummaryJobWorker,
	summaryPath,
	type SummarySession,
	type SummaryWorkerDeps,
	type SummaryWorkerDepsFactory,
} from "../../src/daemon/runtime/summaries/index.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
const TBL_JOBS = `ci_sumjobs_${RUN_ID}`;
const TBL_MEMORY = `ci_summem_${RUN_ID}`;
const TBL_SESSIONS = `ci_sumsess_${RUN_ID}`;

const SESSION: SummarySession = {
	sessionId: `ci-final-${RUN_ID}`,
	userName: "ci-user",
	path: `ci/final/${RUN_ID}`,
	agentId: "claude-code",
};

const SUMMARY_BODY = "## CI final-trigger summary\n\nThe worker wrote this end-to-end.";

describe.skipIf(!HAS_TOKEN)("live summary-worker final-trigger smoke (opt-in, real backend, end-to-end write)", () => {
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
		for (const tbl of [TBL_JOBS, TBL_MEMORY, TBL_SESSIONS]) {
			const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(tbl)}"`, scope);
			if (!isOk(res)) console.warn(`[ci-cleanup] could not drop ${tbl}: ${JSON.stringify(res)}`);
		}
	});

	it("enqueue → lease → runSummaryWorker writes /summaries/<userName>/<sessionId>.md (poll-convergent)", async () => {
		// Seed ONE real `sessions` event into the throwaway sessions table so the worker's
		// fetcher finds events (the gate is reached). The heal CREATEs the table on first write.
		const sessionsTarget = { table: TBL_SESSIONS, columns: healTargetFor("sessions").columns };
		const seedRow = [
			["id", val.str(`evt-${RUN_ID}`)],
			["path", val.str(SESSION.path)],
			["filename", val.str("user_message")],
			["message", val.text(JSON.stringify({ event: { kind: "user_message", text: "please summarize this session" } }))],
			["author", val.str("ci-user")],
			["agent", val.str("claude-code")],
			["project", val.str("/tmp/ci")],
			["plugin_version", val.str("ci")],
			["agent_id", val.str("ci-user")],
			["creation_date", val.str(new Date().toISOString())],
			["last_update_date", val.str(new Date().toISOString())],
		] as const;
		const insertSql = buildInsert(TBL_SESSIONS, seedRow);
		const seeded = await withHeal(storage, sessionsTarget, scope, () => storage.query(insertSql, scope));
		expect(isOk(seeded), "seed sessions event").toBe(true);

		// The durable queue pointed at the throwaway jobs table (its real ColumnDef shape).
		const queue = createJobQueueService({ storage, scope, config: { tableName: TBL_JOBS } });
		await queue.start();

		// The FINAL-trigger enqueue — exactly what the session-end handler enqueues.
		await queue.enqueue({
			kind: "summary",
			payload: {
				sessionId: SESSION.sessionId,
				path: SESSION.path,
				userName: SESSION.userName,
				agentId: SESSION.agentId,
				triggerKind: "final",
				reason: "SessionEnd",
				count: 0,
			},
		});

		// The worker's REAL buildDeps, routed to the throwaway memory/sessions tables + a FAKE
		// gate (no host CLI live). The store/fetcher are the REAL 017a seams; only the physical
		// table names + the gate are swapped (the proven native-isolation technique).
		const resolveMemory = (canonical: string): string => (canonical === "memory" ? TBL_MEMORY : canonical);
		const buildDeps: SummaryWorkerDepsFactory = (_session, _spec): SummaryWorkerDeps => ({
			lock: { acquire: () => ({ release() {} }) },
			fetcher: {
				async fetch(s) {
					// Read the throwaway sessions table directly (the real fetcher hardcodes the
					// canonical `sessions` name); the SELECT shape mirrors createSessionEventFetcher.
					const sql =
						`SELECT * FROM "${sqlIdent(TBL_SESSIONS)}" WHERE ${sqlIdent("path")} = ${sLiteral(s.path)} ` +
						`ORDER BY ${sqlIdent("creation_date")} ASC`;
					const res = await storage.query(sql, scope);
					if (!isOk(res)) return [];
					return (res.rows as Record<string, unknown>[]).map((r) => ({
						message: r.message,
						author: typeof r.author === "string" ? r.author : "",
						creationDate: typeof r.creation_date === "string" ? r.creation_date : "",
					}));
				},
			},
			gate: createFakeSummaryGenCli(SUMMARY_BODY),
			embed: { async embed() { return null; } },
			store: createSummaryStore(storage, scope, resolveMemory),
		});

		const worker = createSummaryJobWorker({
			queue,
			storage,
			scope,
			embed: { async embed() { return null; } },
			buildDeps,
		});

		// Drive ONE lease → runSummaryWorker → SELECT-before-INSERT write.
		const processed = await worker.runOnce();
		expect(processed, "the worker leased and ran the summary job").toBe(true);

		// Poll-convergent read-back of the summary row at the canonical path.
		const path = summaryPath(SESSION);
		const readSql =
			`SELECT summary FROM "${sqlIdent(TBL_MEMORY)}" ` +
			`WHERE ${sqlIdent("path")} = ${sLiteral(path)} ` +
			`AND ${sqlIdent("description")} != ${sLiteral("in progress")} ` +
			`ORDER BY creation_date DESC LIMIT 1`;
		let body: string | null = null;
		for (let poll = 0; poll < 40 && body === null; poll++) {
			const res = await storage.query(readSql, scope);
			if (isOk(res) && res.rows.length > 0) {
				const v = res.rows[0]?.summary;
				if (typeof v === "string") body = v;
			}
			if (body === null) await new Promise((r) => setTimeout(r, 350));
		}
		expect(body, "the summary row is visible after polling").not.toBeNull();
		expect(body).toContain("final-trigger summary");

		queue.stop();
	});
});
