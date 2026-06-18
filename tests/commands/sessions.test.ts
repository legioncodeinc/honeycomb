/**
 * PRD-020a a-AC-2 (CLI side) — `sessions prune` dispatches the paired-delete INTENT.
 *
 * The CLI does NOT delete; it asks the daemon to. This suite proves the CLI dispatches a
 * `DELETE /api/diagnostics/sessions/prune` carrying the `--before` / `--session-id` filter through the
 * `DaemonClient` seam and renders the daemon's paired tombstone counts. The daemon-side proof
 * that traces + summaries are removed TOGETHER (the desync-prevention assertion) lives in
 * `tests/daemon/runtime/sessions/prune.test.ts`.
 */

import { describe, expect, it } from "vitest";

import {
	buildPruneRequest,
	type CommandDeps,
	createFakeDaemonClient,
	parseSessionsArgs,
	runSessionsCommand,
} from "../../src/commands/index.js";

describe("PRD-020a a-AC-2 — sessions prune dispatches the paired-delete intent through the daemon", () => {
	it("a-AC-2 parses --before and --session-id into the prune filter", () => {
		const inv = parseSessionsArgs(["prune", "--before", "2026-01-01", "--session-id", "s-42"]);
		expect(inv).toEqual({ sub: "prune", before: "2026-01-01", sessionId: "s-42" });
	});

	it("a-AC-2 prune builds a DELETE to /api/diagnostics/sessions/prune carrying the filter as query params", () => {
		const req = buildPruneRequest({ sub: "prune", before: "2026-01-01", sessionId: "s-42" });
		expect(req.method).toBe("DELETE");
		expect(req.path).toBe("/api/diagnostics/sessions/prune");
		expect(req.query).toEqual({ before: "2026-01-01", "session-id": "s-42" });
	});

	it("a-AC-2 prune dispatches through the daemon seam and renders the paired tombstone counts", async () => {
		const daemon = createFakeDaemonClient({
			responses: {
				"DELETE /api/diagnostics/sessions/prune": { status: 200, body: { matched: 3, sessionsTombstoned: 3, summariesTombstoned: 3 } },
			},
		});
		const lines: string[] = [];
		const deps: CommandDeps = { daemon, out: (l) => lines.push(l) };
		const res = await runSessionsCommand(parseSessionsArgs(["prune", "--before", "2026-01-01"]), deps);
		expect(res.exitCode).toBe(0);
		// Exactly the prune route was dispatched (no DeepLake), and the pairing is surfaced.
		expect(daemon.calls).toHaveLength(1);
		expect(daemon.calls[0]?.req.path).toBe("/api/diagnostics/sessions/prune");
		expect(lines.join("\n")).toMatch(/Pruned 3 sessions \(3 traces \+ 3 summaries removed, paired\)/);
	});

	it("a-AC-2 a daemon error on prune surfaces a non-zero exit", async () => {
		const daemon = createFakeDaemonClient({ responses: { "DELETE /api/diagnostics/sessions/prune": { status: 400 } } });
		const res = await runSessionsCommand(parseSessionsArgs(["prune", "--before", "2026-01-01"]), { daemon, out: () => {} });
		expect(res.exitCode).toBe(1);
	});
});
