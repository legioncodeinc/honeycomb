/**
 * PRD-021c c-AC-4 + c-AC-5 + c-AC-6 — the shared hook runtime + binary driver.
 *
 * c-AC-4: session-start renders prior context via the real `ContextRenderer` AND
 *   drains the 020d notifications pipeline (the runtime CALLS the pipeline; it does
 *   not reimplement it).
 * c-AC-5: the claude-code binary drives the runtime — native stdin JSON → shim →
 *   core → DaemonHookClient POST.
 * c-AC-6: the codex binary reuses the SAME runtime + seams (only the shim differs),
 *   proving the runtime is shared, not re-derived.
 */

import { describe, expect, it, vi } from "vitest";

import { createClaudeCodeShim } from "../../../src/hooks/claude-code/shim.js";
import { createCodexShim } from "../../../src/hooks/codex/shim.js";
import { createCursorShim } from "../../../src/hooks/cursor/shim.js";
import { createHookRuntime } from "../../../src/hooks/runtime.js";
import { type BinaryIo, runHookBinary } from "../../../src/hooks/binary.js";
import {
	createFakePrimeRenderer,
	type DaemonHookClient,
	type DaemonHookRequest,
	type DaemonHookResponse,
	type HookSessionMeta,
	type PrimeRenderer,
} from "../../../src/hooks/shared/index.js";
import {
	createFakeClaimLock,
	createFakeNotificationsState,
	createNotificationsPipeline,
	type Notification,
	type NotificationsPipeline,
} from "../../../src/notifications/index.js";

/** A recording DaemonHookClient: records every send + returns a configurable status. */
function recordingClient(status = 201, body: unknown = { ok: true, id: "row" }) {
	const calls: DaemonHookRequest[] = [];
	const client: DaemonHookClient = {
		async send(req: DaemonHookRequest): Promise<DaemonHookResponse> {
			calls.push(req);
			return { status, body };
		},
	};
	return { client, calls };
}

/** A recording notifications pipeline (records each drain, returns a banner). */
function recordingPipeline(banner: Notification | null): NotificationsPipeline & { drains: number } {
	let drains = 0;
	return {
		get drains() {
			return drains;
		},
		async drain() {
			drains++;
			return { banner, suppressed: [] };
		},
	};
}

const META: HookSessionMeta = {
	sessionId: "sess-runtime",
	path: "conversations/sess-runtime",
	cwd: "/repo/honeycomb",
	agent: "claude-code",
};

describe("c-AC-4 session-start: renders prior context via the renderer + drains the notifications pipeline", () => {
	it("renders the daemon-returned context block into additionalContext", async () => {
		// The renderer asks the daemon /context; the recording client returns a block.
		const { client } = recordingClient(200, { additionalContext: "GOALS: ship 021c." });
		const pipeline = recordingPipeline(null);
		const runtime = createHookRuntime({ daemon: client, notifications: pipeline });

		const outcome = await runtime.runEvent(
			createClaudeCodeShim(),
			{ name: "SessionStart", payload: { source: "startup" } },
			META,
		);
		expect(outcome.result.additionalContext, "the rendered rules/goals block").toBe("GOALS: ship 021c.");
	});

	it("drains the 020d notifications pipeline exactly once on session-start (calls it, does not reimplement)", async () => {
		const { client } = recordingClient(200, { additionalContext: "" });
		const pipeline = recordingPipeline({
			id: "welcome",
			kind: "persistent",
			text: "Welcome to Honeycomb",
			priority: 10,
			dedupKey: "welcome",
		});
		const runtime = createHookRuntime({ daemon: client, notifications: pipeline });

		const outcome = await runtime.runEvent(
			createClaudeCodeShim(),
			{ name: "SessionStart", payload: { source: "startup" } },
			META,
		);
		expect(pipeline.drains, "the existing pipeline was drained once").toBe(1);
		expect(outcome.drain?.banner?.id, "the drained primary banner is surfaced").toBe("welcome");
	});

	it("uses the REAL 020d pipeline factory end-to-end (a transient banner wins its claim)", async () => {
		// Build the genuine pipeline with the real factory + in-memory fakes for state/lock.
		const backend = {
			async fetch(): Promise<readonly Notification[]> {
				return [{ id: "savings", kind: "transient", text: "saved 4h", priority: 5 }];
			},
		};
		const pipeline = createNotificationsPipeline({
			state: createFakeNotificationsState(),
			lock: createFakeClaimLock(),
			backend,
		});
		const { client } = recordingClient(200, { additionalContext: "" });
		const runtime = createHookRuntime({ daemon: client, notifications: pipeline });
		const outcome = await runtime.runEvent(
			createClaudeCodeShim(),
			{ name: "SessionStart", payload: { source: "startup" } },
			META,
		);
		expect(outcome.drain?.banner?.id).toBe("savings");
	});

	it("a notifications drain failure never breaks session-start (fail-soft)", async () => {
		const { client } = recordingClient(200, { additionalContext: "X" });
		const throwingPipeline: NotificationsPipeline = {
			async drain() {
				throw new Error("backend exploded");
			},
		};
		const runtime = createHookRuntime({ daemon: client, notifications: throwingPipeline });
		const outcome = await runtime.runEvent(
			createClaudeCodeShim(),
			{ name: "SessionStart", payload: {} },
			META,
		);
		expect(outcome.result.additionalContext).toBe("X");
		expect(outcome.drain?.banner).toBeNull();
	});
});

describe("PRD-046d session prime: the runtime injects the 046c digest at session-start for BOTH harnesses", () => {
	/** A recording prime renderer — records each render call so once-per-session is provable. */
	function recordingPrime(digest: string): PrimeRenderer & { renders: number } {
		let renders = 0;
		return {
			get renders() {
				return renders;
			},
			async render() {
				renders++;
				return digest;
			},
		};
	}

	it("d-AC-1: the Claude Code session-start injects the prime digest into additionalContext", async () => {
		const { client } = recordingClient(200, { additionalContext: "" }); // no rules/goals block
		const runtime = createHookRuntime({
			daemon: client,
			notifications: recordingPipeline(null),
			prime: createFakePrimeRenderer("## Memory\n- decided X"),
		});
		const outcome = await runtime.runEvent(
			createClaudeCodeShim(),
			{ name: "SessionStart", payload: { source: "startup" } },
			META,
		);
		expect(outcome.result.additionalContext).toBe("## Memory\n- decided X");
	});

	it("d-AC-2: the Cursor session-start injects the SAME prime digest (shared runtime, no per-harness fork)", async () => {
		const { client } = recordingClient(200, { additionalContext: "" });
		const runtime = createHookRuntime({
			daemon: client,
			notifications: recordingPipeline(null),
			prime: createFakePrimeRenderer("## Memory\n- decided X"),
		});
		// Cursor's native session-start event is `sessionStart` (mapped by the cursor shim).
		const outcome = await runtime.runEvent(
			createCursorShim(),
			{ name: "sessionStart", payload: { source: "startup" } },
			META,
		);
		expect(outcome.result.additionalContext).toBe("## Memory\n- decided X");
	});

	it("d-AC-1: the prime is APPENDED to the rules/goals block when both are present", async () => {
		const { client } = recordingClient(200, { additionalContext: "RULES: be concise." });
		const runtime = createHookRuntime({
			daemon: client,
			notifications: recordingPipeline(null),
			prime: createFakePrimeRenderer("## Memory\n- decided X"),
		});
		const outcome = await runtime.runEvent(
			createClaudeCodeShim(),
			{ name: "SessionStart", payload: { source: "startup" } },
			META,
		);
		expect(outcome.result.additionalContext).toBe("RULES: be concise.\n\n## Memory\n- decided X");
	});

	it("d-AC-3: the prime renders ONCE at session-start and NOT on a per-turn capture", async () => {
		const { client } = recordingClient(200, { additionalContext: "" });
		const prime = recordingPrime("## Memory\n- decided X");
		const runtime = createHookRuntime({ daemon: client, notifications: recordingPipeline(null), prime });

		// Session-start → one prime render.
		await runtime.runEvent(createClaudeCodeShim(), { name: "SessionStart", payload: { source: "startup" } }, META);
		expect(prime.renders, "primed once at session-start").toBe(1);

		// A subsequent per-turn capture event must NOT re-prime.
		await runtime.runEvent(
			createClaudeCodeShim(),
			{ name: "UserPromptSubmit", payload: { prompt: "next turn" } },
			META,
		);
		await runtime.runEvent(
			createClaudeCodeShim(),
			{ name: "PostToolUse", payload: { tool_name: "Read", tool_input: {} } },
			META,
		);
		expect(prime.renders, "no re-prime on per-turn events").toBe(1);
	});

	it("d-AC-4: a cold-repo / unreachable prime ('') injects nothing and never errors session-start", async () => {
		const { client } = recordingClient(200, { additionalContext: "RULES: be concise." });
		const runtime = createHookRuntime({
			daemon: client,
			notifications: recordingPipeline(null),
			prime: createFakePrimeRenderer(""), // daemon down / cold repo → empty digest
		});
		const outcome = await runtime.runEvent(
			createCursorShim(),
			{ name: "sessionStart", payload: { source: "startup" } },
			META,
		);
		// The session starts normally with just the context block; no prime, no error.
		expect(outcome.result.ok).toBe(true);
		expect(outcome.result.additionalContext).toBe("RULES: be concise.");
	});

	it("d-AC-4: a THROWING prime renderer is absorbed — session-start still completes", async () => {
		const { client } = recordingClient(200, { additionalContext: "RULES: be concise." });
		const throwingPrime: PrimeRenderer = {
			async render() {
				throw new Error("prime exploded");
			},
		};
		const runtime = createHookRuntime({
			daemon: client,
			notifications: recordingPipeline(null),
			prime: throwingPrime,
		});
		const outcome = await runtime.runEvent(
			createClaudeCodeShim(),
			{ name: "SessionStart", payload: { source: "startup" } },
			META,
		);
		expect(outcome.result.ok).toBe(true);
		expect(outcome.result.additionalContext).toBe("RULES: be concise.");
	});

	it("d-AC-1: the prime digest reaches stdout through the Claude Code binary driver (the real channel)", async () => {
		const out: string[] = [];
		const io: BinaryIo = {
			async readStdin() {
				return JSON.stringify({ hook_event_name: "SessionStart", session_id: "s", source: "startup" });
			},
			writeStdout(text) {
				out.push(text);
			},
		};
		const { client } = recordingClient(200, { additionalContext: "" });
		const runtime = createHookRuntime({
			daemon: client,
			notifications: recordingPipeline(null),
			prime: createFakePrimeRenderer("## Memory\n- decided X"),
		});
		await runHookBinary({ shim: createClaudeCodeShim(), runtime, io });
		expect(out).toHaveLength(1);
		const envelope = JSON.parse(out[0]) as { channel: string; additionalContext: string };
		expect(envelope.additionalContext).toBe("## Memory\n- decided X");
	});

	it("d-AC-2: the prime digest reaches stdout through the CURSOR binary driver (model-only additional_context)", async () => {
		// This is the EXACT path the cursor bundle's `runCursorHook` runs: native cursor
		// `sessionStart` JSON on stdin → cursor shim → runtime (prime fetch) → stdout envelope.
		const out: string[] = [];
		const io: BinaryIo = {
			async readStdin() {
				return JSON.stringify({ hook_event_name: "sessionStart", session_id: "s", source: "startup" });
			},
			writeStdout(text) {
				out.push(text);
			},
		};
		const { client } = recordingClient(200, { additionalContext: "" });
		const runtime = createHookRuntime({
			daemon: client,
			notifications: recordingPipeline(null),
			prime: createFakePrimeRenderer("## Memory\n- decided X"),
		});
		await runHookBinary({ shim: createCursorShim(), runtime, io });
		expect(out).toHaveLength(1);
		// Cursor lands context MODEL-ONLY (the shared `renderContext` channel envelope).
		const envelope = JSON.parse(out[0]) as { channel: string; additionalContext: string };
		expect(envelope.channel).toBe("model-only");
		expect(envelope.additionalContext).toBe("## Memory\n- decided X");
	});
});

describe("c-AC-5 claude-code binary: native stdin event drives the runtime (shim → core → client POST)", () => {
	function io(stdin: string): BinaryIo & { out: string[] } {
		const out: string[] = [];
		return {
			out,
			async readStdin() {
				return stdin;
			},
			writeStdout(text) {
				out.push(text);
			},
		};
	}

	it("parses the native Claude Code UserPromptSubmit envelope and POSTs the capture", async () => {
		const { client, calls } = recordingClient();
		const runtime = createHookRuntime({ daemon: client, notifications: recordingPipeline(null) });
		const stdin = JSON.stringify({
			hook_event_name: "UserPromptSubmit",
			session_id: "sess-bin",
			transcript_path: "conversations/sess-bin",
			cwd: "/repo/honeycomb",
			prompt: "what did we decide about 021c?",
		});
		const outcome = await runHookBinary({ shim: createClaudeCodeShim(), runtime, io: io(stdin) });

		expect(outcome.dropped).toBeUndefined();
		expect(calls, "the binary POSTed one capture through the runtime").toHaveLength(1);
		expect(calls[0].endpoint).toBe("capture");
		expect(calls[0].runtimePath).toBe("legacy");
		// The session metadata was derived from the native envelope.
		expect(calls[0].meta.sessionId).toBe("sess-bin");
		expect(calls[0].meta.path).toBe("conversations/sess-bin");
		// The captured prompt rode the body verbatim.
		const body = calls[0].body as { event: { kind: string; text: string } };
		expect(body.event).toEqual({ kind: "user_message", text: "what did we decide about 021c?" });
	});

	it("session-start emits the rendered context block on stdout (model-only additionalContext)", async () => {
		const { client } = recordingClient(200, { additionalContext: "RULES: be concise." });
		const runtime = createHookRuntime({ daemon: client, notifications: recordingPipeline(null) });
		const surface = io(JSON.stringify({ hook_event_name: "SessionStart", session_id: "s", source: "startup" }));
		await runHookBinary({ shim: createClaudeCodeShim(), runtime, io: surface });
		expect(surface.out).toHaveLength(1);
		const envelope = JSON.parse(surface.out[0]) as { channel: string; additionalContext: string };
		expect(envelope.channel).toBe("model-only");
		expect(envelope.additionalContext).toBe("RULES: be concise.");
	});

	it("malformed stdin exits cleanly with an empty response (fail-soft, never a throw)", async () => {
		const { client, calls } = recordingClient();
		const runtime = createHookRuntime({ daemon: client, notifications: recordingPipeline(null) });
		const surface = io("{ not json");
		const outcome = await runHookBinary({ shim: createClaudeCodeShim(), runtime, io: surface });
		expect(outcome.dropped).toBe(true);
		expect(calls, "no daemon call on a malformed event").toHaveLength(0);
		expect(surface.out).toEqual(["{}"]);
	});

	it("a non-lifecycle event the shim drops makes no daemon call", async () => {
		const { client, calls } = recordingClient();
		const runtime = createHookRuntime({ daemon: client, notifications: recordingPipeline(null) });
		const surface = io(JSON.stringify({ hook_event_name: "Notification", session_id: "s" }));
		const outcome = await runHookBinary({ shim: createClaudeCodeShim(), runtime, io: surface });
		expect(outcome.dropped).toBe(true);
		expect(calls).toHaveLength(0);
	});
});

describe("c-AC-6 second harness (codex) reuses the SAME runtime + seams (not re-derived)", () => {
	function io(stdin: string): BinaryIo & { out: string[] } {
		const out: string[] = [];
		return { out, async readStdin() { return stdin; }, writeStdout(t) { out.push(t); } };
	}

	it("the codex binary drives the SAME runtime instance — proving the runtime is shared", async () => {
		const { client, calls } = recordingClient();
		// ONE runtime, used by BOTH harnesses below — the c-AC-6 reuse proof.
		const runtime = createHookRuntime({ daemon: client, notifications: recordingPipeline(null) });

		// Drive a claude-code event AND a codex event through the SAME runtime + seams.
		await runHookBinary({
			shim: createClaudeCodeShim(),
			runtime,
			io: io(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "cc", prompt: "from claude" })),
		});
		await runHookBinary({
			shim: createCodexShim(),
			runtime,
			io: io(JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: "cx", prompt: "from codex" })),
		});

		expect(calls, "both harnesses POSTed through the one shared runtime").toHaveLength(2);
		// Both produced the SAME canonical normalized body shape (c-AC-1 equivalence).
		expect((calls[0].body as { event: unknown }).event).toEqual({ kind: "user_message", text: "from claude" });
		expect((calls[1].body as { event: unknown }).event).toEqual({ kind: "user_message", text: "from codex" });
		// Both used the SAME daemon-client seam (same recording client instance).
		expect(calls[0].endpoint).toBe(calls[1].endpoint);
	});

	it("createHookRuntime builds the three production seams once (deps reused across events)", async () => {
		const { client } = recordingClient();
		const runtime = createHookRuntime({ daemon: client, notifications: recordingPipeline(null) });
		// The runtime exposes ONE deps bundle (daemon + credentials + context) reused per event.
		expect(runtime.deps.daemon).toBe(client);
		expect(runtime.deps.credentials).toBeDefined();
		expect(runtime.deps.context).toBeDefined();
	});

	it("the default runtime drains a real daemon-backed notifications source fail-soft when the daemon is down", async () => {
		// No injected pipeline → the runtime builds the default 020d pipeline with a
		// daemon-backed backend source. With fetch failing, the drain yields no banner,
		// never throwing (the bounded fail-soft drain).
		const failingFetch = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const { client } = recordingClient(200, { additionalContext: "" });
		const runtime = createHookRuntime({ daemon: client, fetch: failingFetch });
		const outcome = await runtime.runEvent(
			createCodexShim(),
			{ name: "SessionStart", payload: { source: "startup" } },
			META,
		);
		expect(outcome.drain?.banner).toBeNull();
	});
});

describe("PRD-045g g-AC-2: the runtime injects the REAL auto-pull seam on session-start", () => {
	/** A recording `SessionStartSeams` whose autoPullSkills records every call. */
	function recordingSeams(): import("../../../src/hooks/shared/index.js").SessionStartSeams & { pulls: number } {
		let pulls = 0;
		return {
			get pulls() {
				return pulls;
			},
			async healDriftedOrgToken() {},
			async autoUpdate() {},
			async ensureTables() {},
			async writePlaceholderSummary() {},
			async spawnGraphPull() {},
			async autoPullSkills() {
				pulls++;
			},
		};
	}

	it("calls autoPullSkills ONCE on session-start (the seam is wired into SessionStartDeps)", async () => {
		const { client } = recordingClient(200, { additionalContext: "" });
		const seams = recordingSeams();
		const runtime = createHookRuntime({ daemon: client, notifications: recordingPipeline(null), seams });
		await runtime.runEvent(createClaudeCodeShim(), { name: "SessionStart", payload: { source: "startup" } }, META);
		expect(seams.pulls, "auto-pull ran at session start").toBe(1);
	});

	it("does NOT auto-pull on a per-turn capture event (session-start only)", async () => {
		const { client } = recordingClient();
		const seams = recordingSeams();
		const runtime = createHookRuntime({ daemon: client, notifications: recordingPipeline(null), seams });
		await runtime.runEvent(createClaudeCodeShim(), { name: "UserPromptSubmit", payload: { prompt: "x" } }, META);
		expect(seams.pulls, "no auto-pull on capture").toBe(0);
	});

	it("a THROWING autoPullSkills is absorbed — session-start still returns its context (fail-soft)", async () => {
		const { client } = recordingClient(200, { additionalContext: "RULES: be concise." });
		const throwingSeams: import("../../../src/hooks/shared/index.js").SessionStartSeams = {
			async healDriftedOrgToken() {},
			async autoUpdate() {},
			async ensureTables() {},
			async writePlaceholderSummary() {},
			async spawnGraphPull() {},
			async autoPullSkills() {
				throw new Error("pull exploded");
			},
		};
		const runtime = createHookRuntime({ daemon: client, notifications: recordingPipeline(null), seams: throwingSeams });
		const outcome = await runtime.runEvent(
			createClaudeCodeShim(),
			{ name: "SessionStart", payload: { source: "startup" } },
			META,
		);
		expect(outcome.result.ok).toBe(true);
		expect(outcome.result.additionalContext).toBe("RULES: be concise.");
	});

	it("the DEFAULT runtime (no injected seams) builds a real seam that fail-softs when the daemon is down", async () => {
		// No injected seams → the runtime builds the REAL `createSessionStartSeams`, whose
		// autoPullSkills POSTs the loopback pull. With the daemon down the fetch is refused and
		// swallowed — session-start still completes (the production fail-soft path, g-AC-2).
		const failingFetch = (async () => {
			throw new Error("ECONNREFUSED");
		}) as unknown as typeof fetch;
		const { client } = recordingClient(200, { additionalContext: "RULES: be concise." });
		const runtime = createHookRuntime({ daemon: client, notifications: recordingPipeline(null), fetch: failingFetch });
		const outcome = await runtime.runEvent(
			createClaudeCodeShim(),
			{ name: "SessionStart", payload: { source: "startup" } },
			META,
		);
		expect(outcome.result.ok).toBe(true);
		expect(outcome.result.additionalContext).toBe("RULES: be concise.");
	});
});

// Silence any unhandled-rejection noise from fire-and-forget paths in this suite.
vi.spyOn(console, "error").mockImplementation(() => undefined);
