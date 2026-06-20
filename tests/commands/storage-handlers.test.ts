/**
 * PRD-020a a-AC-3 + a-AC-6 — every storage verb dispatches THROUGH the daemon, never DeepLake.
 *
 * Proves:
 *   - a-AC-3: each `cls: "storage"` verb issues a `DaemonClient` request (the fake records it)
 *     and the CLI builds NO SQL — it dispatches a route + body intent.
 *   - a-AC-6: `honeycomb skill scope team --users alice,bob` dispatches `POST /api/skills/scope`
 *     with the parsed scope + users, through the SAME daemon seam.
 */

import { describe, expect, it } from "vitest";

import {
	buildStorageRequest,
	type CommandDeps,
	createFakeDaemonClient,
	runStorageVerb,
} from "../../src/commands/index.js";

describe("PRD-020a a-AC-3 — storage verbs route through the daemon (never DeepLake)", () => {
	it("a-AC-3 each storage verb dispatches exactly one daemon request to its route", async () => {
		const daemon = createFakeDaemonClient();
		const deps: CommandDeps = { daemon, out: () => {} };

		await runStorageVerb("recall", ["decision"], deps);
		await runStorageVerb("graph", ["build"], deps);
		await runStorageVerb("goal", ["list"], deps);

		expect(daemon.calls.map((c) => `${c.req.method} ${c.req.path}`)).toEqual([
			"POST /api/memories/recall",
			"POST /api/graph/build",
			"GET /api/goals",
		]);
	});

	it("a-AC-3 the CLI dispatches INTENT (route + body), never SQL", () => {
		const req = buildStorageRequest("remember", ["the", "daemon", "owns", "the", "sql"]);
		expect(req.path).toBe("/api/memories");
		expect(req.method).toBe("POST");
		// The body is a content intent — no SQL fragment anywhere.
		expect(JSON.stringify(req.body)).not.toMatch(/SELECT|INSERT|DELETE|FROM/i);
	});

	it("a-AC-6 skill scope team --users alice,bob → POST /api/skills/scope through the daemon", async () => {
		const daemon = createFakeDaemonClient();
		const deps: CommandDeps = { daemon, out: () => {} };
		const res = await runStorageVerb("skill", ["scope", "team", "--users", "alice,bob"], deps);
		expect(res.exitCode).toBe(0);
		expect(daemon.calls).toHaveLength(1);
		const call = daemon.calls[0]!.req;
		expect(call.method).toBe("POST");
		expect(call.path).toBe("/api/skills/scope");
		expect(call.body).toEqual({ scope: "team", users: ["alice", "bob"], force: false });
	});

	it("a-AC-6 skill pull --force → POST /api/skills/pull with force=true", () => {
		const req = buildStorageRequest("skill", ["pull", "--force"]);
		expect(req.path).toBe("/api/skills/pull");
		expect(req.body).toEqual({ force: true });
	});

	it("a-AC-3 a daemon error status surfaces a non-zero exit (fail-loud, no silent success)", async () => {
		const daemon = createFakeDaemonClient({ responses: { "POST /api/graph/build": { status: 500 } } });
		const deps: CommandDeps = { daemon, out: () => {} };
		const res = await runStorageVerb("graph", ["build"], deps);
		expect(res.exitCode).toBe(1);
	});
});

describe("PRD-023 dogfood — `recall` RENDERS the daemon's hits (not just `recall: ok`)", () => {
	const RECALL_KEY = "POST /api/memories/recall";

	it("renders each hit's source + id + a readable snippet of text", async () => {
		const daemon = createFakeDaemonClient({
			responses: {
				[RECALL_KEY]: {
					status: 200,
					body: {
						hits: [
							{ source: "memory", id: "mem-1", text: "We chose Deep Lake for the vector store." },
							{ source: "sessions", id: "sess-9", text: "The daemon owns all SQL; the CLI dispatches intent." },
						],
						sources: ["memory", "sessions"],
						degraded: false,
					},
				},
			},
		});
		const lines: string[] = [];
		const deps: CommandDeps = { daemon, out: (l) => lines.push(l) };

		const res = await runStorageVerb("recall", ["why", "deep", "lake"], deps);
		expect(res.exitCode).toBe(0);

		const stdout = lines.join("\n");
		// NOT the old discarded-body behavior.
		expect(stdout).not.toContain("recall: ok");
		// The hit ids AND their text are rendered.
		expect(stdout).toContain("mem-1");
		expect(stdout).toContain("sess-9");
		expect(stdout).toContain("We chose Deep Lake for the vector store.");
		expect(stdout).toContain("The daemon owns all SQL");
		// The source tag is shown per hit.
		expect(stdout).toContain("[memory]");
		expect(stdout).toContain("[sessions]");
	});

	it("surfaces the `(lexical fallback)` marker when the daemon reports degraded recall", async () => {
		const daemon = createFakeDaemonClient({
			responses: {
				[RECALL_KEY]: {
					status: 200,
					body: { hits: [{ source: "memory", id: "m1", text: "lexical-only hit" }], degraded: true },
				},
			},
		});
		const lines: string[] = [];
		const deps: CommandDeps = { daemon, out: (l) => lines.push(l) };
		await runStorageVerb("recall", ["anything"], deps);
		expect(lines.join("\n")).toContain("(lexical fallback)");
	});

	it("--json prints the raw JSON body (machine-readable), not the human render", async () => {
		const body = { hits: [{ source: "memory", id: "j1", text: "json hit" }], sources: ["memory"], degraded: false };
		const daemon = createFakeDaemonClient({ responses: { [RECALL_KEY]: { status: 200, body } } });
		const lines: string[] = [];
		const deps: CommandDeps = { daemon, out: (l) => lines.push(l) };

		// `true` is the threaded `--json` global flag.
		await runStorageVerb("recall", ["q"], deps, true);

		const stdout = lines.join("\n");
		// The raw JSON round-trips to the same object.
		expect(JSON.parse(stdout)).toEqual(body);
		// No human-render tags leaked into the JSON output.
		expect(stdout).not.toContain("[memory] j1");
	});

	it("an empty result prints a clean `no memories found` line", async () => {
		const daemon = createFakeDaemonClient({
			responses: { [RECALL_KEY]: { status: 200, body: { hits: [], sources: [], degraded: false } } },
		});
		const lines: string[] = [];
		const deps: CommandDeps = { daemon, out: (l) => lines.push(l) };

		await runStorageVerb("recall", ["nothing", "matches"], deps);

		const stdout = lines.join("\n");
		expect(stdout).toContain('no memories found for "nothing matches"');
		expect(stdout).not.toContain("recall: ok");
	});

	it("the OTHER storage verbs keep the unchanged `<verb>: ok` render", async () => {
		const daemon = createFakeDaemonClient();
		const lines: string[] = [];
		const deps: CommandDeps = { daemon, out: (l) => lines.push(l) };
		await runStorageVerb("remember", ["a", "fact"], deps);
		expect(lines.join("\n")).toContain("remember: ok");
	});
});
