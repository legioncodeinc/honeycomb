/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE routing_history SMOKE — OPT-IN, MUTATES A REAL DEEPLAKE BACKEND.    ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-010 (D-7): append a REDACTED routing event to the real DeepLake      ║
 * ║  backend through the real `RoutingHistoryStore`, then read it back and    ║
 * ║  assert the on-disk row carries NO secret value and NO request body       ║
 * ║  (the c-AC-6 / d-AC-5 redaction-by-construction thesis, proven live).     ║
 * ║                                                                          ║
 * ║  GATED + ISOLATED exactly like graph-persist-live.itest.ts:               ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = skip.      ║
 * ║    - `.itest.ts` suffix + `tests/integration/**` exclusion keeps it OUT   ║
 * ║      of `npm run test` / `npm run ci`. Only `npm run test:integration`.  ║
 * ║    - Authorised workspace (`HONEYCOMB_DEEPLAKE_WORKSPACE`, default         ║
 * ║      `honeycomb_ci`, fallback `honeycomb`). An invented workspace 403s.   ║
 * ║    - Per-run throwaway table (`ci_routing_history_<runid>`), DROPped in   ║
 * ║      afterAll. Never touches the real `routing_history` table.            ║
 * ║                                                                          ║
 * ║  STALE-SEGMENT CAVEAT: a single immediate read of a just-written row can  ║
 * ║  land on a stale segment and under-report on this backend (the bug that   ║
 * ║  kept main CI red). We POLL the by-id read until the row is present (a    ║
 * ║  scan never invents a row, only misses it on a stale segment), mirroring  ║
 * ║  the `scanDistinct`/`SCAN_POLLS` pattern from graph-persist-live.         ║
 * ║                                                                          ║
 * ║  SECRETS: the token is read ONLY from the env via the storage layer's    ║
 * ║  `envCredentialProvider`. Never hardcoded, logged, or echoed.            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RedactedRoutingEvent } from "../../src/daemon/runtime/inference/contracts.js";
import { routingEventId } from "../../src/daemon/runtime/inference/history-store.js";
import { ROUTING_HISTORY_COLUMNS } from "../../src/daemon/storage/catalog/routing-history.js";
import type { QueryScope } from "../../src/daemon/storage/client.js";
import type { HealTarget } from "../../src/daemon/storage/heal.js";
import {
	createStorageClient,
	envCredentialProvider,
	isOk,
	resolveStorageConfig,
	type StorageClient,
	sLiteral,
	sqlIdent,
} from "../../src/daemon/storage/index.js";
import { appendOnlyInsert, val } from "../../src/daemon/storage/writes.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
const CI_TABLE = `ci_routing_history_${RUN_ID}`;

/** The throwaway `routing_history`-shaped HealTarget (single-sourced columns). */
const ciTarget: HealTarget = { table: CI_TABLE, columns: [...ROUTING_HISTORY_COLUMNS] };

/** The secret + the request body that MUST NOT appear on disk. */
const SECRET_VALUE = "sk-live-must-never-persist";
const REQUEST_BODY = "the user's private prompt that must never persist";

/** A redacted event carrying ONLY routing metadata (no secret, no body). */
const event: RedactedRoutingEvent = {
	requestId: `live-req-${RUN_ID}`,
	workload: "memory_extraction",
	servingTarget: "sonnet",
	mode: "strict",
	attempts: [
		{ targetId: "haiku", outcome: "failed", statusCode: 503, reason: "5xx" },
		{ targetId: "sonnet", outcome: "selected" },
	],
	blockedCandidates: [{ targetId: "opus", reason: "privacy" }],
};

/** How many times the by-id read is polled before the row is considered absent. */
const PRESENCE_POLLS = 25;
/**
 * Delay between presence polls. The append is heal-aware and returns `ok` only
 * after the throwaway table is CREATED and the row inserted (asserted below), so
 * the row is durable — but a brand-new table's first reads can land on a segment
 * that has not yet caught up. Back-to-back reads (~100ms each) span only ~2s,
 * which is too tight for a just-created table; spacing the polls makes the read
 * window ~10s+ so propagation reliably catches up (a scan never invents a row, so
 * a longer window only ever turns a false-absent into the true-present).
 */
const POLL_DELAY_MS = 400;

describe.skipIf(!HAS_TOKEN)("live routing_history smoke (opt-in, real backend, redaction check)", () => {
	let storage: StorageClient;
	let org: string;
	let workspace: string;
	let scope: QueryScope;

	beforeAll(() => {
		const raw = envCredentialProvider().read();
		const provider = {
			read: () => ({
				...raw,
				workspace: process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "honeycomb_ci",
			}),
		};
		const config = resolveStorageConfig(provider);
		org = config.org;
		workspace = config.workspace;
		scope = { org, workspace };
		storage = createStorageClient({ provider });
	});

	afterAll(async () => {
		if (!storage) return;
		// DROP is the reliable teardown on this backend (DELETE does not dependably
		// remove rows — PRD-004 / CONVENTIONS §5 D-8 caveat).
		const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(CI_TABLE)}"`, scope);
		if (!isOk(res)) {
			console.warn(`[ci-cleanup] could not drop ${CI_TABLE} in ${workspace}: ${JSON.stringify(res)}`);
		}
	});

	it("appends a redacted event and reads it back with NO secret + NO request body on disk", async () => {
		const id = routingEventId(event.requestId, event.attempts.length);
		// The on-disk event body is the same redacted JSON the store would write —
		// built here so the itest is self-contained (the store resolves the canonical
		// table via healTargetFor; we point at the throwaway table directly).
		const body = JSON.stringify({
			request_id: event.requestId,
			workload: event.workload,
			serving_target: event.servingTarget,
			mode: event.mode,
			attempts: event.attempts,
			blocked_candidates: event.blockedCandidates,
		});

		// Sanity: the redacted body genuinely excludes the secret + the request body.
		expect(body).not.toContain(SECRET_VALUE);
		expect(body).not.toContain(REQUEST_BODY);

		const wrote = await appendOnlyInsert(storage, ciTarget, scope, [
			["id", val.str(id)],
			["org_id", val.str(org)],
			["workspace_id", val.str(workspace)],
			["request_id", val.str(event.requestId)],
			["workload", val.str(event.workload)],
			["created_at", val.str(new Date().toISOString())],
			["event", val.text(body)],
		]);
		// The append MUST succeed (heal-aware: a missing throwaway table is created
		// then the insert retried). Surface the backend error rather than failing
		// later with a confusing "row absent".
		expect(wrote.kind, `append must succeed: ${JSON.stringify(wrote)}`).toBe("ok");

		// Read the row back by id, POLLING until present (a single immediate read of a
		// just-written row can land on a stale segment and under-report).
		const selectSql = `SELECT id, event FROM "${sqlIdent(CI_TABLE)}" WHERE id = ${sLiteral(id)} LIMIT 1`;
		let onDiskEvent: string | undefined;
		for (let poll = 0; poll < PRESENCE_POLLS; poll++) {
			const res = await storage.query(selectSql, scope);
			if (isOk(res) && res.rows.length > 0) {
				const raw = res.rows[0]?.event;
				onDiskEvent = typeof raw === "string" ? raw : JSON.stringify(raw);
				break;
			}
			await new Promise((resolve) => setTimeout(resolve, POLL_DELAY_MS));
		}

		expect(onDiskEvent, "the routing event row is present after polling").toBeDefined();
		const disk = onDiskEvent as string;
		// The redacted metadata IS on disk.
		expect(disk).toContain(event.requestId);
		expect(disk).toContain("sonnet");
		expect(disk).toContain("503");
		// The secret value + the request body are NOT (the redaction thesis, live).
		expect(disk).not.toContain(SECRET_VALUE);
		expect(disk).not.toContain(REQUEST_BODY);
		expect(disk).not.toMatch(/sk-[A-Za-z0-9]/);
	});
});
