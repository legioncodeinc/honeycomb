/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE synthesis SMOKE — OPT-IN, MUTATES A REAL DEEPLAKE BACKEND.          ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-017b b-AC-1 / b-AC-4: write TWO per-session summaries to `memory` at  ║
 * ║  `/summaries/<userName>/<sessionId>.md`, run the synthesis, and read the   ║
 * ║  `MEMORY.md` index back (poll-convergent) — it LINKS BOTH summaries. A     ║
 * ║  re-synthesis does NOT double the index row (SELECT-before-INSERT keyed on  ║
 * ║  `path`, never an in-place UPDATE). Drives the SAME `createSummaryStore` +  ║
 * ║  `createSynthesisStore` paths the daemon uses, so the read+write converges  ║
 * ║  LIVE on this eventually-consistent backend.                             ║
 * ║                                                                          ║
 * ║  GATED + NATIVELY ISOLATED (modeled on summary-write-live / skills-write): ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = whole        ║
 * ║      suite skips, run exits 0.                                            ║
 * ║    - `.itest.ts` suffix keeps it OUT of `npm run test` / `npm run ci`.     ║
 * ║      Only `npm run test:integration` runs it.                            ║
 * ║    - Throwaway-table isolation is NATIVE: BOTH stores' `resolveTable` seam  ║
 * ║      routes the canonical `memory` name to ONE per-run `ci_synth_<runid>`   ║
 * ║      table, which the heal CREATEs DIRECTLY on the first write (its real    ║
 * ║      `memory` ColumnDef shape) — NOT a SQL-string proxy (which races the    ║
 * ║      heal's CREATE/introspect/ALTER and corrupts a fresh table). The        ║
 * ║      summaries AND the synthesized MEMORY.md share the one throwaway table  ║
 * ║      (the synthesis reads the summaries it wrote). DROPped in afterAll.     ║
 * ║    - `queryTimeoutMs: 120_000`.                                          ║
 * ║                                                                          ║
 * ║  POLL-CONVERGENT, SPACED read-backs: this backend serves a read from        ║
 * ║  segments of differing freshness, so a SINGLE immediate read of a just-     ║
 * ║  written row can under-report. The synthesis SUMMARY READ is itself spaced  ║
 * ║  with retries (the fresh-write propagation lesson from the 017a live fix),  ║
 * ║  and the MEMORY.md read-back polls until visible — a read can miss the       ║
 * ║  write but never invents one, so polling converges UP to the durable row.  ║
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
import {
	createSummaryStore,
	type SummaryRow,
	type SummarySession,
	summaryPath,
} from "../../src/daemon/runtime/summaries/index.js";
import {
	createSynthesisStore,
	MEMORY_INDEX_PATH,
	synthesizeMemoryIndex,
} from "../../src/daemon/runtime/summaries/index.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
/** The per-run THROWAWAY table — the `memory` shape, shared by summaries + synthesis, DROPped in teardown. */
const TBL_MEMORY = `ci_synth_${RUN_ID}`;

/** Two distinct sessions whose summaries the synthesis must link into ONE MEMORY.md. */
const SESSION_A: SummarySession = { sessionId: `ci-a-${RUN_ID}`, userName: "ci-user", path: `ci/conv/a/${RUN_ID}` };
const SESSION_B: SummarySession = { sessionId: `ci-b-${RUN_ID}`, userName: "ci-user", path: `ci/conv/b/${RUN_ID}` };

function summaryRow(session: SummarySession, body: string): SummaryRow {
	return {
		path: summaryPath(session),
		summary: body,
		description: body.slice(0, 80),
		embedding: null,
		author: "ci-user",
	};
}

/** Route the canonical `memory` name to the per-run throwaway table NATIVELY (the proven isolation). */
const resolveTable = (canonical: string): string => (canonical === "memory" ? TBL_MEMORY : canonical);

describe.skipIf(!HAS_TOKEN)("live synthesis smoke (opt-in, real backend, MEMORY.md links both summaries, SBI exactly-once)", () => {
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
		const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(TBL_MEMORY)}"`, scope);
		if (!isOk(res)) console.warn(`[ci-cleanup] could not drop ${TBL_MEMORY}: ${JSON.stringify(res)}`);
	});

	it("writes 2 summaries → synthesizes → reads MEMORY.md back (poll-convergent) linking BOTH; re-synthesis does not double", async () => {
		const summaryStore = createSummaryStore(storage, scope, resolveTable);
		const pathA = summaryPath(SESSION_A);
		const pathB = summaryPath(SESSION_B);

		// Write a summary and RETRY through the fresh-throwaway-table heal-create race until the
		// row is durably visible. `writeSummary` reports the ACTUAL insert result, which can be
		// false when the first INSERT races a just-healed table; the write is idempotent per real
		// summary (placeholder-excluding SBI probe), so re-running is safe and lands once the table
		// propagates. This also converges the INPUTS before synthesis (which reads /summaries/% once
		// and writes MEMORY.md write-once — a stale single read would permanently link one).
		const writeUntilVisible = async (session: SummarySession, p: string, body: string): Promise<void> => {
			const visibleSql =
				`SELECT ${sqlIdent("path")} FROM "${sqlIdent(TBL_MEMORY)}" ` +
				`WHERE ${sqlIdent("path")} = ${sLiteral(p)} ` +
				`AND ${sqlIdent("description")} != ${sLiteral("in progress")} LIMIT 1`;
			for (let attempt = 0; attempt < 8; attempt++) {
				await summaryStore.writeSummary(summaryRow(session, body));
				for (let poll = 0; poll < 8; poll++) {
					const res = await storage.query(visibleSql, scope);
					if (isOk(res) && res.rows.length > 0) return;
					await new Promise((r) => setTimeout(r, 400));
				}
			}
			throw new Error(`summary at ${p} never became durably visible`);
		};
		await writeUntilVisible(SESSION_A, pathA, "## session A — refactored auth");
		await writeUntilVisible(SESSION_B, pathB, "## session B — fixed recall");

		// Synthesize ONCE: reads the now-converged /summaries/% rows, renders MEMORY.md linking
		// both, SELECT-before-INSERT at /MEMORY.md.
		const synthStore = createSynthesisStore(storage, scope, resolveTable);
		const result = await synthesizeMemoryIndex({ store: synthStore });
		expect(result.linkedSummaries, "synthesis linked both summaries").toBeGreaterThanOrEqual(2);

		// Poll-convergent, SPACED read-back of the MEMORY.md body (a just-written row may not be
		// visible on the first read; a stale segment never invents one).
		const readSql =
			`SELECT summary FROM "${sqlIdent(TBL_MEMORY)}" ` +
			`WHERE ${sqlIdent("path")} = ${sLiteral(MEMORY_INDEX_PATH)} ` +
			`AND ${sqlIdent("description")} != ${sLiteral("in progress")} ` +
			`ORDER BY creation_date DESC LIMIT 1`;
		let body: string | null = null;
		let linksBoth = false;
		for (let poll = 0; poll < 40 && !linksBoth; poll++) {
			const res = await storage.query(readSql, scope);
			if (isOk(res) && res.rows.length > 0) {
				const v = res.rows[0]?.summary;
				if (typeof v === "string") {
					body = v;
					linksBoth = v.includes(pathA) && v.includes(pathB);
				}
			}
			if (!linksBoth) await new Promise((r) => setTimeout(r, 400));
		}
		expect(body, "MEMORY.md visible after poll").not.toBeNull();
		expect(linksBoth, "MEMORY.md links BOTH per-session summaries").toBe(true);

		// Settle so the index row is durable on every segment before the exactly-once probe.
		await new Promise((r) => setTimeout(r, 1500));
		// Re-run synthesis: SELECT-before-INSERT keyed on /MEMORY.md sees the existing index →
		// does NOT insert a second row (exactly-once). It must NEVER emit an in-place UPDATE.
		const second = await synthesizeMemoryIndex({ store: synthStore });
		expect(second.written).toBe(false);

		// Confirm exactly ONE real (non-placeholder) MEMORY.md row exists at the index path.
		const countSql =
			`SELECT path FROM "${sqlIdent(TBL_MEMORY)}" ` +
			`WHERE ${sqlIdent("path")} = ${sLiteral(MEMORY_INDEX_PATH)} ` +
			`AND ${sqlIdent("description")} != ${sLiteral("in progress")}`;
		let count = 0;
		for (let poll = 0; poll < 30; poll++) {
			const res = await storage.query(countSql, scope);
			if (isOk(res)) count = Math.max(count, res.rows.length);
			await new Promise((r) => setTimeout(r, 250));
		}
		expect(count, "exactly one MEMORY.md index row at the path").toBe(1);
	});
});
