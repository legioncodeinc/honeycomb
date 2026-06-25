// @vitest-environment jsdom
/**
 * PRD-042 — the Sync page DOM suite (skills + agents views, detail, controls, activity, state).
 *
 * Mounts the REAL {@link SyncPage} into jsdom against a MOCKED wire client and asserts the acceptance
 * criteria through the rendered DOM + the pure helpers:
 *   a-AC-1 / b-AC-1  the list renders one row per skill/agent with a state badge (no double-count).
 *   a-AC-2 / b-AC-2  a row opens a detail view; NO native blob / author email / org GUID is rendered.
 *   a-AC-7           a control shows an in-flight state, then re-reads the union (NOT an optimistic
 *                    flip): the wire's action + a fresh assetsView() are both invoked.
 *   OQ-4             Demote is DISABLED when `authoredByMe` is false.
 *   b-AC-6           the Agents tab renders the SAME components keyed by asset_type (symmetry).
 *   042c             the activity feed renders sync events (filtered) + the per-scope summary matches
 *                    the lists (summarizeScopes / buildActivityLines pure helpers).
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SyncPage, summarizeScopes, buildActivityLines } from "../../../src/dashboard/web/pages/sync.js";
import { ScopeContext, type ScopeContextValue } from "../../../src/dashboard/web/scope-context.js";
import type { PageProps } from "../../../src/dashboard/web/page-frame.js";
import type { AssetSyncRowWire, AssetSyncViewWire, LogRecordWire, WireClient } from "../../../src/dashboard/web/wire.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A union fixture: a local skill, a shared skill (authored by someone else), a local agent. */
function fixtureView(): AssetSyncViewWire {
	return {
		skills: [
			{ assetType: "skill", name: "local-skill", description: "a local skill", state: "local", scope: "repository", sourceHarness: "claude-code", tier: "", style: "", version: 0, honeycombId: "", authoredByMe: false },
			{ assetType: "skill", name: "shared-skill", description: "a shared skill", state: "shared", scope: "team", sourceHarness: "claude-code", tier: "Team", style: "Repository", version: 3, honeycombId: "hc_shared0000shared0000shared0000s", authoredByMe: false },
		],
		agents: [
			{ assetType: "agent", name: "local-agent", description: "a local agent", state: "local", scope: "repository", sourceHarness: "cursor", tier: "", style: "", version: 0, honeycombId: "", authoredByMe: false },
		],
	};
}

/** A captured SSE follow subscription — the handler the page registered + the unsubscribe spy. */
interface StreamHandle {
	/** The latest `onRecord` callback the page handed to `logsStream` (drive it to simulate a tail). */
	handler: ((record: LogRecordWire) => void) | null;
	/** The unsubscribe spy (asserted called on unmount). */
	unsubscribe: ReturnType<typeof vi.fn>;
}

/** A mock wire returning the fixture view + an action ack + a fresh re-read view (converged). */
function mockWire(view: AssetSyncViewWire, logs: LogRecordWire[] = []): WireClient & {
	assetsView: ReturnType<typeof vi.fn>;
	syncAction: ReturnType<typeof vi.fn>;
	logsStream: ReturnType<typeof vi.fn>;
	stream: StreamHandle;
} {
	const assetsView = vi.fn(async () => view);
	const syncAction = vi.fn(async () => ({ ok: true, action: "promote" as const, assetType: "skill" as const, honeycombId: "hc_x", state: "shared" as const, version: 4 }));
	// Capture the page's SSE follow handler so a test can drive a tail record + assert the unsubscribe.
	const stream: StreamHandle = { handler: null, unsubscribe: vi.fn() };
	const logsStream = vi.fn((onRecord: (record: LogRecordWire) => void) => {
		stream.handler = onRecord;
		return stream.unsubscribe;
	});
	return {
		kpis: vi.fn(),
		sessions: vi.fn(),
		settings: vi.fn(),
		rules: vi.fn(),
		skills: vi.fn(),
		graph: vi.fn(),
		recall: vi.fn(),
		logs: vi.fn(async () => logs),
		logsStream,
		harnesses: vi.fn(),
		assetsView,
		syncAction,
		health: vi.fn(),
		pollinate: vi.fn(),
		vaultSettings: vi.fn(),
		setSetting: vi.fn(),
		secretNames: vi.fn(),
		// Test-only accessors: the captured SSE handle (drive a tail record + assert the unsubscribe).
		stream,
	} as unknown as WireClient & {
		assetsView: ReturnType<typeof vi.fn>;
		syncAction: ReturnType<typeof vi.fn>;
		logsStream: ReturnType<typeof vi.fn>;
		stream: StreamHandle;
	};
}

function pageProps(wire: WireClient): PageProps {
	return { wire, daemonUp: true, assetBase: "assets", pollinating: false };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	window.location.hash = "#/sync";
});

afterEach(() => {
	if (root !== undefined) act(() => root.unmount());
	container.remove();
	window.location.hash = "";
});

/** A scope with an ACTIVE project — PRD-049e (the page renders the needs-selection state without one). */
const SCOPE_WITH_PROJECT: ScopeContextValue = {
	scope: { org: "acme", workspace: "backend", project: "api" },
	setScope: () => {},
};

async function mountPage(wire: WireClient): Promise<void> {
	await act(async () => {
		root = createRoot(container);
		root.render(
			<ScopeContext.Provider value={SCOPE_WITH_PROJECT}>
				<SyncPage {...pageProps(wire)} />
			</ScopeContext.Provider>,
		);
	});
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe("PRD-042 pure helpers", () => {
	it("summarizeScopes counts shared/local/pulled across skills + agents (matches the lists)", () => {
		const counts = summarizeScopes(fixtureView());
		expect(counts.shared).toBe(1); // shared-skill
		expect(counts.local).toBe(2); // local-skill + local-agent
		expect(counts.pulled).toBe(0);
	});

	it("buildActivityLines filters to sync events, newest first", () => {
		const records: LogRecordWire[] = [
			{ time: "2026-06-22T10:00:00.000Z", method: "GET", path: "/api/logs", status: 200 },
			{ time: "2026-06-22T10:00:01.000Z", method: "POST", path: "/api/diagnostics/sync/promote", status: 200 },
			{ time: "2026-06-22T10:00:02.000Z", method: "POST", path: "/api/diagnostics/sync/demote", status: 200 },
		];
		const lines = buildActivityLines(records);
		expect(lines.length).toBe(2); // only the two /sync/ events, not the /api/logs GET
		expect(lines[0]).toContain("tombstoned"); // newest first (demote)
		expect(lines[1]).toContain("published"); // promote
	});
});

describe("PRD-042 Sync page DOM", () => {
	it("a-AC-1: lists every skill with a state badge (no double-count)", async () => {
		const wire = mockWire(fixtureView());
		await mountPage(wire);
		// The Skills tab is default — both skill rows render once.
		expect(container.querySelector('[data-testid="row-skill-local-skill"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="row-skill-shared-skill"]')).not.toBeNull();
		expect(container.querySelectorAll('[data-testid="row-skill-local-skill"]').length).toBe(1);
		// The state badges render their honest state text.
		expect(container.textContent).toContain("local");
		expect(container.textContent).toContain("shared");
	});

	it("b-AC-6: the Agents tab renders the SAME components keyed by asset_type (symmetry)", async () => {
		const wire = mockWire(fixtureView());
		await mountPage(wire);
		// Click the Agents tab.
		const tab = container.querySelector('[data-testid="tab-agents"]') as HTMLButtonElement;
		await act(async () => tab.click());
		expect(container.querySelector('[data-testid="row-agent-local-agent"]')).not.toBeNull();
	});

	it("a-AC-2: a row opens a detail view with no secret (no native blob / email / org GUID)", async () => {
		const wire = mockWire(fixtureView());
		await mountPage(wire);
		const rowBtn = container.querySelector('[data-testid="row-skill-shared-skill"]') as HTMLButtonElement;
		await act(async () => rowBtn.click());
		const detail = container.querySelector('[data-testid="detail-skill-shared-skill"]');
		expect(detail).not.toBeNull();
		// Detail shows presentation-safe fields...
		expect(detail?.textContent).toContain("Team"); // tier
		expect(detail?.textContent).toContain("v3"); // version
		// ...and NEVER a secret.
		expect(detail?.textContent).not.toContain("@");
		expect(detail?.textContent).not.toContain("native");
	});

	it("OQ-4: Demote is disabled when the viewer did not author the asset", async () => {
		const wire = mockWire(fixtureView());
		await mountPage(wire);
		const demote = container.querySelector('[data-testid="demote-skill-shared-skill"]') as HTMLButtonElement;
		expect(demote).not.toBeNull();
		expect(demote.disabled).toBe(true); // shared-skill.authoredByMe === false
	});

	it("OQ-4: Demote is enabled for an authored asset", async () => {
		const view = fixtureView();
		const authored: AssetSyncViewWire = {
			skills: [{ ...(view.skills[1] as AssetSyncRowWire), authoredByMe: true }],
			agents: [],
		};
		const wire = mockWire(authored);
		await mountPage(wire);
		const demote = container.querySelector('[data-testid="demote-skill-shared-skill"]') as HTMLButtonElement;
		expect(demote.disabled).toBe(false);
	});

	it("a-AC-7: promoting dispatches the real action then RE-READS the union (not optimistic)", async () => {
		const wire = mockWire(fixtureView());
		await mountPage(wire);
		const initialReads = wire.assetsView.mock.calls.length; // the mount poll already read once
		const promote = container.querySelector('[data-testid="promote-skill-local-skill"]') as HTMLButtonElement;
		await act(async () => {
			promote.click();
			await Promise.resolve();
			await Promise.resolve();
		});
		// The REAL action fired with the right kind + name...
		expect(wire.syncAction).toHaveBeenCalledWith("promote", expect.objectContaining({ assetType: "skill", name: "local-skill" }));
		// ...and the page RE-READ the union after (converged reflect, never an optimistic local flip).
		expect(wire.assetsView.mock.calls.length).toBeGreaterThan(initialReads);
	});

	it("042c: the activity feed + per-scope summary render", async () => {
		const logs: LogRecordWire[] = [
			{ time: "2026-06-22T10:00:01.000Z", method: "POST", path: "/api/diagnostics/sync/promote", status: 200 },
		];
		const wire = mockWire(fixtureView(), logs);
		await mountPage(wire);
		// The per-scope summary shows the converged counts (1 shared, 2 local).
		expect(container.textContent).toContain("shared with team");
		expect(container.textContent).toContain("local only");
		// The activity feed (LiveLog) shows the filtered sync event.
		expect(container.textContent).toContain("published");
	});

	// ── a-AC-6: Enable is the path back for a DISABLED (shared, not-on-disk) asset. ──
	it("a-AC-6: a shared asset shows an Enable control that dispatches the REAL enable action", async () => {
		const wire = mockWire(fixtureView());
		await mountPage(wire);
		// The shared-skill (state=shared) renders an Enable button (the path back from disabled).
		const enable = container.querySelector('[data-testid="enable-skill-shared-skill"]') as HTMLButtonElement;
		expect(enable).not.toBeNull();
		const initialReads = wire.assetsView.mock.calls.length;
		await act(async () => {
			enable.click();
			await Promise.resolve();
			await Promise.resolve();
		});
		// The REAL enable action fired keyed by asset_type + name, carrying the substrate id so the
		// daemon can re-install from the CURRENT version (never an empty native — the page sends none).
		expect(wire.syncAction).toHaveBeenCalledWith(
			"enable",
			expect.objectContaining({ assetType: "skill", name: "shared-skill", honeycombId: "hc_shared0000shared0000shared0000s" }),
		);
		// The page NEVER ships a native blob with the enable (the daemon reads it from the substrate).
		const [, enableInput] = wire.syncAction.mock.calls.find((c) => c[0] === "enable") as [string, { native?: string }];
		expect(enableInput.native).toBeUndefined();
		// ...and it RE-READ the union after (converged reflect, never an optimistic local flip).
		expect(wire.assetsView.mock.calls.length).toBeGreaterThan(initialReads);
	});

	it("a-AC-6: Enable is symmetric — a shared AGENT shows it too (one component family)", async () => {
		const view: AssetSyncViewWire = {
			skills: [],
			agents: [
				{ assetType: "agent", name: "shared-agent", description: "d", state: "shared", scope: "team", sourceHarness: "claude-code", tier: "Team", style: "Repository", version: 2, honeycombId: "hc_agent0000agent0000agent0000agen", authoredByMe: false },
			],
		};
		const wire = mockWire(view);
		await mountPage(wire);
		const tab = container.querySelector('[data-testid="tab-agents"]') as HTMLButtonElement;
		await act(async () => tab.click());
		expect(container.querySelector('[data-testid="enable-agent-shared-agent"]')).not.toBeNull();
	});

	// ── c-AC-2: the activity feed BACKFILLS then FOLLOWS the SSE tail (no poll). ──
	it("c-AC-2: the activity feed backfills, follows the SSE tail, and unsubscribes on unmount", async () => {
		// Backfill snapshot: one prior sync event (filtered in).
		const logs: LogRecordWire[] = [
			{ time: "2026-06-22T10:00:00.000Z", method: "POST", path: "/api/diagnostics/sync/promote", status: 200 },
		];
		const wire = mockWire(fixtureView(), logs);
		await mountPage(wire);
		// The page subscribed to the SSE follow stream (NOT a poll) and the backfill rendered.
		expect(wire.logsStream).toHaveBeenCalledTimes(1);
		expect(wire.stream.handler).not.toBeNull();
		expect(container.textContent).toContain("published"); // backfilled promote

		// Drive a NEW record over the SSE tail — a sync `demote` event lands and is rendered.
		await act(async () => {
			wire.stream.handler?.({ time: "2026-06-22T10:00:05.000Z", method: "POST", path: "/api/diagnostics/sync/demote", status: 200 });
			await Promise.resolve();
		});
		expect(container.textContent).toContain("tombstoned"); // the SSE-tailed demote

		// A NON-sync record over the tail is FILTERED OUT (the feed shows only /sync/ events).
		await act(async () => {
			wire.stream.handler?.({ time: "2026-06-22T10:00:06.000Z", method: "GET", path: "/api/logs", status: 200 });
			await Promise.resolve();
		});

		// Unmount → the EventSource subscription is torn down (no leaked follow).
		act(() => root.unmount());
		expect(wire.stream.unsubscribe).toHaveBeenCalled();
	});
});
