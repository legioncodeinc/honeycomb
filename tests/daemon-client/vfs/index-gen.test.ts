/**
 * PRD-015a a-AC-5 — `generateVirtualIndex`.
 *
 * No `/index.md` row + the mount root is read → a TWO-SECTION table (recent memories +
 * recent sessions), each section CAPPED at 50 rows with a per-section TRUNCATION NOTICE
 * pointing the agent at Grep. Every row reaches storage through the dispatch seam.
 */

import { describe, expect, it } from "vitest";

import {
	createFakeDaemonDispatch,
	createFakeSnapshotLoader,
	DeepLakeFs,
	generateVirtualIndex,
	INDEX_SECTION_LIMIT,
	type Row,
} from "../../../src/daemon-client/vfs/index.js";
import { memoryRow, SCOPE, sessionRow } from "./fixtures.js";

/**
 * Respond with `count` memory rows + `count` session rows for the INDEX-GEN section SELECTs
 * (the recent-memories / recent-sessions queries), but answer the tier-2 single-path probe
 * (`WHERE path = 'index.md'`) with NO rows — so a synthesized index is what gets rendered.
 */
function rowsResponder(memCount: number, sessCount: number) {
	return (sql: string): readonly Row[] => {
		// The tier-2 "is there a real index row?" probe — answer empty (no real row).
		if (sql.includes('FROM "memory"') && sql.includes("WHERE path =")) return [];
		if (sql.includes('FROM "memory"')) {
			return Array.from({ length: memCount }, (_v, i) => memoryRow(`m/${i}.md`, `summary ${i}`));
		}
		if (sql.includes('FROM "sessions"')) {
			return Array.from({ length: sessCount }, (_v, i) => sessionRow(`s/${i}.md`));
		}
		return [];
	};
}

describe("a-AC-5 generateVirtualIndex: two-section table ≤50 rows each + truncation", () => {
	it("a-AC-5 renders both sections with headers", async () => {
		const dispatch = createFakeDaemonDispatch({ respond: rowsResponder(2, 2) });
		const body = await generateVirtualIndex(dispatch, SCOPE);
		expect(body).toContain("## Recent memories");
		expect(body).toContain("## Recent sessions");
		expect(body).toContain("summary 0");
	});

	it("a-AC-5 caps each section at 50 rows and appends a truncation notice when more exist", async () => {
		// Respond with 51 of each (the cap + 1 → "more available").
		const dispatch = createFakeDaemonDispatch({ respond: rowsResponder(51, 51) });
		const body = await generateVirtualIndex(dispatch, SCOPE);
		// Only the 50th index (m/49.md) renders; the 51st (m/50.md) is dropped.
		expect(body).toContain("m/49.md");
		expect(body).not.toContain("m/50.md");
		// A truncation notice points at Grep (once per truncated section).
		const notices = body.match(/Use Grep over the mount to search the rest/g) ?? [];
		expect(notices).toHaveLength(2);
	});

	it("a-AC-5 no truncation notice when a section fits under the cap", async () => {
		const dispatch = createFakeDaemonDispatch({ respond: rowsResponder(3, 3) });
		const body = await generateVirtualIndex(dispatch, SCOPE);
		expect(body).not.toContain("Use Grep over the mount to search the rest");
	});

	it("a-AC-5 fetches one over the cap (LIMIT 51) so 'more available' needs no COUNT round-trip", async () => {
		const dispatch = createFakeDaemonDispatch({ respond: rowsResponder(0, 0) });
		await generateVirtualIndex(dispatch, SCOPE);
		for (const call of dispatch.calls) {
			expect(call.sql).toContain(`LIMIT ${INDEX_SECTION_LIMIT + 1}`);
		}
	});

	it("a-AC-5 the sessions section groups by path (DeepLake NULL-SUM workaround)", async () => {
		const dispatch = createFakeDaemonDispatch({ respond: rowsResponder(0, 0) });
		await generateVirtualIndex(dispatch, SCOPE);
		const sessionsSql = dispatch.calls.find((c) => c.sql.includes('FROM "sessions"'));
		expect(sessionsSql?.sql).toContain("GROUP BY path");
		expect(sessionsSql?.sql).toContain("MAX(creation_date)");
	});

	it("a-AC-5 / a-AC-1 a REAL /index.md row wins over the synthesized index", async () => {
		// memory read for index.md returns a real row → that body is served, not the synthesized one.
		const dispatch = createFakeDaemonDispatch({
			respond: (sql) =>
				sql.includes('FROM "memory"') && sql.includes("index.md") ? [memoryRow("index.md", "REAL INDEX")] : [],
		});
		const fs = new DeepLakeFs({ dispatch, scope: SCOPE, snapshots: createFakeSnapshotLoader(null) });
		const body = await fs.readFile("index.md");
		expect(body).toBe("REAL INDEX");
		expect(body).not.toContain("## Recent memories");
	});

	it("a-AC-5 with no real row, the mount root synthesizes the two-section index", async () => {
		const dispatch = createFakeDaemonDispatch({ respond: rowsResponder(1, 1) });
		const fs = new DeepLakeFs({ dispatch, scope: SCOPE, snapshots: createFakeSnapshotLoader(null) });
		const body = await fs.readFile("index.md");
		expect(body).toContain("## Recent memories");
		expect(body).toContain("## Recent sessions");
	});
});
