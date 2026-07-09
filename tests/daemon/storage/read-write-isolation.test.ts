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
 * PRD-077 (read/write split) — the writes-cannot-starve-reads regression guard.
 *
 * The daemon builds a DEDICATED write `StorageClient` (its own transport + its own
 * `Semaphore`, sized by `writeMaxConcurrency`, default 3) for capture appends ONLY, so a
 * capture-write burst under a slow DeepLake can never consume the READ client's Semaphore
 * slots and queue recall arms tens of seconds behind them (the live-observed `armsMs: 73273`).
 *
 * This is the isolation proof: SATURATE the write client's Semaphore(3) with hanging appends,
 * then fire a concurrent READ on a SEPARATE read client (Semaphore(5)) and assert it still
 * reaches its transport — i.e. the two clients have INDEPENDENT in-flight caps and writes
 * cannot starve reads. Driven by a gated transport whose responses resolve only when the test
 * releases them, so the isolation is asserted deterministically with no wall-clock timing.
 *
 * No `.skip` / `.only`; `vitest run` is CI.
 */

import { describe, expect, it } from "vitest";

import { createStorageClient } from "../../../src/daemon/storage/index.js";
import type { StorageRow } from "../../../src/daemon/storage/result.js";
import type { DeepLakeTransport } from "../../../src/daemon/storage/transport.js";
import { fakeCredentialRecord, stubProvider } from "../../helpers/fake-deeplake.js";

const SCOPE = { org: "fake-org" } as const;

/** Flush the microtask + timer queue so parked/awaiting queries advance deterministically. */
function tick(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

/**
 * A transport whose every request BLOCKS until the test releases it. `started` records how many
 * requests reached the transport (permits held), so a test can assert the per-client cap.
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

/** Build a client over a gated transport with the given cap and a no-op backoff clock. */
function clientWith(transport: DeepLakeTransport, maxConcurrency: number) {
	return createStorageClient({
		transport,
		provider: stubProvider(fakeCredentialRecord()),
		sleep: async () => {},
		maxConcurrency,
	});
}

describe("PRD-077 read/write split: a saturated write client cannot starve reads", () => {
	it("reads acquire a slot on the read client even while the write client's Semaphore(3) is full", async () => {
		const readTransport = new GatedTransport();
		const writeTransport = new GatedTransport();
		const readClient = clientWith(readTransport, 5); // the read client (MAX_CONCURRENT_QUERIES).
		const writeClient = clientWith(writeTransport, 3); // the dedicated write client (writeMaxConcurrency).

		// SATURATE the write client: 4 concurrent capture appends. Its Semaphore(3) admits 3 to the
		// write transport; the 4th parks at the write semaphore (the write client is now fully backed up).
		const writes = Array.from({ length: 4 }, (_, i) => writeClient.query(`INSERT ${i}`, SCOPE));
		await tick();
		expect(writeTransport.started.length).toBe(3); // write cap saturated; the 4th is queued.

		// A concurrent READ (a recall arm) on the SEPARATE read client STILL reaches its transport —
		// the read Semaphore is independent of the (saturated) write Semaphore. This is the whole fix:
		// under the prior single shared client, this read would have queued behind the 3 hanging writes.
		const read = readClient.query("SELECT 1", SCOPE);
		await tick();
		expect(readTransport.started.length).toBe(1);

		// Drain everything so no promise dangles. Release + tick so the parked 4th write starts and
		// then gets released too (a plain release loop would miss the still-parked 4th).
		readTransport.releaseOne();
		for (let i = 0; i < 4; i++) {
			writeTransport.releaseOne();
			await tick();
		}
		const results = await Promise.all([read, ...writes]);
		expect(results.every((r) => r.kind === "ok")).toBe(true);
		// The 4th write only reached the transport after a slot freed (proving the write cap held it).
		expect(writeTransport.started.length).toBe(4);
	});
});
