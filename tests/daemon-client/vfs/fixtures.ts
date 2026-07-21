/**
 * Shared test fixtures for the PRD-015a VFS suite.
 *
 * A real (minimal) codebase-graph {@link Snapshot} the graph bridge renders, plus row
 * builders for the `memory` / `sessions` tables the dispatch fake answers with. No live
 * backend, no network — every test drives the module against a FAKE `DaemonDispatch` and
 * this in-memory snapshot.
 */

import type { Snapshot } from "../../../src/daemon/runtime/codebase/contracts.js";
import type { Row, VfsScope } from "../../../src/daemon-client/vfs/index.js";

/** A canonical test scope (org/workspace/agent_id) asserted on every dispatch. */
export const SCOPE: VfsScope = { org: "acme", workspace: "default", agentId: "agent-1" };

/**
 * A minimal but VALID snapshot: two file nodes + one symbol + one import link, enough for
 * `handleGraphVfs` to render `index.md`, `find/`, etc. — entirely in memory, zero network.
 */
export const FIXTURE_SNAPSHOT: Snapshot = {
	directed: true,
	multigraph: true,
	graph: { org: "acme", workspace: "default", repo: "honeycomb", commit: "commit-abc" },
	nodes: [
		{
			id: "src/a.ts",
			kind: "file",
			name: "a.ts",
			sourceFile: "src/a.ts",
			language: "typescript",
			observation: { startLine: 1, endLine: 40 },
		},
		{
			id: "src/b.ts",
			kind: "file",
			name: "b.ts",
			sourceFile: "src/b.ts",
			language: "typescript",
			observation: { startLine: 1, endLine: 20 },
		},
		{
			id: "src/a.ts#doThing",
			kind: "symbol",
			name: "doThing",
			sourceFile: "src/a.ts",
			language: "typescript",
			symbolKind: "function",
			exported: true,
			observation: { startLine: 3, endLine: 10 },
		},
	],
	links: [
		{
			source: "src/a.ts",
			target: "src/b.ts",
			relation: "imports",
			confidence: "EXTRACTED",
			id: "src/a.ts:imports:0",
		},
	],
	observation: {
		generatedAt: "2026-06-18T00:00:00.000Z",
		generatorVersion: "014b.1",
		fileCount: 2,
		nodeCount: 3,
		edgeCount: 1,
		parseErrorCount: 0,
	},
};

/** A `memory` summary row keyed by path. */
export function memoryRow(path: string, summary: string): Row {
	return { path, summary };
}

/** A `sessions` message row (the JSONB `message` column carries the event line). */
export function sessionRow(message: string): Row {
	return { message };
}

/**
 * A `sessions` staleness-probe row: `count(*)` + `max(creation_date)`. Answers the cheap
 * token probe the session cache dispatches before deciding whether to re-fetch the payload.
 */
export function sessionProbeRow(n: number, hwm: string): Row {
	return { n, hwm };
}

/**
 * Answer the session dispatch pair from ONE `respond`: the count/max probe SQL gets a
 * {@link sessionProbeRow}; the `message` concat SQL gets `rows`; everything else gets `[]`.
 */
export function respondSession(n: number, hwm: string, rows: readonly Row[]): (sql: string) => readonly Row[] {
	return (sql: string) => {
		if (sql.includes("count(*)") && sql.includes('FROM "sessions"')) return [sessionProbeRow(n, hwm)];
		if (sql.includes('FROM "sessions"')) return rows;
		return [];
	};
}
