/**
 * PRD-049b — per-project capture attribution (49b-AC-1 / 49b-AC-3).
 *
 * The capture path resolves the row's `project_id` from the session cwd via the 049a
 * thin-client resolver and writes it onto the `sessions` INSERT (BESIDE the kept raw
 * `project` cwd path, D5). This suite proves:
 *
 *   - 49b-AC-1: a capture whose cwd is BOUND to a registry project (via a seeded
 *     `~/.deeplake/projects.json` binding) carries THAT project's `project_id` — so a
 *     per-project read-back in that project finds it. Two concurrent captures in two
 *     folders attribute to two projects with NO manual switch (the binding is the authority).
 *   - 49b-AC-3: an identity-less capture (no binding, no cache) lands in the workspace
 *     `__unsorted__` inbox — never dropped, never mis-attributed to a real project.
 *
 * Verification posture mirrors the capture-handler suite: in-process via
 * `daemon.app.request(...)` against the PRD-002 fake transport; the `sessions` INSERT SQL
 * is the artifact asserted. The capture handler's `projectsDir` dep points the resolver at
 * a temp cache so a binding can be seeded deterministically.
 */

import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { healTargetFor } from "../../../../src/daemon/storage/catalog/index.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import { createRuntimePathService } from "../../../../src/daemon/runtime/middleware/runtime-path.js";
import { createCaptureHandler } from "../../../../src/daemon/runtime/capture/capture-handler.js";
import { UNSORTED_PROJECT_ID } from "../../../../src/daemon/storage/catalog/projects.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const ORG = "fake-org";
const WORKSPACE = "fake-ws";

const tempDirs: string[] = [];
afterEach(() => {
	for (const d of tempDirs.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			// best-effort cleanup
		}
	}
});

/** Seed a `~/.deeplake/projects.json` cache (temp dir) binding `path` → `projectId`. */
function seedProjectsCache(bindings: Array<{ path: string; projectId: string }>): string {
	const dir = mkdtempSync(join(tmpdir(), "honeycomb-projects-"));
	tempDirs.push(dir);
	const cache = {
		schemaVersion: 1 as const,
		org: ORG,
		workspace: WORKSPACE,
		bindings,
		projects: [],
	};
	writeFileSync(join(dir, "projects.json"), JSON.stringify(cache), "utf8");
	return dir;
}

function responder() {
	return (req: TransportRequest): Record<string, unknown>[] => {
		const sql = req.sql;
		if (/information_schema\.columns/i.test(sql)) {
			return healTargetFor("sessions").columns.map((c) => ({ column_name: c.name }));
		}
		return [];
	};
}

function buildDaemon(projectsDir?: string): { daemon: Daemon; fake: FakeDeepLakeTransport } {
	const fake = new FakeDeepLakeTransport(responder());
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const daemon = createDaemon({
		config: { host: "127.0.0.1", port: 3850, mode: "local", widened: false },
		storage,
		logger: createRequestLogger({ silent: true }),
		services: { runtimePath: createRuntimePathService() },
	});
	const handler = createCaptureHandler({
		storage,
		sessionsTarget: healTargetFor("sessions"),
		queue: { async enqueue() { return "j"; }, async lease() { return null; }, async complete() {}, async fail() {}, start() {}, stop() {} },
		// PRD-062c: assert the pre-062c synchronous single-INSERT path (flags-OFF parity, AC-9).
		captureConfig: { batch: false, windowMs: 1_000, maxEvents: 25, envelopeBudgetBytes: 0 },
		...(projectsDir !== undefined ? { projectsDir } : {}),
	});
	handler.register(daemon);
	return { daemon, fake };
}

function headers(): Record<string, string> {
	return {
		"content-type": "application/json",
		"x-honeycomb-runtime-path": "plugin",
		"x-honeycomb-session": "sess-1",
		"x-honeycomb-org": ORG,
		"x-honeycomb-workspace": WORKSPACE,
	};
}

function captureBody(cwd: string) {
	return {
		event: { kind: "user_message", text: "decision: use postgres" },
		metadata: {
			sessionId: "sess-1",
			path: "conversations/sess-1",
			cwd,
			permissionMode: "default",
			hookEventName: "UserPromptSubmit",
			agentId: "agent-7",
			org: ORG,
			workspace: WORKSPACE,
			agent: "claude-code",
			pluginVersion: "0.1.0",
		},
	};
}

async function postCapture(daemon: Daemon, cwd: string): Promise<string> {
	const res = await daemon.app.request("/api/hooks/capture", {
		method: "POST",
		headers: headers(),
		body: JSON.stringify(captureBody(cwd)),
	});
	expect(res.status).toBe(201);
	return res.status.toString();
}

function sessionsInsert(fake: FakeDeepLakeTransport): string {
	const insert = fake.requests.find((r) => /^\s*INSERT\s+INTO\s+"sessions"/i.test(r.sql));
	expect(insert, "a sessions INSERT was issued").toBeDefined();
	return insert!.sql;
}

describe("capture project attribution (49b-AC-1)", () => {
	it("a cwd bound to a registry project writes THAT project's project_id (not the inbox)", async () => {
		const dir = seedProjectsCache([{ path: "/work/api", projectId: "proj-api" }]);
		const { daemon, fake } = buildDaemon(dir);
		await postCapture(daemon, "/work/api/src");

		const sql = sessionsInsert(fake);
		// The resolved registry key is written to project_id; the raw cwd stays on `project` (D5).
		expect(sql).toContain("'proj-api'");
		expect(sql).toContain("/work/api/src"); // the raw `project` cwd path (D5, kept).
		expect(sql).not.toContain(`'${UNSORTED_PROJECT_ID}'`); // not the inbox — it bound.
	});

	it("two concurrent captures in two bound folders attribute to two projects, no switch", async () => {
		const dir = seedProjectsCache([
			{ path: "/work/api", projectId: "proj-api" },
			{ path: "/work/web", projectId: "proj-web" },
		]);
		const { daemon, fake } = buildDaemon(dir);
		await postCapture(daemon, "/work/api/src");
		await postCapture(daemon, "/work/web/app");

		const inserts = fake.requests.filter((r) => /^\s*INSERT\s+INTO\s+"sessions"/i.test(r.sql));
		expect(inserts.length).toBe(2);
		// Each row carries its OWN project — no shared machine-global field leaked across them.
		expect(inserts.some((r) => r.sql.includes("'proj-api'"))).toBe(true);
		expect(inserts.some((r) => r.sql.includes("'proj-web'"))).toBe(true);
	});
});

describe("identity-less capture → inbox (49b-AC-3)", () => {
	it("a cwd with no binding (no cache) lands in the workspace __unsorted__ inbox, never dropped", async () => {
		const { daemon, fake } = buildDaemon(); // no projectsDir → no cache → inbox fallback.
		await postCapture(daemon, "/some/scratch/dir");

		const sql = sessionsInsert(fake);
		expect(sql).toContain(`'${UNSORTED_PROJECT_ID}'`); // attributed to the inbox.
		// The row was still written (never dropped, never fail-closed on capture).
		expect(/^\s*INSERT\s+INTO\s+"sessions"/i.test(sql)).toBe(true);
	});

	it("a blank cwd resolves to the inbox without throwing", async () => {
		const { daemon, fake } = buildDaemon();
		await postCapture(daemon, "");
		const sql = sessionsInsert(fake);
		expect(sql).toContain(`'${UNSORTED_PROJECT_ID}'`);
	});
});
