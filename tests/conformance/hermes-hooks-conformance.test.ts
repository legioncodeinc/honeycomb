/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

import {
	assertHermesConfigConforms,
	HERMES_HOOK_EVENT_NAMES,
	isHermesHookEvent,
} from "../../references/hermes/hooks-schema.js";
import { createFakeFs, HermesConnector } from "../../src/connectors/index.js";

const HOME = "/home/dev";
const BUNDLE = "/repo/harnesses/hermes/bundle";
const MCP = "/repo/mcp/bundle/server.js";
const CONFIG = `${HOME}/.hermes/config.yaml`;

function fsWith(config?: string) {
	return createFakeFs({
		files: {
			[`${HOME}/.hermes`]: "",
			[`${BUNDLE}/session-start.js`]: "x",
			[`${BUNDLE}/capture.js`]: "x",
			[`${BUNDLE}/session-end.js`]: "x",
			[MCP]: "x",
			...(config === undefined ? {} : { [CONFIG]: config }),
		},
	});
}

function build(fs = fsWith()) {
	return new HermesConnector(fs, { home: HOME, bundleSource: BUNDLE, mcpServerPath: MCP });
}

describe("conformance: HermesConnector emits Hermes Agent 0.19 shell-hook YAML", () => {
	it("uses only native Hermes events and a schema-valid flat hook/MCP shape", async () => {
		const fs = fsWith();
		await build(fs).install();
		const config = parse(fs.files.get(CONFIG) as string);

		expect(() => assertHermesConfigConforms(config)).not.toThrow();
		const events = Object.keys((config as { hooks: Record<string, unknown> }).hooks);
		for (const event of events) expect(isHermesHookEvent(event)).toBe(true);
		expect(events).toContain("on_session_finalize");
		expect(events).not.toContain("on_session_end");
	});

	it("preserves a conformant foreign hook and remains conformant after uninstall", async () => {
		const seeded = `hooks:\n  pre_llm_call:\n    - command: /opt/acme/guard.py\n      timeout: 5\n`;
		const fs = fsWith(seeded);
		const c = build(fs);
		await c.install();
		expect(() => assertHermesConfigConforms(parse(fs.files.get(CONFIG) as string))).not.toThrow();

		await c.uninstall();
		const restored = parse(fs.files.get(CONFIG) as string) as { hooks: Record<string, unknown[]> };
		expect(() => assertHermesConfigConforms(restored)).not.toThrow();
		expect(restored.hooks.pre_llm_call).toEqual([{ command: "/opt/acme/guard.py", timeout: 5 }]);
	});

	it("the oracle rejects typoed events, malformed entries, and out-of-range timeouts", () => {
		expect(HERMES_HOOK_EVENT_NAMES.length).toBeGreaterThan(5);
		expect(() => assertHermesConfigConforms({ hooks: { on_session_finalized: [{ command: "node x" }] } })).toThrow();
		expect(() => assertHermesConfigConforms({ hooks: { pre_llm_call: [{ timeout: 5 }] } })).toThrow();
		expect(() =>
			assertHermesConfigConforms({ hooks: { pre_llm_call: [{ command: "node x", timeout: 999 }] } }),
		).toThrow();
	});
});
