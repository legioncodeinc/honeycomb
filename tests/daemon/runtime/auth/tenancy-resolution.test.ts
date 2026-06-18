/**
 * PRD-011a — org/workspace partition resolution + isolation (each AC-named).
 *
 * a-AC-1 the resolved org is sent and the workspace is part of the storage PATH
 *        (the QueryScope), so cross-workspace reads are impossible.
 * a-AC-2 a recall in workspace A with its API filter deliberately removed reaches
 *        no row/partition/index of workspace B — because the workspace is the
 *        PARTITION (QueryScope), not a WHERE-clause value, the SQL never names B at
 *        all, so removing an API filter cannot widen across the partition.
 *
 * The proof is structural: the workspace lives in the storage-path `QueryScope`
 * every `storage.query(sql, scope)` carries, NOT in the interpolated SQL. We resolve
 * the tenancy for workspace A and assert (1) the scope names A, and (2) the recall
 * authorization SQL the engine emits — built WITHOUT any per-call workspace filter —
 * contains no workspace token at all, so the only thing scoping it to A is the
 * partition the resolver produced. (The live partition isolation is additionally
 * proven against a real backend by recall-authz-live.itest.ts.)
 */

import { describe, expect, it } from "vitest";

import {
	type Credentials,
	encodeStubToken,
	resolveRequestTenancy,
} from "../../../../src/daemon/runtime/auth/index.js";
import { buildAuthorizationSql, buildScopeClause } from "../../../../src/daemon/runtime/recall/index.js";

function credsFor(org: string, workspace: string): Credentials {
	return {
		token: encodeStubToken({ org }),
		orgId: org,
		orgName: `${org} Inc`,
		workspace,
		agentId: "agent-a",
		savedAt: "2026-06-17T00:00:00.000Z",
	};
}

describe("a-AC-1 resolved org is sent and the workspace is part of the storage path", () => {
	it("resolves the QueryScope to the org + workspace partition", () => {
		const r = resolveRequestTenancy({ credentials: credsFor("acme", "workspace-a"), env: {} });
		expect(r.kind).toBe("ok");
		if (r.kind !== "ok") return;
		expect(r.tenancy.scope.org).toBe("acme");
		expect(r.tenancy.scope.workspace).toBe("workspace-a");
		expect(r.tenancy.agentId).toBe("agent-a");
	});

	it("fails closed (denied) when no credentials resolve", () => {
		const r = resolveRequestTenancy({ credentials: null, env: {} });
		expect(r.kind).toBe("denied");
	});

	it("fails closed (denied) when the file orgId disagrees with the token claim", () => {
		const tampered = credsFor("acme", "workspace-a");
		const r = resolveRequestTenancy({
			credentials: { ...tampered, orgId: "evilcorp" },
			env: {},
		});
		expect(r.kind).toBe("denied");
		if (r.kind !== "denied") return;
		expect(r.fileOrg).toBe("evilcorp");
		expect(r.tokenOrg).toBe("acme");
	});
});

describe("a-AC-2 cross-workspace reads are impossible even with the API filter removed", () => {
	it("the workspace is the partition (QueryScope), never a value in the recall SQL", () => {
		// Resolve workspace A.
		const a = resolveRequestTenancy({ credentials: credsFor("acme", "workspace-a"), env: {} });
		const b = resolveRequestTenancy({ credentials: credsFor("acme", "workspace-b"), env: {} });
		expect(a.kind).toBe("ok");
		expect(b.kind).toBe("ok");
		if (a.kind !== "ok" || b.kind !== "ok") return;

		// The ONLY difference between an A-scoped and a B-scoped query is the partition
		// the storage layer applies beneath the SQL — the scopes differ by workspace.
		expect(a.tenancy.scope.workspace).toBe("workspace-a");
		expect(b.tenancy.scope.workspace).toBe("workspace-b");
		expect(a.tenancy.scope.workspace).not.toBe(b.tenancy.scope.workspace);

		// Build the recall authorization SQL the engine emits for agent A, with NO
		// caller (API) filter at all — the deliberately-removed-filter case.
		const clause = buildScopeClause({
			agentId: "agent-a",
			readPolicy: "isolated",
			org: a.tenancy.scope.org,
			workspace: a.tenancy.scope.workspace,
		});
		const sql = buildAuthorizationSql({
			candidateIds: ["m1", "m2"],
			clause,
			filters: undefined,
		});
		expect(sql).not.toBeNull();
		// The SQL names neither workspace — the partition is NOT a WHERE value. So even
		// with the API filter removed, the statement cannot address workspace B; only
		// the QueryScope partition decides which workspace's data the read touches.
		expect(sql).not.toContain("workspace-a");
		expect(sql).not.toContain("workspace-b");
	});
});
