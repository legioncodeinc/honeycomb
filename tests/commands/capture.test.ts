/**
 * PRD-079b (b-AC-4) — the `honeycomb capture drain` thin-client verb.
 *
 * Proves the verb is a THIN CLIENT routed through the {@link DaemonClient} seam:
 *   - `capture drain` POSTs to `/api/diagnostics/capture-drain` (the force-drain trigger seam) with
 *     NO body, and renders the daemon's `{ drained, retried, deadLettered }` counts — never SQL,
 *     never DeepLake.
 *   - a non-2xx daemon status exits 1 cleanly.
 *   - READ-THROUGH FAIL-SOFT: a daemon-down (send rejects) path reports cleanly and exits 1, never
 *     throws.
 *   - the verb is wired into the dispatcher: a parsed `capture` invocation routes to the handler and
 *     reaches the daemon seam exactly once (no DeepLake import — enforced by the `src/commands`
 *     NON_DAEMON_ROOT invariant test).
 *
 * Every case drives an injected {@link FakeDaemonClient} (mirrors maintenance.test.ts) — no socket,
 * no live daemon, no live DeepLake.
 */

import { describe, expect, it } from "vitest";

import {
	CAPTURE_DRAIN_ENDPOINT,
	type CommandDeps,
	createDispatcher,
	createFakeDaemonClient,
	type DaemonClient,
	type DaemonRequest,
	runCaptureVerb,
} from "../../src/commands/index.js";

/** Collect a handler's output lines for assertion. */
function withSink(): { out: (line: string) => void; lines: string[] } {
	const lines: string[] = [];
	return { out: (line: string) => lines.push(line), lines };
}

/** A canned drain summary the daemon returns (drained + retried + dead-lettered counts). */
const DRAIN_BODY = { ok: true, drained: 4, retried: 2, deadLettered: 1 } as const;

describe("PRD-079b b-AC-4 — `honeycomb capture drain` routes through the daemon seam", () => {
	it("capture drain POSTs to /api/diagnostics/capture-drain with NO body and renders the counts", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/diagnostics/capture-drain": { status: 200, body: DRAIN_BODY } },
		});
		const { out, lines } = withSink();
		const deps: CommandDeps = { daemon, out };

		const res = await runCaptureVerb(["drain"], deps);

		expect(res.exitCode).toBe(0);
		expect(daemon.calls).toHaveLength(1);
		const call = daemon.calls[0]!.req;
		expect(call.method).toBe("POST");
		expect(call.path).toBe(CAPTURE_DRAIN_ENDPOINT);
		expect(call.body).toBeUndefined();
		// The render surfaces the three counts the operator asked to see.
		const text = lines.join("\n");
		expect(text).toMatch(/4 drained/);
		expect(text).toMatch(/2 retried/);
		expect(text).toMatch(/1 dead-lettered/);
	});

	it("the CLI dispatches INTENT (route only), never SQL", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/diagnostics/capture-drain": { status: 200, body: DRAIN_BODY } },
		});
		await runCaptureVerb(["drain"], { daemon, out: () => {} });
		expect(JSON.stringify(daemon.calls[0]!.req)).not.toMatch(/SELECT|INSERT|DELETE|FROM/i);
	});

	it("a non-2xx daemon status renders an error and exits 1", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/diagnostics/capture-drain": { status: 500, body: {} } },
		});
		const { out, lines } = withSink();
		const res = await runCaptureVerb(["drain"], { daemon, out });
		expect(res.exitCode).toBe(1);
		expect(lines.join("\n")).toMatch(/error/i);
	});

	it("read-through fail-soft: a daemon-down (send rejects) path reports cleanly and never throws", async () => {
		// A client whose `send` REJECTS (the daemon is down / the socket refused) — the handler must
		// catch it, print a clean one-liner, and exit 1 without letting the rejection escape.
		const downDaemon: DaemonClient = {
			async send(_req: DaemonRequest): Promise<never> {
				throw new Error("ECONNREFUSED 127.0.0.1:3850");
			},
			async ping(): Promise<boolean> {
				return false;
			},
		};
		const { out, lines } = withSink();
		const res = await runCaptureVerb(["drain"], { daemon: downDaemon, out });
		expect(res.exitCode).toBe(1);
		expect(lines.join("\n")).toMatch(/could not reach the daemon/i);
		// No secret leaked in the clean error line.
		expect(lines.join("\n")).not.toMatch(/token|secret|bearer|authorization/i);
	});

	it("an unknown subcommand prints usage (exit 1) and never hits the daemon", async () => {
		const daemon = createFakeDaemonClient();
		const res = await runCaptureVerb(["bogus"], { daemon, out: () => {} });
		expect(res.exitCode).toBe(1);
		expect(daemon.calls).toHaveLength(0);
	});

	it("an empty subcommand prints usage (exit 0) and never hits the daemon", async () => {
		const daemon = createFakeDaemonClient();
		const res = await runCaptureVerb([], { daemon, out: () => {} });
		expect(res.exitCode).toBe(0);
		expect(daemon.calls).toHaveLength(0);
	});
});

describe("PRD-079b b-AC-4 — dispatcher wiring", () => {
	it("the dispatcher routes `capture drain` to the daemon seam exactly once", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/diagnostics/capture-drain": { status: 200, body: DRAIN_BODY } },
		});
		const dispatcher = createDispatcher();
		const inv = dispatcher.parse(["capture", "drain"]);
		expect(inv.verb).toBe("capture");
		const res = await dispatcher.dispatch(inv, { daemon, out: () => {} });
		expect(res.exitCode).toBe(0);
		expect(daemon.calls).toHaveLength(1);
		expect(daemon.calls[0]!.req.path).toBe(CAPTURE_DRAIN_ENDPOINT);
		expect(daemon.calls[0]!.req.body).toBeUndefined();
	});
});
