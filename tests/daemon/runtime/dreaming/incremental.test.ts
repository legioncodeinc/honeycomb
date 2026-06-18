/**
 * PRD-009b Dreaming Session Runner (incremental pass) — b-AC-1..6 (Wave 2).
 *
 * Verification posture (EXECUTION_LEDGER-prd-009 / dreaming CONVENTIONS):
 *   - The full {@link DreamingRunner} lifecycle runs against a STATEFUL fake DeepLake
 *     transport that models the relevant tables (`dreaming_state`, `memory`,
 *     `entities`, `entity_attributes`, `entity_aspects`, `ontology_proposals`) in
 *     memory with append-only / highest-version-by-id semantics. No live network.
 *   - The model is a FAKE `ModelClient` (`createFakeModelClient({ memory_dreaming })`)
 *     so the dreaming workload + the returned mutation set are scripted and asserted.
 *   - The 008c apply path is the REAL `submitProposal` (control-plane risk router +
 *     append-only supersede), so the destructive-routing + append-only assertions are
 *     proven end-to-end, not mocked.
 *   - Each `describe` is named after the b-AC it proves (one-to-one ledger map).
 *   - No `.skip` / `.only`; `vitest run` is CI.
 *
 * b-AC-1 payload loads identity + new summaries + graph snapshot + DREAMING.md; the
 *        pass runs as a session (the harness drives the lifecycle).
 * b-AC-2 mutations apply via the control plane with provenance; destructive → pending.
 * b-AC-3 incremental loads ONLY post-`last_pass_at` data + a graph query tool exists.
 * b-AC-4 a supersede advances the prior claim's status on the append-only path and the
 *        prior rows remain on disk (merge/delete are the destructive guard of b-AC-2).
 * b-AC-5 on success `last_pass_at` is updated and `pending_job_id` is cleared.
 * b-AC-6 the model call resolves the `memory_dreaming` workload, not extraction.
 */

import { describe, expect, it } from "vitest";

import type { QueryScope, StorageQuery } from "../../../../src/daemon/storage/client.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { StorageRow } from "../../../../src/daemon/storage/result.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";
import { createFakeModelClient, type FakeModelClient } from "../../../../src/daemon/runtime/pipeline/model-client.js";
import {
	createDreamingRunner,
	type DreamingStateUpdater,
} from "../../../../src/daemon/runtime/dreaming/runner.js";
import type { DreamingJobPayload } from "../../../../src/daemon/runtime/dreaming/contracts.js";
import {
	createGraphQueryTool,
	createIncrementalStrategy,
	DEFAULT_DREAMING_TASK_PROMPT,
	estimateTokens,
	IncrementalPayloadStrategy,
	type DreamingIdentitySource,
} from "../../../../src/daemon/runtime/dreaming/incremental.js";
import { dreamingStateId } from "../../../../src/daemon/runtime/dreaming/trigger.js";

const SCOPE: QueryScope = { org: "test-org", workspace: "test-ws" };
const AGENT = "agent-a";

// ════════════════════════════════════════════════════════════════════════════
// A stateful in-memory multi-table store + responder.
// ════════════════════════════════════════════════════════════════════════════

interface Row {
	[col: string]: string | number;
}

/**
 * Models the daemon tables this pass touches with the byte-shapes the production
 * builders emit: `INSERT INTO "<tbl>" (cols) VALUES (vals)` appends a row; a SELECT is
 * filtered by the equality / NOT-LIKE / ILIKE conjuncts in its WHERE and ordered by
 * version/creation_date when requested. Highest-version-by-id reads fall out of the
 * ORDER BY version DESC LIMIT 1 the writers issue.
 */
class GraphStore {
	readonly tables = new Map<string, Row[]>();

	seed(table: string, rows: Row[]): void {
		this.tables.set(table, [...(this.tables.get(table) ?? []), ...rows]);
	}

	rowsOf(table: string): Row[] {
		return this.tables.get(table) ?? [];
	}

	responder(): (req: TransportRequest) => StorageRow[] {
		return (req) => this.handle(req.sql);
	}

	private handle(sql: string): StorageRow[] {
		const s = sql.trim();
		if (/^INSERT/i.test(s)) {
			this.applyInsert(s);
			return [];
		}
		if (/^SELECT/i.test(s)) {
			return this.applySelect(s);
		}
		// Heal introspection / UPDATE / other — answer empty (the table "exists").
		return [];
	}

	private applyInsert(sql: string): void {
		const table = matchTable(sql);
		const m = sql.match(/\(([^)]*)\)\s*VALUES\s*\((.*)\)\s*$/is);
		if (!table || !m) return;
		const cols = m[1].split(",").map((c) => c.trim().replace(/^"|"$/g, ""));
		const vals = splitTopLevel(m[2]);
		const row: Row = {};
		cols.forEach((c, i) => {
			const raw = vals[i] ?? "";
			row[c] = isNumeric(raw) ? Number(raw) : unquote(raw);
		});
		this.seed(table, [row]);
	}

	private applySelect(sql: string): StorageRow[] {
		const table = matchTable(sql);
		if (!table) return [];
		let rows = [...this.rowsOf(table)];

		// Equality conjuncts: id / agent_id / claim_key / status / entity_id.
		for (const col of ["id", "agent_id", "claim_key", "status", "entity_id"]) {
			const v = matchEq(sql, col);
			if (v !== null) rows = rows.filter((r) => String(r[col] ?? "") === v);
		}
		// `creation_date > '<since>'` (the incremental delta bound for summaries).
		const since = matchGt(sql, "creation_date");
		if (since !== null) rows = rows.filter((r) => String(r.creation_date ?? "") > since);
		// `updated_at > '<since>'` (the incremental delta bound for the graph snapshot).
		const upSince = matchGt(sql, "updated_at");
		if (upSince !== null) rows = rows.filter((r) => String(r.updated_at ?? "") > upSince);
		// `path NOT LIKE 'transcripts/%'` (exclude raw transcript rows from the delta).
		if (/path"?\s+NOT\s+LIKE\s+'transcripts\//i.test(sql)) {
			rows = rows.filter((r) => !String(r.path ?? "").startsWith("transcripts/"));
		}
		// `name ILIKE '%frag%'` (the graph-query tool substring search).
		const ilike = matchIlike(sql, "name");
		if (ilike !== null) {
			const needle = ilike.replace(/%/g, "").toLowerCase();
			rows = rows.filter((r) => String(r.name ?? "").toLowerCase().includes(needle));
		}

		// ORDER BY version DESC LIMIT 1 → highest-version-by-id.
		if (/ORDER\s+BY\s+("?version"?)\s+DESC/i.test(sql)) {
			rows.sort((a, b) => Number(b.version ?? 0) - Number(a.version ?? 0));
		} else if (/ORDER\s+BY\s+("?creation_date"?|"?updated_at"?)\s+(ASC|DESC)/i.test(sql)) {
			const desc = /\b(updated_at)"?\s+DESC/i.test(sql);
			const key = /updated_at/i.test(sql) ? "updated_at" : "creation_date";
			rows.sort((a, b) => {
				const cmp = String(a[key] ?? "").localeCompare(String(b[key] ?? ""));
				return desc ? -cmp : cmp;
			});
		}
		const limit = matchLimit(sql);
		if (limit !== null) rows = rows.slice(0, limit);
		return rows.map((r) => ({ ...r }) as StorageRow);
	}
}

// ── SQL micro-parsers (test-only, tolerant) ───────────────────────────────────

function matchTable(sql: string): string | null {
	const m = sql.match(/(?:INTO|FROM)\s+"([a-zA-Z_][a-zA-Z0-9_]*)"/i);
	return m ? m[1] : null;
}
// A leading non-identifier boundary so a column matcher for `id` does NOT also match
// inside `agent_id` / `entity_id` (the `id` suffix). `(?:^|[^\w"])` anchors the match
// to a real column-name start.
function matchEq(sql: string, col: string): string | null {
	const re = new RegExp(`(?:^|[^\\w"])"?${col}"?\\s*=\\s*'([^']*)'`, "i");
	const m = sql.match(re);
	return m ? m[1] : null;
}
function matchGt(sql: string, col: string): string | null {
	const re = new RegExp(`(?:^|[^\\w"])"?${col}"?\\s*>\\s*'([^']*)'`, "i");
	const m = sql.match(re);
	return m ? m[1] : null;
}
function matchIlike(sql: string, col: string): string | null {
	const re = new RegExp(`(?:^|[^\\w"])"?${col}"?\\s+ILIKE\\s+'([^']*)'`, "i");
	const m = sql.match(re);
	return m ? m[1] : null;
}
function matchLimit(sql: string): number | null {
	const m = sql.match(/LIMIT\s+(\d+)/i);
	return m ? Number(m[1]) : null;
}
function splitTopLevel(s: string): string[] {
	const out: string[] = [];
	let inStr = false;
	let cur = "";
	for (let i = 0; i < s.length; i++) {
		const ch = s[i];
		if (inStr) {
			cur += ch;
			if (ch === "'" && s[i + 1] !== "'") inStr = false;
			else if (ch === "'" && s[i + 1] === "'") {
				cur += s[++i];
			}
			continue;
		}
		if (ch === "'") {
			inStr = true;
			cur += ch;
			continue;
		}
		if (ch === ",") {
			out.push(cur.trim());
			cur = "";
			continue;
		}
		cur += ch;
	}
	if (cur.trim() !== "") out.push(cur.trim());
	return out;
}
function unquote(v: string): string {
	const t = v.trim();
	if (/^E'/i.test(t)) return t.slice(2, -1).replace(/''/g, "'").replace(/\\\\/g, "\\");
	if (t.startsWith("'") && t.endsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
	return t;
}
function isNumeric(v: string): boolean {
	const t = v.trim();
	return t !== "" && !t.startsWith("'") && !/^E'/i.test(t) && Number.isFinite(Number(t));
}

// ── Test wiring ────────────────────────────────────────────────────────────────

function storageFor(store: GraphStore): StorageQuery {
	const transport = new FakeDeepLakeTransport(store.responder());
	return createStorageClient({ transport, provider: stubProvider(fakeCredentialRecord()) });
}

/** A recording state-updater so b-AC-5 can assert the success path stamped + cleared. */
function recordingUpdater(): DreamingStateUpdater & { calls: Array<{ agentId: string; passAt: string }> } {
	const calls: Array<{ agentId: string; passAt: string }> = [];
	return {
		calls,
		recordPassComplete(agentId: string, passAt: string): Promise<void> {
			calls.push({ agentId, passAt });
			return Promise.resolve();
		},
	};
}

/** A fixed identity source so the identity/DREAMING.md seam is asserted deterministically. */
function identitySource(over: Partial<{
	identityFiles: string[];
	priorDreamingSessions: string[];
	memoryMd: string;
	dreamingTaskPrompt: string;
}> = {}): DreamingIdentitySource {
	return {
		load() {
			return Promise.resolve({
				identityFiles: over.identityFiles ?? ["IDENTITY: I am the dreaming agent."],
				priorDreamingSessions: over.priorDreamingSessions ?? ["PRIOR PASS: merged A and B."],
				memoryMd: over.memoryMd ?? "MEMORY.md body",
				dreamingTaskPrompt: over.dreamingTaskPrompt ?? DEFAULT_DREAMING_TASK_PROMPT,
			});
		},
	};
}

const JOB: DreamingJobPayload = {
	mode: "incremental",
	agentId: AGENT,
	enqueuedAt: "2026-06-17T00:00:00.000Z",
	tokensAtEnqueue: 100_000,
};

/** Seed a prior `dreaming_state` row carrying a `last_pass_at` boundary for the scope. */
function seedLastPass(store: GraphStore, lastPassAt: string): void {
	store.seed("dreaming_state", [
		{
			id: dreamingStateId({ agentId: AGENT }),
			agent_id: AGENT,
			tokens_since_last_pass: 0,
			last_pass_at: lastPassAt,
			pending_job_id: "job-1",
			version: 3,
		},
	]);
}

/** Seed `memory` summary rows (chronological via creation_date). */
function seedSummary(store: GraphStore, path: string, summary: string, creationDate: string): void {
	store.seed("memory", [
		{ id: path, path, summary, agent_id: AGENT, creation_date: creationDate, last_update_date: creationDate },
	]);
}

const PASS_BOUNDARY = "2026-06-10T00:00:00.000Z";

// ════════════════════════════════════════════════════════════════════════════
// b-AC-1
// ════════════════════════════════════════════════════════════════════════════

describe("b-AC-1: pass loads identity + new summaries + graph snapshot + DREAMING.md", () => {
	it("assembles a prompt carrying the identity preset, DREAMING.md, new summaries, and the changed graph", async () => {
		const store = new GraphStore();
		seedLastPass(store, PASS_BOUNDARY);
		seedSummary(store, "sum/new", "User prefers dark mode now.", "2026-06-15T00:00:00.000Z");
		store.seed("entities", [
			{ id: "e1", name: "DarkMode", type: "feature", agent_id: AGENT, updated_at: "2026-06-15T01:00:00.000Z" },
		]);
		store.seed("entity_attributes", [
			{
				id: "a1",
				content: "theme=dark",
				claim_key: "ck1",
				status: "active",
				agent_id: AGENT,
				updated_at: "2026-06-15T01:00:00.000Z",
			},
		]);

		const strategy = new IncrementalPayloadStrategy({ identitySource: identitySource() });
		const payload = await strategy.loadPayload(storageFor(store), SCOPE, JOB);

		expect(payload).not.toBeNull();
		const prompt = payload?.prompt ?? "";
		expect(prompt).toContain("DREAMING.md (task)");
		expect(prompt).toContain(DEFAULT_DREAMING_TASK_PROMPT.slice(0, 32));
		expect(prompt).toContain("IDENTITY: I am the dreaming agent.");
		expect(prompt).toContain("MEMORY.md body");
		expect(prompt).toContain("PRIOR PASS: merged A and B.");
		expect(prompt).toContain("User prefers dark mode now."); // new summary
		expect(prompt).toContain("entity e1 (feature): DarkMode"); // graph snapshot
		expect(prompt).toContain("claim ck1: theme=dark");
		expect(payload?.tokenBudget).toBeGreaterThan(0);
	});

	it("captures the pass as a session: the harness drives load → model → apply → finalize for a real job", async () => {
		const store = new GraphStore();
		seedLastPass(store, PASS_BOUNDARY);
		seedSummary(store, "sum/new", "A fact appeared.", "2026-06-15T00:00:00.000Z");

		const model = createFakeModelClient({
			memory_dreaming: JSON.stringify({
				mutations: [
					{ kind: "create_entity", payload: { name: "Widget", type: "thing" }, confidence: 0.9, rationale: "seen" },
				],
				summary: "consolidated one entity",
				tokenBudget: 128_000,
			}),
		});
		const updater = recordingUpdater();
		const runner = createDreamingRunner({
			storage: storageFor(store),
			scope: SCOPE,
			strategy: createIncrementalStrategy({ identitySource: identitySource() }),
			model,
			stateUpdater: updater,
		});

		const result = await runner.runPass(JOB);

		expect(model.calls).toHaveLength(1); // the model was called → a session ran
		expect(result.summary).toBe("consolidated one entity");
		expect(result.outcomes).toHaveLength(1);
		expect(updater.calls).toHaveLength(1); // finalized like any session
	});
});

// ════════════════════════════════════════════════════════════════════════════
// b-AC-2
// ════════════════════════════════════════════════════════════════════════════

describe("b-AC-2: mutations apply via the control plane with provenance; destructive → pending review", () => {
	async function runWith(store: GraphStore, mutations: unknown[]): ReturnType<ReturnType<typeof createDreamingRunner>["runPass"]> {
		seedLastPass(store, PASS_BOUNDARY);
		seedSummary(store, "sum/new", "trigger summary", "2026-06-15T00:00:00.000Z");
		const model = createFakeModelClient({
			memory_dreaming: JSON.stringify({ mutations, summary: "s", tokenBudget: 128_000 }),
		});
		const runner = createDreamingRunner({
			storage: storageFor(store),
			scope: SCOPE,
			strategy: createIncrementalStrategy({ identitySource: identitySource() }),
			model,
			stateUpdater: recordingUpdater(),
		});
		return runner.runPass(JOB);
	}

	it("routes an additive create_entity directly and writes an applied ontology_proposals row with provenance", async () => {
		const store = new GraphStore();
		const result = await runWith(store, [
			{ kind: "create_entity", payload: { name: "Acme", type: "org" }, confidence: 0.9, rationale: "evidence-x" },
		]);

		expect(result.outcomes[0].route).toBe("direct");
		expect(result.outcomes[0].status).toBe("applied");
		const proposals = store.rowsOf("ontology_proposals");
		expect(proposals.some((p) => p.status === "applied" && p.operation === "entity.create")).toBe(true);
		// Provenance is carried on the proposal row (rationale + evidence).
		const applied = proposals.find((p) => p.status === "applied");
		expect(String(applied?.rationale)).toBe("evidence-x");
	});

	it("routes a destructive merge_entities to PENDING review, never applied", async () => {
		const store = new GraphStore();
		const result = await runWith(store, [
			{ kind: "merge_entities", payload: { from: "e2", into: "e1" }, confidence: 1, rationale: "dupes" },
		]);

		expect(result.outcomes[0].route).toBe("pending");
		expect(result.outcomes[0].status).toBe("pending");
		const proposals = store.rowsOf("ontology_proposals");
		expect(proposals.some((p) => p.status === "pending" && p.operation === "entity.merge")).toBe(true);
		// Destructive op is NOT applied: no applied proposal row was written for it.
		expect(proposals.some((p) => p.status === "applied")).toBe(false);
	});

	it("routes delete_entity and delete_attribute to PENDING review (destructive guard)", async () => {
		const store = new GraphStore();
		const result = await runWith(store, [
			{ kind: "delete_entity", payload: { entityId: "e9" }, confidence: 1, rationale: "junk" },
			{ kind: "delete_attribute", payload: { priorId: "a9" }, confidence: 1, rationale: "junk" },
		]);

		expect(result.outcomes.every((o) => o.route === "pending")).toBe(true);
		expect(result.outcomes.map((o) => o.status)).toEqual(["pending", "pending"]);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// b-AC-3
// ════════════════════════════════════════════════════════════════════════════

describe("b-AC-3: incremental loads ONLY post-last_pass_at data + a graph query tool is available", () => {
	it("loads only summaries written after last_pass_at, not the ones before it", async () => {
		const store = new GraphStore();
		seedLastPass(store, PASS_BOUNDARY);
		seedSummary(store, "sum/old", "OLD summary before the boundary.", "2026-06-01T00:00:00.000Z");
		seedSummary(store, "sum/new", "NEW summary after the boundary.", "2026-06-15T00:00:00.000Z");

		const strategy = new IncrementalPayloadStrategy({ identitySource: identitySource() });
		const payload = await strategy.loadPayload(storageFor(store), SCOPE, JOB);

		const prompt = payload?.prompt ?? "";
		expect(prompt).toContain("NEW summary after the boundary.");
		expect(prompt).not.toContain("OLD summary before the boundary.");
	});

	it("excludes raw transcript rows from the summary delta", async () => {
		const store = new GraphStore();
		seedLastPass(store, PASS_BOUNDARY);
		seedSummary(store, "transcripts/sess-1", "RAW transcript content.", "2026-06-15T00:00:00.000Z");
		seedSummary(store, "sum/curated", "Curated summary.", "2026-06-15T00:00:01.000Z");

		const payload = await new IncrementalPayloadStrategy({ identitySource: identitySource() }).loadPayload(
			storageFor(store),
			SCOPE,
			JOB,
		);

		const prompt = payload?.prompt ?? "";
		expect(prompt).toContain("Curated summary.");
		expect(prompt).not.toContain("RAW transcript content.");
	});

	it("returns null (an empty pass) when there are no new summaries since last_pass_at", async () => {
		const store = new GraphStore();
		seedLastPass(store, PASS_BOUNDARY);
		seedSummary(store, "sum/old", "Only an old summary.", "2026-06-01T00:00:00.000Z");

		const payload = await new IncrementalPayloadStrategy({ identitySource: identitySource() }).loadPayload(
			storageFor(store),
			SCOPE,
			JOB,
		);
		expect(payload).toBeNull();
	});

	it("exposes a scoped, read-only graph query tool the model can call on demand", async () => {
		const store = new GraphStore();
		store.seed("entities", [
			{ id: "e1", name: "Postgres", type: "tech", agent_id: AGENT },
			{ id: "e2", name: "Redis", type: "tech", agent_id: AGENT },
			{ id: "e3", name: "Postgres-Mirror", type: "tech", agent_id: "other-agent" }, // different agent
		]);

		const tool = createGraphQueryTool(storageFor(store), SCOPE, AGENT);
		const res = await tool.findEntitiesByName("postgres");

		// Substring match, case-insensitive, AND scoped to AGENT (other-agent excluded).
		expect(res.rows.map((r) => r.id)).toEqual(["e1"]);
		// The tool issues a guarded, agent-scoped SELECT.
		expect(res.sql).toContain("agent_id");
		expect(res.sql).toContain("ILIKE");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// b-AC-4
// ════════════════════════════════════════════════════════════════════════════

describe("b-AC-4: a supersede advances the prior claim's status on the append-only path; prior rows remain on disk", () => {
	it("supersede_attribute appends a new active version AND an append-mark of the prior, leaving the original row intact", async () => {
		const store = new GraphStore();
		seedLastPass(store, PASS_BOUNDARY);
		seedSummary(store, "sum/new", "claim changed", "2026-06-15T00:00:00.000Z");

		// A prior ACTIVE claim row already on disk for the slot's claim_key.
		// (claim_key is derived by slotClaimKey(aspectId, slot); we seed the row the
		// supersede path will resolve as the prior active sibling.)
		const model = createFakeModelClient({
			memory_dreaming: JSON.stringify({
				mutations: [
					{
						kind: "supersede_attribute",
						payload: {
							entityId: "e1",
							aspectId: "asp1",
							groupKey: "g1",
							claimKey: "c1",
							content: "new value",
							priorId: "attr_prior",
							memoryId: "mem1",
						},
						confidence: 0.95,
						rationale: "newer evidence",
					},
				],
				summary: "superseded a claim",
				tokenBudget: 128_000,
			}),
		});

		// Seed the prior active row so the append-mark has a complete row to copy forward.
		store.seed("entity_attributes", [
			{
				id: "attr_prior",
				aspect_id: "asp1",
				content: "old value",
				status: "active",
				claim_key: "ck-seed",
				version: 1,
				agent_id: AGENT,
			},
		]);

		const runner = createDreamingRunner({
			storage: storageFor(store),
			scope: SCOPE,
			strategy: createIncrementalStrategy({ identitySource: identitySource() }),
			model,
			stateUpdater: recordingUpdater(),
		});
		const result = await runner.runPass(JOB);

		expect(result.outcomes[0].route).toBe("direct"); // claim.supersede is bounded direct-apply
		expect(result.outcomes[0].status).toBe("applied");

		const attrRows = store.rowsOf("entity_attributes");
		// The ORIGINAL active row is still on disk (append-only — never mutated in place).
		const original = attrRows.find((r) => r.id === "attr_prior" && r.status === "active" && r.version === 1);
		expect(original).toBeDefined();
		expect(original?.content).toBe("old value"); // content copied/kept UNCHANGED

		// A superseded append-mark of the PRIOR id was added (status advanced via a NEW row).
		const supersededMark = attrRows.find((r) => r.id === "attr_prior" && r.status === "superseded");
		expect(supersededMark).toBeDefined();
		expect(Number(supersededMark?.version)).toBeGreaterThan(1); // appended at a higher version

		// A NEW active claim version was appended (the new value).
		expect(attrRows.some((r) => r.id !== "attr_prior" && r.status === "active" && r.content === "new value")).toBe(true);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// b-AC-5
// ════════════════════════════════════════════════════════════════════════════

describe("b-AC-5: on a successful pass, last_pass_at is updated and pending_job_id is cleared", () => {
	it("invokes the state updater exactly once with the agent id and a fresh ISO last_pass_at", async () => {
		const store = new GraphStore();
		seedLastPass(store, PASS_BOUNDARY);
		seedSummary(store, "sum/new", "a new fact", "2026-06-15T00:00:00.000Z");

		const model = createFakeModelClient({
			memory_dreaming: JSON.stringify({ mutations: [], summary: "noop", tokenBudget: 128_000 }),
		});
		const updater = recordingUpdater();
		const runner = createDreamingRunner({
			storage: storageFor(store),
			scope: SCOPE,
			strategy: createIncrementalStrategy({ identitySource: identitySource() }),
			model,
			stateUpdater: updater,
			clock: { now: () => Date.parse("2026-06-17T12:00:00.000Z") },
		});

		const result = await runner.runPass(JOB);

		// recordPassComplete is the seam that stamps last_pass_at + clears pending_job_id
		// (the trigger's append-only path). The runner calls it once on success.
		expect(updater.calls).toHaveLength(1);
		expect(updater.calls[0].agentId).toBe(AGENT);
		expect(updater.calls[0].passAt).toBe("2026-06-17T12:00:00.000Z");
		expect(result.lastPassAt).toBe("2026-06-17T12:00:00.000Z");
	});

	it("still finalizes (stamps + clears) on an empty pass when there is nothing to dream over", async () => {
		const store = new GraphStore();
		seedLastPass(store, PASS_BOUNDARY);
		// No new summaries → strategy returns null → harness records an empty pass.
		const model = createFakeModelClient({ memory_dreaming: "{}" });
		const updater = recordingUpdater();
		const runner = createDreamingRunner({
			storage: storageFor(store),
			scope: SCOPE,
			strategy: createIncrementalStrategy({ identitySource: identitySource() }),
			model,
			stateUpdater: updater,
		});

		await runner.runPass(JOB);
		expect(model.calls).toHaveLength(0); // model never called on an empty pass
		expect(updater.calls).toHaveLength(1); // but the state is still finalized
	});
});

// ════════════════════════════════════════════════════════════════════════════
// b-AC-6
// ════════════════════════════════════════════════════════════════════════════

describe("b-AC-6: the model call resolves the dreaming workload, not extraction", () => {
	it("calls the model with the memory_dreaming workload", async () => {
		const store = new GraphStore();
		seedLastPass(store, PASS_BOUNDARY);
		seedSummary(store, "sum/new", "fact for routing", "2026-06-15T00:00:00.000Z");

		const model = createFakeModelClient({
			memory_dreaming: JSON.stringify({ mutations: [], summary: "", tokenBudget: 128_000 }),
		});
		const runner = createDreamingRunner({
			storage: storageFor(store),
			scope: SCOPE,
			strategy: createIncrementalStrategy({ identitySource: identitySource() }),
			model,
			stateUpdater: recordingUpdater(),
		});

		await runner.runPass(JOB);

		expect(model.calls).toHaveLength(1);
		expect(model.calls[0].workload).toBe("memory_dreaming");
		expect(model.calls[0].workload).not.toBe("memory_extraction");
	});
});

// ════════════════════════════════════════════════════════════════════════════
// Unit coverage for the pure helpers the strategy relies on.
// ════════════════════════════════════════════════════════════════════════════

describe("token budgeting: the payload is capped to maxInputTokens (D-2)", () => {
	it("estimateTokens approximates ~4 chars per token and rounds up", () => {
		expect(estimateTokens("")).toBe(0);
		expect(estimateTokens("abcd")).toBe(1);
		expect(estimateTokens("abcde")).toBe(2);
	});

	it("caps the assembled prompt under a tiny maxInputTokens budget", async () => {
		const store = new GraphStore();
		seedLastPass(store, PASS_BOUNDARY);
		// A large new summary that would blow a tiny budget.
		seedSummary(store, "sum/big", "x".repeat(10_000), "2026-06-15T00:00:00.000Z");

		const strategy = new IncrementalPayloadStrategy({
			identitySource: identitySource(),
			maxInputTokens: 200,
		});
		const payload = await strategy.loadPayload(storageFor(store), SCOPE, JOB);

		expect(payload).not.toBeNull();
		// The assembled prompt fits under the (coarse) token budget it was capped to.
		expect(estimateTokens(payload?.prompt ?? "")).toBeLessThanOrEqual(200);
		// DREAMING.md leads the priority order, so the task framing survives the cap.
		expect(payload?.prompt ?? "").toContain("DREAMING.md (task)");
	});
});
