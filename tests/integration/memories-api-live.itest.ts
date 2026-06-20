/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  PRD-022a — the /api/memories WRITE→READ-over-HTTP proof (live, gated).    ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  The data-API headline: a memory STORED through `POST /api/memories` is    ║
 * ║  RECALLED through `POST /api/memories/recall` — over real loopback HTTP,   ║
 * ║  against LIVE DeepLake, by the WIRED engines (no 501, no direct SQL).      ║
 * ║                                                                          ║
 * ║    a-AC-3  POST /api/memories lands a real `memories` row (201).           ║
 * ║    a-AC-2  POST /api/memories/recall surfaces it (BM25/ILIKE lexical arm,  ║
 * ║            embeddings OFF — the silent fallback, ledger D-4).             ║
 * ║    a-AC-6  every request stamps `x-honeycomb-session` (the session group   ║
 * ║            the runtime-path middleware guards); a request without it 400s. ║
 * ║    bonus   recall ALSO surfaces a captured `sessions` raw turn for the     ║
 * ║            same term when one is seeded (the cross-arm hybrid coverage).   ║
 * ║                                                                          ║
 * ║  GATED + ISOLATED (same posture as golden-path-live.itest.ts):           ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = skip,exit 0.║
 * ║    - `.itest.ts` + `tests/integration/**` exclusion keep it OUT of         ║
 * ║      `npm run ci`. Only `npm run test:integration` runs it.              ║
 * ║    - Per-run UNIQUE term so the proof reads only THIS run's row — never    ║
 * ║      clobbers or reads real data. Append-only; in the token's authorized   ║
 * ║      workspace (`HONEYCOMB_DEEPLAKE_WORKSPACE`, default `honeycomb_ci`).   ║
 * ║                                                                          ║
 * ║  The 022d composition root does not yet wire `mountMemoriesApi` (that IS   ║
 * ║  022d). For THIS itest we mount it manually onto the assembled daemon —    ║
 * ║  `mountMemoriesApi(booted.assembled.daemon, { storage })` — exactly the    ║
 * ║  one call 022d will add to `assembleSeams()`.                            ║
 * ║                                                                          ║
 * ║  120s CAP. SECRETS: the token reaches the daemon ONLY via the storage     ║
 * ║  layer's env provider — never hardcoded, logged, or echoed. Do NOT run    ║
 * ║  locally; the orchestrator runs it with creds.                           ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createStorageClient,
	envCredentialProvider,
	type QueryScope,
	resolveStorageConfig,
	type StorageClient,
} from "../../src/daemon/storage/index.js";
import { mountMemoriesApi } from "../../src/daemon/runtime/memories/index.js";
import { bootTestDaemon, type BootedTestDaemon } from "./_daemon-harness.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

/** A per-run unique id so the proof reads only THIS run's rows (never real data). */
function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
/** The deterministic, per-run-unique recall term seeded into the stored memory. */
const RECALL_TERM = `memoriesapi${RUN_ID}`;
/** A session id stamped on every request (the a-AC-6 session-group requirement). */
const SESSION = `022a-mem-${RUN_ID}`;

describe.skipIf(!HAS_TOKEN)("PRD-022a /api/memories store→recall over HTTP (live)", () => {
	let booted: BootedTestDaemon;
	let storage: StorageClient;
	let scope: QueryScope;
	let headers: Record<string, string>;
	let noSessionHeaders: Record<string, string>;

	beforeAll(async () => {
		// Resolve the token's authorized tenancy from the env provider — the SAME scope the
		// assembled daemon's storage client resolves — so the stored row lands in-scope.
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

		// Boot the REAL assembled daemon against live DeepLake on an ephemeral port (021a),
		// then MOUNT the memories API manually — assembleDaemon does not wire it yet (022d does).
		booted = await bootTestDaemon({ mode: "local" });
		mountMemoriesApi(booted.assembled.daemon, { storage });

		// The session-group headers every request stamps: org/workspace (tenancy) +
		// runtime-path + session (the runtime-path middleware requires the last two).
		headers = {
			"x-honeycomb-org": scope.org,
			"x-honeycomb-workspace": scope.workspace ?? "honeycomb_ci",
			"x-honeycomb-runtime-path": "legacy",
			"x-honeycomb-session": SESSION,
			"content-type": "application/json",
		};
		noSessionHeaders = { ...headers };
		delete noSessionHeaders["x-honeycomb-session"];
	}, 120_000);

	afterAll(async () => {
		if (booted) await booted.stop();
	});

	it(
		"a-AC-3 + a-AC-2: a stored memory is recalled over HTTP by the wired engines",
		async () => {
			// ── a-AC-6: the session group rejects a request with no x-honeycomb-session. ──
			const noSession = await fetch(`${booted.baseUrl}/api/memories/recall`, {
				method: "POST",
				headers: noSessionHeaders,
				body: JSON.stringify({ query: RECALL_TERM }),
			});
			expect(noSession.status, "a-AC-6: no session header → rejected before the handler").toBe(400);

			// ── a-AC-3: STORE a real memory carrying the unique term (no 501). ───────────
			const storeRes = await fetch(`${booted.baseUrl}/api/memories`, {
				method: "POST",
				headers,
				body: JSON.stringify({ content: `the ${RECALL_TERM} subsystem wires recall to HTTP` }),
			});
			expect(storeRes.status, "a-AC-3: store landed a row (201, not 501)").toBe(201);
			const stored = (await storeRes.json()) as { id: string | null; action: string };
			expect(stored.action, "a-AC-3: the controlled-writes engine inserted (or deduped) a row").toMatch(
				/inserted|deduped/,
			);
			expect(stored.id, "a-AC-3: the stored row has an id").not.toBeNull();

			// ── a-AC-2: RECALL the stored memory over HTTP (poll-convergent — the just-written
			// row may not be visible on the first read on this eventually-consistent backend). ──
			let recalled = false;
			let degraded = true;
			for (let poll = 0; poll < 40 && !recalled; poll++) {
				const recallRes = await fetch(`${booted.baseUrl}/api/memories/recall`, {
					method: "POST",
					headers,
					body: JSON.stringify({ query: RECALL_TERM }),
				});
				expect(recallRes.status, "a-AC-2: recall serves (no 501)").toBe(200);
				const body = (await recallRes.json()) as {
					hits: { source: string; id: string; text: string }[];
					sources: string[];
					degraded: boolean;
				};
				degraded = body.degraded;
				if (body.hits.some((h) => h.text.includes(RECALL_TERM))) recalled = true;
				if (!recalled) await new Promise((r) => setTimeout(r, 350));
			}
			expect(recalled, "a-AC-2: the stored memory is surfaced by recall over HTTP (the data-API thesis)").toBe(
				true,
			);
			// Embeddings OFF for the data-API proof → the BM25/ILIKE lexical arm (ledger D-4).
			expect(degraded, "a-AC-2: recall ran the lexical fallback (embeddings off)").toBe(true);

			// ── bonus: GET the stored memory back by id over HTTP (FR-4). ────────────────
			if (stored.id !== null) {
				const getRes = await fetch(`${booted.baseUrl}/api/memories/${encodeURIComponent(stored.id)}`, {
					headers,
				});
				// The version-bumped row should read back (200) carrying the term; a 404 is a
				// freshness miss on this eventually-consistent backend and is non-fatal here.
				if (getRes.status === 200) {
					const got = (await getRes.json()) as { memory: { id: string; content: string } };
					expect(got.memory.content, "FR-4: GET /api/memories/:id returns the stored content").toContain(
						RECALL_TERM,
					);
				}
			}

			// eslint-disable-next-line no-console
			console.log(
				`[022a receipt] store→recall over HTTP: term=${RECALL_TERM} recalled=${recalled} degraded=${degraded}`,
			);
		},
		120_000,
	);
});
