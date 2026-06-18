/**
 * PRD-019d codebase cluster conditional registration — d-AC-4.
 *
 * The codebase tools (`honeycomb_code_search/context/blast/impact`) are registered
 * ONLY when the workspace graph is built (`honeycomb graph build`). Before the
 * graph is built they are ABSENT from the tool list; after, they appear. Driven
 * through the real registry + a fake seam (no daemon, no graph build).
 */

import { describe, expect, it } from "vitest";
import {
	type Actor,
	CONDITIONAL_TOOL_NAMES,
	createFakeDaemonApiSeam,
	createMcpServer,
} from "../../mcp/src/index.js";

const ACTOR: Actor = { actor: "agent-1", actorType: "agent" };

describe("d-AC-4: codebase cluster is conditional on the workspace graph build", () => {
	it("d-AC-4 with the graph NOT built, the codebase tools are absent from the surface", () => {
		const daemon = createFakeDaemonApiSeam();
		const handle = createMcpServer({ daemon, actor: ACTOR, graphBuilt: false });
		for (const name of CONDITIONAL_TOOL_NAMES) {
			expect(handle.toolNames, `${name} should be absent before graph build`).not.toContain(name);
		}
		// Sanity: the non-codebase surface is still present.
		expect(handle.toolNames).toContain("memory_search");
	});

	it("d-AC-4 after `honeycomb graph build` (graphBuilt=true), the codebase tools appear", () => {
		const daemon = createFakeDaemonApiSeam();
		const handle = createMcpServer({ daemon, actor: ACTOR, graphBuilt: true });
		for (const name of CONDITIONAL_TOOL_NAMES) {
			expect(handle.toolNames, `${name} should be present after graph build`).toContain(name);
		}
		expect(CONDITIONAL_TOOL_NAMES).toEqual([
			"honeycomb_code_search",
			"honeycomb_code_context",
			"honeycomb_code_blast",
			"honeycomb_code_impact",
		]);
	});

	it("d-AC-4 the default (no flag) is graph-NOT-built — codebase tools absent", () => {
		const daemon = createFakeDaemonApiSeam();
		const handle = createMcpServer({ daemon, actor: ACTOR });
		expect(handle.toolNames).not.toContain("honeycomb_code_search");
	});
});
