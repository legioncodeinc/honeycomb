/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE PRODUCT-DATA API — OPT-IN, DRIVES /api/goals + /api/kpis OVER HTTP   ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-022c (c-AC-1 / c-AC-2). Boots the REAL `bootTestDaemon({mode:"local"})║
 * ║  harness against LIVE DeepLake on an EPHEMERAL port (NOT 3850), mounts the ║
 * ║  product-data seam (`mountProductDataApi`) onto it — the assembly (022d)   ║
 * ║  fires it in production; here the itest fires it directly onto the booted  ║
 * ║  daemon — then drives the real HTTP surface:                              ║
 * ║                                                                          ║
 * ║    - POST /api/goals a per-run-unique goal → GET /api/goals returns it     ║
 * ║      (c-AC-1: the 003d update-or-insert-by-key landed + reads back).      ║
 * ║    - POST /api/kpis the SAME per-run-unique key TWICE → GET shows ONE row  ║
 * ║      with the second value (c-AC-2: an existing key UPDATES, never a dup). ║
 * ║                                                                          ║
 * ║  GATED + ISOLATED:                                                        ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = whole       ║
 * ║      suite skips, the run exits 0.                                        ║
 * ║    - `.itest.ts` suffix keeps it OUT of `npm run test` / `npm run ci`;     ║
 * ║      only `npm run test:integration` runs it.                            ║
 * ║    - Ephemeral port (0): the OS picks a free port; 3850 is never bound.    ║
 * ║    - PER-RUN-UNIQUE keys: every key carries a fresh suffix so reruns never ║
 * ║      collide and the upsert proof is unambiguous.                        ║
 * ║                                                                          ║
 * ║  Embeddings OFF (BM25 fallback): goals/kpis reads are plain SELECTs, no    ║
 * ║  vector — no embed daemon required.                                       ║
 * ║                                                                          ║
 * ║  SECRETS: the token is read ONLY from env via the storage layer's         ║
 * ║  `envCredentialProvider`. Never hardcoded, logged, or echoed.            ║
 * ║                                                                          ║
 * ║  120s cap. Do NOT run locally (no creds) — the orchestrator runs it.      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createStorageClient } from "../../src/daemon/storage/index.js";
import { mountProductDataApi } from "../../src/daemon/runtime/product/index.js";
import { type BootedTestDaemon, bootTestDaemon } from "./_daemon-harness.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

/** The org/workspace this itest stamps on every request (the local-mode loopback tenant). */
const ORG = process.env.HONEYCOMB_DEEPLAKE_ORG ?? "local";
const WORKSPACE = process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "default";
const HEADERS = {
	"x-honeycomb-org": ORG,
	"x-honeycomb-workspace": WORKSPACE,
	"content-type": "application/json",
};

describe.skipIf(!HAS_TOKEN)("LIVE PRODUCT-DATA: /api/goals upsert+read, /api/kpis existing-key-updates over HTTP", () => {
	let booted: BootedTestDaemon | null = null;
	// A per-run suffix so reruns never collide and the upsert proof is unambiguous.
	const run = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
	const goalKey = `itest-goal-${run}`;
	const kpiKey = `itest-kpi-${run}`;

	beforeAll(async () => {
		// One live storage client, shared with the booted daemon AND the seam mount, so the
		// reads/writes go through the same partition the daemon health-probed.
		const storage = createStorageClient();
		booted = await bootTestDaemon({ mode: "local", storage });
		// Fire the product-data seam onto the booted daemon (in production 022d does this in
		// assembleSeams; here we wire it directly so the route answers over HTTP).
		mountProductDataApi(booted.assembled.daemon, { storage });
	}, 120_000);

	afterAll(async () => {
		if (booted !== null) {
			try {
				await booted.stop();
			} catch {
				// Already stopped — a double stop is a no-op.
			}
		}
	});

	it(
		"c-AC-1 POST /api/goals lands a goal and GET /api/goals returns it",
		async () => {
			expect(booted, "the daemon booted against live DeepLake").not.toBeNull();
			const b = booted!;

			const post = await fetch(`${b.baseUrl}/api/goals`, {
				method: "POST",
				headers: HEADERS,
				body: JSON.stringify({ key: goalKey, value: "ship the data-access API", target: "2026-07" }),
			});
			expect(post.status, "POST /api/goals lands the goal (no 501/400)").toBe(201);

			const get = await fetch(`${b.baseUrl}/api/goals`, { headers: HEADERS });
			expect(get.status).toBe(200);
			const body = (await get.json()) as { goals: Array<{ key: string; value: string }> };
			const found = body.goals.find((g) => g.key === goalKey);
			expect(found, "the just-added goal reads back").toBeDefined();
			expect(found?.value).toBe("ship the data-access API");
		},
		120_000,
	);

	it(
		"c-AC-2 POST /api/kpis the same key twice yields ONE row with the updated value",
		async () => {
			const b = booted!;

			const first = await fetch(`${b.baseUrl}/api/kpis`, {
				method: "POST",
				headers: HEADERS,
				body: JSON.stringify({ key: kpiKey, value: "320", unit: "ms" }),
			});
			expect(first.status).toBe(201);

			const second = await fetch(`${b.baseUrl}/api/kpis`, {
				method: "POST",
				headers: HEADERS,
				body: JSON.stringify({ key: kpiKey, value: "180", unit: "ms" }),
			});
			expect(second.status).toBe(201);

			// Poll-convergent read: this backend serves segments of differing freshness that
			// flap, so a read immediately after the UPDATE can under-report the prior value.
			// We poll until the durable current state (value="180", the last write) surfaces;
			// a stale segment under-reports, never invents, so this converges UP to "180".
			let matching: Array<{ key: string; value: string }> = [];
			for (let poll = 0; poll < 40; poll++) {
				const get = await fetch(`${b.baseUrl}/api/kpis`, { headers: HEADERS });
				expect(get.status).toBe(200);
				const body = (await get.json()) as { kpis: Array<{ key: string; value: string }> };
				matching = body.kpis.filter((k) => k.key === kpiKey);
				if (matching.length === 1 && matching[0]?.value === "180") break;
				await new Promise((r) => setTimeout(r, 350));
			}
			expect(matching, "exactly one row for the key — the second add UPDATED, not duplicated").toHaveLength(1);
			expect(matching[0]?.value).toBe("180");
		},
		120_000,
	);
});

// A no-token guard so the suite is never silently empty in a non-gated runner.
describe.skipIf(HAS_TOKEN)("LIVE PRODUCT-DATA (skipped: no HONEYCOMB_DEEPLAKE_TOKEN)", () => {
	it("is gated off without a live token", () => {
		expect(typeof mountProductDataApi).toBe("function");
	});
});
