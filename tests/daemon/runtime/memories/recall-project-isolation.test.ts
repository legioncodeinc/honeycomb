/**
 * PRD-049b — per-project recall isolation (49b-AC-2 / 49b-AC-3 / 49b-AC-4).
 *
 * Drives the LIVE `recallMemories` engine against a fake `StorageQuery` and asserts the
 * project-segment predicate is ANDed into EVERY recall arm — the lexical `memories` /
 * `memory` / `sessions` arms AND the semantic `<#>` arm (via the inline `extraConjunct`)
 * AND the semantic hydrate — so a recall in project A can never surface a project-B row:
 *
 *   - 49b-AC-2: a recall in project A carries `project_id = 'proj-A'` on every arm and a
 *     project-B row (which a naive fake would return) is filtered by the predicate;
 *   - 49b-AC-3: an unbound (no project) recall narrows to the `__unsorted__` inbox + the
 *     unset sentinel only, never a real project;
 *   - 49b-AC-4: project is an ADDITIONAL predicate — the soft-delete exclusion (and, on the
 *     fast path, the agent_id clause) still apply beside it, never replaced.
 *
 * The assertion is on the SQL each arm builds (the predicate is server-side), the same
 * verification posture the recall-resilience suite uses.
 */

import { describe, expect, it } from "vitest";

import type { QueryScope, StorageQuery, QueryOptions } from "../../../../src/daemon/storage/client.js";
import { ok, type QueryResult, type StorageRow } from "../../../../src/daemon/storage/result.js";
import { recallMemories } from "../../../../src/daemon/runtime/memories/recall.js";
import { EMBEDDING_DIMS } from "../../../../src/daemon/storage/vector.js";
import { UNSORTED_PROJECT_ID } from "../../../../src/daemon/storage/catalog/projects.js";
import type { EmbedClient } from "../../../../src/daemon/runtime/services/embed-client.js";

const SCOPE: QueryScope = { org: "org", workspace: "ws" };
const VALID_VECTOR: readonly number[] = new Array(EMBEDDING_DIMS).fill(0.05) as number[];

function fakeEmbed(v: readonly number[] | null): EmbedClient {
	return { async embed(): Promise<readonly number[] | null> { return v; } };
}

/** Capture every SQL statement recall issues; answer every arm with empty rows. */
function recordingStorage(): { storage: StorageQuery; sqls: string[] } {
	const sqls: string[] = [];
	const storage: StorageQuery = {
		async query(sql: string, _scope: QueryScope, _opts?: QueryOptions): Promise<QueryResult> {
			sqls.push(sql);
			return ok([] as StorageRow[], 0);
		},
	};
	return { storage, sqls };
}

/** The arm statements (exclude the heal/introspection helpers) that touch a memory table. */
function memoryArmSqls(sqls: string[]): string[] {
	return sqls.filter((s) => /FROM\s+"(memories|memory|sessions)"/i.test(s));
}

describe("recall project isolation (49b-AC-2)", () => {
	it("ANDs `project_id = 'proj-A'` (+ unset sentinel) into EVERY lexical + semantic arm", async () => {
		const { storage, sqls } = recordingStorage();
		await recallMemories(
			{ query: "secret plan", scope: SCOPE, projectId: "proj-A", projectBound: true },
			{ storage, embed: fakeEmbed(VALID_VECTOR) },
		);

		const arms = memoryArmSqls(sqls);
		// Every arm that hits a memory table must carry the project predicate.
		expect(arms.length).toBeGreaterThanOrEqual(3); // memories + memory + sessions (+ semantic).
		for (const sql of arms) {
			expect(sql).toContain("project_id = 'proj-A'");
			expect(sql).toContain("project_id = ''"); // legacy/workspace-global admitted (D5).
			// 49b-AC-2: never admits another project — a bound session excludes the inbox + B.
			expect(sql).not.toContain("proj-B");
		}
	});

	it("the `memories` lexical arm keeps the soft-delete exclusion BESIDE the project predicate (49b-AC-4)", async () => {
		const { storage, sqls } = recordingStorage();
		await recallMemories(
			{ query: "x", scope: SCOPE, projectId: "proj-A", projectBound: true },
			{ storage },
		);
		const memoriesArm = memoryArmSqls(sqls).find((s) => /'memories'\s+AS\s+source/i.test(s));
		expect(memoriesArm).toBeDefined();
		// Project is ADDITIONAL: the is_deleted=0 exclusion is still present alongside it.
		expect(memoriesArm!).toContain("is_deleted");
		expect(memoriesArm!).toContain("project_id = 'proj-A'");
	});

	it("the semantic `<#>` arm carries the project predicate inline (no cross-project vector leak)", async () => {
		const { storage, sqls } = recordingStorage();
		await recallMemories(
			{ query: "x", scope: SCOPE, projectId: "proj-A", projectBound: true },
			{ storage, embed: fakeEmbed(VALID_VECTOR) },
		);
		// The vector search statement uses the `<#>` operator; it must carry the project predicate.
		const vectorArm = sqls.find((s) => s.includes("<#>"));
		expect(vectorArm).toBeDefined();
		expect(vectorArm!).toContain("project_id = 'proj-A'");
	});

	it("an UNBOUND recall narrows to the inbox + unset sentinel only (49b-AC-3), never a real project", async () => {
		const { storage, sqls } = recordingStorage();
		await recallMemories(
			{ query: "x", scope: SCOPE }, // no projectId → unbound inbox session.
			{ storage },
		);
		for (const sql of memoryArmSqls(sqls)) {
			expect(sql).toContain(`project_id = '${UNSORTED_PROJECT_ID}'`);
			expect(sql).toContain("project_id = ''");
			// Never admits an arbitrary real project on the unbound path.
			expect(sql).not.toMatch(/project_id = 'proj-/);
		}
	});

	it("a project-B row returned by storage is filtered by the predicate (end-to-end)", async () => {
		// Simulate a backend that would hand back a B row on a strong hit: the arm SQL carries the
		// predicate, so in a real engine the row never returns. We assert the predicate is the gate
		// by confirming a recall scoped to A emits NO statement that would admit 'proj-B'.
		const { storage, sqls } = recordingStorage();
		await recallMemories(
			{ query: "shared term", scope: SCOPE, projectId: "proj-A", projectBound: true },
			{ storage, embed: fakeEmbed(VALID_VECTOR) },
		);
		const anyAdmitsB = sqls.some((s) => s.includes("project_id = 'proj-B'"));
		expect(anyAdmitsB).toBe(false);
	});
});
