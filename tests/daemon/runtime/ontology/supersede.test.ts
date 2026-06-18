/**
 * PRD-008 Wave 1 — the shared supersede-by-version-bump helper (`supersede.ts`).
 *
 * The supersede core is implemented FULLY in Wave 1 (008b b-AC-1 and 008c c-AC-4
 * both reuse it), so it is tested here against the fake transport. These tests pin
 * the CONTRACT the two Wave-2 Bees depend on: append a new version, mark the prior
 * sibling, never an in-place content mutate, scope + escaping on every statement.
 *
 * Mapped ACs (the supersede helper is the mechanic behind both):
 *   b-AC-1 new attr in same slot → prior marked superseded via version-bump append.
 *   b-AC-2 no in-place mutate; full version history on disk.
 *   c-AC-4 supersede op is append-only version-bumped, not in-place.
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
	attributeVersionId,
	slotClaimKey,
	supersedeClaim,
} from "../../../../src/daemon/runtime/ontology/supersede.js";
import {
	FakeDeepLakeTransport,
	fakeCredentialRecord,
	stubProvider,
} from "../../../helpers/fake-deeplake.js";

const SCOPE: QueryScope = { org: "o", workspace: "w" };

function storageWith(responder: (req: TransportRequest) => StorageRow[]): {
	storage: StorageQuery;
	transport: FakeDeepLakeTransport;
} {
	const transport = new FakeDeepLakeTransport(responder);
	const storage = createStorageClient({ provider: stubProvider(fakeCredentialRecord()), transport });
	return { storage, transport };
}

const NEW_ATTR = {
	kind: "attribute" as const,
	content: "new value",
	confidence: 0.9,
	importance: 0.5,
	provenance: { memoryId: "mem-1", source: "extraction" },
	agentId: "agent-a",
};

describe("supersedeClaim appends a new version + APPEND-marks the prior sibling (b-AC-1 / c-AC-4)", () => {
	it("APPENDs a status='active' version-bumped row and APPEND-MARKs the prior superseded", async () => {
		const priorId = "attr_prior";
		// Responder: the prior-active read, max-version read, and prior current-state read
		// all return the prior row (version 1, active).
		const responder = (req: TransportRequest): StorageRow[] => {
			const upper = req.sql.toUpperCase();
			if (upper.startsWith("SELECT") && upper.includes("ENTITY_ATTRIBUTES")) {
				return [{ id: priorId, version: 1, status: "active", content: "old value" }];
			}
			return [];
		};
		const { storage, transport } = storageWith(responder);

		const result = await supersedeClaim(storage, SCOPE, {
			entityId: "ent-1",
			aspectId: "asp-1",
			groupKey: "role",
			claimKey: "title",
			newAttribute: NEW_ATTR,
		});

		// The new version is N+1 = 2; its id is deterministic off the slot + version.
		expect(result.version).toBe(2);
		expect(result.supersededId).toBe(priorId);
		expect(result.newId).toBe(
			attributeVersionId("asp-1", { groupKey: "role", claimKey: "title" }, 2),
		);

		// The path is APPEND-ONLY: ZERO in-place UPDATEs (the live-correct mechanism — a
		// by-id SET does not converge on the real backend).
		const updates = transport.requests.filter((r) => r.sql.toUpperCase().startsWith("UPDATE"));
		expect(updates, "supersession issues NO in-place UPDATE").toHaveLength(0);

		const inserts = transport.requests.map((r) => r.sql).filter((s) => s.toUpperCase().startsWith("INSERT"));
		// 1. APPEND the new claim: an INSERT carrying version + status='active' + the new id.
		const activeInsert = inserts.find((s) => s.includes("'active'"));
		expect(activeInsert, "a version-bumped active INSERT was issued").toBeTruthy();
		expect(String(activeInsert)).toContain(`'${result.newId}'`);
		expect(String(activeInsert)).toContain("version");
		// 2. APPEND-MARK the prior: a SEPARATE INSERT carrying status='superseded',
		//    superseded_by=newId, and the SAME id as the prior row (its highest version
		//    now reads superseded — never an UPDATE).
		const markInsert = inserts.find((s) => s.includes("'superseded'"));
		expect(markInsert, "the prior sibling was append-marked superseded").toBeTruthy();
		expect(String(markInsert)).toContain("superseded_by");
		expect(String(markInsert)).toContain(`'${priorId}'`); // same id as the prior
		expect(String(markInsert)).toContain(`'${result.newId}'`); // superseded_by → successor
	});

	it("the mark is a SEPARATE prior-id append — the new claim row is never mutated (b-AC-2)", async () => {
		const priorId = "attr_prior_2";
		const responder = (req: TransportRequest): StorageRow[] => {
			const upper = req.sql.toUpperCase();
			if (upper.startsWith("SELECT") && upper.includes("ENTITY_ATTRIBUTES")) {
				return [{ id: priorId, version: 3, status: "active", content: "prior content" }];
			}
			return [];
		};
		const { storage, transport } = storageWith(responder);

		const result = await supersedeClaim(storage, SCOPE, {
			entityId: "ent-1",
			aspectId: "asp-1",
			groupKey: "g",
			claimKey: "c",
			newAttribute: NEW_ATTR,
			priorId, // caller-supplied: skips the prior-active read entirely
		});

		// NO in-place UPDATE anywhere — the prior row's original version stays INTACT on
		// disk; the mark is a new prior-id version, so full history is preserved (b-AC-2).
		const updates = transport.requests.filter((r) => r.sql.toUpperCase().startsWith("UPDATE"));
		expect(updates, "no in-place UPDATE — append-only history").toHaveLength(0);

		// Exactly TWO inserts: the new active claim and the prior-id superseded mark.
		const inserts = transport.requests.filter((r) => r.sql.toUpperCase().startsWith("INSERT"));
		expect(inserts).toHaveLength(2);
		const markInsert = String(inserts.find((r) => r.sql.includes("'superseded'"))?.sql);
		// The mark carries the PRIOR id (same id, bumped version) and points at the successor.
		expect(markInsert).toContain(`'${priorId}'`);
		expect(markInsert).toContain(`superseded_by`);
		expect(markInsert).toContain(`'${result.newId}'`);
		// The mark APPEND-marks the prior id at version 4 (prior current version 3 + 1),
		// so the prior id's highest version reads superseded while v3 stays active on disk.
		expect(markInsert).toContain(", 4");
	});

	it("supersedes NOTHING when there is no prior sibling (first claim in the slot)", async () => {
		// All reads empty → no prior row → append only, mark nothing.
		const { storage, transport } = storageWith(() => []);
		const result = await supersedeClaim(storage, SCOPE, {
			entityId: "ent-1",
			aspectId: "asp-1",
			groupKey: "g",
			claimKey: "c",
			newAttribute: NEW_ATTR,
		});
		expect(result.supersededId).toBeNull();
		expect(result.version).toBe(1); // first version
		// One INSERT (the v1 active claim); no superseded mark, no UPDATE.
		const inserts = transport.requests.filter((r) => r.sql.toUpperCase().startsWith("INSERT"));
		expect(inserts).toHaveLength(1);
		expect(inserts.some((r) => r.sql.includes("'superseded'"))).toBe(false);
		const updates = transport.requests.filter((r) => r.sql.toUpperCase().startsWith("UPDATE"));
		expect(updates).toHaveLength(0);
	});

	it("every statement carries the org/workspace partition (scope on the wire)", async () => {
		const { storage, transport } = storageWith(() => []);
		await supersedeClaim(storage, SCOPE, {
			entityId: "e",
			aspectId: "a",
			groupKey: "g",
			claimKey: "c",
			newAttribute: NEW_ATTR,
		});
		expect(transport.requests.length).toBeGreaterThan(0);
		for (const req of transport.requests) {
			expect(req.org).toBe("o");
			expect(req.workspace).toBe("w");
		}
	});
});

describe("slot key derivation is deterministic + stable", () => {
	it("the same slot resolves the same claim_key; different slots differ", () => {
		const a = slotClaimKey("asp-1", { groupKey: "role", claimKey: "title" });
		const b = slotClaimKey("asp-1", { groupKey: "role", claimKey: "title" });
		const c = slotClaimKey("asp-1", { groupKey: "role", claimKey: "level" });
		expect(a).toBe(b);
		expect(a).not.toBe(c);
		expect(a.startsWith("ck_")).toBe(true);
	});

	it("the version id changes per version but is stable per (slot, version)", () => {
		const slot = { groupKey: "g", claimKey: "c" };
		expect(attributeVersionId("a", slot, 1)).toBe(attributeVersionId("a", slot, 1));
		expect(attributeVersionId("a", slot, 1)).not.toBe(attributeVersionId("a", slot, 2));
	});
});
