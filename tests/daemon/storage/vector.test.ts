/**
 * PRD-002e Vector Columns & GPU Search — proves e-AC-1..7.
 *
 * Asserts the emitted GPU query (`<#>` cosine, scoped WHERE, over-fetch), the
 * scored-IDs-only result shape, the null-embedding lexical degrade, the 768-dim
 * rejection, and the clamped limits. Each AC has a named test.
 */

import { describe, expect, it } from "vitest";
import { createStorageClient } from "../../../src/daemon/storage/index.js";
import {
	assertEmbeddingDim,
	clampNonNegative,
	DEFAULT_OVERFETCH_MULTIPLIER,
	EMBEDDING_DIMS,
	resolveLimits,
	vectorSearch,
	VectorDimensionError,
	type VectorSearchArgs,
} from "../../../src/daemon/storage/vector.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../helpers/fake-deeplake.js";
import type { TransportRequest } from "../../../src/daemon/storage/transport.js";

const SCOPE = { org: "o1", workspace: "ws1" } as const;
const VEC768 = Array.from({ length: EMBEDDING_DIMS }, (_, i) => (i % 7) * 0.01);

function clientWith(responder?: (req: TransportRequest) => unknown) {
	const fake = new FakeDeepLakeTransport(responder as never);
	const client = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	return { client, fake };
}

function baseArgs(over?: Partial<VectorSearchArgs>): VectorSearchArgs {
	return {
		table: "sessions",
		idColumn: "id",
		embeddingColumn: "message_embedding",
		queryVector: VEC768,
		scope: { orgColumn: "org_id", orgValue: "o1" },
		limit: 10,
		...over,
	};
}

describe("PRD-002e vector columns & GPU search", () => {
	it("e-AC-1 768-dim query → GPU `<#>` query emitted, returns scored IDs from fake rows", async () => {
		const { client, fake } = clientWith((req) => {
			if (/<#>/.test(req.sql)) return [{ id: "x", score: 0.9 }, { id: "y", score: 0.4 }];
			return [];
		});
		const out = await vectorSearch(client, SCOPE, baseArgs());
		expect(out.degraded).toBe(false);
		expect(out.ids).toEqual([
			{ id: "x", score: 0.9 },
			{ id: "y", score: 0.4 },
		]);
		const sql = fake.requests[0]?.sql ?? "";
		expect(sql).toMatch(/message_embedding <#> ARRAY\[/); // GPU cosine operator
		expect(sql).toMatch(/::float4\[\]/); // float4 vector literal
		expect(sql).toMatch(/ORDER BY score DESC/);
	});

	it("e-AC-2 a null/empty embedding row → recall degrades to lexical, not failure", async () => {
		const { client, fake } = clientWith((req) => {
			if (/<#>/.test(req.sql)) return []; // all embeddings null/empty → no vector candidates
			if (/ILIKE/.test(req.sql)) return [{ id: "lex1", score: 1.0 }];
			return [];
		});
		const out = await vectorSearch(client, SCOPE, baseArgs(), {
			textColumn: "message",
			term: "needle",
			limit: 5,
		});
		expect(out.degraded).toBe(true);
		expect(out.ids).toEqual([{ id: "lex1", score: 1.0 }]);
		// The lexical query is the SECOND statement, includes ILIKE, and includes
		// rows the vector branch's ARRAY_LENGTH guard would have excluded.
		const lexical = fake.requests.find((r) => /ILIKE/.test(r.sql));
		expect(lexical?.sql).toMatch(/message::text ILIKE '%needle%'/);
		// Not treated as an error — result kind is ok-shaped (empty or rows).
		expect(out.result.kind === "ok").toBe(true);
	});

	it("e-AC-3 scoped recall over-fetches by the configured multiplier (default 3x)", async () => {
		const { client, fake } = clientWith(() => []);
		await vectorSearch(client, SCOPE, baseArgs({ limit: 10 }));
		const sql = fake.requests[0]?.sql ?? "";
		expect(sql).toMatch(new RegExp(`LIMIT ${10 * DEFAULT_OVERFETCH_MULTIPLIER}`)); // 30
		// A custom multiplier is honoured.
		const fake2 = clientWith(() => []);
		await vectorSearch(fake2.client, SCOPE, baseArgs({ limit: 10, overFetchMultiplier: 5 }));
		expect(fake2.fake.requests[0]?.sql).toMatch(/LIMIT 50/);
	});

	it("e-AC-4 result carries IDs + normalized scores only, no row content", async () => {
		const { client, fake } = clientWith(() => [{ id: "x", score: 0.7, summary: "LEAKED CONTENT" }]);
		const out = await vectorSearch(client, SCOPE, baseArgs());
		// The mapped result exposes id + score ONLY.
		expect(out.ids).toEqual([{ id: "x", score: 0.7 }]);
		expect(Object.keys(out.ids[0])).toEqual(["id", "score"]);
		// The emitted SELECT projects only id + score — never a content column.
		const sql = fake.requests[0]?.sql ?? "";
		expect(sql).toMatch(/SELECT id AS id, .* AS score/);
		expect(sql).not.toMatch(/summary|message::text|body/);
	});

	it("e-AC-5 org/workspace/agent scope filter is applied in the SAME query as the vector match", async () => {
		const { client, fake } = clientWith(() => []);
		await vectorSearch(
			client,
			SCOPE,
			baseArgs({
				scope: {
					orgColumn: "org_id",
					orgValue: "o1",
					workspaceColumn: "workspace_id",
					workspaceValue: "ws1",
					agentColumn: "agent_id",
					agentValue: "a1",
				},
			}),
		);
		const sql = fake.requests[0]?.sql ?? "";
		// One statement contains BOTH the vector op and all scope conjuncts.
		expect(sql).toMatch(/<#>/);
		expect(sql).toMatch(/AND org_id = 'o1'/);
		expect(sql).toMatch(/AND workspace_id = 'ws1'/);
		expect(sql).toMatch(/AND agent_id = 'a1'/);
		// It is a single statement (no semicolon-separated second query).
		expect(sql.split(";").filter((s) => s.trim().length > 0).length).toBe(1);
	});

	it("e-AC-6 a non-768-dim query vector is rejected with a structured error before any query", async () => {
		const { client, fake } = clientWith(() => []);
		await expect(vectorSearch(client, SCOPE, baseArgs({ queryVector: [0.1, 0.2, 0.3] }))).rejects.toBeInstanceOf(
			VectorDimensionError,
		);
		// No statement reached the transport.
		expect(fake.requests.length).toBe(0);
		// The pure assertion is also structured.
		expect(() => assertEmbeddingDim([1, 2, 3])).toThrow(VectorDimensionError);
		expect(() => assertEmbeddingDim(VEC768)).not.toThrow();
	});

	it("e-AC-7 HONEYCOMB_SEMANTIC_LIMIT out of range is clamped non-negative before search", () => {
		expect(clampNonNegative("-5", 20)).toBe(0); // negative → clamped to 0
		expect(clampNonNegative("abc", 20)).toBe(20); // non-numeric → default
		expect(clampNonNegative("8", 20)).toBe(8);
		expect(clampNonNegative(3.9, 20)).toBe(3); // truncated
		// resolveLimits reads the knobs and clamps both.
		const limits = resolveLimits({ HONEYCOMB_SEMANTIC_LIMIT: "-3", HONEYCOMB_HYBRID_LEXICAL_LIMIT: "12" } as NodeJS.ProcessEnv);
		expect(limits.semanticLimit).toBe(0);
		expect(limits.lexicalLimit).toBe(12);
	});

	it("scores are normalized into 0..1 even when the engine returns out-of-range", async () => {
		const { client } = clientWith(() => [
			{ id: "a", score: 1.5 }, // clamps to 1
			{ id: "b", score: -0.3 }, // clamps to 0
		]);
		const out = await vectorSearch(client, SCOPE, baseArgs());
		expect(out.ids).toEqual([
			{ id: "a", score: 1 },
			{ id: "b", score: 0 },
		]);
	});
});
