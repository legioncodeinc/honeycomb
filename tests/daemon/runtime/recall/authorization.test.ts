/**
 * PRD-007c Authorization Boundary — c-AC-1..7 (Wave 2, `retrieval-worker-bee`).
 *
 * THE SECURITY BOUNDARY. This suite is ADVERSARIAL: it proves the phase re-queries
 * with the partition + the shared scope clause + caller filters, drops every
 * candidate that does not survive BEFORE any content loads, fails closed on a
 * malformed agent (never widening), and that the storage partition prevents a
 * cross-workspace id from surfacing even when the inner clause is buggy.
 *
 * Verification posture (recall CONVENTIONS):
 *   - Driven by a SQL-AWARE FAKE transport that (a) answers the roster lookup
 *     (`FROM "agents"`) for group-membership resolution, (b) answers the
 *     authorization re-query (`FROM "memories" … id IN (…)`) by returning ONLY the
 *     ids the scope/partition would actually authorize, and (c) records every
 *     statement + its resolved org/workspace so the emitted SQL + escaping + the
 *     partition that reached the wire are all assertable.
 *   - IDs-ONLY is asserted structurally: the re-query SELECTs `id` only; no
 *     responder ever returns a `content` column, and the authorized pool carries
 *     no content field.
 *   - Each test is named after the c-AC it proves (one-to-one ledger map).
 *   - No `.skip` / `.only`; `vitest run` is CI.
 */

import { describe, expect, it } from "vitest";

import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import type { StorageRow } from "../../../../src/daemon/storage/result.js";
import {
	type Candidate,
	type MergedPool,
	type RecallConfig,
	RecallConfigSchema,
	type RecallLogger,
	type RecallPhaseDeps,
	type RecallQuery,
	type RecallScope,
	authorizationPhase,
	authorizeBrowse,
	buildAuthorizationSql,
	buildBrowseAuthorizationSql,
	buildFilterConjuncts,
	buildGroupMembersSql,
	buildScopeClause,
} from "../../../../src/daemon/runtime/recall/index.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const ORG = "org-acme";
const WORKSPACE = "ws-main";

function config(overrides: Record<string, unknown> = {}): RecallConfig {
	return RecallConfigSchema.parse(overrides);
}

function scope(overrides: Partial<RecallScope> = {}): RecallScope {
	return {
		org: ORG,
		workspace: WORKSPACE,
		agentId: "agent-self",
		readPolicy: "isolated",
		policyGroup: "",
		...overrides,
	};
}

function query(overrides: Partial<RecallQuery> = {}): RecallQuery {
	return {
		query: "how does the daemon bind its socket",
		scope: overrides.scope ?? scope(),
		...overrides,
	};
}

/** A candidate carries id + per-channel scores + provenance — IDs only, no content. */
function candidate(id: string, fts = 0.5): Candidate {
	return { id, scores: { fts }, provenance: ["fts"] };
}

function pool(ids: readonly string[], degraded = false): MergedPool {
	return { candidates: ids.map((id) => candidate(id)), degraded };
}

/** A recording logger so fail-closed / group-resolve events are assertable. */
function recordingLogger(): { events: { name: string; fields?: Record<string, unknown> }[]; event: RecallLogger } {
	const events: { name: string; fields?: Record<string, unknown> }[] = [];
	const event: RecallLogger = {
		event(name: string, fields?: Record<string, unknown>): void {
			events.push({ name, fields });
		},
	};
	return { events, event };
}

/**
 * A SQL-aware fake transport modeling a tiny REAL roster + memory store. The
 * responder enforces the scope HONESTLY: it returns from the `memories` re-query
 * ONLY the ids that the partition (org/workspace reaching the wire) AND the
 * authorized id set permit — exactly what a correct DeepLake would do under the
 * storage partition + the inner clause. This lets the test prove the boundary
 * drops unauthorized ids and that the partition excludes cross-workspace ids.
 */
function makeStorage(args: {
	/** Roster rows returned for the `agents` group lookup (group-membership resolution). */
	rosterRows?: StorageRow[];
	/** The ids the backing store would authorize for the re-query (post scope + partition). */
	authorizedIds: readonly string[];
	/** Optional: a workspace→authorized-ids map so the partition can be modeled per workspace. */
	authorizedByWorkspace?: Record<string, readonly string[]>;
}): {
	storage: ReturnType<typeof createStorageClient>;
	fake: FakeDeepLakeTransport;
} {
	const responder = (req: TransportRequest): StorageRow[] => {
		const sql = req.sql;
		if (/(INSERT|UPDATE|DELETE|ALTER|DROP)\b/i.test(sql)) {
			throw new Error(`authorization must be read-only: ${sql}`);
		}
		// Roster lookup for group-membership resolution.
		if (/FROM\s+"agents"/i.test(sql)) return args.rosterRows ?? [];
		// The memory re-query (scored recall) or the browse query.
		if (/FROM\s+"memories"/i.test(sql)) {
			// Model the OUTER partition ring: the authorized set may depend on the
			// workspace that reached the wire (c-AC-6).
			const authorized =
				args.authorizedByWorkspace?.[req.workspace] ?? args.authorizedIds;
			// Model the candidate `IN (…)` constraint: only ids named in the SQL survive
			// when the statement carries an IN list (the scored re-query). Browse has no IN.
			const hasIn = /\bIN\s*\(/i.test(sql);
			return authorized
				.filter((id) => (hasIn ? sql.includes(`'${id}'`) : true))
				.map((id) => ({ id }));
		}
		return [];
	};
	const fake = new FakeDeepLakeTransport(responder);
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	return { storage, fake };
}

function deps(args: {
	storage: ReturnType<typeof createStorageClient>;
	logger?: RecallPhaseDeps["logger"];
	config?: RecallConfig;
}): RecallPhaseDeps {
	return {
		storage: args.storage,
		scope: { org: ORG, workspace: WORKSPACE },
		config: args.config ?? config(),
		logger: args.logger,
	};
}

// ── c-AC-1 ──────────────────────────────────────────────────────────────────

describe("c-AC-1 re-query with the org/workspace partition + read-policy clause + caller filters", () => {
	it("emits one SELECT over memories with `id IN (…)`, the scope clause, and the caller filters, under the partition", async () => {
		const { storage, fake } = makeStorage({ authorizedIds: ["m1", "m2"] });
		const q = query({
			scope: scope({ agentId: "agent-self", readPolicy: "isolated" }),
			filters: { type: "decision", project: "honeycomb", pinned: true, minImportance: 0.4, tag: "infra" },
		});
		const authorized = await authorizationPhase(pool(["m1", "m2"]), q, deps({ storage }));

		const req = fake.requests.find((r) => /FROM\s+"memories"/i.test(r.sql));
		expect(req, "an authorization re-query over memories must be emitted").toBeDefined();
		// The candidate IN constraint (FR-1), IDs only (no content projected).
		expect(req?.sql).toMatch(/SELECT\s+id\s+AS\s+id/i);
		expect(req?.sql).not.toMatch(/\bcontent\b/i);
		expect(req?.sql).toMatch(/\bid\s+IN\s*\(\s*'m1',\s*'m2'\s*\)/i);
		// The shared scope clause (isolated → agent_id = '<self>'), archived excluded.
		expect(req?.sql).toMatch(/agent_id = 'agent-self'/);
		expect(req?.sql).toMatch(/is_deleted = 0/);
		// Caller filters applied WITHIN the same authorized re-query (FR-4).
		expect(req?.sql).toMatch(/type = 'decision'/);
		expect(req?.sql).toMatch(/project = 'honeycomb'/);
		expect(req?.sql).toMatch(/pinned = 1/);
		expect(req?.sql).toMatch(/importance >= 0\.4/);
		expect(req?.sql).toMatch(/tags::text ILIKE '%"infra"%'/);
		// The partition reached the wire (the OUTER ring).
		expect(req?.org).toBe(ORG);
		expect(req?.workspace).toBe(WORKSPACE);
		// Survivors only.
		expect(authorized.candidates.map((c) => c.id).sort()).toEqual(["m1", "m2"]);
		// The compiled clause is carried for the gate (e-AC-4).
		expect(authorized.context.clause.policyApplied).toBe("isolated");
	});

	it("the caller filters are NOT an unscoped pre-filter — they share the same WHERE as the clause", () => {
		const clause = buildScopeClause({ agentId: "agent-self", readPolicy: "isolated", org: ORG, workspace: WORKSPACE });
		const sql = buildAuthorizationSql({
			candidateIds: ["m1"],
			clause,
			filters: { type: "fact", createdAfter: "2026-01-01", createdBefore: "2026-12-31" },
		});
		// One statement: the IN, the clause, and every filter are AND-joined in one WHERE.
		expect(sql).not.toBeNull();
		expect(sql).toMatch(/WHERE\s+id\s+IN\s*\([^)]*\)\s+AND\s*\(/i);
		expect(sql).toMatch(/AND created_at >= '2026-01-01'/);
		expect(sql).toMatch(/AND created_at <= '2026-12-31'/);
		// Only one SELECT — no separate pre-filter pass.
		expect((sql?.match(/SELECT/gi) ?? []).length).toBe(1);
	});
});

// ── c-AC-2 ──────────────────────────────────────────────────────────────────

describe("c-AC-2 isolated agent → only its own non-archived memories survive", () => {
	it("an isolated agent's clause is agent_id = self AND is_deleted = 0, and only own ids return", async () => {
		// The backing store authorizes only the isolated agent's own row (m_own); a peer's
		// row (m_peer) is present in the candidate pool but the store does not authorize it.
		const { storage, fake } = makeStorage({ authorizedIds: ["m_own"] });
		const q = query({ scope: scope({ agentId: "agent-self", readPolicy: "isolated" }) });
		const authorized = await authorizationPhase(pool(["m_own", "m_peer"]), q, deps({ storage }));

		const req = fake.requests.find((r) => /FROM\s+"memories"/i.test(r.sql));
		expect(req?.sql).toMatch(/\(agent_id = 'agent-self' AND is_deleted = 0\)/);
		// No `visibility = 'global'` arm — isolated never widens to workspace-global.
		expect(req?.sql).not.toMatch(/visibility = 'global'/);
		// Only the own id survives; the peer is dropped.
		expect(authorized.candidates.map((c) => c.id)).toEqual(["m_own"]);
	});
});

// ── c-AC-3 ──────────────────────────────────────────────────────────────────

describe("c-AC-3 group agent → group-global + own survive, archived excluded", () => {
	it("resolves same-policy_group peers off the roster and renders global-from-peers + own", async () => {
		// Roster: two peers share the group; the re-query authorizes a peer's GLOBAL row
		// (m_peerglobal) + the agent's own row (m_own), excludes archived.
		const { storage, fake } = makeStorage({
			rosterRows: [{ id: "agent-self" }, { id: "agent-peer" }],
			authorizedIds: ["m_peerglobal", "m_own"],
		});
		const q = query({ scope: scope({ agentId: "agent-self", readPolicy: "group", policyGroup: "team-blue" }) });
		const authorized = await authorizationPhase(pool(["m_peerglobal", "m_own", "m_outsider"]), q, deps({ storage }));

		// The roster lookup ran, scoped to the same policy_group + read_policy = group.
		const roster = fake.requests.find((r) => /FROM\s+"agents"/i.test(r.sql));
		expect(roster, "a roster lookup must run for a group agent").toBeDefined();
		expect(roster?.sql).toMatch(/policy_group = 'team-blue'/);
		expect(roster?.sql).toMatch(/read_policy = 'group'/);
		expect(roster?.workspace).toBe(WORKSPACE);

		// The compiled clause renders the group arm: global from the resolved peers + own.
		const req = fake.requests.find((r) => /FROM\s+"memories"/i.test(r.sql));
		expect(req?.sql).toMatch(/visibility = 'global' AND agent_id IN \('agent-self', 'agent-peer'\)/);
		expect(req?.sql).toMatch(/OR agent_id = 'agent-self'/);
		expect(req?.sql).toMatch(/is_deleted = 0/);
		expect(authorized.context.clause.policyApplied).toBe("group");
		// Group-global peer + own survive; the outsider is dropped.
		expect(authorized.candidates.map((c) => c.id).sort()).toEqual(["m_own", "m_peerglobal"]);
	});

	it("a group agent with NO resolved peers degrades to own-only (fail-closed, never wider)", async () => {
		const { storage, fake } = makeStorage({ rosterRows: [], authorizedIds: ["m_own"] });
		const q = query({ scope: scope({ agentId: "agent-self", readPolicy: "group", policyGroup: "team-empty" }) });
		const authorized = await authorizationPhase(pool(["m_own", "m_peerglobal"]), q, deps({ storage }));

		const req = fake.requests.find((r) => /FROM\s+"memories"/i.test(r.sql));
		// No peers resolved → the clause is own-only, NOT a wider global IN list.
		expect(req?.sql).toMatch(/\(agent_id = 'agent-self' AND is_deleted = 0\)/);
		expect(req?.sql).not.toMatch(/visibility = 'global'/);
		expect(authorized.candidates.map((c) => c.id)).toEqual(["m_own"]);
	});
});

// ── c-AC-4 ──────────────────────────────────────────────────────────────────

describe("c-AC-4 an unauthorized candidate is dropped before any content loads", () => {
	it("a candidate the scoped re-query does not return is removed, and authorization returns IDs only", async () => {
		// Pool has m_ok (authorized) + m_evil (a strong vector hit the store will NOT authorize).
		const { storage, fake } = makeStorage({ authorizedIds: ["m_ok"] });
		const q = query({ scope: scope({ agentId: "agent-self", readPolicy: "isolated" }) });
		const evilPool: MergedPool = {
			candidates: [
				{ id: "m_ok", scores: { fts: 0.3 }, provenance: ["fts"] },
				{ id: "m_evil", scores: { vector: 0.99 }, provenance: ["vector"] },
			],
			degraded: false,
		};
		const authorized = await authorizationPhase(evilPool, q, deps({ storage }));

		// The unauthorized high-score candidate is dropped.
		expect(authorized.candidates.map((c) => c.id)).toEqual(["m_ok"]);
		expect(authorized.candidates.some((c) => c.id === "m_evil")).toBe(false);
		// IDs only — the surviving candidate is the IDs-only shape (no content field).
		for (const c of authorized.candidates) {
			expect(Object.keys(c).sort()).toEqual(["id", "provenance", "scores"]);
		}
		// No content column was ever loaded in authorization.
		for (const req of fake.requests) expect(req.sql).not.toMatch(/\bcontent\b/i);
	});

	it("an empty candidate pool authorizes nothing and never emits a memory re-query", async () => {
		const { storage, fake } = makeStorage({ authorizedIds: ["anything"] });
		const authorized = await authorizationPhase(pool([]), query(), deps({ storage }));
		expect(authorized.candidates).toEqual([]);
		// No `IN ()` is ever emitted — the phase short-circuits.
		expect(fake.requests.some((r) => /FROM\s+"memories"/i.test(r.sql))).toBe(false);
	});
});

// ── c-AC-5 ──────────────────────────────────────────────────────────────────

describe("c-AC-5 a malformed agent id → isolated + structured error, never a wider policy", () => {
	it("a blank agent id fails closed to isolated, surfaces a structured error, and never widens to shared/group", async () => {
		const { storage, fake } = makeStorage({ authorizedIds: ["m_own"] });
		const log = recordingLogger();
		// The caller REQUESTED `shared` but the agent id is blank → must fail closed.
		const q = query({ scope: scope({ agentId: "   ", readPolicy: "shared" }) });
		const authorized = await authorizationPhase(pool(["m_own"]), q, deps({ storage, logger: log.event }));

		// The applied policy is isolated, NOT the requested shared.
		expect(authorized.context.clause.policyApplied).toBe("isolated");
		expect(authorized.context.clause.error).toBeDefined();
		expect(authorized.context.clause.error?.org).toBe(ORG);
		expect(authorized.context.clause.error?.workspace).toBe(WORKSPACE);
		expect(authorized.context.clause.error?.reason).toMatch(/agent id/i);
		// The emitted SQL is the safe isolated fragment — NEVER a `visibility = 'global'` widening.
		const req = fake.requests.find((r) => /FROM\s+"memories"/i.test(r.sql));
		expect(req?.sql).not.toMatch(/visibility = 'global'/);
		// The fail-closed event was surfaced (not swallowed), with the route context.
		const event = log.events.find((e) => e.name === "recall.authz_fail_closed");
		expect(event, "the fail-closed event must be surfaced").toBeDefined();
		expect(event?.fields?.route).toBe("recall");
	});

	it("an unknown read policy also fails closed to isolated with a structured error", async () => {
		const { storage } = makeStorage({ authorizedIds: ["m_own"] });
		const q = query({ scope: { ...scope(), readPolicy: "superuser" as unknown as RecallScope["readPolicy"] } });
		const authorized = await authorizationPhase(pool(["m_own"]), q, deps({ storage }));
		expect(authorized.context.clause.policyApplied).toBe("isolated");
		expect(authorized.context.clause.error?.reason).toMatch(/unknown read policy/i);
	});
});

// ── c-AC-6 ──────────────────────────────────────────────────────────────────

describe("c-AC-6 the storage partition excludes a cross-workspace id even with a buggy inner clause", () => {
	it("a candidate that only exists in another workspace never surfaces, because the partition reaches the wire", async () => {
		// The backing store: workspace ws-main authorizes ONLY m_here; the cross-workspace id
		// m_elsewhere lives in ws-other. Even if the inner clause matched it, the partition
		// (the workspace reaching `storage.query`) is what bounds the result.
		const { storage, fake } = makeStorage({
			authorizedByWorkspace: {
				"ws-main": ["m_here"],
				"ws-other": ["m_elsewhere"],
			},
			authorizedIds: [],
		});
		const q = query({ scope: scope({ workspace: "ws-main", agentId: "agent-self", readPolicy: "isolated" }) });
		const authorized = await authorizationPhase(pool(["m_here", "m_elsewhere"]), q, deps({ storage }));

		// The re-query reached the wire under the ws-main partition (the OUTER ring).
		const req = fake.requests.find((r) => /FROM\s+"memories"/i.test(r.sql));
		expect(req?.workspace).toBe("ws-main");
		// The cross-workspace id is excluded by the partition, never surfaces.
		expect(authorized.candidates.map((c) => c.id)).toEqual(["m_here"]);
		expect(authorized.candidates.some((c) => c.id === "m_elsewhere")).toBe(false);
	});
});

// ── c-AC-7 ──────────────────────────────────────────────────────────────────

describe("c-AC-7 the VFS browse path applies the same scope clause before any content returns", () => {
	it("authorizeBrowse compiles the same clause and SELECTs ids under the partition, no content", async () => {
		const { storage, fake } = makeStorage({ authorizedIds: ["b1", "b2"] });
		const result = await authorizeBrowse(
			scope({ agentId: "agent-self", readPolicy: "isolated" }),
			deps({ storage }),
			{ project: "honeycomb" },
		);
		const req = fake.requests.find((r) => /FROM\s+"memories"/i.test(r.sql));
		expect(req, "the browse path must issue a scoped memory query").toBeDefined();
		// SAME clause builder — isolated own-only, archived excluded — IDs only, no content.
		expect(req?.sql).toMatch(/SELECT\s+id\s+AS\s+id/i);
		expect(req?.sql).not.toMatch(/\bcontent\b/i);
		expect(req?.sql).toMatch(/\(agent_id = 'agent-self' AND is_deleted = 0\)/);
		expect(req?.sql).toMatch(/project = 'honeycomb'/);
		// Under the partition (the OUTER ring).
		expect(req?.workspace).toBe(WORKSPACE);
		// IDs returned for the authorized rows; the clause is handed back for the content load.
		expect(result.ids.sort()).toEqual(["b1", "b2"]);
		expect(result.clause.policyApplied).toBe("isolated");
	});

	it("the browse SQL carries the read-policy clause (no candidate IN — it enumerates the authorized set)", () => {
		const clause = buildScopeClause({ agentId: "agent-self", readPolicy: "shared", org: ORG, workspace: WORKSPACE });
		const sql = buildBrowseAuthorizationSql({ clause });
		// The clause is present; there is no `IN (…)` (browse lists, it doesn't filter a pool).
		expect(sql).toMatch(/WHERE\s*\(\(visibility = 'global' OR agent_id = 'agent-self'\) AND is_deleted = 0\)/);
		expect(sql).not.toMatch(/\bIN\s*\(/i);
	});
});

// ── Builder-level SQL-safety adversarial checks ──────────────────────────────

describe("authorization SQL safety — every value escaped, no early quote close", () => {
	it("an injection-shaped candidate id is escaped in the IN list (cannot close the literal early)", () => {
		const clause = buildScopeClause({ agentId: "agent-self", readPolicy: "isolated", org: ORG, workspace: WORKSPACE });
		const sql = buildAuthorizationSql({ candidateIds: ["m1", "'); DROP TABLE memories; --"], clause, filters: undefined });
		expect(sql).not.toBeNull();
		// The embedded quote is doubled by sLiteral, so the payload collapses to ONE inert
		// literal: the `'` cannot close the string early, so no second statement is produced.
		expect(sql).toContain("'''); DROP TABLE memories; --'");
		// The whole statement is still exactly one SELECT — the injection never split it.
		expect((sql?.match(/SELECT/gi) ?? []).length).toBe(1);
		// The candidate IN list is a single balanced literal group — the `')` from the
		// payload did NOT close the IN list (which would leave `DROP …` as live SQL).
		expect(sql).not.toMatch(/IN \('m1', ''\); DROP/);
	});

	it("an injection-shaped tag filter is escaped for both the literal and the LIKE wildcards", () => {
		const conjuncts = buildFilterConjuncts({ tag: "a%b_c'; --" });
		// `sqlLike` doubles the quote AND escapes `%`/`_` so the tag can't widen the match.
		expect(conjuncts).toContain("''");
		expect(conjuncts).toMatch(/a\\%b\\_c/);
	});

	it("the roster lookup escapes the policy group value", () => {
		const sql = buildGroupMembersSql("team'; DROP TABLE agents; --");
		// The embedded quote is doubled → the payload is one inert literal, never a second
		// statement. The `policy_group = '…'` literal stays balanced and closed by sLiteral.
		expect(sql).toContain("policy_group = 'team''; DROP TABLE agents; --'");
		expect((sql.match(/SELECT/gi) ?? []).length).toBe(1);
	});
});
