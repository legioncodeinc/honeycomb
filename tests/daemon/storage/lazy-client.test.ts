/**
 * PRD-050b — the DEFERRED storage client (`createLazyStorageClient`).
 *
 * This is the seam b-AC-1 audits + fixes: the EAGER `createStorageClient` throws a
 * `StorageConfigError` when no credential resolves (a fresh install), which would take the daemon
 * down at boot before it could serve the pre-auth dashboard. `createLazyStorageClient` defers the
 * build so:
 *
 *   b-AC-1  construction NEVER throws with no credential; a query returns a typed `connection_error`
 *           (the closed-union "no server response" kind every consumer already branches on) instead.
 *   b-AC-3  the build is RE-ATTEMPTED per query until it succeeds, so the moment a credential lands
 *           the NEXT query connects — the live pre-auth → authenticated transition, no restart.
 */

import { describe, expect, it } from "vitest";

import type { QueryScope } from "../../../src/daemon/storage/client.js";
import { createLazyStorageClient } from "../../../src/daemon/storage/index.js";
import { QueryMeter } from "../../../src/daemon/storage/query-meter.js";
import { FakeDeepLakeTransport, fakeCredentialRecord } from "../../helpers/fake-deeplake.js";

const SCOPE: QueryScope = { org: "fake-org", workspace: "fake-ws" };

/** A mutable provider whose `read()` starts EMPTY (no creds) and can be flipped to a valid record. */
function mutableProvider(): { read(): Record<string, unknown>; setRecord(r: Record<string, unknown>): void } {
	let record: Record<string, unknown> = {}; // no token/org/endpoint → StorageConfigSchema rejects.
	return {
		read: () => record,
		setRecord(r: Record<string, unknown>): void {
			record = r;
		},
	};
}

describe("b-AC-1 the deferred client never throws at construction with no credential", () => {
	it("constructs cleanly with an empty (no-creds) provider — no StorageConfigError thrown", () => {
		const provider = mutableProvider();
		// The eager createStorageClient(provider) would THROW here; the lazy variant must not.
		expect(() => createLazyStorageClient({ provider })).not.toThrow();
	});

	it("a query in the pre-auth phase returns a typed connection_error, never a throw", async () => {
		const provider = mutableProvider();
		const client = createLazyStorageClient({ provider });
		const res = await client.query("SELECT 1", SCOPE);
		expect(res.kind).toBe("connection_error");
		// No secret/stack — a redacted pre-auth message.
		if (res.kind === "connection_error") expect(res.message).toContain("pre-auth");
	});

	it("endpoint reports a stable placeholder before credentials resolve (no eager read)", () => {
		const provider = mutableProvider();
		const client = createLazyStorageClient({ provider });
		expect(client.endpoint).toBe("pending-credentials");
	});
});

describe("b-AC-3 the deferred client connects on the NEXT query once a credential lands (no restart)", () => {
	it("returns connection_error pre-auth, then a real result after the credential is written", async () => {
		const provider = mutableProvider();
		const transport = new FakeDeepLakeTransport();
		const client = createLazyStorageClient({ provider, transport });

		// Pre-auth: no creds → connection_error (the dashboard surface degrades to "connect me").
		const pre = await client.query("SELECT 1", SCOPE);
		expect(pre.kind).toBe("connection_error");

		// The login flow writes the credential — flip the provider to a valid record (the same effect
		// `loadCredentials` re-reading the freshly-written `~/.deeplake/credentials.json` has).
		provider.setRecord(fakeCredentialRecord());
		// The transport answers the next real query (the build now succeeds and is cached).
		transport.enqueueRows([{ ok: 1 }]);

		const post = await client.query("SELECT 1", SCOPE);
		expect(post.kind).toBe("ok");
		if (post.kind === "ok") expect(post.rows).toEqual([{ ok: 1 }]);

		// The endpoint now reflects the resolved credential (the built client is cached).
		expect(client.endpoint).toBe("https://fake.deeplake.test");
	});

	it("does NOT cache the pre-auth failure — each query re-attempts the build until it succeeds", async () => {
		const provider = mutableProvider();
		const transport = new FakeDeepLakeTransport();
		const client = createLazyStorageClient({ provider, transport });

		// Three pre-auth queries all degrade (the failed build is never cached).
		expect((await client.query("SELECT 1", SCOPE)).kind).toBe("connection_error");
		expect((await client.query("SELECT 1", SCOPE)).kind).toBe("connection_error");

		// Creds land — the very next query builds + connects.
		provider.setRecord(fakeCredentialRecord());
		transport.enqueueRows([{ n: 42 }]);
		const res = await client.query("SELECT 1", SCOPE);
		expect(res.kind).toBe("ok");
	});

	it("forwards the same query meter before and after the deferred client connects", async () => {
		const provider = mutableProvider();
		const transport = new FakeDeepLakeTransport();
		const meter = new QueryMeter();
		const client = createLazyStorageClient({ provider, transport, meter });

		expect(client.meterSnapshot()).toEqual({ perSource: [], totalReads: 0, totalWrites: 0 });
		expect(client.meterLogLine()).toBe("[query-meter] total_reads=0 total_writes=0");

		provider.setRecord(fakeCredentialRecord());
		transport.enqueueRows([{ ok: 1 }]);
		await client.query("SELECT 1", SCOPE, { source: "recall-arm" });

		expect(client.meterSnapshot().perSource).toEqual([{ source: "recall-arm", reads: 1, writes: 0 }]);
	});
});
