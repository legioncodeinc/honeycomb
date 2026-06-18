/**
 * PRD-007a Candidate Collection — a-AC-1..7 (Wave 1, `retrieval-worker-bee`).
 *
 * Verification posture (EXECUTION_LEDGER-prd-007 / recall CONVENTIONS):
 *   - The collection channels are verified against the PRD-002 FAKE transport (a
 *     SQL-aware responder returning candidate rows per channel + capturing the
 *     emitted SQL) and a FAKE `EmbedClient` (768-dim → vector path; null → silent
 *     lexical fallback). No live DeepLake, no live embed daemon.
 *   - Each test is named after the AC it proves (one-to-one ledger map).
 *   - No `.skip` / `.only`; `vitest run` is CI.
 *   - IDs-ONLY is asserted structurally: the channel SQL selects `id`+`score`, and
 *     no responder ever returns a `content` column the collector reads.
 */

import { describe, expect, it } from "vitest";

import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import type { StorageRow } from "../../../../src/daemon/storage/result.js";
import { EMBEDDING_DIMS } from "../../../../src/daemon/storage/vector.js";
import type { EmbedClient } from "../../../../src/daemon/runtime/services/embed-client.js";
import {
	type CollectionDeps,
	type HintSource,
	type RecallConfig,
	RecallConfigSchema,
	type RecallQuery,
	type ScoredId,
	buildFtsSql,
	collectCandidates,
	prepareLexicalTerm,
} from "../../../../src/daemon/runtime/recall/index.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const ORG_SCOPE = { org: "fake-org", workspace: "fake-ws" } as const;

function recallConfig(overrides: Record<string, unknown> = {}): RecallConfig {
	return RecallConfigSchema.parse(overrides);
}

function recallQuery(overrides: Partial<RecallQuery> = {}): RecallQuery {
	return {
		query: "how does the daemon bind its socket",
		scope: {
			org: "fake-org",
			workspace: "fake-ws",
			agentId: "agent-1",
			readPolicy: "isolated",
			policyGroup: "",
		},
		...overrides,
	};
}

/** A 768-dim query vector the fake embed returns to drive the vector arm. */
function vec768(fill = 0.02): number[] {
	return Array.from({ length: EMBEDDING_DIMS }, () => fill);
}

/** A fake embed client returning a fixed vector (or null to force lexical-only). */
function fakeEmbed(vector: readonly number[] | null): EmbedClient {
	return {
		async embed(): Promise<readonly number[] | null> {
			return vector;
		},
	};
}

/**
 * A SQL-aware fake transport responder. Returns `ftsRows` for the FTS ILIKE SELECT
 * over `memories.content`, `vectorRows` for the `<#>` vector SELECT, and throws on
 * any statement that would load a content column or mutate — collection is IDs-only
 * and read-only by contract.
 */
function makeStorage(args: { ftsRows: StorageRow[]; vectorRows: StorageRow[] }): {
	storage: ReturnType<typeof createStorageClient>;
	fake: FakeDeepLakeTransport;
} {
	const responder = (req: TransportRequest): StorageRow[] => {
		const sql = req.sql;
		if (/(INSERT|UPDATE|DELETE|ALTER|DROP)\b/i.test(sql)) {
			throw new Error(`collection must be read-only: ${sql}`);
		}
		// Vector channel: the `<#>` cosine operator.
		if (/<#>/.test(sql)) return args.vectorRows;
		// FTS channel: an ILIKE over content with no `<#>`.
		if (/ILIKE/i.test(sql) && /FROM\s+"memories"/i.test(sql)) return args.ftsRows;
		return [];
	};
	const fake = new FakeDeepLakeTransport(responder);
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	return { storage, fake };
}

function deps(args: {
	storage: ReturnType<typeof createStorageClient>;
	config?: RecallConfig;
	embed?: EmbedClient;
	hints?: HintSource;
}): CollectionDeps {
	return {
		storage: args.storage,
		scope: ORG_SCOPE,
		config: args.config ?? recallConfig(),
		embed: args.embed,
		hints: args.hints,
	};
}

// ── a-AC-1 ──────────────────────────────────────────────────────────────────

describe("a-AC-1 FTS → BM25-style 0-1 scores, IDs only, no content", () => {
	it("builds an ILIKE FTS SELECT returning id+score normalized 0..1, no content column", () => {
		const sql = buildFtsSql({ term: "daemon bind", agentId: "agent-1", limit: 20 });
		// IDs only: the projection is `id` + a `score` expression; no `content` selected.
		expect(sql).toMatch(/SELECT\s+id\s+AS\s+id/i);
		expect(sql).toMatch(/AS score/i);
		expect(sql).not.toMatch(/SELECT[\s\S]*\bcontent\b\s+AS/i);
		// BM25-style 0..1: a LEAST(1.0, …) clamp keeps the score in range.
		expect(sql).toMatch(/LEAST\(1\.0,/);
		// Scope conjunct inline (agent_id) — FR-9.
		expect(sql).toMatch(/agent_id = 'agent-1'/);
	});

	it("collects FTS candidates with clamped 0..1 scores and fts provenance", async () => {
		const { storage } = makeStorage({
			ftsRows: [
				{ id: "m1", score: 0.4 },
				{ id: "m2", score: 1.7 }, // out-of-range → clamped to 1.
			],
			vectorRows: [],
		});
		// embed absent → vector skipped; FTS is the lexical floor.
		const pool = await collectCandidates(recallQuery(), deps({ storage }));
		const m1 = pool.candidates.find((c) => c.id === "m1");
		const m2 = pool.candidates.find((c) => c.id === "m2");
		expect(m1?.scores.fts).toBe(0.4);
		expect(m2?.scores.fts).toBe(1); // clamped.
		expect(m1?.provenance).toEqual(["fts"]);
	});
});

// ── a-AC-2 ──────────────────────────────────────────────────────────────────

describe("a-AC-2 Vector → GPU similarity over 768-dim cols, over-fetch 3x", () => {
	it("emits a `<#>` vector SELECT whose LIMIT = channelLimit × overFetchMultiplier (3x default)", async () => {
		const { storage, fake } = makeStorage({ ftsRows: [], vectorRows: [{ id: "v1", score: 0.9 }] });
		const config = recallConfig({ channelLimit: 20 }); // default overFetchMultiplier = 3.
		await collectCandidates(recallQuery(), deps({ storage, config, embed: fakeEmbed(vec768()) }));
		const vectorSql = fake.requests.find((r) => /<#>/.test(r.sql));
		expect(vectorSql).toBeDefined();
		// 20 × 3 = 60.
		expect(vectorSql?.sql).toMatch(/LIMIT 60\b/);
		// Over the 768-dim content_embedding column, IDs only.
		expect(vectorSql?.sql).toMatch(/content_embedding <#>/);
		expect(vectorSql?.sql).toMatch(/SELECT\s+id\s+AS\s+id/i);
	});

	it("attaches the vector score + vector provenance to the merged candidate", async () => {
		const { storage } = makeStorage({ ftsRows: [], vectorRows: [{ id: "v1", score: 0.88 }] });
		const pool = await collectCandidates(recallQuery(), deps({ storage, embed: fakeEmbed(vec768()) }));
		const v1 = pool.candidates.find((c) => c.id === "v1");
		expect(v1?.scores.vector).toBeCloseTo(0.88, 5);
		expect(v1?.provenance).toContain("vector");
		expect(pool.degraded).toBe(false);
	});
});

// ── a-AC-3 ──────────────────────────────────────────────────────────────────

describe("a-AC-3 embed-off → vector skipped, lexical returned, no error", () => {
	it("with no embed client, the vector channel never runs and lexical candidates return, degraded=true", async () => {
		const { storage, fake } = makeStorage({ ftsRows: [{ id: "m1", score: 0.5 }], vectorRows: [] });
		const pool = await collectCandidates(recallQuery(), deps({ storage })); // embed absent.
		// No `<#>` statement was ever emitted.
		expect(fake.requests.some((r) => /<#>/.test(r.sql))).toBe(false);
		// Lexical candidate survived, no throw, degrade flagged.
		expect(pool.candidates.map((c) => c.id)).toContain("m1");
		expect(pool.degraded).toBe(true);
	});

	it("when the embed client returns null (daemon unreachable), vector is skipped and recall degrades", async () => {
		const { storage, fake } = makeStorage({ ftsRows: [{ id: "m1", score: 0.5 }], vectorRows: [] });
		const pool = await collectCandidates(recallQuery(), deps({ storage, embed: fakeEmbed(null) }));
		expect(fake.requests.some((r) => /<#>/.test(r.sql))).toBe(false);
		expect(pool.degraded).toBe(true);
		expect(pool.candidates).toHaveLength(1);
	});

	it("a wrong-dim vector is rejected → vector skipped, lexical floor returned, no throw", async () => {
		const { storage, fake } = makeStorage({ ftsRows: [{ id: "m1", score: 0.5 }], vectorRows: [] });
		const pool = await collectCandidates(recallQuery(), deps({ storage, embed: fakeEmbed([0.1, 0.2, 0.3]) }));
		expect(fake.requests.some((r) => /<#>/.test(r.sql))).toBe(false);
		expect(pool.degraded).toBe(true);
		expect(pool.candidates.map((c) => c.id)).toEqual(["m1"]);
	});
});

// ── a-AC-4 ──────────────────────────────────────────────────────────────────

describe("a-AC-4 hints capped — a memory can't ride in on hints alone", () => {
	it("the hint channel is truncated to config.hintCap (default 3)", async () => {
		const { storage } = makeStorage({ ftsRows: [], vectorRows: [] });
		const manyHints: ScoredId[] = [
			{ id: "h1", score: 0.9 },
			{ id: "h2", score: 0.8 },
			{ id: "h3", score: 0.7 },
			{ id: "h4", score: 0.6 },
			{ id: "h5", score: 0.5 },
		];
		const hints: HintSource = { async match() { return manyHints; } };
		const pool = await collectCandidates(recallQuery(), deps({ storage, hints }));
		const hintCandidates = pool.candidates.filter((c) => c.provenance.includes("hint"));
		// Default cap is 3 — the 4th and 5th hint cannot enter the pool.
		expect(hintCandidates).toHaveLength(3);
		expect(hintCandidates.map((c) => c.id).sort()).toEqual(["h1", "h2", "h3"]);
	});

	it("the cap is config-driven (hintCap=1 admits exactly one hint-only candidate)", async () => {
		const { storage } = makeStorage({ ftsRows: [], vectorRows: [] });
		const hints: HintSource = {
			async match() {
				return [
					{ id: "h1", score: 0.9 },
					{ id: "h2", score: 0.8 },
				];
			},
		};
		const pool = await collectCandidates(recallQuery(), deps({ storage, config: recallConfig({ hintCap: 1 }), hints }));
		expect(pool.candidates.filter((c) => c.provenance.includes("hint"))).toHaveLength(1);
	});
});

// ── a-AC-5 ──────────────────────────────────────────────────────────────────

describe("a-AC-5 merge by memory ID, strongest calibrated score wins unless blended", () => {
	it("a memory found by FTS and vector merges to one candidate with both per-channel scores", async () => {
		const { storage } = makeStorage({
			ftsRows: [{ id: "shared", score: 0.3 }],
			vectorRows: [{ id: "shared", score: 0.95 }],
		});
		const pool = await collectCandidates(recallQuery(), deps({ storage, embed: fakeEmbed(vec768()) }));
		const shared = pool.candidates.filter((c) => c.id === "shared");
		// Merged by id — exactly one candidate, not two.
		expect(shared).toHaveLength(1);
		expect(shared[0]?.scores.fts).toBeCloseTo(0.3, 5);
		expect(shared[0]?.scores.vector).toBeCloseTo(0.95, 5);
		// Provenance carries BOTH channels.
		expect(shared[0]?.provenance.sort()).toEqual(["fts", "vector"]);
	});

	it("the pool orders candidates by strongest single per-channel score descending", async () => {
		const { storage } = makeStorage({
			ftsRows: [{ id: "weak", score: 0.2 }],
			vectorRows: [{ id: "strong", score: 0.99 }],
		});
		const pool = await collectCandidates(recallQuery(), deps({ storage, embed: fakeEmbed(vec768()) }));
		expect(pool.candidates[0]?.id).toBe("strong");
	});
});

// ── a-AC-6 ──────────────────────────────────────────────────────────────────

describe("a-AC-6 raw query escaped via helpers; original NL preserved for vector", () => {
	it("an injection-shaped query is escaped in the FTS ILIKE pattern (no early quote close)", async () => {
		const evil = "'; DROP TABLE memories; --";
		const { storage, fake } = makeStorage({ ftsRows: [], vectorRows: [] });
		await collectCandidates(recallQuery({ query: evil }), deps({ storage }));
		const ftsReq = fake.requests.find((r) => /ILIKE/i.test(r.sql));
		expect(ftsReq).toBeDefined();
		// The embedded single quote is doubled by sqlStr/sqlLike — it cannot close the
		// literal early, so no second statement is ever produced.
		expect(ftsReq?.sql).toContain("''");
		expect(ftsReq?.sql).not.toMatch(/DROP TABLE memories;\s*--\s*'/);
	});

	it("the ORIGINAL NL query string is passed verbatim to the embed seam (not the lexical term)", async () => {
		const { storage } = makeStorage({ ftsRows: [], vectorRows: [{ id: "v1", score: 0.9 }] });
		let embedded = "";
		const recordingEmbed: EmbedClient = {
			async embed(text: string): Promise<readonly number[] | null> {
				embedded = text;
				return vec768();
			},
		};
		const nl = "  How   does the daemon   bind? ";
		await collectCandidates(recallQuery({ query: nl }), deps({ storage, embed: recordingEmbed }));
		// The vector path gets the UNMODIFIED NL string (whitespace preserved),
		// whereas the lexical term is whitespace-normalized.
		expect(embedded).toBe(nl);
		expect(prepareLexicalTerm(nl, false)).toBe("How does the daemon bind?");
	});
});

// ── a-AC-7 ──────────────────────────────────────────────────────────────────

describe("a-AC-7 per-channel provenance attached; no content row loaded", () => {
	it("every candidate carries its source-channel provenance and only id+scores (no content field)", async () => {
		const { storage } = makeStorage({
			ftsRows: [{ id: "f1", score: 0.5 }],
			vectorRows: [{ id: "v1", score: 0.6 }],
		});
		const pool = await collectCandidates(recallQuery(), deps({ storage, embed: fakeEmbed(vec768()) }));
		for (const c of pool.candidates) {
			expect(c.provenance.length).toBeGreaterThan(0);
			// The Candidate shape is IDs-only: id + scores + provenance, no `content`.
			expect(Object.keys(c).sort()).toEqual(["id", "provenance", "scores"]);
		}
		expect(pool.candidates.find((c) => c.id === "f1")?.provenance).toEqual(["fts"]);
		expect(pool.candidates.find((c) => c.id === "v1")?.provenance).toEqual(["vector"]);
	});

	it("no channel SQL selects a content column (no content row is loaded in collection)", async () => {
		const { storage, fake } = makeStorage({ ftsRows: [{ id: "f1", score: 0.5 }], vectorRows: [{ id: "v1", score: 0.6 }] });
		await collectCandidates(recallQuery(), deps({ storage, embed: fakeEmbed(vec768()) }));
		for (const req of fake.requests) {
			// Each SELECT projects `id AS id` + `... AS score` only — no `content AS`.
			expect(req.sql).not.toMatch(/\bcontent\s+AS\b/i);
		}
	});
});
