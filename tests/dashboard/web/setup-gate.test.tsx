// @vitest-environment jsdom
/**
 * PRD-050b — the pre-auth guided-setup GATE DOM suite (b-AC-3 / b-AC-6).
 *
 * Mounts the real `<SetupGate>` with a MOCKED `fetch` returning the `/setup/state` + `/setup/login`
 * wire payloads (driven through the REAL wire layer so the zod boundary is exercised; only `fetch` is
 * mocked, no live network). Asserts:
 *
 *   b-AC-6  the "First time setup" button is PRESENT in the fresh-install (authenticated:false) state
 *           and ABSENT once a valid credential exists (authenticated:true → the dashboard renders).
 *   b-AC-3  the gate POLLS /setup/state and swaps from the guided-setup screen to the authenticated
 *           dashboard when authenticated flips true — no reload, same component tree.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SetupGate } from "../../../src/dashboard/web/setup-gate.js";
import { createWireClient } from "../../../src/dashboard/web/wire.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const FRESH_STATE = {
	credentials: { deeplake: false, honeycomb: false, hivemind: false },
	phase: "fresh",
	priorTool: { hivemind: "absent" },
	firstTimeSetupComplete: false,
	authenticated: false,
	warmup: { enabled: true, live: false, warm: false },
};

const LINKED_STATE = {
	credentials: { deeplake: true, honeycomb: false, hivemind: false },
	phase: "linked",
	priorTool: { hivemind: "absent" },
	firstTimeSetupComplete: true,
	authenticated: true,
	warmup: { enabled: true, live: true, warm: true },
};

const LOGIN_GRANT = {
	user_code: "WXYZ-1234",
	verification_uri: "https://app.deeplake.ai/device",
	verification_uri_complete: "https://app.deeplake.ai/device?code=WXYZ-1234",
};

/**
 * A mock fetch. `setupState` is a getter so a test can flip the state mid-poll (the live transition).
 * The authenticated dashboard's own endpoints (settings/health/kpis/…) answer empty so the Shell
 * renders without crashing once it mounts.
 */
function makeMockFetch(opts: { setupState: () => unknown; loginOk?: boolean }): typeof fetch {
	const loginOk = opts.loginOk ?? true;
	return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
		const url = typeof input === "string" ? input : input.toString();
		const json = (body: unknown, status = 200): Response =>
			new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		if (url.includes("/setup/state")) return json(opts.setupState());
		if (url.includes("/setup/login")) return loginOk ? json(LOGIN_GRANT) : new Response("err", { status: 502 });
		if (url.endsWith("/health")) return new Response("", { status: 200 });
		// The authenticated Shell hydrates from these — answer empty/safe so it renders.
		if (url.includes("/api/diagnostics/settings")) return json({ orgId: "", orgName: "", workspace: "", settings: {} });
		return json({});
	}) as unknown as typeof fetch;
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	vi.useFakeTimers();
	container = document.createElement("div");
	document.body.appendChild(container);
});
afterEach(() => {
	act(() => root.unmount());
	container.remove();
	vi.useRealTimers();
	vi.restoreAllMocks();
});

/** Mount the gate, flushing the initial poll. */
async function mountGate(fetchImpl: typeof fetch): Promise<void> {
	const wire = createWireClient({ fetchImpl });
	await act(async () => {
		root = createRoot(container);
		root.render(<SetupGate client={wire} assetBase="assets" />);
	});
	// Flush the on-mount `setupState()` poll.
	await act(async () => {
		await Promise.resolve();
	});
}

describe("b-AC-6 the 'First time setup' button is present fresh, absent once linked", () => {
	it("renders the 'First time setup' button in the fresh-install state", async () => {
		const fetchImpl = makeMockFetch({ setupState: () => FRESH_STATE });
		await mountGate(fetchImpl);
		expect(container.querySelector('[data-testid="guided-setup"]')).not.toBeNull();
		expect(container.textContent).toContain("First time setup");
	});

	it("does NOT render the button once authenticated (the dashboard shows instead)", async () => {
		const fetchImpl = makeMockFetch({ setupState: () => LINKED_STATE });
		await mountGate(fetchImpl);
		// The guided-setup subtree (button included) is structurally absent once authenticated.
		expect(container.querySelector('[data-testid="guided-setup"]')).toBeNull();
		expect(container.textContent).not.toContain("First time setup");
		// The authenticated dashboard chrome is mounted instead (the sidebar nav).
		expect(container.querySelector('[aria-label="Dashboard navigation"]')).not.toBeNull();
	});
});

describe("b-AC-3 the gate polls /setup/state and swaps to the dashboard on the live transition", () => {
	it("starts on the guided-setup screen, then swaps to the dashboard when authenticated flips true", async () => {
		// The state flips from fresh → linked on the SECOND poll (simulating the credential landing).
		let authenticated = false;
		const fetchImpl = makeMockFetch({ setupState: () => (authenticated ? LINKED_STATE : FRESH_STATE) });
		await mountGate(fetchImpl);

		// Pre-auth: the guided-setup screen + button.
		expect(container.querySelector('[data-testid="guided-setup"]')).not.toBeNull();

		// The login flow writes the credential — flip the state, then advance to the next poll tick.
		authenticated = true;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2600); // > SETUP_POLL_MS
		});

		// Same component tree, no reload — the dashboard now renders, the guided-setup screen is gone.
		expect(container.querySelector('[data-testid="guided-setup"]')).toBeNull();
		expect(container.querySelector('[aria-label="Dashboard navigation"]')).not.toBeNull();
	});
});
