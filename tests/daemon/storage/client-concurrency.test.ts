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
 * PRD-062 FIX 2 — the StorageClient in-flight concurrency cap (Semaphore(5)).
 *
 * The storage client bounds how many transport requests reach the backend at once
 * (transport.ts documents it; PRD-062 mandates it). These tests prove the cap:
 *   - sem-AC-1: with the default cap of 5, a 6th concurrent query WAITS at the
 *     semaphore until one in-flight query completes (only 5 reach the transport).
 *   - sem-AC-2: a FAILED query releases its permit, so the cap never wedges under
 *     a flapping backend (10 erroring queries all settle, not just the first 5).
 *   - sem-AC-3: the transient-retry loop still works under the cap (a flap then a
 *     success returns ok after exactly one retry).
 *
 * Verification posture: a gated fake transport whose responses resolve only when the
 * test releases them, so the in-flight count is asserted deterministically with no
 * wall-clock timing.
 */

import { describe, expect, it } from "vitest";

import { MAX_CONCURRENT_QUERIES } from "../../../src/daemon/storage/client.js";
import { createStorageClient } from "../../../src/daemon/storage/index.js";
import type { StorageRow } from "../../../src/daemon/storage/result.js";
import type { DeepLakeTransport } from "../../../src/daemon/storage/transport.js";
import { TransportError } from "../../../src/daemon/storage/transport.js";
import { fakeCredentialRecord, stubProvider } from "../../helpers/fake-deeplake.js";

const SCOPE = { org: "fake-org" } as const;

/** Build a client over the given transport with a no-op backoff clock (instant, deterministic). */
function clientWith(transport: DeepLakeTransport) {
	return createStorageClient({
		transport,
		provider: stubProvider(fakeCredentialRecord()),
		sleep: async () => {},
	});
}

/** Flush the microtask + timer queue so parked/awaiting queries advance deterministically. */
function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A transport whose every request BLOCKS until the test explicitly releases it. `started` records how
 * many requests reached the transport — i.e. how many permits are held — so a test can assert the cap.
 */
class GatedTransport implements DeepLakeTransport {
	readonly started: string[] = [];
	private readonly gates: Array<() => void> = [];

	query(req: { sql: string }): Promise<StorageRow[]> {
		this.started.push(req.sql);
		return new Promise<StorageRow[]>((resolve) => {
			this.gates.push(() => resolve([]));
		});
	}

	/** Complete the oldest in-flight request (frees one permit). No-op when none are pending. */
	releaseOne(): void {
		const gate = this.gates.shift();
		if (gate !== undefined) gate();
	}
}

describe("PRD-062 FIX 2: StorageClient in-flight concurrency cap", () => {
	it("sem-AC-1: at most 5 queries are in flight; a 6th waits until one completes", async () => {
		expect(MAX_CONCURRENT_QUERIES).toBe(5);
		const transport = new GatedTransport();
		const client = clientWith(transport);

		// Fire 6 concurrent READS (do not await — they park in flight).
		const running = Array.from({ length: 6 }, (_, i) => client.query(`SELECT ${i}`, SCOPE));
		await tick();
		// The cap holds the 6th at the semaphore: only 5 reached the transport.
		expect(transport.started.length).toBe(5);

		// Complete one in-flight query → its permit frees → the parked 6th proceeds to the transport.
		transport.releaseOne();
		await tick();
		expect(transport.started.length).toBe(6);

		// Drain the rest so the promises settle (no dangling handles).
		for (let i = 0; i < 6; i++) transport.releaseOne();
		const results = await Promise.all(running);
		expect(results.every((r) => r.kind === "ok")).toBe(true);
	});

	it("sem-AC-2: a failed query releases its permit so the cap never wedges", async () => {
		// Every request throws — if a permit leaked on the error path, queries past the 5th would hang
		// forever and this Promise.all would never resolve (the test would time out).
		const transport: DeepLakeTransport = {
			async query() {
				throw new TransportError("connection", "boom");
			},
		};
		const client = clientWith(transport);
		const results = await Promise.all(Array.from({ length: 10 }, (_, i) => client.query(`SELECT ${i}`, SCOPE)));
		expect(results).toHaveLength(10);
		expect(results.every((r) => r.kind === "connection_error")).toBe(true);
	});

	it("sem-AC-3: the transient-retry loop still succeeds under the concurrency cap", async () => {
		let calls = 0;
		const transport: DeepLakeTransport = {
			async query() {
				calls += 1;
				// First attempt flaps with a transient 503; the retry succeeds.
				if (calls === 1) throw new TransportError("query", "503 transient flap", 503);
				return [{ ok: 1 }];
			},
		};
		const client = clientWith(transport);
		const res = await client.query("SELECT 1", SCOPE);
		expect(res.kind).toBe("ok");
		expect(calls).toBe(2); // one retry, each attempt acquiring + releasing a permit.
	});
});
