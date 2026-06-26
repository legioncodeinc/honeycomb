// @vitest-environment jsdom
/**
 * PRD-040 — the Memories page DOM suite (040a browse/search/view + 040b add/edit + 040c lifecycle).
 *
 * Mounts the REAL {@link MemoriesPage} into jsdom against a MOCKED `WireClient` and proves every AC:
 *   040a — list hydrates + honest empty state; search swaps to ranked hits + lexical badge; detail
 *          renders content + metadata; a forgotten/unknown id renders the honest state.
 *   040b — add POSTs + re-lists; edit POSTs modify with a REQUIRED reason (empty reason can't submit);
 *          RE-READ-not-optimistic (the ack/persisted value differs from the form input → the re-read
 *          value shows); honest failure leaves the persisted value; forget is behind a confirm.
 *   040c — compact renders the per-table summary (incl. errored → "attempted, not completed"); pollinate
 *          reflects the three ack shapes honestly (no spinner); watch polls + filters + stops.
 *   AC-5 — memory content is ESCAPED (no injected markup); no secret/token in any rendered line.
 *
 * Driven through a hand-rolled mock `WireClient` so the suite is fast + isolated; the wire's zod
 * boundary is exercised by `wire-memories.test.ts`.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MemoriesPage } from "../../../src/dashboard/web/pages/memories.js";
import { ScopeContext, type ScopeContextValue } from "../../../src/dashboard/web/scope-context.js";
import { DEFAULT_MEMORY_TYPE, MEMORY_TYPES } from "../../../src/shared/memory-types.js";
import type { PageProps } from "../../../src/dashboard/web/page-frame.js";
import type { CompactSummaryWire, PollinateAck, LogRecordWire, MemoryRecordWire, RecalledMemory, WireClient } from "../../../src/dashboard/web/wire.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** Build a memory record with sensible defaults. */
function rec(over: Partial<MemoryRecordWire> = {}): MemoryRecordWire {
	return {
		id: "mem-1",
		type: "fact",
		content: "we deploy via just release",
		confidence: 1,
		agentId: "default",
		createdAt: "2026-06-20T00:00:00.000Z",
		updatedAt: "2026-06-21T00:00:00.000Z",
		visibility: "global",
		sourceType: "session",
		sourceId: "sess-9",
		version: 1,
		hasEmbedding: true,
		...over,
	};
}

/** A configurable mock wire — only the methods the page calls; everything else zeroed/no-op. */
function mockWire(opts: {
	list?: MemoryRecordWire[];
	get?: (id: string) => MemoryRecordWire | null;
	recall?: { memories: RecalledMemory[]; degraded: boolean };
	addAck?: { id: string | null; action: string } | null;
	modifyAck?: { id: string | null; action: string; audited: boolean } | null;
	forgetAck?: { id: string | null; action: string; audited: boolean } | null;
	compact?: CompactSummaryWire | null;
	pollinate?: PollinateAck;
	logs?: LogRecordWire[];
} = {}): WireClient {
	const listRows = opts.list ?? [];
	return {
		kpis: vi.fn(),
		sessions: vi.fn(),
		settings: vi.fn(),
		rules: vi.fn(),
		skills: vi.fn(),
		graph: vi.fn(),
		recall: vi.fn(async () => opts.recall ?? { memories: [], degraded: false }),
		listMemories: vi.fn(async () => listRows),
		getMemory: vi.fn(async (id: string) => (opts.get ? opts.get(id) : listRows.find((r) => r.id === id) ?? null)),
		// NOTE: `"key" in opts` distinguishes an EXPLICIT null ack (honest-failure tests) from "not provided".
		addMemory: vi.fn(async () => ("addAck" in opts ? opts.addAck : { id: "mem-new", action: "stored" })),
		modifyMemory: vi.fn(async () => ("modifyAck" in opts ? opts.modifyAck : { id: "mem-1", action: "modified", audited: true })),
		forgetMemory: vi.fn(async () => ("forgetAck" in opts ? opts.forgetAck : { id: "mem-1", action: "forgotten", audited: true })),
		compact: vi.fn(async () => ("compact" in opts ? opts.compact : null)),
		// PRD-058d: the lifecycle HEALTH panel now mounts on this page; its reads degrade to empty
		// (the panel renders its honest inert state) so the 040 suites are unaffected.
		lifecycleConflicts: vi.fn(async () => []),
		lifecycleStaleRefs: vi.fn(async () => []),
		lifecycleHistory: vi.fn(async () => []),
		resolveConflict: vi.fn(async () => true),
		calibration: vi.fn(async () => ({ ece: 0, brier: 0, nSamples: 0, fitAt: null, identity: true, reliabilityDiagram: [] })),
		pollinate: vi.fn(async () => opts.pollinate ?? { triggered: true, status: "enqueued" }),
		logs: vi.fn(async () => opts.logs ?? []),
		harnesses: vi.fn(),
		health: vi.fn(),
		vaultSettings: vi.fn(),
		setSetting: vi.fn(),
		secretNames: vi.fn(),
	} as unknown as WireClient;
}

function pageProps(wire: WireClient): PageProps {
	return { wire, daemonUp: true, assetBase: "assets", pollinating: false };
}

let container: HTMLDivElement;
let root: Root | undefined;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
});

afterEach(() => {
	if (root !== undefined) act(() => root.unmount());
	root = undefined;
	container.remove();
	vi.restoreAllMocks();
});

/** Flush pending microtasks so async hydrate/poll state settles. */
async function flush(): Promise<void> {
	await act(async () => {
		for (let i = 0; i < 8; i += 1) await Promise.resolve();
	});
}

/**
 * A scope context with an ACTIVE project selected — PRD-049e. The Memories page reads
 * `useScope().scope.project` (49e-AC-2/AC-5): with no project it renders the needs-selection state.
 * These 040 suites assert the populated page, so they mount under a provider with a project selected.
 */
const SCOPE_WITH_PROJECT: ScopeContextValue = {
	scope: { org: "acme", workspace: "backend", project: "api" },
	setScope: () => {},
};

async function mountPage(wire: WireClient): Promise<void> {
	await act(async () => {
		root = createRoot(container);
		root.render(
			<ScopeContext.Provider value={SCOPE_WITH_PROJECT}>
				<MemoriesPage {...pageProps(wire)} />
			</ScopeContext.Provider>,
		);
	});
	await flush();
}

/** Find a button by its exact text. */
function btn(text: string): HTMLButtonElement | undefined {
	return [...container.querySelectorAll("button")].find((b) => b.textContent === text);
}

async function click(el: Element | undefined): Promise<void> {
	await act(async () => el?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
	await flush();
}

/** Set a textarea/input value through React's onChange. */
async function setValue(el: HTMLTextAreaElement | HTMLInputElement | null, value: string): Promise<void> {
	if (el === null) return;
	const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
	const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
	setter?.call(el, value);
	await act(async () => el.dispatchEvent(new Event("input", { bubbles: true })));
	await flush();
}

/** Select an `<option>` value through React's onChange (the `change` event a select fires). */
async function setSelect(el: HTMLSelectElement | null, value: string): Promise<void> {
	if (el === null) return;
	const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
	setter?.call(el, value);
	await act(async () => el.dispatchEvent(new Event("change", { bubbles: true })));
	await flush();
}

// ─────────────────────────────────────────────────────────────────────────────
// 040a — browse
// ─────────────────────────────────────────────────────────────────────────────

describe("040a-AC-1: the page lists memories newest-first + honest empty state", () => {
	it("hydrates the browse list from wire.listMemories on mount", async () => {
		const wire = mockWire({ list: [rec({ id: "mem-1", content: "first fact" }), rec({ id: "mem-2", content: "second fact" })] });
		await mountPage(wire);
		expect(wire.listMemories).toHaveBeenCalled();
		const list = container.querySelector('[data-testid="memory-list"]');
		expect(list?.textContent).toContain("first fact");
		expect(list?.textContent).toContain("second fact");
		expect(container.querySelectorAll('[data-testid="memory-row"]')).toHaveLength(2);
	});

	it("an empty corpus shows the honest empty state", async () => {
		await mountPage(mockWire({ list: [] }));
		expect(container.textContent).toContain("No memories yet.");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 040a — search
// ─────────────────────────────────────────────────────────────────────────────

describe("040a-AC-2: search swaps the list for ranked hits + the lexical badge", () => {
	it("submitting a query POSTs recall and replaces the list with the ranked hits", async () => {
		const memories: RecalledMemory[] = [
			{ memoryKey: "deploy/x", snippet: "we deploy from prd-022", source: "memories", score: 0.42, scope: "team", verified: true, kind: "memory", secondary: false },
		];
		const wire = mockWire({ list: [rec({ content: "browse row" })], recall: { memories, degraded: false } });
		await mountPage(wire);
		await setValue(container.querySelector('input'), "how do we deploy");
		await click(btn("Search"));
		expect(wire.recall).toHaveBeenCalled();
		const results = container.querySelector('[data-testid="search-results"]');
		expect(results?.textContent).toContain("deploy/x");
		expect(results?.textContent).toContain("0.42");
		// The browse list is swapped out while a search is active.
		expect(container.querySelector('[data-testid="memory-list"]')).toBeNull();
	});

	it("shows the PRD-029 lexical-fallback badge on degraded:true and clearing restores the list", async () => {
		const wire = mockWire({ list: [rec({ content: "browse row" })], recall: { memories: [], degraded: true } });
		await mountPage(wire);
		await setValue(container.querySelector('input'), "anything");
		await click(btn("Search"));
		expect(container.textContent).toContain("lexical fallback");
		// Clear restores the browse list.
		await click(btn("Clear"));
		expect(container.querySelector('[data-testid="memory-list"]')?.textContent).toContain("browse row");
		expect(container.textContent).not.toContain("lexical fallback");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 040a — detail
// ─────────────────────────────────────────────────────────────────────────────

describe("040a-AC-3: detail renders content + metadata; forgotten id is honest", () => {
	it("clicking a row opens the detail with full content + OQ-1 metadata", async () => {
		const wire = mockWire({ list: [rec({ id: "mem-1", content: "the full content", version: 3, sourceType: "session", sourceId: "sess-9", hasEmbedding: true })] });
		await mountPage(wire);
		await click(container.querySelector('[data-testid="memory-row"]') ?? undefined);
		expect(wire.getMemory).toHaveBeenCalledWith("mem-1");
		const detail = container.querySelector('[data-testid="memory-detail"]');
		expect(detail).not.toBeNull();
		expect(detail?.textContent).toContain("the full content");
		// metadata: scope/source/version/embedding presence
		expect(detail?.textContent).toContain("global");
		expect(detail?.textContent).toContain("session");
		expect(detail?.textContent).toContain("sess-9");
		expect(detail?.textContent).toContain("3"); // version
		expect(detail?.textContent).toContain("yes (semantic)");
	});

	it("a forgotten/unknown id renders the honest 'forgotten' state, not a crash", async () => {
		const wire = mockWire({ list: [rec({ id: "gone" })], get: () => null });
		await mountPage(wire);
		await click(container.querySelector('[data-testid="memory-row"]') ?? undefined);
		expect(container.querySelector('[data-testid="memory-forgotten"]')).not.toBeNull();
		expect(container.textContent).toContain("forgotten");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 040a — XSS escaping
// ─────────────────────────────────────────────────────────────────────────────

describe("040a-AC-5: memory content renders as ESCAPED text (no injected markup)", () => {
	it("a content string with markup does not create DOM elements", async () => {
		const evil = "<img src=x onerror=alert(1)><script>alert(2)</script>";
		const wire = mockWire({ list: [rec({ id: "mem-1", content: evil })] });
		await mountPage(wire);
		await click(container.querySelector('[data-testid="memory-row"]') ?? undefined);
		const content = container.querySelector('[data-testid="memory-content"]');
		expect(content?.textContent).toContain(evil); // shown as literal text
		// The markup never became real elements.
		expect(content?.querySelector("img")).toBeNull();
		expect(content?.querySelector("script")).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 040b — add
// ─────────────────────────────────────────────────────────────────────────────

describe("040b-AC-1: add POSTs the store + re-lists (re-read, not optimistic)", () => {
	it("submitting the add form POSTs content and refreshes the list from the daemon", async () => {
		let listed: MemoryRecordWire[] = [];
		const wire = mockWire();
		// Drive a list that GROWS after the add — proving the page re-reads (not echoes the input).
		(wire.listMemories as ReturnType<typeof vi.fn>).mockImplementation(async () => listed);
		(wire.addMemory as ReturnType<typeof vi.fn>).mockImplementation(async () => {
			listed = [rec({ id: "mem-new", content: "added from daemon" })];
			return { id: "mem-new", action: "stored" };
		});
		await mountPage(wire);
		expect(container.textContent).toContain("No memories yet.");
		await setValue(container.querySelector('textarea[aria-label="new content"]'), "added from daemon");
		await click(btn("Add memory"));
		expect(wire.addMemory).toHaveBeenCalled();
		// The re-listed row appears (the daemon's truth), not just the local form value.
		expect(container.querySelector('[data-testid="memory-list"]')?.textContent).toContain("added from daemon");
	});

	it("an add failure surfaces honestly and stores nothing", async () => {
		const wire = mockWire({ list: [], addAck: null });
		await mountPage(wire);
		await setValue(container.querySelector('textarea[aria-label="new content"]'), "x");
		await click(btn("Add memory"));
		expect(container.querySelector('[data-testid="add-note"]')?.textContent).toContain("Add failed");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// memory-type taxonomy — the AddForm type dropdown (closed set)
// ─────────────────────────────────────────────────────────────────────────────

describe("memory-type taxonomy: the AddForm renders a closed-set <select> defaulting to fact", () => {
	it("renders a <select> with exactly the six MEMORY_TYPES, defaulting to fact", async () => {
		await mountPage(mockWire({ list: [] }));
		const select = container.querySelector<HTMLSelectElement>('[data-testid="add-type"]');
		expect(select, "the add form must render a type <select>").not.toBeNull();
		const options = [...(select?.querySelectorAll("option") ?? [])].map((o) => o.getAttribute("value"));
		expect(options).toEqual([...MEMORY_TYPES]);
		// Default selection is `fact`.
		expect(select?.value).toBe(DEFAULT_MEMORY_TYPE);
	});

	it("submits the chosen token (not free text) to wire.addMemory", async () => {
		const wire = mockWire({ list: [] });
		await mountPage(wire);
		await setValue(container.querySelector('textarea[aria-label="new content"]'), "an architectural choice");
		await setSelect(container.querySelector<HTMLSelectElement>('[data-testid="add-type"]'), "decision");
		await click(btn("Add memory"));
		expect(wire.addMemory).toHaveBeenCalledWith({ content: "an architectural choice", type: "decision" });
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 040b — edit
// ─────────────────────────────────────────────────────────────────────────────

describe("040b-AC-2/AC-3/AC-4: edit requires a reason, calls modify, re-reads (not optimistic)", () => {
	async function openEdit(wire: WireClient): Promise<void> {
		await mountPage(wire);
		await click(container.querySelector('[data-testid="memory-row"]') ?? undefined);
		await click(btn("Edit"));
	}

	it("an empty reason cannot submit (Save disabled until a reason is present)", async () => {
		const wire = mockWire({ list: [rec({ id: "mem-1", content: "original" })] });
		await openEdit(wire);
		const save = btn("Save new version");
		expect(save?.disabled).toBe(true);
		// Provide a reason → enabled.
		await setValue(container.querySelector('input[aria-label="edit reason"]'), "correcting a typo");
		expect(btn("Save new version")?.disabled).toBe(false);
	});

	it("saving calls modifyMemory (not a PUT/replace) and RE-READS the persisted value, not the form input", async () => {
		// The persisted re-read returns DIFFERENT content than the form typed — the UI must show the
		// re-read value (the daemon's truth), proving the page is not optimistic.
		const persisted = rec({ id: "mem-1", content: "DAEMON-NORMALIZED CONTENT", version: 2 });
		const wire = mockWire({ list: [rec({ id: "mem-1", content: "original" })], get: () => persisted });
		await openEdit(wire);
		await setValue(container.querySelector('input[aria-label="edit reason"]'), "a reason");
		await setValue(container.querySelector('textarea[aria-label="edit content"]'), "what the user typed");
		await click(btn("Save new version"));
		expect(wire.modifyMemory).toHaveBeenCalledWith("mem-1", { content: "what the user typed", reason: "a reason" });
		// The DETAIL now shows the RE-READ value, NOT the typed value.
		const content = container.querySelector('[data-testid="memory-content"]');
		expect(content?.textContent).toContain("DAEMON-NORMALIZED CONTENT");
		expect(content?.textContent).not.toContain("what the user typed");
	});

	it("AC-5 honest failure: a rejected edit leaves the unchanged persisted memory shown", async () => {
		const wire = mockWire({ list: [rec({ id: "mem-1", content: "original persisted" })], modifyAck: null, get: () => rec({ id: "mem-1", content: "original persisted" }) });
		await openEdit(wire);
		await setValue(container.querySelector('input[aria-label="edit reason"]'), "a reason");
		await setValue(container.querySelector('textarea[aria-label="edit content"]'), "rejected edit");
		await click(btn("Save new version"));
		expect(container.querySelector('[data-testid="detail-note"]')?.textContent).toContain("Save failed");
		// The persisted (unchanged) content is still what shows after the re-read.
		expect(container.querySelector('[data-testid="memory-content"]')?.textContent).toContain("original persisted");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 040b — forget (behind a confirm)
// ─────────────────────────────────────────────────────────────────────────────

describe("040b-OQ-1: forget is behind an explicit confirm", () => {
	it("forget requires a confirm before it calls forgetMemory", async () => {
		const wire = mockWire({ list: [rec({ id: "mem-1" })] });
		await mountPage(wire);
		await click(container.querySelector('[data-testid="memory-row"]') ?? undefined);
		await click(btn("Forget"));
		// Not yet called — only the confirm affordance appeared.
		expect(wire.forgetMemory).not.toHaveBeenCalled();
		expect(container.textContent).toContain("soft-deletes");
		await click(btn("Confirm forget"));
		expect(wire.forgetMemory).toHaveBeenCalledWith("mem-1", { reason: expect.any(String) });
		// Back to the list (the memory is now a tombstone → detail closed).
		expect(container.querySelector('[data-testid="memory-detail"]')).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 040c — compact
// ─────────────────────────────────────────────────────────────────────────────

describe("040c-AC-1: compact behind a confirm renders the honest per-table summary", () => {
	it("confirms, POSTs compact, and renders the per-table summary incl. errored → 'attempted'", async () => {
		const summary: CompactSummaryWire = {
			ok: true,
			summaries: [
				{ table: "skills", keysScanned: 12, keysCompacted: 12, rowsReaped: 30, keysSkipped: 0, errored: 0 },
				{ table: "rules", keysScanned: 4, keysCompacted: 0, rowsReaped: 0, keysSkipped: 0, errored: 1 },
			],
			skippedTables: ["entity_attributes"],
		};
		const wire = mockWire({ list: [], compact: summary });
		await mountPage(wire);
		await click(btn("Compact"));
		expect(wire.compact).not.toHaveBeenCalled(); // confirm first
		expect(container.textContent).toContain("prunes old memory versions");
		await click(btn("Confirm compact"));
		expect(wire.compact).toHaveBeenCalled();
		const out = container.querySelector('[data-testid="compact-summary"]');
		expect(out?.textContent).toContain("skills");
		expect(out?.textContent).toContain("30 rows reaped");
		expect(out?.textContent).toContain("rules: attempted, not completed");
		expect(out?.textContent).toContain("entity_attributes");
	});

	it("a null compact result never crashes (compaction unavailable)", async () => {
		const wire = mockWire({ list: [], compact: null });
		await mountPage(wire);
		await click(btn("Compact"));
		await click(btn("Confirm compact"));
		// No throw; the summary block simply does not render a per-table line.
		expect(container.querySelector('[data-testid="compact-summary"]')).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 040c — pollinate (three honest ack shapes, no spinner)
// ─────────────────────────────────────────────────────────────────────────────

describe("040c-AC-2: pollinate reflects the three ack shapes honestly (no fake spinner)", () => {
	async function pollinateWith(ack: PollinateAck): Promise<string> {
		if (root !== undefined) {
			act(() => root?.unmount());
			root = undefined;
		}
		const wire = mockWire({ list: [], pollinate: ack });
		await mountPage(wire);
		await click(btn("Pollinate now"));
		return container.querySelector('[data-testid="pollinate-note"]')?.textContent ?? "";
	}

	it("enqueued → consolidating; running → already running; skipped → skipped · reason", async () => {
		expect(await pollinateWith({ triggered: true, status: "enqueued" })).toContain("consolidating");
		expect(await pollinateWith({ triggered: true, status: "running", reason: "in flight" })).toContain("already running");
		const skipped = await pollinateWith({ triggered: false, status: "skipped", reason: "disabled" });
		expect(skipped).toContain("skipped");
		expect(skipped).toContain("disabled");
		// A !triggered ack never leaves a permanent "pollinating…" spinner — the button is enabled again.
		expect(btn("Pollinate now")?.disabled).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// 040c — watch (poll + filter + stop)
// ─────────────────────────────────────────────────────────────────────────────

describe("040c-AC-3: watch polls /api/logs filtered to memory routes, and stops on toggle-off", () => {
	it("toggling watch polls logs, filters to memory routes, and stop clears the feed", async () => {
		const logs: LogRecordWire[] = [
			{ time: "2026-06-20T14:32:08.000Z", method: "GET", path: "/api/memories", status: 200 },
			{ time: "2026-06-20T14:32:09.000Z", method: "GET", path: "/api/diagnostics/kpis", status: 200 }, // filtered OUT
			{ time: "2026-06-20T14:32:10.000Z", method: "POST", path: "/api/diagnostics/pollinate", status: 202 },
		];
		const wire = mockWire({ list: [], logs });
		await mountPage(wire);
		await click(btn("Watch"));
		const feed = container.querySelector('[data-testid="watch-feed"]');
		expect(wire.logs).toHaveBeenCalled();
		expect(feed?.textContent).toContain("/api/memories");
		expect(feed?.textContent).toContain("/api/diagnostics/pollinate");
		// The non-memory route is filtered out.
		expect(feed?.textContent).not.toContain("/api/diagnostics/kpis");
		// Stop clears the interval + the feed disappears.
		await click(btn("Stop watch"));
		expect(container.querySelector('[data-testid="watch-feed"]')).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-5 — no secret leaks
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-5: no token/secret renders anywhere on the page", () => {
	it("no token/secret/bearer/authorization/password appears across list/detail/compact/pollinate/watch", async () => {
		const summary: CompactSummaryWire = { ok: true, summaries: [{ table: "skills", keysScanned: 1, keysCompacted: 1, rowsReaped: 1, keysSkipped: 0, errored: 0 }], skippedTables: [] };
		const logs: LogRecordWire[] = [{ time: "2026-06-20T14:32:08.000Z", method: "GET", path: "/api/memories", status: 200 }];
		const wire = mockWire({ list: [rec({ content: "a benign fact" })], compact: summary, pollinate: { triggered: true, status: "enqueued" }, logs });
		await mountPage(wire);
		await click(btn("Compact"));
		await click(btn("Confirm compact"));
		await click(btn("Pollinate now"));
		await click(btn("Watch"));
		const text = (container.textContent ?? "").toLowerCase();
		for (const needle of ["token", "secret", "bearer", "authorization", "password"]) {
			expect(text).not.toContain(needle);
		}
	});
});
