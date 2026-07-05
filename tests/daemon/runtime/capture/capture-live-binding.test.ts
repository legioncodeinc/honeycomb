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
 * Live-reload of a folder→project binding WITHOUT a daemon restart.
 *
 * A `honeycomb project bind` writes a new entry into `~/.deeplake/projects.json`. The bug this pins:
 * a binding written AFTER the daemon booted was invisible, so a capture in that folder kept gating
 * `no_bound_project` (149 events observed dropped live) until an operator restarted the daemon.
 *
 * The capture handler resolves the session's project per-request through `resolveScopeFromDisk`
 * (→ `loadProjectsCache`, which reads `projects.json` fresh on every call — no module-level cache).
 * These tests hold the handler FIXED across the write to prove the SAME running handler honors the
 * new binding on the very next capture: gated → written, no restart, using the existing `projectsDir`
 * seam that the production assembly wires to `~/.deeplake`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createCaptureHandler } from "../../../../src/daemon/runtime/capture/capture-handler.js";
import { createGatedCapturesCounter } from "../../../../src/daemon/runtime/capture/gated-captures.js";
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

/** A fresh projects-cache dir with NO bindings yet (the pre-bind state). */
function emptyProjectsDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "hc-livebind-"));
	tempDirs.push(dir);
	return dir;
}

/** Write (or overwrite) `projects.json` in `dir` with the given folder→project bindings. */
function writeBinding(dir: string, bindings: Array<{ path: string; projectId: string }>): void {
	writeFileSync(
		join(dir, "projects.json"),
		JSON.stringify({ schemaVersion: 1, org: ORG, workspace: WORKSPACE, bindings, projects: [] }),
		"utf8",
	);
}

function responder() {
	return (req: TransportRequest): Record<string, unknown>[] => {
		if (/information_schema\.columns/i.test(req.sql)) {
			return healTargetFor("sessions").columns.map((c) => ({ column_name: c.name }));
		}
		return [];
	};
}

function buildHandlerDaemon(projectsDir: string): { daemon: Daemon; fake: FakeDeepLakeTransport } {
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
		queue: {
			async enqueue() {
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
		gatedCaptures: createGatedCapturesCounter(),
		captureConfig: { batch: false, windowMs: 1_000, maxEvents: 25, envelopeBudgetBytes: 0 },
		// The per-session bound-project gate is ON (the production posture) so an unbound cwd gates.
		boundProjectGate: true,
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

describe("live-reload: a projects.json binding written after boot is honored (no restart)", () => {
	it("gated no_bound_project before the bind, then captured to the bound project after — same handler", async () => {
		const dir = emptyProjectsDir();
		const { daemon, fake } = buildHandlerDaemon(dir);

		// BEFORE the bind: the cwd resolves to no bound project → gated, nothing written.
		const before = await postCapture(daemon, "/work/api/src");
		expect(before.status).toBe(200);
		expect((await before.json()).reason).toBe("no_bound_project");
		expect(sessionsInserts(fake)).toEqual([]);

		// `honeycomb project bind /work/api proj-api` writes the binding to the SAME cache file the
		// running handler reads — no restart, no re-construction of the handler.
		writeBinding(dir, [{ path: "/work/api", projectId: "proj-api" }]);

		// AFTER the bind: the very next capture in that folder is honored and attributed to proj-api.
		const after = await postCapture(daemon, "/work/api/src");
		expect(after.status).toBe(201);
		const inserts = sessionsInserts(fake);
		expect(inserts.length).toBe(1);
		expect(inserts[0]).toContain("'proj-api'");
	});

	it("a binding REMOVED after boot re-gates the folder on the next capture (live in both directions)", async () => {
		const dir = emptyProjectsDir();
		writeBinding(dir, [{ path: "/work/api", projectId: "proj-api" }]);
		const { daemon, fake } = buildHandlerDaemon(dir);

		// Bound → captured.
		const first = await postCapture(daemon, "/work/api/src");
		expect(first.status).toBe(201);
		expect(sessionsInserts(fake).length).toBe(1);

		// The binding is removed on disk (e.g. an `unbind`); the running handler picks up the empty
		// cache on the next capture and re-gates the now-unbound folder.
		writeBinding(dir, []);
		const second = await postCapture(daemon, "/work/api/src");
		expect(second.status).toBe(200);
		expect((await second.json()).reason).toBe("no_bound_project");
		// Still exactly one INSERT — the second capture wrote nothing.
		expect(sessionsInserts(fake).length).toBe(1);
	});
});
