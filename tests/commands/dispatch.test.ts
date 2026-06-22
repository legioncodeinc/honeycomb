/**
 * PRD-020a a-AC-1 + index AC-1 — the unified dispatcher: parse + route + org/ws passthrough.
 *
 * Proves:
 *   - a-AC-1: global flags parse, the verb resolves, and `org`/`workspace`/`login`/`logout`
 *     forward their FULL arg array to the auth dispatcher (NOT re-parsed).
 *   - index AC-1: a storage verb dispatches THROUGH the `DaemonClient` seam (never DeepLake);
 *     the invariant test proves the static no-storage-import half.
 */

import { describe, expect, it } from "vitest";

import {
	type AuthPassthrough,
	type CommandDeps,
	createDispatcher,
	createFakeDaemonClient,
	parseInvocation,
} from "../../src/commands/index.js";

/** A recording auth-passthrough fake that captures the FULL arg array forwarded (FR-4). */
function recordingAuth(): AuthPassthrough & { calls: string[][] } {
	const calls: string[][] = [];
	return {
		calls,
		async dispatch(args: readonly string[]): Promise<number> {
			calls.push([...args]);
			return 0;
		},
	};
}

describe("PRD-020a a-AC-1 — the unified dispatcher parses + routes", () => {
	it("a-AC-1 parses leading global flags and resolves the verb, leaving the tail for the handler", () => {
		const inv = parseInvocation(["--json", "recall", "my", "query", "--limit", "5"]);
		expect(inv.flags.json).toBe(true);
		expect(inv.verb).toBe("recall");
		expect(inv.argv).toEqual(["my", "query", "--limit", "5"]);
	});

	it("a-AC-1 prints usage and exits 0 when no command is given (FR-1)", async () => {
		const lines: string[] = [];
		const deps: CommandDeps = { daemon: createFakeDaemonClient(), out: (l) => lines.push(l) };
		const d = createDispatcher();
		const res = await d.dispatch(d.parse([]), deps);
		expect(res.exitCode).toBe(0);
		expect(lines.join("\n")).toMatch(/usage: honeycomb/);
	});

	it("a-AC-1 --version short-circuits to the version line", async () => {
		const lines: string[] = [];
		const deps: CommandDeps = { daemon: createFakeDaemonClient(), out: (l) => lines.push(l) };
		const d = createDispatcher();
		const res = await d.dispatch(d.parse(["--version"]), deps);
		expect(res.exitCode).toBe(0);
		expect(lines.join("\n")).toMatch(/honeycomb v/);
	});

	it("a-AC-1 org/workspace pass the FULL arg array through to the auth dispatcher (FR-4)", async () => {
		const auth = recordingAuth();
		const deps: CommandDeps = { daemon: createFakeDaemonClient(), auth, out: () => {} };
		const d = createDispatcher();

		await d.dispatch(d.parse(["org", "switch", "acme"]), deps);
		await d.dispatch(d.parse(["workspace", "use", "prod"]), deps);
		await d.dispatch(d.parse(["login"]), deps);

		// The dispatcher forwards verb + tail verbatim — it does NOT re-parse the subcommand.
		expect(auth.calls).toEqual([["org", "switch", "acme"], ["workspace", "use", "prod"], ["login"]]);
	});

	it("index AC-1 a storage verb dispatches THROUGH the DaemonClient seam (never DeepLake)", async () => {
		const daemon = createFakeDaemonClient();
		const deps: CommandDeps = { daemon, out: () => {} };
		const d = createDispatcher();
		const res = await d.dispatch(d.parse(["recall", "what", "did", "we", "decide"]), deps);
		expect(res.exitCode).toBe(0);
		// The storage verb reached the daemon seam — exactly one dispatched call, to the recall route.
		expect(daemon.calls).toHaveLength(1);
		expect(daemon.calls[0]?.req.path).toBe("/api/memories/recall");
	});

	it("PRD-045f f-AC-3 `skillify pull` is REGISTERED and DISPATCHES through the daemon seam (not just a table row)", async () => {
		const daemon = createFakeDaemonClient();
		const deps: CommandDeps = { daemon, out: () => {} };
		const d = createDispatcher();

		// The verb resolves (registered) AND the dispatcher routes it as a storage verb to the
		// live skills group — a dead-route or unknown-verb would never reach the daemon seam.
		const res = await d.dispatch(d.parse(["skillify", "pull"]), deps);
		expect(res.exitCode).toBe(0);
		expect(daemon.calls).toHaveLength(1);
		expect(daemon.calls[0]?.req.path).toBe("/api/skills/pull");
	});

	it("a-AC-1 an unknown command prints usage and exits non-zero", async () => {
		const lines: string[] = [];
		const deps: CommandDeps = { daemon: createFakeDaemonClient(), out: (l) => lines.push(l) };
		const d = createDispatcher();
		const res = await d.dispatch(d.parse(["frobnicate"]), deps);
		expect(res.exitCode).toBe(1);
		expect(lines.join("\n")).toMatch(/unknown command/);
	});
});
