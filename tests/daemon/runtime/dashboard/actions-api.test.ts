/**
 * Dashboard imperative-actions suite — `mountActionsGroup` (logout / embeddings / restart / uninstall).
 *
 * Drives the four handlers through a bare Hono group with injected seams (the credential remover, the
 * embed supervisor, the restart respawn, the shutdown, the uninstall outcome), so every handler AND
 * every guard-rejection path is provable without removing a real credential, killing the test process,
 * or spawning a real daemon. Proves:
 *   - the shared guard: local-mode-only, cross-origin reject, untrusted-Origin reject, missing-session reject;
 *   - logout calls the credential remover and returns `{ ok: true }`;
 *   - embeddings actuates the supervisor live (`setEnabled`) AND persists the choice, echoing the new state;
 *   - a malformed embeddings body 400s without touching the supervisor;
 *   - restart spawns the respawn helper, acks `{ restarting: true }`, then triggers shutdown;
 *   - uninstall returns the injected guided outcome.
 */

import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { EmbedSupervisor } from "../../../../src/daemon/runtime/services/embed-supervisor.js";
import type { VaultStore } from "../../../../src/daemon/runtime/vault/store.js";
import { EMBEDDINGS_ENABLED_KEY } from "../../../../src/daemon/runtime/vault/api.js";
import {
	mountActionsGroup,
	type MountActionsOptions,
	type UninstallOutcome,
} from "../../../../src/daemon/runtime/dashboard/actions-api.js";

/** A recording embed supervisor fake (only `setEnabled` is exercised; the rest satisfy the type). */
function fakeEmbed(): { sup: EmbedSupervisor; setEnabledCalls: boolean[] } {
	const setEnabledCalls: boolean[] = [];
	const sup = {
		live: false,
		warm: false,
		disabled: false,
		restarts: 0,
		async start(): Promise<void> {},
		async stop(): Promise<void> {},
		async restart(): Promise<void> {},
		async setEnabled(enabled: boolean): Promise<void> {
			setEnabledCalls.push(enabled);
		},
	} satisfies EmbedSupervisor;
	return { sup, setEnabledCalls };
}

/** A recording vault-store fake (only `setSetting` is exercised). */
function fakeStore(): { store: VaultStore; calls: Array<{ key: string; value: unknown; scope: unknown }> } {
	const calls: Array<{ key: string; value: unknown; scope: unknown }> = [];
	const store = {
		async setSetting(key: string, value: unknown, scope: unknown): Promise<{ ok: true }> {
			calls.push({ key, value, scope });
			return { ok: true };
		},
	} as unknown as VaultStore;
	return { store, calls };
}

/** Build an app whose root group carries the action handlers (group-relative paths → `/logout` etc.). */
function appWith(mode: "local" | "team" | "hybrid", options: MountActionsOptions): Hono {
	const app = new Hono();
	mountActionsGroup(app, mode, options);
	return app;
}

/** The headers a legitimate dashboard request carries (same-origin custom session header, loopback). */
function okHeaders(extra: Record<string, string> = {}): Record<string, string> {
	return {
		"content-type": "application/json",
		"x-honeycomb-session": "dashboard-web",
		"sec-fetch-site": "same-origin",
		...extra,
	};
}

afterEach(() => {
	vi.useRealTimers();
});

describe("dashboard actions — the shared guard", () => {
	it("403s when the daemon is not in local mode", async () => {
		const { sup } = fakeEmbed();
		const app = appWith("team", { embed: sup, removeCredentials: () => {} });
		const res = await app.request("/logout", { method: "POST", headers: okHeaders() });
		expect(res.status).toBe(403);
	});

	it("403s a cross-site browser request (CSRF)", async () => {
		const { sup } = fakeEmbed();
		let removed = false;
		const app = appWith("local", { embed: sup, removeCredentials: () => { removed = true; } });
		const res = await app.request("/logout", { method: "POST", headers: okHeaders({ "sec-fetch-site": "cross-site" }) });
		expect(res.status).toBe(403);
		expect(removed).toBe(false);
	});

	it("403s a request whose Origin is not loopback", async () => {
		const { sup } = fakeEmbed();
		const app = appWith("local", { embed: sup, removeCredentials: () => {} });
		const res = await app.request("/logout", { method: "POST", headers: okHeaders({ origin: "https://evil.example" }) });
		expect(res.status).toBe(403);
	});

	it("allows a loopback Origin", async () => {
		const { sup } = fakeEmbed();
		let removed = false;
		const app = appWith("local", { embed: sup, removeCredentials: () => { removed = true; } });
		const res = await app.request("/logout", { method: "POST", headers: okHeaders({ origin: "http://127.0.0.1:3850" }) });
		expect(res.status).toBe(200);
		expect(removed).toBe(true);
	});

	it("403s when the dashboard session header is missing", async () => {
		const { sup } = fakeEmbed();
		const app = appWith("local", { embed: sup, removeCredentials: () => {} });
		const headers = { "content-type": "application/json", "sec-fetch-site": "same-origin" };
		const res = await app.request("/logout", { method: "POST", headers });
		expect(res.status).toBe(403);
	});
});

describe("dashboard actions — logout", () => {
	it("removes the credentials and acks ok", async () => {
		const { sup } = fakeEmbed();
		let removed = false;
		const app = appWith("local", { embed: sup, removeCredentials: () => { removed = true; } });
		const res = await app.request("/logout", { method: "POST", headers: okHeaders() });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(removed).toBe(true);
	});
});

describe("dashboard actions — embeddings", () => {
	it("actuates the supervisor live AND persists the choice, echoing the new state", async () => {
		const { sup, setEnabledCalls } = fakeEmbed();
		const { store, calls } = fakeStore();
		const app = appWith("local", { embed: sup, store, defaultScope: { org: "o", workspace: "w" } });
		const res = await app.request("/embeddings", { method: "POST", headers: okHeaders(), body: JSON.stringify({ enabled: false }) });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, enabled: false });
		// Live actuation + persistence both fired.
		expect(setEnabledCalls).toEqual([false]);
		expect(calls).toHaveLength(1);
		expect(calls[0]?.key).toBe(EMBEDDINGS_ENABLED_KEY);
		expect(calls[0]?.value).toBe(false);
	});

	it("400s a body with no boolean `enabled` and never touches the supervisor", async () => {
		const { sup, setEnabledCalls } = fakeEmbed();
		const app = appWith("local", { embed: sup });
		const res = await app.request("/embeddings", { method: "POST", headers: okHeaders(), body: JSON.stringify({ nope: 1 }) });
		expect(res.status).toBe(400);
		expect(setEnabledCalls).toEqual([]);
	});

	it("still toggles live when no store is wired (persistence simply skipped)", async () => {
		const { sup, setEnabledCalls } = fakeEmbed();
		const app = appWith("local", { embed: sup, defaultScope: { org: "o", workspace: "w" } });
		const res = await app.request("/embeddings", { method: "POST", headers: okHeaders(), body: JSON.stringify({ enabled: true }) });
		expect(res.status).toBe(200);
		expect(setEnabledCalls).toEqual([true]);
	});
});

describe("dashboard actions — restart", () => {
	it("spawns the respawn helper, acks restarting, then triggers shutdown", async () => {
		vi.useFakeTimers();
		const { sup } = fakeEmbed();
		let spawned = false;
		let shutdownCalled = false;
		const app = appWith("local", {
			embed: sup,
			spawnRestart: () => { spawned = true; },
			shutdown: () => { shutdownCalled = true; },
		});
		const res = await app.request("/restart", { method: "POST", headers: okHeaders() });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true, restarting: true });
		// The helper spawns synchronously; the shutdown is deferred a tick so the response flushes.
		expect(spawned).toBe(true);
		expect(shutdownCalled).toBe(false);
		vi.runAllTimers();
		expect(shutdownCalled).toBe(true);
	});
});

describe("dashboard actions — uninstall", () => {
	it("returns the injected guided outcome", async () => {
		const { sup } = fakeEmbed();
		const outcome: UninstallOutcome = {
			ok: true,
			harnesses: ["claude-code", "cursor"],
			removed: false,
			command: "honeycomb uninstall",
			note: "guided",
		};
		const app = appWith("local", { embed: sup, uninstall: () => outcome });
		const res = await app.request("/uninstall", { method: "POST", headers: okHeaders() });
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual(outcome);
	});
});
