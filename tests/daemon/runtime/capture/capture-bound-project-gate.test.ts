/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

/**
 * PRD-073a / 073c — the PER-SESSION bound-project capture gate + the tenancy tie (AC-named).
 *
 * Unlike the one-shot PRD-059a first-run gate, this gates per session FOREVER: a session in an
 * unbound folder writes nothing even after other projects are bound, unless the inbox opt-in is on.
 * The 073c tenancy seam gates every capture with `tenancy_unconfirmed` when tenancy is not confirmed,
 * ahead of the bound-project check. Driven in-process via `daemon.app.request(...)` against the PRD-002
 * fake transport; the `sessions` INSERT SQL (or its absence) is the artifact asserted.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCaptureHandler } from "../../../../src/daemon/runtime/capture/capture-handler.js";
import { createGatedCapturesCounter } from "../../../../src/daemon/runtime/capture/gated-captures.js";
import { resolveInboxCaptureEnabled } from "../../../../src/daemon/runtime/capture/capture-config.js";
import { createRequestLogger } from "../../../../src/daemon/runtime/logger.js";
import { createRuntimePathService } from "../../../../src/daemon/runtime/middleware/runtime-path.js";
import { createDaemon, type Daemon } from "../../../../src/daemon/runtime/server.js";
import { healTargetFor } from "../../../../src/daemon/storage/catalog/index.js";
import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import type { TransportRequest } from "../../../../src/daemon/storage/transport.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const ORG = "fake-org";
const WORKSPACE = "fake-ws";

const tempDirs: string[] = [];
afterEach(() => {
	for (const d of tempDirs.splice(0)) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			// best-effort
		}
	}
});

function seedCache(bindings: Array<{ path: string; projectId: string }>): string {
	const dir = mkdtempSync(join(tmpdir(), "hc-bpgate-"));
	tempDirs.push(dir);
	writeFileSync(
		join(dir, "projects.json"),
		JSON.stringify({ schemaVersion: 1, org: ORG, workspace: WORKSPACE, bindings, projects: [] }),
		"utf8",
	);
	return dir;
}

function emptyDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "hc-bpgate-empty-"));
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

interface GateDeps {
	readonly projectsDir: string;
	readonly boundProjectGate?: boolean;
	readonly inboxCapture?: boolean;
	readonly tenancyConfirmed?: () => boolean;
	readonly env?: NodeJS.ProcessEnv;
}

function buildDaemon(deps: GateDeps): {
	daemon: Daemon;
	fake: FakeDeepLakeTransport;
	enqueued: string[];
	gated: ReturnType<typeof createGatedCapturesCounter>;
} {
	const fake = new FakeDeepLakeTransport(responder());
	const storage = createStorageClient({ transport: fake, provider: stubProvider(fakeCredentialRecord()) });
	const daemon = createDaemon({
		config: { host: "127.0.0.1", port: 3850, mode: "local", widened: false },
		storage,
		logger: createRequestLogger({ silent: true }),
		services: { runtimePath: createRuntimePathService() },
	});
	const enqueued: string[] = [];
	const gated = createGatedCapturesCounter();
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
		enqueuePipelineEntry: async () => {
			enqueued.push("pipeline-entry");
		},
		projectsDir: deps.projectsDir,
		gatedCaptures: gated,
		captureConfig: { batch: false, windowMs: 1_000, maxEvents: 25, envelopeBudgetBytes: 0 },
		...(deps.boundProjectGate !== undefined ? { boundProjectGate: deps.boundProjectGate } : {}),
		...(deps.inboxCapture !== undefined ? { inboxCapture: deps.inboxCapture } : {}),
		...(deps.tenancyConfirmed !== undefined ? { tenancyConfirmed: deps.tenancyConfirmed } : {}),
		...(deps.env !== undefined ? { env: deps.env } : {}),
	});
	handler.register(daemon);
	return { daemon, fake, enqueued, gated };
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

describe("073a-AC-1: unbound folders are silent (inbox off)", () => {
	it("073a-AC-1.1: bound:false + inbox off → no row, no enqueue, ack { ok, gated, reason: no_bound_project }", async () => {
		const { daemon, fake, enqueued, gated } = buildDaemon({ projectsDir: emptyDir(), boundProjectGate: true });
		const res = await postCapture(daemon, "/work/scratch");
		expect(res.status).toBe(200);
		const body = (await res.json()) as { ok: boolean; gated?: boolean; reason?: string };
		expect(body.ok).toBe(true);
		expect(body.gated).toBe(true);
		expect(body.reason).toBe("no_bound_project");
		expect(sessionsInserts(fake)).toEqual([]);
		expect(enqueued).toEqual([]);
		expect(gated.read().no_bound_project).toBe(1);
	});

	it("073a-AC-1.2: gate is PER-SESSION — an unbound cwd is gated even when other projects are bound", async () => {
		const { daemon, fake } = buildDaemon({
			projectsDir: seedCache([{ path: "/work/api", projectId: "proj-api" }]),
			boundProjectGate: true,
		});
		const res = await postCapture(daemon, "/somewhere/else");
		expect(res.status).toBe(200);
		expect((await res.json()).reason).toBe("no_bound_project");
		expect(sessionsInserts(fake)).toEqual([]);
	});

	it("073a-AC-1.3: zero bindings → repeated captures leave table row counts unchanged", async () => {
		const { daemon, fake } = buildDaemon({ projectsDir: emptyDir(), boundProjectGate: true });
		for (let i = 0; i < 3; i += 1) await postCapture(daemon, "/tmp/x");
		expect(sessionsInserts(fake)).toEqual([]);
		// Not even the heal-introspection SELECT runs — the handler returns before any storage call.
		expect(fake.requests.length).toBe(0);
	});
});

describe("073a-AC-2: bound folders are unchanged", () => {
	it("073a-AC-2.1: a cwd under a binding captures with the resolved projectId", async () => {
		const { daemon, fake } = buildDaemon({
			projectsDir: seedCache([{ path: "/work/api", projectId: "proj-api" }]),
			boundProjectGate: true,
		});
		const res = await postCapture(daemon, "/work/api/src");
		expect(res.status).toBe(201);
		const inserts = sessionsInserts(fake);
		expect(inserts.length).toBe(1);
		expect(inserts[0]).toContain("'proj-api'");
	});

	it("073a-AC-2.2: HONEYCOMB_PROJECT_ID override captures from ANY cwd, never gated", async () => {
		const { daemon, fake } = buildDaemon({
			projectsDir: emptyDir(),
			boundProjectGate: true,
			env: { HONEYCOMB_PROJECT_ID: "pinned-proj" },
		});
		const res = await postCapture(daemon, "/anywhere/unbound");
		expect(res.status).toBe(201);
		const inserts = sessionsInserts(fake);
		expect(inserts.length).toBe(1);
		expect(inserts[0]).toContain("'pinned-proj'");
	});
});

describe("073a-AC-3: the inbox is a choice", () => {
	it("073a-AC-3.1: inbox ON → an unbound-cwd capture lands under __unsorted__ and pipelines run", async () => {
		const { daemon, fake, enqueued } = buildDaemon({
			projectsDir: seedCache([{ path: "/work/api", projectId: "proj-api" }]),
			boundProjectGate: true,
			inboxCapture: true,
		});
		const res = await postCapture(daemon, "/unbound/here");
		expect(res.status).toBe(201);
		const inserts = sessionsInserts(fake);
		expect(inserts.length).toBe(1);
		expect(inserts[0]).toContain("'__unsorted__'");
		expect(enqueued).toContain("pipeline-entry");
	});

	it("073a-AC-3.2: the inbox opt-in defaults OFF (unset env)", () => {
		expect(resolveInboxCaptureEnabled({})).toBe(false);
		expect(resolveInboxCaptureEnabled({ HONEYCOMB_INBOX_CAPTURE: "garbage" })).toBe(false);
		expect(resolveInboxCaptureEnabled({ HONEYCOMB_INBOX_CAPTURE: "true" })).toBe(true);
		expect(resolveInboxCaptureEnabled({ HONEYCOMB_INBOX_CAPTURE: "1" })).toBe(true);
	});
});

describe("073c tie: capture waits for confirmed tenancy (parent AC-9)", () => {
	it("073c-AC-3.1: tenancy unconfirmed + folder bindings present → gated tenancy_unconfirmed", async () => {
		const { daemon, fake, gated } = buildDaemon({
			projectsDir: seedCache([{ path: "/work/api", projectId: "proj-api" }]),
			boundProjectGate: true,
			tenancyConfirmed: () => false,
		});
		const res = await postCapture(daemon, "/work/api/src"); // a BOUND cwd — still gated on tenancy.
		expect(res.status).toBe(200);
		expect((await res.json()).reason).toBe("tenancy_unconfirmed");
		expect(sessionsInserts(fake)).toEqual([]);
		expect(gated.read().tenancy_unconfirmed).toBe(1);
	});

	it("confirmed tenancy + bound cwd → capture proceeds", async () => {
		const { daemon, fake } = buildDaemon({
			projectsDir: seedCache([{ path: "/work/api", projectId: "proj-api" }]),
			boundProjectGate: true,
			tenancyConfirmed: () => true,
		});
		const res = await postCapture(daemon, "/work/api/src");
		expect(res.status).toBe(201);
		expect(sessionsInserts(fake).length).toBe(1);
	});

	it("a throwing tenancy seam FAILS OPEN (capture proceeds for a bound cwd)", async () => {
		const { daemon, fake } = buildDaemon({
			projectsDir: seedCache([{ path: "/work/api", projectId: "proj-api" }]),
			boundProjectGate: true,
			tenancyConfirmed: () => {
				throw new Error("seam hiccup");
			},
		});
		const res = await postCapture(daemon, "/work/api/src");
		expect(res.status).toBe(201);
		expect(sessionsInserts(fake).length).toBe(1);
	});
});

describe("073a back-compat: gates are opt-in", () => {
	it("with no gate deps wired, an unbound cwd still captures (pre-073 behavior)", async () => {
		const { daemon, fake } = buildDaemon({ projectsDir: emptyDir() });
		const res = await postCapture(daemon, "/work/scratch");
		expect(res.status).toBe(201);
		expect(sessionsInserts(fake)[0]).toContain("'__unsorted__'");
	});
});
