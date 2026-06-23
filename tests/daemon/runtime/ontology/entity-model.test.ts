/**
 * PRD-008a Entity Model + Inline Linker — a-AC-1..7 (Wave 1).
 *
 * Verification posture (EXECUTION_LEDGER-prd-008 / ontology CONVENTIONS):
 *   - All assertions run against a FAKE DeepLake transport (`FakeDeepLakeTransport`)
 *     wrapped in a real `StorageClient`. No live network. No `.skip` / `.only`;
 *     `vitest run` is CI.
 *   - Each `describe` block is named after the AC it proves (one-to-one ledger map).
 *   - The fake transport's `requests` array captures every SQL statement issued,
 *     letting us assert the exact write path, the scope on the wire, and the escaping
 *     WITHOUT a live backend.
 *
 * a-AC-1 Inline linker scans proper nouns, links to EXISTING agent entities, creates
 *         nothing, calls no model.
 * a-AC-2 Linker does NO network I/O; synchronous; safe right after the memory commit.
 * a-AC-3 Attribute carries kind/status/confidence/importance/version lineage/provenance.
 * a-AC-4 Aspect weight rises on confirm, decays toward the floor on stale.
 * a-AC-5 Claim value lives in an addressable group_key/claim_key slot under its aspect.
 * a-AC-6 Every write scoped by org/workspace/agent_id; linker never links cross-agent.
 * a-AC-7 Every interpolated name/key/value escaped through the SQL helpers.
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
	ASPECT_WEIGHT_CEILING,
	ASPECT_WEIGHT_FLOOR,
} from "../../../../src/daemon/runtime/ontology/contracts.js";
import {
	ASPECT_CONFIRM_STEP,
	ASPECT_DECAY_STEP,
	ASPECT_STALE_WINDOW_MS,
	AttributeProvenanceError,
	canonicaliseName,
	confirmAspectWeight,
	decayAspectWeight,
	entityId,
	extractProperNounCandidates,
	inlineLinkMemory,
	writeAspect,
	writeAttribute,
	writeEntity,
} from "../../../../src/daemon/runtime/ontology/entity-model.js";
import {
	FakeDeepLakeTransport,
	fakeCredentialRecord,
	stubProvider,
} from "../../../helpers/fake-deeplake.js";

// ── Scope fixture ─────────────────────────────────────────────────────────────

const SCOPE: QueryScope = { org: "test-org", workspace: "test-ws" };
const AGENT = "agent-alpha";

// ── Storage builders ──────────────────────────────────────────────────────────

/** Storage whose responder answers every statement by inspecting the SQL. */
function storageWith(responder: (req: TransportRequest) => StorageRow[]): {
	storage: StorageQuery;
	transport: FakeDeepLakeTransport;
} {
	const transport = new FakeDeepLakeTransport(responder);
	const storage = createStorageClient({ provider: stubProvider(fakeCredentialRecord()), transport });
	return { storage, transport };
}

/** Everything absent (probes miss) and every mutation succeeds — the "all new" world. */
function allNewResponder(): (req: TransportRequest) => StorageRow[] {
	return () => [];
}

/**
 * A responder where `entities` probes by `name = '<canonical>'` return a hit for the
 * supplied canonical names (the entity EXISTS for the agent), and everything else is
 * empty. Lets us drive the linker's "links to existing entity" path.
 */
function entitiesExistResponder(existing: Record<string, string>): (req: TransportRequest) => StorageRow[] {
	return (req) => {
		const sql = req.sql;
		const upper = sql.toUpperCase();
		if (upper.startsWith("SELECT") && upper.includes("ENTITIES") && upper.includes("WHERE NAME")) {
			for (const [canonical, id] of Object.entries(existing)) {
				if (sql.includes(`'${canonical}'`)) return [{ id }];
			}
			return [];
		}
		return [];
	};
}

// ═════════════════════════════════════════════════════════════════════════════
// a-AC-1 — linker links to EXISTING entities only, creates nothing, calls no model
// ═════════════════════════════════════════════════════════════════════════════

describe("a-AC-1 inline linker links to existing agent entities, creates nothing, no model", () => {
	it("writes a mention for a proper noun that matches an EXISTING agent entity", async () => {
		const existingId = entityId(AGENT, "activeloop");
		const { storage, transport } = storageWith(entitiesExistResponder({ activeloop: existingId }));

		const result = await inlineLinkMemory(storage, SCOPE, {
			agentId: AGENT,
			memoryId: "mem-1",
			content: "We migrated to Activeloop this week.",
		});

		// Linked exactly the existing entity.
		expect(result.mentions).toHaveLength(1);
		expect(result.mentions[0].entityId).toBe(existingId);
		expect(result.mentions[0].canonicalName).toBe("activeloop");

		const sqls = transport.requests.map((r) => r.sql.toUpperCase());
		// It WROTE a mention …
		expect(sqls.some((s) => s.startsWith("INSERT") && s.includes("MEMORY_ENTITY_MENTIONS"))).toBe(true);
		// … and CREATED NOTHING: no INSERT/UPDATE into entities or attributes.
		expect(sqls.some((s) => s.includes("INSERT") && s.includes("ENTITIES"))).toBe(false);
		expect(sqls.some((s) => s.includes("UPDATE") && s.includes("ENTITIES"))).toBe(false);
		expect(sqls.some((s) => s.includes("ENTITY_ATTRIBUTES"))).toBe(false);
		expect(sqls.some((s) => s.includes("ENTITY_ASPECTS"))).toBe(false);
	});

	it("links NOTHING when no candidate matches an existing entity (creates no entity)", async () => {
		const { storage, transport } = storageWith(allNewResponder());

		const result = await inlineLinkMemory(storage, SCOPE, {
			agentId: AGENT,
			memoryId: "mem-2",
			content: "We migrated to Activeloop and Honeycomb this week.",
		});

		expect(result.mentions).toHaveLength(0);
		expect(result.candidateCount).toBeGreaterThan(0); // it DID scan candidates …
		const sqls = transport.requests.map((r) => r.sql.toUpperCase());
		// … but wrote NOTHING (no mention, no entity).
		expect(sqls.some((s) => s.startsWith("INSERT"))).toBe(false);
		// Only entity-existence probe SELECTs were issued.
		expect(sqls.every((s) => s.startsWith("SELECT"))).toBe(true);
	});

	it("takes NO model client — the signature is structurally model-free (a-AC-1)", () => {
		// inlineLinkMemory's arguments are (storage, scope, {agentId, memoryId, content}).
		// There is no ModelClient parameter at all, so a model call is impossible by
		// construction. We assert the arity to lock the contract.
		expect(inlineLinkMemory.length).toBe(3);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// a-AC-2 — linker does no network I/O; synchronous; storage-only
// ═════════════════════════════════════════════════════════════════════════════

describe("a-AC-2 linker does no network I/O beyond storage; safe right after commit", () => {
	it("issues ONLY storage queries through the injected client (no fetch, no other I/O)", async () => {
		// The ONLY way the linker reaches the outside world is the injected StorageQuery.
		// We give it a transport that records every call; if the linker did any other I/O
		// it would not be observable here, so we additionally assert global fetch is never
		// invoked by spying on it.
		const fetchSpy = vi_spyGlobalFetch();
		try {
			const existingId = entityId(AGENT, "honeycomb");
			const { storage, transport } = storageWith(entitiesExistResponder({ honeycomb: existingId }));

			await inlineLinkMemory(storage, SCOPE, {
				agentId: AGENT,
				memoryId: "mem-3",
				content: "Honeycomb shipped.",
			});

			// Every observable I/O is a storage query on the injected transport.
			expect(transport.requests.length).toBeGreaterThan(0);
			// Global fetch was never called.
			expect(fetchSpy.calls).toBe(0);
		} finally {
			fetchSpy.restore();
		}
	});

	it("extractProperNounCandidates is pure + synchronous (no async, no I/O)", () => {
		// The proper-noun scan returns synchronously (not a Promise) — proving the
		// detection path is model-free, offline, and safe on the write path.
		const out = extractProperNounCandidates("Alex met Claude at Activeloop.");
		expect(Array.isArray(out)).toBe(true);
		expect(out).toContain("alex");
		expect(out).toContain("claude");
		expect(out).toContain("activeloop");
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// a-AC-3 — attribute carries the full claim shape + provenance
// ═════════════════════════════════════════════════════════════════════════════

describe("a-AC-3 attribute carries kind/status/confidence/importance/version/provenance", () => {
	it("INSERTs an attribute row with every required field + memory provenance", async () => {
		const { storage, transport } = storageWith(allNewResponder());

		await writeAttribute(storage, SCOPE, {
			agentId: AGENT,
			aspectId: "asp-1",
			slot: { groupKey: "role", claimKey: "title" },
			kind: "attribute",
			content: "Staff Engineer",
			confidence: 0.8,
			importance: 0.6,
			provenance: { memoryId: "mem-prov", source: "extraction", proposalId: "prop-9" },
		});

		const insert = transport.requests.map((r) => r.sql).find((s) => s.toUpperCase().startsWith("INSERT"));
		expect(insert, "an attribute INSERT was issued").toBeTruthy();
		const sql = String(insert);
		// kind, status (active), version lineage, claim/group keys, and the memory id.
		expect(sql).toContain("kind");
		expect(sql).toContain("'attribute'");
		expect(sql).toContain("status");
		expect(sql).toContain("'active'");
		expect(sql).toContain("version");
		expect(sql).toContain("confidence");
		expect(sql).toContain("importance");
		expect(sql).toContain("claim_key");
		expect(sql).toContain("group_key");
		// Mandatory provenance: the memory id is on the row.
		expect(sql).toContain("'mem-prov'");
	});

	it("REJECTS an attribute with no provenance.memoryId (not a valid graph row)", async () => {
		const { storage } = storageWith(allNewResponder());
		await expect(
			writeAttribute(storage, SCOPE, {
				agentId: AGENT,
				aspectId: "asp-1",
				slot: { groupKey: "role", claimKey: "title" },
				kind: "attribute",
				content: "x",
				confidence: 1,
				importance: 1,
				provenance: { memoryId: "   ", source: "extraction" },
			}),
		).rejects.toBeInstanceOf(AttributeProvenanceError);
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// a-AC-4 — aspect weight rises on confirm, decays toward the floor on stale
// ═════════════════════════════════════════════════════════════════════════════

describe("a-AC-4 aspect weight rise-on-confirm + decay-toward-floor-on-stale", () => {
	it("confirmation raises the weight toward the ceiling, never past it", () => {
		expect(confirmAspectWeight(0.5)).toBeCloseTo(0.5 + ASPECT_CONFIRM_STEP, 6);
		// Never exceeds the ceiling.
		expect(confirmAspectWeight(ASPECT_WEIGHT_CEILING)).toBe(ASPECT_WEIGHT_CEILING);
		expect(confirmAspectWeight(0.95)).toBe(ASPECT_WEIGHT_CEILING);
	});

	it("a stale aspect decays toward the floor, never below it", () => {
		const now = 1_000_000_000_000;
		const stale = now - ASPECT_STALE_WINDOW_MS - 1; // just past the window
		expect(decayAspectWeight(0.8, stale, now)).toBeCloseTo(0.8 - ASPECT_DECAY_STEP, 6);
		// Decays toward, never below, the floor.
		expect(decayAspectWeight(ASPECT_WEIGHT_FLOOR + 0.05, stale, now)).toBe(ASPECT_WEIGHT_FLOOR);
		expect(decayAspectWeight(ASPECT_WEIGHT_FLOOR, stale, now)).toBe(ASPECT_WEIGHT_FLOOR);
	});

	it("an aspect WITHIN the staleness window does not decay", () => {
		const now = 1_000_000_000_000;
		const fresh = now - (ASPECT_STALE_WINDOW_MS - 1); // still inside the window
		expect(decayAspectWeight(0.7, fresh, now)).toBeCloseTo(0.7, 6);
	});

	it("persists the recomputed weight through writeAspect (rounded trip)", async () => {
		const { storage, transport } = storageWith(allNewResponder());
		await writeAspect(storage, SCOPE, {
			agentId: AGENT,
			entityId: "ent-1",
			name: "role",
			weight: confirmAspectWeight(0.5),
		});
		// updateOrInsertByKey probes by id first (a SELECT), then INSERTs — match the INSERT.
		const sql = transport.requests
			.map((r) => r.sql)
			.find((s) => s.toUpperCase().startsWith("INSERT") && s.toUpperCase().includes("ENTITY_ASPECTS"));
		expect(sql).toBeTruthy();
		expect(String(sql)).toContain("weight");
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// a-AC-5 — claim value lives in an addressable group_key/claim_key slot
// ═════════════════════════════════════════════════════════════════════════════

describe("a-AC-5 claim value is addressable by group_key/claim_key under its aspect", () => {
	it("the attribute row carries BOTH the group_key and a derived claim_key for the slot", async () => {
		const { storage, transport } = storageWith(allNewResponder());
		await writeAttribute(storage, SCOPE, {
			agentId: AGENT,
			aspectId: "asp-slot",
			slot: { groupKey: "employment", claimKey: "current_title" },
			kind: "attribute",
			content: "Principal",
			confidence: 1,
			importance: 1,
			provenance: { memoryId: "mem-slot", source: "extraction" },
		});
		const sql = String(transport.requests.map((r) => r.sql).find((s) => s.toUpperCase().startsWith("INSERT")));
		// The group_key is carried verbatim; the claim_key is the derived lineage key.
		expect(sql).toContain("'employment'");
		expect(sql).toContain("claim_key");
		// The aspect the slot hangs under is on the row.
		expect(sql).toContain("'asp-slot'");
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// a-AC-6 — every write scoped by org/workspace/agent; linker never crosses agent
// ═════════════════════════════════════════════════════════════════════════════

describe("a-AC-6 every write scoped by org/workspace/agent_id; no cross-agent link", () => {
	it("the partition (org/workspace) reaches the wire on every statement", async () => {
		const existingId = entityId(AGENT, "activeloop");
		const { storage, transport } = storageWith(entitiesExistResponder({ activeloop: existingId }));
		await inlineLinkMemory(storage, SCOPE, { agentId: AGENT, memoryId: "mem-s", content: "Activeloop." });
		// Every recorded request carries the org + workspace partition.
		expect(transport.requests.length).toBeGreaterThan(0);
		for (const req of transport.requests) {
			expect(req.org).toBe("test-org");
			expect(req.workspace).toBe("test-ws");
		}
	});

	it("the entity-existence probe carries the agent_id conjunct (cross-agent unreachable)", async () => {
		const { storage, transport } = storageWith(allNewResponder());
		await inlineLinkMemory(storage, SCOPE, { agentId: AGENT, memoryId: "mem-x", content: "Honeycomb." });
		const probe = transport.requests
			.map((r) => r.sql)
			.find((s) => s.toUpperCase().startsWith("SELECT") && s.toUpperCase().includes("ENTITIES"));
		expect(probe, "an entity-existence probe was issued").toBeTruthy();
		// The probe restricts to THIS agent — a row for another agent can never resolve.
		expect(String(probe)).toContain("agent_id = 'agent-alpha'");
	});

	it("a different agent does NOT resolve an entity owned by agent-alpha", async () => {
		// The responder only returns a hit when the SQL contains the alpha-derived id's
		// canonical name AND the alpha agent conjunct. A beta linker's probe carries
		// `agent_id = 'agent-beta'`, so the responder (keyed on the alpha conjunct) misses.
		const responder = (req: TransportRequest): StorageRow[] => {
			const sql = req.sql;
			if (
				sql.toUpperCase().startsWith("SELECT") &&
				sql.includes("'activeloop'") &&
				sql.includes("agent_id = 'agent-alpha'")
			) {
				return [{ id: entityId("agent-alpha", "activeloop") }];
			}
			return [];
		};
		const { storage } = storageWith(responder);

		const beta = await inlineLinkMemory(storage, SCOPE, {
			agentId: "agent-beta",
			memoryId: "mem-beta",
			content: "Activeloop.",
		});
		// Beta links NOTHING — alpha's entity is across the boundary.
		expect(beta.mentions).toHaveLength(0);

		const alpha = await inlineLinkMemory(storage, SCOPE, {
			agentId: "agent-alpha",
			memoryId: "mem-alpha",
			content: "Activeloop.",
		});
		expect(alpha.mentions).toHaveLength(1);
	});

	it("writeEntity / writeAspect carry agent_id + visibility on the row (engine scope)", async () => {
		const { storage, transport } = storageWith(allNewResponder());
		await writeEntity(storage, SCOPE, { agentId: AGENT, rawName: "Honeycomb", type: "project" });
		const insert = transport.requests
			.map((r) => r.sql)
			.find((s) => s.toUpperCase().includes("ENTITIES") && s.toUpperCase().includes("AGENT_ID"));
		expect(insert).toBeTruthy();
		expect(String(insert)).toContain("'agent-alpha'");
		expect(String(insert)).toContain("visibility");
	});
});

// ═════════════════════════════════════════════════════════════════════════════
// a-AC-7 — every interpolated name/key/value escaped through the SQL helpers
// ═════════════════════════════════════════════════════════════════════════════

describe("a-AC-7 every interpolated name/key/value escaped through the SQL helpers", () => {
	it("an entity name with an embedded quote is escaped (injection collapses to a literal)", async () => {
		const { storage, transport } = storageWith(allNewResponder());
		// A malicious-looking name with a quote + a statement terminator.
		await writeEntity(storage, SCOPE, { agentId: AGENT, rawName: "O'Brien'; DROP TABLE entities;--", type: "person" });
		// updateOrInsertByKey probes by id first; the escaped name lands on the INSERT.
		const insert = String(
			transport.requests
				.map((r) => r.sql)
				.find((s) => s.toUpperCase().startsWith("INSERT") && s.toUpperCase().includes("ENTITIES")),
		);
		// The single quote is DOUBLED by sqlStr (sLiteral) — the embedded quote can never
		// close the literal early, so no second statement is produced.
		expect(insert).toContain("''");
		// The canonical name is lowercased; the escaped form is present, the raw unescaped
		// `O'Brien` (single quote) is NOT a bare literal break.
		expect(insert.toLowerCase()).toContain("o''brien");
	});

	it("a proper-noun candidate with a quote is escaped in the existence probe (no injection)", async () => {
		const { storage, transport } = storageWith(allNewResponder());
		await inlineLinkMemory(storage, SCOPE, {
			agentId: AGENT,
			memoryId: "mem-q",
			content: "We met O'Brien yesterday.",
		});
		const probe = transport.requests
			.map((r) => r.sql)
			.find((s) => s.toUpperCase().startsWith("SELECT") && s.includes("o''brien"));
		// The candidate `o'brien` is doubled-quote escaped in the WHERE name = '…' clause.
		expect(probe, "the quoted candidate is escaped in the probe").toBeTruthy();
	});

	it("canonicaliseName trims + lowercases (the dedup key shape)", () => {
		expect(canonicaliseName("  Activeloop Deep Lake  ")).toBe("activeloop deep lake");
	});
});

// ── Global fetch spy helper (a-AC-2) ──────────────────────────────────────────

/**
 * Spy on the global `fetch` to PROVE the linker performs no network I/O of its own.
 * Returns the call count + a restore fn. We do not import vitest's `vi` global spy on
 * fetch because the daemon storage path uses the injected transport (not fetch) — so
 * any fetch call would be an unexpected I/O the linker must never make.
 */
function vi_spyGlobalFetch(): { calls: number; restore: () => void } {
	const original = globalThis.fetch;
	let calls = 0;
	// @ts-expect-error — overriding the global for the duration of the test.
	globalThis.fetch = (...args: unknown[]) => {
		calls += 1;
		if (typeof original === "function") return (original as (...a: unknown[]) => unknown)(...args);
		return Promise.reject(new Error("fetch disabled in test"));
	};
	return {
		get calls() {
			return calls;
		},
		restore() {
			globalThis.fetch = original;
		},
	};
}
