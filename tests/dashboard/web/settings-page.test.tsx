// @vitest-environment jsdom
/**
 * PRD-044 — the Settings page DOM suite (044a auth · 044b provider keys · 044c search mode).
 *
 * Mounts the REAL {@link SettingsPage} into jsdom against a MOCKED wire client and asserts the ACs
 * through the rendered DOM:
 *   AC-1  the page renders THREE sections (DeepLake auth · provider keys · search & inference).
 *   044a  auth is truthful: connected (org/workspace/source) vs disconnected (CLI hand-off);
 *         source=env → "via HONEYCOMB_TOKEN"; absent expiresAt → "expiry unknown"; NO token.
 *   044b  a save POSTs the conventional name + `{ value }`, CLEARS on success, re-reads presence;
 *         the presence badges include Cohere; NO secret value appears in the DOM (input cleared,
 *         never echoed).
 *   044c  the recall-mode select persists via setSetting + reflects the persisted value; the
 *         migrated provider/model/dreaming controls persist through setSetting.
 *   AC-6  no token/secret value in the rendered DOM.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SettingsPage } from "../../../src/dashboard/web/pages/settings.js";
import type { PageProps } from "../../../src/dashboard/web/page-frame.js";
import type { AuthStatusWire, VaultSettingsWire, WireClient } from "../../../src/dashboard/web/wire.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const CONNECTED_FILE: AuthStatusWire = {
	connected: true,
	orgId: "org-acme",
	orgName: "Acme Inc",
	workspace: "backend",
	agentId: "agent-7",
	source: "file",
	savedAt: "2026-06-22T00:00:00.000Z",
};

const DISCONNECTED: AuthStatusWire = {
	connected: false,
	orgId: "",
	orgName: "",
	workspace: "",
	agentId: "",
	source: "none",
	savedAt: "",
};

const EMPTY_VAULT: VaultSettingsWire = { settings: {}, catalog: [] };

/** A mock wire stubbing every method; the three 044 methods are overridable per test. */
function mockWire(opts: {
	authStatus?: AuthStatusWire;
	vault?: VaultSettingsWire;
	secretNames?: string[];
	secretNamesAfter?: string[];
	setSecretOk?: boolean;
} = {}): WireClient & {
	authStatus: ReturnType<typeof vi.fn>;
	setSecret: ReturnType<typeof vi.fn>;
	setSetting: ReturnType<typeof vi.fn>;
	secretNames: ReturnType<typeof vi.fn>;
	vaultSettings: ReturnType<typeof vi.fn>;
} {
	let secretCall = 0;
	const names = opts.secretNames ?? [];
	const namesAfter = opts.secretNamesAfter ?? names;
	const secretNames = vi.fn(async () => {
		const v = secretCall === 0 ? names : namesAfter;
		secretCall++;
		return v;
	});
	const authStatus = vi.fn(async () => opts.authStatus ?? DISCONNECTED);
	const vaultSettings = vi.fn(async () => opts.vault ?? EMPTY_VAULT);
	const setSecret = vi.fn(async () => opts.setSecretOk ?? true);
	const setSetting = vi.fn(async () => true);
	return {
		kpis: vi.fn(),
		sessions: vi.fn(),
		settings: vi.fn(),
		rules: vi.fn(),
		skills: vi.fn(),
		graph: vi.fn(),
		memoryGraph: vi.fn(),
		recall: vi.fn(),
		listMemories: vi.fn(),
		getMemory: vi.fn(),
		addMemory: vi.fn(),
		modifyMemory: vi.fn(),
		forgetMemory: vi.fn(),
		compact: vi.fn(),
		logs: vi.fn(),
		logsStream: vi.fn(() => () => {}),
		logsHistory: vi.fn(),
		turnsHistory: vi.fn(),
		harnesses: vi.fn(),
		assetsView: vi.fn(),
		syncAction: vi.fn(),
		health: vi.fn(),
		dream: vi.fn(),
		vaultSettings,
		setSetting,
		secretNames,
		setSecret,
		authStatus,
	} as unknown as WireClient & {
		authStatus: ReturnType<typeof vi.fn>;
		setSecret: ReturnType<typeof vi.fn>;
		setSetting: ReturnType<typeof vi.fn>;
		secretNames: ReturnType<typeof vi.fn>;
		vaultSettings: ReturnType<typeof vi.fn>;
	};
}

function pageProps(wire: WireClient): PageProps {
	return { wire, daemonUp: true, assetBase: "assets", dreaming: false };
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
});

/** Set a controlled input's value through React's onChange (the native-setter bypass). */
async function setInputValue(el: HTMLInputElement | null, value: string): Promise<void> {
	if (el === null) return;
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	setter?.call(el, value);
	await act(async () => el.dispatchEvent(new Event("input", { bubbles: true })));
}

async function mountPage(wire: WireClient): Promise<void> {
	await act(async () => {
		root = createRoot(container);
		root.render(<SettingsPage {...pageProps(wire)} />);
	});
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe("AC-1 the page renders three sections", () => {
	it("renders DeepLake auth, provider keys, and search & inference", async () => {
		await mountPage(mockWire());
		expect(container.textContent).toContain("DeepLake");
		expect(container.querySelector('[data-testid="provider-keys"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="search-inference"]')).not.toBeNull();
	});
});

describe("044a auth is truthful", () => {
	it("connected (file) shows the real org/workspace/source and never a token", async () => {
		const wire = mockWire({ authStatus: CONNECTED_FILE });
		await mountPage(wire);
		const connected = container.querySelector('[data-testid="auth-connected"]');
		expect(connected).not.toBeNull();
		expect(container.textContent).toContain("Acme Inc");
		expect(container.textContent).toContain("backend");
		expect(container.textContent).toContain("agent-7");
		// Absent expiresAt → "expiry unknown", never a fabricated date.
		expect(container.textContent).toContain("expiry unknown");
	});

	it("source=env renders 'via HONEYCOMB_TOKEN'", async () => {
		await mountPage(mockWire({ authStatus: { ...CONNECTED_FILE, source: "env" } }));
		expect(container.textContent).toContain("via HONEYCOMB_TOKEN");
	});

	it("disconnected shows the honest not-connected state + the CLI hand-off", async () => {
		await mountPage(mockWire({ authStatus: DISCONNECTED }));
		expect(container.querySelector('[data-testid="auth-disconnected"]')).not.toBeNull();
		expect(container.textContent).toContain("Not connected to DeepLake");
		expect(container.querySelector('[data-testid="auth-connect"]')).not.toBeNull();
		expect(container.textContent).toContain("honeycomb login");
	});
});

describe("044b provider keys are write-only", () => {
	it("renders a row per provider INCLUDING Cohere, with presence badges", async () => {
		await mountPage(mockWire({ secretNames: ["ANTHROPIC_API_KEY"] }));
		for (const id of ["anthropic", "openai", "openrouter", "cohere"]) {
			expect(container.querySelector(`[data-testid="provider-row-${id}"]`)).not.toBeNull();
		}
		// Anthropic present → "key set ✓"; the others "not set".
		const anthropicRow = container.querySelector('[data-testid="provider-row-anthropic"]');
		expect(anthropicRow?.textContent).toContain("key set ✓");
		const cohereRow = container.querySelector('[data-testid="provider-row-cohere"]');
		expect(cohereRow?.textContent).toContain("not set");
	});

	it("a save POSTs the conventional name + value, CLEARS the input, re-reads presence", async () => {
		const SECRET = "sk-cohere-DO-NOT-LEAK";
		const wire = mockWire({ secretNames: [], secretNamesAfter: ["COHERE_API_KEY"], setSecretOk: true });
		await mountPage(wire);
		const input = container.querySelector('input[data-testid="provider-input-cohere"]') as HTMLInputElement;
		expect(input.type).toBe("password"); // write-only password field.
		await setInputValue(input, SECRET);
		const save = container.querySelector('[data-testid="provider-save-cohere"]') as HTMLButtonElement;
		await act(async () => {
			save.click();
			await Promise.resolve();
			await Promise.resolve();
		});
		// POSTed the conventional name + the value (write-only).
		expect(wire.setSecret).toHaveBeenCalledWith("COHERE_API_KEY", SECRET);
		// The input CLEARED on success (no lingering value in state/DOM).
		const inputAfter = container.querySelector('input[data-testid="provider-input-cohere"]') as HTMLInputElement;
		expect(inputAfter.value).toBe("");
		// The secret value appears NOWHERE in the DOM (AC-3 / AC-6).
		expect(container.innerHTML).not.toContain(SECRET);
		// Re-read presence flipped the badge to "set ✓".
		const cohereRow = container.querySelector('[data-testid="provider-row-cohere"]');
		expect(cohereRow?.textContent).toContain("key set ✓");
	});

	it("an empty value is rejected client-side and never POSTed", async () => {
		const wire = mockWire({ secretNames: [] });
		await mountPage(wire);
		const save = container.querySelector('[data-testid="provider-save-openai"]') as HTMLButtonElement;
		await act(async () => {
			save.click();
			await Promise.resolve();
		});
		expect(wire.setSecret).not.toHaveBeenCalled();
		expect(container.querySelector('[data-testid="provider-rejected-openai"]')).not.toBeNull();
	});

	it("a rejected (non-2xx) write keeps the input (for retry) and shows 'not accepted', never echoing the value", async () => {
		const SECRET = "sk-rejected-DO-NOT-LEAK";
		const wire = mockWire({ secretNames: [], setSecretOk: false });
		await mountPage(wire);
		const input = container.querySelector('input[data-testid="provider-input-openai"]') as HTMLInputElement;
		await setInputValue(input, SECRET);
		const save = container.querySelector('[data-testid="provider-save-openai"]') as HTMLButtonElement;
		await act(async () => {
			save.click();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(container.querySelector('[data-testid="provider-rejected-openai"]')).not.toBeNull();
		// Write-only discipline: on a REJECTED write the value is RETAINED for retry (only a SUCCESS
		// clears it) — and it lives ONLY in the masked password input the user is editing, never
		// ECHOED into any other DOM text (no badge, no response display, no log). Assert the value is
		// confined to that one password input's `value`, present nowhere else in the rendered text.
		const inputAfter = container.querySelector('input[data-testid="provider-input-openai"]') as HTMLInputElement;
		expect(inputAfter.value).toBe(SECRET); // retained for retry.
		expect(inputAfter.type).toBe("password"); // masked, never displayed as text.
		// The value is NOT present in the rendered TEXT content anywhere (it is never echoed).
		expect(container.textContent ?? "").not.toContain(SECRET);
	});
});

describe("044c recall mode + migrated inference", () => {
	it("the recall-mode select reflects the persisted value and persists via setSetting", async () => {
		const wire = mockWire({ vault: { settings: { recallMode: "hybrid" }, catalog: [] } });
		await mountPage(wire);
		const select = container.querySelector('[data-testid="recall-mode-select"]') as HTMLSelectElement;
		expect(select).not.toBeNull();
		// Reflects the persisted value.
		expect(select.value).toBe("hybrid");
		// Change to keyword → persists through setSetting (no new wire method).
		await act(async () => {
			const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
			setter?.call(select, "keyword");
			select.dispatchEvent(new Event("change", { bubbles: true }));
			await Promise.resolve();
		});
		expect(wire.setSetting).toHaveBeenCalledWith("recallMode", "keyword");
	});

	it("the 'default' option maps to leaving the key UNSET (empty value)", async () => {
		// No recallMode persisted → the controlled select value is "" (the default option).
		const wire = mockWire({ vault: { settings: {}, catalog: [] } });
		await mountPage(wire);
		const select = container.querySelector('[data-testid="recall-mode-select"]') as HTMLSelectElement;
		expect(select.value).toBe("");
	});

	it("the migrated provider/model/dreaming panel persists through setSetting", async () => {
		const wire = mockWire({
			vault: {
				settings: { activeProvider: "anthropic", activeModel: "claude-sonnet-4-6" },
				catalog: [{ id: "anthropic", label: "Anthropic", models: ["claude-sonnet-4-6", "claude-opus-4-8"], openEnded: false }],
			},
		});
		await mountPage(wire);
		// The dreaming toggle is part of the migrated panel — clicking it persists dreaming.enabled.
		const toggle = container.querySelector('[aria-label="dreaming"]') as HTMLButtonElement;
		expect(toggle).not.toBeNull();
		await act(async () => {
			toggle.click();
			await Promise.resolve();
		});
		expect(wire.setSetting).toHaveBeenCalledWith("dreaming.enabled", true);
	});
});
