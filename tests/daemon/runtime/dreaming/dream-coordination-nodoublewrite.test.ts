/**
 * PRD-045d d-AC-4 — COORDINATION: the dreaming-apply path and the 045a/045c pipeline
 * graph-persist path do NOT double-write the same graph edge. PLAIN CI, deterministic, no
 * token, no network, no model.
 *
 * ════════════════════════════════════════════════════════════════════════════
 * THE CONTRACT (045c → 045d coordination hand-off).
 * 045c made the ontology apply path idempotent via DETERMINISTIC IDs + a presence-probe
 * before every append: a `memory_entity_mentions` row is keyed `mention_<sha(memoryId,
 * entityId)>` (probed by `inlineLinkMemory` before append, `entity-model.ts:584`); a claim
 * attribute's version-1 row is keyed `attr_<sha(aspectId, slot, version)>` (probed by
 * `writeAttribute` before append, `entity-model.ts:300`); an entity is `update-or-insert`
 * by `ent_<sha(agentId, canonicalName)>`. 045c's guidance to 045d: the dreaming runner must
 * keep calling the SAME entry points (`submitProposal` → the entity-model writers /
 * `supersedeClaim`; `inlineLinkMemory`) — never raw inserts — so the pipeline-apply path and
 * the dreaming-apply path converge to ONE row instead of double-writing.
 *
 * This suite PROVES that property end-to-end at the storage layer. It builds a SINGLE shared
 * stateful in-memory store (the same store both paths read + write through), runs the SAME
 * logical edge through BOTH apply paths, and asserts EXACTLY ONE durable row:
 *
 *   - MENTION edge (memory → entity): the 045a/045c pipeline links the memory via
 *     `inlineLinkMemory`; the dreaming pass (which the runner drives by re-linking through
 *     the SAME `inlineLinkMemory` entry point) links it again. Deterministic `mention_…` id
 *     + presence-probe ⇒ ONE `memory_entity_mentions` row, not two.
 *   - CLAIM edge (a bounded `claim.add`): the pipeline writes the version-1 claim via
 *     `writeAttribute`; the dreaming pass submits the SAME bounded `claim.add` proposal,
 *     which the control plane (`submitProposal`, the runner's ONLY graph-write seam) applies
 *     through the SAME `writeAttribute`. Deterministic `attr_…` id + presence-probe ⇒ ONE
 *     `entity_attributes` row, not two.
 *
 * The order is run BOTH ways (pipeline-first, then dreaming-first) so the convergence is
 * symmetric — whichever path WRITES the claim first, the other is a no-op append. (For the
 * MENTION edge the inline linker links only to EXISTING entities, so the mention lands once
 * the 045a pipeline — the PRIMARY graph writer, D-045d-1 — has created the entity; the
 * dreaming pass re-linking the same memory is then a no-op. Either way: ONE row.)
 *
 * Deterministic by construction: the in-memory store answers every presence probe + read
 * from its own recorded rows, so the dedup actually fires (a stub that always returns `[]`
 * would HIDE the property). No `.skip`/`.only`; `vitest run` is CI.
 * ════════════════════════════════════════════════════════════════════════════
 */

import { describe, expect, it } from "vitest";

import {
	createStorageClient,
	type QueryScope,
	type StorageQuery,
} from "../../../../src/daemon/storage/index.js";
import type { StorageRow } from "../../../../src/daemon/storage/result.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import {
	aspectId as deriveAspectId,
	entityId as deriveEntityId,
	inlineLinkMemory,
	mentionId as deriveMentionId,
	writeAspect,
	writeAttribute,
	writeEntity,
} from "../../../../src/daemon/runtime/ontology/entity-model.js";
import { attributeVersionId } from "../../../../src/daemon/runtime/ontology/supersede.js";
import { submitProposal } from "../../../../src/daemon/runtime/ontology/control-plane.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const SCOPE: QueryScope = { org: "test-org", workspace: "test-ws" };
const AGENT = "ci-agent-045d";

/**
 * A STATEFUL multi-table in-memory store, exposed as a `responder` for the shared fake
 * transport. It records every `INSERT INTO "<table>"` as a row keyed by table, and answers
 * the SELECTs the entity-model + supersede + control-plane writers issue:
 *   - by-id presence probe:        `SELECT id … WHERE id = '<id>' AND agent_id = '…' LIMIT 1`
 *   - linker by-name resolve:      `SELECT id … FROM "entities" WHERE name = '<canonical>' …`
 *   - updateOrInsertByKey probe:   `SELECT id FROM "entities" WHERE id = '<id>' LIMIT 1`
 *   - max-version read:            `SELECT version … WHERE claim_key = '<ck>' ORDER BY version DESC`
 * Every other statement answers `[]`. An UPDATE (the `entities` upsert edit path) mutates the
 * recorded row. This is the minimum fidelity needed for the deterministic-id dedup to FIRE —
 * a write whose id is already present must be observable as already-present so the writer
 * skips its append.
 */
function statefulStore(): { storage: StorageQuery; rows: Record<string, StorageRow[]>; transport: FakeDeepLakeTransport } {
	const rows: Record<string, StorageRow[]> = {};

	const tableOf = (sql: string, verb: "INSERT INTO" | "FROM" | "UPDATE"): string => {
		const re = new RegExp(`${verb}\\s+"?([A-Za-z_][A-Za-z0-9_]*)"?`, "i");
		const m = re.exec(sql);
		return m ? m[1] : "";
	};
	const captured = (sql: string, col: string): string | null => {
		// Pull a single-quoted value following `<col> = '…'` (handles the `E'…'` body prefix too).
		const m = new RegExp(`"?${col}"?\\s*=\\s*E?'([^']*)'`, "i").exec(sql);
		return m ? m[1] : null;
	};

	const responder = (req: TransportRequest): StorageRow[] => {
		const sql = req.sql;
		const upper = sql.toUpperCase();

		// ── INSERT: record a row from (cols) VALUES (vals). ──
		if (upper.startsWith("INSERT INTO")) {
			const table = tableOf(sql, "INSERT INTO");
			const colsMatch = /\(([^)]*)\)\s*VALUES\s*\(/i.exec(sql);
			const valsMatch = /VALUES\s*\((.*)\)\s*$/is.exec(sql);
			if (table !== "" && colsMatch && valsMatch) {
				const cols = colsMatch[1].split(",").map((c) => c.trim().replace(/"/g, ""));
				const vals = splitTopLevel(valsMatch[1]).map(unliteral);
				const row: StorageRow = {};
				cols.forEach((c, i) => {
					row[c] = vals[i];
				});
				(rows[table] ??= []).push(row);
			}
			return [];
		}

		// ── UPDATE: the entities upsert edit path (id already present) — mutate in place. ──
		if (upper.startsWith("UPDATE")) {
			const table = tableOf(sql, "UPDATE");
			const id = captured(sql, "id");
			const list = rows[table] ?? [];
			const target = id !== null ? list.find((r) => String(r.id) === id) : undefined;
			if (target) {
				// Apply each `col = val` in the SET clause we can parse (best-effort; the test
				// only relies on row COUNT staying at one, not the mutated content).
				const setPart = /SET\s+(.*?)\s+WHERE/is.exec(sql);
				if (setPart) {
					for (const assign of splitTopLevel(setPart[1])) {
						const am = /"?([A-Za-z_][A-Za-z0-9_]*)"?\s*=\s*(.*)$/s.exec(assign.trim());
						if (am) target[am[1]] = unliteral(am[2].trim());
					}
				}
			}
			return [];
		}

		// ── SELECT: answer presence probes + resolves from the recorded rows. ──
		if (upper.startsWith("SELECT")) {
			const table = tableOf(sql, "FROM");
			const list = rows[table] ?? [];

			// max-version read for a claim_key (supersede / version bump).
			if (/CLAIM_KEY/.test(upper) && /ORDER BY/.test(upper) && /VERSION/.test(upper)) {
				const ck = captured(sql, "claim_key");
				const matches = list.filter((r) => String(r.claim_key) === ck);
				if (matches.length === 0) return [];
				const top = matches.reduce((a, b) => (Number(b.version) >= Number(a.version) ? b : a));
				return [{ version: Number(top.version) }];
			}

			// by-name resolve (linker): WHERE name = '<canonical>' [AND agent_id = '…'].
			const wantName = captured(sql, "name");
			if (wantName !== null) {
				const agent = captured(sql, "agent_id");
				const hit = list.find(
					(r) => String(r.name) === wantName && (agent === null || String(r.agent_id) === agent),
				);
				return hit ? [{ id: hit.id }] : [];
			}

			// by-id presence probe: WHERE id = '<id>' [AND agent_id = '…'].
			const wantId = captured(sql, "id");
			if (wantId !== null) {
				const agent = captured(sql, "agent_id");
				const hit = list.find(
					(r) => String(r.id) === wantId && (agent === null || String(r.agent_id) === agent),
				);
				return hit ? [{ id: hit.id }] : [];
			}

			// A bare list read → every recorded row of the table.
			return list.slice();
		}

		return [];
	};

	const transport = new FakeDeepLakeTransport(responder);
	const storage = createStorageClient({ provider: stubProvider(fakeCredentialRecord()), transport });
	return { storage, rows, transport };
}

/** Split a comma-separated VALUES / SET body at the TOP level (respecting single quotes). */
function splitTopLevel(body: string): string[] {
	const out: string[] = [];
	let depth = 0;
	let inStr = false;
	let cur = "";
	for (let i = 0; i < body.length; i++) {
		const ch = body[i];
		if (inStr) {
			cur += ch;
			if (ch === "'") inStr = false;
			continue;
		}
		if (ch === "'") {
			inStr = true;
			cur += ch;
		} else if (ch === "(") {
			depth++;
			cur += ch;
		} else if (ch === ")") {
			depth--;
			cur += ch;
		} else if (ch === "," && depth === 0) {
			out.push(cur.trim());
			cur = "";
		} else {
			cur += ch;
		}
	}
	if (cur.trim() !== "") out.push(cur.trim());
	return out;
}

/** Strip a SQL string literal (`'…'` or `E'…'`) to its raw value; pass a bare number through. */
function unliteral(token: string): string {
	const t = token.trim();
	const m = /^E?'([\s\S]*)'$/.exec(t);
	if (m) return m[1].replace(/''/g, "'");
	return t;
}

/** Count recorded rows in a table whose `id` equals the deterministic id. */
function countById(rows: Record<string, StorageRow[]>, table: string, id: string): number {
	return (rows[table] ?? []).filter((r) => String(r.id) === id).length;
}

// ── The shared edge fixtures: ONE memory, ONE entity, ONE claim slot. ─────────

const MEMORY_ID = "mem-coord-1";
const ENTITY_CANONICAL = "activeloop";
const ENTITY_ID = deriveEntityId(AGENT, ENTITY_CANONICAL);
const ASPECT_NAME = "headcount";
const ASPECT_ID = deriveAspectId(ENTITY_ID, ASPECT_NAME);
const SLOT = { groupKey: "size", claimKey: "employees" } as const;
const ATTR_V1_ID = attributeVersionId(ASPECT_ID, SLOT, 1);
const MENTION_ID = deriveMentionId(MEMORY_ID, ENTITY_ID);

/** The 045a/045c PIPELINE apply: create the entity + aspect, write the claim, link the memory. */
async function runPipelineApply(storage: StorageQuery): Promise<void> {
	await writeEntity(storage, SCOPE, { agentId: AGENT, rawName: ENTITY_CANONICAL, type: "system" });
	await writeAspect(storage, SCOPE, { agentId: AGENT, entityId: ENTITY_ID, name: ASPECT_NAME });
	await writeAttribute(storage, SCOPE, {
		agentId: AGENT,
		aspectId: ASPECT_ID,
		slot: SLOT,
		kind: "attribute",
		content: "Activeloop has 60 employees",
		confidence: 0.9,
		importance: 0.6,
		provenance: { memoryId: MEMORY_ID, source: "extraction" },
	});
	await inlineLinkMemory(storage, SCOPE, {
		agentId: AGENT,
		memoryId: MEMORY_ID,
		content: "We met the Activeloop team this week.",
	});
}

/**
 * The DREAMING apply over the SAME edge: it goes through the runner's ONLY graph-write
 * seam — `submitProposal` (a bounded `claim.add` → the SAME `writeAttribute`) — plus the
 * SAME `inlineLinkMemory` entry point for the mention. This mirrors EXACTLY what the
 * dreaming runner does (`runner.ts:284` submitProposal; the 045c mention coordination): it
 * never issues a raw insert.
 */
async function runDreamingApply(storage: StorageQuery): Promise<void> {
	// The dreaming pass re-links the same memory→entity through the shared entry point.
	await inlineLinkMemory(storage, SCOPE, {
		agentId: AGENT,
		memoryId: MEMORY_ID,
		content: "Activeloop came up again in the consolidation.",
	});
	// The dreaming pass proposes the SAME bounded claim.add; the control plane applies it
	// through the SAME writeAttribute (deterministic attr_… id + presence-probe).
	const outcome = await submitProposal(
		storage,
		SCOPE,
		{
			operation: "claim.add",
			payload: {
				aspectId: ASPECT_ID,
				groupKey: SLOT.groupKey,
				claimKey: SLOT.claimKey,
				kind: "attribute",
				content: "Activeloop has 60 employees",
				memoryId: MEMORY_ID,
				confidence: 0.9,
				importance: 0.6,
			},
			confidence: 0.9,
			rationale: "consolidate headcount claim",
			provenance: { source: "dreaming", evidence: MEMORY_ID },
		},
		{ agentId: AGENT },
	);
	// Sanity: the bounded op took the DIRECT apply route (so it actually reached writeAttribute).
	expect(outcome.route, "a bounded claim.add applies directly through writeAttribute").toBe("direct");
}

describe("PRD-045d d-AC-4 — dreaming-apply + 045a/045c graph-persist do NOT double-write the same edge", () => {
	it("pipeline FIRST then dreaming → exactly ONE mention row and ONE claim row (dreaming is a no-op append)", async () => {
		const { storage, rows } = statefulStore();

		await runPipelineApply(storage);
		// After the pipeline pass the edge exists exactly once.
		expect(countById(rows, "memory_entity_mentions", MENTION_ID)).toBe(1);
		expect(countById(rows, "entity_attributes", ATTR_V1_ID)).toBe(1);

		await runDreamingApply(storage);

		// d-AC-4: the dreaming pass over the SAME edge wrote NOTHING NEW — the deterministic
		// id + presence-probe made both appends no-ops. Still exactly ONE row each.
		expect(
			countById(rows, "memory_entity_mentions", MENTION_ID),
			"the mention edge converged to ONE row (no double-write)",
		).toBe(1);
		expect(
			countById(rows, "entity_attributes", ATTR_V1_ID),
			"the claim edge converged to ONE row (no double-write)",
		).toBe(1);
	});

	it("dreaming FIRST then pipeline → exactly ONE mention row and ONE claim row (symmetric convergence)", async () => {
		const { storage, rows } = statefulStore();

		await runDreamingApply(storage);
		// The dreaming pass writes the bounded claim through submitProposal → writeAttribute
		// (one row). It does NOT create the mention edge yet: the inline linker links ONLY to
		// EXISTING entities (a-AC-1), and the entity has not been created yet (the 045a pipeline
		// is the PRIMARY graph writer — D-045d-1), so there is nothing to link to. That is the
		// correct division of labour, not a double-write.
		expect(countById(rows, "entity_attributes", ATTR_V1_ID), "dreaming wrote the claim once").toBe(1);
		expect(countById(rows, "memory_entity_mentions", MENTION_ID), "no entity yet → no mention yet").toBe(0);

		await runPipelineApply(storage);

		// After the pipeline creates the entity + links the memory + re-writes the SAME claim:
		// the claim is a no-op append (already present by its deterministic id) and the mention
		// lands exactly once. Whichever path wrote the claim first, the other is a no-op — the
		// edges converge to ONE row each (no double-write).
		expect(countById(rows, "entity_attributes", ATTR_V1_ID), "symmetric: ONE claim row").toBe(1);
		expect(countById(rows, "memory_entity_mentions", MENTION_ID), "symmetric: ONE mention row").toBe(1);
	});

	it("both paths run THREE times interleaved → still exactly ONE row per edge (idempotent under repeat)", async () => {
		const { storage, rows } = statefulStore();

		for (let i = 0; i < 3; i++) {
			await runPipelineApply(storage);
			await runDreamingApply(storage);
		}

		// Six total apply passes over the same edge, ONE durable row each — the deterministic-id
		// idempotency holds under arbitrary repeat (the live-backend property 045c relies on).
		expect(countById(rows, "memory_entity_mentions", MENTION_ID), "ONE mention under repeat").toBe(1);
		expect(countById(rows, "entity_attributes", ATTR_V1_ID), "ONE claim under repeat").toBe(1);
		// And exactly ONE entity row for the shared canonical name (update-or-insert by id).
		expect(countById(rows, "entities", ENTITY_ID), "ONE entity under repeat").toBe(1);
	});
});
