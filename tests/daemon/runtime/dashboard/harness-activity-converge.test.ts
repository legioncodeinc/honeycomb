/**
 * The poll-max convergence mitigation for `turnsCaptured` — the DeepLake read-replica staleness fix.
 *
 * DeepLake's read replicas can serve stale under-counts for `COUNT(*)` on `sessions` — a query that
 * should return ~1800 rows randomly returns ~18 on some replicas. The staleness only ever
 * UNDER-reports, so polling N times and taking the MAX `n` per `agent` converges on the truth.
 *
 * These tests prove the mitigation directly against a fake transport that scripts the staleness:
 *   1. STALE-REPLICA: alternating full (real counts) and stale (under-count) responses → the merged
 *      result carries the MAX (the fresh counts), not the stale ones.
 *   2. ALL-STALE: every response is the stale under-count → the merged result is the best-seen (the
 *      stale counts themselves — still better than zero, and the honest answer within the budget).
 *   3. CONSISTENT: every response is the same (no staleness) → the merged result equals a single read
 *      (no regression on a healthy DeepLake).
 *   4. ALL-FAIL: every query throws → all six harnesses return zeroed activity (the fail-soft path
 *      preserved from the prior single-read behavior).
 */

import { describe, expect, it } from "vitest";

import type { RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import {
	type HarnessStatus,
	mountHarnessApi,
} from "../../../../src/daemon/runtime/dashboard/harness-api.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const ORG = "fake-org";
const WORKSPACE = "fake-ws";

function cfg(): RuntimeConfig {
	return { host: "127.0.0.1", mode: "local", port: 3850, widened: false };
}

function headers(): Record<string, string> {
	return { "x-honeycomb-org": ORG, "x-honeycomb-workspace": WORKSPACE };
}

/** A "full" activity result: claude-code with 1800 turns (the real count). */
const FULL_ROWS = [{ agent: "claude-code", n: 1800, last: "2026-07-06T20:00:00.000Z" }];

/** A "stale" activity result: claude-code with 18 turns (the under-count from a stale replica). */
const STALE_ROWS = [{ agent: "claude-code", n: 18, last: "2026-07-06T18:00:00.000Z" }];

/**
 * A fake transport whose responder is a mutable function — each test swaps the responder to script
 * the staleness pattern (alternating, always-stale, consistent, or always-fail).
 */
function makeDaemon(responder: (req: TransportRequest) => Record<string, unknown>[]) {
	const fake = new FakeDeepLakeTransport(responder);
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const daemon = createDaemon({ config: cfg(), storage, logger: createRequestLogger({ silent: true }) });
	const installed = new Set<string>(["claude-code"]);
	mountHarnessApi(daemon, { storage, installedHarnesses: installed });
	return { daemon, storage, fake };
}

/** Fetch the harnesses endpoint and extract the claude-code status. */
async function getClaudeCode(daemon: ReturnType<typeof createDaemon>): Promise<HarnessStatus> {
	const res = await daemon.app.request("/api/diagnostics/harnesses", { headers: headers() });
	expect(res.status).toBe(200);
	const body = (await res.json()) as { harnesses: HarnessStatus[] };
	return body.harnesses.find((h) => h.name === "claude-code") as HarnessStatus;
}

/** A responder that matches the activity GROUP BY SQL and returns scripted rows. */
function activityResponder(rows: Record<string, unknown>[]): (req: TransportRequest) => Record<string, unknown>[] {
	return (req: TransportRequest): Record<string, unknown>[] => {
		if (/GROUP BY\s+agent/i.test(req.sql) && /FROM\s+"sessions"/i.test(req.sql)) return rows;
		return [];
	};
}

/** A responder that alternates between two row sets on consecutive calls (the stale-replica pattern). */
function alternatingResponder(a: Record<string, unknown>[], b: Record<string, unknown>[]): {
	responder: (req: TransportRequest) => Record<string, unknown>[];
	getCallCount: () => number;
} {
	let callCount = 0;
	return {
		responder(req: TransportRequest): Record<string, unknown>[] {
			if (!(/GROUP BY\s+agent/i.test(req.sql) && /FROM\s+"sessions"/i.test(req.sql))) return [];
			callCount += 1;
			return callCount % 2 === 1 ? a : b;
		},
		getCallCount: () => callCount,
	};
}

describe("Harness activity poll-max convergence (DeepLake stale-replica mitigation)", () => {
	it("STALE-REPLICA: alternating full/stale responses → turnsCaptured is the MAX (the fresh count, not the stale 18)", async () => {
		const { responder } = alternatingResponder(FULL_ROWS, STALE_ROWS);
		const { daemon } = makeDaemon(responder);
		const cc = await getClaudeCode(daemon);
		expect(cc.turnsCaptured, "the merged count is the MAX across polls (1800, not 18)").toBe(1800);
		expect(cc.lastSeen, "the merged lastSeen is the LATEST timestamp (the fresh one)").toBe("2026-07-06T20:00:00.000Z");
	});

	it("STALE-REPLICA (reversed order): stale first, then full → still the MAX", async () => {
		const { responder } = alternatingResponder(STALE_ROWS, FULL_ROWS);
		const { daemon } = makeDaemon(responder);
		const cc = await getClaudeCode(daemon);
		expect(cc.turnsCaptured, "even when the stale response comes first, the MAX wins").toBe(1800);
	});

	it("ALL-STALE: every poll returns the under-count → turnsCaptured is the best-seen (18, not 0)", async () => {
		const { daemon } = makeDaemon(activityResponder(STALE_ROWS));
		const cc = await getClaudeCode(daemon);
		// When every replica is stale, the honest best-effort answer is the stale count (18), not 0.
		// The mitigation doesn't fabricate a higher number; it takes the max of what it observed.
		expect(cc.turnsCaptured, "the best-seen count when all replicas are stale").toBe(18);
		expect(cc.active, "18 > 0 so the harness is still active").toBe(true);
	});

	it("CONSISTENT: every poll returns the same data → no regression (count equals a single read)", async () => {
		const { daemon } = makeDaemon(activityResponder(FULL_ROWS));
		const cc = await getClaudeCode(daemon);
		expect(cc.turnsCaptured, "consistent data → the merged max equals the single-read value").toBe(1800);
		expect(cc.lastSeen).toBe("2026-07-06T20:00:00.000Z");
	});

	it("ALL-FAIL: every query throws → all six zeroed (the fail-soft path is preserved)", async () => {
		const { daemon } = makeDaemon(() => {
			throw new Error("deeplake unreachable");
		});
		const res = await daemon.app.request("/api/diagnostics/harnesses", { headers: headers() });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { harnesses: HarnessStatus[] };
		expect(body.harnesses.length, "all six canonical harnesses present").toBe(6);
		for (const h of body.harnesses) {
			expect(h.turnsCaptured, `${h.name} is zeroed when every query fails`).toBe(0);
			expect(h.active).toBe(false);
		}
	});

	it("MULTI-AGENT: the max-reduce works per-agent across the full canonical six", async () => {
		// Poll 1: full counts for 3 harnesses; Poll 2: stale under-counts for only 1.
		const full = [
			{ agent: "claude-code", n: 1800, last: "2026-07-06T20:00:00.000Z" },
			{ agent: "cursor", n: 312, last: "2026-07-06T19:00:00.000Z" },
			{ agent: "codex", n: 5, last: "2026-07-06T18:00:00.000Z" },
		];
		const stale = [{ agent: "claude-code", n: 18, last: "2026-07-06T17:00:00.000Z" }];
		const { responder } = alternatingResponder(full, stale);
		const { daemon } = makeDaemon(responder);
		const res = await daemon.app.request("/api/diagnostics/harnesses", { headers: headers() });
		expect(res.status).toBe(200);
		const body = (await res.json()) as { harnesses: HarnessStatus[] };
		const byName = new Map(body.harnesses.map((h) => [h.name, h]));
		expect(byName.get("claude-code")!.turnsCaptured, "claude-code: max of 1800 and 18").toBe(1800);
		expect(byName.get("cursor")!.turnsCaptured, "cursor: only in the full poll (312)").toBe(312);
		expect(byName.get("codex")!.turnsCaptured, "codex: only in the full poll (5)").toBe(5);
		expect(byName.get("hermes")!.turnsCaptured, "hermes: absent from all polls (0)").toBe(0);
	});
});
