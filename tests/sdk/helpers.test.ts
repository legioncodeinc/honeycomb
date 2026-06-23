/**
 * PRD-019e SDK framework helpers — AC-named Vitest (e-AC-5).
 *
 * Proves the Vercel AI SDK helper and the OpenAI tool helper REUSE the core client's
 * token + actor model (e-AC-5): each helper's execute/dispatch calls the SAME
 * fake-fetch core client, so the configured actor headers ride on the daemon call.
 */

import { describe, expect, it } from "vitest";
import { createHoneycombClient } from "../../src/sdk/client.js";
import type { Fetch } from "../../src/sdk/contracts.js";
import {
	createOpenAiTools,
	dispatchOpenAiToolCall,
	OPENAI_TOOL_RECALL,
	OPENAI_TOOL_REMEMBER,
} from "../../src/sdk/openai.js";
import { createVercelAiTools } from "../../src/sdk/vercel.js";

interface RecordedFetch {
	readonly url: string;
	readonly init?: RequestInit;
}

function recordingFetch(body: unknown): { fetch: Fetch; calls: RecordedFetch[] } {
	const calls: RecordedFetch[] = [];
	const fetch: Fetch = async (url, init) => {
		calls.push({ url, init });
		return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
	};
	return { fetch, calls };
}

function header(init: RequestInit | undefined, name: string): string | undefined {
	return (init?.headers as Record<string, string> | undefined)?.[name];
}

const ACTOR = { actor: "alex", actorType: "user" };
const DAEMON = "http://127.0.0.1:3850";

describe("e-AC-5: Vercel AI SDK helper reuses the core client", () => {
	it("e-AC-5 createVercelAiTools.recall.execute calls the core client carrying actor + token", async () => {
		const { fetch, calls } = recordingFetch({ results: [{ path: "p", text: "t" }] });
		const client = createHoneycombClient({ daemonUrl: DAEMON, token: "tok-9", ...ACTOR, fetch });

		const tools = createVercelAiTools(client);
		const out = await tools.honeycomb_recall.execute({ query: "deploy", limit: 3 });

		expect(out).toEqual([{ path: "p", text: "t" }]);
		expect(calls).toHaveLength(1);
		// PRD-022d: the core client now reaches the WIRED recall endpoint.
		expect(calls[0].url).toBe(`${DAEMON}/api/memories/recall`);
		expect(header(calls[0].init, "x-honeycomb-actor")).toBe("alex");
		expect(header(calls[0].init, "x-honeycomb-actor-type")).toBe("user");
		expect(header(calls[0].init, "authorization")).toBe("Bearer tok-9");
	});

	it("e-AC-5 createVercelAiTools.remember.execute stores via the core client", async () => {
		const { fetch, calls } = recordingFetch({ ok: true });
		const client = createHoneycombClient({ daemonUrl: DAEMON, token: "tok-9", ...ACTOR, fetch });

		const tools = createVercelAiTools(client);
		await tools.honeycomb_remember.execute({ text: "remember this", path: "notes/x" });

		// PRD-022d: the WIRED store body is `{ content, normalizedContent }`.
		expect(calls[0].url).toBe(`${DAEMON}/api/memories`);
		expect(JSON.parse(calls[0].init?.body as string)).toEqual({ content: "remember this", normalizedContent: "notes/x" });
		expect(header(calls[0].init, "x-honeycomb-actor")).toBe("alex");
	});

	it("e-AC-5 the Vercel tool set does NOT expose a secrets tool (value-safety)", () => {
		const { fetch } = recordingFetch({});
		const client = createHoneycombClient({ daemonUrl: DAEMON, ...ACTOR, fetch });
		const tools = createVercelAiTools(client);
		expect(Object.keys(tools)).toEqual(["honeycomb_recall", "honeycomb_remember"]);
	});
});

describe("e-AC-5: OpenAI tool helper reuses the core client", () => {
	it("e-AC-5 createOpenAiTools emits function-tool defs for recall + remember", () => {
		const tools = createOpenAiTools();
		expect(tools.map((t) => t.function.name)).toEqual([OPENAI_TOOL_RECALL, OPENAI_TOOL_REMEMBER]);
		for (const t of tools) expect(t.type).toBe("function");
	});

	it("e-AC-5 dispatchOpenAiToolCall(recall) routes through the core client with actor + token", async () => {
		const { fetch, calls } = recordingFetch({ results: [{ path: "p", text: "t" }] });
		const client = createHoneycombClient({ daemonUrl: DAEMON, token: "tok-7", ...ACTOR, fetch });

		const out = await dispatchOpenAiToolCall(client, OPENAI_TOOL_RECALL, { query: "deploy", limit: 2 });

		expect(out).toEqual([{ path: "p", text: "t" }]);
		// PRD-022d: the OpenAI helper reuses the core client, which now hits the wired endpoint.
		expect(calls[0].url).toBe(`${DAEMON}/api/memories/recall`);
		expect(header(calls[0].init, "x-honeycomb-actor")).toBe("alex");
		expect(header(calls[0].init, "authorization")).toBe("Bearer tok-7");
	});

	it("e-AC-5 dispatchOpenAiToolCall(remember) stores via the core client", async () => {
		const { fetch, calls } = recordingFetch({ ok: true });
		const client = createHoneycombClient({ daemonUrl: DAEMON, token: "tok-7", ...ACTOR, fetch });

		const out = await dispatchOpenAiToolCall(client, OPENAI_TOOL_REMEMBER, { text: "x" });

		expect(out).toEqual({ ok: true });
		expect(calls[0].url).toBe(`${DAEMON}/api/memories`);
		expect(header(calls[0].init, "x-honeycomb-actor-type")).toBe("user");
	});

	it("e-AC-5 dispatchOpenAiToolCall throws on an unknown tool name", async () => {
		const { fetch } = recordingFetch({});
		const client = createHoneycombClient({ daemonUrl: DAEMON, ...ACTOR, fetch });
		await expect(dispatchOpenAiToolCall(client, "honeycomb_unknown", {})).rejects.toThrow(/unknown tool/);
	});
});
