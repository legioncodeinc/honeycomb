/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

import type { Context } from "hono";
import { describe, expect, it } from "vitest";

import {
	isLoopbackPeer,
	refuseRemoteSetup,
	setupPeerAddress,
} from "../../../../src/daemon/runtime/dashboard/setup-loopback.js";

function contextWithPeer(address: string | undefined): Context {
	return {
		env: { incoming: { socket: address === undefined ? {} : { remoteAddress: address } } },
		json: (body: unknown, status: number) => Response.json(body, { status }),
	} as unknown as Context;
}

describe("setup routes refuse a non-loopback peer", () => {
	it("treats 127.0.0.1, ::1, and the IPv4-mapped loopback as loopback", () => {
		expect(isLoopbackPeer("127.0.0.1")).toBe(true);
		expect(isLoopbackPeer("::1")).toBe(true);
		expect(isLoopbackPeer("::ffff:127.0.0.1")).toBe(true);
		expect(isLoopbackPeer("10.1.2.3")).toBe(false);
	});

	it("allows an in-process request that has no TCP peer", () => {
		expect(setupPeerAddress(contextWithPeer(undefined))).toBeNull();
		expect(refuseRemoteSetup(contextWithPeer(undefined))).toBeNull();
	});

	it("allows a loopback peer and refuses a remote peer", async () => {
		expect(refuseRemoteSetup(contextWithPeer("127.0.0.1"))).toBeNull();
		const denied = refuseRemoteSetup(contextWithPeer("10.1.2.3"));
		expect(denied).not.toBeNull();
		expect(denied?.status).toBe(403);
		await expect(denied?.json()).resolves.toEqual({
			error: "forbidden",
			reason: "setup routes are loopback-only",
		});
	});
});
