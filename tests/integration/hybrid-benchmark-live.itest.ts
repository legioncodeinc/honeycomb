/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  PRD-047 W0 — native `deeplake_hybrid_record` vs post-query RRF (LIVE A/B). ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  The decision instrument PRD-027 D-1 deferred: run the SAME committed       ║
 * ║  golden set through BOTH recall implementations against the SAME warm live  ║
 * ║  store and emit recall@k / MRR / nDCG for each, plus the delta —            ║
 * ║                                                                            ║
 * ║    • current  — `recallMemories` (per-arm `<#>` + BM25, fused in TS by RRF) ║
 * ║    • candidate — `hybridRecall`  (DeepLake's native `deeplake_hybrid_record`)║
 * ║                                                                            ║
 * ║  This does NOT assert a winner: which fusion is better is the OPEN QUESTION ║
 * ║  the benchmark answers with numbers, not a baked-in assumption. It asserts  ║
 * ║  only that BOTH paths ran end-to-end and the harness emitted comparable     ║
 * ║  metrics (a `[045 receipt]` line per path + the delta). The PRD reads the   ║
 * ║  receipts and decides adoption.                                            ║
 * ║                                                                            ║
 * ║  GATED + ISOLATED (mirrors recall-eval-live.itest.ts):                     ║
 * ║   - SKIPS CLEANLY (exit 0) when the DeepLake token is absent OR the embed   ║
 * ║     daemon is unreachable / embeddings are off.                            ║
 * ║   - `.itest.ts` keeps it OUT of `npm run ci`; only `test:integration` /     ║
 * ║     `npm run bench:hybrid` runs it.                                        ║
 * ║   - Per-run UNIQUE keys/ids: every seeded memory carries the run id so the  ║
 * ║     benchmark reads ONLY this run's rows (append-only honeycomb_ci).        ║
 * ║   - Poll-convergent reads (DeepLake eventual consistency) before scoring.   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createStorageClient,
	envCredentialProvider,
	type QueryScope,
	resolveStorageConfig,
	sLiteral,
	sqlIdent,
	sqlLike,
	isOk,
	type StorageClient,
} from "../../src/daemon/storage/index.js";
import { EMBEDDING_DIMS, vectorSearch } from "../../src/daemon/storage/vector.js";
import {
	createEmbedAttachment,
	resolveEmbedClientOptions,
	type EmbedClient,
} from "../../src/daemon/runtime/services/embed-client.js";
import { mountMemoriesApi } from "../../src/daemon/runtime/memories/index.js";
import { recallMemories } from "../../src/daemon/runtime/memories/recall.js";
import { hybridRecall, resolveHybridWeights } from "../../src/daemon/runtime/memories/hybrid-recall.js";
import {
	runEval,
	seedTextFor,
	type EvalReport,
	type ExpectedIds,
	type GoldenSet,
	loadGoldenSet,
} from "../../src/eval/golden.js";
import type { AggregateMetrics } from "../../src/eval/metrics.js";
import { bootTestDaemon, type BootedTestDaemon } from "./_daemon-harness.js";
import { neutralizeIfInfraDegraded } from "./_infra-skip.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

/** A per-run unique id so the benchmark reads ONLY this run's rows. */
function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
const SESSION = `prd045-bench-${RUN_ID}`;
const HERE = dirname(fileURLToPath(import.meta.url));
const EVAL_DIR = join(HERE, "..", "..", "eval");
const GOLDEN: GoldenSet = loadGoldenSet(readFileSync(join(EVAL_DIR, "recall-golden.json"), "utf8"));

/** Probe the embed daemon: a real 768-dim vector back ⇒ embeddings are genuinely available. */
async function embedDaemonReachable(): Promise<boolean> {
	const opts = resolveEmbedClientOptions();
	if (!opts.enabled) return false;
	try {
		const res = await fetch(`${opts.url}/embed`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ text: "probe" }),
			signal: AbortSignal.timeout(Math.min(opts.timeoutMs, 4_000)),
		});
		if (!res.ok) return false;
		const body = (await res.json()) as { vector?: unknown };
		return Array.isArray(body.vector) && body.vector.length === EMBEDDING_DIMS;
	} catch {
		return false;
	}
}

/** Pretty-print the headline metrics for a receipt line. */
function fmt(m: AggregateMetrics): string {
	return (
		`recall@1=${m.recallAtK["1"]?.toFixed(3)} recall@5=${m.recallAtK["5"]?.toFixed(3)} ` +
		`recall@10=${m.recallAtK["10"]?.toFixed(3)} MRR=${m.mrr.toFixed(3)} nDCG=${m.ndcg.toFixed(3)}`
	);
}

describe.skipIf(!HAS_TOKEN)("PRD-047 native-hybrid vs RRF benchmark (live, gated)", () => {
	let booted: BootedTestDaemon;
	let storage: StorageClient;
	let scope: QueryScope;
	let headers: Record<string, string>;
	let embedReady = false;
	let embedClient: EmbedClient | undefined;
	const expectedIds = new Map<string, string>();
	const relevanceClass = new Map<string, readonly string[]>();

	beforeAll(async () => {
		embedReady = await embedDaemonReachable();
		if (!embedReady) {
			// eslint-disable-next-line no-console
			console.log("[prd045] embed daemon unreachable / embeddings off — hybrid benchmark SKIPS (not a failure).");
			return;
		}
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
		booted = await bootTestDaemon({ mode: "local" });
		const embed = createEmbedAttachment({ storage });
		embedClient = embed.client;
		mountMemoriesApi(booted.assembled.daemon, { storage, embed: embed.client });
		headers = {
			"x-honeycomb-org": scope.org,
			"x-honeycomb-workspace": scope.workspace ?? "honeycomb_ci",
			"x-honeycomb-runtime-path": "legacy",
			"x-honeycomb-session": SESSION,
			"content-type": "application/json",
		};
	}, 120_000);

	afterAll(async () => {
		if (booted) await booted.stop();
	});

	/** Poll a read-back to convergence (DeepLake eventual consistency — never a single read). */
	async function pollUntil(check: () => Promise<boolean>, attempts = 120, delayMs = 1_000): Promise<boolean> {
		for (let i = 0; i < attempts; i++) {
			if (await check()) return true;
			await new Promise((r) => setTimeout(r, delayMs));
		}
		return false;
	}

	/** Seed every golden pair as a memory under a per-run key, capturing the storage id. */
	async function seedGolden(): Promise<void> {
		for (const pair of GOLDEN.pairs) {
			const res = await fetch(`${booted.baseUrl}/api/memories`, {
				method: "POST",
				headers,
				body: JSON.stringify({ content: seedTextFor(pair, RUN_ID) }),
			});
			expect(res.status, `seed for ${pair.key} landed (201)`).toBe(201);
			const stored = (await res.json()) as { id: string | null };
			if (stored.id !== null) expectedIds.set(pair.key, stored.id);
		}
	}

	/** PHASE 1 — poll until every seeded memory's content_embedding column is a 768-dim vector. */
	async function awaitColumnConvergence(): Promise<boolean> {
		const ids = [...expectedIds.values()];
		if (ids.length === 0) return false;
		const inList = ids.map((id) => sLiteral(id)).join(", ");
		const sql =
			`SELECT COUNT(*) AS n FROM "${sqlIdent("memories")}" ` +
			`WHERE ${sqlIdent("id")} IN (${inList}) AND ARRAY_LENGTH(${sqlIdent("content_embedding")}, 1) = ${EMBEDDING_DIMS}`;
		return pollUntil(async () => {
			const res = await storage.query(sql, scope);
			if (!isOk(res) || res.rows.length === 0) return false;
			return Number(res.rows[0]?.n ?? 0) >= ids.length;
		});
	}

	/** PHASE 2 — prove the `<#>` vector segment is warm (per-seed cluster-served self-recall, 90% quorum). */
	async function awaitVectorPathConvergence(): Promise<boolean> {
		if (embedClient === undefined) return false;
		const seedVectors = new Map<string, readonly number[]>();
		for (const pair of GOLDEN.pairs) {
			if (expectedIds.get(pair.key) === undefined) continue;
			const vec = await embedClient.embed(seedTextFor(pair, RUN_ID));
			if (vec === null || vec.length !== EMBEDDING_DIMS) return false;
			seedVectors.set(pair.key, vec);
		}
		const WARM_SCORE = 0.9;
		const quorum = Math.ceil(seedVectors.size * 0.9);
		async function served(queryVector: readonly number[]): Promise<boolean> {
			try {
				const recall = await vectorSearch(storage, scope, {
					table: "memories",
					idColumn: "id",
					embeddingColumn: "content_embedding",
					queryVector,
					scope: {},
					limit: 5,
				});
				const top = recall.ids[0];
				return top !== undefined && top.score >= WARM_SCORE;
			} catch {
				return false;
			}
		}
		return pollUntil(async () => {
			let warm = 0;
			for (const vec of seedVectors.values()) if (await served(vec)) warm++;
			return warm >= quorum;
		}, 120, 1_000);
	}

	/** Build each golden pair's relevance CLASS (this run's seed + equally-correct prior copies). */
	async function buildRelevanceClasses(): Promise<void> {
		for (const pair of GOLDEN.pairs) {
			const pattern = `'%${sqlLike(pair.memoryText)}%'`;
			const sql =
				`SELECT ${sqlIdent("id")} AS id FROM "${sqlIdent("memories")}" ` +
				`WHERE ${sqlIdent("content")}::text ILIKE ${pattern} AND ${sqlIdent("is_deleted")} = 0`;
			const res = await storage.query(sql, scope);
			const ids = new Set<string>();
			const thisRun = expectedIds.get(pair.key);
			if (thisRun !== undefined) ids.add(thisRun);
			if (isOk(res)) for (const r of res.rows) ids.add(String(r.id ?? ""));
			ids.delete("");
			relevanceClass.set(pair.key, [...ids]);
		}
	}

	/** Score one recall implementation against the converged store. */
	async function evalWith(recall: (query: string) => Promise<readonly string[]>): Promise<EvalReport> {
		const expected: ExpectedIds = relevanceClass;
		return runEval(GOLDEN, recall, expected);
	}

	it(
		"runs both recall paths on the golden set and emits a metrics receipt for each + the delta",
		async ({ skip }) => {
			if (!embedReady) return;
			await neutralizeIfInfraDegraded("hybrid-benchmark-live:preflight", () => storage.connect(scope), skip);

			await seedGolden();
			expect(expectedIds.size, "every golden pair seeded a memory id").toBe(GOLDEN.pairs.length);

			const converged = (await awaitColumnConvergence()) && (await awaitVectorPathConvergence());
			expect(converged, "the store warmed on BOTH the content_embedding column AND the `<#>` vector path").toBe(true);
			await buildRelevanceClasses();

			// Both paths read the SAME warm store with the SAME embed seam — the only variable is fusion.
			const weights = resolveHybridWeights();
			const rrf = await evalWith(async (query) => {
				const r = await recallMemories({ query, scope, limit: 10 }, { storage, embed: embedClient });
				return r.hits.map((h) => h.id);
			});
			const hybrid = await evalWith(async (query) => {
				const r = await hybridRecall({ query, scope, limit: 10 }, { storage, embed: embedClient }, weights);
				return r.hits.map((h) => h.id);
			});

			const dR5 = (hybrid.metrics.recallAtK["5"] ?? 0) - (rrf.metrics.recallAtK["5"] ?? 0);
			const dMrr = hybrid.metrics.mrr - rrf.metrics.mrr;
			// eslint-disable-next-line no-console
			console.log(`[045 receipt] RRF (current):    ${fmt(rrf.metrics)}`);
			// eslint-disable-next-line no-console
			console.log(`[045 receipt] hybrid (candidate): ${fmt(hybrid.metrics)} [weights v=${weights.vector} t=${weights.text}]`);
			// eslint-disable-next-line no-console
			console.log(`[045 receipt] delta (hybrid − RRF): recall@5 Δ=${dR5.toFixed(3)} MRR Δ=${dMrr.toFixed(3)}`);

			// The bar is "both ran and measured", NOT "hybrid won" — adoption is the PRD's call on the numbers.
			expect(rrf.queries.length).toBe(GOLDEN.pairs.length);
			expect(hybrid.queries.length).toBe(GOLDEN.pairs.length);
			expect(rrf.metrics.recallAtK["10"], "RRF surfaced real hits").toBeGreaterThan(0);
			expect(hybrid.metrics.recallAtK["10"], "native hybrid surfaced real hits (the operator works)").toBeGreaterThan(0);
		},
		600_000,
	);
});
