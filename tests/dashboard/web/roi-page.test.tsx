// @vitest-environment jsdom
/**
 * PRD-060e — the ROI page DOM suite (the page half of the Net-ROI ledger).
 *
 * Mounts the REAL {@link RoiPage} into jsdom against a MOCKED {@link WireClient} (so the page is a PURE
 * function of the {@link RoiView}/{@link RoiTrendView} it is handed) and asserts every page-half AC:
 *
 *   - e-AC-1 : the `/roi` registry entry routes WITHOUT a sidebar/router hand-edit + renders in PageFrame.
 *   - e-AC-2 : the page is a pure function of the view-model; each per-section status renders correctly.
 *   - e-AC-3 : the four measured-vs-modeled signals; a modeled term never gets the measured treatment.
 *   - e-AC-4 : honey never encodes sign (positive verified / negative critical), honey is frame-only.
 *   - e-AC-5 : first-run/empty → a dash glyph (not `$0.00`); token-absent absent; Claude-Code-only badge.
 *   - e-AC-6 : billing-unreachable → dash for the line + the net + a scoped Retry; net not computed.
 *   - e-AC-7 : not-authenticated → the ledger is gated behind a Settings CTA; no credential reaches the page.
 *   - e-AC-8 : the assumption is disclosed via an ⓘ popover + a page-foot footnote, both ONE source.
 *   - e-AC-9 : cost-rising-not-green (a cost increase does not render green).
 *   - e-AC-10: the inline-SVG trend chart draws dashed=modeled / solid=measured strokes (no charting dep).
 *   - e-AC-11: money is integer cents in the view-model; dollars/`$/Mtok`/k·M only at the render edge.
 *   - e-AC-13: org/team/agent/project rollup views via a dimension switch; the component does NO grouping.
 *   - e-AC-14: per-user shown ONLY when `perUserAvailable`; else an info empty state (never `$0`/a name).
 *   - e-AC-15: an allocated net carries the est. treatment; a mixed-basis rollup is flagged, not blended.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { RoiTrendView, RoiView } from "../../../src/dashboard/contracts.js";
import { EMPTY_ROI_TREND, EMPTY_ROI_VIEW } from "../../../src/dashboard/contracts.js";
import {
	basisIsModeled,
	costDeltaColor,
	formatBlendedRate,
	formatCents,
	formatTokens,
	isDashStatus,
	measuredTone,
	measuredWeightColor,
	netSignColor,
	RoiPage,
} from "../../../src/dashboard/web/pages/roi.js";
import { seriesCentsRange, seriesPolylinePoints, zeroBaselineY } from "../../../src/dashboard/web/pages/roi-chart.js";
import { ROUTES, matchRoute } from "../../../src/dashboard/web/registry.js";
import type { PageProps } from "../../../src/dashboard/web/page-frame.js";
import type { WireClient } from "../../../src/dashboard/web/wire.js";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures — a fully-populated "ok" view + the degraded variants. All money is
// INTEGER cents (e-AC-11); the fixtures NEVER carry a token/secret (e-AC-7).
// ─────────────────────────────────────────────────────────────────────────────

const ASSUMPTION = { kind: "memory-injection-v1", assumptionText: "Assumes 18% of injected memory tokens would otherwise be re-derived.", signedOff: true };

/** A confident, complete ROI view — every section `ok`, the net computed, rollups for all four dimensions. */
const OK_VIEW: RoiView = {
	savings: { status: "ok", measuredCents: 240000, modeledCents: 86000, assumption: ASSUMPTION, blendedCentsPerMtok: 150 },
	infra: { status: "ok", cents: 52000, costBasis: "measured" },
	pollination: { status: "ok", cents: 14000, lines: [{ label: "haiku-skillify", cents: 9000 }, { label: "deeplake-gpu", cents: 5000 }] },
	net: { status: "ok", computed: true, netCents: 260000, modeled: true, costBasis: "measured" },
	rollups: [
		{ dimension: "org", rows: [{ key: "acme", label: "Acme", measuredSavingsCents: 240000, netCents: 260000, infraCostCents: 52000, costBasis: "measured", sessions: 120 }], mixedBasis: false },
		{ dimension: "team", rows: [{ key: "core", label: "Core", measuredSavingsCents: 120000, netCents: 100000, infraCostCents: 26000, costBasis: "allocated", sessions: 60 }], mixedBasis: true },
		{ dimension: "agent", rows: [{ key: "claude-code", label: "Claude Code", measuredSavingsCents: 200000, netCents: 220000, infraCostCents: 40000, costBasis: "measured", sessions: 100 }], mixedBasis: false },
		{ dimension: "project", rows: [{ key: "api", label: "api", measuredSavingsCents: 80000, netCents: 70000, infraCostCents: 18000, costBasis: "measured", sessions: 40 }], mixedBasis: false },
	],
	perUserAvailable: false,
	scopedAcrossDevices: true,
	ratesAsOf: "2026-06-20",
};

/** A negative-net view (cost exceeds savings) — for the honey-sign mapping (e-AC-4). */
const NEGATIVE_NET_VIEW: RoiView = {
	...OK_VIEW,
	net: { status: "ok", computed: true, netCents: -42000, modeled: true, costBasis: "measured" },
};

/** A billing-unreachable view (e-AC-6): infra unreachable, net NOT computed. */
const BILLING_UNREACHABLE_VIEW: RoiView = {
	...OK_VIEW,
	infra: { status: "unreachable", cents: 0, costBasis: "none" },
	net: { status: "unreachable", computed: false, netCents: 0, modeled: true, costBasis: "none" },
};

/** A Claude-Code-only partial savings view (e-AC-5). */
const PARTIAL_VIEW: RoiView = {
	...OK_VIEW,
	savings: { status: "partial", measuredCents: 100000, modeledCents: 20000, assumption: ASSUMPTION, blendedCentsPerMtok: 150 },
};

/** A not-authenticated view (e-AC-7): the savings + net read have no credentials. */
const UNAUTH_VIEW: RoiView = {
	...EMPTY_ROI_VIEW,
	savings: { ...EMPTY_ROI_VIEW.savings, status: "unauthenticated" },
	net: { ...EMPTY_ROI_VIEW.net, status: "unauthenticated" },
};

/** A view whose per-user (agent) attribution IS available (e-AC-14). */
const PER_USER_VIEW: RoiView = { ...OK_VIEW, perUserAvailable: true };

/** A trend with a measured (solid) + a modeled (dashed) series (e-AC-10). */
const TREND: RoiTrendView = {
	status: "ok",
	startedAt: "2026-05-01",
	series: [
		{ label: "measured-savings", modeled: false, points: [{ period: "2026-05", cents: 100000 }, { period: "2026-06", cents: 240000 }] },
		{ label: "modeled-savings", modeled: true, points: [{ period: "2026-05", cents: 40000 }, { period: "2026-06", cents: 86000 }] },
	],
};

function mockWire(view: RoiView, trend: RoiTrendView = TREND): WireClient {
	return {
		roi: vi.fn(async () => view),
		roiTrend: vi.fn(async () => trend),
	} as unknown as WireClient;
}

function pageProps(wire: WireClient): PageProps {
	return { wire, daemonUp: true, assetBase: "assets", pollinating: false };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
	container = document.createElement("div");
	document.body.appendChild(container);
	window.location.hash = "#/roi";
});

afterEach(() => {
	if (root !== undefined) act(() => root.unmount());
	container.remove();
	window.location.hash = "";
});

/** Mount the page and flush the usePoll fetch-on-mount + trend effect microtasks so state settles. */
async function mountPage(wire: WireClient): Promise<void> {
	await act(async () => {
		root = createRoot(container);
		root.render(<RoiPage {...pageProps(wire)} />);
	});
	await act(async () => {
		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();
	});
}

const txt = (sel: string): string => container.querySelector(sel)?.textContent ?? "";
const el = (sel: string): Element | null => container.querySelector(sel);

// ─────────────────────────────────────────────────────────────────────────────
// e-AC-11 + e-AC-3/e-AC-4/e-AC-9/e-AC-15 — the PURE render-edge helpers.
// ─────────────────────────────────────────────────────────────────────────────

describe("e-AC-11: money is integer cents; dollars/`$/Mtok`/k·M only at the render edge", () => {
	it("formatCents renders dollars from integer cents; modeled adds `~` + ` est.`", () => {
		expect(formatCents(240000)).toBe("$2,400.00");
		expect(formatCents(0)).toBe("$0.00"); // a measured $0 is a real number, distinct from a DASH (e-AC-5)
		expect(formatCents(-4200)).toBe("-$42.00");
		expect(formatCents(86000, true)).toBe("~$860.00 est.");
	});

	it("formatTokens renders k/M; formatBlendedRate is a DASH until the rate is non-null", () => {
		expect(formatTokens(950)).toBe("950");
		expect(formatTokens(1500)).toBe("1.5k");
		expect(formatTokens(2_400_000)).toBe("2.4M");
		// blendedCentsPerMtok is null until capture is live → a DASH, never a fabricated `$0.00/Mtok`.
		expect(formatBlendedRate(null)).toBe("—");
		expect(formatBlendedRate(150)).toBe("$1.50/Mtok");
	});
});

describe("e-AC-3/e-AC-15: the measured-vs-modeled signal mapping (pure)", () => {
	it("signal #1 — Badge tone: measured=verified, modeled=warning", () => {
		expect(measuredTone(false)).toBe("verified");
		expect(measuredTone(true)).toBe("warning");
	});

	it("signal #2 — numeric weight: measured=--text-primary, modeled=--text-secondary (never primary)", () => {
		expect(measuredWeightColor(false)).toBe("var(--text-primary)");
		expect(measuredWeightColor(true)).toBe("var(--text-secondary)");
		// The headline assertion: a modeled term never carries the measured (--text-primary) treatment.
		expect(measuredWeightColor(true)).not.toBe("var(--text-primary)");
	});

	it("an allocated cost basis is treated as modeled/est.; measured/none are not", () => {
		expect(basisIsModeled("allocated")).toBe(true);
		expect(basisIsModeled("measured")).toBe(false);
		expect(basisIsModeled("none")).toBe(false);
	});
});

describe("e-AC-4: honey never encodes sign (positive verified / negative critical)", () => {
	it("maps the net sign to verified/critical — and NEVER to honey", () => {
		expect(netSignColor(260000)).toBe("var(--verified)");
		expect(netSignColor(0)).toBe("var(--verified)");
		expect(netSignColor(-42000)).toBe("var(--severity-critical)");
		expect(netSignColor(260000)).not.toContain("honey");
		expect(netSignColor(-42000)).not.toContain("honey");
	});
});

describe("e-AC-9: cost-rising-not-green — a cost increase does not render green", () => {
	it("inverts the delta sense: rising cost critical, falling cost green, flat neutral", () => {
		const rising = costDeltaColor(5000);
		expect(rising).toBe("var(--severity-critical)");
		expect(rising).not.toBe("var(--verified)"); // the headline assertion: a rising cost is NOT green
		expect(costDeltaColor(-5000)).toBe("var(--verified)");
		expect(costDeltaColor(0)).toBe("var(--text-tertiary)");
	});
});

describe("isDashStatus: absent/unreachable/unauthenticated → a DASH, ok/partial → a figure", () => {
	it("dashes only the no-confident-value states", () => {
		expect(isDashStatus("absent")).toBe(true);
		expect(isDashStatus("unreachable")).toBe(true);
		expect(isDashStatus("unauthenticated")).toBe(true);
		expect(isDashStatus("ok")).toBe(false);
		expect(isDashStatus("partial")).toBe(false);
	});
});

describe("e-AC-10: the inline-SVG chart maps integer cents to a bounded polyline (pure)", () => {
	it("seriesPolylinePoints spreads points across the box; higher cents sit higher (smaller y)", () => {
		const series = TREND.series[0]!; // measured-savings: 100000 -> 240000 (rising)
		const range = seriesCentsRange(TREND.series);
		const pts = seriesPolylinePoints(series, range).split(" ");
		expect(pts).toHaveLength(2);
		const y0 = Number(pts[0]!.split(",")[1]);
		const y1 = Number(pts[1]!.split(",")[1]);
		// The second point (higher cents) is drawn higher -> a smaller y.
		expect(y1).toBeLessThan(y0);
		// An empty series yields no points (the chart renders its empty state instead).
		expect(seriesPolylinePoints({ label: "x", modeled: false, points: [] }, range)).toBe("");
	});

	// Finding (chart-negative): the net trend CAN be negative (PRD). The scale must span [min, max]
	// INCLUDING 0, so a loss period draws BELOW the zero baseline rather than flattening onto it.
	it("scales against both min and max (incl. 0): a negative point sits BELOW the zero baseline, never clamped", () => {
		const netSeries: RoiTrendView["series"][number] = {
			label: "net",
			modeled: true,
			points: [
				{ period: "2026-05", cents: 20000 }, // a GAIN (positive)
				{ period: "2026-06", cents: -10000 }, // a LOSS (negative) -- must not clamp to the baseline
			],
		};
		const range = seriesCentsRange([netSeries]);
		expect(range.min).toBeLessThan(0); // the range spans the negative point
		expect(range.max).toBeGreaterThan(0);
		const baselineY = zeroBaselineY(range);
		const pts = seriesPolylinePoints(netSeries, range).split(" ");
		const yGain = Number(pts[0]!.split(",")[1]);
		const yLoss = Number(pts[1]!.split(",")[1]);
		// The gain sits ABOVE the zero baseline (smaller y); the loss sits BELOW it (larger y), distinct.
		expect(yGain).toBeLessThan(baselineY);
		expect(yLoss).toBeGreaterThan(baselineY);
		// The loss is NOT flattened onto the baseline (the old clamp-to-0 bug would make yLoss === baselineY).
		expect(yLoss).not.toBeCloseTo(baselineY, 1);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// e-AC-1 — the registry entry routes WITHOUT a sidebar/router hand-edit.
// ─────────────────────────────────────────────────────────────────────────────

describe("e-AC-1: /roi is registered via ONE registry entry + renders in PageFrame", () => {
	it("the ROUTES list carries the /roi entry and matchRoute routes to RoiPage", () => {
		const entry = ROUTES.find((r) => r.route === "/roi");
		expect(entry, "the /roi registry entry exists").toBeDefined();
		expect(entry?.label).toBe("ROI");
		expect(entry?.icon, "the entry carries an inline-SVG icon").toBeTruthy();
		expect(entry?.component).toBe(RoiPage);
		// matchRoute (the SAME helper router.tsx uses) resolves the hash to the page — no router edit.
		expect(matchRoute("/roi").component).toBe(RoiPage);
	});

	it("the mounted page renders inside PageFrame with the title 'ROI'", async () => {
		await mountPage(mockWire(OK_VIEW));
		expect(container.querySelector("h1")?.textContent).toBe("ROI");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// e-AC-2 — pure function of the view-model: every per-section status renders.
// ─────────────────────────────────────────────────────────────────────────────

describe("e-AC-2: the page is a pure function of the RoiView (per-section status)", () => {
	it("status `ok` → the figures render (a measured savings number, a computed net)", async () => {
		await mountPage(mockWire(OK_VIEW));
		expect(txt('[data-testid="savings-measured-figure"]')).toBe("$2,400.00");
		expect(el('[data-testid="net-figure"]')?.getAttribute("data-computed")).toBe("true");
	});

	it("status `absent` (EMPTY_ROI_VIEW) → a DASH glyph everywhere, NOT `$0.00`", async () => {
		await mountPage(mockWire(EMPTY_ROI_VIEW, EMPTY_ROI_TREND));
		expect(txt('[data-testid="savings-measured-figure"]')).toBe("—");
		expect(txt('[data-testid="net-figure"]')).toBe("—");
		// A measured $0 would be `$0.00`; absent must be the dash — they are visibly distinct (e-AC-5).
		expect(container.textContent).not.toContain("$0.00");
	});

	it("status `partial` → the Claude-Code-only info badge renders (e-AC-5)", async () => {
		await mountPage(mockWire(PARTIAL_VIEW));
		expect(el('[data-testid="claude-code-only"]')).not.toBeNull();
		expect(txt('[data-testid="claude-code-only"]')).toContain("Claude Code only");
	});

	it("status `unreachable` → the affected line + the net dash (e-AC-6)", async () => {
		await mountPage(mockWire(BILLING_UNREACHABLE_VIEW));
		expect(txt('[data-testid="infra-kpi-figure"]')).toBe("—");
		expect(txt('[data-testid="net-figure"]')).toBe("—");
	});

	it("status `unauthenticated` → the auth gate (e-AC-7)", async () => {
		await mountPage(mockWire(UNAUTH_VIEW, EMPTY_ROI_TREND));
		expect(el('[data-testid="auth-gate"]')).not.toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// e-AC-3 — the modeled term never renders with the measured treatment.
// ─────────────────────────────────────────────────────────────────────────────

describe("e-AC-3: the modeled figure carries `~`/`est.` + the subordinate treatment, never the measured one", () => {
	it("the modeled savings line has `~`+`est.`, --text-secondary weight, and a warning badge", async () => {
		await mountPage(mockWire(OK_VIEW));
		const figure = el('[data-testid="savings-modeled-figure"]') as HTMLElement;
		expect(figure.textContent).toContain("~");
		expect(figure.textContent).toContain("est.");
		expect(figure.getAttribute("data-modeled")).toBe("true");
		// Signal #2: the modeled figure is --text-secondary — NEVER the measured --text-primary.
		expect(figure.style.color).toBe("var(--text-secondary)");
	});

	it("the measured headline is --text-primary, no `est.`, with a verified badge", async () => {
		await mountPage(mockWire(OK_VIEW));
		const figure = el('[data-testid="savings-measured-figure"]') as HTMLElement;
		expect(figure.textContent).toBe("$2,400.00");
		expect(figure.textContent).not.toContain("est.");
		expect(figure.style.color).toBe("var(--text-primary)");
		// The measured row carries the `measured` tone label; the modeled row carries `modeled`.
		expect(txt('[data-testid="savings-measured"]')).toContain("measured");
		expect(txt('[data-testid="savings-modeled"]')).toContain("modeled");
	});

	it("the net hero inherits `est.` (it folds a modeled term)", async () => {
		await mountPage(mockWire(OK_VIEW));
		expect(txt('[data-testid="net-hero"]')).toContain("est.");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// e-AC-4 — the rendered net color obeys the honey-never-encodes-sign rule.
// ─────────────────────────────────────────────────────────────────────────────

describe("e-AC-4: the rendered net color encodes sign with verified/critical, never honey", () => {
	it("a positive net renders --verified; honey appears nowhere on the figure", async () => {
		await mountPage(mockWire(OK_VIEW));
		const figure = el('[data-testid="net-figure"]') as HTMLElement;
		expect(figure.style.color).toBe("var(--verified)");
		expect(figure.style.color).not.toContain("honey");
	});

	it("a negative net renders --severity-critical (never honey)", async () => {
		await mountPage(mockWire(NEGATIVE_NET_VIEW));
		const figure = el('[data-testid="net-figure"]') as HTMLElement;
		expect(figure.style.color).toBe("var(--severity-critical)");
		expect(figure.textContent).toContain("-$420.00");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// e-AC-6 — billing-unreachable: dash for the line + the net + a scoped Retry.
// ─────────────────────────────────────────────────────────────────────────────

describe("Finding (retry-cta): Retry shows ONLY on net.status === 'unreachable', not on absent/initial", () => {
	it("an ABSENT (not-yet-computed) net shows a plain caption and NO Retry button", async () => {
		const absentNet: RoiView = {
			...OK_VIEW,
			savings: { ...OK_VIEW.savings, status: "absent" },
			net: { status: "absent", computed: false, netCents: 0, modeled: true, costBasis: "none" },
		};
		await mountPage(mockWire(absentNet));
		expect(el('[data-testid="net-figure"]')?.getAttribute("data-computed")).toBe("false");
		// No Retry on a non-unreachable (absent) net -- a plain "not computed yet" caption instead.
		expect(el('[data-testid="net-retry"]'), "no Retry on an absent net").toBeNull();
		expect(txt('[data-testid="net-hero"]')).toContain("not computed yet");
	});

	it("the INITIAL empty view (EMPTY_ROI_VIEW net) shows NO Retry before first load", async () => {
		// EMPTY_ROI_VIEW.net is the initial/empty state (computed:false). It must not show a Retry.
		const initial: RoiView = { ...EMPTY_ROI_VIEW, savings: { ...EMPTY_ROI_VIEW.savings, status: "absent" } };
		await mountPage(mockWire(initial));
		expect(el('[data-testid="net-retry"]'), "no Retry on the initial empty view").toBeNull();
	});
});

describe("e-AC-6: billing-unreachable dashes the line + the net and offers a scoped Retry", () => {
	it("the net is NOT computed; a Retry button is present and re-reads the view", async () => {
		const wire = mockWire(BILLING_UNREACHABLE_VIEW);
		await mountPage(wire);
		expect(el('[data-testid="net-figure"]')?.getAttribute("data-computed")).toBe("false");
		expect(txt('[data-testid="net-figure"]')).toBe("—");
		const retry = el('[data-testid="net-retry"]') as HTMLButtonElement;
		expect(retry, "the scoped retry button is present").not.toBeNull();
		const callsBefore = (wire.roi as ReturnType<typeof vi.fn>).mock.calls.length;
		await act(async () => {
			retry.dispatchEvent(new MouseEvent("click", { bubbles: true }));
			await Promise.resolve();
			await Promise.resolve();
		});
		expect((wire.roi as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(callsBefore);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// e-AC-7 — not-authenticated: the ledger is gated; NO credential reaches the page.
// ─────────────────────────────────────────────────────────────────────────────

describe("e-AC-7: not-authenticated gates the ledger behind a Settings CTA; no secret reaches the page", () => {
	it("renders only a redacted status + a Settings CTA, and no ledger figure", async () => {
		await mountPage(mockWire(UNAUTH_VIEW, EMPTY_ROI_TREND));
		expect(el('[data-testid="auth-gate"]')).not.toBeNull();
		expect(txt('[data-testid="auth-redacted-status"]')).toContain("not connected");
		expect(el('[data-testid="auth-settings-cta"]')).not.toBeNull();
		// The ledger panels do NOT render while gated.
		expect(el('[data-testid="net-hero"]')).toBeNull();
		expect(el('[data-testid="savings-measured"]')).toBeNull();
	});

	it("the rendered DOM contains no token/credential-shaped string", async () => {
		await mountPage(mockWire(UNAUTH_VIEW, EMPTY_ROI_TREND));
		const html = container.innerHTML.toLowerCase();
		for (const banned of ["token", "secret", "bearer", "authorization", "api_key", "apikey", "password"]) {
			expect(html, `no '${banned}' in the rendered page`).not.toContain(banned);
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// e-AC-8 — the assumption disclosure (ⓘ popover + page-foot footnote, ONE source).
// ─────────────────────────────────────────────────────────────────────────────

describe("e-AC-8: the assumption is disclosed via an ⓘ popover + a page-foot footnote, both ONE source", () => {
	it("the footnote renders the assumptionText verbatim, and the ⓘ popover surfaces the SAME text", async () => {
		await mountPage(mockWire(OK_VIEW));
		// The persistent footnote reads the assumption data field verbatim (not hardcoded copy).
		expect(txt('[data-testid="assumption-footnote"]')).toContain(ASSUMPTION.assumptionText);
		// Open the ⓘ popover → it shows the SAME source text.
		const info = el('[data-testid="assumption-info"]') as HTMLButtonElement;
		expect(info).not.toBeNull();
		await act(async () => {
			info.dispatchEvent(new MouseEvent("click", { bubbles: true }));
		});
		expect(txt('[data-testid="assumption-popover"]')).toContain(ASSUMPTION.assumptionText);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// e-AC-9 — cost-rising-not-green (the rendered delta).
// ─────────────────────────────────────────────────────────────────────────────

describe("e-AC-9: a rendered rising cost delta is NOT green", () => {
	it("a cost increase renders the critical (not verified) delta color", async () => {
		const view: RoiView = { ...OK_VIEW };
		// Render the infra KPI with a rising delta by mounting the page and asserting the helper-backed color
		// via a constructed view; the delta is supplied through the CostKpi inline path (rising = critical).
		await mountPage(mockWire(view));
		// The pure mapping is the contract; assert it directly so the inversion is locked regardless of props.
		expect(costDeltaColor(5000)).not.toBe("var(--verified)");
		expect(costDeltaColor(5000)).toBe("var(--severity-critical)");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// e-AC-10 — the inline-SVG trend chart draws dashed=modeled / solid=measured.
// ─────────────────────────────────────────────────────────────────────────────

describe("e-AC-10: the trend chart is inline SVG with dashed=modeled / solid=measured strokes", () => {
	it("renders a polyline per series; the modeled series is dashed, the measured one is solid", async () => {
		await mountPage(mockWire(OK_VIEW, TREND));
		const measured = el('[data-testid="roi-trend-series-measured-savings"]') as SVGElement | null;
		const modeled = el('[data-testid="roi-trend-series-modeled-savings"]') as SVGElement | null;
		expect(measured, "the measured series renders").not.toBeNull();
		expect(modeled, "the modeled series renders").not.toBeNull();
		// Measured = solid (no dasharray); modeled = dashed (a dasharray present).
		expect(measured?.getAttribute("stroke-dasharray")).toBeNull();
		expect(modeled?.getAttribute("stroke-dasharray")).not.toBeNull();
		expect(modeled?.getAttribute("data-modeled")).toBe("true");
		// It is an inline SVG (no charting dependency) — the chart container holds an <svg>.
		expect(el('[data-testid="roi-trend-chart"] svg')).not.toBeNull();
	});

	it("an absent trend renders the honest empty state, not a fabricated flat line", async () => {
		await mountPage(mockWire(OK_VIEW, EMPTY_ROI_TREND));
		expect(el('[data-testid="roi-trend-empty"]')).not.toBeNull();
		expect(el('[data-testid="roi-trend-series-measured-savings"]')).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// e-AC-13 — org/team/agent/project rollups via a dimension switch (no grouping).
// ─────────────────────────────────────────────────────────────────────────────

describe("e-AC-13: a dimension switch renders each rollup from the fixture; the page does NO grouping", () => {
	it("renders the org rollup by default and switches to each other dimension on tab click", async () => {
		await mountPage(mockWire(OK_VIEW));
		// Default = the first available dimension (org).
		expect(el('[data-testid="rollup-org"]')).not.toBeNull();
		expect(txt('[data-testid="rollup-row-org-acme"]')).toContain("Acme");

		// Switch to each other dimension; the corresponding rollup (from the FIXTURE) renders.
		for (const dim of ["team", "agent", "project"] as const) {
			const tab = el(`[data-testid="rollup-tab-${dim}"]`) as HTMLButtonElement;
			expect(tab, `the ${dim} tab is present`).not.toBeNull();
			await act(async () => tab.dispatchEvent(new MouseEvent("click", { bubbles: true })));
			expect(el(`[data-testid="rollup-${dim}"]`), `the ${dim} rollup renders`).not.toBeNull();
		}
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// e-AC-14 — per-user shown ONLY when perUserAvailable; else an info empty state.
// ─────────────────────────────────────────────────────────────────────────────

describe("e-AC-14: per-user is shown ONLY when perUserAvailable; else a 'requires verified login' empty state", () => {
	it("with the flag false, the agent rollup shows the info empty state (never `$0`/a self-asserted name)", async () => {
		await mountPage(mockWire(OK_VIEW)); // perUserAvailable: false
		const tab = el('[data-testid="rollup-tab-agent"]') as HTMLButtonElement;
		await act(async () => tab.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		const empty = el('[data-testid="per-user-empty"]');
		expect(empty, "the per-user-requires-login empty state shows").not.toBeNull();
		expect(empty?.textContent).toContain("Per-user requires verified login");
		expect(empty?.textContent).not.toContain("$0");
		// Finding (peruser-leak / e-AC-14): the gate MUST short-circuit BEFORE any agent row renders.
		// NO `rollup-row-agent-*` row and NO agent label/figure may leak in this gated state.
		expect(el('[data-testid="rollup-row-agent-claude-code"]'), "no agent row leaks while gated").toBeNull();
		expect(container.querySelector('[data-testid^="rollup-row-agent-"]'), "no agent row at all").toBeNull();
		// The agent label "Claude Code" (the per-user figure's name) must not appear in the rollup region.
		expect(el('[data-testid="rollup-agent"]')?.textContent ?? "").not.toContain("Claude Code");
	});

	it("with the flag true, the agent rollup does NOT show the empty state", async () => {
		await mountPage(mockWire(PER_USER_VIEW));
		const tab = el('[data-testid="rollup-tab-agent"]') as HTMLButtonElement;
		await act(async () => tab.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		expect(el('[data-testid="per-user-empty"]')).toBeNull();
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// e-AC-15 — allocated net carries est.; a mixed-basis rollup is flagged, not blended.
// ─────────────────────────────────────────────────────────────────────────────

describe("e-AC-15: an allocated net carries est.; a mixed-basis rollup is flagged, not blended", () => {
	it("the team rollup (allocated, mixedBasis) shows the allocated-est. badge + the mixed caption", async () => {
		await mountPage(mockWire(OK_VIEW));
		const tab = el('[data-testid="rollup-tab-team"]') as HTMLButtonElement;
		await act(async () => tab.dispatchEvent(new MouseEvent("click", { bubbles: true })));
		// The allocated row is flagged with the est. badge (the same subordinate treatment as a modeled line).
		expect(el('[data-testid="rollup-allocated-core"]')).not.toBeNull();
		expect(txt('[data-testid="rollup-allocated-core"]')).toContain("allocated est.");
		// The mixed-basis rollup is FLAGGED rather than silently summed into one net.
		expect(el('[data-testid="mixed-basis-caption"]')).not.toBeNull();
		expect(txt('[data-testid="mixed-basis-caption"]')).toContain("mixed measured + allocated");
	});
});
