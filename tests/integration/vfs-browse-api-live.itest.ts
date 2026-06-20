/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE VFS BROWSE API SMOKE — OPT-IN, BOOTS THE REAL ASSEMBLED DAEMON       ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  PRD-022b (b-AC-1 / b-AC-3 / b-AC-4 + b-AC-2 / b-AC-5 / b-AC-6). Boots the ║
 * ║  REAL `assembleDaemon()` against LIVE DeepLake on an EPHEMERAL port (NOT   ║
 * ║  3850), mounts `mountVfsApi` onto the booted daemon, seeds ONE `memory`    ║
 * ║  row at a per-run-unique path through the SAME daemon-side storage client  ║
 * ║  the browse reads run through, then drives the real `/memory/*` browse:    ║
 * ║    - b-AC-1: `GET /memory/cat?path=<seeded>` returns the row's content.    ║
 * ║    - b-AC-3: `GET /memory/ls?prefix=<run-prefix>` lists the seeded entry.  ║
 * ║    - b-AC-4: `GET /memory/find?pattern=<run-token>` matches the seeded row.║
 * ║    - b-AC-2: `GET /memory/grep?q=<token>` runs hybrid search live, returns ║
 * ║      a structurally valid (BM25/ILIKE-degraded, embeddings-off) result.    ║
 * ║    - b-AC-5: `GET /memory/classify?path=<p>` == the 015 client classifyPath║
 * ║    - b-AC-6: a write on a `/memory/*` path is 405 with audited guidance.   ║
 * ║                                                                          ║
 * ║  WHY mountVfsApi IS MOUNTED HERE (not by assembleDaemon):                  ║
 * ║    The browse seam is fired by `assembleSeams` in 022d; until that lands,  ║
 * ║    this itest mounts `mountVfsApi(daemon, { storage })` onto the booted    ║
 * ║    daemon itself — exactly the one-line attach 022d will move into the     ║
 * ║    composition root.                                                       ║
 * ║                                                                          ║
 * ║  GATED + ISOLATED (mirrors dashboard-logs-live.itest.ts):                 ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = whole       ║
 * ║      suite skips, the run exits 0.                                        ║
 * ║    - `.itest.ts` suffix keeps it OUT of `npm run test` / `npm run ci`.     ║
 * ║    - Ephemeral port (0): 3850 is never bound; per-boot temp lock dir.      ║
 * ║    - Per-run-unique seeded path so the read-back sees only THIS run.       ║
 * ║                                                                          ║
 * ║  The `/memory` group is a SESSION group, so every request stamps          ║
 * ║  `x-honeycomb-runtime-path` + `x-honeycomb-session` (what the VFS clients  ║
 * ║  send) on top of the tenancy headers. SECRETS: the token is read ONLY     ║
 * ║  from env via the storage layer. 120s cap. The orchestrator runs it.      ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createStorageClient,
	envCredentialProvider,
	type QueryScope,
	type StorageClient,
} from "../../src/daemon/storage/index.js";
import { createSummaryStore } from "../../src/daemon/runtime/summaries/index.js";
import { mountVfsApi } from "../../src/daemon/runtime/vfs/api.js";
import { classifyPath } from "../../src/daemon-client/vfs/classify.js";
import { bootTestDaemon, type BootedTestDaemon } from "./_daemon-harness.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

/** The daemon's own org partition (the SAME source assemble.ts resolves the daemon scope from). */
const ORG = process.env.HONEYCOMB_DEEPLAKE_ORG ?? "local";
const WORKSPACE = process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "default";

/** A deterministic, per-run-unique token so the read-back sees only THIS run's seeded row. */
function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
/** The per-run-unique seeded path (mount-relative `memory` path identity). */
const SEED_PREFIX = `vfs-browse-022b/${RUN_ID}/`;
const SEED_PATH = `${SEED_PREFIX}note.md`;
const SEED_TOKEN = `vfsbrowse${RUN_ID}`;
const SEED_BODY = `live VFS browse proof body containing the unique ${SEED_TOKEN} token`;

/** The headers a session-scoped `/memory` browse carries (runtime-path + session + tenancy). */
function browseHeaders(): Record<string, string> {
	return {
		"x-honeycomb-org": ORG,
		"x-honeycomb-workspace": WORKSPACE,
		"x-honeycomb-runtime-path": "plugin",
		"x-honeycomb-session": `vfs-browse-${RUN_ID}`,
	};
}

describe.skipIf(!HAS_TOKEN)("LIVE VFS BROWSE 022b: cat/ls/find/grep over /memory against live DeepLake", () => {
	let booted: BootedTestDaemon | null = null;
	let storage: StorageClient | null = null;
	let scope: QueryScope;

	beforeAll(async () => {
		// Boot the REAL assembled daemon against live DeepLake on an ephemeral port, in
		// `local` mode. The live storage client resolves its creds from `HONEYCOMB_DEEPLAKE_*`.
		booted = await bootTestDaemon({ mode: "local" });

		// A live storage client (same creds, via the storage layer) to SEED the `memory` row
		// and to back the browse reads. Resolve the token's authorized tenancy from env so the
		// seeded row lands in-scope.
		const raw = envCredentialProvider().read();
		const provider = { read: () => raw };
		storage = createStorageClient({ provider });
		scope = { org: ORG, workspace: WORKSPACE };

		// Seed ONE `memory` row at the per-run-unique path via the SAME SELECT-before-INSERT
		// path the daemon's summary worker uses (no schema change, real `memory` columns).
		const store = createSummaryStore(storage, scope);
		await store.writeSummary({
			path: SEED_PATH,
			summary: SEED_BODY,
			description: SEED_TOKEN,
			embedding: null, // embeddings-off: the browse cat/ls/find never need the vector.
			author: "vfs-browse-itest",
		});

		// Mount the 022b browse seam onto the booted daemon (022d will move this into assemble).
		mountVfsApi(booted.assembled.daemon, { storage });
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
		"b-AC-1: cat on the seeded /memory path returns the row's content live",
		async () => {
			expect(booted, "the daemon booted against live DeepLake").not.toBeNull();
			const b = booted!;
			const res = await fetch(`${b.baseUrl}/memory/cat?path=${encodeURIComponent(SEED_PATH)}`, {
				headers: browseHeaders(),
			});
			expect(res.status, "GET /memory/cat is 200 against live storage").toBe(200);
			const body = (await res.json()) as { found: boolean; content: string };
			expect(body.found, "the seeded row is found").toBe(true);
			expect(body.content, "the row content surfaces").toContain(SEED_TOKEN);
		},
		120_000,
	);

	it(
		"b-AC-3: ls on the per-run prefix lists the seeded entry live",
		async () => {
			const b = booted!;
			const res = await fetch(`${b.baseUrl}/memory/ls?prefix=${encodeURIComponent(SEED_PREFIX)}`, {
				headers: browseHeaders(),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { entries: { path: string }[] };
			expect(body.entries.map((e) => e.path), "the seeded path is listed under its prefix").toContain(SEED_PATH);
		},
		120_000,
	);

	it(
		"b-AC-4: find on the per-run token matches the seeded row live",
		async () => {
			const b = booted!;
			// `find` matches on PATH; the per-run id is in the path, so the pattern hits it.
			const res = await fetch(`${b.baseUrl}/memory/find?pattern=${encodeURIComponent(RUN_ID)}`, {
				headers: browseHeaders(),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { matches: { path: string }[] };
			expect(body.matches.map((m) => m.path), "the seeded path matches the find pattern").toContain(SEED_PATH);
		},
		120_000,
	);

	it(
		"b-AC-2: grep runs hybrid search live and returns a BM25/ILIKE-degraded result (embeddings off)",
		async () => {
			const b = booted!;
			const res = await fetch(`${b.baseUrl}/memory/grep?q=${encodeURIComponent(SEED_TOKEN)}`, {
				headers: browseHeaders(),
			});
			expect(res.status, "GET /memory/grep is 200 against live storage").toBe(200);
			const body = (await res.json()) as { degraded: boolean; hits: { id: string; content: string }[] };
			// No embed client wired into the browse → lexical-only → the silent BM25/ILIKE fallback.
			expect(body.degraded, "grep ran lexical-only (embeddings off)").toBe(true);
			expect(Array.isArray(body.hits), "grep returns a hit array").toBe(true);
		},
		120_000,
	);

	it(
		"b-AC-5: daemon-side classify matches the 015 client classifyPath for the seeded path",
		async () => {
			const b = booted!;
			const res = await fetch(`${b.baseUrl}/memory/classify?path=${encodeURIComponent(SEED_PATH)}`, {
				headers: browseHeaders(),
			});
			expect(res.status).toBe(200);
			const body = (await res.json()) as { pathClass: string };
			expect(body.pathClass, "daemon-side verdict == the 015 client's pure classifyPath").toBe(
				classifyPath(SEED_PATH),
			);
		},
		120_000,
	);

	it(
		"b-AC-6: a write on a /memory path is denied (405) with guidance pointing at /api/memories",
		async () => {
			const b = booted!;
			const res = await fetch(`${b.baseUrl}/memory/${SEED_PATH}`, {
				method: "POST",
				headers: { ...browseHeaders(), "content-type": "application/json" },
				body: JSON.stringify({ summary: "should never land via the VFS" }),
			});
			expect(res.status, "the VFS is read-only — a write is 405").toBe(405);
			const body = (await res.json()) as { error: string; writeRoute: string };
			expect(body.writeRoute).toBe("/api/memories");
		},
		120_000,
	);
});
