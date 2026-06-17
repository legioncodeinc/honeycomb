/**
 * Controlled-writes stage tests — PRD-006c (c-AC-1..6).
 *
 * The ONLY stage that mutates `memories`. These prove each acceptance criterion
 * against the PRD-002 fake transport (a `StorageClient` over `FakeDeepLakeTransport`)
 * and a FAKE embed client (the 005b seam). We assert on the EMITTED SQL — the
 * dedup SELECT-before-INSERT, the version-bumped INSERT, the scope, the escaping —
 * and on the embed-call ORDERING (prefetched before the write, c-AC-6).
 *
 * Posture (CONVENTIONS §5): in-process, no real network. Each test is named after
 * the AC it proves; no `.skip` / `.only`.
 */

import { describe, expect, it } from "vitest";

import {
	applyControlledWrite,
	type ControlledWriteHandlerDeps,
	type ControlledWriteInput,
	createControlledWriteHandler,
	detectContradiction,
	MEMORIES_VERSION_COLUMN,
} from "../../../../src/daemon/runtime/pipeline/controlled-writes.js";
import { type PipelineConfig, PipelineConfigSchema } from "../../../../src/daemon/runtime/pipeline/config.js";
import { type Proposal } from "../../../../src/daemon/runtime/pipeline/contracts.js";
import { type StageJob } from "../../../../src/daemon/runtime/pipeline/stage-worker.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import { contentHash } from "../../../../src/daemon/storage/catalog/index.js";
import { EMBEDDING_DIMS } from "../../../../src/daemon/storage/vector.js";
import type { QueryScope } from "../../../../src/daemon/storage/client.js";
import type { EmbedClient } from "../../../../src/daemon/runtime/services/embed-client.js";
import {
	FakeDeepLakeTransport,
	fakeCredentialRecord,
	type RecordedRequest,
	type Responder,
	stubProvider,
} from "../../../helpers/fake-deeplake.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";

// ── fixtures ──────────────────────────────────────────────────────────────────────

const SCOPE: QueryScope = { org: "org-1", workspace: "ws-1" };

/** Resolve a PipelineConfig from a partial raw record (clamped/defaulted by zod). */
function config(over: Record<string, unknown> = {}): PipelineConfig {
	return PipelineConfigSchema.parse(over);
}

/** A storage client over a SQL-aware fake transport (records every request). */
function storageWith(responder: Responder): {
	storage: ReturnType<typeof createStorageClient>;
	requests: RecordedRequest[];
} {
	const transport = new FakeDeepLakeTransport(responder);
	const storage = createStorageClient({
		transport,
		provider: stubProvider(fakeCredentialRecord({ org: SCOPE.org, workspace: SCOPE.workspace })),
	});
	return { storage, requests: transport.requests };
}

/** A 768-dim vector the fake embed client returns. */
function vec768(): number[] {
	return Array.from({ length: EMBEDDING_DIMS }, (_, i) => (i % 7) * 0.001);
}

/**
 * A recording fake embed client. `calls` captures each `embed(text)` and a
 * monotonic sequence number so a test can assert ordering against the SQL the
 * transport recorded.
 */
function recordingEmbed(vector: readonly number[] | null = vec768()): EmbedClient & {
	readonly calls: { text: string }[];
} {
	const calls: { text: string }[] = [];
	return {
		calls,
		async embed(text: string): Promise<readonly number[] | null> {
			calls.push({ text });
			return vector;
		},
	};
}

/** Build deps with a recording embed + a fixed id/clock so assertions are exact. */
function deps(
	storage: ReturnType<typeof createStorageClient>,
	cfg: PipelineConfig,
	embed: EmbedClient,
	over: Partial<ControlledWriteHandlerDeps> = {},
): ControlledWriteHandlerDeps {
	return {
		storage,
		config: cfg,
		embed,
		now: () => new Date("2026-06-17T00:00:00.000Z"),
		newId: () => "mem_fixed_id",
		...over,
	};
}

function addProposal(over: Partial<Proposal> = {}): Proposal {
	return { action: "add", confidence: 0.9, reason: "", ...over };
}

function input(over: Partial<ControlledWriteInput> = {}): ControlledWriteInput {
	return {
		proposal: addProposal(),
		content: "TypeScript is the project language",
		normalizedContent: "typescript is the project language",
		factConfidence: 0.9,
		...over,
	};
}

/** A responder that returns no rows for the dedup probe + the version SELECT. */
const noRows: Responder = () => [];

/** Is this SQL the dedup probe (`content_hash = ...`)? */
function isDedupProbe(sql: string): boolean {
	return /content_hash\s*=/.test(sql);
}

/** Is this SQL the version-read SELECT (`SELECT version ... ORDER BY version`)? */
function isVersionRead(sql: string): boolean {
	return /SELECT\s+version\b/i.test(sql) && /ORDER\s+BY\s+version/i.test(sql);
}

/** Is this SQL the memories INSERT? */
function isInsert(sql: string): boolean {
	return /INSERT\s+INTO\s+"memories"/i.test(sql);
}

// ── c-AC-1 ──────────────────────────────────────────────────────────────────────

describe("c-AC-1: ADD gated by confidence + non-empty + hash-not-present", () => {
	it("c-AC-1 applies an ADD when confidence clears threshold, content non-empty, hash absent", async () => {
		const { storage, requests } = storageWith(noRows);
		const embed = recordingEmbed();
		const out = await applyControlledWrite(input(), SCOPE, deps(storage, config(), embed));

		expect(out.action).toBe("inserted");
		expect(out.memoryId).toBe("mem_fixed_id");
		// A dedup probe ran, then the version read, then the INSERT.
		expect(requests.some((r) => isDedupProbe(r.sql))).toBe(true);
		expect(requests.some((r) => isInsert(r.sql))).toBe(true);
	});

	it("c-AC-1 SKIPS an ADD below the confidence threshold (no probe, no insert)", async () => {
		const { storage, requests } = storageWith(noRows);
		const embed = recordingEmbed();
		// Default threshold is 0.7; a 0.5 fact must not write.
		const out = await applyControlledWrite(
			input({ factConfidence: 0.5 }),
			SCOPE,
			deps(storage, config(), embed),
		);

		expect(out.action).toBe("skipped");
		expect(out.reason).toBe("below_confidence");
		expect(requests.some((r) => isInsert(r.sql))).toBe(false);
		// Gated BEFORE the embed prefetch — no embed call for a rejected fact.
		expect(embed.calls).toHaveLength(0);
	});

	it("c-AC-1 SKIPS an ADD with empty normalized content", async () => {
		const { storage, requests } = storageWith(noRows);
		const embed = recordingEmbed();
		const out = await applyControlledWrite(
			input({ content: "   ", normalizedContent: "   " }),
			SCOPE,
			deps(storage, config(), embed),
		);

		expect(out.action).toBe("skipped");
		expect(out.reason).toBe("empty_content");
		expect(requests.some((r) => isInsert(r.sql))).toBe(false);
	});

	it("c-AC-1 honours a configured threshold from minFactConfidenceForWrite", async () => {
		const { storage } = storageWith(noRows);
		const embed = recordingEmbed();
		// Raise the gate to 0.95; a 0.9 fact now fails.
		const out = await applyControlledWrite(
			input({ factConfidence: 0.9 }),
			SCOPE,
			deps(storage, config({ minFactConfidenceForWrite: 0.95 }), embed),
		);
		expect(out.action).toBe("skipped");
		expect(out.reason).toBe("below_confidence");
	});
});

// ── c-AC-2 ──────────────────────────────────────────────────────────────────────

describe("c-AC-2: ADD whose content_hash exists returns existing id, no duplicate INSERT", () => {
	it("c-AC-2 returns the existing memory id and emits NO INSERT on a hash hit", async () => {
		const in0 = input();
		const expectedHash = contentHash(in0.normalizedContent);
		let probedHash = "";
		const responder: Responder = (req: TransportRequest) => {
			if (isDedupProbe(req.sql)) {
				// Capture the literal hash that was probed, then answer with a hit.
				const m = req.sql.match(/content_hash\s*=\s*'([0-9a-f]+)'/i);
				probedHash = m ? m[1] : "";
				return [{ id: "existing-mem-7" }];
			}
			return [];
		};
		const { storage, requests } = storageWith(responder);
		const embed = recordingEmbed();

		const out = await applyControlledWrite(in0, SCOPE, deps(storage, config(), embed));

		expect(out.action).toBe("deduped");
		expect(out.memoryId).toBe("existing-mem-7");
		// The probed hash is the SHA-256 of the normalized content (FR-5).
		expect(probedHash).toBe(expectedHash);
		// NO INSERT was emitted (c-AC-2).
		expect(requests.some((r) => isInsert(r.sql))).toBe(false);
	});
});

// ── c-AC-3 ──────────────────────────────────────────────────────────────────────

describe("c-AC-3: UPDATE/DELETE contradiction check + flag + autonomous gate + version-bumped", () => {
	const updateProposal = (over: Partial<Proposal> = {}): Proposal => ({
		action: "update",
		targetId: "target-mem-1",
		confidence: 0.9,
		reason: "the language is no longer TypeScript",
		...over,
	});

	it("c-AC-3 with autonomous OFF flags for review but does NOT apply (no INSERT)", async () => {
		const { storage, requests } = storageWith(noRows);
		const embed = recordingEmbed();
		const out = await applyControlledWrite(
			input({ proposal: updateProposal() }),
			SCOPE,
			deps(storage, config({ autonomous: { allowUpdateDelete: false } }), embed),
		);

		expect(out.action).toBe("flagged_not_applied");
		expect(out.memoryId).toBe("target-mem-1");
		expect(out.contradiction).toBe(true); // "no longer" negation + lexical overlap (D-7)
		expect(requests.some((r) => isInsert(r.sql))).toBe(false);
	});

	it("c-AC-3 with autonomous ON applies an UPDATE as an append-only version bump", async () => {
		// The version read returns version 4; the bump must INSERT version 5.
		const responder: Responder = (req: TransportRequest) => {
			if (isVersionRead(req.sql)) return [{ version: 4 }];
			return [];
		};
		const { storage, requests } = storageWith(responder);
		const embed = recordingEmbed();
		const out = await applyControlledWrite(
			input({ proposal: updateProposal() }),
			SCOPE,
			deps(storage, config({ autonomous: { allowUpdateDelete: true } }), embed),
		);

		expect(out.action).toBe("version_bumped");
		expect(out.memoryId).toBe("target-mem-1");
		// The INSERT carries version 5 (N+1) — an append, never an in-place UPDATE.
		const insert = requests.find((r) => isInsert(r.sql));
		expect(insert).toBeDefined();
		const compact = (insert?.sql ?? "").replace(/\s+/g, " ");
		// It is an INSERT, not an in-place UPDATE … SET.
		expect(/INSERT\s+INTO\s+"memories"/i.test(compact)).toBe(true);
		expect(/UPDATE\s+"memories"\s+SET/i.test(compact)).toBe(false);
		// The version column is carried on the row. `buildInsert` emits bare (sqlIdent-
		// validated) column names, so match the column word-boundaried, not quote-wrapped.
		expect(/\bversion\b/.test(compact)).toBe(true);
		// And its VALUES entry is 5 (N+1 over the version-read's 4).
		expect(/VALUES[^)]*\b5\b/.test(compact)).toBe(true);
		// No bare in-place UPDATE statement was emitted.
		expect(requests.every((r) => !/^UPDATE\s+"memories"/i.test(r.sql.trim()))).toBe(true);
	});

	it("c-AC-3 applies a DELETE as a version-bumped soft-delete (is_deleted = 1)", async () => {
		const responder: Responder = (req: TransportRequest) => {
			if (isVersionRead(req.sql)) return [{ version: 1 }];
			return [];
		};
		const { storage, requests } = storageWith(responder);
		const embed = recordingEmbed();
		const out = await applyControlledWrite(
			input({
				proposal: { action: "delete", targetId: "target-mem-2", confidence: 0.9, reason: "remove this" },
			}),
			SCOPE,
			deps(storage, config({ autonomous: { allowUpdateDelete: true } }), embed),
		);

		expect(out.action).toBe("version_bumped");
		const insert = requests.find((r) => isInsert(r.sql));
		const compact = (insert?.sql ?? "").replace(/\s+/g, " ");
		// The append carries is_deleted = 1 (a tombstone version), never a hard DELETE.
		// `buildInsert` emits bare (sqlIdent-validated) column names, so match the
		// column word-boundaried rather than quote-wrapped.
		expect(/\bis_deleted\b/.test(compact)).toBe(true);
		// The is_deleted column's VALUES entry is 1 (SOFT_DELETED tombstone), not 0 — a
		// soft-delete append, distinguishing it from a live row. The fixture's row has a
		// NULL embedding and a comma-free content body, so a positional column→value map
		// is unambiguous here.
		const colsVals = compact.match(/\(([^)]*)\)\s+VALUES\s+\(([^)]*)\)/i);
		expect(colsVals).not.toBeNull();
		const colNames = (colsVals?.[1] ?? "").split(",").map((c) => c.trim());
		const colVals = (colsVals?.[2] ?? "").split(",").map((c) => c.trim());
		const delIdx = colNames.indexOf("is_deleted");
		expect(delIdx).toBeGreaterThanOrEqual(0);
		expect(colVals[delIdx]).toBe("1"); // SOFT_DELETED tombstone, never 0
		// No hard DELETE was emitted.
		expect(requests.every((r) => !/^DELETE\s+FROM/i.test(r.sql.trim()))).toBe(true);
		// A DELETE has no new content to embed — no embed prefetch for a delete.
		expect(embed.calls).toHaveLength(0);
	});

	it("c-AC-3 skips an UPDATE/DELETE with no target id", async () => {
		const { storage, requests } = storageWith(noRows);
		const out = await applyControlledWrite(
			input({ proposal: { action: "update", confidence: 0.9, reason: "x" } }),
			SCOPE,
			deps(storage, config({ autonomous: { allowUpdateDelete: true } }), recordingEmbed()),
		);
		expect(out.action).toBe("skipped");
		expect(out.reason).toBe("missing_target_id");
		expect(requests.some((r) => isInsert(r.sql))).toBe(false);
	});

	it("detectContradiction flags negation + antonym, ignores unrelated reasons", () => {
		expect(
			detectContradiction("the build uses esbuild", {
				action: "update",
				targetId: "t",
				confidence: 1,
				reason: "the build does not use esbuild anymore",
			}),
		).toBe(true);
		expect(
			detectContradiction("embeddings are enabled", {
				action: "update",
				targetId: "t",
				confidence: 1,
				reason: "embeddings are disabled",
			}),
		).toBe(true);
		// No lexical overlap → not flagged.
		expect(
			detectContradiction("the build uses esbuild", {
				action: "update",
				targetId: "t",
				confidence: 1,
				reason: "completely unrelated sentence about weather",
			}),
		).toBe(false);
	});
});

// ── c-AC-4 ──────────────────────────────────────────────────────────────────────

describe("c-AC-4: shadowMode writes nothing, proposals logged only", () => {
	it("c-AC-4 under shadowMode emits NO storage query at all for an ADD", async () => {
		const { storage, requests } = storageWith(noRows);
		const embed = recordingEmbed();
		const out = await applyControlledWrite(input(), SCOPE, deps(storage, config({ shadowMode: true }), embed));

		expect(out.action).toBe("skipped");
		expect(out.reason).toBe("shadow_mode");
		expect(requests).toHaveLength(0); // nothing written
		expect(embed.calls).toHaveLength(0); // no work done at all
	});
});

// ── c-AC-5 ──────────────────────────────────────────────────────────────────────

describe("c-AC-5: mutationsFrozen writes nothing; frozen supersedes shadow", () => {
	it("c-AC-5 under mutationsFrozen (shadow off) writes nothing", async () => {
		const { storage, requests } = storageWith(noRows);
		const out = await applyControlledWrite(
			input(),
			SCOPE,
			deps(storage, config({ mutationsFrozen: true }), recordingEmbed()),
		);
		expect(out.action).toBe("skipped");
		expect(out.reason).toBe("mutations_frozen");
		expect(requests).toHaveLength(0);
	});

	it("c-AC-5 frozen SUPERSEDES shadow: with BOTH set the reason is mutations_frozen", async () => {
		const { storage, requests } = storageWith(noRows);
		const out = await applyControlledWrite(
			input(),
			SCOPE,
			deps(storage, config({ mutationsFrozen: true, shadowMode: true }), recordingEmbed()),
		);
		// Frozen is checked FIRST, so the reason is frozen, not shadow.
		expect(out.reason).toBe("mutations_frozen");
		expect(requests).toHaveLength(0);
	});
});

// ── c-AC-6 ──────────────────────────────────────────────────────────────────────

describe("c-AC-6: embeddings prefetched before commit, no network call during commit", () => {
	it("c-AC-6 calls embed BEFORE the dedup-check and the INSERT (ordering)", async () => {
		// Record a single interleaved timeline of embed calls and SQL statements.
		const timeline: string[] = [];
		const responder: Responder = (req: TransportRequest) => {
			timeline.push(isDedupProbe(req.sql) ? "sql:dedup" : isInsert(req.sql) ? "sql:insert" : "sql:other");
			return [];
		};
		const { storage } = storageWith(responder);
		const calls: { text: string }[] = [];
		const embed: EmbedClient = {
			async embed(text: string): Promise<readonly number[] | null> {
				calls.push({ text });
				timeline.push("embed");
				return vec768();
			},
		};

		const out = await applyControlledWrite(input(), SCOPE, deps(storage, config(), embed));
		expect(out.action).toBe("inserted");

		// The embed call precedes the dedup probe AND the insert.
		const embedIdx = timeline.indexOf("embed");
		const dedupIdx = timeline.indexOf("sql:dedup");
		const insertIdx = timeline.indexOf("sql:insert");
		expect(embedIdx).toBeGreaterThanOrEqual(0);
		expect(embedIdx).toBeLessThan(dedupIdx);
		expect(embedIdx).toBeLessThan(insertIdx);
		// And NO embed call happens between the dedup-check and the INSERT commit:
		// every embed call index is before the dedup index (only one embed, prefetched).
		const embedAfterDedup = timeline
			.map((t, i) => ({ t, i }))
			.filter((x) => x.t === "embed" && x.i > dedupIdx);
		expect(embedAfterDedup).toHaveLength(0);
	});

	it("c-AC-6 a null embed (disabled/unreachable) writes the row with content_embedding NULL", async () => {
		const { storage, requests } = storageWith(noRows);
		const embed = recordingEmbed(null); // disabled → null vector
		const out = await applyControlledWrite(input(), SCOPE, deps(storage, config(), embed));

		expect(out.action).toBe("inserted");
		const insert = requests.find((r) => isInsert(r.sql));
		const compact = (insert?.sql ?? "").replace(/\s+/g, " ");
		// The embedding column is written as NULL, not a vector literal.
		expect(/content_embedding/.test(compact)).toBe(true);
		expect(/NULL/.test(compact)).toBe(true);
		expect(/::float4\[\]/.test(compact)).toBe(false);
	});

	it("c-AC-6 a wrong-dim embed is rejected and the row writes content_embedding NULL", async () => {
		const { storage, requests } = storageWith(noRows);
		const embed = recordingEmbed([1, 2, 3]); // non-768 → rejected
		const out = await applyControlledWrite(input(), SCOPE, deps(storage, config(), embed));
		expect(out.action).toBe("inserted");
		const insert = requests.find((r) => isInsert(r.sql));
		expect(/::float4\[\]/.test(insert?.sql ?? "")).toBe(false);
	});
});

// ── scope + escaping (FR-10 / FR-11) ──────────────────────────────────────────────

describe("FR-10/FR-11: every write threads scope + routes through escaping helpers", () => {
	it("threads org/workspace on every statement and agent_id onto the row", async () => {
		const { storage, requests } = storageWith(noRows);
		const out = await applyControlledWrite(
			input({ agentId: "agent-42" }),
			SCOPE,
			deps(storage, config(), recordingEmbed()),
		);
		expect(out.action).toBe("inserted");
		// Every issued statement carried the org + workspace partition (FR-11).
		expect(requests.length).toBeGreaterThan(0);
		for (const r of requests) {
			expect(r.org).toBe(SCOPE.org);
			expect(r.workspace).toBe(SCOPE.workspace);
		}
		// The row carries agent_id = 'agent-42' (engine scope column, FR-11).
		const insert = requests.find((r) => isInsert(r.sql));
		expect(/agent_id/.test(insert?.sql ?? "")).toBe(true);
		expect(/'agent-42'/.test(insert?.sql ?? "")).toBe(true);
	});

	it("escapes a single-quote injection payload in the content (FR-10)", async () => {
		const { storage, requests } = storageWith(noRows);
		const evil = "Robert'); DROP TABLE memories;--";
		const out = await applyControlledWrite(
			input({ content: evil, normalizedContent: evil }),
			SCOPE,
			deps(storage, config(), recordingEmbed()),
		);
		expect(out.action).toBe("inserted");
		const insert = requests.find((r) => isInsert(r.sql));
		const sql = insert?.sql ?? "";
		// The embedded quote is doubled (escaped), so it cannot close the literal early.
		expect(sql).toContain("Robert'')");
		// The security property is INERTNESS, not a payload occurrence count. The content
		// legitimately lands in TWO columns (`content` + `normalized_content`), so the
		// payload string appears once per column — both copies escaped, both inert.
		const dropCount = sql.match(/DROP TABLE/g)?.length ?? 0;
		expect(dropCount).toBe(2); // one per column the content is written to
		// Prove inertness directly: the attacker's close-literal-then-new-statement
		// sequence `'); ` never appears UNescaped. The payload's `Robert');` becomes
		// `Robert'');` (doubled quote), so the literal never closes early and no second
		// statement is smuggled in. There is no `'); DROP` (single quote + paren + drop)
		// anywhere — only the inert doubled-quote form survives.
		expect(/(^|[^'])'\);\s*DROP/i.test(sql)).toBe(false);
		// Every DROP TABLE occurrence is preceded by the doubled-quote escape — i.e. it
		// sits inside a still-open string literal, not at statement position.
		for (const m of sql.matchAll(/DROP TABLE/gi)) {
			const before = sql.slice(0, m.index ?? 0);
			expect(before.includes("Robert'')")).toBe(true);
		}
	});
});

// ── handler wiring ────────────────────────────────────────────────────────────────

describe("createControlledWriteHandler: payload → write, drop-invalid, scope threading", () => {
	it("returns the no-op handler when no deps are supplied (Wave-1 stub call)", async () => {
		const handler = createControlledWriteHandler();
		// The no-op completes without throwing and writes nothing.
		await expect(
			handler({
				id: "j1",
				kind: "memory_controlled_write",
				attempt: 1,
				scope: { org: "o", workspace: "w", agentId: "default" },
				payload: {},
			}),
		).resolves.toBeUndefined();
	});

	it("drops an unparseable proposal payload as a no-op (job completes, no throw)", async () => {
		const { storage, requests } = storageWith(noRows);
		const handler = createControlledWriteHandler(deps(storage, config(), recordingEmbed()));
		const job: StageJob = {
			id: "j2",
			kind: "memory_controlled_write",
			attempt: 1,
			scope: { org: SCOPE.org, workspace: SCOPE.workspace, agentId: "default" },
			payload: { proposal: { not: "a valid proposal" } },
		};
		await expect(handler(job)).resolves.toBeUndefined();
		expect(requests).toHaveLength(0);
	});

	it("applies an ADD from a job payload, threading the job-scope agent id", async () => {
		const { storage, requests } = storageWith(noRows);
		const handler = createControlledWriteHandler(deps(storage, config(), recordingEmbed()));
		const job: StageJob = {
			id: "j3",
			kind: "memory_controlled_write",
			attempt: 1,
			scope: { org: SCOPE.org, workspace: SCOPE.workspace, agentId: "agent-from-scope" },
			payload: {
				proposal: { action: "add", confidence: 0.9, reason: "" },
				content: "fact body",
				normalized_content: "fact body",
				fact_confidence: 0.9,
			},
		};
		await handler(job);
		const insert = requests.find((r) => isInsert(r.sql));
		expect(insert).toBeDefined();
		expect(/'agent-from-scope'/.test(insert?.sql ?? "")).toBe(true);
	});
});

// ── the version-column widening (documented seam) ────────────────────────────────

describe("MEMORIES_VERSION_COLUMN: the version column composed into the heal target", () => {
	it("is a BIGINT NOT NULL with a DEFAULT so it heals onto a populated table", () => {
		expect(MEMORIES_VERSION_COLUMN.name).toBe("version");
		expect(/BIGINT/i.test(MEMORIES_VERSION_COLUMN.sql)).toBe(true);
		expect(/NOT\s+NULL/i.test(MEMORIES_VERSION_COLUMN.sql)).toBe(true);
		expect(/DEFAULT/i.test(MEMORIES_VERSION_COLUMN.sql)).toBe(true);
	});
});
