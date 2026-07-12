/**
 * PRD-022a `mountMemoriesApi` suite — the `/api/memories/*` mount seam.
 *
 * Proves, against a fake-but-real SQL-aware `StorageQuery`:
 *   a-AC-1  the mount seam attaches the handlers (BEFORE → 501, AFTER → live).
 *   a-AC-2  POST /api/memories/recall returns recall hits (no 501), BM25/ILIKE fallback.
 *   a-AC-3  POST /api/memories lands a real row (no 501) that is then recallable.
 *   a-AC-5  a malformed body → zod 400 BEFORE the engine is reached.
 *   a-AC-6  the session group requires `x-honeycomb-session` (400 without it).
 *   FR-4    GET /api/memories (list) + GET /api/memories/:id (get).
 *
 * The `/api/memories` group is a SESSION group behind the runtime-path middleware,
 * so every in-process request stamps `x-honeycomb-runtime-path: legacy` +
 * `x-honeycomb-session` (the a-AC-6 requirement the 022d clients must satisfy).
 */

import { describe, expect, it } from "vitest";

import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import {
	MAX_RECALL_TOKEN_BUDGET,
	mountMemoriesApi,
	type VaultSettingsReader,
} from "../../../../src/daemon/runtime/memories/index.js";
import { EMBEDDING_DIMS } from "../../../../src/daemon/storage/vector.js";
import type { EmbedClient } from "../../../../src/daemon/runtime/services/embed-client.js";
import type { SecretScope } from "../../../../src/daemon/runtime/secrets/contracts.js";
import type { SettingResult } from "../../../../src/daemon/runtime/vault/store.js";
import { createFakeAuthenticator } from "../../../../src/daemon/runtime/auth/contracts.js";
import { createRbacPolicy } from "../../../../src/daemon/runtime/auth/rbac.js";
import { resolvePipelineConfig } from "../../../../src/daemon/runtime/pipeline/config.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const ORG = "fake-org";
const WORKSPACE = "fake-ws";
const SESSION = "sess-022a";

function cfg(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
}

function cfgTeam(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "team", widened: false };
}

/** The daemon's configured default tenant (the single LOCAL tenant) injected via defaultScope. */
const DEFAULT_SCOPE = { org: "daemon-default-org", workspace: "daemon-default-ws" } as const;

/** Session-group headers WITHOUT the org/workspace tenancy headers (the SDK/MCP thin-client shape). */
function headersNoOrg(extra: Record<string, string> = {}): Record<string, string> {
	return {
		"x-honeycomb-runtime-path": "legacy",
		"x-honeycomb-session": SESSION,
		"content-type": "application/json",
		...extra,
	};
}

/** Build a daemon at an explicit mode (default local), sharing the seeded responder. */
function makeDaemonMode(term: string, config: RuntimeConfig) {
	const fake = new FakeDeepLakeTransport(responder(term));
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const daemon = createDaemon({ config, storage, logger: createRequestLogger({ silent: true }) });
	return { daemon, storage, fake };
}

/** Headers for a fully-formed session-group request (org + runtime-path + session). */
function headers(extra: Record<string, string> = {}): Record<string, string> {
	return {
		"x-honeycomb-org": ORG,
		"x-honeycomb-workspace": WORKSPACE,
		"x-honeycomb-runtime-path": "legacy",
		"x-honeycomb-session": SESSION,
		"content-type": "application/json",
		...extra,
	};
}

/**
 * A SQL-aware responder: the per-arm recall `memories` SELECT surfaces a memories
 * hit for the seeded term; the `memory`/`sessions` sibling arms return empty (no
 * such table here — the same fresh-partition shape recall must tolerate); a memories
 * read-back scan returns a stored row; everything else is empty rows.
 */
function responder(term: string) {
	return (req: TransportRequest): Record<string, unknown>[] => {
		const sql = req.sql;
		// Recall `memories` arm (the per-arm SELECT carrying `'memories' AS source`,
		// matching the seeded term) → a memories arm hit. The `memory`/`sessions` arms
		// fall through to empty rows, proving the per-arm merge still surfaces memories.
		if (/'memories'\s+AS\s+source/i.test(sql) && sql.includes(term)) {
			return [{ source: "memories", id: "mem-1", text: `a fact about ${term}` }];
		}
		// memory_get / memory_list scan of memories.
		if (/FROM\s+"memories"/i.test(sql) && /ORDER BY/i.test(sql)) {
			return [
				{
					id: "mem-1",
					type: "fact",
					content: `a fact about ${term}`,
					confidence: 1,
					agent_id: "default",
					is_deleted: 0,
					created_at: "2026-06-20T00:00:00.000Z",
					updated_at: "2026-06-20T00:00:00.000Z",
				},
			];
		}
		// Dedup probe (SELECT-before-INSERT) → no existing row, so the store inserts.
		return [];
	};
}

function makeDaemon(term: string) {
	const fake = new FakeDeepLakeTransport(responder(term));
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const daemon = createDaemon({ config: cfg(), storage, logger: createRequestLogger({ silent: true }) });
	return { daemon, storage, fake };
}

describe("PRD-022a mountMemoriesApi wires the /api/memories/* handlers", () => {
	it("a-AC-1: BEFORE attach, /api/memories/recall answers the 501 scaffold", async () => {
		const { daemon } = makeDaemon("widget");
		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ query: "widget" }),
		});
		expect(res.status).toBe(501);
	});

	it("a-AC-1: AFTER attach, the recall handler is live (not 501)", async () => {
		const { daemon, storage } = makeDaemon("widget");
		mountMemoriesApi(daemon, { storage });
		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ query: "widget" }),
		});
		expect(res.status).toBe(200);
	});

	it("a-AC-2: recall returns the captured turn via the lexical UNION ALL (degraded fallback)", async () => {
		const term = "honeycombterm";
		const { daemon, storage } = makeDaemon(term);
		mountMemoriesApi(daemon, { storage });
		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ query: term }),
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { hits: { source: string; text: string }[]; sources: string[]; degraded: boolean };
		expect(json.hits.length).toBeGreaterThan(0);
		expect(json.hits[0]?.text).toContain(term);
		expect(json.sources).toContain("memories");
		// Embeddings off → the BM25/ILIKE lexical arm; degraded is surfaced true.
		expect(json.degraded).toBe(true);
	});

	it("a-AC-3: POST /api/memories lands a real row (201, not 501) with an action", async () => {
		const { daemon, storage } = makeDaemon("widget");
		mountMemoriesApi(daemon, { storage });
		const res = await daemon.app.request("/api/memories", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ content: "the user prefers tabs over spaces" }),
		});
		expect(res.status).toBe(201);
		const json = (await res.json()) as { id: string | null; action: string };
		expect(json.action).toBe("inserted");
		expect(json.id).not.toBeNull();
	});

	it("a-AC-3: a stored row is INSERTed into the memories table (write reaches storage)", async () => {
		const { daemon, storage, fake } = makeDaemon("widget");
		mountMemoriesApi(daemon, { storage });
		await daemon.app.request("/api/memories", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ content: "remember the deploy runbook" }),
		});
		const inserts = fake.requests.filter((r) => /INSERT INTO\s+"memories"/i.test(r.sql));
		expect(inserts.length).toBeGreaterThan(0);
	});

	it("a-AC-5: a malformed recall body (missing query) → zod 400 before the engine", async () => {
		const { daemon, storage, fake } = makeDaemon("widget");
		mountMemoriesApi(daemon, { storage });
		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ notquery: 1 }),
		});
		expect(res.status).toBe(400);
		const json = (await res.json()) as { error: string; issues: unknown[] };
		expect(json.error).toBe("bad_request");
		expect(Array.isArray(json.issues)).toBe(true);
		// The engine was never reached: no recall arm (the per-arm `'…' AS source`
		// SELECT) ran.
		expect(fake.requests.some((r) => /\bAS\s+source\b/i.test(r.sql))).toBe(false);
	});

	it("SECURITY (PRD-047e): a tokenBudget above MAX_RECALL_TOKEN_BUDGET → zod 400 before the engine", async () => {
		const { daemon, storage, fake } = makeDaemon("widget");
		mountMemoriesApi(daemon, { storage });
		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: headers(),
			// One above the boundary ceiling: a defense-in-depth reject, never a silent coerce.
			body: JSON.stringify({ query: "widget", tokenBudget: MAX_RECALL_TOKEN_BUDGET + 1 }),
		});
		expect(res.status).toBe(400);
		const json = (await res.json()) as { error: string };
		expect(json.error).toBe("bad_request");
		// The engine was never reached: no recall arm SELECT ran.
		expect(fake.requests.some((r) => /\bAS\s+source\b/i.test(r.sql))).toBe(false);
	});

	it("SECURITY (PRD-047e): a non-positive tokenBudget → zod 400 (never a silent coerce)", async () => {
		const { daemon, storage } = makeDaemon("widget");
		mountMemoriesApi(daemon, { storage });
		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ query: "widget", tokenBudget: 0 }),
		});
		expect(res.status).toBe(400);
	});

	it("PRD-047e: a tokenBudget AT the ceiling is accepted (no legitimate request is rejected)", async () => {
		const { daemon, storage } = makeDaemon("widget");
		mountMemoriesApi(daemon, { storage });
		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ query: "widget", tokenBudget: MAX_RECALL_TOKEN_BUDGET }),
		});
		// In-range budget passes validation and reaches the engine (200, not a 400 reject).
		expect(res.status).toBe(200);
	});

	it("a-AC-5: a malformed store body (missing content) → zod 400 before the engine", async () => {
		const { daemon, storage, fake } = makeDaemon("widget");
		mountMemoriesApi(daemon, { storage });
		const res = await daemon.app.request("/api/memories", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({}),
		});
		expect(res.status).toBe(400);
		expect(fake.requests.some((r) => /INSERT INTO\s+"memories"/i.test(r.sql))).toBe(false);
	});

	it("a-AC-6: the session group rejects a request with no x-honeycomb-session (400)", async () => {
		const { daemon, storage } = makeDaemon("widget");
		mountMemoriesApi(daemon, { storage });
		const noSession = headers();
		delete noSession["x-honeycomb-session"];
		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: noSession,
			body: JSON.stringify({ query: "widget" }),
		});
		expect(res.status).toBe(400);
		const json = (await res.json()) as { reason: string };
		expect(json.reason).toContain("x-honeycomb-session");
	});

	it("FR-7: a request with no x-honeycomb-org → 400 (tenancy fail-closed)", async () => {
		const { daemon, storage } = makeDaemon("widget");
		mountMemoriesApi(daemon, { storage });
		const noOrg = headers();
		delete noOrg["x-honeycomb-org"];
		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: noOrg,
			body: JSON.stringify({ query: "widget" }),
		});
		expect(res.status).toBe(400);
		const json = (await res.json()) as { reason: string };
		expect(json.reason).toContain("x-honeycomb-org");
	});

	it("FR-4: GET /api/memories lists the scoped tenant's memories", async () => {
		const { daemon, storage } = makeDaemon("widget");
		mountMemoriesApi(daemon, { storage });
		const res = await daemon.app.request("/api/memories", { headers: headers() });
		expect(res.status).toBe(200);
		const json = (await res.json()) as { memories: { id: string; content: string }[] };
		expect(json.memories.length).toBeGreaterThan(0);
		expect(json.memories[0]?.id).toBe("mem-1");
	});

	it("FR-4: GET /api/memories/:id returns the single memory", async () => {
		const { daemon, storage } = makeDaemon("widget");
		mountMemoriesApi(daemon, { storage });
		const res = await daemon.app.request("/api/memories/mem-1", { headers: headers() });
		expect(res.status).toBe(200);
		const json = (await res.json()) as { memory: { id: string } };
		expect(json.memory.id).toBe("mem-1");
	});

	it("mounts idempotently against the assembled-config resolution (no env crash)", () => {
		// The store path resolves the pipeline config from env; resolution must not throw
		// for the default (false-safe) env — proves the seam is wirable in assembly.
		expect(() => resolvePipelineConfig()).not.toThrow();
	});
});

describe("PRD-022 local-mode default-scope fallback (the SDK/MCP 400 regression fix)", () => {
	it("local mode + NO org header + defaultScope injected → recall reaches the engine (200)", async () => {
		// The dogfood regression: a loopback thin client (SDK recall / MCP memory_search) sends
		// session + runtime-path but NOT x-honeycomb-org. In local mode with a configured
		// default tenant, the request must fall back to it — NOT 400.
		const term = "fallbackterm";
		const { daemon, storage, fake } = makeDaemonMode(term, cfg());
		mountMemoriesApi(daemon, { storage, defaultScope: DEFAULT_SCOPE });
		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: headersNoOrg(),
			body: JSON.stringify({ query: term }),
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { hits: { text: string }[] };
		expect(json.hits.length).toBeGreaterThan(0);
		// The engine actually ran (a recall arm SELECT fired) — not a short-circuit.
		expect(fake.requests.some((r) => /\bAS\s+source\b/i.test(r.sql))).toBe(true);
	});

	it("local mode + NO org header + NO defaultScope → still 400 (defensive, unchanged)", async () => {
		const { daemon, storage } = makeDaemonMode("widget", cfg());
		// No defaultScope injected (a bare unit mount) → the fallback never fires → fail-closed.
		mountMemoriesApi(daemon, { storage });
		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: headersNoOrg(),
			body: JSON.stringify({ query: "widget" }),
		});
		expect(res.status).toBe(400);
		const json = (await res.json()) as { reason: string };
		expect(json.reason).toContain("x-honeycomb-org");
	});

	it("TEAM mode + NO org header → REJECTED, never the local fallback (fallback is local-only)", async () => {
		const { daemon, storage, fake } = makeDaemonMode("widget", cfgTeam());
		// Even though a defaultScope is injected, team mode must NOT fall back — tenancy is
		// still required outside local. In team mode the PRD-011 permission middleware rejects
		// an unauthenticated request with 401 BEFORE the handler (an even stronger guard than
		// the handler's 400); either way the request is REJECTED and the fallback never fires.
		mountMemoriesApi(daemon, { storage, defaultScope: DEFAULT_SCOPE });
		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: headersNoOrg(),
			body: JSON.stringify({ query: "widget" }),
		});
		// NOT 200 — the request never resolved to the default tenant.
		expect(res.status).not.toBe(200);
		// The auth/tenancy layer rejected it (401 from the middleware, or 400 from the handler).
		expect([400, 401]).toContain(res.status);
		// The recall engine was NEVER reached (no recall-arm SELECT ran) — the fallback did not
		// silently grant a team request the default tenant's data.
		expect(fake.requests.some((r) => /\bAS\s+source\b/i.test(r.sql))).toBe(false);
	});

	it("SECURITY (PRD-022 cross-tenant): TEAM mode + valid org-A token + FORGED x-honeycomb-org:orgB → no orgB read", async () => {
		// The cross-tenant hardening regression. An authenticated caller whose token binds
		// org A forges `x-honeycomb-org: orgB` to try to read org B's memories. The data
		// handler partitions storage by the header org; WITHOUT the fix the recall arm would
		// run scoped to org B (a cross-tenant breach). The fix: the permission middleware
		// stamps the VALIDATED Identity, and the scope resolver rejects a header org that
		// disagrees with the token's org → the recall engine is never reached under org B.
		const term = "secretB";
		const fake = new FakeDeepLakeTransport(responder(term));
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const ORG_A = "org-a";
		const ORG_B = "org-b";
		const TOKEN_A = "token-for-org-a";
		// A real authenticator: the org-A token validates to Identity{ org: A, role: member }.
		const authenticator = createFakeAuthenticator({
			[TOKEN_A]: { org: ORG_A, workspace: "ws-a", agentId: "default", role: "member" },
		});
		const daemon = createDaemon({
			config: cfgTeam(),
			storage,
			logger: createRequestLogger({ silent: true }),
			authenticator,
			policy: createRbacPolicy(),
		});
		mountMemoriesApi(daemon, { storage });
		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: {
				authorization: `Bearer ${TOKEN_A}`,
				"x-honeycomb-org": ORG_B, // forged: the caller's token binds org A, not B.
				"x-honeycomb-runtime-path": "legacy",
				"x-honeycomb-session": SESSION,
				"content-type": "application/json",
			},
			body: JSON.stringify({ query: term }),
		});
		// The forged-org request is REJECTED (the handler's fail-closed 400 once the scope
		// resolver refuses the mismatched org). It is NOT a 200 with org-B data.
		expect(res.status).not.toBe(200);
		// PROOF: no recall arm ever ran scoped to org B — the cross-tenant read was blocked
		// before storage. (No `'…' AS source` SELECT was issued under org B at all.)
		const orgBReads = fake.requests.filter((r) => r.org === ORG_B && /\bAS\s+source\b/i.test(r.sql));
		expect(orgBReads.length).toBe(0);
	});

	it("SECURITY (PRD-022 cross-tenant): TEAM mode + valid org-A token + MATCHING x-honeycomb-org:orgA → reaches org-A read", async () => {
		// The companion positive case: the SAME caller with the HONEST (matching) org header
		// is allowed and the recall runs scoped to org A. This proves the fix rejects only a
		// MISMATCH, never a legitimate org-aligned request (no over-blocking).
		const term = "ownfact";
		const fake = new FakeDeepLakeTransport(responder(term));
		const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
		const ORG_A = "org-a";
		const TOKEN_A = "token-for-org-a";
		const authenticator = createFakeAuthenticator({
			[TOKEN_A]: { org: ORG_A, workspace: "ws-a", agentId: "default", role: "member" },
		});
		const daemon = createDaemon({
			config: cfgTeam(),
			storage,
			logger: createRequestLogger({ silent: true }),
			authenticator,
			policy: createRbacPolicy(),
		});
		mountMemoriesApi(daemon, { storage });
		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: {
				authorization: `Bearer ${TOKEN_A}`,
				"x-honeycomb-org": ORG_A, // matching: the header agrees with the token's org.
				"x-honeycomb-runtime-path": "legacy",
				"x-honeycomb-session": SESSION,
				"content-type": "application/json",
			},
			body: JSON.stringify({ query: term }),
		});
		expect(res.status).toBe(200);
		// The recall arm ran scoped to org A (the validated tenant), never another tenant.
		const recallArm = fake.requests.find((r) => /\bAS\s+source\b/i.test(r.sql));
		expect(recallArm?.org).toBe(ORG_A);
	});

	it("org header present (local, with defaultScope) → the HEADER scope wins, not the default", async () => {
		const term = "headerwins";
		const { daemon, storage, fake } = makeDaemonMode(term, cfg());
		mountMemoriesApi(daemon, { storage, defaultScope: DEFAULT_SCOPE });
		// A request WITH the org header (the CLI shape) must use the header tenant, not the default.
		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ query: term }),
		});
		expect(res.status).toBe(200);
		// The header org (ORG = "fake-org"), NOT the injected default, partitioned the query.
		const recallArm = fake.requests.find((r) => /\bAS\s+source\b/i.test(r.sql));
		expect(recallArm?.org).toBe(ORG);
		expect(recallArm?.org).not.toBe(DEFAULT_SCOPE.org);
	});
});

// ── PRD-044c — the LIVE /api/memories/recall path READS recallMode + honors it ────────────────

/** A 768-dim query vector for the live recall-mode handler tests. */
const VALID_QUERY_VECTOR: readonly number[] = new Array(EMBEDDING_DIMS).fill(0.05) as number[];

/** A fixed-vector EmbedClient so the handler's semantic arm WOULD run unless recallMode gates it. */
function fakeEmbed(result: readonly number[] | null): EmbedClient {
	return {
		async embed(): Promise<readonly number[] | null> {
			return result;
		},
	};
}

/**
 * A fake vault `getSetting` reader: returns `{ ok:true, value }` for the `recallMode` key when
 * `value` is set, else `{ ok:false, reason:"not_found" }` (the UNSET case). Records every read so a
 * test can prove the handler consulted the vault at recall time. Structurally a {@link VaultSettingsReader}.
 */
function fakeVault(value: string | null): { vault: VaultSettingsReader; reads: string[] } {
	const reads: string[] = [];
	const vault: VaultSettingsReader = {
		async getSetting(key: string, _scope: SecretScope): Promise<SettingResult> {
			reads.push(key);
			if (key === "recallMode" && value !== null) return { ok: true, value };
			return { ok: false, reason: "not_found" };
		},
	};
	return { vault, reads };
}

/**
 * A SQL-aware responder that answers BOTH the lexical `memories` arm AND the semantic `<#>` cosine
 * arm (+ its hydration SELECT). With a valid embed injected, the semantic arm WOULD surface
 * `mem-sem` and report `degraded:false` — UNLESS `recallMode:"keyword"` gates it off, in which case
 * only the lexical `mem-lex` surfaces and `<#>` is never issued. This is the seam that makes the
 * keyword-vs-default contrast observable over HTTP.
 */
function recallModeResponder(term: string) {
	return (req: TransportRequest): Record<string, unknown>[] => {
		const sql = req.sql;
		// The lexical `memories` arm (always runs — the resilient floor).
		if (/'memories'\s+AS\s+source/i.test(sql) && sql.includes(term)) {
			return [{ source: "memories", id: "mem-lex", text: `a lexical fact about ${term}` }];
		}
		// The semantic `<#>` cosine arm → a scored id (only reached when the semantic arm runs).
		if (sql.includes("<#>")) return [{ id: "mem-sem", score: 0.93 }];
		// The hydration SELECT (`AS source` + `IN (...)`) → the matched semantic row's text.
		if (/AS\s+source/i.test(sql) && /\bIN\s*\(/i.test(sql)) {
			return [{ source: "memories", id: "mem-sem", text: `a semantic-only hit about ${term}` }];
		}
		return [];
	};
}

function makeRecallModeDaemon(term: string) {
	const fake = new FakeDeepLakeTransport(recallModeResponder(term));
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const daemon = createDaemon({ config: cfg(), storage, logger: createRequestLogger({ silent: true }) });
	return { daemon, storage, fake };
}

describe("PRD-044c — /api/memories/recall reads the recallMode setting and honors it on the LIVE path", () => {
	it("recallMode='keyword' persisted → handler reads it; response is keyword-gated (NO `<#>`, degraded:false)", async () => {
		const term = "modeterm";
		const { daemon, storage, fake } = makeRecallModeDaemon(term);
		const { vault, reads } = fakeVault("keyword");
		// Embeddings ARE available (a valid embed) — only the keyword MODE suppresses the semantic arm.
		mountMemoriesApi(daemon, { storage, embed: fakeEmbed(VALID_QUERY_VECTOR), vault });

		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ query: term }),
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { hits: { id: string }[]; degraded: boolean };

		// The handler consulted the vault for the recall mode AT RECALL TIME.
		expect(reads).toContain("recallMode");
		// The keyword gate: NO `<#>` cosine arm was ever issued to storage.
		expect(fake.requests.some((r) => r.sql.includes("<#>")), "keyword mode issues NO `<#>` arm").toBe(false);
		// An intentional lexical run is NOT degraded (PRD-029 coherence).
		expect(json.degraded).toBe(false);
		// Only the lexical hit surfaces; the semantic-only id never appears (the arm never ran).
		expect(json.hits.some((h) => h.id === "mem-lex")).toBe(true);
		expect(json.hits.some((h) => h.id === "mem-sem")).toBe(false);
	});

	it("recallMode UNSET (key not found) → behavior unchanged: the semantic `<#>` arm RUNS (degraded:false)", async () => {
		const term = "modeterm";
		const { daemon, storage, fake } = makeRecallModeDaemon(term);
		const { vault } = fakeVault(null); // the key is not set → fail-soft to today's behavior.
		mountMemoriesApi(daemon, { storage, embed: fakeEmbed(VALID_QUERY_VECTOR), vault });

		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ query: term }),
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { hits: { id: string }[]; degraded: boolean };

		// UNSET → the default path: the `<#>` cosine arm WAS issued (the semantic arm ran).
		expect(fake.requests.some((r) => r.sql.includes("<#>")), "default path issues the `<#>` arm").toBe(true);
		expect(json.degraded).toBe(false);
		// The semantic-only hit surfaces — proving the arm ran on the default path.
		expect(json.hits.some((h) => h.id === "mem-sem")).toBe(true);
	});

	it("NO vault wired at all → unchanged behavior (the semantic arm runs; no vault read attempted)", async () => {
		// A unit-constructed mount with no vault must behave EXACTLY as today (the deterministic floor).
		const term = "modeterm";
		const { daemon, storage, fake } = makeRecallModeDaemon(term);
		mountMemoriesApi(daemon, { storage, embed: fakeEmbed(VALID_QUERY_VECTOR) }); // no vault.

		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: headers(),
			body: JSON.stringify({ query: term }),
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { degraded: boolean };
		expect(fake.requests.some((r) => r.sql.includes("<#>"))).toBe(true);
		expect(json.degraded).toBe(false);
	});
});

// ── PRD-049b: per-project recall scoping on the /api/memories/recall handler ──
describe("PRD-049b recall handler project scoping (49b-AC-2 / D8)", () => {
	it("with NO cwd, the recall runs WORKSPACE-WIDE (ISS-006 corpus parity) and surfaces the visible D8 warning", async () => {
		const term = "projterm";
		const { daemon, storage, fake } = makeDaemon(term);
		mountMemoriesApi(daemon, { storage });
		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: headers(), // no cwd body field, no x-honeycomb-cwd header → degraded resolution.
			body: JSON.stringify({ query: term }),
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { projectScopeDegraded?: boolean; warning?: string };
		// D8: the degrade is VISIBLE, not silent.
		expect(json.projectScopeDegraded).toBe(true);
		expect(typeof json.warning).toBe("string");
		expect(json.warning).toContain("project scoping degraded");
		// ISS-006 (corpus parity): degraded resolution applies NO project predicate — the recall
		// corpus is the WHOLE workspace partition, EXACTLY the corpus the degraded GET /api/memories
		// list shows. (Pre-fix, recall narrowed to inbox-only here — the OPPOSITE fallback of the
		// list's no-filter for the same input, so search operated over a different set than the
		// list rendered.)
		const arms = fake.requests.filter((r) => /FROM\s+"(memories|memory|sessions)"/i.test(r.sql) && /AS source/i.test(r.sql));
		expect(arms.length).toBeGreaterThan(0);
		for (const r of arms) {
			expect(r.sql).not.toContain("project_id");
		}
	});

	it("a recall body `cwd` with no resolvable binding still resolves (no degrade warning; inbox scope)", async () => {
		const term = "projterm2";
		const { daemon, storage, fake } = makeDaemon(term);
		mountMemoriesApi(daemon, { storage });
		const res = await daemon.app.request("/api/memories/recall", {
			method: "POST",
			headers: headers(),
			// A cwd IS provided → the project resolves (to the inbox, since no projects.json), so
			// scoping is NOT degraded — the warning is omitted, but the arms still narrow correctly.
			body: JSON.stringify({ query: term, cwd: "/some/unbound/dir" }),
		});
		expect(res.status).toBe(200);
		const json = (await res.json()) as { projectScopeDegraded?: boolean };
		expect(json.projectScopeDegraded).toBeUndefined();
		const arms = fake.requests.filter((r) => /FROM\s+"(memories|memory|sessions)"/i.test(r.sql) && /AS source/i.test(r.sql));
		for (const r of arms) {
			expect(r.sql).toContain("project_id = '__unsorted__'");
		}
	});

	// ── PRD-058e: the calibration introspection endpoint ────────────────────────
	it("58e: GET /api/memories/calibration returns the cold-start shape when no curve is fit", async () => {
		const { daemon, storage } = makeDaemon("anything");
		mountMemoriesApi(daemon, { storage });
		const res = await daemon.app.request("/api/memories/calibration", { method: "GET", headers: headers() });
		expect(res.status).toBe(200);
		const json = (await res.json()) as {
			ece: number;
			brier: number;
			nSamples: number;
			identity: boolean;
			fitAt: string | null;
			reliabilityDiagram: { lower: number; upper: number }[];
		};
		// No memory_calibration row in the fake → the cold-start identity introspection.
		expect(json.identity).toBe(true);
		expect(json.ece).toBe(0);
		expect(json.brier).toBe(0);
		expect(json.nSamples).toBe(0);
		expect(json.fitAt).toBeNull();
		expect(json.reliabilityDiagram.length).toBeGreaterThan(0);
	});

	it("58e: GET /api/memories/calibration is tenancy fail-closed (no org → 400)", async () => {
		const { daemon, storage } = makeDaemon("anything");
		mountMemoriesApi(daemon, { storage });
		const noOrg = headers();
		delete noOrg["x-honeycomb-org"];
		const res = await daemon.app.request("/api/memories/calibration", { method: "GET", headers: noOrg });
		expect(res.status).toBe(400);
	});
});
