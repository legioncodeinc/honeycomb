/**
 * PRD-080b (b-AC-4) — the `honeycomb memory redrive` thin-client verb.
 *
 * Proves the verb is a THIN CLIENT routed through the {@link DaemonClient} seam:
 *   - `memory redrive` POSTs to `/api/diagnostics/memory-redrive` with NO body, and renders the daemon's
 *     `{ redriven, skipped }` counts — never SQL, never DeepLake.
 *   - a non-2xx daemon status exits 1 cleanly.
 *   - READ-THROUGH FAIL-SOFT: a daemon-down (send rejects) path reports cleanly and exits 1, never throws.
 *   - the verb is wired into the dispatcher: a parsed `memory redrive` invocation routes to the handler
 *     and reaches the daemon seam exactly once (no DeepLake import).
 *
 * Every case drives an injected {@link FakeDaemonClient} (mirrors capture.test.ts) — no socket, no live
 * daemon, no live DeepLake.
 */

import { describe, expect, it } from "vitest";

import {
	type CommandDeps,
	createDispatcher,
	createFakeDaemonClient,
	type DaemonClient,
	type DaemonRequest,
	MEMORY_REDRIVE_ENDPOINT,
	runMemoryVerb,
} from "../../src/commands/index.js";

/** Collect a handler's output lines for assertion. */
function withSink(): { out: (line: string) => void; lines: string[] } {
	const lines: string[] = [];
	return { out: (line: string) => lines.push(line), lines };
}

/** A canned re-drive summary the daemon returns (redriven + skipped counts). */
const REDRIVE_BODY = { ok: true, redriven: 5, skipped: 2 } as const;

describe("PRD-080b b-AC-4 — `honeycomb memory redrive` routes through the daemon seam", () => {
	it("memory redrive POSTs to /api/diagnostics/memory-redrive with NO body and renders the counts", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/diagnostics/memory-redrive": { status: 200, body: REDRIVE_BODY } },
		});
		const { out, lines } = withSink();
		const deps: CommandDeps = { daemon, out };

		const res = await runMemoryVerb(["redrive"], deps);

		expect(res.exitCode).toBe(0);
		expect(daemon.calls).toHaveLength(1);
		const call = daemon.calls[0]!.req;
		expect(call.method).toBe("POST");
		expect(call.path).toBe(MEMORY_REDRIVE_ENDPOINT);
		expect(call.body).toBeUndefined();
		const text = lines.join("\n");
		expect(text).toMatch(/5 redriven/);
		expect(text).toMatch(/2 skipped/);
	});

	it("exits 1 cleanly on a non-2xx daemon status", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/diagnostics/memory-redrive": { status: 503, body: {} } },
		});
		const { out, lines } = withSink();

		const res = await runMemoryVerb(["redrive"], { daemon, out });

		expect(res.exitCode).toBe(1);
		expect(lines.join("\n")).toMatch(/error: memory redrive failed \(daemon 503\)/);
	});

	it("is read-through fail-soft: a daemon-down send-reject reports cleanly and exits 1, never throws", async () => {
		const daemon: DaemonClient = {
			async send(_req: DaemonRequest): Promise<never> {
				throw new Error("ECONNREFUSED 127.0.0.1:3850");
			},
			async ping(): Promise<boolean> {
				return false;
			},
		};
		const { out, lines } = withSink();

		const res = await runMemoryVerb(["redrive"], { daemon, out });

		expect(res.exitCode).toBe(1);
		expect(lines.join("\n")).toMatch(/could not reach the daemon/);
	});

	it("routes through the dispatcher: `memory redrive` reaches the daemon seam exactly once", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/diagnostics/memory-redrive": { status: 200, body: REDRIVE_BODY } },
		});
		const { out } = withSink();
		const dispatcher = createDispatcher();

		const res = await dispatcher.dispatch(dispatcher.parse(["memory", "redrive"]), { daemon, out });

		expect(res.exitCode).toBe(0);
		expect(daemon.calls).toHaveLength(1);
		expect(daemon.calls[0]!.req.path).toBe(MEMORY_REDRIVE_ENDPOINT);
	});
});
