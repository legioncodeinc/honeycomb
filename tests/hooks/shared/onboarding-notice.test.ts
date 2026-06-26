/**
 * PRD-059a / IRD-123 — the session-start "bind a project to start" notice suite (a-AC-2).
 *
 * The notice is the SESSION-START half of the first-run gate: when the active workspace has bound no
 * project, session-start prepends ONE quiet "bind a project to start" notice to the rendered
 * `additionalContext` (once per session, NOT per turn — that is the session-start seam). Once a project
 * is bound, no notice appears. The check is a pure local read (no DeepLake) and is fail-soft.
 *
 * Driven against the recording fakes + an injected {@link OnboardingNoticeGate}, plus the REAL
 * disk-backed gate over a temp `~/.deeplake/projects.json` to prove the production read path.
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
	type OnboardingNoticeGate,
	type SessionStartDeps,
} from "../../../src/hooks/shared/contracts.js";
import { BIND_PROJECT_NOTICE, createOnboardingNoticeGate, runSessionStart } from "../../../src/hooks/shared/session-start.js";

const META = { sessionId: "sess-1", path: "conv-1", cwd: "/repo", agent: "claude-code" } as const;

function startInput(over: Partial<HookInput> = {}): HookInput {
	return { event: "session-start", meta: { ...META }, runtimePath: "plugin", ...over };
}

function baseDeps(over: Partial<SessionStartDeps> = {}): SessionStartDeps {
	return {
		daemon: createFakeDaemonHookClient(),
		credentials: createFakeCredentialReader({ token: "t", org: "acme" }),
		context: createFakeContextRenderer("## Rules\n- be kind"),
		seams: createFakeSessionStartSeams(),
		captureEnv: { captureFlag: undefined },
		...over,
	};
}

/** A gate returning a fixed bound/unbound answer. */
function gate(hasBound: boolean): OnboardingNoticeGate {
	return { hasBoundProject: () => hasBound };
}

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

describe("session-start onboarding notice (a-AC-2)", () => {
	it("prepends the 'bind a project to start' notice when the workspace has NO bound project", async () => {
		const result = await runSessionStart(startInput(), baseDeps({ onboardingNotice: gate(false) }));
		expect(result.ok).toBe(true);
		expect(result.additionalContext).toContain(BIND_PROJECT_NOTICE);
		// The notice LEADS, before the rules/goals block.
		expect(result.additionalContext?.indexOf(BIND_PROJECT_NOTICE)).toBe(0);
		expect(result.additionalContext).toContain("Rules");
	});

	it("shows NO notice when the workspace already has a bound project", async () => {
		const result = await runSessionStart(startInput(), baseDeps({ onboardingNotice: gate(true) }));
		expect(result.additionalContext ?? "").not.toContain(BIND_PROJECT_NOTICE);
		expect(result.additionalContext).toContain("Rules");
	});

	it("is inert when no gate is wired (prior behaviour unchanged)", async () => {
		const result = await runSessionStart(startInput(), baseDeps());
		expect(result.additionalContext ?? "").not.toContain(BIND_PROJECT_NOTICE);
	});

	it("a throwing gate never breaks session-start (fail-soft, no notice)", async () => {
		const throwing: OnboardingNoticeGate = {
			hasBoundProject() {
				throw new Error("boom");
			},
		};
		const result = await runSessionStart(startInput(), baseDeps({ onboardingNotice: throwing }));
		expect(result.ok).toBe(true);
		expect(result.additionalContext ?? "").not.toContain(BIND_PROJECT_NOTICE);
	});
});

describe("createOnboardingNoticeGate — the REAL disk-backed read (a-AC-3)", () => {
	it("reads the local cache with no network: zero bindings → notice shown", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hc-notice-"));
		tempDirs.push(dir);
		writeFileSync(
			join(dir, "projects.json"),
			JSON.stringify({ schemaVersion: 1, org: "acme", workspace: "backend", bindings: [], projects: [] }),
			"utf8",
		);
		const result = await runSessionStart(
			startInput(),
			baseDeps({
				credentials: createFakeCredentialReader({ token: "t", org: "acme", workspace: "backend" }),
				onboardingNotice: createOnboardingNoticeGate(dir),
			}),
		);
		expect(result.additionalContext).toContain(BIND_PROJECT_NOTICE);
	});

	it("a bound project in the cache → no notice", async () => {
		const dir = mkdtempSync(join(tmpdir(), "hc-notice-"));
		tempDirs.push(dir);
		writeFileSync(
			join(dir, "projects.json"),
			JSON.stringify({
				schemaVersion: 1,
				org: "acme",
				workspace: "backend",
				bindings: [{ path: "/work/api", projectId: "api" }],
				projects: [],
			}),
			"utf8",
		);
		const result = await runSessionStart(
			startInput(),
			baseDeps({
				credentials: createFakeCredentialReader({ token: "t", org: "acme", workspace: "backend" }),
				onboardingNotice: createOnboardingNoticeGate(dir),
			}),
		);
		expect(result.additionalContext ?? "").not.toContain(BIND_PROJECT_NOTICE);
	});
});
