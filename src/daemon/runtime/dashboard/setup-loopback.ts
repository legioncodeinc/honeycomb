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
 * Loopback gate for local-mode setup routes.
 *
 * Setup login, state, tenancy, and migration sit on the unprotected root group and
 * are mounted only in `local` mode. `HONEYCOMB_BIND` can still widen the listener
 * (a-AC-7) without changing that mode, which would expose those handlers to any
 * peer that can reach the socket. A real TCP peer that is not loopback is refused.
 * An in-process request (`app.request`, no socket) has no peer address and is
 * allowed, so the existing unit tests keep exercising the handlers.
 */

import type { Context } from "hono";

const LOOPBACK_PEERS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1", "localhost"]);

/** The TCP peer address when the Node server attached a socket, otherwise null. */
export function setupPeerAddress(c: Context): string | null {
	const env = c.env as { incoming?: { socket?: { remoteAddress?: string | null } } } | undefined;
	const address = env?.incoming?.socket?.remoteAddress;
	if (typeof address !== "string" || address.trim() === "") return null;
	return address.trim();
}

/** True when `address` is a loopback peer. */
export function isLoopbackPeer(address: string): boolean {
	return LOOPBACK_PEERS.has(address);
}

/**
 * Refuse a non-loopback TCP peer. Returns the 403 response to send, or null when
 * the request may proceed.
 */
export function refuseRemoteSetup(c: Context): Response | null {
	const address = setupPeerAddress(c);
	if (address === null || isLoopbackPeer(address)) return null;
	return c.json({ error: "forbidden", reason: "setup routes are loopback-only" }, 403);
}
