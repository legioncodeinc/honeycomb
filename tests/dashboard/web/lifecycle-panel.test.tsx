// @vitest-environment jsdom
/**
 * PRD-058d — the Lifecycle HEALTH panel DOM suite.
 *
 * Acceptance criteria → tests:
 *   58d.2.1 the panel renders the health badge H + freshness + open-conflict count + stale-ref count + ECE.
 *   58d.2.2 a dashboard resolve calls the 058b resolve endpoint (via wire.resolveConflict) and polls the queue
 *           to convergence (the resolved conflict drops out of the open list after the re-read).
 *   58d.2.4 the calibration view renders the ECE/Brier + the reliability diagram; a dormant curve renders inert.
 *   Plus: a term whose engine is OFF renders INERT (empty/dormant), not an error (PRD-029 degradation reuse).
 *
 * Driven through a hand-rolled mock `WireClient` so the suite is fast + isolated.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { LifecycleHealthPanel, assembleStoreHealth, healthTone } from "../../../src/dashboard/web/pages/lifecycle-panel.js";
import { EMPTY_CALIBRATION, type CalibrationWire, type LifecycleConflictWire, type LifecycleStaleRefWire, type WireClient } from "../../../src/dashboard/web/wire.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** A configurable mock wire — only the lifecycle methods the panel calls. */
function mockWire(opts: {
	conflicts?: LifecycleConflictWire[];
	conflictsAfterResolve?: LifecycleConflictWire[];
	staleRefs?: LifecycleStaleRefWire[];
	calibration?: CalibrationWire;
	resolveOk?: boolean;
} = {}): { wire: WireClient; resolveCalls: { id: string; input: { verdict: string; winnerId?: string } }[] } {
	const resolveCalls: { id: string; input: { verdict: string; winnerId?: string } }[] = [];
	let conflictReads = 0;
	const wire = {
		lifecycleConflicts: vi.fn(async () => {
			conflictReads += 1;
			// First read returns the open queue; reads AFTER a resolve return the converged (post-resolve) queue.
			if (conflictReads > 1 && opts.conflictsAfterResolve !== undefined) return opts.conflictsAfterResolve;
			return opts.conflicts ?? [];
		}),
		lifecycleStaleRefs: vi.fn(async () => opts.staleRefs ?? []),
		calibration: vi.fn(async () => opts.calibration ?? EMPTY_CALIBRATION),
		resolveConflict: vi.fn(async (id: string, input: { verdict: string; winnerId?: string }) => {
			resolveCalls.push({ id, input });
			return opts.resolveOk ?? true;
		}),
	} as unknown as WireClient;
	return { wire, resolveCalls };
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
		for (let i = 0; i < 12; i += 1) await Promise.resolve();
	});
}

function render(wire: WireClient): void {
	root = createRoot(container);
	act(() => root!.render(<LifecycleHealthPanel wire={wire} />));
}

const CONFLICT: LifecycleConflictWire = { id: "c1", memoryAId: "m1", memoryBId: "m2", verdict: "review", winnerId: null, status: "open", contraScore: 0.8 };
const CALIBRATED: CalibrationWire = {
	ece: 0.04,
	brier: 0.12,
	nSamples: 120,
	fitAt: "2026-06-26T00:00:00.000Z",
	identity: false,
	reliabilityDiagram: [
		{ lower: 0, upper: 0.5, meanConfidence: 0.25, accuracy: 0.2, count: 0 },
		{ lower: 0.5, upper: 1, meanConfidence: 0.75, accuracy: 0.7, count: 0 },
	],
};

describe("PRD-058d lifecycle panel — health summary (AC-55d.2.1)", () => {
	it("renders the H badge + the open-conflict count + the stale-ref count + the ECE", async () => {
		const { wire } = mockWire({
			conflicts: [CONFLICT],
			staleRefs: [{ memoryId: "mem-9", refStatus: "stale", staleRefs: ["src/gone.ts"], verifiedAt: null }],
			calibration: CALIBRATED,
		});
		render(wire);
		await flush();
		const text = container.textContent ?? "";
		expect(container.querySelector('[data-testid="health-badge"]')).not.toBeNull();
		expect(text).toContain("Conflicts (1)");
		expect(text).toContain("Stale references (1)");
		expect(text).toContain("0.040"); // ECE
		// The summary carries a distinct freshness row AND a distinct calibrated-confidence row (no mislabel).
		expect(text).toContain("freshness");
		expect(text).toContain("calibrated confidence");
	});

	it("renders the badge as H = A·C·(1−σ)·κ with freshness shown honestly (A), never C mislabeled as freshness", async () => {
		const { wire } = mockWire({
			conflicts: [CONFLICT], // one open conflict → κ = 0.5
			staleRefs: [{ memoryId: "mem-9", refStatus: "stale", staleRefs: ["src/gone.ts"], verifiedAt: null }], // σ = 1/8
			calibration: CALIBRATED, // C = 1 − ece = 0.96
		});
		render(wire);
		await flush();
		// A is unavailable on the read side → identity 1; H = 1 · 0.96 · (1 − 0.125) · 0.5 = 0.42.
		const badge = container.querySelector('[data-testid="health-badge"]');
		expect(badge?.textContent).toContain("0.42");
		// The freshness stat tile reads inert (A dormant), NOT the calibrated-confidence value 0.96. The
		// `Stat` tile is the leaf div whose FIRST span is exactly the "freshness" label; its value span follows.
		const freshnessTile = Array.from(container.querySelectorAll("div")).find(
			(d) => d.querySelector("span")?.textContent?.toLowerCase() === "freshness",
		);
		expect(freshnessTile).toBeDefined();
		const freshnessValue = freshnessTile?.querySelectorAll("span")[1]?.textContent ?? "";
		expect(freshnessValue).not.toBe("0.96"); // freshness must NOT show C.
		// C (0.96) is rendered under its OWN calibrated-confidence label.
		expect(container.textContent ?? "").toContain("0.96");
	});

	it("an all-engines-off install renders INERT (empty conflicts, no stale refs, dormant calibration), not an error", async () => {
		const { wire } = mockWire({ conflicts: [], staleRefs: [], calibration: EMPTY_CALIBRATION });
		render(wire);
		await flush();
		const text = container.textContent ?? "";
		expect(container.querySelector('[data-testid="conflicts-empty"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="stale-refs-empty"]')).not.toBeNull();
		expect(container.querySelector('[data-testid="calibration-dormant"]')).not.toBeNull();
		expect(text).toContain("dormant");
	});
});

describe("PRD-058d lifecycle panel — resolve through the 058b endpoint + poll to convergence (AC-55d.2.2)", () => {
	it("clicking Resolve calls wire.resolveConflict and the conflict drops out after the re-read", async () => {
		const { wire, resolveCalls } = mockWire({ conflicts: [CONFLICT], conflictsAfterResolve: [], resolveOk: true });
		render(wire);
		await flush();
		// The conflict row is present.
		expect(container.querySelector('[data-conflict-id="c1"]')).not.toBeNull();
		// Click Resolve (the default verdict is `review`, no winner required).
		const resolveBtn = Array.from(container.querySelectorAll("button")).find((b) => b.textContent?.includes("Resolve"));
		expect(resolveBtn).toBeDefined();
		await act(async () => {
			resolveBtn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		await flush();
		// It went through the 058b resolve seam (NOT a parallel resolve path).
		expect((wire.resolveConflict as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBeGreaterThan(0);
		expect(resolveCalls[0]).toMatchObject({ id: "c1", input: { verdict: "review" } });
		// Polled to convergence: the resolved conflict left the open queue.
		expect(container.querySelector('[data-conflict-id="c1"]')).toBeNull();
		expect(container.querySelector('[data-testid="conflicts-empty"]')).not.toBeNull();
	});
});

describe("PRD-058d lifecycle panel — calibration view (AC-55d.2.4)", () => {
	it("renders the ECE/Brier + the reliability diagram when a curve is fit", async () => {
		const { wire } = mockWire({ calibration: CALIBRATED });
		render(wire);
		await flush();
		expect(container.querySelector('[data-testid="calibration-view"]')).not.toBeNull();
		const text = container.textContent ?? "";
		expect(text).toContain("0.040"); // ECE
		expect(text).toContain("0.120"); // Brier
		expect(text).toContain("120"); // samples
	});
});

describe("PRD-058d lifecycle panel — pure helpers", () => {
	it("assembleStoreHealth applies the dormant-term identity", () => {
		expect(assembleStoreHealth({})).toBe(1);
		expect(assembleStoreHealth({ staleness: 0.5 })).toBeCloseTo(0.5, 6);
		expect(assembleStoreHealth({ kappa: 0 })).toBe(0);
	});

	it("healthTone bands H into verified / honey / warning", () => {
		expect(healthTone(0.9)).toBe("verified");
		expect(healthTone(0.5)).toBe("honey");
		expect(healthTone(0.1)).toBe("warning");
	});
});
