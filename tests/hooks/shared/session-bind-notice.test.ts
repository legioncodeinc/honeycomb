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
 * PRD-073b — the PER-SESSION bind notice (AC-073b.2.2). Unlike the 059a workspace-level notice, this
 * renders whenever THIS session's cwd is unbound (inbox opt-in off), with a cwd-specific copy when the
 * workspace already has OTHER bound projects. Once per session, fail-soft. Driven against the REAL
 * disk-backed gate over a temp `~/.deeplake/projects.json`.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
	createFakeContextRenderer,
	createFakeCredentialReader,
	createFakeDaemonHookClient,
	createFakeSessionStartSeams,
	type HookInput,
	type SessionStartDeps,
} from "../../../src/hooks/shared/contracts.js";
import {
	BIND_PROJECT_CWD_NOTICE,
	BIND_PROJECT_NOTICE,
	createSessionBindNoticeGate,
	runSessionStart,
} from "../../../src/hooks/shared/session-start.js";

const ORG = "acme";
const WORKSPACE = "backend";

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

function seed(bindings: Array<{ path: string; projectId: string }>): string {
	const dir = mkdtempSync(join(tmpdir(), "hc-bindnotice-"));
	tempDirs.push(dir);
	writeFileSync(
		join(dir, "projects.json"),
		JSON.stringify({ schemaVersion: 1, org: ORG, workspace: WORKSPACE, bindings, projects: [] }),
		"utf8",
	);
	return dir;
}

function startInput(cwd: string): HookInput {
	return {
		event: "session-start",
		meta: { sessionId: "sess-1", path: "conv-1", cwd, agent: "claude-code" },
		runtimePath: "plugin",
	};
}

function deps(dir: string, env: NodeJS.ProcessEnv, over: Partial<SessionStartDeps> = {}): SessionStartDeps {
	return {
		daemon: createFakeDaemonHookClient(),
		credentials: createFakeCredentialReader({ token: "t", org: ORG, workspace: WORKSPACE }),
		context: createFakeContextRenderer("## Rules\n- be kind"),
		seams: createFakeSessionStartSeams(),
		captureEnv: { captureFlag: undefined },
		onboardingNotice: createSessionBindNoticeGate({ dir, env }),
		...over,
	};
}

describe("073b-AC-2.2: the per-session bind notice renders once with the cwd-specific copy", () => {
	it("an unbound cwd while the workspace has OTHER bound projects → the cwd-specific notice", async () => {
		const dir = seed([{ path: "/work/api", projectId: "proj-api" }]);
		const result = await runSessionStart(startInput("/some/other/folder"), deps(dir, {}));
		expect(result.additionalContext).toContain(BIND_PROJECT_CWD_NOTICE);
		// Rendered exactly once, and leading before the rules block.
		expect(result.additionalContext?.indexOf(BIND_PROJECT_CWD_NOTICE)).toBe(0);
		expect(result.additionalContext?.split(BIND_PROJECT_CWD_NOTICE).length).toBe(2);
		expect(result.additionalContext).toContain("Rules");
	});

	it("a genuinely fresh install (zero bindings) → the workspace-level notice", async () => {
		const dir = seed([]);
		const result = await runSessionStart(startInput("/work/api/src"), deps(dir, {}));
		expect(result.additionalContext).toContain(BIND_PROJECT_NOTICE);
	});

	it("a BOUND cwd → NO notice (this session is captured)", async () => {
		const dir = seed([{ path: "/work/api", projectId: "proj-api" }]);
		const result = await runSessionStart(startInput("/work/api/src"), deps(dir, {}));
		expect(result.additionalContext ?? "").not.toContain(BIND_PROJECT_NOTICE);
		expect(result.additionalContext ?? "").not.toContain(BIND_PROJECT_CWD_NOTICE);
	});

	it("the inbox opt-in ON → NO notice (unbound folders are inboxed, not dormant)", async () => {
		const dir = seed([{ path: "/work/api", projectId: "proj-api" }]);
		const result = await runSessionStart(startInput("/unbound/here"), deps(dir, { HONEYCOMB_INBOX_CAPTURE: "true" }));
		expect(result.additionalContext ?? "").not.toContain(BIND_PROJECT_CWD_NOTICE);
		expect(result.additionalContext ?? "").not.toContain(BIND_PROJECT_NOTICE);
	});

	it("not logged in → NO notice (login precedes bind)", async () => {
		const dir = seed([]);
		const result = await runSessionStart(
			startInput("/unbound"),
			deps(dir, {}, { credentials: createFakeCredentialReader(undefined) }),
		);
		expect(result.additionalContext ?? "").not.toContain(BIND_PROJECT_NOTICE);
	});
});
