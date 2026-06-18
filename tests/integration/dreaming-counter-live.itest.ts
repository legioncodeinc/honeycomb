/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE dreaming_state COUNTER SMOKE — OPT-IN, MUTATES A REAL DEEPLAKE BACKEND.║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  THIS SUITE WRITES TO A REAL DEEPLAKE ORG. It lazily creates a            ║
 * ║  `dreaming_state` table from the catalog ColumnDef array, increments +     ║
 * ║  resets the per-scope counter through the REAL append-only version-bump    ║
 * ║  path, and (best-effort) DROPs the table. It is GATED:                     ║
 * ║                                                                            ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` — no token → SKIP, exit 0.║
 * ║    - NEVER part of `npm run test` / `npm run ci` — the `.itest.ts` suffix   ║
 * ║      is outside the default `*.test.ts` glob and `tests/integration/**` is  ║
 * ║      excluded. Run only via `npm run test:integration` (+ `.env.local`).    ║
 * ║                                                                            ║
 * ║  ISOLATION (mirrors memory-jobs-live.itest.ts — do not weaken):            ║
 * ║    - Runs in the SAME authorized workspace the daemon uses                  ║
 * ║      (`HONEYCOMB_DEEPLAKE_WORKSPACE`, default `honeycomb_ci`). An invented   ║
 * ║      partition is rejected 403 by the scoped token.                         ║
 * ║    - Points the trigger at a throwaway, namespaced table                    ║
 * ║      (`ci_dreaming_<run-id>`) via the `tableName` seam — the SAME ColumnDef  ║
 * ║      array, a DROP-able name — never a real daemon's `dreaming_state`. DROP  ║
 * ║      is the reliable teardown here (DELETE does not dependably remove rows). ║
 * ║                                                                            ║
 * ║  SECRETS: the token is read ONLY from the env via the storage layer's      ║
 * ║  `envCredentialProvider`. Never hardcoded, logged, or echoed.              ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * What it proves (the live round-trip only fake-verified before):
 *   1. increment → highest-version read returns the accumulated counter (a-AC-1 /
 *      a-AC-5) on the REAL backend, where a single by-id read can land on a stale
 *      segment — the trigger's poll-convergent `readState` must still settle.
 *   2. threshold → enqueue → reset SUBTRACTS the threshold (a-AC-2 / FR-5), and a
 *      summary write INTERLEAVED between the threshold read and the reset is NOT
 *      lost — the reset-not-lose-concurrent-writes race, the live-only check. We
 *      reproduce it deterministically: increment to OVER threshold, then in the
 *      window before the tick's reset lands, increment again; after the tick the
 *      counter must reflect (total − threshold), never a hard zero.
 *
 * It is a SMOKE, not a re-test of a-AC-1..6 (those are proven against the fake
 * transport in `tests/daemon/runtime/dreaming/trigger.test.ts`).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createStorageClient,
	envCredentialProvider,
	isOk,
	resolveStorageConfig,
	type StorageClient,
	sqlIdent,
} from "../../src/daemon/storage/index.js";
import { DreamingConfigSchema } from "../../src/daemon/runtime/dreaming/config.js";
import {
	createDreamingTrigger,
	type DreamingJobEnqueuer,
	type DreamingScope,
	type DreamingTrigger,
} from "../../src/daemon/runtime/dreaming/trigger.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
const CI_TABLE = `ci_dreaming_${RUN_ID}`;

/** A fake queue that records enqueues + hands back a synthetic id (no real job needed). */
class RecordingQueue implements DreamingJobEnqueuer {
	readonly calls: { kind: string; payload: Record<string, unknown> }[] = [];
	private seq = 0;
	async enqueue(job: { kind: string; payload: Record<string, unknown> }): Promise<string> {
		this.calls.push(job);
		this.seq += 1;
		return `ci-job-${RUN_ID}-${this.seq}`;
	}
}

describe.skipIf(!HAS_TOKEN)("live dreaming_state counter smoke (opt-in, real backend)", () => {
	let storage: StorageClient;
	let org: string;
	let workspace: string;
	const SCOPE_AGENT: DreamingScope = { agentId: `ci-agent-${RUN_ID}` };

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
		storage = createStorageClient({ provider });
	});

	afterAll(async () => {
		if (!storage) return;
		const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(CI_TABLE)}"`, { org, workspace });
		if (!isOk(res)) {
			console.warn(`[ci-cleanup] could not drop ${CI_TABLE} in ${workspace}`);
		}
	});

	function triggerWith(tokenThreshold: number): DreamingTrigger {
		return createDreamingTrigger({
			storage,
			scope: { org, workspace },
			config: DreamingConfigSchema.parse({ enabled: true, tokenThreshold }),
			enqueuer: new RecordingQueue(),
			tableName: CI_TABLE,
		});
	}

	it("increment accumulates and the highest-version read returns it (a-AC-1 / a-AC-5)", async () => {
		const trigger = triggerWith(1_000_000); // high threshold: no enqueue here.
		await trigger.incrementDreamingCounter(SCOPE_AGENT, 40);
		await trigger.incrementDreamingCounter(SCOPE_AGENT, 35);
		const state = await trigger.readState(SCOPE_AGENT);
		expect(state.tokensSinceLastPass).toBe(75);
	});

	it("threshold → enqueue + reset SUBTRACTS, and an interleaved write is not lost (a-AC-2 / FR-5)", async () => {
		// Fresh agent scope so this scenario's counter is independent of the first.
		const scope: DreamingScope = { agentId: `ci-agent-${RUN_ID}-b` };
		const queue = new RecordingQueue();
		const trigger = createDreamingTrigger({
			storage,
			scope: { org, workspace },
			config: DreamingConfigSchema.parse({ enabled: true, tokenThreshold: 100 }),
			enqueuer: queue,
			tableName: CI_TABLE,
		});

		// Accumulate 130 (over the 100 threshold).
		await trigger.incrementDreamingCounter(scope, 130);
		// Interleave a summary write of 50 BEFORE the tick (the concurrent-write window).
		await trigger.incrementDreamingCounter(scope, 50); // total now 180.

		const result = await trigger.checkAndEnqueueDreaming(scope);
		expect(result.decision).toBe("enqueued");
		expect(queue.calls).toHaveLength(1);

		// 180 - 100 = 80 carried forward (NOT lost, NOT hard-zeroed). The live
		// poll-convergent read must settle on the post-reset highest version.
		const state = await trigger.readState(scope);
		expect(state.tokensSinceLastPass).toBe(80);
		expect(state.pendingJobId).not.toBe("");
	});
});
