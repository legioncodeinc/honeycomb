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
