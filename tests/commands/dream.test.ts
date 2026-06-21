/**
 * PRD-026 Wave 2a — the `honeycomb dream` thin-client verb (Deliverable 3).
 *
 * Proves the verb is a THIN CLIENT routed through the {@link DaemonClient} seam:
 *   - `dream trigger` POSTs to `/api/diagnostics/dream` (the "Dream now" trigger seam) with
 *     NO body, and renders the daemon's ack — never SQL, never DeepLake.
 *   - `dream trigger --compact` carries `{mode:"compaction"}` so the daemon enqueues a
 *     full-graph compaction pass.
 *   - the three ack shapes (`enqueued` / `running` / `skipped`+`disabled`) each render a
 *     distinct human line, and a non-2xx daemon status exits 1.
 *   - the verb is wired into the dispatcher: a parsed `dream` invocation routes to the handler
 *     and reaches the daemon seam exactly once (no DeepLake import — enforced by the
 *     `src/commands` NON_DAEMON_ROOT invariant test).
 *
 * Every case drives an injected {@link FakeDaemonClient} (mirrors storage-handlers.test.ts) — no
 * socket, no live daemon, no model.
 */

import { describe, expect, it } from "vitest";

import {
	type CommandDeps,
	createDispatcher,
	createFakeDaemonClient,
	DREAM_ENDPOINT,
	parseDreamCliArgs,
	runDreamVerb,
} from "../../src/commands/index.js";

/** Collect a handler's output lines for assertion. */
function withSink(): { out: (line: string) => void; lines: string[] } {
	const lines: string[] = [];
	return { out: (line: string) => lines.push(line), lines };
}

describe("PRD-026 D-3 — `honeycomb dream trigger` routes through the daemon seam", () => {
	it("dream trigger POSTs to /api/diagnostics/dream with NO body and renders the enqueued ack", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/diagnostics/dream": { status: 202, body: { triggered: true, status: "enqueued" } } },
		});
		const { out, lines } = withSink();
		const deps: CommandDeps = { daemon, out };

		const res = await runDreamVerb(["trigger"], deps);

		expect(res.exitCode).toBe(0);
		expect(daemon.calls).toHaveLength(1);
		const call = daemon.calls[0]!.req;
		expect(call.method).toBe("POST");
		expect(call.path).toBe(DREAM_ENDPOINT);
		// No `--compact` → no mode body; the daemon picks the mode.
		expect(call.body).toBeUndefined();
		expect(lines.join("\n")).toMatch(/enqueued/i);
	});

	it("dream trigger --compact carries {mode:'compaction'} so the daemon enqueues a full-graph pass", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/diagnostics/dream": { status: 202, body: { triggered: true, status: "enqueued" } } },
		});
		const deps: CommandDeps = { daemon, out: () => {} };

		await runDreamVerb(["trigger", "--compact"], deps);

		const call = daemon.calls[0]!.req;
		expect(call.body).toEqual({ mode: "compaction" });
		// The CLI dispatches INTENT (route + mode), never SQL.
		expect(JSON.stringify(call.body)).not.toMatch(/SELECT|INSERT|DELETE|FROM/i);
	});

	it("the running ack (a pass already pending / below threshold) renders the loop-healthy line", async () => {
		const daemon = createFakeDaemonClient({
			responses: {
				"POST /api/diagnostics/dream": { status: 202, body: { triggered: true, status: "running", reason: "pending" } },
			},
		});
		const { out, lines } = withSink();
		const res = await runDreamVerb(["trigger"], { daemon, out });
		expect(res.exitCode).toBe(0);
		expect(lines.join("\n")).toMatch(/no new pass/i);
		expect(lines.join("\n")).toMatch(/pending/);
	});

	it("the disabled ack (master switch off) renders skipped + points at the enable knob", async () => {
		const daemon = createFakeDaemonClient({
			responses: {
				"POST /api/diagnostics/dream": { status: 202, body: { triggered: false, status: "skipped", reason: "disabled" } },
			},
		});
		const { out, lines } = withSink();
		const res = await runDreamVerb(["trigger"], { daemon, out });
		expect(res.exitCode).toBe(0);
		const text = lines.join("\n");
		expect(text).toMatch(/skipped/i);
		expect(text).toMatch(/HONEYCOMB_DREAMING_ENABLED/);
	});

	it("a non-2xx daemon status renders an error and exits 1", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/diagnostics/dream": { status: 500, body: {} } },
		});
		const { out, lines } = withSink();
		const res = await runDreamVerb(["trigger"], { daemon, out });
		expect(res.exitCode).toBe(1);
		expect(lines.join("\n")).toMatch(/error/i);
	});

	it("an unknown subcommand prints usage (exit 1) and never hits the daemon", async () => {
		const daemon = createFakeDaemonClient();
		const res = await runDreamVerb(["bogus"], { daemon, out: () => {} });
		expect(res.exitCode).toBe(1);
		expect(daemon.calls).toHaveLength(0);
	});

	it("the ack render carries no token/secret/header value (AC-6, grep-proven)", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/diagnostics/dream": { status: 202, body: { triggered: true, status: "enqueued" } } },
		});
		const { out, lines } = withSink();
		await runDreamVerb(["trigger"], { daemon, out });
		expect(lines.join("\n")).not.toMatch(/token|secret|bearer|authorization|x-honeycomb/i);
	});
});

describe("PRD-026 D-3 — parse + dispatcher wiring", () => {
	it("parseDreamCliArgs reads the subcommand + --compact preference", () => {
		expect(parseDreamCliArgs(["trigger"])).toEqual({ subCommand: "trigger", compact: false });
		expect(parseDreamCliArgs(["trigger", "--compact"])).toEqual({ subCommand: "trigger", compact: true });
		expect(parseDreamCliArgs(["--compact", "trigger"])).toEqual({ subCommand: "trigger", compact: true });
		expect(parseDreamCliArgs([])).toEqual({ subCommand: "", compact: false });
	});

	it("the dispatcher routes `dream` to the daemon seam exactly once", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/diagnostics/dream": { status: 202, body: { triggered: true, status: "enqueued" } } },
		});
		const dispatcher = createDispatcher();
		const inv = dispatcher.parse(["dream", "trigger", "--compact"]);
		expect(inv.verb).toBe("dream");
		const res = await dispatcher.dispatch(inv, { daemon, out: () => {} });
		expect(res.exitCode).toBe(0);
		expect(daemon.calls).toHaveLength(1);
		expect(daemon.calls[0]!.req.path).toBe(DREAM_ENDPOINT);
		expect(daemon.calls[0]!.req.body).toEqual({ mode: "compaction" });
	});
});
