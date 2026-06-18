/**
 * PRD-019b session-start suite — b-AC-3, b-AC-6 (FR-3 / FR-8 / FR-10).
 *
 * Driven against the recording fakes. b-AC-3 asserts the FR-3 ORDER, the capture
 * gate gating ensure+placeholder, and the returned `additionalContext`. b-AC-6
 * asserts every hook call stamps `x-honeycomb-runtime-path` and that the daemon's
 * `409` (driven via `createFakeDaemonHookClient({ status: 409 })`) is SURFACED, not
 * re-tested (the daemon enforces; this core stamps — D-6).
 */

import { describe, expect, it } from "vitest";

import {
	createFakeContextRenderer,
	createFakeCredentialReader,
	createFakeDaemonHookClient,
	createFakeSessionStartSeams,
	type HookInput,
	type SessionStartDeps,
} from "../../../src/hooks/shared/contracts.js";
import { runSessionStart } from "../../../src/hooks/shared/session-start.js";
import { createContextRenderer } from "../../../src/hooks/shared/context-renderer.js";
import { runCapture } from "../../../src/hooks/shared/capture.js";

const META = { sessionId: "sess-1", path: "conv-1", cwd: "/repo", agent: "claude-code" } as const;

function startInput(over: Partial<HookInput> = {}): HookInput {
	return { event: "session-start", meta: { ...META }, runtimePath: "plugin", ...over };
}

describe("PRD-019b session-start core", () => {
	it("b-AC-3: ensures tables + placeholder + context + returns additionalContext, in FR-3 order", async () => {
		const seams = createFakeSessionStartSeams();
		const d: SessionStartDeps = {
			daemon: createFakeDaemonHookClient(),
			credentials: createFakeCredentialReader({ token: "t", org: "acme" }),
			context: createFakeContextRenderer("## Rules\n- be kind\n## Goals\n- ship 019b"),
			seams,
			captureEnv: { captureFlag: undefined }, // capture enabled (default)
		};

		const result = await runSessionStart(startInput(), d);

		// additionalContext is the rendered block (b-AC-3).
		expect(result.ok).toBe(true);
		expect(result.additionalContext).toContain("Goals");

		// FR-3 ORDER: heal → autoUpdate → ensureTables → placeholder → (render) → pull → graph.
		expect(seams.steps.map((s) => s.step)).toEqual([
			"healDriftedOrgToken",
			"autoUpdate",
			"ensureTables",
			"writePlaceholderSummary",
			"autoPullSkills",
			"spawnGraphPull",
		]);
	});

	it("b-AC-3: capture-gate OFF skips ensureTables + placeholder but STILL renders context", async () => {
		const seams = createFakeSessionStartSeams();
		const d: SessionStartDeps = {
			daemon: createFakeDaemonHookClient(),
			credentials: createFakeCredentialReader(),
			context: createFakeContextRenderer("BLOCK"),
			seams,
			captureEnv: { captureFlag: "false" }, // capture disabled
		};

		const result = await runSessionStart(startInput(), d);

		// The gated steps never ran; the read-only context still rendered + returned.
		expect(seams.steps.map((s) => s.step)).toEqual([
			"healDriftedOrgToken",
			"autoUpdate",
			"autoPullSkills",
			"spawnGraphPull",
		]);
		expect(result.additionalContext).toBe("BLOCK");
	});

	it("b-AC-3 / FR-10: a throwing step is absorbed and the lifecycle still returns context", async () => {
		const seams = createFakeSessionStartSeams({ throwOn: new Set(["autoUpdate", "spawnGraphPull"]) });
		const d: SessionStartDeps = {
			daemon: createFakeDaemonHookClient(),
			credentials: createFakeCredentialReader(),
			context: createFakeContextRenderer("STILL HERE"),
			seams,
		};

		const result = await runSessionStart(startInput(), d);
		expect(result.ok).toBe(true);
		expect(result.additionalContext).toBe("STILL HERE");
		// Every step was still ATTEMPTED in order despite two of them throwing.
		expect(seams.steps.map((s) => s.step)).toEqual([
			"healDriftedOrgToken",
			"autoUpdate",
			"ensureTables",
			"writePlaceholderSummary",
			"autoPullSkills",
			"spawnGraphPull",
		]);
	});

	it("b-AC-3 / FR-10: the context renderer absorbs a daemon error and returns no block", async () => {
		// A renderer over a daemon that rejects must fail soft to "" — never throw.
		const rejecting = {
			async send(): Promise<never> {
				throw new Error("context fetch failed");
			},
		};
		const renderer = createContextRenderer(rejecting as unknown as Parameters<typeof createContextRenderer>[0]);
		const d: SessionStartDeps = {
			daemon: createFakeDaemonHookClient(),
			credentials: createFakeCredentialReader(),
			context: renderer,
			seams: createFakeSessionStartSeams(),
		};
		const result = await runSessionStart(startInput(), d);
		expect(result.ok).toBe(true);
		expect(result.additionalContext).toBeUndefined(); // empty block → omitted
	});

	it("b-AC-6: the second runtime path is rejected with 409 (daemon enforces; core surfaces)", async () => {
		// First path claims `plugin` and succeeds.
		const okClient = createFakeDaemonHookClient({ status: 200 });
		const okDeps = {
			daemon: okClient,
			credentials: createFakeCredentialReader(),
			context: createFakeContextRenderer(),
		};
		const first = await runCapture(
			{ event: "user_message", meta: { ...META }, data: { kind: "user_message", text: "hi" }, runtimePath: "plugin" },
			okDeps,
			{},
		);
		expect(first.ok).toBe(true);
		expect(okClient.calls[0].runtimePath).toBe("plugin");

		// Second path (`legacy`) on the same session → the daemon returns 409. The core
		// SURFACES it as a conflict, and STAMPED the header so the daemon could enforce.
		const conflictClient = createFakeDaemonHookClient({ status: 409 });
		const conflictDeps = {
			daemon: conflictClient,
			credentials: createFakeCredentialReader(),
			context: createFakeContextRenderer(),
		};
		const second = await runCapture(
			{ event: "user_message", meta: { ...META }, data: { kind: "user_message", text: "hi" }, runtimePath: "legacy" },
			conflictDeps,
			{},
		);
		expect(second.ok).toBe(false);
		expect(second.reason).toBe("runtime-path-conflict");
		expect(conflictClient.calls[0].runtimePath).toBe("legacy");
	});
});
