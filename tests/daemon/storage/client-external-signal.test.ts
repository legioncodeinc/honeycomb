/**
 * PRD-077b (L-B2 / L-B8) — the storage client threads a caller's EXTERNAL deadline signal into the
 * statement's abort, so a recall lane's `AbortSignal.timeout(...)` aborts the in-flight query
 * daemon-side (freeing its Semaphore permit) INDEPENDENT of the per-statement timeout.
 *
 * Verified against the FAKE transport (no live DeepLake): a slow response whose `delayMs` far
 * exceeds the client's per-statement timeout is nonetheless aborted the moment the EXTERNAL signal
 * fires, classified as a timeout result — proving the additive `opts.signal` reaches `fetch`.
 *
 * No `.skip` / `.only`; `vitest run` is CI.
 */

import { describe, expect, it } from "vitest";

import { createStorageClient } from "../../../src/daemon/storage/index.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../helpers/fake-deeplake.js";
import type { QueryScope } from "../../../src/daemon/storage/client.js";

const SCOPE: QueryScope = { org: "fake-org", workspace: "fake-ws" };

describe("L-B2/L-B8: an external deadline signal aborts the in-flight statement daemon-side", () => {
	it("a slow query is aborted (timeout result) the instant the caller's signal fires, not after delayMs", async () => {
		const fake = new FakeDeepLakeTransport();
		// A response that would take 10s — but the external deadline fires first.
		fake.enqueueSlow([{ id: "x" }], 10_000);
		const client = createStorageClient({
			transport: fake,
			// A HIGH per-statement timeout so ONLY the external signal can abort this call.
			provider: stubProvider(fakeCredentialRecord({ queryTimeoutMs: 60_000 })),
			sleep: async () => {},
		});

		// The caller's lane deadline — fires well before the fake's 10s delay.
		const signal = AbortSignal.timeout(30);
		const startedAt = Date.now();
		const result = await client.query("SELECT 1", SCOPE, { signal });
		const elapsedMs = Date.now() - startedAt;

		// Aborted daemon-side and classified as a timeout — NOT a 10s hang.
		expect(result.kind).toBe("timeout");
		expect(elapsedMs).toBeLessThan(1000);
		// The statement reached the transport (the abort cut a real in-flight request).
		expect(fake.requests.length).toBeGreaterThanOrEqual(1);
	});
});
