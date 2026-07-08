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
import { runCapture } from "../../../src/hooks/shared/capture.js";
import { createContextRenderer } from "../../../src/hooks/shared/context-renderer.js";
import {
	type ContextRenderer,
	createFakeContextRenderer,
	createFakeCredentialReader,
	createFakeDaemonHookClient,
	createFakePrimeRenderer,
	createFakeSessionStartSeams,
	type HookInput,
	type PrimeRenderer,
	type SessionStartDeps,
} from "../../../src/hooks/shared/contracts.js";
import {
	BIND_PROJECT_NOTICE,
	joinBlocks,
	RECALL_AWARENESS_NOTICE,
	runSessionStart,
} from "../../../src/hooks/shared/session-start.js";

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

		// FR-3 ORDER: heal → autoUpdate → ensureTables → placeholder → (render) → pull skills →
		// pull assets → graph.
		expect(seams.steps.map((s) => s.step)).toEqual([
			"healDriftedOrgToken",
			"autoUpdate",
			"ensureTables",
			"writePlaceholderSummary",
			"autoPullSkills",
			"autoPullAssets",
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
			"autoPullAssets",
			"spawnGraphPull",
		]);
		expect(result.additionalContext).toBe(`BLOCK\n\n${RECALL_AWARENESS_NOTICE}`);
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
		expect(result.additionalContext).toBe(`STILL HERE\n\n${RECALL_AWARENESS_NOTICE}`);
		// Every step was still ATTEMPTED in order despite two of them throwing.
		expect(seams.steps.map((s) => s.step)).toEqual([
			"healDriftedOrgToken",
			"autoUpdate",
			"ensureTables",
			"writePlaceholderSummary",
			"autoPullSkills",
			"autoPullAssets",
			"spawnGraphPull",
		]);
	});

	it("PRD-033 R-1: invokes autoPullAssets right after autoPullSkills (before spawnGraphPull)", async () => {
		const seams = createFakeSessionStartSeams();
		const d: SessionStartDeps = {
			daemon: createFakeDaemonHookClient(),
			credentials: createFakeCredentialReader({ token: "t", org: "acme" }),
			context: createFakeContextRenderer("BLOCK"),
			seams,
		};

		await runSessionStart(startInput(), d);

		const order = seams.steps.map((s) => s.step);
		const skillsIdx = order.indexOf("autoPullSkills");
		const assetsIdx = order.indexOf("autoPullAssets");
		const graphIdx = order.indexOf("spawnGraphPull");
		expect(assetsIdx).toBeGreaterThan(-1);
		expect(assetsIdx).toBe(skillsIdx + 1); // immediately after the skills pull
		expect(assetsIdx).toBeLessThan(graphIdx); // before graph-pull
	});

	it("PRD-033 R-1 / FR-10: a THROWING autoPullAssets is absorbed — session-start still returns context", async () => {
		const seams = createFakeSessionStartSeams({ throwOn: new Set(["autoPullAssets"]) });
		const d: SessionStartDeps = {
			daemon: createFakeDaemonHookClient(),
			credentials: createFakeCredentialReader({ token: "t", org: "acme" }),
			context: createFakeContextRenderer("STILL HERE"),
			seams,
		};

		const result = await runSessionStart(startInput(), d);

		// The asset pull blew up, but session start absorbed it and returned its context block,
		// and the LATER steps (spawnGraphPull) still ran.
		expect(result.ok).toBe(true);
		expect(result.additionalContext).toBe(`STILL HERE\n\n${RECALL_AWARENESS_NOTICE}`);
		expect(seams.steps.map((s) => s.step)).toContain("autoPullAssets");
		expect(seams.steps.map((s) => s.step)).toContain("spawnGraphPull");
	});

	it("b-AC-3 / FR-10 / c-AC-3: the context renderer absorbs a daemon error and returns no block, but the recall notice still carries", async () => {
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
		// The context block is empty (c-AC-3: notice-only carries just the notice), never throws.
		expect(result.additionalContext).toBe(RECALL_AWARENESS_NOTICE);
	});

	it("b-AC-3: passes the harness runtime path into the context renderer", async () => {
		const seen: string[] = [];
		const recordingContext: ContextRenderer = {
			async render(req): Promise<string> {
				if (req.runtimePath !== undefined) seen.push(req.runtimePath);
				return "BLOCK";
			},
		};
		const d: SessionStartDeps = {
			daemon: createFakeDaemonHookClient(),
			credentials: createFakeCredentialReader(),
			context: recordingContext,
			seams: createFakeSessionStartSeams(),
		};

		await runSessionStart(startInput({ runtimePath: "legacy" }), d);

		expect(seen).toEqual(["legacy"]);
	});

	it("b-AC-3: the production context renderer stamps the requested runtime path", async () => {
		const daemon = createFakeDaemonHookClient({ body: { additionalContext: "BLOCK" } });
		const renderer = createContextRenderer(daemon);

		const block = await renderer.render({ meta: META, runtimePath: "legacy" });

		expect(block).toBe("BLOCK");
		expect(daemon.calls[0].runtimePath).toBe("legacy");
	});

	// ── PRD-046d: the session-start memory prime (d-AC-1/d-AC-2 at the core; d-AC-4) ──

	it("d-AC-1/d-AC-2: the prime digest is APPENDED to the rendered context block", async () => {
		const d: SessionStartDeps = {
			daemon: createFakeDaemonHookClient(),
			credentials: createFakeCredentialReader({ token: "t", org: "acme" }),
			context: createFakeContextRenderer("## Rules\n- be kind"),
			prime: createFakePrimeRenderer("## Memory\n- decided X"),
			seams: createFakeSessionStartSeams(),
		};
		const result = await runSessionStart(startInput(), d);
		// Both blocks are present, the prime after the rules block, separated by a blank line, and
		// the recall-awareness notice trails after both (c-AC-2: an added block, not a replacement).
		expect(result.additionalContext).toBe(
			`## Rules\n- be kind\n\n## Memory\n- decided X\n\n${RECALL_AWARENESS_NOTICE}`,
		);
	});

	it("d-AC-1: passes the harness runtime path into the prime renderer", async () => {
		const seen: string[] = [];
		const recordingPrime: PrimeRenderer = {
			async render(req): Promise<string> {
				if (req.runtimePath !== undefined) seen.push(req.runtimePath);
				return "## Memory\n- decided X";
			},
		};
		const d: SessionStartDeps = {
			daemon: createFakeDaemonHookClient(),
			credentials: createFakeCredentialReader({ token: "t", org: "acme" }),
			context: createFakeContextRenderer(""),
			prime: recordingPrime,
			seams: createFakeSessionStartSeams(),
		};

		await runSessionStart(startInput({ runtimePath: "legacy" }), d);

		expect(seen).toEqual(["legacy"]);
	});

	it("d-AC-1/d-AC-2: the prime is injected even when there is no rules/goals context block", async () => {
		const d: SessionStartDeps = {
			daemon: createFakeDaemonHookClient(),
			credentials: createFakeCredentialReader({ token: "t", org: "acme" }),
			context: createFakeContextRenderer(""), // no rules/goals block
			prime: createFakePrimeRenderer("## Memory\n- decided X"),
			seams: createFakeSessionStartSeams(),
		};
		const result = await runSessionStart(startInput(), d);
		expect(result.additionalContext).toBe(`## Memory\n- decided X\n\n${RECALL_AWARENESS_NOTICE}`);
	});

	it("d-AC-4: a cold-repo / unreachable prime ('') contributes NOTHING — only the context block remains", async () => {
		const d: SessionStartDeps = {
			daemon: createFakeDaemonHookClient(),
			credentials: createFakeCredentialReader({ token: "t", org: "acme" }),
			context: createFakeContextRenderer("## Rules\n- be kind"),
			prime: createFakePrimeRenderer(""), // cold repo / daemon down → no digest
			seams: createFakeSessionStartSeams(),
		};
		const result = await runSessionStart(startInput(), d);
		expect(result.additionalContext).toBe(`## Rules\n- be kind\n\n${RECALL_AWARENESS_NOTICE}`);
	});

	it("d-AC-4: a THROWING prime renderer is absorbed — session-start still returns the context block", async () => {
		const throwingPrime: PrimeRenderer = {
			async render(): Promise<string> {
				throw new Error("prime fetch exploded");
			},
		};
		const d: SessionStartDeps = {
			daemon: createFakeDaemonHookClient(),
			credentials: createFakeCredentialReader({ token: "t", org: "acme" }),
			context: createFakeContextRenderer("## Rules\n- be kind"),
			prime: throwingPrime,
			seams: createFakeSessionStartSeams(),
		};
		const result = await runSessionStart(startInput(), d);
		expect(result.ok).toBe(true);
		expect(result.additionalContext).toBe(`## Rules\n- be kind\n\n${RECALL_AWARENESS_NOTICE}`);
	});

	it("d-AC-4 / c-AC-3: both empty (no context + cold prime) now carries ONLY the recall-awareness notice (PRD-075c)", async () => {
		const d: SessionStartDeps = {
			daemon: createFakeDaemonHookClient(),
			credentials: createFakeCredentialReader(),
			context: createFakeContextRenderer(""),
			prime: createFakePrimeRenderer(""),
			seams: createFakeSessionStartSeams(),
		};
		const result = await runSessionStart(startInput(), d);
		expect(result.ok).toBe(true);
		// Pre-075c this omitted `additionalContext` entirely; the recall notice is now a
		// standing, unconditional block (c-AC-3's "notice-only" case), so it survives alone.
		expect(result.additionalContext).toBe(RECALL_AWARENESS_NOTICE);
	});

	it("d-AC-3: with NO prime seam wired, session-start is unchanged (no prime, prior behaviour)", async () => {
		const d: SessionStartDeps = {
			daemon: createFakeDaemonHookClient(),
			credentials: createFakeCredentialReader(),
			context: createFakeContextRenderer("## Rules\n- be kind"),
			seams: createFakeSessionStartSeams(),
			// no `prime` — the absent-seam path is a no-op.
		};
		const result = await runSessionStart(startInput(), d);
		expect(result.additionalContext).toBe(`## Rules\n- be kind\n\n${RECALL_AWARENESS_NOTICE}`);
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

	// ── PRD-075c: the recall-awareness notice (c-AC-1..c-AC-3) ──

	it("c-AC-1: additionalContext includes the recall-awareness notice on a normal session-start run", async () => {
		const d: SessionStartDeps = {
			daemon: createFakeDaemonHookClient(),
			credentials: createFakeCredentialReader({ token: "t", org: "acme" }),
			context: createFakeContextRenderer("## Rules\n- be kind\n## Goals\n- ship 075c"),
			prime: createFakePrimeRenderer("## Memory\n- decided X"),
			seams: createFakeSessionStartSeams(),
		};

		const result = await runSessionStart(startInput(), d);

		expect(result.additionalContext).toContain(RECALL_AWARENESS_NOTICE);
	});

	it("c-AC-2: the existing digest/prime/first-run-notice content survives unchanged alongside the recall notice", async () => {
		const d: SessionStartDeps = {
			daemon: createFakeDaemonHookClient(),
			credentials: createFakeCredentialReader({ token: "t", org: "acme" }),
			context: createFakeContextRenderer("## Rules\n- be kind"),
			prime: createFakePrimeRenderer("## Memory\n- decided X"),
			onboardingNotice: { hasBoundProject: () => false }, // 059a first-run notice shows
			seams: createFakeSessionStartSeams(),
		};

		const result = await runSessionStart(startInput(), d);

		// The notice is an ADDED block: every prior block is still present, verbatim, and the
		// recall-awareness notice is additional (not a replacement for any of them).
		expect(result.additionalContext).toContain(BIND_PROJECT_NOTICE);
		expect(result.additionalContext).toContain("## Rules\n- be kind");
		expect(result.additionalContext).toContain("## Memory\n- decided X");
		expect(result.additionalContext).toContain(RECALL_AWARENESS_NOTICE);
		// Exact composition: first-run notice leads, recall-awareness notice trails.
		expect(result.additionalContext).toBe(
			`${BIND_PROJECT_NOTICE}\n\n## Rules\n- be kind\n\n## Memory\n- decided X\n\n${RECALL_AWARENESS_NOTICE}`,
		);
	});

	it("c-AC-3: with all other blocks empty, additionalContext carries JUST the recall notice (never throws)", async () => {
		const d: SessionStartDeps = {
			daemon: createFakeDaemonHookClient(),
			credentials: createFakeCredentialReader(),
			context: createFakeContextRenderer(""),
			prime: createFakePrimeRenderer(""),
			seams: createFakeSessionStartSeams(),
		};

		await expect(runSessionStart(startInput(), d)).resolves.toEqual({
			ok: true,
			additionalContext: RECALL_AWARENESS_NOTICE,
		});
	});

	it("c-AC-3: joinBlocks, the underlying composition helper, omits additionalContext when EVERY block is empty (including a hypothetically-absent notice)", () => {
		// Direct unit coverage of the pure join/omit rule that composes noticeBlock, contextBlock,
		// primeBlock, and the recall-awareness notice: all-empty (as if the notice were disabled
		// or absent too) still reduces to "", so the caller correctly omits `additionalContext`.
		expect(joinBlocks("", "", "", "")).toBe("");
	});

	it("c-AC-3: joinBlocks carries just a single non-empty block when every other slot (including the notice slot) is empty", () => {
		expect(joinBlocks("", "", "", RECALL_AWARENESS_NOTICE)).toBe(RECALL_AWARENESS_NOTICE);
		expect(joinBlocks("", "", "", "")).toBe("");
	});
});
