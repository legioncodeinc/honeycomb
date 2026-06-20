/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  THE HEADLINE — PRD-022e (Wave 3), the data-access API ACCEPTANCE PROOF.  ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  The whole point of PRD-022: a real captured turn is recalled THROUGH the  ║
 * ║  `/api/memories/recall` HTTP route — by the CLI, the SDK, AND the MCP —    ║
 * ║  against LIVE DeepLake, on a REAL assembled daemon. NOT around it via       ║
 * ║  direct SQL (that was PRD-021f's golden path; this proves the ROUTE the     ║
 * ║  clients actually use). No manual seam mount, no 501, no 400.             ║
 * ║                                                                          ║
 * ║    e-AC-1 CLI       store a turn via the CLI loopback DaemonClient through  ║
 * ║                     `POST /api/memories`, then recall it through            ║
 * ║                     `POST /api/memories/recall` — the `honeycomb recall`    ║
 * ║                     transport, header-stamping and all. The turn returns.   ║
 * ║    e-AC-2 SDK       the real `createHoneycombClient(...).recall("<term>")`  ║
 * ║                     returns the SAME turn through the SAME HTTP route +      ║
 * ║                     session header.                                       ║
 * ║    e-AC-3 MCP       the real `HANDLERS.memory_search` (mcp/src/handlers.ts) ║
 * ║                     driven through the production `createHttpDaemonApiSeam` ║
 * ║                     returns the SAME turn through the SAME HTTP route.      ║
 * ║                     (Three clients, ONE wired route — the index AC-1        ║
 * ║                     trifecta.)                                            ║
 * ║    e-AC-4 WRITE     a SECOND `remember` (store) through `/api/memories` is  ║
 * ║                     recalled back through the route — the write→read loop   ║
 * ║                     over HTTP (controlled-writes, not direct SQL).         ║
 * ║    e-AC-5 SURFACE   the rest of the wired surface answers (not 501):        ║
 * ║                     `/memory` VFS grep + cat (022b), `/api/goals` POST→GET  ║
 * ║                     (022c), `/api/kpis` same-key-twice → ONE row (022c).    ║
 * ║                     (`/api/sources` is DEFERRED/501 per 022d — NOT asserted)║
 * ║                                                                          ║
 * ║  GATED + ISOLATED (same posture as data-api-assembled-live.itest.ts):     ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = skip,exit 0.║
 * ║    - `.itest.ts` + `tests/integration/**` exclusion keep it OUT of         ║
 * ║      `npm run ci`; only `npm run test:integration` runs it.              ║
 * ║    - Per-run UNIQUE terms/keys so the proof reads only THIS run's rows.    ║
 * ║    - Ephemeral port (bootTestDaemon binds port 0 — never 3850).            ║
 * ║    - Boot the assembled daemon ONCE; all six clients share it.            ║
 * ║                                                                          ║
 * ║  Embeddings OFF for the proof (D-4): recall runs the BM25/ILIKE degraded   ║
 * ║  arm — `degraded:true` is acceptable; the HIT is what matters.            ║
 * ║                                                                          ║
 * ║  120s CAP. SECRETS via env only (the storage layer's provider). Do NOT     ║
 * ║  run locally; the orchestrator runs it with creds. The operator smoke      ║
 * ║  `scripts/dogfood-acceptance-smoke.mjs` (npm run smoke:data-api) wraps      ║
 * ║  this same proof for a human.                                            ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createStorageClient,
	envCredentialProvider,
	type QueryScope,
	resolveStorageConfig,
} from "../../src/daemon/storage/index.js";
import { createLoopbackDaemonClient, type DaemonClient } from "../../src/commands/index.js";
import { createHoneycombClient } from "../../src/sdk/index.js";
import { HANDLERS } from "../../mcp/src/handlers.js";
import { createHttpDaemonApiSeam } from "../../mcp/src/daemon-seam.js";
import type { Actor } from "../../mcp/src/contracts.js";
import { bootTestDaemon, type BootedTestDaemon } from "./_daemon-harness.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

/** A per-run unique id so the proof reads only THIS run's rows (never real data). */
function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
/** The deterministic, per-run-unique recall term the CLI seeds and all three clients recall. */
const RECALL_TERM = `dogfood${RUN_ID}`;
/** A SECOND term seeded by the e-AC-4 remember→recall-over-HTTP loop. */
const REMEMBER_TERM = `remembered${RUN_ID}`;

/** The MCP actor identity stamped onto every MCP daemon call (a plugin-path thin client). */
const MCP_ACTOR: Actor = { actor: "ci-022e-dogfood", actorType: "agent" };

/** A recall hit as the wired `/api/memories/recall` route returns it. */
interface RecallHit {
	readonly source: string;
	readonly id: string;
	readonly text: string;
}

/** The wired recall response envelope (022a route shape). */
interface RecallBody {
	readonly hits: RecallHit[];
	readonly sources: string[];
	readonly degraded: boolean;
}

describe.skipIf(!HAS_TOKEN)(
	"PRD-022e DOGFOOD: capture→recall THROUGH /api/memories/recall by the CLI, the SDK, and the MCP (live, assembled daemon)",
	() => {
		let booted: BootedTestDaemon;
		let cli: DaemonClient;
		let scope: QueryScope;
		/** The tenancy headers every client carries; the session/runtime-path headers each client stamps itself. */
		let tenancyHeaders: Record<string, string>;

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

			// Boot the REAL assembled daemon against live DeepLake on an ephemeral port. The
			// assembly FIRES the three data seams (022d d-AC-1) — we do NOT mount anything
			// manually. That is the dogfood bar: the seams are wired into assembleDaemon, so the
			// CLI/SDK/MCP all reach a REAL handler (no 501), through the runtime-path middleware
			// (no 400, because each client stamps the session-group headers).
			booted = await bootTestDaemon({ mode: "local", storage: createStorageClient({ provider }) });

			tenancyHeaders = {
				"x-honeycomb-org": scope.org,
				"x-honeycomb-workspace": scope.workspace ?? "honeycomb_ci",
			};
			// The REAL CLI loopback client (`honeycomb recall`'s transport): it stamps the
			// session-group headers (runtime-path + synthetic session) automatically for /api/memories.
			cli = createLoopbackDaemonClient({ baseUrl: booted.baseUrl, headers: tenancyHeaders });
		}, 120_000);

		afterAll(async () => {
			if (booted) await booted.stop();
		});

		// ── e-AC-1 + e-AC-2 + e-AC-3: the index AC-1 trifecta ─────────────────────────
		// One captured turn, recalled THROUGH /api/memories/recall by all three clients.
		it(
			"e-AC-1/2/3: a turn stored over HTTP is recalled THROUGH /api/memories/recall by the CLI, the SDK, AND the MCP",
			async () => {
				// ── e-AC-1 (capture): store the turn via the CLI client (`honeycomb remember`-equiv).
				// The CLI client stamps the session headers, so this reaches the wired handler (201).
				const stored = await cli.send({
					method: "POST",
					path: "/api/memories",
					body: { content: `the ${RECALL_TERM} subsystem proves dogfood recall through the HTTP route` },
				});
				expect(stored.status, "e-AC-1: store landed a row through /api/memories (201, not 501/400)").toBe(201);
				const storedBody = stored.body as { id: string | null; action: string };
				expect(storedBody.action, "the controlled-writes engine inserted (or deduped) the row").toMatch(
					/inserted|deduped/,
				);

				// ── e-AC-1 (recall, CLI path): `honeycomb recall "<term>"`-equivalent through the
				// CLI client → the turn returns via /api/memories/recall (poll-convergent: a just-
				// written row may not be visible on the first read on this eventually-consistent
				// backend; polling converges UP and never invents a hit).
				const cliRecall = await pollRecallCli(cli, RECALL_TERM);
				expect(cliRecall.hit, "e-AC-1: the CLI recalls the captured turn THROUGH /api/memories/recall").toBe(true);
				expect(cliRecall.lastStatus, "e-AC-1: recall reached the handler (no 400/501)").toBe(200);

				// ── e-AC-2 (SDK path): the real SDK client, pointed at the SAME booted daemon, runs
				// `recall()` → the SAME hit, through the SAME HTTP route + session header. The SDK
				// maps the wired `{hits:[{id,text}]}` envelope to `RecallResult[]` (path ← id).
				const sdk = createHoneycombClient({
					daemonUrl: booted.baseUrl,
					actor: "ci-022e-sdk",
					actorType: "agent",
					// The loopback daemon resolves tenancy from the local-mode open middleware; the SDK
					// still carries the org/workspace as actor-scope headers via its own stamping. The
					// token rides only because baseUrl is loopback (isTokenTransportSafe), never logged.
					token: process.env.HONEYCOMB_DEEPLAKE_TOKEN,
				});
				const sdkHits = await pollRecallSdk(sdk, RECALL_TERM);
				expect(
					sdkHits.some((h) => h.text.includes(RECALL_TERM)),
					"e-AC-2: the SDK recalls the SAME turn THROUGH the same /api/memories/recall route",
				).toBe(true);

				// ── e-AC-3 (MCP path): the real MCP `memory_search` handler, driven through the
				// production `createHttpDaemonApiSeam` pointed at the booted daemon's ephemeral port.
				// The seam stamps the plugin runtime-path + synthetic session header (d-AC-3), so the
				// handler routes `POST /api/memories/recall` and returns the SAME hit.
				const mcpSeam = createHttpDaemonApiSeam({ host: booted.address.host, port: booted.address.port });
				const mcpHit = await pollRecallMcp(mcpSeam, RECALL_TERM);
				expect(
					mcpHit,
					"e-AC-3: the MCP memory_search recalls the SAME turn THROUGH the same /api/memories/recall route",
				).toBe(true);

				// eslint-disable-next-line no-console
				console.log(
					`[022e receipt] index AC-1 trifecta: term=${RECALL_TERM} ` +
						`CLI=hit SDK=hit MCP=hit through /api/memories/recall (degraded=${String(cliRecall.degraded)})`,
				);
			},
			120_000,
		);

		// ── e-AC-4: remember → recall over HTTP (the write→read loop, controlled-writes) ──
		it(
			"e-AC-4: a remember through /api/memories is recalled back THROUGH /api/memories/recall (write→read over HTTP)",
			async () => {
				// Store via the CLI client `remember` path (the controlled-writes ADD, NOT direct SQL).
				const remembered = await cli.send({
					method: "POST",
					path: "/api/memories",
					body: { content: `note: the ${REMEMBER_TERM} fact was remembered over the HTTP write route` },
				});
				expect(remembered.status, "e-AC-4: remember landed a row over /api/memories (201)").toBe(201);

				// Recall it back THROUGH the route (poll-convergent).
				const recalled = await pollRecallCli(cli, REMEMBER_TERM);
				expect(
					recalled.hit,
					"e-AC-4: the remembered fact is recalled back THROUGH /api/memories/recall (write→read over HTTP)",
				).toBe(true);

				// eslint-disable-next-line no-console
				console.log(`[022e receipt] remember→recall over HTTP: term=${REMEMBER_TERM} recalled=true`);
			},
			120_000,
		);

		// ── e-AC-5: the rest of the wired surface answers (not 501) ───────────────────
		// VFS browse (022b) + product-data (022c) through the SAME assembled daemon.
		it(
			"e-AC-5: the VFS browse + product-data surface answers through the assembled daemon (not 501)",
			async () => {
				// ── VFS grep (022b /memory/grep) — a SESSION group, so it goes through the CLI client
				// (which stamps the session headers). It reaches a real handler (200), with the
				// embeddings-off lexical degraded signal observable. We assert it ANSWERS (not 501/400),
				// not a specific hit (grep ranks over the `memories` engine table; freshness varies).
				const grep = await cli.send({
					method: "GET",
					path: "/memory/grep",
					query: { q: RECALL_TERM },
				});
				expect(grep.status, "e-AC-5: /memory/grep answers through the assembled daemon (not 501/400)").toBe(200);
				const grepBody = grep.body as { query: string; degraded: boolean; hits: unknown[] };
				expect(Array.isArray(grepBody.hits), "e-AC-5: /memory/grep returns the recall envelope").toBe(true);

				// ── VFS cat (022b /memory/cat) — answers (a missing path is `found:false`, still 200).
				const cat = await cli.send({
					method: "GET",
					path: "/memory/cat",
					query: { path: `conversations/does-not-exist-${RUN_ID}` },
				});
				expect(cat.status, "e-AC-5: /memory/cat answers through the assembled daemon (not 501/400)").toBe(200);
				const catBody = cat.body as { path: string; found: boolean; content: string };
				expect(catBody.found, "e-AC-5: /memory/cat reports a clean miss for an absent path (not an invented row)").toBe(
					false,
				);

				// ── product-data: /api/goals POST → GET (022c). NOT a session group → tenancy headers
				// only (a raw fetch suffices; the CLI client would over-stamp the session header, which
				// is harmless but the dashboard-group resolver ignores it). POST upserts + reads back.
				const goalKey = `dogfood-goal-${RUN_ID}`;
				const goalPost = await fetch(`${booted.baseUrl}/api/goals`, {
					method: "POST",
					headers: { ...tenancyHeaders, "content-type": "application/json" },
					body: JSON.stringify({ key: goalKey, value: "prove the data-access API end to end" }),
				});
				expect(goalPost.status, "e-AC-5: POST /api/goals upserts through the assembled daemon (201, not 501)").toBe(201);

				const goalGet = await fetch(`${booted.baseUrl}/api/goals`, { headers: tenancyHeaders });
				expect(goalGet.status, "e-AC-5: GET /api/goals answers (200)").toBe(200);
				const goalsBody = (await goalGet.json()) as { goals: { key: string; value: string }[] };
				expect(
					goalsBody.goals.some((g) => g.key === goalKey),
					"e-AC-5: GET /api/goals returns the just-upserted goal (POST→GET read-back)",
				).toBe(true);

				// ── product-data: /api/kpis same key TWICE → ONE row (022c c-AC-2). The second POST
				// UPDATES in place; GET shows exactly one row for the key, with the second value.
				const kpiKey = `dogfood-kpi-${RUN_ID}`;
				const kpiFirst = await fetch(`${booted.baseUrl}/api/kpis`, {
					method: "POST",
					headers: { ...tenancyHeaders, "content-type": "application/json" },
					body: JSON.stringify({ key: kpiKey, value: "1" }),
				});
				expect(kpiFirst.status, "e-AC-5: POST /api/kpis (first) lands (201)").toBe(201);
				const kpiSecond = await fetch(`${booted.baseUrl}/api/kpis`, {
					method: "POST",
					headers: { ...tenancyHeaders, "content-type": "application/json" },
					body: JSON.stringify({ key: kpiKey, value: "2" }),
				});
				expect(kpiSecond.status, "e-AC-5: POST /api/kpis (second, same key) lands (201)").toBe(201);

				// Poll-convergent read (eventual consistency): the read right after the UPDATE can
				// flap to a stale segment showing the prior value, so poll until the durable
				// current state (value="2", the last write) surfaces. A stale segment under-reports,
				// never invents, so this converges UP to the second value.
				let sameKey: { key: string; value: string }[] = [];
				for (let poll = 0; poll < 40; poll++) {
					const kpiGet = await fetch(`${booted.baseUrl}/api/kpis`, { headers: tenancyHeaders });
					expect(kpiGet.status, "e-AC-5: GET /api/kpis answers (200)").toBe(200);
					const kpisBody = (await kpiGet.json()) as { kpis: { key: string; value: string }[] };
					sameKey = kpisBody.kpis.filter((k) => k.key === kpiKey);
					if (sameKey.length === 1 && sameKey[0]?.value === "2") break;
					await sleep(POLL_DELAY_MS);
				}
				expect(
					sameKey.length,
					"e-AC-5: /api/kpis same-key-twice → exactly ONE row (an existing key UPDATES, never duplicates)",
				).toBe(1);
				expect(sameKey[0]?.value, "e-AC-5: the surviving KPI row carries the SECOND value").toBe("2");

				// eslint-disable-next-line no-console
				console.log(
					`[022e receipt] wired surface answers: /memory/grep=200 /memory/cat=200 ` +
						`/api/goals POST→GET=ok /api/kpis same-key-twice→1 row`,
				);
			},
			120_000,
		);
	},
);

// ════════════════════════════════════════════════════════════════════════════
// Poll-convergent recall drivers — one per client, all hitting the SAME wired
// /api/memories/recall route. Eventual consistency: a just-written row may not be
// visible on the first read; polling converges UP (a stale segment under-reports,
// never invents). Each asserts the route reached the handler (no 400/501) before
// looking for the seeded term.
// ════════════════════════════════════════════════════════════════════════════

/** The shared poll budget — 40 attempts × 350ms ≈ 14s, well under the 120s cap. */
const POLL_ATTEMPTS = 40;
const POLL_DELAY_MS = 350;

function sleep(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

/** The CLI-client recall outcome (the hit flag + the last HTTP status + the degraded signal). */
interface CliRecallOutcome {
	readonly hit: boolean;
	readonly lastStatus: number;
	readonly degraded: boolean;
}

/** Drive recall through the real CLI loopback client (`honeycomb recall`'s transport). */
async function pollRecallCli(cli: DaemonClient, term: string): Promise<CliRecallOutcome> {
	let lastStatus = 0;
	let degraded = false;
	for (let poll = 0; poll < POLL_ATTEMPTS; poll++) {
		const res = await cli.send({ method: "POST", path: "/api/memories/recall", body: { query: term } });
		lastStatus = res.status;
		// The route MUST reach the handler — a 400/501 here is a real product bug, never poll-retried away.
		if (res.status !== 200) return { hit: false, lastStatus, degraded };
		const body = res.body as RecallBody;
		degraded = body.degraded === true;
		if (body.hits.some((h) => h.text.includes(term))) return { hit: true, lastStatus, degraded };
		await sleep(POLL_DELAY_MS);
	}
	return { hit: false, lastStatus, degraded };
}

/** Drive recall through the real SDK `client.recall()` (maps hits→RecallResult, path ← id). */
async function pollRecallSdk(
	sdk: ReturnType<typeof createHoneycombClient>,
	term: string,
): Promise<readonly { path: string; text: string }[]> {
	for (let poll = 0; poll < POLL_ATTEMPTS; poll++) {
		const hits = await sdk.recall(term);
		if (hits.some((h) => h.text.includes(term))) return hits;
		await sleep(POLL_DELAY_MS);
	}
	return [];
}

/** Drive recall through the real MCP `memory_search` handler over the production seam. */
async function pollRecallMcp(seam: ReturnType<typeof createHttpDaemonApiSeam>, term: string): Promise<boolean> {
	const handler = HANDLERS.memory_search;
	if (handler === undefined) throw new Error("memory_search handler is not registered");
	for (let poll = 0; poll < POLL_ATTEMPTS; poll++) {
		// The handler routes POST /api/memories/recall through the seam (which stamps the session
		// header) and returns the daemon's recall body on a 2xx (it throws on a non-2xx, so a
		// 400/501 surfaces as a real failure rather than a silent miss).
		const body = (await handler({ query: term }, MCP_ACTOR, seam)) as RecallBody;
		if (Array.isArray(body.hits) && body.hits.some((h) => h.text.includes(term))) return true;
		await sleep(POLL_DELAY_MS);
	}
	return false;
}
