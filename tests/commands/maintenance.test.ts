/**
 * PRD-030 Wave 2a — the `honeycomb maintenance` thin-client verb (Deliverable 2).
 *
 * Proves the verb is a THIN CLIENT routed through the {@link DaemonClient} seam:
 *   - `maintenance compact` POSTs to `/api/diagnostics/compact` (the compaction trigger seam)
 *     with NO body, and renders the daemon's per-table summary — never SQL, never DeepLake.
 *   - `maintenance compact --table skills` carries `{table:"skills"}` so the daemon narrows
 *     the pass to one table.
 *   - the summary render surfaces rows reaped + `keysSkipped` (the transient-flap signal).
 *   - a non-2xx daemon status exits 1.
 *   - the verb is wired into the dispatcher: a parsed `maintenance` invocation routes to the
 *     handler and reaches the daemon seam exactly once (no DeepLake import — enforced by the
 *     `src/commands` NON_DAEMON_ROOT invariant test).
 *
 * Every case drives an injected {@link FakeDaemonClient} (mirrors pollinate.test.ts) — no socket,
 * no live daemon, no live DeepLake.
 */

import { describe, expect, it } from "vitest";

import {
	type CommandDeps,
	createDispatcher,
	createFakeDaemonClient,
	MAINTENANCE_COMPACT_ENDPOINT,
	parseMaintenanceCliArgs,
	runMaintenanceVerb,
} from "../../src/commands/index.js";

/** Collect a handler's output lines for assertion. */
function withSink(): { out: (line: string) => void; lines: string[] } {
	const lines: string[] = [];
	return { out: (line: string) => lines.push(line), lines };
}

/** A canned summary body the daemon returns (one table reaped, one with a flap). */
const SUMMARY_BODY = {
	ok: true,
	summaries: [
		{ table: "skills", keysScanned: 3, keysCompacted: 1, rowsReaped: 7, keysSkipped: 0, errored: 0 },
		{ table: "rules", keysScanned: 2, keysCompacted: 0, rowsReaped: 0, keysSkipped: 1, errored: 0 },
	],
	skippedTables: ["pollinating_state"],
} as const;

describe("PRD-030 D-2 — `honeycomb maintenance compact` routes through the daemon seam", () => {
	it("maintenance compact POSTs to /api/diagnostics/compact with NO body and renders the summary", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/diagnostics/compact": { status: 200, body: SUMMARY_BODY } },
		});
		const { out, lines } = withSink();
		const deps: CommandDeps = { daemon, out };

		const res = await runMaintenanceVerb(["compact"], deps);

		expect(res.exitCode).toBe(0);
		expect(daemon.calls).toHaveLength(1);
		const call = daemon.calls[0]!.req;
		expect(call.method).toBe("POST");
		expect(call.path).toBe(MAINTENANCE_COMPACT_ENDPOINT);
		// No `--table` → no body; the daemon compacts every allow-listed table.
		expect(call.body).toBeUndefined();
		// The render surfaces the per-table rows reaped + the total.
		expect(lines.join("\n")).toMatch(/7 row\(s\) reaped/);
		expect(lines.join("\n")).toMatch(/skills/);
	});

	it("maintenance compact --table skills carries {table:'skills'} so the daemon narrows the pass", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/diagnostics/compact": { status: 200, body: SUMMARY_BODY } },
		});
		const deps: CommandDeps = { daemon, out: () => {} };

		await runMaintenanceVerb(["compact", "--table", "skills"], deps);

		const call = daemon.calls[0]!.req;
		expect(call.body).toEqual({ table: "skills" });
		// The CLI dispatches INTENT (route + selector), never SQL.
		expect(JSON.stringify(call.body)).not.toMatch(/SELECT|INSERT|DELETE|FROM/i);
	});

	it("the --table=name form is parsed identically", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/diagnostics/compact": { status: 200, body: SUMMARY_BODY } },
		});
		await runMaintenanceVerb(["compact", "--table=rules"], { daemon, out: () => {} });
		expect(daemon.calls[0]!.req.body).toEqual({ table: "rules" });
	});

	it("the summary surfaces keysSkipped as the transient-flap signal", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/diagnostics/compact": { status: 200, body: SUMMARY_BODY } },
		});
		const { out, lines } = withSink();
		const res = await runMaintenanceVerb(["compact"], { daemon, out });
		expect(res.exitCode).toBe(0);
		const text = lines.join("\n");
		// `rules` had a key skipped — the operator-facing flap signal + the re-run hint.
		expect(text).toMatch(/1 key\(s\) skipped/i);
		expect(text).toMatch(/re-run converges/i);
	});

	it("an all-zero pass renders an honest 'nothing to compact'", async () => {
		const empty = {
			ok: true,
			summaries: [{ table: "skills", keysScanned: 1, keysCompacted: 0, rowsReaped: 0, keysSkipped: 0, errored: 0 }],
			skippedTables: [],
		};
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/diagnostics/compact": { status: 200, body: empty } },
		});
		const { out, lines } = withSink();
		const res = await runMaintenanceVerb(["compact"], { daemon, out });
		expect(res.exitCode).toBe(0);
		expect(lines.join("\n")).toMatch(/nothing to compact/i);
	});

	it("a non-2xx daemon status renders an error and exits 1", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/diagnostics/compact": { status: 500, body: {} } },
		});
		const { out, lines } = withSink();
		const res = await runMaintenanceVerb(["compact"], { daemon, out });
		expect(res.exitCode).toBe(1);
		expect(lines.join("\n")).toMatch(/error/i);
	});

	it("an unknown subcommand prints usage (exit 1) and never hits the daemon", async () => {
		const daemon = createFakeDaemonClient();
		const res = await runMaintenanceVerb(["bogus"], { daemon, out: () => {} });
		expect(res.exitCode).toBe(1);
		expect(daemon.calls).toHaveLength(0);
	});

	it("an empty subcommand prints usage (exit 0) and never hits the daemon", async () => {
		const daemon = createFakeDaemonClient();
		const res = await runMaintenanceVerb([], { daemon, out: () => {} });
		expect(res.exitCode).toBe(0);
		expect(daemon.calls).toHaveLength(0);
	});

	it("the summary render carries no token/secret/header value (AC-6, grep-proven)", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/diagnostics/compact": { status: 200, body: SUMMARY_BODY } },
		});
		const { out, lines } = withSink();
		await runMaintenanceVerb(["compact"], { daemon, out });
		expect(lines.join("\n")).not.toMatch(/token|secret|bearer|authorization|x-honeycomb/i);
	});
});

describe("PRD-030 D-2 — parse + dispatcher wiring", () => {
	it("parseMaintenanceCliArgs reads the subcommand + --table selector", () => {
		expect(parseMaintenanceCliArgs(["compact"])).toEqual({ subCommand: "compact", table: "" });
		expect(parseMaintenanceCliArgs(["compact", "--table", "skills"])).toEqual({ subCommand: "compact", table: "skills" });
		expect(parseMaintenanceCliArgs(["compact", "--table=rules"])).toEqual({ subCommand: "compact", table: "rules" });
		expect(parseMaintenanceCliArgs(["--table", "skills", "compact"])).toEqual({ subCommand: "compact", table: "skills" });
		expect(parseMaintenanceCliArgs([])).toEqual({ subCommand: "", table: "" });
	});

	it("the dispatcher routes `maintenance` to the daemon seam exactly once", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/diagnostics/compact": { status: 200, body: SUMMARY_BODY } },
		});
		const dispatcher = createDispatcher();
		const inv = dispatcher.parse(["maintenance", "compact", "--table", "skills"]);
		expect(inv.verb).toBe("maintenance");
		const res = await dispatcher.dispatch(inv, { daemon, out: () => {} });
		expect(res.exitCode).toBe(0);
		expect(daemon.calls).toHaveLength(1);
		expect(daemon.calls[0]!.req.path).toBe(MAINTENANCE_COMPACT_ENDPOINT);
		expect(daemon.calls[0]!.req.body).toEqual({ table: "skills" });
	});
});
