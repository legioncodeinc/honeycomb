/**
 * PRD-058d — the `honeycomb memory` lifecycle CLI suite.
 *
 * Acceptance criteria → tests:
 *   58d.3.1 `honeycomb memory conflicts` lists conflicts (scope-filtered daemon-side) via GET /api/memories/conflicts.
 *   58d.3.2 `honeycomb memory conflicts resolve <id> --verdict <v> --winner <id>` resolves through the SAME 058b
 *           endpoint/path the dashboard uses (POST /api/memories/conflicts/<id>/resolve) — no parallel resolve logic.
 *   58d.3.3 `honeycomb memory stale-refs` lists stale references via GET /api/memories/stale-refs.
 *   58d.3.4 `honeycomb memory inspect <id> --lifecycle` prints freshnessScore, calibratedConfidence, refStatus,
 *           conflict status, and the computed H.
 */

import { describe, expect, it } from "vitest";

import { createFakeDaemonClient, type CommandDeps } from "../../src/commands/contracts.js";
import { parseMemoryCliArgs, runMemoryVerb } from "../../src/commands/memory.js";

/** Build deps with a fake daemon + a capturing output sink. */
function deps(responses: Record<string, { status: number; body?: unknown }> = {}): {
	deps: CommandDeps;
	lines: string[];
	calls: () => readonly { req: { method: string; path: string; body?: unknown; query?: Record<string, string> } }[];
} {
	const lines: string[] = [];
	const daemon = createFakeDaemonClient({ responses });
	const commandDeps: CommandDeps = { daemon, out: (l: string) => lines.push(l) };
	return { deps: commandDeps, lines, calls: () => daemon.calls };
}

describe("PRD-058d memory CLI — arg parsing", () => {
	it("parses conflicts/resolve/stale-refs/inspect + the flags", () => {
		expect(parseMemoryCliArgs(["conflicts"])).toMatchObject({ sub: "conflicts", status: "open" });
		expect(parseMemoryCliArgs(["conflicts", "resolve", "c1", "--verdict", "supersede", "--winner", "m2"])).toMatchObject({
			sub: "conflicts",
			arg: "resolve",
			id: "c1",
			verdict: "supersede",
			winner: "m2",
		});
		expect(parseMemoryCliArgs(["inspect", "mem-1", "--lifecycle"])).toMatchObject({ sub: "inspect", arg: "mem-1", lifecycle: true });
	});

	it("does NOT fold a consumed flag value into the positionals (interleaved flag order)", () => {
		// CodeRabbit #125: a paired-flag value (`supersede`, `m9`) interleaved BEFORE/BETWEEN positionals
		// must be CONSUMED, never treated as a positional, so the conflict id stays the sole id positional.
		expect(parseMemoryCliArgs(["conflicts", "resolve", "--verdict", "supersede", "c1"])).toMatchObject({
			sub: "conflicts",
			arg: "resolve",
			id: "c1",
			verdict: "supersede",
		});
		expect(parseMemoryCliArgs(["conflicts", "resolve", "--verdict", "supersede", "--winner", "m9", "c1"])).toMatchObject({
			sub: "conflicts",
			arg: "resolve",
			id: "c1",
			verdict: "supersede",
			winner: "m9",
		});
	});

	it("`conflicts resolve <id> --verdict supersede --winner <id>` parses the id as the SOLE positional id", () => {
		// The canonical resolve invocation: the only positional id is the conflict id, the flag values are consumed.
		const parsed = parseMemoryCliArgs(["conflicts", "resolve", "c1", "--verdict", "supersede", "--winner", "m2"]);
		expect(parsed).toMatchObject({ sub: "conflicts", arg: "resolve", id: "c1", verdict: "supersede", winner: "m2" });
		// Neither flag value leaked into a positional field.
		expect(parsed.id).not.toBe("supersede");
		expect(parsed.id).not.toBe("m2");
	});
});

describe("PRD-058d memory CLI — conflicts list (AC-55d.3.1)", () => {
	it("`memory conflicts` GETs /api/memories/conflicts and renders the pair + verdict + status", async () => {
		const { deps: d, lines, calls } = deps({
			"GET /api/memories/conflicts": {
				status: 200,
				body: { conflicts: [{ id: "c1", memoryAId: "m1", memoryBId: "m2", verdict: "review", winnerId: null, status: "open" }], status: "open" },
			},
		});
		const result = await runMemoryVerb(["conflicts"], d);
		expect(result.exitCode).toBe(0);
		const call = calls()[0]!;
		expect(call.req.method).toBe("GET");
		expect(call.req.path).toBe("/api/memories/conflicts");
		expect(call.req.query).toMatchObject({ status: "open" });
		expect(lines.join("\n")).toContain("c1");
		expect(lines.join("\n")).toContain("m1 ⇄ m2");
	});

	it("an empty queue renders the honest empty state", async () => {
		const { deps: d, lines } = deps({ "GET /api/memories/conflicts": { status: 200, body: { conflicts: [], status: "open" } } });
		await runMemoryVerb(["conflicts"], d);
		expect(lines.join("\n")).toContain("no conflicts found");
	});
});

describe("PRD-058d memory CLI — resolve through the SAME 058b path (AC-55d.3.2)", () => {
	it("`memory conflicts resolve <id> --verdict supersede --winner <id>` POSTs the 058b resolve endpoint", async () => {
		const { deps: d, calls } = deps({
			"POST /api/memories/conflicts/c1/resolve": { status: 200, body: { conflict: { id: "c1", status: "resolved" } } },
		});
		const result = await runMemoryVerb(["conflicts", "resolve", "c1", "--verdict", "supersede", "--winner", "m2", "--reason", "newer wins"], d);
		expect(result.exitCode).toBe(0);
		const call = calls()[0]!;
		// THE SAME path/code the dashboard hits — no parallel resolve logic.
		expect(call.req.method).toBe("POST");
		expect(call.req.path).toBe("/api/memories/conflicts/c1/resolve");
		expect(call.req.body).toMatchObject({ verdict: "supersede", winnerId: "m2", reason: "newer wins" });
	});

	it("an invalid verdict is rejected BEFORE any daemon dispatch (no parallel resolve logic)", async () => {
		const { deps: d, lines, calls } = deps();
		const result = await runMemoryVerb(["conflicts", "resolve", "c1", "--verdict", "bogus"], d);
		expect(result.exitCode).toBe(1);
		expect(calls()).toHaveLength(0); // never dispatched
		expect(lines.join("\n")).toContain("--verdict must be one of");
	});

	it("a missing id prints usage and does not dispatch", async () => {
		const { deps: d, calls } = deps();
		const result = await runMemoryVerb(["conflicts", "resolve"], d);
		expect(result.exitCode).toBe(1);
		expect(calls()).toHaveLength(0);
	});
});

describe("PRD-058d memory CLI — stale-refs list (AC-55d.3.3)", () => {
	it("`memory stale-refs` GETs /api/memories/stale-refs and lists the memory id + refs", async () => {
		const { deps: d, lines, calls } = deps({
			"GET /api/memories/stale-refs": {
				status: 200,
				body: { staleRefs: [{ memoryId: "mem-9", refStatus: "stale", staleRefs: ["src/gone.ts"], verifiedAt: null }] },
			},
		});
		const result = await runMemoryVerb(["stale-refs"], d);
		expect(result.exitCode).toBe(0);
		expect(calls()[0]!.req.path).toBe("/api/memories/stale-refs");
		expect(lines.join("\n")).toContain("mem-9");
		expect(lines.join("\n")).toContain("src/gone.ts");
	});
});

describe("PRD-058d memory CLI — inspect --lifecycle (AC-55d.3.4)", () => {
	it("prints freshnessScore, calibratedConfidence, refStatus, conflict, and the computed H", async () => {
		const { deps: d, lines } = deps({
			"GET /api/memories/mem-1": {
				status: 200,
				body: {
					memory: {
						id: "mem-1",
						freshnessScore: 0.5,
						activation: 0.5,
						calibratedConfidence: 0.8,
						staleness: 0,
						refStatus: "fresh",
						openConflict: false,
						kappa: 1,
					},
				},
			},
		});
		const result = await runMemoryVerb(["inspect", "mem-1", "--lifecycle"], d);
		expect(result.exitCode).toBe(0);
		const out = lines.join("\n");
		expect(out).toContain("freshnessScore");
		expect(out).toContain("calibratedConfidence");
		expect(out).toContain("refStatus");
		expect(out).toContain("open-conflict");
		// H = 0.5 · 0.8 · (1 − 0) · 1 = 0.400
		expect(out).toContain("H (health)");
		expect(out).toContain("0.400");
	});

	it("with a dormant calibration term, H degrades to the live terms (the identity rule)", async () => {
		const { deps: d, lines } = deps({
			// No calibratedConfidence, no staleness, no kappa → each identity; only freshness 0.5 is live.
			"GET /api/memories/mem-2": { status: 200, body: { memory: { id: "mem-2", freshnessScore: 0.5, refStatus: "unknown" } } },
		});
		await runMemoryVerb(["inspect", "mem-2", "--lifecycle"], d);
		// H = 0.5 · 1 · 1 · 1 = 0.500
		expect(lines.join("\n")).toContain("0.500");
	});
});
