// @vitest-environment jsdom
/**
 * PRD-050d — the coexistence-warning + migration DOM suite (d-AC-1 / d-AC-2 / d-AC-6 / d-AC-7).
 *
 * Mounts the real `<SetupGate>` with a MOCKED `fetch` returning the `/setup/state` + `/setup/migrate*`
 * wire payloads (driven through the REAL wire layer so the zod boundary is exercised; only `fetch` is
 * mocked). Asserts:
 *   d-AC-1  a prior un-migrated Hivemind renders the COEXISTENCE-WARNING wizard, NOT the plain first-time
 *           state (the "First time setup" button is absent; the "Proceed with Honeycomb" button is present).
 *   d-AC-2  "Proceed" does NOT migrate immediately — it shows a CONFIRM step before the destructive call.
 *   d-AC-6  on a `migrated` result the parent poll flips to the authenticated dashboard.
 *   d-AC-7  an interrupted migration (non-terminal phase) renders the resume/rollback surface, never a
 *           clean state.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SetupGate } from "../../../src/dashboard/web/setup-gate.js";
import { createWireClient } from "../../../src/dashboard/web/wire.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const PRIOR_HIVEMIND_STATE = {
	credentials: { deeplake: true, honeycomb: false, hivemind: true },
	phase: "fresh",
	priorTool: { hivemind: "present" },
	firstTimeSetupComplete: false,
	authenticated: false,
	warmup: { enabled: true, live: false, warm: false },
};

const INTERRUPTED_STATE = {
	...PRIOR_HIVEMIND_STATE,
	migration: { phase: "uninstall", startedAt: "2026-06-25T12:00:00.000Z", backupPath: "/home/u/.hivemind-backup-x" },
};

const LINKED_STATE = {
	credentials: { deeplake: true, honeycomb: false, hivemind: false },
	phase: "migrated",
	priorTool: { hivemind: "migrated" },
	firstTimeSetupComplete: true,
	authenticated: true,
	warmup: { enabled: true, live: true, warm: true },
};

const MIGRATE_ADOPTED = { ok: true, phase: "done", message: "All set.", migrated: true, backupPath: "/home/u/.hivemind-backup-x" };
const ROLLBACK_OK = { ok: true, phase: "rolled_back", message: "Rolled back." };

/** A mock fetch whose `/setup/state` is a getter so a test flips the state mid-poll. */
function makeMockFetch(opts: { setupState: () => unknown; migrate?: unknown; rollback?: unknown }): typeof fetch {
	return vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
		const url = typeof input === "string" ? input : input.toString();
		const json = (body: unknown, status = 200): Response =>
			new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		if (url.includes("/setup/migrate-from-hivemind/rollback")) return json(opts.rollback ?? ROLLBACK_OK);
		if (url.includes("/setup/migrate-from-hivemind")) return json(opts.migrate ?? MIGRATE_ADOPTED);
		if (url.includes("/setup/state")) return json(opts.setupState());
		if (url.endsWith("/health")) return new Response("", { status: 200 });
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

async function mountGate(fetchImpl: typeof fetch): Promise<void> {
	const wire = createWireClient({ fetchImpl });
	await act(async () => {
		root = createRoot(container);
		root.render(<SetupGate client={wire} assetBase="assets" />);
	});
	await act(async () => {
		await Promise.resolve();
	});
}

/** Click a testid'd element and flush. */
async function click(testid: string): Promise<void> {
	const el = container.querySelector(`[data-testid="${testid}"]`) as HTMLElement | null;
	if (el === null) throw new Error(`no element with data-testid="${testid}"`);
	await act(async () => {
		el.click();
		await Promise.resolve();
	});
}

describe("d-AC-1 a prior un-migrated Hivemind renders the coexistence-warning wizard (not first-time)", () => {
	it("renders the coexistence-warning + the 'Proceed with Honeycomb' button, NOT the first-time button", async () => {
		await mountGate(makeMockFetch({ setupState: () => PRIOR_HIVEMIND_STATE }));
		expect(container.querySelector('[data-testid="coexistence-warning"]')).not.toBeNull();
		// The plain first-time guided-setup is structurally absent.
		expect(container.querySelector('[data-testid="guided-setup"]')).toBeNull();
		expect(container.textContent).toContain("Proceed with Honeycomb");
		expect(container.textContent).not.toContain("First time setup");
		// d-AC-2: the rule is stated up front.
		expect(container.textContent?.toLowerCase()).toContain("isn’t supported");
	});
});

describe("d-AC-2 'Proceed' confirms BEFORE any destructive action", () => {
	it("shows a confirm step on Proceed, and only migrates after the explicit confirm", async () => {
		const fetchImpl = makeMockFetch({ setupState: () => PRIOR_HIVEMIND_STATE });
		await mountGate(fetchImpl);

		// First click → confirm step (NO migrate call yet).
		await click("proceed-button");
		expect(container.querySelector('[data-testid="migration-confirm"]')).not.toBeNull();
		const calledMigrate = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) =>
			String(c[0]).includes("/setup/migrate-from-hivemind"),
		);
		expect(calledMigrate).toBe(false);

		// Confirm → the destructive migrate fires.
		await click("confirm-migrate-button");
		const calledAfter = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) =>
			String(c[0]).includes("/setup/migrate-from-hivemind"),
		);
		expect(calledAfter).toBe(true);
	});
});

describe("d-AC-6 an adopt-success migration flips to the authenticated dashboard via the poll", () => {
	it("after a `migrated` result, the next /setup/state poll (now authenticated) renders the dashboard", async () => {
		// State flips to LINKED on the second poll, simulating the credential adoption landing.
		let linked = false;
		const fetchImpl = makeMockFetch({ setupState: () => (linked ? LINKED_STATE : PRIOR_HIVEMIND_STATE), migrate: MIGRATE_ADOPTED });
		await mountGate(fetchImpl);

		await click("proceed-button");
		await click("confirm-migrate-button");
		// The adopt-success persisted the credential server-side; flip the state then advance the poll.
		linked = true;
		await act(async () => {
			await vi.advanceTimersByTimeAsync(2600);
		});
		expect(container.querySelector('[data-testid="coexistence-warning"]')).toBeNull();
		expect(container.querySelector('[aria-label="Dashboard navigation"]')).not.toBeNull();
	});
});

describe("d-AC-7 an interrupted migration renders the resume/rollback surface (never a clean state)", () => {
	it("renders the interrupted surface with resume + rollback affordances", async () => {
		await mountGate(makeMockFetch({ setupState: () => INTERRUPTED_STATE }));
		expect(container.querySelector('[data-testid="migration-interrupted"]')).not.toBeNull();
		// A half-migrated machine is NEVER shown as a clean coexistence/first-time state.
		expect(container.querySelector('[data-testid="coexistence-warning"]')).toBeNull();
		expect(container.querySelector('[data-testid="guided-setup"]')).toBeNull();
		expect(container.querySelector('[data-testid="resume-button"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="rollback-button"]')).not.toBeNull();
		expect(container.textContent).toContain("interrupted");
	});

	it("Roll back calls the rollback endpoint", async () => {
		const fetchImpl = makeMockFetch({ setupState: () => INTERRUPTED_STATE, rollback: ROLLBACK_OK });
		await mountGate(fetchImpl);
		await click("rollback-button");
		const calledRollback = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls.some((c) =>
			String(c[0]).includes("/setup/migrate-from-hivemind/rollback"),
		);
		expect(calledRollback).toBe(true);
	});
});
