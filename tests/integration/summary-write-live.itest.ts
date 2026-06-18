/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE summary-write SMOKE — OPT-IN, MUTATES A REAL DEEPLAKE BACKEND.      ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-017a a-AC-1 / a-AC-6: a per-session summary is written to `memory` at ║
 * ║  `/summaries/<userName>/<sessionId>.md` via SELECT-before-INSERT keyed on  ║
 * ║  `path` — EXACTLY ONCE, never an in-place UPDATE. This suite SELECT-before-║
 * ║  INSERTs one summary through the SAME `createSummaryStore` path the daemon ║
 * ║  uses, reads it back (poll-convergent), and re-runs the write to prove it  ║
 * ║  does NOT double — the exactly-once / append-not-mutate write converges     ║
 * ║  LIVE.                                                                    ║
 * ║                                                                          ║
 * ║  GATED + NATIVELY ISOLATED (modeled on skills-write-live / sources-purge): ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = whole        ║
 * ║      suite skips, run exits 0.                                            ║
 * ║    - `.itest.ts` suffix keeps it OUT of `npm run test` / `npm run ci`.     ║
 * ║      Only `npm run test:integration` runs it.                            ║
 * ║    - Throwaway-table isolation is NATIVE: `createSummaryStore`'s           ║
 * ║      `resolveTable` seam routes the canonical `memory` name to a per-run   ║
 * ║      `ci_summaries_<runid>` table, which the heal CREATEs DIRECTLY on the  ║
 * ║      first write (its real `memory` ColumnDef shape) — NOT a SQL-string    ║
 * ║      proxy (which races the heal's CREATE/introspect/ALTER and corrupts a  ║
 * ║      fresh table). DROPped in afterAll. Never touches the real `memory`.   ║
 * ║    - `queryTimeoutMs: 120_000`.                                          ║
 * ║                                                                          ║
 * ║  POLL-CONVERGENT read-backs: this backend serves a read from segments of  ║
 * ║  differing freshness, so a SINGLE immediate read of a just-written row can ║
 * ║  under-report. We poll until the row is visible — a read can miss the      ║
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
	summaryPath,
	type SummarySession,
} from "../../src/daemon/runtime/summaries/index.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
/** The per-run THROWAWAY table — the `memory` shape, isolated, DROPped in teardown. */
const TBL_MEMORY = `ci_summaries_${RUN_ID}`;

const SESSION: SummarySession = { sessionId: `ci-sess-${RUN_ID}`, userName: "ci-user", path: `ci/conv/${RUN_ID}` };

function summaryRow(body: string): SummaryRow {
	return {
		path: summaryPath(SESSION),
		summary: body,
		description: body.slice(0, 80),
		embedding: null,
		author: "ci-user",
	};
}

describe.skipIf(!HAS_TOKEN)("live summary-write smoke (opt-in, real backend, SELECT-before-INSERT exactly-once)", () => {
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

	it("SELECT-before-INSERTs a summary at /summaries/…, reads it back (poll-convergent), and a re-run does not double", async () => {
		// Route the canonical `memory` name to the per-run throwaway table NATIVELY via the
		// store's `resolveTable` seam — the heal CREATEs the physical throwaway table directly
		// (the proven skills-write / sources-purge isolation technique). A SQL-string proxy
		// races the heal's CREATE/introspect/ALTER and corrupts a fresh table.
		const resolveTable = (canonical: string): string => (canonical === "memory" ? TBL_MEMORY : canonical);
		const store = createSummaryStore(storage, scope, resolveTable);
		const path = summaryPath(SESSION);

		// First write: lazily CREATEs the throwaway `memory`-shaped table on the placeholder
		// SELECT-before-INSERT, then writes the real summary.
		await store.writePlaceholder(path, "ci-user");
		await store.removePlaceholder(path);
		const first = await store.writeSummary(summaryRow("## version one body"));
		expect(first.written).toBe(true);

		// Poll-convergent read-back: the just-written row may not be visible on the first read.
		const readSql =
			`SELECT summary FROM "${sqlIdent(TBL_MEMORY)}" ` +
			`WHERE ${sqlIdent("path")} = ${sLiteral(path)} ` +
			`AND ${sqlIdent("description")} != ${sLiteral("in progress")} ` +
			`ORDER BY creation_date DESC LIMIT 1`;
		let body: string | null = null;
		for (let poll = 0; poll < 30 && body === null; poll++) {
			const res = await storage.query(readSql, scope);
			if (isOk(res) && res.rows.length > 0) {
				const v = res.rows[0]?.summary;
				if (typeof v === "string") body = v;
			}
			if (body === null) await new Promise((r) => setTimeout(r, 350));
		}
		expect(body, "summary visible after poll").not.toBeNull();
		expect(body).toContain("version one body");

		// Settle so v1 is durably propagated on every segment before the exactly-once probe
		// (the SBI probe is a single read; a stale segment would otherwise let v2 in).
		await new Promise((r) => setTimeout(r, 1500));
		// Re-run the write: SELECT-before-INSERT keyed on `path` sees the existing summary →
		// does NOT insert a second row (exactly-once). It must NEVER emit an in-place UPDATE.
		const second = await store.writeSummary(summaryRow("## version two body SHOULD NOT LAND"));
		expect(second.written).toBe(false); // already present → exactly-once

		// Confirm only ONE real (non-placeholder) summary row exists at the path, and it is v1.
		const countSql =
			`SELECT summary FROM "${sqlIdent(TBL_MEMORY)}" ` +
			`WHERE ${sqlIdent("path")} = ${sLiteral(path)} ` +
			`AND ${sqlIdent("description")} != ${sLiteral("in progress")}`;
		let count = 0;
		let sawV1 = false;
		let sawV2 = false;
		for (let poll = 0; poll < 30; poll++) {
			const res = await storage.query(countSql, scope);
			if (isOk(res)) {
				count = Math.max(count, res.rows.length);
				for (const row of res.rows) {
					const s = typeof row.summary === "string" ? row.summary : "";
					if (s.includes("version one body")) sawV1 = true;
					if (s.includes("SHOULD NOT LAND")) sawV2 = true;
				}
			}
			await new Promise((r) => setTimeout(r, 250));
		}
		expect(sawV1, "v1 present").toBe(true);
		expect(sawV2, "the re-run never landed (exactly-once, no UPDATE)").toBe(false);
		expect(count, "exactly one real summary row at the path").toBe(1);
	});
});
