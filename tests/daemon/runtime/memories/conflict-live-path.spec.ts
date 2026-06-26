/**
 * PRD-058b — the LIVE-PATH conflict test (C-1, the "completed != live" proof).
 *
 * ════════════════════════════════════════════════════════════════════════════
 * This is the test the QA found MISSING: every prior 058b suite either exercised
 * `detectAndProject` in isolation (its own unit test) OR drove the recall κ gate with
 * an INJECTED suppression set. None proved that storing a fact + its contradiction
 * THROUGH THE CONTROLLED-WRITE PATH the daemon assembles actually (a) lands a
 * `memory_conflicts` row and (b) makes recall suppress the loser. That round-trip is
 * what IDX-2 / 58b.1.1 require ON THE WIRED PATH — and what this test pins.
 * ════════════════════════════════════════════════════════════════════════════
 *
 * The flow under test (the REAL composition, not a mock of it):
 *   1. store fact A ("we deploy on fridays") via `applyControlledWrite` with the REAL
 *      `createControlledWriteConflictHook` wired as `onConflict` (exactly how
 *      `assemble.ts` wires it). A has no candidates → no conflict.
 *   2. store the CONTRADICTION B ("we never deploy on fridays") through the SAME path,
 *      with A forwarded as B's decision-stage candidate. The post-commit hook runs the
 *      REAL detector + projects an OPEN conflict into `memory_conflicts`.
 *   3. assert a `memory_conflicts` row landed (poll to convergence over the stateful fake).
 *   4. run `recallMemories` with the REAL `createConflictSuppressionSource(storage)` over
 *      the SAME storage — assert recall returns at most the winner (the loser is dropped).
 *
 * A STATEFUL fake transport captures the `memory_conflicts` INSERT the hook emits and
 * replays it on the open-conflict projection read recall issues — so the suppression is
 * driven by what DETECTION ACTUALLY WROTE, not a hand-injected set. That is the live proof.
 */

import { describe, expect, it } from "vitest";

import {
	applyControlledWrite,
	type ControlledWriteCandidate,
	type ControlledWriteHandlerDeps,
	type ControlledWriteInput,
} from "../../../../src/daemon/runtime/pipeline/controlled-writes.js";
import { type PipelineConfig, PipelineConfigSchema } from "../../../../src/daemon/runtime/pipeline/config.js";
import { type Proposal } from "../../../../src/daemon/runtime/pipeline/contracts.js";
import { createControlledWriteConflictHook } from "../../../../src/daemon/runtime/memories/conflict-hook.js";
import { createConflictSuppressionSource } from "../../../../src/daemon/runtime/memories/conflict-resolve.js";
import { recallMemories } from "../../../../src/daemon/runtime/memories/recall.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { QueryScope } from "../../../../src/daemon/storage/client.js";
import type { EmbedClient } from "../../../../src/daemon/runtime/services/embed-client.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const SCOPE: QueryScope = { org: "o", workspace: "w" };

/** Extract the value bound to `col` from a single-row `memory_conflicts` INSERT (`'a'` literals). */
function readInsertedValue(sql: string, col: string): string | null {
	// The writer builds `INSERT INTO "memory_conflicts" (..., col, ...) VALUES (..., 'val', ...)`.
	const colsMatch = sql.match(/\(([^)]*)\)\s*VALUES\s*\(/i);
	const valsMatch = sql.match(/VALUES\s*\((.*)\)\s*$/is);
	if (colsMatch === null || valsMatch === null) return null;
	const cols = colsMatch[1]!.split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
	// Split the VALUES list on top-level commas (the conflict row carries only scalar literals).
	const vals = splitTopLevel(valsMatch[1]!);
	const idx = cols.indexOf(col);
	if (idx < 0 || idx >= vals.length) return null;
	const raw = vals[idx]!.trim();
	const lit = raw.match(/^'(.*)'$/s);
	return lit !== null ? lit[1]!.replace(/''/g, "'") : raw;
}

/** Split a SQL VALUES body on top-level commas (ignores commas inside single-quoted literals). */
function splitTopLevel(body: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let inStr = false;
	let cur = "";
	for (let i = 0; i < body.length; i++) {
		const ch = body[i]!;
		if (inStr) {
			cur += ch;
			if (ch === "'") {
				if (body[i + 1] === "'") { cur += "'"; i++; } else inStr = false;
			}
			continue;
		}
		if (ch === "'") { inStr = true; cur += ch; continue; }
		if (ch === "(") depth++;
		if (ch === ")") depth--;
		if (ch === "," && depth === 0) { out.push(cur); cur = ""; continue; }
		cur += ch;
	}
	if (cur.trim() !== "") out.push(cur);
	return out;
}

/**
 * A STATEFUL fake: it records every `memory_conflicts` projection INSERT and replays the LATEST one on
 * the open-conflict projection read + the by-id read-back, so detection's write drives recall's gate
 * (the live round-trip). The `memories` recall arm returns both A + B so the suppression is observable.
 */
function liveStorage(memoryRows: () => Record<string, unknown>[]) {
	const conflictProjections: Record<string, unknown>[] = [];
	const responder = (req: TransportRequest): Record<string, unknown>[] => {
		const sql = req.sql;
		// Capture a memory_conflicts projection INSERT (the hook's detectAndProject → projectConflict).
		if (/INSERT\s+INTO\s+"memory_conflicts"/i.test(sql)) {
			conflictProjections.push({
				id: readInsertedValue(sql, "id"),
				memory_a_id: readInsertedValue(sql, "memory_a_id"),
				memory_b_id: readInsertedValue(sql, "memory_b_id"),
				winner_id: readInsertedValue(sql, "winner_id"),
				kappa_loser: readInsertedValue(sql, "kappa_loser"),
				verdict: readInsertedValue(sql, "verdict"),
				status: readInsertedValue(sql, "status"),
				version: 1,
			});
			return [];
		}
		// The open-conflict projection read recall's κ gate issues → replay what detection wrote.
		if (/FROM\s+"memory_conflicts"/i.test(sql)) {
			return conflictProjections.map((p) => ({ ...p }));
		}
		// The controlled-write dedup probe (`content_hash = …`) + the version-read SELECT must find
		// NOTHING — otherwise the ADD dedups instead of inserting. Check these BEFORE the recall arm.
		if (/content_hash\s*=/.test(sql)) return [];
		if (/SELECT\s+version\b/i.test(sql) && /ORDER\s+BY\s+version/i.test(sql)) return [];
		// The recall lexical/vector arms over `memories` → both sides (so suppression is observable).
		// Recall's arm SELECTs `content`/`source`; the dedup/version probes were already handled above.
		if (/FROM\s+"memories"/i.test(sql)) return memoryRows();
		// Everything else (memory_history append, INSERT memories, candidate hydrate) → no rows.
		return [];
	};
	const fake = new FakeDeepLakeTransport(responder);
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord({ org: SCOPE.org, workspace: SCOPE.workspace })) });
	return { storage, fake, conflictProjections };
}

/** A 768-dim vector the fake embed returns (claim-slot sim = 1 for identical vectors → high Contra). */
function vec768(): number[] {
	return Array.from({ length: 768 }, () => 0.05);
}

/** A fake embed client returning a fixed 768-dim vector (so the detector's `sim` is high). */
function fakeEmbed(): EmbedClient {
	return { async embed(): Promise<readonly number[]> { return vec768(); } };
}

function config(): PipelineConfig {
	return PipelineConfigSchema.parse({});
}

function addProposal(): Proposal {
	return { action: "add", confidence: 0.95, reason: "" };
}

function input(content: string, candidates?: readonly ControlledWriteCandidate[]): ControlledWriteInput {
	return {
		proposal: addProposal(),
		content,
		normalizedContent: content.toLowerCase(),
		factConfidence: 0.95,
		...(candidates !== undefined ? { candidates } : {}),
	};
}

function deps(storage: ReturnType<typeof createStorageClient>, over: Partial<ControlledWriteHandlerDeps> = {}): ControlledWriteHandlerDeps {
	return { storage, config: config(), embed: fakeEmbed(), ...over };
}

describe("PRD-058b LIVE PATH (C-1) — conflict detection runs on the wired controlled-write path", () => {
	it("58b.1.1 / IDX-2: storing a fact + its contradiction via controlled-write projects a memory_conflicts row, and recall suppresses the loser", async () => {
		const memoryRows = () => [
			{ source: "memories", id: "mem_a", text: "we deploy on fridays", created_at: "2026-06-26T00:00:00Z" },
			{ source: "memories", id: "mem_b", text: "we never deploy on fridays", created_at: "2026-06-26T00:01:00Z" },
		];
		const { storage, fake, conflictProjections } = liveStorage(memoryRows);
		// The REAL hook — no model (provider `none` → lexical opp), the fake embed gives high sim.
		const hook = createControlledWriteConflictHook({ storage, embed: fakeEmbed() });

		// 1. Store fact A through the controlled-write path. No candidates → no conflict.
		const outA = await applyControlledWrite(input("we deploy on fridays"), SCOPE, deps(storage, { onConflict: hook, newId: () => "mem_a" }));
		expect(outA.action).toBe("inserted");
		expect(conflictProjections).toHaveLength(0); // A alone has nothing to conflict with.

		// 2. Store the CONTRADICTION B through the SAME path, with A forwarded as B's decision candidate.
		const outB = await applyControlledWrite(
			input("we never deploy on fridays", [{ id: "mem_a", content: "we deploy on fridays" }]),
			SCOPE,
			deps(storage, { onConflict: hook, newId: () => "mem_b" }),
		);
		expect(outB.action).toBe("inserted");

		// 3. A memory_conflicts row landed FROM DETECTION (the live wiring proof, not an injected set).
		expect(conflictProjections.length).toBeGreaterThanOrEqual(1);
		const projected = conflictProjections[conflictProjections.length - 1]!;
		expect(projected.status).toBe("open");
		// The normalized pair is {mem_a, mem_b}; a winner was assigned (the loser is suppressible).
		const pair = [projected.memory_a_id, projected.memory_b_id].sort();
		expect(pair).toEqual(["mem_a", "mem_b"]);
		expect([projected.memory_a_id, projected.memory_b_id]).toContain(projected.winner_id);

		// 4. Recall over the SAME storage with the REAL suppression source: at most the winner survives.
		const suppression = createConflictSuppressionSource(storage);
		const result = await recallMemories({ query: "deploy fridays", scope: SCOPE }, { storage, conflictSuppression: suppression });
		const ids = result.hits.filter((h) => h.source === "memories").map((h) => h.id);
		const winner = String(projected.winner_id);
		const loser = winner === "mem_a" ? "mem_b" : "mem_a";
		expect(ids).toContain(winner); // the winner survives.
		expect(ids).not.toContain(loser); // the κ = ρ loser is suppressed — IDX-2 holds on the WIRED path.

		// And a memory_conflicts INSERT did fire on the live path (sanity on the transport trace).
		expect(fake.requests.some((r) => /INSERT\s+INTO\s+"memory_conflicts"/i.test(r.sql))).toBe(true);
	});

	it("a fact with NO candidates runs no detection (the no-candidate short-circuit) — never a spurious conflict", async () => {
		const { storage, conflictProjections } = liveStorage(() => []);
		const hook = createControlledWriteConflictHook({ storage, embed: fakeEmbed() });
		const out = await applyControlledWrite(input("typescript is the language"), SCOPE, deps(storage, { onConflict: hook, newId: () => "mem_solo" }));
		expect(out.action).toBe("inserted");
		expect(conflictProjections).toHaveLength(0); // nothing to detect against → no projection.
	});

	it("fail-soft: a hook whose detector throws NEVER fails the committed write (the memory still lands)", async () => {
		const { storage } = liveStorage(() => []);
		// A hook that throws — the controlled-write handler must swallow it (the write is already committed).
		const throwingHook = {
			async detect(): Promise<{ readonly projectedIds: readonly string[] }> {
				throw new Error("detector exploded");
			},
		};
		const out = await applyControlledWrite(
			input("a fact", [{ id: "cand", content: "another fact" }]),
			SCOPE,
			deps(storage, { onConflict: throwingHook, newId: () => "mem_safe" }),
		);
		// The write COMMITTED despite the hook throwing — no memory was lost.
		expect(out.action).toBe("inserted");
		expect(out.memoryId).toBe("mem_safe");
	});
});
