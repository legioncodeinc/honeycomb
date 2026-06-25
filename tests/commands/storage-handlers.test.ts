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
	parseSkillId,
	runStorageVerb,
} from "../../src/commands/index.js";
import { MEMORY_TYPES } from "../../src/shared/memory-types.js";

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

	it("PRD-045f f-AC-3 skillify pull ROUTES onto the live /api/skills group (not a dead /api/skillify)", () => {
		// The registered `skillify` verb must DISPATCH, not fall through to the generic
		// `/api/skillify` route the daemon never mounts. It shares the `skill` shape → /api/skills/pull.
		const req = buildStorageRequest("skillify", ["pull"]);
		expect(req.method).toBe("POST");
		expect(req.path).toBe("/api/skills/pull");
		// It is NOT the dead generic fallthrough.
		expect(req.path).not.toBe("/api/skillify");
		expect(req.path).not.toBe("/api/skillify/pull");
	});

	it("PRD-045f f-AC-3 skillify pull dispatches exactly one daemon request through the seam", async () => {
		const daemon = createFakeDaemonClient();
		const deps: CommandDeps = { daemon, out: () => {} };
		const res = await runStorageVerb("skillify", ["pull"], deps);
		expect(res.exitCode).toBe(0);
		expect(daemon.calls).toHaveLength(1);
		expect(`${daemon.calls[0]!.req.method} ${daemon.calls[0]!.req.path}`).toBe("POST /api/skills/pull");
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

	it("renders each hit's source + id + ENGINE score + a readable snippet, in ENGINE order", async () => {
		// PRD-027 Wave 1: the engine returns hits ALREADY ranked DESC by the fused RRF `score`,
		// distilled `[memory]` facts ahead of raw `[sessions]` drill-downs. The CLI renders the
		// ENGINE score + ENGINE order verbatim (AC-4) — it never invents a score and never re-sorts.
		const daemon = createFakeDaemonClient({
			responses: {
				[RECALL_KEY]: {
					status: 200,
					body: {
						hits: [
							{ source: "memory", id: "mem-1", text: "We chose Deep Lake for the vector store.", score: 0.51, kind: "memory", secondary: false },
							{ source: "sessions", id: "sess-9", text: "The daemon owns all SQL; the CLI dispatches intent.", score: 0.19, kind: "session", secondary: true },
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
		// AC-4: the ENGINE score is rendered per hit (no client-side score invention).
		expect(stdout).toContain("(0.51)");
		expect(stdout).toContain("(0.19)");
		// AC-4: the rendered ORDER is the engine order — the distilled `[memory]` line precedes
		// the raw `[sessions]` drill-down line (the daemon ranked them; the CLI preserved it).
		const memLine = lines.findIndex((l) => l.includes("mem-1"));
		const sessLine = lines.findIndex((l) => l.includes("sess-9"));
		expect(memLine).toBeGreaterThanOrEqual(0);
		expect(sessLine).toBeGreaterThan(memLine);
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

describe("PRD-049c — `skill promote` CLI verb routes to the daemon promote endpoint (49c-AC-2 / 49c-AC-4)", () => {
	it("parseSkillId splits `<name>--<author>` on the LAST `--` (a name may itself contain `--`)", () => {
		expect(parseSkillId("tidy-imports--alice")).toEqual({ name: "tidy-imports", author: "alice" });
		expect(parseSkillId("a--b--carol")).toEqual({ name: "a--b", author: "carol" });
		// A bare id (no `--`) → empty author, which the daemon's zod boundary then rejects.
		expect(parseSkillId("loner")).toEqual({ name: "loner", author: "" });
	});

	it("default reach: `skill promote tidy-imports--alice` → POST /api/skills/promote { workspaceWide:false }", () => {
		const req = buildStorageRequest("skill", ["promote", "tidy-imports--alice"]);
		expect(req.method).toBe("POST");
		expect(req.path).toBe("/api/skills/promote");
		expect(req.body).toEqual({ name: "tidy-imports", author: "alice", workspaceWide: false });
	});

	it("--workspace-wide sets the reach: { workspaceWide:true }", () => {
		const req = buildStorageRequest("skill", ["promote", "house-style--alice", "--workspace-wide"]);
		expect(req.path).toBe("/api/skills/promote");
		expect(req.body).toEqual({ name: "house-style", author: "alice", workspaceWide: true });
	});

	it("dispatches exactly one daemon request through the seam (registered + routed, not a dead row)", async () => {
		const daemon = createFakeDaemonClient({
			responses: {
				"POST /api/skills/promote": {
					status: 200,
					body: { promoted: true, skillId: "tidy-imports--alice", crossProjectScope: "user", promotedFromProject: "proj-A", version: 2 },
				},
			},
		});
		const deps: CommandDeps = { daemon, out: () => {} };
		const res = await runStorageVerb("skill", ["promote", "tidy-imports--alice"], deps);
		expect(res.exitCode).toBe(0);
		expect(daemon.calls).toHaveLength(1);
		expect(`${daemon.calls[0]!.req.method} ${daemon.calls[0]!.req.path}`).toBe("POST /api/skills/promote");
	});

	it("prints a plain-language confirmation naming the reach + origin project (visible provenance)", async () => {
		const daemon = createFakeDaemonClient({
			responses: {
				"POST /api/skills/promote": {
					status: 200,
					body: { promoted: true, skillId: "tidy-imports--alice", crossProjectScope: "user", promotedFromProject: "proj-A", version: 2 },
				},
			},
		});
		const lines: string[] = [];
		const deps: CommandDeps = { daemon, out: (l) => lines.push(l) };
		const res = await runStorageVerb("skill", ["promote", "tidy-imports--alice"], deps);
		expect(res.exitCode).toBe(0);
		const out = lines.join("\n");
		expect(out).toContain("Promoted");
		expect(out).toContain("across all of your projects");
		expect(out).toContain("proj-A"); // the origin project is named (provenance is visible).
		expect(out).not.toContain("skill: ok"); // not the generic render.
	});

	it("workspace-wide confirmation names the broader reach", async () => {
		const daemon = createFakeDaemonClient({
			responses: {
				"POST /api/skills/promote": {
					status: 200,
					body: { promoted: true, skillId: "house-style--alice", crossProjectScope: "workspace", promotedFromProject: "proj-A", version: 2 },
				},
			},
		});
		const lines: string[] = [];
		const deps: CommandDeps = { daemon, out: (l) => lines.push(l) };
		await runStorageVerb("skill", ["promote", "house-style--alice", "--workspace-wide"], deps);
		expect(lines.join("\n")).toContain("across the whole workspace");
	});

	it("a `promoted:false` outcome (no such skill) is reported plainly with a non-zero exit", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/skills/promote": { status: 200, body: { promoted: false, skillId: null } } },
		});
		const lines: string[] = [];
		const deps: CommandDeps = { daemon, out: (l) => lines.push(l) };
		const res = await runStorageVerb("skill", ["promote", "ghost--alice"], deps);
		expect(res.exitCode).toBe(1);
		expect(lines.join("\n")).toContain('No skill "ghost--alice" to promote');
	});

	it("a daemon error status surfaces a non-zero exit (fail-loud)", async () => {
		const daemon = createFakeDaemonClient({ responses: { "POST /api/skills/promote": { status: 400 } } });
		const deps: CommandDeps = { daemon, out: () => {} };
		const res = await runStorageVerb("skill", ["promote", "tidy-imports--alice"], deps);
		expect(res.exitCode).toBe(1);
	});

	it("the dispatched body carries NO SQL — the CLI dispatches intent, the daemon owns the SQL", () => {
		const req = buildStorageRequest("skill", ["promote", "tidy-imports--alice", "--workspace-wide"]);
		expect(JSON.stringify(req.body)).not.toMatch(/SELECT|INSERT|UPDATE|DELETE|FROM/i);
	});
});

describe("memory-type taxonomy — `remember --type` validates against the closed set", () => {
	it("a valid --type rides in the body and is stripped from the remembered content", () => {
		const req = buildStorageRequest("remember", ["use", "ESM", "imports", "--type", "convention"]);
		expect(req.method).toBe("POST");
		expect(req.path).toBe("/api/memories");
		// The type token rides as the body `type`, and is NOT part of the content.
		expect(req.body).toEqual({ content: "use ESM imports", type: "convention" });
	});

	it("an omitted --type sends no `type` (the daemon applies the column default `fact`)", () => {
		const req = buildStorageRequest("remember", ["a", "plain", "fact"]);
		expect(req.body).toEqual({ content: "a plain fact" });
		expect((req.body as Record<string, unknown>).type).toBeUndefined();
	});

	it("each of the six types is accepted by the build path", () => {
		for (const t of MEMORY_TYPES) {
			const req = buildStorageRequest("remember", ["x", "--type", t]);
			expect((req.body as Record<string, unknown>).type).toBe(t);
		}
	});

	it("an unknown --type is REJECTED before dispatch (exit 2) and names the valid set", async () => {
		const daemon = createFakeDaemonClient();
		const lines: string[] = [];
		const deps: CommandDeps = { daemon, out: (l) => lines.push(l) };
		const res = await runStorageVerb("remember", ["x", "--type", "banana"], deps);
		expect(res.exitCode).toBe(2);
		// No daemon call — the gate short-circuits before dispatch.
		expect(daemon.calls).toHaveLength(0);
		const stdout = lines.join("\n");
		expect(stdout).toContain('unknown --type "banana"');
		// The error names every valid token so the user can self-correct.
		for (const t of MEMORY_TYPES) expect(stdout).toContain(t);
	});

	it("a valid --type dispatches exactly one daemon request to /api/memories", async () => {
		const daemon = createFakeDaemonClient();
		const deps: CommandDeps = { daemon, out: () => {} };
		const res = await runStorageVerb("remember", ["a", "gotcha", "--type", "gotcha"], deps);
		expect(res.exitCode).toBe(0);
		expect(daemon.calls).toHaveLength(1);
		expect(daemon.calls[0]!.req.body).toEqual({ content: "a gotcha", type: "gotcha" });
	});
});
