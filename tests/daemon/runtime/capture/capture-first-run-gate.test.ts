/**
 * PRD-059a / IRD-123 — the first-run capture gate suite (a-AC-1 / a-AC-3 / a-AC-4 / a-AC-5).
 *
 * The gate REVERSES 049a's "never drop → inbox" for the ZERO-projects pre-onboarding state only:
 * while the active workspace has bound no project on this device, a capture NO-OPs (no `sessions`/
 * `memory`/`memory_jobs` row, no pipeline job). The moment the first project is bound the gate opens
 * and capture — including the 049a `__unsorted__` inbox fallback for unbound folders — resumes.
 *
 * Verification posture mirrors `capture-project-attribution.test.ts`: in-process via
 * `daemon.app.request(...)` against the PRD-002 FAKE transport; the `sessions` INSERT SQL (or its
 * ABSENCE) is the artifact asserted. The handler's `projectsDir` points the gate at a temp cache so
 * the bound/zero state is deterministic. NO live network.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

/** Seed a temp `~/.deeplake/projects.json` with the given bindings; empty bindings = zero-state. */
function seedCache(bindings: Array<{ path: string; projectId: string }>): string {
	const dir = mkdtempSync(join(tmpdir(), "hc-gate-"));
	tempDirs.push(dir);
	writeFileSync(
		join(dir, "projects.json"),
		JSON.stringify({ schemaVersion: 1, org: ORG, workspace: WORKSPACE, bindings, projects: [] }),
		"utf8",
	);
	return dir;
}

/** A temp dir with NO projects.json at all (the genuinely-absent zero-state). */
function emptyDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "hc-gate-empty-"));
	tempDirs.push(dir);
	return dir;
}

function responder() {
	return (req: TransportRequest): Record<string, unknown>[] => {
		if (/information_schema\.columns/i.test(req.sql)) {
			return healTargetFor("sessions").columns.map((c) => ({ column_name: c.name }));
		}
		return [];
	};
}

interface BuiltDaemon {
	readonly daemon: Daemon;
	readonly fake: FakeDeepLakeTransport;
	readonly enqueued: string[];
}

/** Build a daemon whose capture handler has the first-run gate ON, pointed at `projectsDir`. */
function buildDaemon(projectsDir: string, firstRunGate = true): BuiltDaemon {
	const fake = new FakeDeepLakeTransport(responder());
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const daemon = createDaemon({
		config: { host: "127.0.0.1", port: 3850, mode: "local", widened: false },
		storage,
		logger: createRequestLogger({ silent: true }),
		services: { runtimePath: createRuntimePathService() },
	});
	const enqueued: string[] = [];
	const handler = createCaptureHandler({
		storage,
		sessionsTarget: healTargetFor("sessions"),
		queue: {
			async enqueue(job: { kind: string }) {
				enqueued.push(job.kind);
				return "j";
			},
			async lease() {
				return null;
			},
			async complete() {},
			async fail() {},
			start() {},
			stop() {},
		},
		projectsDir,
		firstRunGate,
		// PRD-062c: this gate suite asserts the synchronous "no INSERT issued" contract, so pin
		// the flags-OFF write path (one immediate INSERT per event, no buffer) — AC-9 parity.
		captureConfig: { batch: false, windowMs: 1_000, maxEvents: 25, envelopeBudgetBytes: 0 },
		// A pipeline-entry seam that records it was called — to prove the gate suppresses it too.
		enqueuePipelineEntry: async () => {
			enqueued.push("pipeline-entry");
		},
	});
	handler.register(daemon);
	return { daemon, fake, enqueued };
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

async function postCapture(daemon: Daemon, cwd: string): Promise<Response> {
	return daemon.app.request("/api/hooks/capture", {
		method: "POST",
		headers: headers(),
		body: JSON.stringify(captureBody(cwd)),
	});
}

function sessionsInserts(fake: FakeDeepLakeTransport): string[] {
	return fake.requests.filter((r) => /^\s*INSERT\s+INTO\s+"sessions"/i.test(r.sql)).map((r) => r.sql);
}

describe("first-run capture gate — zero projects (a-AC-1 / IRD-123 123-AC-1)", () => {
	it("writes NO sessions row and enqueues NO job when the workspace has zero bound projects", async () => {
		const { daemon, fake, enqueued } = buildDaemon(emptyDir());
		const res = await postCapture(daemon, "/work/scratch");
		// The gated ack is a clean 200 (not a failure) so the shim does not treat it as an error.
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; gated?: boolean };
		expect(body.ok).toBe(true);
		expect(body.gated).toBe(true);
		// a-AC-1: no row written, no job enqueued.
		expect(sessionsInserts(fake)).toEqual([]);
		expect(enqueued).toEqual([]);
	});

	it("a malformed/absent cache (genuine zero-state) suppresses; no INSERT issued", async () => {
		const { daemon, fake } = buildDaemon(emptyDir());
		await postCapture(daemon, "/some/dir");
		// Not even the heal-introspection SELECT runs — the handler returns before any storage call.
		expect(fake.requests.length).toBe(0);
	});
});

describe("first-run capture gate — opens after the first bind (a-AC-4 / a-AC-5)", () => {
	it("a cwd bound to a project captures normally (the gate is open)", async () => {
		const { daemon, fake } = buildDaemon(seedCache([{ path: "/work/api", projectId: "proj-api" }]));
		const res = await postCapture(daemon, "/work/api/src");
		expect(res.status).toBe(201);
		const inserts = sessionsInserts(fake);
		expect(inserts.length).toBe(1);
		expect(inserts[0]).toContain("'proj-api'");
	});

	it("a-AC-5: with ≥1 bound project, an UNBOUND folder still falls to the __unsorted__ inbox", async () => {
		// One project bound (gate open), but THIS capture's cwd is unbound → inbox, not suppressed.
		const { daemon, fake } = buildDaemon(seedCache([{ path: "/work/api", projectId: "proj-api" }]));
		const res = await postCapture(daemon, "/somewhere/else");
		expect(res.status).toBe(201);
		const inserts = sessionsInserts(fake);
		expect(inserts.length).toBe(1);
		expect(inserts[0]).toContain("'__unsorted__'"); // inbox fallback resumed (gate is first-run-only).
	});
});

describe("first-run capture gate — disabled (pre-059a behaviour)", () => {
	it("with the gate OFF, a zero-projects workspace still captures to the inbox (back-compat)", async () => {
		const { daemon, fake } = buildDaemon(emptyDir(), /* firstRunGate */ false);
		const res = await postCapture(daemon, "/work/scratch");
		expect(res.status).toBe(201);
		const inserts = sessionsInserts(fake);
		expect(inserts.length).toBe(1);
		expect(inserts[0]).toContain("'__unsorted__'");
	});
});
