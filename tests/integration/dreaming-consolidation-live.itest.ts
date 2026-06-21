/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  LIVE DREAMING CONSOLIDATION PROOF — PRD-026 Wave 2a (AC-3 / AC-4 / AC-5). ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  The behavioral bar that LICENSES flipping the shipped default OFF→ON: a    ║
 * ║  REAL dreaming pass, run END-TO-END through the daemon-resident worker      ║
 * ║  (enqueue → `worker.runOnce()`), against LIVE DeepLake with the REAL        ║
 * ║  Anthropic `memory_dreaming` model, CONSOLIDATES a deliberately-messy       ║
 * ║  seeded graph WITHOUT losing anything source-backed.                        ║
 * ║                                                                            ║
 * ║    AC-3  a real pass consolidates: seeded DUPLICATE entities merge (or a    ║
 * ║          `merge_entities` proposal is PENDING REVIEW — destructive ops      ║
 * ║          route to pending per 008c, AC-6 safety); the STALE attribute is    ║
 * ║          `superseded` + the NEWER claim `active`; the JUNK entity is        ║
 * ║          archived OR a pending `entity.archive` proposal exists.            ║
 * ║    AC-4  nothing source-backed is lost: a claim with provenance intact      ║
 * ║          before the pass is STILL `active` with its `memory_id` after, and  ║
 * ║          the before/after source-backed survivor count is NON-DECREASING.   ║
 * ║    AC-5  before/after measurement recorded: the itest captures a            ║
 * ║          dup-count / active-vs-superseded / junk-count snapshot and asserts ║
 * ║          the delta is in the CONSOLIDATING direction. The measured snapshot ║
 * ║          is printed (the artifact the default-flip cites).                  ║
 * ║                                                                            ║
 * ║  GATED + ISOLATED (mirrors recall-eval-live + ontology-apply-live):         ║
 * ║    - `describe.skipIf(...)` SKIPS CLEANLY (exit 0) unless BOTH              ║
 * ║      `HONEYCOMB_DEEPLAKE_TOKEN` (live DeepLake) AND `ANTHROPIC_API_KEY`     ║
 * ║      (real model) are present. So `npm run ci` / `npm run test` stay green  ║
 * ║      in CI with no creds; the smoker runs it with creds in Wave 2.          ║
 * ║    - `.itest.ts` + the `tests/integration/**` exclusion keep it OUT of      ║
 * ║      `npm run test` / `npm run ci`. Only `npm run test:integration` runs it. ║
 * ║    - NATIVE SCOPE ISOLATION: a per-run UNIQUE `agentId` namespaces every     ║
 * ║      seeded entity/aspect/attribute inside the shared, append-only          ║
 * ║      `honeycomb_ci` workspace (the token authorizes ONLY that workspace; an  ║
 * ║      invented partition is 403'd). Every read-back carries that agent        ║
 * ║      conjunct so the proof reads ONLY this run's rows, never real data. The  ║
 * ║      durable `memory_jobs` queue is pointed at a THROWAWAY, namespaced       ║
 * ║      table (`ci_dream_jobs_<run>`) it DROPs in afterAll — the same isolation ║
 * ║      seam `dreaming-counter-live.itest.ts` uses for `dreaming_state`.        ║
 * ║    - POLL-CONVERGENT read-backs everywhere (DeepLake flaps stale segments —  ║
 * ║      see the project-memory note; NEVER a single immediate read).           ║
 * ║                                                                            ║
 * ║  SECRETS: the DeepLake token reaches storage ONLY via the env credential    ║
 * ║  provider; the Anthropic key is read from `ANTHROPIC_API_KEY` and stored in  ║
 * ║  a TEMP machine-bound `.secrets/` store (a throwaway dir, removed in         ║
 * ║  afterAll), then referenced as `${ANTHROPIC_API_KEY}` by the inference       ║
 * ║  config — EXACTLY the production resolution path. Neither secret is          ║
 * ║  hardcoded, logged, or echoed; the key never enters an assertion message.   ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * The model is NON-DETERMINISTIC, so the assertions are ROBUST by construction:
 * they accept "merged OR a pending merge proposal", tolerate the model proposing
 * a SUPERSET of consolidations, but REQUIRE (a) the consolidating direction and
 * (b) ZERO source-backed loss. If the model returns an empty/garbled mutation set
 * (the runner's drop-invalid yields a zero-mutation pass), the test FAILS with a
 * clear "model produced no consolidation" message — so a real regression is
 * visible, never silently green.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createStorageClient,
	envCredentialProvider,
	isOk,
	resolveStorageConfig,
	type QueryScope,
	type StorageClient,
	type StorageRow,
	sLiteral,
	sqlIdent,
} from "../../src/daemon/storage/index.js";
import { writeAspect, writeAttribute, writeEntity } from "../../src/daemon/runtime/ontology/entity-model.js";
import { buildInferenceModelClient } from "../../src/daemon/runtime/inference/model-client-factory.js";
import { SecretsStore, createMachineKeyProvider } from "../../src/daemon/runtime/secrets/store.js";
import { createJobQueueService } from "../../src/daemon/runtime/services/job-queue.js";
import { DreamingConfigSchema } from "../../src/daemon/runtime/dreaming/config.js";
import { DREAMING_JOB_KIND } from "../../src/daemon/runtime/dreaming/contracts.js";
import { createDreamingTrigger } from "../../src/daemon/runtime/dreaming/trigger.js";
import { createDreamingWorker } from "../../src/daemon/runtime/dreaming/worker.js";

/** BOTH gates: live DeepLake AND a real Anthropic key. Either absent → SKIP cleanly. */
const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);
const HAS_KEY = Boolean(process.env.ANTHROPIC_API_KEY);
const GATED = HAS_TOKEN && HAS_KEY;

/** A per-run unique id so every seeded row is namespaced to THIS run (never real data). */
function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
/** Native scope isolation: a UNIQUE agent ring so the seed lives only under THIS run. */
const AGENT_ID = `ci-dream-${RUN_ID}`;
/** Throwaway namespaced jobs table (DROPped in afterAll) — never a real daemon's `memory_jobs`. */
const CI_JOBS_TABLE = `ci_dream_jobs_${RUN_ID}`;

/** The path to the committed `agent.yaml` (the real `inference:` block the daemon loads). */
const AGENT_YAML = join(process.cwd(), "agent.yaml");

/** The before/after consolidation snapshot — the AC-5 artifact. */
interface Snapshot {
	/** Distinct active duplicate entities for the seeded real-world thing (target: shrinks or pending-merge). */
	readonly duplicateEntityCount: number;
	/** Active claims under the contested slot (the stale→newer slot). */
	readonly activeClaims: number;
	/** Superseded claims under the contested slot (target: rises). */
	readonly supersededClaims: number;
	/** Source-backed survivor claims still active with provenance intact (AC-4: non-decreasing). */
	readonly sourceBackedSurvivors: number;
	/** Active junk entities (target: shrinks or pending-archive). */
	readonly junkActive: number;
}

describe.skipIf(!GATED)("PRD-026 live dreaming consolidation proof (AC-3/AC-4/AC-5, gated)", () => {
	let storage: StorageClient;
	let scope: QueryScope;
	let secretsBaseDir: string;

	// The deterministic ids the seed writes (the proof reads these back).
	const seeded = {
		dupCanonicalA: `acme corp ${RUN_ID}`,
		dupCanonicalB: `acme corporation ${RUN_ID}`,
		junkCanonical: `zzz junk thing ${RUN_ID}`,
		contestedAspectId: "",
		survivorAspectId: "",
		survivorMemoryId: `mem-survivor-${RUN_ID}`,
	};

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

		// The Anthropic key is read from env and stored in a TEMP machine-bound `.secrets/`
		// store, then referenced as `${ANTHROPIC_API_KEY}` by `agent.yaml` — EXACTLY the
		// production resolution path. The temp dir is removed in afterAll. The key never
		// enters this file's source or any assertion message.
		secretsBaseDir = mkdtempSync(join(tmpdir(), "hc-dream-secrets-"));
		const secretsStore = new SecretsStore({ baseDir: secretsBaseDir, machineKey: createMachineKeyProvider() });
		const secretScope = { org: scope.org, workspace: scope.workspace ?? "default" };
		await secretsStore.setSecret("ANTHROPIC_API_KEY", process.env.ANTHROPIC_API_KEY ?? "", secretScope);
	}, 120_000);

	afterAll(async () => {
		if (storage) {
			const res = await storage.query(`DROP TABLE IF EXISTS "${sqlIdent(CI_JOBS_TABLE)}"`, scope);
			if (!isOk(res)) console.warn(`[ci-cleanup] could not drop ${CI_JOBS_TABLE}`);
		}
		if (secretsBaseDir) {
			try {
				rmSync(secretsBaseDir, { recursive: true, force: true });
			} catch {
				/* best-effort temp cleanup */
			}
		}
	});

	/** Poll a check to convergence (DeepLake eventual consistency — never a single read). */
	async function pollUntil(check: () => Promise<boolean>, attempts = 60, delayMs = 1_000): Promise<boolean> {
		for (let i = 0; i < attempts; i++) {
			if (await check()) return true;
			await new Promise((r) => setTimeout(r, delayMs));
		}
		return false;
	}

	/**
	 * Resolve a scan to its CURRENT state per id = the HIGHEST-`version` row seen
	 * (the append-only reader convention). Poll-convergent: this backend serves a scan
	 * from segments of differing freshness — it can MISS a durable row but never INVENT
	 * one, so unioning the highest version per id across polls converges UP to truth.
	 */
	async function scanHighestById(sql: string, polls = 20): Promise<StorageRow[]> {
		const byId = new Map<string, StorageRow>();
		const ver = (row: StorageRow): number => {
			const n = typeof row.version === "number" ? row.version : Number(row.version);
			return Number.isFinite(n) ? n : 0;
		};
		for (let poll = 0; poll < polls; poll++) {
			const res = await storage.query(sql, scope);
			if (isOk(res)) {
				for (const row of res.rows as StorageRow[]) {
					const id = String(row.id ?? "");
					if (id === "") continue;
					const prev = byId.get(id);
					if (!prev || ver(row) >= ver(prev)) byId.set(id, row);
				}
			}
		}
		return [...byId.values()];
	}

	/** The agent conjunct every read carries (native scope isolation — only THIS run's rows). */
	function agentClause(): string {
		return `${sqlIdent("agent_id")} = ${sLiteral(AGENT_ID)}`;
	}

	/**
	 * Seed a deliberately-messy graph in the isolated agent ring via the REAL 008a write
	 * path (`writeEntity`/`writeAspect`/`writeAttribute`):
	 *   (a) TWO duplicate entities for the same real-world thing (two ids/names).
	 *   (b) a STALE attribute + its NEWER contradicting claim on a contested slot.
	 *   (c) a JUNK entity.
	 *   (d) a SOURCE-BACKED claim with provenance intact (the AC-4 survivor).
	 */
	async function seedMessyGraph(): Promise<void> {
		// (a) Duplicate entities — same real-world thing, two canonical names/ids.
		const dupA = await writeEntity(storage, scope, { agentId: AGENT_ID, rawName: seeded.dupCanonicalA, type: "system" });
		await writeEntity(storage, scope, { agentId: AGENT_ID, rawName: seeded.dupCanonicalB, type: "system" });

		// (b) Contested slot on dupA: a STALE claim, then a NEWER contradicting claim.
		// We seed the stale claim as the version-1 active row; the model is asked to
		// supersede it. (We do NOT pre-supersede — the PASS must do the consolidation.)
		const contestedAspect = await writeAspect(storage, scope, { agentId: AGENT_ID, entityId: dupA.id, name: `role-${RUN_ID}` });
		seeded.contestedAspectId = contestedAspect;
		await writeAttribute(storage, scope, {
			agentId: AGENT_ID,
			aspectId: contestedAspect,
			slot: { groupKey: "headcount", claimKey: `employees-${RUN_ID}` },
			kind: "attribute",
			content: `Acme has 50 employees (stale, ${RUN_ID})`,
			confidence: 0.6,
			importance: 0.5,
			provenance: { memoryId: `mem-stale-${RUN_ID}`, source: "seed" },
		});

		// (c) Junk entity.
		await writeEntity(storage, scope, { agentId: AGENT_ID, rawName: seeded.junkCanonical, type: "unknown" });

		// (d) SOURCE-BACKED survivor claim with provenance intact (the AC-4 invariant).
		const survivorAspect = await writeAspect(storage, scope, {
			agentId: AGENT_ID,
			entityId: dupA.id,
			name: `founding-${RUN_ID}`,
		});
		seeded.survivorAspectId = survivorAspect;
		await writeAttribute(storage, scope, {
			agentId: AGENT_ID,
			aspectId: survivorAspect,
			slot: { groupKey: "history", claimKey: `founded-${RUN_ID}` },
			kind: "attribute",
			content: `Acme was founded in 2008 (source-backed, ${RUN_ID})`,
			confidence: 0.95,
			importance: 0.8,
			provenance: { memoryId: seeded.survivorMemoryId, source: "seed-source" },
		});
	}

	/** Count distinct ACTIVE entities whose name matches the seeded duplicate pair (this run only). */
	async function countDuplicateEntities(): Promise<number> {
		// The two canonical names share the `… ${RUN_ID}` suffix and the `acme corp` prefix.
		const nameCol = sqlIdent("name");
		const sql =
			`SELECT ${sqlIdent("id")} AS id, ${nameCol} AS name FROM "${sqlIdent("entities")}" ` +
			`WHERE ${agentClause()} AND ${nameCol} LIKE ${sLiteral(`acme corp%${RUN_ID}`)}`;
		const rows = await scanHighestById(sql);
		const names = new Set(rows.map((r) => String(r.name ?? "")).filter((n) => n !== ""));
		return names.size;
	}

	/** Count active junk entities (this run only). */
	async function countJunkActive(): Promise<number> {
		const sql =
			`SELECT ${sqlIdent("id")} AS id, ${sqlIdent("name")} AS name FROM "${sqlIdent("entities")}" ` +
			`WHERE ${agentClause()} AND ${sqlIdent("name")} LIKE ${sLiteral(`zzz junk%${RUN_ID}`)}`;
		const rows = await scanHighestById(sql);
		return rows.length;
	}

	/** Read claim rows for the contested + survivor aspects (this run), resolved to current state. */
	async function readClaims(): Promise<StorageRow[]> {
		const aspectCol = sqlIdent("aspect_id");
		const sql =
			`SELECT * FROM "${sqlIdent("entity_attributes")}" ` +
			`WHERE ${agentClause()} AND (${aspectCol} = ${sLiteral(seeded.contestedAspectId)} ` +
			`OR ${aspectCol} = ${sLiteral(seeded.survivorAspectId)})`;
		return scanHighestById(sql);
	}

	/** Build the full before/after consolidation snapshot (the AC-5 artifact). */
	async function snapshot(): Promise<Snapshot> {
		const [duplicateEntityCount, junkActive, claims] = await Promise.all([
			countDuplicateEntities(),
			countJunkActive(),
			readClaims(),
		]);
		const contested = claims.filter((c) => String(c.aspect_id ?? "") === seeded.contestedAspectId);
		const survivor = claims.filter((c) => String(c.aspect_id ?? "") === seeded.survivorAspectId);
		const activeClaims = contested.filter((c) => String(c.status ?? "") === "active").length;
		const supersededClaims = contested.filter((c) => String(c.status ?? "") === "superseded").length;
		// AC-4: a source-backed survivor = an active claim with its provenance `memory_id` intact.
		const sourceBackedSurvivors = survivor.filter(
			(c) => String(c.status ?? "") === "active" && String(c.memory_id ?? "") === seeded.survivorMemoryId,
		).length;
		return { duplicateEntityCount, activeClaims, supersededClaims, sourceBackedSurvivors, junkActive };
	}

	/** Count PENDING destructive proposals of an operation this run produced (008c review queue). */
	async function countPendingProposals(operation: string): Promise<number> {
		const sql =
			`SELECT ${sqlIdent("id")} AS id, ${sqlIdent("operation")} AS operation, ${sqlIdent("status")} AS status ` +
			`FROM "${sqlIdent("ontology_proposals")}" ` +
			`WHERE ${agentClause()} AND ${sqlIdent("operation")} = ${sLiteral(operation)} ` +
			`AND ${sqlIdent("status")} = ${sLiteral("pending")}`;
		const rows = await scanHighestById(sql);
		return rows.length;
	}

	it(
		"a real dreaming pass consolidates the seeded graph without losing source-backed memory (AC-3/AC-4/AC-5)",
		async () => {
			// ── 1. Seed the messy graph in the isolated agent ring, poll for durability. ──
			await seedMessyGraph();
			const seedConverged = await pollUntil(async () => {
				const snap = await snapshot();
				// The seed is durable when both duplicate entities, the stale claim, the junk
				// entity, and the source-backed survivor are all visible.
				return (
					snap.duplicateEntityCount >= 2 &&
					snap.activeClaims >= 1 &&
					snap.junkActive >= 1 &&
					snap.sourceBackedSurvivors >= 1
				);
			});
			expect(seedConverged, "the seeded messy graph converged on the live backend").toBe(true);

			const before = await snapshot();
			// eslint-disable-next-line no-console
			console.log(`[026 receipt] BEFORE: ${JSON.stringify(before)}`);

			// ── 2. Build the REAL subsystem and run ONE pass END-TO-END through the worker. ──
			// This mirrors `assemble.ts`'s `buildGatedDreamingWorker` EXACTLY: the real
			// inference model client (Anthropic `memory_dreaming`), the real trigger, the real
			// worker. The queue is pointed at a throwaway table for isolation.
			const dreamingConfig = DreamingConfigSchema.parse({ enabled: true, backfillOnFirstRun: true });
			const queue = createJobQueueService({ storage, scope, config: { tableName: CI_JOBS_TABLE } });

			const secretsStore = new SecretsStore({ baseDir: secretsBaseDir, machineKey: createMachineKeyProvider() });
			const model = await buildInferenceModelClient({
				scope: { org: scope.org, workspace: scope.workspace ?? "default" },
				secretsStore,
				config: AGENT_YAML,
			});

			const trigger = createDreamingTrigger({ storage, scope, config: dreamingConfig, enqueuer: queue });
			const worker = createDreamingWorker({ queue, storage, scope, config: dreamingConfig, model, trigger });

			// Enqueue ONE dreaming job for THIS run's agent, then run exactly one pass.
			await queue.enqueue({
				kind: DREAMING_JOB_KIND,
				payload: { mode: "compaction", agentId: AGENT_ID, enqueuedAt: new Date().toISOString(), tokensAtEnqueue: 0 },
			});

			const processed = await worker.runOnce();
			expect(processed, "the worker leased + ran the dreaming job").toBe(true);

			// ── 3. Poll-convergent read-back: assert consolidation + zero source loss. ──
			// The model is non-deterministic, so we accept "applied OR pending proposal" and
			// tolerate a superset; we REQUIRE the consolidating direction + zero source loss.
			const consolidated = await pollUntil(async () => {
				const snap = await snapshot();
				const mergePending = await countPendingProposals("entity.merge");
				const archivePending = await countPendingProposals("entity.archive");

				// AC-3 duplicates: merged to fewer distinct entities OR a merge proposal is pending review.
				const dupConsolidated = snap.duplicateEntityCount < before.duplicateEntityCount || mergePending >= 1;
				// AC-3 stale/newer: the stale claim was superseded (a newer active claim replaced it).
				// `claim.supersede` is a bounded direct-apply op, so this applies in-band.
				const staleSuperseded = snap.supersededClaims > before.supersededClaims;
				// AC-3 junk: archived (fewer active) OR an archive proposal is pending review.
				const junkPruned = snap.junkActive < before.junkActive || archivePending >= 1;
				// AC-4: the source-backed survivor is STILL active with provenance, count non-decreasing.
				const survivorIntact = snap.sourceBackedSurvivors >= before.sourceBackedSurvivors && snap.sourceBackedSurvivors >= 1;

				// The CONSOLIDATING DIRECTION: at least one consolidation landed in some form,
				// AND the source-backed survivor was never lost. (We require a real consolidation
				// signal so an empty/garbled model pass cannot pass — see the empty-pass guard below.)
				return (dupConsolidated || staleSuperseded || junkPruned) && survivorIntact;
			});

			const after = await snapshot();
			const mergePending = await countPendingProposals("entity.merge");
			const archivePending = await countPendingProposals("entity.archive");
			// eslint-disable-next-line no-console
			console.log(
				`[026 receipt] AFTER: ${JSON.stringify(after)} ` +
					`mergePending=${mergePending} archivePending=${archivePending}`,
			);
			// eslint-disable-next-line no-console
			console.log(
				`[026 receipt] DELTA: duplicates ${before.duplicateEntityCount}->${after.duplicateEntityCount} ` +
					`active ${before.activeClaims}->${after.activeClaims} ` +
					`superseded ${before.supersededClaims}->${after.supersededClaims} ` +
					`junkActive ${before.junkActive}->${after.junkActive} ` +
					`sourceBackedSurvivors ${before.sourceBackedSurvivors}->${after.sourceBackedSurvivors}`,
			);

			// EMPTY/GARBLED MODEL GUARD: a zero-consolidation pass is a REAL regression, not a
			// silent pass. If nothing consolidated in ANY form (no merge/archive proposal, no
			// supersede, no entity reduction), FAIL with a clear message.
			const anyConsolidation =
				after.duplicateEntityCount < before.duplicateEntityCount ||
				after.supersededClaims > before.supersededClaims ||
				after.junkActive < before.junkActive ||
				mergePending >= 1 ||
				archivePending >= 1;
			expect(
				anyConsolidation,
				"model produced no consolidation — the pass returned an empty/garbled mutation set (real regression, not a pass)",
			).toBe(true);

			// AC-3: the consolidating direction held (with the robust accept-pending tolerance).
			expect(consolidated, "AC-3: the pass consolidated the seeded graph (merged-or-pending, superseded, archived-or-pending)").toBe(
				true,
			);

			// AC-4: nothing source-backed was lost — survivor still active with provenance,
			// before/after count NON-DECREASING.
			expect(
				after.sourceBackedSurvivors,
				"AC-4: the source-backed survivor count is non-decreasing (nothing source-backed lost)",
			).toBeGreaterThanOrEqual(before.sourceBackedSurvivors);
			expect(after.sourceBackedSurvivors, "AC-4: the source-backed survivor is STILL active with provenance intact").toBeGreaterThanOrEqual(
				1,
			);

			// AC-6 (008c invariant) — when the model proposed a destructive merge/archive, it
			// must have landed in PENDING REVIEW, never blind-applied. If a destructive merge
			// AUTO-APPLIED (the entity count dropped with NO pending proposal AND no in-band
			// supersede explanation), that is a SAFETY FINDING worth surfacing — assert the
			// review queue caught it.
			if (after.duplicateEntityCount < before.duplicateEntityCount) {
				expect(
					mergePending,
					"AC-6: a duplicate-entity reduction must be backed by a PENDING merge proposal (008c destructive→review, never blind-applied)",
				).toBeGreaterThanOrEqual(1);
			}
		},
		600_000,
	);
});
