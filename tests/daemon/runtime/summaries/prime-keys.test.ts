/**
 * PRD-046b Tier-1 KEY READ path — proves b-AC-4 (cheap to read: a prime is a SQL skim,
 * NO generation at read time) + b-AC-5 (both sources + scope), named + unskipped.
 *
 * Verification posture (no live DeepLake): the real `skimPrimeKeys` runs over a
 * `FakeDeepLakeTransport` that records every statement. The proof of b-AC-4 is structural:
 * the ONLY statements the skim emits are SELECTs (no INSERT/UPDATE, and there is no gate
 * seam on the read path at all — the reader takes a `StorageQuery`, never a `SummaryGenCli`).
 */

import { describe, expect, it } from "vitest";

import { createStorageClient, type QueryScope } from "../../../../src/daemon/storage/index.js";
import { TransportError, type TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";
import {
	buildDurableKeySkimSql,
	buildEpisodicKeySkimSql,
	resolveKeySkimLimit,
	skimPrimeKeys,
} from "../../../../src/daemon/runtime/summaries/index.js";

const SCOPE: QueryScope = { org: "o1", workspace: "ws1" };

function storage(responder: (req: TransportRequest) => Record<string, unknown>[] = () => []) {
	const transport = new FakeDeepLakeTransport(responder);
	return { storage: createStorageClient({ transport, provider: stubProvider(fakeCredentialRecord()) }), transport };
}

describe("PRD-046b b-AC-4 — assembling a prime is a pure SQL skim (NO generation at read time)", () => {
	it("skimPrimeKeys issues ONLY read SELECTs (no INSERT/UPDATE, no gate) and returns the stored keys", async () => {
		const { storage: s, transport } = storage((req) => {
			if (/FROM\s+"memory"/i.test(req.sql)) {
				return [{ key: "CI pack-step timeout — fixed via a retry-on-429 wrapper", path: "/summaries/alice/s1.md" }];
			}
			if (/FROM\s+"memories"/i.test(req.sql)) {
				return [{ key: "DeepLake reads are eventually consistent — always poll to convergence", id: "mem-1", content: "..." }];
			}
			return [];
		});

		const keys = await skimPrimeKeys({ storage: s, scope: SCOPE });

		// Both sources contributed, each key carrying its resolvable ref (path / id).
		expect(keys).toHaveLength(2);
		const episodic = keys.find((k) => k.source === "episodic");
		const durable = keys.find((k) => k.source === "durable");
		expect(episodic?.ref).toBe("/summaries/alice/s1.md");
		expect(episodic?.key).toContain("retry-on-429");
		expect(durable?.ref).toBe("mem-1");
		expect(durable?.key).toContain("eventually consistent");

		// b-AC-4: EVERY statement the skim emitted is a SELECT. No INSERT, no UPDATE — and
		// there is NO gate/generation call on the read path (the reader has no gate seam).
		expect(transport.requests.length).toBeGreaterThan(0);
		for (const req of transport.requests) {
			expect(req.sql.trimStart().toUpperCase().startsWith("SELECT"), req.sql).toBe(true);
			// No mutation STATEMENT (matched as the verb + its object, not the substring "update"
			// inside `last_update_date`): no `INSERT INTO`, no `UPDATE "…" SET`, no `DELETE FROM`.
			expect(/\bINSERT\s+INTO\b|\bUPDATE\s+"[^"]+"\s+SET\b|\bDELETE\s+FROM\b/i.test(req.sql), req.sql).toBe(false);
		}
	});

	it("the durable skim falls back to `content` for an un-keyed legacy fact (still primeable)", async () => {
		const { storage: s } = storage((req) => {
			if (/FROM\s+"memories"/i.test(req.sql)) {
				return [{ key: "", id: "mem-legacy", content: "the legacy fact body with no derived key" }];
			}
			return [];
		});
		const keys = await skimPrimeKeys({ storage: s, scope: SCOPE });
		const durable = keys.find((k) => k.source === "durable");
		expect(durable?.key).toBe("the legacy fact body with no derived key");
	});

	it("PRD-046 durable-key: a KEYED fact surfaces its real `key`, NOT the `content` fallback", async () => {
		// A freshly stored fact now carries a derived durable key (the deferred 046b generator).
		// The prime must surface that sharp key, not fall through to the raw content body.
		const sharpKey = "DeepLake reads are eventually consistent — always poll to convergence";
		const rawContent = "DeepLake reads are eventually consistent so a single immediate read can see a stale segment; always poll to convergence before asserting.";
		const { storage: s } = storage((req) => {
			if (/FROM\s+"memories"/i.test(req.sql)) {
				return [{ key: sharpKey, id: "mem-keyed", content: rawContent }];
			}
			return [];
		});
		const keys = await skimPrimeKeys({ storage: s, scope: SCOPE });
		const durable = keys.find((k) => k.source === "durable");
		// The REAL key takes precedence — the prime lists the sharp headline, not the long content.
		expect(durable?.key).toBe(sharpKey);
		expect(durable?.key).not.toBe(rawContent);
	});
});

describe("PRD-046b b-AC-5 — both sources, scoped; the skim carries the tenant partition", () => {
	it("the skim runs both source reads under the per-request scope (org/workspace partition)", async () => {
		const { storage: s, transport } = storage(() => []);
		await skimPrimeKeys({ storage: s, scope: SCOPE });
		// Both the episodic (memory) and durable (memories) reads went out, each carrying the scope.
		expect(transport.requests.some((r) => /FROM\s+"memory"/i.test(r.sql))).toBe(true);
		expect(transport.requests.some((r) => /FROM\s+"memories"/i.test(r.sql))).toBe(true);
		for (const req of transport.requests) {
			expect(req.org).toBe(SCOPE.org);
			expect(req.workspace).toBe(SCOPE.workspace);
		}
	});

	it("the episodic skim SQL excludes the in-progress placeholder + empty keys, newest first", () => {
		const sql = buildEpisodicKeySkimSql(10);
		expect(sql).toMatch(/FROM\s+"memory"/);
		expect(sql).toMatch(/LIKE/);
		expect(sql).toContain("/summaries/");
		expect(sql).toMatch(/in progress/); // placeholder excluded
		expect(sql).toMatch(/ORDER BY\s+last_update_date\s+DESC/);
		expect(sql).toMatch(/LIMIT 10/);
	});

	it("the durable skim SQL excludes soft-deleted tombstones, newest first", () => {
		const sql = buildDurableKeySkimSql(5);
		expect(sql).toMatch(/FROM\s+"memories"/);
		expect(sql).toMatch(/is_deleted = 0/);
		expect(sql).toMatch(/ORDER BY\s+updated_at\s+DESC/);
		expect(sql).toMatch(/LIMIT 5/);
	});

	it("resolveKeySkimLimit clamps to [1, MAX] and defaults a bad value", () => {
		expect(resolveKeySkimLimit(undefined)).toBeGreaterThan(0);
		expect(resolveKeySkimLimit(0)).toBeGreaterThan(0);
		expect(resolveKeySkimLimit(-5)).toBeGreaterThan(0);
		expect(resolveKeySkimLimit(10_000)).toBeLessThanOrEqual(200);
		expect(resolveKeySkimLimit(7)).toBe(7);
	});

	it("a non-ok source read contributes no keys (fail-soft: a missing table yields an empty skim)", async () => {
		// Episodic read errors (missing table), durable returns one row → only the durable key.
		const { storage: s } = storage((req) => {
			if (/FROM\s+"memory"/i.test(req.sql)) throw new TransportError("query", 'relation "memory" does not exist', 404);
			if (/FROM\s+"memories"/i.test(req.sql)) return [{ key: "a durable key", id: "d1", content: "c" }];
			return [];
		});
		const keys = await skimPrimeKeys({ storage: s, scope: SCOPE });
		expect(keys).toHaveLength(1);
		expect(keys[0]?.source).toBe("durable");
	});
});
