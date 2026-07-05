/**
 * Live-reload of daemon tenancy + storage config WITHOUT a restart.
 *
 * The daemon historically snapshotted its storage-client config ONCE at boot and cached the built
 * client forever, so a `honeycomb login` (new org/workspace/token) or a re-point written AFTER boot
 * was invisible until the operator restarted. These tests pin the fix on TWO seams:
 *
 *   1. {@link createMtimeGatedResolver} — the mtime-gated + debounced re-read primitive (no watcher).
 *   2. {@link createLazyStorageClient} — rebuilds the cached client when the resolved config's
 *      identity fields change (mtime moved), and NOT otherwise (debounced, never thrashed).
 *
 * All timing is driven by an injected clock + an injected mtime reader — NO real sleeps, NO disk.
 */

import { describe, expect, it } from "vitest";

import type { QueryScope } from "../../../src/daemon/storage/client.js";
import { createLazyStorageClient } from "../../../src/daemon/storage/index.js";
import { createMtimeGatedResolver, type MtimeReader } from "../../../src/daemon/storage/live-reload.js";
import { FakeDeepLakeTransport, fakeCredentialRecord } from "../../helpers/fake-deeplake.js";

/** A scope that omits the workspace so the client fills it from `config.workspace` (visible on the wire). */
const SCOPE_NO_WS: QueryScope = { org: "req-org" };

/** The workspace the last statement carried to the wire (the client defaults it from config). */
function lastWorkspace(transport: FakeDeepLakeTransport): string | undefined {
	return transport.requests.at(-1)?.workspace;
}

/** A mutable clock the tests advance deterministically. */
function fakeClock(): { now(): number; advance(ms: number): void } {
	let t = 1_000;
	return {
		now: () => t,
		advance(ms: number): void {
			t += ms;
		},
	};
}

/** A mutable mtime source: `set(n)` flips the reported mtime (or `null` for "absent"). */
function fakeMtime(initial: number | null = 100): { reader: MtimeReader; set(v: number | null): void } {
	let value = initial;
	return {
		reader: () => value,
		set(v: number | null): void {
			value = v;
		},
	};
}

/** A mutable provider whose `read()` returns the current record (the same effect a re-login on disk has). */
function mutableProvider(initial: Record<string, unknown>): {
	read(): Record<string, unknown>;
	setRecord(r: Record<string, unknown>): void;
} {
	let record = initial;
	return {
		read: () => record,
		setRecord(r: Record<string, unknown>): void {
			record = r;
		},
	};
}

describe("createMtimeGatedResolver — mtime-gated + debounced re-derivation", () => {
	it("derives once on first access, then reuses within the debounce window (no re-derive)", () => {
		const clock = fakeClock();
		const mtime = fakeMtime(1);
		let derives = 0;
		const resolve = createMtimeGatedResolver(
			mtime.reader,
			() => {
				derives += 1;
				return derives;
			},
			{ ttlMs: 100, now: clock.now },
		);

		expect(resolve()).toBe(1); // first access derives
		expect(resolve()).toBe(1); // inside window, same tick → cached
		clock.advance(50);
		mtime.set(2); // mtime changed but we are still inside the debounce window
		expect(resolve()).toBe(1); // debounced → no stat, still cached
		expect(derives).toBe(1);
	});

	it("re-derives after the window ONLY when the mtime actually changed", () => {
		const clock = fakeClock();
		const mtime = fakeMtime(1);
		let derives = 0;
		const resolve = createMtimeGatedResolver(
			mtime.reader,
			() => {
				derives += 1;
				return derives;
			},
			{ ttlMs: 100, now: clock.now },
		);

		expect(resolve()).toBe(1);
		// Window elapsed, but the mtime is unchanged → re-stat, no re-derive.
		clock.advance(150);
		expect(resolve()).toBe(1);
		expect(derives).toBe(1);
		// Window elapsed AND the mtime moved → re-derive.
		clock.advance(150);
		mtime.set(2);
		expect(resolve()).toBe(2);
		expect(derives).toBe(2);
	});

	it("fail-soft: an absent (null) mtime after a successful derive keeps the last value", () => {
		const clock = fakeClock();
		const mtime = fakeMtime(1);
		let derives = 0;
		const resolve = createMtimeGatedResolver(
			mtime.reader,
			() => {
				derives += 1;
				return derives;
			},
			{ ttlMs: 100, now: clock.now },
		);

		expect(resolve()).toBe(1);
		clock.advance(150);
		mtime.set(null); // the file was deleted / unreadable
		expect(resolve()).toBe(1); // keep the last value, never tear it down
		expect(derives).toBe(1);
	});
});

describe("live tenancy scope — a changed credentials.json flips the resolved tenancy for a new request", () => {
	// This mirrors the daemon's `createLiveDaemonScope`: a getter-backed QueryScope over a
	// debounced mtime-gated re-resolve of the credential provider (the SAME env-over-file read
	// the storage client connects under). It proves a `login` written after boot flips the
	// local-mode default scope for the NEXT request, with NO restart.
	function liveScope(
		provider: { read(): Record<string, unknown> },
		mtime: MtimeReader,
		clock: { now(): number },
	): QueryScope {
		const resolve = createMtimeGatedResolver<QueryScope>(
			mtime,
			() => {
				const rec = provider.read();
				const org = typeof rec.org === "string" ? rec.org : "local";
				const workspace = typeof rec.workspace === "string" ? rec.workspace : "default";
				return { org, workspace };
			},
			{ ttlMs: 100, now: clock.now },
		);
		return {
			get org(): string {
				return resolve().org;
			},
			get workspace(): string | undefined {
				return resolve().workspace;
			},
		};
	}

	it("a re-login (new org/workspace on disk) is seen by a later request read of the same scope object", () => {
		const clock = fakeClock();
		const mtime = fakeMtime(1);
		const provider = mutableProvider({ org: "org-A", workspace: "ws-A" });
		const scope = liveScope(provider, mtime.reader, clock);

		// First request reads org-A (the boot tenancy).
		expect(scope.org).toBe("org-A");
		expect(scope.workspace).toBe("ws-A");

		// `honeycomb login` writes a new tenancy to `~/.deeplake/credentials.json` after boot.
		provider.setRecord({ org: "org-B", workspace: "ws-B" });
		mtime.set(2);
		clock.advance(150);

		// The NEXT request read of the SAME scope object sees org-B — no daemon restart.
		expect(scope.org).toBe("org-B");
		expect(scope.workspace).toBe("ws-B");
	});

	it("a per-request `{ ...scope }` spread snapshots the CURRENT tenancy each time", () => {
		const clock = fakeClock();
		const mtime = fakeMtime(1);
		const provider = mutableProvider({ org: "org-A", workspace: "ws-A" });
		const scope = liveScope(provider, mtime.reader, clock);

		const reqA = { ...scope };
		expect(reqA).toEqual({ org: "org-A", workspace: "ws-A" });

		provider.setRecord({ org: "org-B", workspace: "ws-B" });
		mtime.set(2);
		clock.advance(150);

		const reqB = { ...scope };
		expect(reqB).toEqual({ org: "org-B", workspace: "ws-B" });
		// The earlier snapshot is untouched — each request captured its own tenancy.
		expect(reqA).toEqual({ org: "org-A", workspace: "ws-A" });
	});
});

describe("createLazyStorageClient — rebuilds on a config change, no restart", () => {
	it("a changed credential (new endpoint/workspace) rebuilds the client for the NEXT query", async () => {
		const clock = fakeClock();
		const mtime = fakeMtime(1);
		const transport = new FakeDeepLakeTransport();
		const provider = mutableProvider(
			fakeCredentialRecord({ endpoint: "https://a.deeplake.test", workspace: "ws-A" }),
		);
		const client = createLazyStorageClient({
			provider,
			transport,
			mtimeReader: mtime.reader,
			ttlMs: 100,
			now: clock.now,
		});

		// First query builds + caches the client under config-A (endpoint + workspace ws-A).
		transport.enqueueRows([{ n: 1 }]);
		expect((await client.query("SELECT 1", SCOPE_NO_WS)).kind).toBe("ok");
		expect(client.endpoint).toBe("https://a.deeplake.test");
		expect(lastWorkspace(transport)).toBe("ws-A");

		// A re-login writes config-B (the same effect the file changing has); bump the mtime + window.
		provider.setRecord(fakeCredentialRecord({ endpoint: "https://b.deeplake.test", workspace: "ws-B" }));
		mtime.set(2);
		clock.advance(150);

		// The NEXT query rebuilds against config-B — on the SAME running client, no restart.
		transport.enqueueRows([{ n: 2 }]);
		expect((await client.query("SELECT 1", SCOPE_NO_WS)).kind).toBe("ok");
		expect(client.endpoint).toBe("https://b.deeplake.test");
		expect(lastWorkspace(transport)).toBe("ws-B");
	});

	it("does NOT rebuild when the config identity is unchanged even after the mtime moves", async () => {
		const clock = fakeClock();
		const mtime = fakeMtime(1);
		const transport = new FakeDeepLakeTransport();
		const provider = mutableProvider(
			fakeCredentialRecord({ endpoint: "https://a.deeplake.test", workspace: "ws-A" }),
		);
		const client = createLazyStorageClient({
			provider,
			transport,
			mtimeReader: mtime.reader,
			ttlMs: 100,
			now: clock.now,
		});

		transport.enqueueRows([{ n: 1 }]);
		await client.query("SELECT 1", SCOPE_NO_WS);
		expect(client.endpoint).toBe("https://a.deeplake.test");

		// mtime moved but the identity (endpoint/token/org/workspace) is byte-identical → no rebuild.
		mtime.set(2);
		clock.advance(150);
		transport.enqueueRows([{ n: 2 }]);
		await client.query("SELECT 1", SCOPE_NO_WS);
		expect(client.endpoint).toBe("https://a.deeplake.test");
		expect(lastWorkspace(transport)).toBe("ws-A");
	});

	it("debounces: a config change inside the window is NOT picked up until the window elapses", async () => {
		const clock = fakeClock();
		const mtime = fakeMtime(1);
		const transport = new FakeDeepLakeTransport();
		const provider = mutableProvider(
			fakeCredentialRecord({ endpoint: "https://a.deeplake.test", workspace: "ws-A" }),
		);
		const client = createLazyStorageClient({
			provider,
			transport,
			mtimeReader: mtime.reader,
			ttlMs: 100,
			now: clock.now,
		});

		transport.enqueueRows([{ n: 1 }]);
		await client.query("SELECT 1", SCOPE_NO_WS);
		expect(lastWorkspace(transport)).toBe("ws-A");

		// Change lands but we are still inside the debounce window → the query still uses config-A.
		provider.setRecord(fakeCredentialRecord({ endpoint: "https://b.deeplake.test", workspace: "ws-B" }));
		mtime.set(2);
		clock.advance(10); // < ttlMs
		transport.enqueueRows([{ n: 2 }]);
		await client.query("SELECT 1", SCOPE_NO_WS);
		expect(lastWorkspace(transport)).toBe("ws-A");

		// After the window elapses the change is honored.
		clock.advance(150);
		transport.enqueueRows([{ n: 3 }]);
		await client.query("SELECT 1", SCOPE_NO_WS);
		expect(lastWorkspace(transport)).toBe("ws-B");
	});

	it("fail-soft: a transient no-creds read (absent mtime) keeps the working client (no tear-down)", async () => {
		const clock = fakeClock();
		const mtime = fakeMtime(1);
		const transport = new FakeDeepLakeTransport();
		const provider = mutableProvider(
			fakeCredentialRecord({ endpoint: "https://a.deeplake.test", workspace: "ws-A" }),
		);
		const client = createLazyStorageClient({
			provider,
			transport,
			mtimeReader: mtime.reader,
			ttlMs: 100,
			now: clock.now,
		});

		transport.enqueueRows([{ n: 1 }]);
		await client.query("SELECT 1", SCOPE_NO_WS);
		expect(client.endpoint).toBe("https://a.deeplake.test");

		// The credentials file goes momentarily unreadable → the resolver reports a null mtime; the
		// working client must NOT be torn down (a hiccup must not down the connection).
		mtime.set(null);
		clock.advance(150);
		transport.enqueueRows([{ n: 2 }]);
		expect((await client.query("SELECT 1", SCOPE_NO_WS)).kind).toBe("ok");
		expect(client.endpoint).toBe("https://a.deeplake.test");
	});
});
