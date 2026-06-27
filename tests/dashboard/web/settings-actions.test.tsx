// @vitest-environment jsdom
/**
 * Settings page — dashboard ACTIONS DOM suite (logout / login / embeddings / restart / uninstall).
 *
 * Mounts the REAL {@link SettingsPage} into jsdom against a mocked wire and drives the new action
 * controls through the rendered DOM:
 *   - logout: the connected auth section shows "Log out"; clicking calls `wire.logout()` and the
 *     section re-reads `authStatus()` (now disconnected) → flips to the connect state;
 *   - login: the disconnected section's "Connect to DeepLake" calls `wire.setupLogin()` and renders
 *     the returned `user_code` (no token);
 *   - embeddings: the toggle reflects `health().reasons.embeddings` and flips via `setEmbeddings`;
 *   - restart: a two-step confirm calls `restartDaemon()` and shows "restarting…";
 *   - uninstall: a two-step confirm calls `uninstall()` and renders the returned command.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsPage } from "../../../src/dashboard/web/pages/settings.js";
import type { PageProps } from "../../../src/dashboard/web/page-frame.js";
import type { AuthStatusWire, WireClient } from "../../../src/dashboard/web/wire.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONNECTED: AuthStatusWire = {
	connected: true,
	orgId: "org-acme",
	orgName: "Acme Inc",
	workspace: "backend",
	agentId: "agent-7",
	source: "file",
	savedAt: "2026-06-22T00:00:00.000Z",
};
const DISCONNECTED: AuthStatusWire = { connected: false, orgId: "", orgName: "", workspace: "", agentId: "", source: "none", savedAt: "" };

/** Build a mock wire with just the methods the Settings page touches; the rest are inert stubs. */
function mockWire(over: Partial<Record<keyof WireClient, unknown>> = {}): WireClient {
	const base: Record<string, unknown> = {
		authStatus: vi.fn(async () => DISCONNECTED),
		vaultSettings: vi.fn(async () => ({ settings: {}, catalog: [] })),
		secretNames: vi.fn(async () => []),
		setSecret: vi.fn(async () => true),
		setSetting: vi.fn(async () => true),
		health: vi.fn(async () => ({ up: true, reasons: { storage: "ok", embeddings: "off", schema: "ok" } })),
		setupLogin: vi.fn(async () => ({ user_code: "WXYZ-9876", verification_uri: "https://deeplake.test/device" })),
		logout: vi.fn(async () => true),
		setEmbeddings: vi.fn(async () => true),
		restartDaemon: vi.fn(async () => true),
		uninstall: vi.fn(async () => ({ ok: true, harnesses: ["claude-code", "cursor"], removed: false, command: "honeycomb uninstall", note: "guided" })),
	};
	return { ...base, ...over } as unknown as WireClient;
}

function pageProps(wire: WireClient): PageProps {
	return { wire, daemonUp: true, assetBase: "assets", pollinating: false };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	window.location.hash = "#/settings";
});

afterEach(() => {
	if (root !== undefined) act(() => root.unmount());
	container.remove();
	window.location.hash = "";
	vi.useRealTimers();
});

async function flush(): Promise<void> {
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

async function mountPage(wire: WireClient): Promise<void> {
	await act(async () => {
		root = createRoot(container);
		root.render(<SettingsPage {...pageProps(wire)} />);
	});
	await flush();
}

async function click(testid: string): Promise<void> {
	const el = container.querySelector(`[data-testid="${testid}"]`);
	if (el === null) throw new Error(`no element [data-testid="${testid}"]`);
	await act(async () => el.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await flush();
}

describe("logout", () => {
	it("connected shows Log out; clicking calls logout and flips to disconnected", async () => {
		// authStatus: connected first, disconnected after logout (re-read).
		let call = 0;
		const authStatus = vi.fn(async () => (call++ === 0 ? CONNECTED : DISCONNECTED));
		const logout = vi.fn(async () => true);
		const wire = mockWire({ authStatus, logout });
		await mountPage(wire);
		expect(container.querySelector('[data-testid="auth-logout-button"]')).not.toBeNull();
		await click("auth-logout-button");
		expect(logout).toHaveBeenCalledTimes(1);
		// The section re-read authStatus → now disconnected → the connect affordance renders.
		expect(container.querySelector('[data-testid="auth-disconnected"]')).not.toBeNull();
	});
});

describe("login (in-page device flow)", () => {
	it("Connect to DeepLake calls setupLogin and renders the user_code", async () => {
		const setupLogin = vi.fn(async () => ({ user_code: "WXYZ-9876", verification_uri: "https://deeplake.test/device" }));
		const wire = mockWire({ authStatus: vi.fn(async () => DISCONNECTED), setupLogin });
		await mountPage(wire);
		await click("auth-connect-button");
		expect(setupLogin).toHaveBeenCalledTimes(1);
		expect(container.textContent).toContain("WXYZ-9876");
	});
});

describe("embeddings toggle", () => {
	it("reflects off and turns on via setEmbeddings(true)", async () => {
		const setEmbeddings = vi.fn(async () => true);
		const wire = mockWire({ setEmbeddings });
		await mountPage(wire);
		const toggle = container.querySelector('[data-testid="embeddings-toggle"]');
		expect(toggle?.textContent).toContain("Turn on");
		await click("embeddings-toggle");
		expect(setEmbeddings).toHaveBeenCalledWith(true);
	});
});

describe("system restart", () => {
	it("two-step confirm calls restartDaemon and shows restarting", async () => {
		const restartDaemon = vi.fn(async () => true);
		const wire = mockWire({ restartDaemon });
		await mountPage(wire);
		await click("system-restart-button");
		expect(container.querySelector('[data-testid="system-restart-confirm"]')).not.toBeNull();
		await click("system-restart-confirm");
		expect(restartDaemon).toHaveBeenCalledTimes(1);
		expect(container.querySelector('[data-testid="system-restarting"]')).not.toBeNull();
	});
});

describe("system uninstall", () => {
	it("two-step confirm calls uninstall and renders the command + harnesses", async () => {
		const uninstall = vi.fn(async () => ({ ok: true, harnesses: ["claude-code", "cursor"], removed: false, command: "honeycomb uninstall", note: "Run this to finish." }));
		const wire = mockWire({ uninstall });
		await mountPage(wire);
		await click("system-uninstall-button");
		expect(container.querySelector('[data-testid="system-uninstall-confirm"]')).not.toBeNull();
		await click("system-uninstall-confirm");
		expect(uninstall).toHaveBeenCalledTimes(1);
		const result = container.querySelector('[data-testid="system-uninstall-result"]');
		expect(result).not.toBeNull();
		expect(result?.textContent).toContain("honeycomb uninstall");
		expect(result?.textContent).toContain("claude-code");
	});
});
