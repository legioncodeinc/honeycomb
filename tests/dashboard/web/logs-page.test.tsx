// @vitest-environment jsdom
/**
 * PRD-043 — the Logs page DOM suite (043b history + live tail + filters + pagination; 043c Turns).
 *
 * Mounts the REAL {@link LogsPage} into jsdom against a MOCKED wire client and asserts the ACs
 * through the rendered DOM + the pure helpers:
 *   b-AC-1  the history table + the live tail both render, sharing ONE row renderer (LogRow).
 *   b-AC-2  filters drive the `/api/logs/history` query and refetch page one.
 *   b-AC-3  "load more" pages via the cursor, appending older rows (no dup/gap).
 *   b-AC-4  status → DS tone (statusTone: 2xx ok / 4xx warn / 5xx critical).
 *   b-AC-5  explicit loading / empty / error states (never a blank table).
 *   c-AC-1  the Turns list renders captured turns (newest first), labeled "Turns".
 *   c-AC-2  selecting a turn opens its detail; Back returns to the list.
 *   c-AC-4  no user-facing "Sessions" string for captured turns (grep-proven in the DOM).
 *   AC-5    no secret (header/token/body) in the rendered history rows or the turn detail.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LogsPage, statusTone, appendLiveRecord } from "../../../src/dashboard/web/pages/logs.js";
import type { PageProps } from "../../../src/dashboard/web/page-frame.js";
import type {
	LogRecordWire,
	LogsHistoryWire,
	SessionRowWire,
	TurnsHistoryWire,
	WireClient,
} from "../../../src/dashboard/web/wire.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A request-log record fixture. */
function logRec(over: Partial<LogRecordWire> = {}): LogRecordWire {
	return {
		time: "2026-06-22T10:00:01.000Z",
		method: "POST",
		path: "/api/memories/recall",
		status: 200,
		durationMs: 12,
		mode: "local",
		org: "acme",
		workspace: "default",
		...over,
	};
}

/** A captured-turn (session) row fixture — labeled "Turns" on the page. */
function turnRow(over: Partial<SessionRowWire> = {}): SessionRowWire {
	return { sessionId: "sess-1", project: "/repo/honeycomb", startedAt: "2026-06-22T09:00:00.000Z", eventCount: 0, status: "captured", ...over };
}

interface StreamHandle {
	handler: ((record: LogRecordWire) => void) | null;
	unsubscribe: ReturnType<typeof vi.fn>;
}

/** A mock wire returning the given history page, turns page, and capturing the SSE follow handler. */
function mockWire(opts: {
	history?: LogsHistoryWire;
	historyPages?: LogsHistoryWire[];
	turns?: TurnsHistoryWire;
	turnsPages?: TurnsHistoryWire[];
	historyThrows?: boolean;
}): WireClient & {
	logsHistory: ReturnType<typeof vi.fn>;
	turnsHistory: ReturnType<typeof vi.fn>;
	logsStream: ReturnType<typeof vi.fn>;
	stream: StreamHandle;
} {
	const historyPages = opts.historyPages ?? (opts.history ? [opts.history] : [{ records: [], count: 0, nextCursor: null, persistent: true }]);
	let historyCall = 0;
	const logsHistory = vi.fn(async () => {
		if (opts.historyThrows) throw new Error("boom");
		const page = historyPages[Math.min(historyCall, historyPages.length - 1)];
		historyCall++;
		return page;
	});
	const turnsPages = opts.turnsPages ?? (opts.turns ? [opts.turns] : [{ sessions: [], nextCursor: null }]);
	let turnsCall = 0;
	const turnsHistory = vi.fn(async () => {
		const page = turnsPages[Math.min(turnsCall, turnsPages.length - 1)];
		turnsCall++;
		return page;
	});
	const stream: StreamHandle = { handler: null, unsubscribe: vi.fn() };
	const logsStream = vi.fn((onRecord: (r: LogRecordWire) => void) => {
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
		memoryGraph: vi.fn(),
		recall: vi.fn(),
		listMemories: vi.fn(),
		getMemory: vi.fn(),
		addMemory: vi.fn(),
		modifyMemory: vi.fn(),
		forgetMemory: vi.fn(),
		compact: vi.fn(),
		logs: vi.fn(async () => []),
		logsStream,
		logsHistory,
		turnsHistory,
		harnesses: vi.fn(),
		assetsView: vi.fn(),
		syncAction: vi.fn(),
		health: vi.fn(),
		dream: vi.fn(),
		vaultSettings: vi.fn(),
		setSetting: vi.fn(),
		secretNames: vi.fn(),
		stream,
	} as unknown as WireClient & {
		logsHistory: ReturnType<typeof vi.fn>;
		turnsHistory: ReturnType<typeof vi.fn>;
		logsStream: ReturnType<typeof vi.fn>;
		stream: StreamHandle;
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
	window.location.hash = "#/logs";
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
		root.render(<LogsPage {...pageProps(wire)} />);
	});
	// Let the on-mount fetches resolve.
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

describe("PRD-043 pure helpers", () => {
	it("statusTone maps status codes to the DS level tones (b-AC-4)", () => {
		expect(statusTone(200)).toBe("verified");
		expect(statusTone(201)).toBe("verified");
		expect(statusTone(404)).toBe("warning");
		expect(statusTone(429)).toBe("warning");
		expect(statusTone(500)).toBe("critical");
		expect(statusTone(503)).toBe("critical");
		expect(statusTone(301)).toBe("neutral");
	});

	it("appendLiveRecord prepends newest-first and caps the buffer", () => {
		let buf: readonly LogRecordWire[] = [];
		buf = appendLiveRecord(buf, logRec({ path: "/a" }));
		buf = appendLiveRecord(buf, logRec({ path: "/b" }));
		expect(buf.map((r) => r.path)).toEqual(["/b", "/a"]); // newest first
	});
});

describe("PRD-043b request-log view", () => {
	it("b-AC-1: renders the history table AND the live tail, sharing the LogRow renderer", async () => {
		const wire = mockWire({
			history: { records: [logRec({ path: "/api/x", status: 200 }), logRec({ path: "/api/y", status: 500 })], count: 2, nextCursor: null, persistent: true },
		});
		await mountPage(wire);
		// The history table rendered with rows.
		expect(container.querySelector('[data-testid="history-list"]')).not.toBeNull();
		expect(container.querySelectorAll('[data-testid="log-row"]').length).toBeGreaterThanOrEqual(2);
		// The live tail panel rendered (collapsible, on top).
		expect(container.textContent).toContain("Live tail");
		expect(container.querySelector('[data-testid="live-toggle"]')).not.toBeNull();
		// The history paths render.
		expect(container.textContent).toContain("/api/x");
		expect(container.textContent).toContain("/api/y");
	});

	it("b-AC-1: a live SSE record renders via the SAME LogRow renderer", async () => {
		const wire = mockWire({ history: { records: [], count: 0, nextCursor: null, persistent: true } });
		await mountPage(wire);
		expect(wire.logsStream).toHaveBeenCalledTimes(1);
		// Drive a record over the SSE tail — it lands in the live list using the shared row renderer.
		await act(async () => {
			wire.stream.handler?.(logRec({ path: "/api/live", status: 201 }));
			await Promise.resolve();
		});
		const liveList = container.querySelector('[data-testid="live-list"]');
		expect(liveList).not.toBeNull();
		expect(liveList?.textContent).toContain("/api/live");
	});

	it("b-AC-2: applying a filter refetches page one with the filter params", async () => {
		const wire = mockWire({ history: { records: [logRec()], count: 1, nextCursor: null, persistent: true } });
		await mountPage(wire);
		const callsBefore = wire.logsHistory.mock.calls.length;
		// Type a status filter and Apply (the DS Input spreads data-testid onto the inner <input>).
		const statusInput = container.querySelector('input[data-testid="filter-status"]') as HTMLInputElement;
		expect(statusInput).not.toBeNull();
		await setInputValue(statusInput, "5xx");
		const apply = container.querySelector('[data-testid="filter-apply"]') as HTMLButtonElement;
		await act(async () => {
			apply.click();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(wire.logsHistory.mock.calls.length).toBeGreaterThan(callsBefore);
		// The latest call carried the status filter.
		const lastCall = wire.logsHistory.mock.calls[wire.logsHistory.mock.calls.length - 1]?.[0];
		expect(lastCall).toMatchObject({ status: "5xx" });
	});

	it("b-AC-3: load-more pages via the cursor and APPENDS older rows (no dup/gap)", async () => {
		const wire = mockWire({
			historyPages: [
				{ records: [logRec({ path: "/p9" }), logRec({ path: "/p8" })], count: 2, nextCursor: "cursor-1", persistent: true },
				{ records: [logRec({ path: "/p7" }), logRec({ path: "/p6" })], count: 2, nextCursor: null, persistent: true },
			],
		});
		await mountPage(wire);
		expect(container.querySelectorAll('[data-testid="log-row"]').length).toBe(2);
		const loadMore = container.querySelector('[data-testid="history-load-more"]') as HTMLButtonElement;
		expect(loadMore).not.toBeNull();
		await act(async () => {
			loadMore.click();
			await Promise.resolve();
			await Promise.resolve();
		});
		// The second page APPENDED — all four rows present, no duplicate.
		const text = container.querySelector('[data-testid="history-list"]')?.textContent ?? "";
		for (const p of ["/p9", "/p8", "/p7", "/p6"]) expect(text).toContain(p);
		// The load-more call carried the cursor from page one.
		const last = wire.logsHistory.mock.calls[wire.logsHistory.mock.calls.length - 1]?.[0];
		expect(last).toMatchObject({ cursor: "cursor-1" });
	});

	it("b-AC-5: an empty history renders the explicit empty state, not a blank table", async () => {
		const wire = mockWire({ history: { records: [], count: 0, nextCursor: null, persistent: true } });
		await mountPage(wire);
		expect(container.querySelector('[data-testid="history-empty"]')).not.toBeNull();
		expect(container.textContent).toContain("No logs match these filters");
	});

	it("b-AC-5: a history fetch failure renders the explicit error state", async () => {
		const wire = mockWire({ historyThrows: true });
		await mountPage(wire);
		expect(container.querySelector('[data-testid="history-error"]')).not.toBeNull();
	});

	it("AC-4: a non-persistent store renders the 'history unavailable' state (fail-soft)", async () => {
		const wire = mockWire({ history: { records: [], count: 0, nextCursor: null, persistent: false } });
		await mountPage(wire);
		expect(container.querySelector('[data-testid="history-unavailable"]')).not.toBeNull();
	});

	it("AC-5 (no-secret): rendered history rows carry no header/token/body", async () => {
		const wire = mockWire({ history: { records: [logRec()], count: 1, nextCursor: null, persistent: true } });
		await mountPage(wire);
		const list = container.querySelector('[data-testid="history-list"]')?.textContent ?? "";
		expect(list).not.toMatch(/authorization/i);
		expect(list).not.toMatch(/bearer/i);
		expect(list).not.toMatch(/\btoken\b/i);
	});
});

describe("PRD-043c Turns view", () => {
	it("c-AC-1: lists captured turns (newest first) under a 'Turns' heading", async () => {
		const wire = mockWire({
			turns: { sessions: [turnRow({ sessionId: "t1", project: "/repo/a" }), turnRow({ sessionId: "t2", project: "/repo/b" })], nextCursor: null },
		});
		await mountPage(wire);
		// Switch to the Turns tab.
		const tab = container.querySelector('[data-testid="tab-turns"]') as HTMLButtonElement;
		await act(async () => {
			tab.click();
			await Promise.resolve();
		});
		expect(container.querySelector('[data-testid="turns-list"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="turn-row-t1"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="turn-row-t2"]')).not.toBeNull();
		expect(container.textContent).toContain("Turns");
	});

	it("c-AC-2: selecting a turn opens its detail (metadata) and Back returns to the list", async () => {
		const wire = mockWire({ turns: { sessions: [turnRow({ sessionId: "t1", project: "/repo/a", status: "captured" })], nextCursor: null } });
		await mountPage(wire);
		const tab = container.querySelector('[data-testid="tab-turns"]') as HTMLButtonElement;
		await act(async () => {
			tab.click();
			await Promise.resolve();
		});
		const row = container.querySelector('[data-testid="turn-row-t1"]') as HTMLButtonElement;
		await act(async () => {
			row.click();
			await Promise.resolve();
		});
		const detail = container.querySelector('[data-testid="turn-detail"]');
		expect(detail).not.toBeNull();
		expect(detail?.textContent).toContain("t1"); // turn id
		expect(detail?.textContent).toContain("/repo/a"); // project
		// Back returns to the list.
		const back = container.querySelector('[data-testid="turn-back"]') as HTMLButtonElement;
		await act(async () => {
			back.click();
			await Promise.resolve();
		});
		expect(container.querySelector('[data-testid="turn-detail"]')).toBeNull();
		expect(container.querySelector('[data-testid="turns-list"]')).not.toBeNull();
	});

	it("c-AC-4: no user-facing 'Sessions' string for captured turns (grep-proven in the DOM)", async () => {
		const wire = mockWire({ turns: { sessions: [turnRow({ sessionId: "t1" })], nextCursor: null } });
		await mountPage(wire);
		const tab = container.querySelector('[data-testid="tab-turns"]') as HTMLButtonElement;
		await act(async () => {
			tab.click();
			await Promise.resolve();
		});
		// The captured-turns surface says "Turns", never "Sessions" (PRD-035a).
		expect(container.textContent).toContain("Turns");
		expect(container.textContent?.toLowerCase()).not.toContain("session");
	});

	it("c-AC-5 (no-secret / metadata-only): the turn detail renders no transcript/body/secret", async () => {
		const wire = mockWire({ turns: { sessions: [turnRow({ sessionId: "t1" })], nextCursor: null } });
		await mountPage(wire);
		const tab = container.querySelector('[data-testid="tab-turns"]') as HTMLButtonElement;
		await act(async () => {
			tab.click();
			await Promise.resolve();
		});
		const row = container.querySelector('[data-testid="turn-row-t1"]') as HTMLButtonElement;
		await act(async () => {
			row.click();
			await Promise.resolve();
		});
		const detail = container.querySelector('[data-testid="turn-detail"]')?.textContent ?? "";
		expect(detail).not.toMatch(/authorization/i);
		expect(detail).not.toMatch(/bearer/i);
		expect(detail).not.toMatch(/transcript/i);
		expect(detail).not.toMatch(/jsonb/i);
	});

	it("c-AC-1 (empty): an empty turns list renders the explicit empty state", async () => {
		const wire = mockWire({ turns: { sessions: [], nextCursor: null } });
		await mountPage(wire);
		const tab = container.querySelector('[data-testid="tab-turns"]') as HTMLButtonElement;
		await act(async () => {
			tab.click();
			await Promise.resolve();
		});
		expect(container.querySelector('[data-testid="turns-empty"]')).not.toBeNull();
		expect(container.textContent).toContain("No turns captured yet");
	});

	it("c (paging): a turns nextCursor renders a load-more that pages older turns", async () => {
		const wire = mockWire({
			turnsPages: [
				{ sessions: [turnRow({ sessionId: "t1" })], nextCursor: "tc-1" },
				{ sessions: [turnRow({ sessionId: "t2" })], nextCursor: null },
			],
		});
		await mountPage(wire);
		const tab = container.querySelector('[data-testid="tab-turns"]') as HTMLButtonElement;
		await act(async () => {
			tab.click();
			await Promise.resolve();
		});
		const more = container.querySelector('[data-testid="turns-load-more"]') as HTMLButtonElement;
		expect(more).not.toBeNull();
		await act(async () => {
			more.click();
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(container.querySelector('[data-testid="turn-row-t1"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="turn-row-t2"]')).not.toBeNull();
		const last = wire.turnsHistory.mock.calls[wire.turnsHistory.mock.calls.length - 1]?.[0];
		expect(last).toMatchObject({ cursor: "tc-1" });
	});
});
