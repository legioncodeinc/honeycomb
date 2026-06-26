/**
 * The ROI TREND CHART — PRD-060e (e-AC-10), an INLINE-SVG line chart in the GraphCanvas idiom.
 *
 * No charting dependency: this hand-draws one `<polyline>` per {@link RoiTrendSeries} over a bounded
 * SVG `viewBox`, exactly like `panels.tsx` `GraphCanvas` hand-draws nodes/edges. The measured-vs-modeled
 * language is honored on the stroke (the FOURTH of the four signals, folded in from the page): a
 * `modeled` series draws a DASHED stroke, a measured series a SOLID one. Money is INTEGER cents at every
 * point ({@link RoiTrendPoint.cents}); this component only divides by the series max to map cents → the
 * pixel y-axis, never formatting dollars (that is the page's render edge).
 *
 * Motion (e-AC-10): a one-shot draw-in transition reuses ONLY the existing `--dur-base` token and is
 * SUPPRESSED under `prefers-reduced-motion` — there is no count-up odometer and no infinite animation.
 * Every visual value is an existing `var(--…)` DS token; no new token, no new dependency.
 *
 * The chart is a PURE function of the {@link RoiTrendView} the page hands it (the page fetched it via
 * `wire.roiTrend`); it does no fetching itself.
 */

import React from "react";

import type { RoiTrendSeries, RoiTrendView } from "../../contracts.js";

/** The chart canvas extent — the line points map into this box; the SVG scales to its container. */
const CHART_VIEW = { width: 640, height: 200 } as const;
/** Inner padding (px in viewBox units) so strokes + the baseline never clip the edge. */
const PAD = { top: 12, right: 12, bottom: 18, left: 12 } as const;

/** The per-series stroke color (existing DS tokens only). Measured savings is the defensible green. */
function seriesColor(label: string, modeled: boolean): string {
	if (label.includes("net")) return "var(--honey)";
	if (label.includes("infra") || label.includes("cost")) return "var(--severity-info)";
	// Savings: measured is the proven green; the modeled estimate rides the amber warning tone (e-AC-3).
	return modeled ? "var(--severity-warning)" : "var(--verified)";
}

/**
 * The cents range [min, max] across every point of every series, ALWAYS including 0 so the zero axis is
 * on-scale (pure, exported for tests). Finding (chart-negative): net trend CAN be negative (PRD), so the
 * scale must span both negative and positive cents -- the prior max-only/clamp-to-0 flattened loss
 * periods onto the baseline. `min <= 0 <= max` is guaranteed (0 is folded in), and `max > min` is
 * guaranteed (a degenerate all-zero series widens to [0, 1]) so we never divide by 0.
 */
export function seriesCentsRange(series: readonly RoiTrendSeries[]): { min: number; max: number } {
	let min = 0;
	let max = 0;
	for (const s of series) {
		for (const p of s.points) {
			if (p.cents < min) min = p.cents;
			if (p.cents > max) max = p.cents;
		}
	}
	// Degenerate (all points exactly 0, or no points): widen so max > min and the divide is safe.
	if (max === min) max = min + 1;
	return { min, max };
}

/** The viewBox y-coordinate of the ZERO line for a given range (where the baseline is drawn). */
export function zeroBaselineY(range: { min: number; max: number }): number {
	const innerH = CHART_VIEW.height - PAD.top - PAD.bottom;
	const frac = (0 - range.min) / (range.max - range.min); // fraction of the range that 0 sits at
	return PAD.top + innerH - frac * innerH;
}

/** Map one series' points to an SVG `points` string over the bounded box (pure, exported for tests). */
export function seriesPolylinePoints(series: RoiTrendSeries, range: { min: number; max: number }): string {
	const pts = series.points;
	if (pts.length === 0) return "";
	const innerW = CHART_VIEW.width - PAD.left - PAD.right;
	const innerH = CHART_VIEW.height - PAD.top - PAD.bottom;
	// A single point sits at the left edge; >=2 points spread evenly across the inner width.
	const stepX = pts.length > 1 ? innerW / (pts.length - 1) : 0;
	const span = range.max - range.min;
	return pts
		.map((p, i) => {
			const x = PAD.left + i * stepX;
			// cents -> y: map against the FULL [min, max] range (which includes 0). Higher cents sit
			// HIGHER (smaller y); a NEGATIVE cents value sits BELOW the zero line, never clamped to it.
			const frac = Math.max(0, Math.min(1, (p.cents - range.min) / span));
			const y = PAD.top + innerH - frac * innerH;
			return `${x.toFixed(1)},${y.toFixed(1)}`;
		})
		.join(" ");
}

/** Read the OS reduced-motion preference (fail-soft: treats an unavailable matchMedia as "no preference"). */
function prefersReducedMotion(): boolean {
	try {
		return typeof window !== "undefined" && typeof window.matchMedia === "function"
			? window.matchMedia("(prefers-reduced-motion: reduce)").matches
			: false;
	} catch {
		return false;
	}
}

/** Props for {@link RoiTrendChart}. */
export interface RoiTrendChartProps {
	/** The trend view-model the page fetched via `wire.roiTrend` (the chart is a pure function of it). */
	readonly trend: RoiTrendView;
}

/**
 * The inline-SVG trend chart (e-AC-10). Renders one polyline per series — DASHED for a modeled series,
 * SOLID for a measured one — plus a small legend. An absent/empty trend renders an honest empty state
 * (NOT a fabricated flat line). The draw-in transition reuses `--dur-base` and is suppressed under
 * `prefers-reduced-motion`.
 */
export function RoiTrendChart({ trend }: RoiTrendChartProps): React.JSX.Element {
	const reduceMotion = React.useMemo(() => prefersReducedMotion(), []);
	// The one-shot draw-in: start hidden, flip visible after mount so the stroke transitions in once.
	const [drawn, setDrawn] = React.useState(reduceMotion);
	React.useEffect(() => {
		if (reduceMotion) return;
		const id = requestAnimationFrame(() => setDrawn(true));
		return () => cancelAnimationFrame(id);
	}, [reduceMotion]);

	const hasData = trend.series.some((s) => s.points.length > 0);
	if (trend.status === "absent" || !hasData) {
		return (
			<div
				data-testid="roi-trend-empty"
				style={{ padding: "28px 8px", textAlign: "center", fontSize: 13, color: "var(--text-tertiary)" }}
			>
				{trend.startedAt !== "" ? `Savings tracked from ${trend.startedAt}.` : "No trend history yet."}
			</div>
		);
	}

	const range = seriesCentsRange(trend.series);
	// Finding (chart-negative): the baseline is the ZERO crossing within the [min,max] range, not a
	// fixed bottom edge -- so a loss period draws BELOW it and a gain ABOVE it.
	const baselineY = zeroBaselineY(range);

	return (
		<div data-testid="roi-trend-chart">
			<svg viewBox={`0 0 ${CHART_VIEW.width} ${CHART_VIEW.height}`} style={{ width: "100%", height: 200, display: "block" }} role="img" aria-label="ROI trend over time">
				{/* Baseline (zero axis) — a quiet rule the lines sit above. */}
				<line
					x1={PAD.left}
					y1={baselineY}
					x2={CHART_VIEW.width - PAD.right}
					y2={baselineY}
					stroke="var(--border-subtle)"
					strokeWidth="1"
				/>
				{trend.series.map((s) => {
					const points = seriesPolylinePoints(s, range);
					if (points === "") return null;
					const color = seriesColor(s.label, s.modeled);
					return (
						<polyline
							key={s.label}
							data-testid={`roi-trend-series-${s.label}`}
							data-modeled={s.modeled ? "true" : "false"}
							points={points}
							fill="none"
							stroke={color}
							strokeWidth="2"
							strokeLinejoin="round"
							strokeLinecap="round"
							// The FOURTH measured-vs-modeled signal (e-AC-3/e-AC-10): dashed = modeled, solid = measured.
							strokeDasharray={s.modeled ? "5 4" : undefined}
							// One-shot draw-in via opacity; reuses `--dur-base`, suppressed under reduced-motion.
							style={{
								opacity: drawn ? 1 : 0,
								transition: reduceMotion ? undefined : "opacity var(--dur-base) var(--ease-out)",
							}}
						/>
					);
				})}
			</svg>
			{/* Legend: each series' tone + the dashed/solid affordance, so the stroke language is readable. */}
			<div style={{ display: "flex", flexWrap: "wrap", gap: 14, marginTop: 8 }}>
				{trend.series.map((s) => (
					<span key={s.label} style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
						<svg width={22} height={8} aria-hidden="true" style={{ flex: "none" }}>
							<line
								x1={1}
								y1={4}
								x2={21}
								y2={4}
								stroke={seriesColor(s.label, s.modeled)}
								strokeWidth="2"
								strokeDasharray={s.modeled ? "4 3" : undefined}
							/>
						</svg>
						<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>
							{s.label}
							{s.modeled ? " (est.)" : ""}
						</span>
					</span>
				))}
			</div>
		</div>
	);
}
