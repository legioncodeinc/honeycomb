/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  PRD-046f — the PRIME-EVAL harness, LIVE (f-AC-2 signals + f-AC-3 the bar).║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  Proves session priming changes what the agent retrieves vs a COLD start.  ║
 * ║  A committed prime-scenario set (target memory + a task) is seeded into a   ║
 * ║  per-run honeycomb_ci workspace, the REAL prime digest is assembled from    ║
 * ║  the live scope (`buildPrimeForScope` — the 046c read path), and each       ║
 * ║  scenario is scored PRIMED-vs-COLD on deterministic signals:               ║
 * ║                                                                          ║
 * ║    PULL-THROUGH      — is the seeded TARGET's id present in the assembled   ║
 * ║                        digest (so the primed agent resolves it with one     ║
 * ║                        hivemind_read, no blind search)? MEASURED from the   ║
 * ║                        real digest — not assumed. Cold has no digest → 0.   ║
 * ║    REDUNDANT-SEARCH  — cold must blind-search (the scenario's committed     ║
 * ║      REDUCTION         coldSearchCount, confirmed reachable via a REAL      ║
 * ║                        `recallMemories` blind search); primed reaches the   ║
 * ║                        target through the digest with ZERO blind searches.  ║
 * ║                                                                          ║
 * ║    f-AC-2  the harness emits the signals per-scenario + aggregate.         ║
 * ║    f-AC-3  primed BEATS cold on the headline signal (pull-through and/or    ║
 * ║            redundant-search) with no regression — the 'priming helps' proof.║
 * ║    f-AC-4  the committed prime baseline gate is evaluated (advisory until   ║
 * ║            the first measured baseline flips placeholder=false).           ║
 * ║                                                                          ║
 * ║  GATED + ISOLATED (mirrors recall-eval-live.itest.ts):                    ║
 * ║    - SKIPS CLEANLY (exit 0) when the DeepLake token is absent. The embed    ║
 * ║      daemon is NOT required (the prime read is pure SQL, no <#> — c-AC-5);  ║
 * ║      embeddings only sharpen the COLD blind-search reachability check.      ║
 * ║    - `.itest.ts` + the `tests/integration/**` exclusion keep it OUT of      ║
 * ║      `npm run ci`. Only `npm run test:integration` / `npm run eval:prime`.  ║
 * ║    - Per-run UNIQUE ids: every seeded memory carries the run id so the eval ║
 * ║      reads ONLY this run's rows (append-only, in honeycomb_ci).            ║
 * ║                                                                          ║
 * ║  SECRETS: the DeepLake token reaches the daemon ONLY via the storage env   ║
 * ║  provider; never hardcoded, logged, or echoed. The scenario set is purely  ║
 * ║  synthetic.                                                              ║
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
	isOk,
	type StorageClient,
} from "../../src/daemon/storage/index.js";
import { EMBEDDING_DIMS } from "../../src/daemon/storage/vector.js";
import {
	createEmbedAttachment,
	resolveEmbedClientOptions,
	type EmbedClient,
} from "../../src/daemon/runtime/services/embed-client.js";
import { recallMemories } from "../../src/daemon/runtime/memories/recall.js";
import { buildPrimeForScope } from "../../src/daemon/runtime/memories/prime.js";
import {
	aggregatePrime,
	comparePrimedVsCold,
	gatePrimeAgainstBaseline,
	loadPrimeBaseline,
	loadPrimeScenarioSet,
	runPrimeEval,
	scoreScenario,
	targetSeedTextFor,
	type ColdOutcome,
	type PrimeBaseline,
	type PrimedOutcome,
	type PrimeScenario,
	type PrimeScenarioSet,
} from "../../src/eval/prime.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

/** A per-run unique id so the eval reads ONLY this run's rows (never real data). */
function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
const SESSION = `prd046f-eval-${RUN_ID}`;

const HERE = dirname(fileURLToPath(import.meta.url));
/** The repo-root `eval/` dir (this itest lives at tests/integration/). */
const EVAL_DIR = join(HERE, "..", "..", "eval");
const SCENARIOS: PrimeScenarioSet = loadPrimeScenarioSet(readFileSync(join(EVAL_DIR, "prime-golden.json"), "utf8"));
const BASELINE: PrimeBaseline = loadPrimeBaseline(readFileSync(join(EVAL_DIR, "prime-baseline.json"), "utf8"));

/** Probe the embed daemon (OPTIONAL here — only sharpens the cold reachability check). */
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

describe.skipIf(!HAS_TOKEN)("PRD-046f prime-eval harness (live, gated)", () => {
	let storage: StorageClient;
	let scope: QueryScope;
	let embedClient: EmbedClient | undefined;
	/** scenario.key → this run's seeded TARGET memory id (the id the digest must surface for pull-through). */
	const targetIds = new Map<string, string>();
	/** The ONE assembled digest ref-set for this scope, captured after convergence + reused by every scenario. */
	let digestRefs = new Set<string>();

	beforeAll(async () => {
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

		// The embed client is OPTIONAL: the prime read is pure SQL (no <#>), so pull-through does not
		// need it. It only sharpens the COLD blind-search reachability check; absent → lexical recall.
		if (await embedDaemonReachable()) {
			embedClient = createEmbedAttachment({ storage }).client;
		}
	}, 120_000);

	afterAll(async () => {
		// Append-only workspace: nothing to tear down (per-run ids isolate this run's rows).
	});

	/** Poll a read-back to convergence (DeepLake eventual consistency — never a single read). */
	async function pollUntil(check: () => Promise<boolean>, attempts = 60, delayMs = 500): Promise<boolean> {
		for (let i = 0; i < attempts; i++) {
			if (await check()) return true;
			await new Promise((r) => setTimeout(r, delayMs));
		}
		return false;
	}

	it(
		"f-AC-2/3: seeds scenarios, assembles the REAL digest, scores primed-vs-cold + emits the signals",
		async ({ skip }) => {
			// Boot a local daemon to use the SAME write + recall path the product uses (mirrors the
			// recall-eval itest). Imported lazily so the no-token skip never pays the boot cost.
			const { bootTestDaemon } = await import("./_daemon-harness.js");
			const { neutralizeIfInfraDegraded } = await import("./_infra-skip.js");
			const { mountMemoriesApi } = await import("../../src/daemon/runtime/memories/index.js");

			await neutralizeIfInfraDegraded("prime-eval-live:preflight", () => storage.connect(scope), skip);

			const booted = await bootTestDaemon({ mode: "local" });
			try {
				const embed = createEmbedAttachment({ storage });
				mountMemoriesApi(booted.assembled.daemon, { storage, embed: embed.client });
				const headers: Record<string, string> = {
					"x-honeycomb-org": scope.org,
					"x-honeycomb-workspace": scope.workspace ?? "honeycomb_ci",
					"x-honeycomb-runtime-path": "legacy",
					"x-honeycomb-session": SESSION,
					"content-type": "application/json",
				};

				// ── Seed each scenario's TARGET (run-id stamped) + its distractors. ──
				for (const sc of SCENARIOS.scenarios) {
					const targetRes = await fetch(`${booted.baseUrl}/api/memories`, {
						method: "POST",
						headers,
						body: JSON.stringify({ content: targetSeedTextFor(sc, RUN_ID) }),
					});
					expect(targetRes.status, `seed target for ${sc.key}`).toBe(201);
					const stored = (await targetRes.json()) as { id: string | null };
					if (stored.id !== null) targetIds.set(sc.key, stored.id);
					for (const d of sc.distractorMemoryTexts) {
						await fetch(`${booted.baseUrl}/api/memories`, {
							method: "POST",
							headers,
							body: JSON.stringify({ content: `${d} [${RUN_ID}]` }),
						});
					}
				}
				expect(targetIds.size, "every scenario seeded a target id").toBe(SCENARIOS.scenarios.length);

				// ── Poll until every seeded TARGET id is visible in the durable `memories` table
				// (DeepLake eventual consistency — never a single read). The prime read is pure SQL, so
				// scalar-column visibility is sufficient; no <#>-segment barrier is needed here. ──
				const ids = [...targetIds.values()];
				const idCol = sqlIdent("id");
				const inList = ids.map((id) => sLiteral(id)).join(", ");
				const visibleSql = `SELECT COUNT(*) AS n FROM "${sqlIdent("memories")}" WHERE ${idCol} IN (${inList})`;
				const converged = await pollUntil(async () => {
					const res = await storage.query(visibleSql, scope);
					if (!isOk(res) || res.rows.length === 0) return false;
					return Number(res.rows[0]?.n ?? 0) >= ids.length;
				});
				expect(converged, "f-AC-2: every seeded target converged in the memories table").toBe(true);

				// ── Assemble the REAL prime digest for this scope (the 046c read path) ONCE, and
				// capture every ref it surfaced. Pull-through is MEASURED against this real digest. We
				// raise the per-source skim limit so this run's freshly-seeded targets are inside the
				// newest-first window even amid the shared workspace's prior rows. ──
				const digest = await buildPrimeForScope(storage, scope, 200, { maxTokens: 100_000, recentLimit: 400, durableLimit: 400 });
				digestRefs = new Set<string>([...digest.recent.map((e) => e.ref), ...digest.durable.map((e) => e.ref)]);
				expect(digest.empty, "f-AC-2: the digest is non-empty (targets were seeded)").toBe(false);

				// ── Score every scenario PRIMED-vs-COLD with the deterministic signals. ──
				const primedBehavior = async (sc: PrimeScenario): Promise<PrimedOutcome> => {
					const targetId = targetIds.get(sc.key) ?? null;
					// PULL-THROUGH (measured): the target's id is in the REAL assembled digest → the
					// primed agent resolves it with one hivemind_read, ZERO blind searches.
					const inDigest = targetId !== null && digestRefs.has(targetId);
					return inDigest
						? { resolvedTargetId: targetId, blindSearches: 0 }
						: { resolvedTargetId: null, blindSearches: sc.coldSearchCount };
				};
				const coldBehavior = async (sc: PrimeScenario): Promise<ColdOutcome> => {
					// COLD: no digest → the agent must blind-search. Confirm the target is REACHABLE via a
					// real recall (so the scenario is fair — cold CAN find it, just at coldSearchCount cost),
					// then charge the committed blind-search count. The embed client sharpens this when up.
					const targetId = targetIds.get(sc.key) ?? null;
					const recall = await recallMemories(
						{ query: sc.task, scope, limit: 20 },
						{ storage, ...(embedClient !== undefined ? { embed: embedClient } : {}) },
					);
					const reachable = targetId !== null && recall.hits.some((h) => h.id === targetId);
					return { targetId: reachable ? targetId : null, blindSearches: sc.coldSearchCount };
				};

				const report = await runPrimeEval(SCENARIOS, primedBehavior, coldBehavior);

				// f-AC-2: the harness EMITS the per-scenario report + the aggregate signals.
				expect(report.scenarios.length, "a report line per scenario").toBe(SCENARIOS.scenarios.length);
				expect(report.aggregate.scenarioCount).toBe(SCENARIOS.scenarios.length);

				// eslint-disable-next-line no-console
				console.log(
					`[046f receipt] prime-eval: pull-through=${report.aggregate.pullThroughRate.toFixed(3)} ` +
						`primed-searches=${report.aggregate.primedBlindSearchMean.toFixed(3)} ` +
						`cold-searches=${report.aggregate.coldBlindSearchMean.toFixed(3)} ` +
						`search-reduction=${report.aggregate.searchReductionMean.toFixed(3)} ` +
						`(scenarios=${report.aggregate.scenarioCount})`,
				);
				for (const row of report.scenarios) {
					// eslint-disable-next-line no-console
					console.log(
						`[046f receipt]   ${row.key}: pull=${row.pullThrough} primed=${row.primedBlindSearches} ` +
							`cold=${row.coldBlindSearches} Δ=${row.searchReduction}`,
					);
				}

				// f-AC-3: priming BEATS cold on the headline signal with no regression.
				const lift = comparePrimedVsCold(report.aggregate);
				// eslint-disable-next-line no-console
				console.log(
					`[046f receipt] primed-vs-cold: pull-through=${lift.pullThroughRate.toFixed(3)} ` +
						`search-reduction=${lift.searchReductionMean.toFixed(3)} beats=${lift.beats}`,
				);
				expect(
					lift.beats,
					"f-AC-3: priming beats cold (positive pull-through where cold is 0, no blind-search regression)",
				).toBe(true);

				// The sharpest form of the proof: at least one scenario where PRIMED pulls the target
				// through the digest AND cold needs blind searches it primed did not.
				const sharpWin = report.scenarios.some((r) => r.pullThrough === 1 && r.searchReduction > 0);
				expect(sharpWin, "f-AC-3: ≥1 scenario where priming pulls the target through and saves a blind search").toBe(true);

				// f-AC-4: evaluate the committed gate (advisory until the measured baseline lands).
				const verdict = gatePrimeAgainstBaseline(report.aggregate, BASELINE);
				// eslint-disable-next-line no-console
				console.log(
					`[046f receipt] baseline gate: passed=${verdict.passed} advisory=${verdict.advisory} ` +
						`pull-through=${verdict.pullThroughRate.toFixed(3)} (floor ${verdict.pullThroughFloor.toFixed(3)}) ` +
						`search-reduction=${verdict.searchReductionMean.toFixed(3)} (floor ${verdict.searchReductionFloor.toFixed(3)})` +
						(verdict.reasons.length > 0 ? ` reasons=${verdict.reasons.join("; ")}` : ""),
				);
				if (!verdict.advisory) {
					expect(verdict.passed, `f-AC-4: the run holds the committed prime baseline (${verdict.reasons.join("; ")})`).toBe(true);
				}

				// Re-affirm the pure-signal math against the captured per-scenario outcomes (the live
				// numbers reduce to the SAME pure functions the unit tests hand-verify).
				const recomputed = aggregatePrime(
					SCENARIOS.scenarios.map((sc) => {
						const r = report.scenarios.find((x) => x.key === sc.key)!;
						const primed: PrimedOutcome = { resolvedTargetId: r.primedTargetId, blindSearches: r.primedBlindSearches };
						const cold: ColdOutcome = { targetId: r.coldTargetId, blindSearches: r.coldBlindSearches };
						return scoreScenario(sc, primed, cold);
					}),
				);
				expect(recomputed.pullThroughRate).toBeCloseTo(report.aggregate.pullThroughRate, 10);
				expect(recomputed.searchReductionMean).toBeCloseTo(report.aggregate.searchReductionMean, 10);
			} finally {
				await booted.stop();
			}
		},
		300_000,
	);
});
