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
 * PRD-073b — the hook shim surfaces the daemon's GATED reason (AC-073b.2.1).
 *
 * The daemon returns `{ ok: true, gated: true, reason: "no_bound_project" | "tenancy_unconfirmed" }`
 * (status 200) when a capture is gated by the dormancy ladder. `runCapture` threads that reason onto
 * its result so no shim path reports a plain success for a gated event. An OLD-shape gated ack (no
 * `reason`) — or a normal write — degrades to a plain `ok`, so old daemons + new hooks compose.
 */

import { describe, expect, it } from "vitest";

import {
	createFakeContextRenderer,
	createFakeCredentialReader,
	createFakeDaemonHookClient,
	type HookCoreDeps,
	type HookInput,
} from "../../../src/hooks/shared/contracts.js";
import { runCapture } from "../../../src/hooks/shared/capture.js";

function deps(body: unknown): HookCoreDeps {
	return {
		daemon: createFakeDaemonHookClient({ status: 200, body }),
		credentials: createFakeCredentialReader({ token: "t", org: "acme" }),
		context: createFakeContextRenderer(),
	};
}

const input: HookInput = {
	event: "user_message",
	meta: { sessionId: "sess-1", path: "conv-1", cwd: "/repo", org: "acme", workspace: "ws" } as HookInput["meta"],
	data: { kind: "user_message", text: "hi" },
	runtimePath: "plugin",
};

describe("073b-AC-2.1: a gated capture threads the reason (never a plain success)", () => {
	it("surfaces reason=no_bound_project from the gated ack", async () => {
		const result = await runCapture(input, deps({ ok: true, gated: true, reason: "no_bound_project" }), {});
		expect(result.ok).toBe(true);
		expect(result.reason).toBe("no_bound_project");
	});

	it("surfaces reason=tenancy_unconfirmed from the gated ack", async () => {
		const result = await runCapture(input, deps({ ok: true, gated: true, reason: "tenancy_unconfirmed" }), {});
		expect(result.ok).toBe(true);
		expect(result.reason).toBe("tenancy_unconfirmed");
	});

	it("a NORMAL write ack reports a plain ok (no fabricated reason)", async () => {
		const result = await runCapture(input, deps({ ok: true, id: "sess-x", enqueued: [] }), {});
		expect(result.ok).toBe(true);
		expect(result.reason).toBeUndefined();
	});

	it("an OLD-shape gated ack (gated but NO reason) degrades to a plain ok", async () => {
		const result = await runCapture(input, deps({ ok: true, gated: true }), {});
		expect(result.ok).toBe(true);
		expect(result.reason).toBeUndefined();
	});
});
