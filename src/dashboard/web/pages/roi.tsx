/**
 * The ROI page — PRD-060e (the `/roi` Net-ROI ledger surface).
 *
 * Mounted at a PRD-037 registry slot (ONE entry in `registry.tsx` + this one component —
 * `library/knowledge/private/dashboard/adding-a-page.md`). The page is a PURE FUNCTION of the
 * {@link RoiView} the daemon assembles (e-AC-2): it switches each section on its `status` discriminant
 * and does NO fetching/compute beyond two `usePoll` hydrations (billing ~60s, token per-session) +
 * one explicit fetch-on-range-change for the trend (e-AC-10). It composes 060b savings, 060c infra,
 * 060d pollination into the Net-ROI ledger and degrades section-by-section.
 *
 * ── The honesty language (folded-in UX brief) ─────────────────────────────────
 *   - Measured vs modeled is solved with FOUR reinforcing existing signals (e-AC-3): (1) Badge tone —
 *     `verified` (green) measured / `warning` (amber) modeled; (2) numeric weight — `--text-primary`
 *     measured / `--text-secondary` modeled (subordinate, indented); (3) a literal `est.` marker + a
 *     leading `~` on every modeled figure; (4) dashed-vs-solid chart strokes (in `roi-chart.tsx`). The
 *     SAME four distinguish an `allocated` cost from a `measured` one (e-AC-15). The net hero inherits
 *     `est.` because it folds a modeled term.
 *   - Honey is brand-frame ONLY and never encodes sign (e-AC-4): a positive net renders `var(--verified)`,
 *     a negative net `var(--severity-critical)` — never honey.
 *   - Degraded states (e-AC-5/6/7): first-run/empty → a DASH glyph (not `$0.00`); token-absent → the
 *     `absent` treatment; Claude-Code-only → an info "Claude Code only" badge; billing-unreachable → a
 *     dash for the line AND the net + a scoped Retry; not-authenticated → the ledger is gated behind a
 *     Settings CTA and ONLY redacted status renders (no token/secret reaches the page — e-AC-7).
 *   - Cost-rising is NOT green (e-AC-9): a rising cost KPI delta inverts the usual sense.
 *
 * Money is INTEGER cents in the view-model; dollars are formatted ONLY at the render edge here
 * (e-AC-11). The assumption behind the modeled estimate is disclosed via an ⓘ popover + a persistent
 * page-foot footnote, BOTH sourced from `savings.assumption.assumptionText` (one source — e-AC-8).
 *
 * Security (e-AC-7): the page reads ONLY the loopback `roi`/`roiTrend` endpoints through the injected
 * `wire` (never `createWireClient`); it adds no token/secret and renders subsystem state only. Every
 * visual value is an existing `var(--…)` DS token; no new token, no new dependency. React 18 patterns.
 */

import React from "react";

import type {
	RoiAssumption,
	RoiCostBasisTag,
	RoiNetSection,
	RoiRollup,
	RoiRollupDimension,
	RoiSavingsSection,
	RoiSectionStatus,
	RoiTrendView,
	RoiView,
} from "../../contracts.js";
import { EMPTY_ROI_TREND, EMPTY_ROI_VIEW } from "../../contracts.js";
import { Badge, Button, type BadgeTone } from "../primitives.js";
import { Panel } from "../panels.js";
import type { PageProps } from "../page-frame.js";
import { PageFrame, usePoll } from "../page-frame.js";
import { useScope } from "../scope-context.js";
import { RoiTrendChart } from "./roi-chart.js";

/** The Settings hash route the not-authenticated gate sends the operator to (e-AC-7). */
const SETTINGS_ROUTE = "#/settings" as const;

/** Billing poll cadence (~60s) — the slow loop for the billing-backed sections (infra/pollination/net). */
const BILLING_POLL_MS = 60_000;
/** Token poll cadence — the faster per-session loop for the token-derived savings section. */
const TOKEN_POLL_MS = 15_000;
/** The default trend window the chart requests; a range change triggers an explicit refetch (e-AC-10). */
const DEFAULT_RANGE = "30d" as const;
/** The selectable trend ranges (the dimension-style switch the chart's range control offers). */
const TREND_RANGES = ["7d", "30d", "90d"] as const;

/** The dash glyph the page shows for an absent/unreachable figure — NOT `$0.00` (e-AC-5/e-AC-6). */
export const DASH = "—" as const;

// ─────────────────────────────────────────────────────────────────────────────
// The render edge (e-AC-11) — INTEGER cents → presentation. Cents never leave the
// view-model as a float; these are the ONLY place dollars/`$/Mtok`/k·M are formed.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Format INTEGER cents as a dollar string at the render edge (e-AC-11). `~` is the leading modeled
 * marker (the third measured-vs-modeled signal) — present iff `modeled`. NEVER call this for an
 * absent/unreachable figure; those render {@link DASH} instead (a measured `$0.00` is distinct from
 * unknown — e-AC-5).
 */
export function formatCents(cents: number, modeled = false): string {
	const sign = cents < 0 ? "-" : "";
	const dollars = Math.abs(cents) / 100;
	const body = `${sign}$${dollars.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
	return modeled ? `~${body} est.` : body;
}

/** Format a token count k/M at the render edge (e-AC-11). */
export function formatTokens(tokens: number): string {
	if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`;
	if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`;
	return String(tokens);
}

/**
 * Format the blended `$/Mtok` rate (e-AC-11). `blendedCentsPerMtok` is `null` until token capture is
 * live → render {@link DASH}, NEVER a fabricated `$0.00/Mtok`. When present it is INTEGER cents-per-Mtok.
 */
export function formatBlendedRate(centsPerMtok: number | null): string {
	if (centsPerMtok === null) return DASH;
	return `$${(centsPerMtok / 100).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}/Mtok`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The four measured-vs-modeled signals + the honey-never-encodes-sign rule.
// Pure, exported so the page test asserts the mapping directly (e-AC-3/e-AC-4/e-AC-9/e-AC-15).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Signal #1 — Badge tone: `verified` (green) for a MEASURED figure, `warning` (amber) for a MODELED one
 * (e-AC-3). The same maps an `allocated` cost (treated as modeled/`est.`) vs a `measured` one (e-AC-15).
 */
export function measuredTone(modeled: boolean): BadgeTone {
	return modeled ? "warning" : "verified";
}

/**
 * Signal #2 — numeric weight color: `--text-primary` for a MEASURED figure (the defensible headline),
 * `--text-secondary` for a MODELED one (subordinate). A test asserts a modeled term NEVER renders with
 * the measured (`--text-primary`) treatment (e-AC-3/e-AC-15).
 */
export function measuredWeightColor(modeled: boolean): string {
	return modeled ? "var(--text-secondary)" : "var(--text-primary)";
}

/**
 * The honey-never-encodes-sign rule (e-AC-4): a positive (or zero) net renders `var(--verified)`, a
 * negative net `var(--severity-critical)`. Honey is brand-frame only and is NEVER returned here.
 */
export function netSignColor(netCents: number): string {
	return netCents < 0 ? "var(--severity-critical)" : "var(--verified)";
}

/**
 * A `cost_basis` is rendered as modeled/`est.` iff it is `allocated` (e-AC-15) — an allocated infra
 * share is an estimate, never a measured fact. `measured`/`none` are not subordinated.
 */
export function basisIsModeled(basis: RoiCostBasisTag): boolean {
	return basis === "allocated";
}

/**
 * Cost-rising-not-green (e-AC-9): for a COST KPI the usual delta sense is INVERTED. A rising cost
 * (delta > 0) is BAD → `var(--severity-critical)`; a falling cost (delta < 0) is good → `var(--verified)`;
 * flat is neutral. A test asserts a cost increase does NOT render green.
 */
export function costDeltaColor(deltaCents: number): string {
	if (deltaCents > 0) return "var(--severity-critical)";
	if (deltaCents < 0) return "var(--verified)";
	return "var(--text-tertiary)";
}

// ─────────────────────────────────────────────────────────────────────────────
// Small presentation atoms (DS tokens only).
// ─────────────────────────────────────────────────────────────────────────────

/** A mono caption row label. */
function Caption({ children, color = "var(--text-tertiary)" }: { children: React.ReactNode; color?: string }): React.JSX.Element {
	return <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color }}>{children}</span>;
}

/**
 * The ⓘ assumption popover (e-AC-8) — a hover/focus disclosure sourced from `assumption.assumptionText`
 * (the ONE source the page-foot footnote also reads). Pure markup + a local open state; no copy is
 * hardcoded here.
 */
function AssumptionInfo({ assumption }: { assumption: RoiAssumption }): React.JSX.Element {
	const [open, setOpen] = React.useState(false);
	const text = assumption.assumptionText !== "" ? assumption.assumptionText : "Assumption not yet provided.";
	return (
		<span style={{ position: "relative", display: "inline-flex" }}>
			<button
				type="button"
				data-testid="assumption-info"
				aria-label="modeled assumption"
				aria-expanded={open}
				onClick={() => setOpen((o) => !o)}
				onMouseEnter={() => setOpen(true)}
				onMouseLeave={() => setOpen(false)}
				onFocus={() => setOpen(true)}
				onBlur={() => setOpen(false)}
				style={{
					width: 16,
					height: 16,
					padding: 0,
					borderRadius: "var(--radius-full)",
					border: "1px solid var(--border-strong)",
					background: "transparent",
					color: "var(--text-tertiary)",
					fontFamily: "var(--font-mono)",
					fontSize: 10,
					lineHeight: 1,
					cursor: "pointer",
				}}
			>
				i
			</button>
			{open && (
				<span
					role="tooltip"
					data-testid="assumption-popover"
					style={{
						position: "absolute",
						top: 22,
						left: 0,
						zIndex: 5,
						width: 260,
						padding: "8px 10px",
						background: "var(--bg-elevated)",
						border: "1px solid var(--border-default)",
						borderRadius: "var(--radius-md)",
						boxShadow: "var(--shadow-md)",
						fontSize: 12,
						lineHeight: "16px",
						color: "var(--text-secondary)",
					}}
				>
					{text}
					{!assumption.signedOff && (
						<span style={{ display: "block", marginTop: 4, fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--text-tertiary)" }}>
							provisional — not yet signed off
						</span>
					)}
				</span>
			)}
		</span>
	);
}

/**
 * One ledger figure row: a label, the figure (a DASH for absent/unreachable, else the formatted cents
 * with the measured/modeled weight + `~`/`est.` markers), a measured/modeled tone Badge, and an optional
 * trailing slot (the ⓘ, a basis caption). `modeled` drives the third+second signals; `dash` forces the
 * DASH glyph regardless of the number (so a measured `$0.00` is distinct from unknown — e-AC-5).
 */
function LedgerRow({
	label,
	cents,
	modeled,
	dash,
	indent,
	tone,
	toneLabel,
	trailing,
	testid,
}: {
	label: string;
	cents: number;
	modeled: boolean;
	dash: boolean;
	indent?: boolean;
	tone: BadgeTone;
	toneLabel: string;
	trailing?: React.ReactNode;
	testid: string;
}): React.JSX.Element {
	return (
		<div
			data-testid={testid}
			style={{
				display: "flex",
				alignItems: "center",
				gap: 10,
				padding: "10px 6px",
				paddingLeft: indent ? 22 : 6,
				borderTop: "1px solid var(--border-subtle)",
			}}
		>
			<span style={{ fontSize: 14, color: indent ? "var(--text-secondary)" : "var(--text-primary)" }}>{label}</span>
			<Badge tone={tone} mono>
				{toneLabel}
			</Badge>
			{trailing}
			<span style={{ flex: 1 }} />
			<span
				data-testid={`${testid}-figure`}
				data-modeled={modeled ? "true" : "false"}
				style={{
					fontFamily: "var(--font-mono)",
					fontSize: indent ? 15 : 17,
					fontWeight: 700,
					// Signal #2: an absent/unreachable DASH is tertiary; a present figure carries the measured/modeled weight.
					color: dash ? "var(--text-tertiary)" : measuredWeightColor(modeled),
				}}
			>
				{dash ? DASH : formatCents(cents, modeled)}
			</span>
		</div>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// Section status helpers (e-AC-2/e-AC-5/e-AC-6/e-AC-7).
// ─────────────────────────────────────────────────────────────────────────────

/** A figure is shown as a DASH (not a number) when its section has no confident value (e-AC-5/e-AC-6). */
export function isDashStatus(status: RoiSectionStatus): boolean {
	return status === "absent" || status === "unreachable" || status === "unauthenticated";
}

// ─────────────────────────────────────────────────────────────────────────────
// The NET-ROI hero (e-AC-3/e-AC-4/e-AC-6).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The Net-ROI hero. The net is rendered ONLY when `net.computed` is true (e-AC-6) — otherwise a DASH
 * glyph + a scoped Retry, never a number fabricated from incomplete inputs. When computed it inherits
 * `est.` (the net folds a modeled term, e-AC-3) and its color obeys the honey-never-encodes-sign rule
 * (e-AC-4): positive `var(--verified)`, negative `var(--severity-critical)`.
 */
function NetHero({ net, onRetry, retrying }: { net: RoiNetSection; onRetry: () => void; retrying: boolean }): React.JSX.Element {
	const computed = net.computed && net.status === "ok";
	const allocated = basisIsModeled(net.costBasis);
	return (
		<Panel title="Net ROI" eyebrow={net.modeled ? "saved − (infra + pollination) · est." : "saved − (infra + pollination)"}>
			<div data-testid="net-hero" style={{ display: "flex", alignItems: "center", gap: 16, padding: "14px 6px", flexWrap: "wrap" }}>
				<span
					data-testid="net-figure"
					data-computed={computed ? "true" : "false"}
					style={{
						fontFamily: "var(--font-mono)",
						fontSize: 40,
						fontWeight: 800,
						lineHeight: 1,
						letterSpacing: "-0.02em",
						// e-AC-4: honey NEVER encodes sign — verified (positive) / critical (negative). A non-computed
						// net is a neutral tertiary DASH (no sign to encode).
						color: computed ? netSignColor(net.netCents) : "var(--text-tertiary)",
					}}
				>
					{computed ? formatCents(net.netCents, true) : DASH}
				</span>
				{computed ? (
					<Badge tone="warning" mono>
						est.
					</Badge>
				) : (
					<>
						<Caption>net not computed — an input is missing or unreachable</Caption>
						<Button variant="ghost" size="sm" data-testid="net-retry" disabled={retrying} onClick={onRetry}>
							{retrying ? "retrying…" : "Retry"}
						</Button>
					</>
				)}
				{computed && allocated && (
					<Caption>includes an allocated (estimated) infra share</Caption>
				)}
			</div>
		</Panel>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// The SAVINGS section (e-AC-3) — measured headline + subordinate modeled est. line.
// ─────────────────────────────────────────────────────────────────────────────

/** The Claude-Code-only partial badge (e-AC-5) — info, not error. */
function PartialBadge(): React.JSX.Element {
	return (
		<span data-testid="claude-code-only" style={{ marginLeft: 4, display: "inline-flex" }}>
			<Badge tone="info">Claude Code only</Badge>
		</span>
	);
}

function SavingsSection({ savings }: { savings: RoiSavingsSection }): React.JSX.Element {
	const dash = isDashStatus(savings.status);
	return (
		<Panel
			title="Savings"
			eyebrow="measured cache · modeled memory injection"
			right={savings.status === "partial" ? <PartialBadge /> : undefined}
		>
			<div style={{ display: "flex", flexDirection: "column" }}>
				{/* MEASURED headline — the defensible, billed-fact cache savings (verified / --text-primary). */}
				<LedgerRow
					testid="savings-measured"
					label="Measured cache savings"
					cents={savings.measuredCents}
					modeled={false}
					dash={dash}
					tone={measuredTone(false)}
					toneLabel="measured"
				/>
				{/* MODELED estimate — subordinate, indented, ~ + est., amber (e-AC-3). */}
				<LedgerRow
					testid="savings-modeled"
					label="Modeled memory-injection savings"
					cents={savings.modeledCents}
					modeled
					dash={dash}
					indent
					tone={measuredTone(true)}
					toneLabel="modeled"
					trailing={<AssumptionInfo assumption={savings.assumption} />}
				/>
				<div style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 6px", borderTop: "1px solid var(--border-subtle)" }}>
					<Caption>blended rate</Caption>
					<span style={{ flex: 1 }} />
					<span data-testid="blended-rate" style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text-secondary)" }}>
						{formatBlendedRate(savings.blendedCentsPerMtok)}
					</span>
				</div>
			</div>
		</Panel>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// The COST sections (e-AC-6/e-AC-9) — infra + itemized pollination.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A cost KPI tile with the INVERTED delta sense (e-AC-9). A rising cost (delta > 0) renders the
 * `var(--severity-critical)` (NOT green) treatment; a falling cost renders green. Implemented inline so
 * the shared `Kpi` component is not restructured (per the e-AC-9 directive — keep it additive/inline).
 */
function CostKpi({ label, cents, deltaCents, dash, testid }: { label: string; cents: number; deltaCents?: number; dash: boolean; testid: string }): React.JSX.Element {
	return (
		<div
			data-testid={testid}
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 8,
				padding: 18,
				background: "var(--bg-elevated)",
				border: "1px solid var(--border-default)",
				borderRadius: "var(--radius-lg)",
			}}
		>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-tertiary)" }}>
				{label}
			</span>
			<span
				data-testid={`${testid}-figure`}
				style={{ fontFamily: "var(--font-mono)", fontSize: 30, fontWeight: 700, lineHeight: 1, color: dash ? "var(--text-tertiary)" : "var(--text-primary)", letterSpacing: "-0.01em" }}
			>
				{dash ? DASH : formatCents(cents)}
			</span>
			{!dash && deltaCents !== undefined && deltaCents !== 0 && (
				<span data-testid={`${testid}-delta`} style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: costDeltaColor(deltaCents) }}>
					{/* e-AC-9: a rising cost points UP and is critical-toned (NOT green); a falling cost is green. */}
					{deltaCents > 0 ? "▲" : "▼"} {formatCents(Math.abs(deltaCents))} vs prior period
				</span>
			)}
		</div>
	);
}

function CostSection({
	infraCents,
	infraDash,
	infraBasis,
	pollinationCents,
	pollinationDash,
	pollinationLines,
	infraDeltaCents,
}: {
	infraCents: number;
	infraDash: boolean;
	infraBasis: RoiCostBasisTag;
	pollinationCents: number;
	pollinationDash: boolean;
	pollinationLines: readonly { label: string; cents: number }[];
	infraDeltaCents?: number;
}): React.JSX.Element {
	return (
		<Panel title="Cost" eyebrow="infra · pollination">
			<div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 12, marginBottom: 6 }}>
				<CostKpi testid="infra-kpi" label={basisIsModeled(infraBasis) ? "Infra (allocated, est.)" : "Infra cost"} cents={infraCents} deltaCents={infraDeltaCents} dash={infraDash} />
				<CostKpi testid="pollination-kpi" label="Pollination cost" cents={pollinationCents} dash={pollinationDash} />
			</div>
			{/* The itemized pollination split (Haiku skillify + DeepLake GPU). */}
			<div data-testid="pollination-lines">
				{pollinationDash || pollinationLines.length === 0 ? (
					<div style={{ padding: "10px 6px", fontSize: 13, color: "var(--text-tertiary)" }}>
						{pollinationDash ? "Pollination cost unavailable." : "No pollination contributors yet."}
					</div>
				) : (
					pollinationLines.map((l, i) => (
						<div key={l.label || i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 6px", borderTop: "1px solid var(--border-subtle)" }}>
							<Caption>{l.label}</Caption>
							<span style={{ flex: 1 }} />
							<span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text-secondary)" }}>{formatCents(l.cents)}</span>
						</div>
					))
				)}
			</div>
		</Panel>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// The ROLLUPS section (e-AC-13/e-AC-14/e-AC-15) — a dimension switch over view.rollups.
// The component does NO grouping; the daemon already grouped each dimension (read-time GROUP BY).
// ─────────────────────────────────────────────────────────────────────────────

/** The dimension switch tab (mono pill, honey when active — mirrors the Logs/Sync tabs). */
function DimTab({ label, active, onClick, testid }: { label: string; active: boolean; onClick: () => void; testid: string }): React.JSX.Element {
	return (
		<button
			type="button"
			data-testid={testid}
			aria-pressed={active}
			onClick={onClick}
			style={{
				height: 30,
				padding: "0 12px",
				background: active ? "var(--honey-subtle)" : "var(--bg-elevated)",
				border: `1px solid ${active ? "var(--honey-border)" : "var(--border-default)"}`,
				borderRadius: "var(--radius-full)",
				color: active ? "var(--honey)" : "var(--text-secondary)",
				fontFamily: "var(--font-sans)",
				fontSize: 12,
				fontWeight: 600,
				cursor: "pointer",
			}}
		>
			{label}
		</button>
	);
}

/** All dimensions in display order; the page only offers those the daemon actually shipped a rollup for. */
const DIMENSIONS: readonly RoiRollupDimension[] = ["org", "team", "agent", "project"];

function RollupTable({ rollup, perUserAvailable }: { rollup: RoiRollup; perUserAvailable: boolean }): React.JSX.Element {
	return (
		<div data-testid={`rollup-${rollup.dimension}`}>
			{/* e-AC-15: a mixed-basis rollup is flagged with a caption, not blended into one net. */}
			{rollup.mixedBasis && (
				<div data-testid="mixed-basis-caption" style={{ padding: "8px 6px", marginBottom: 4, fontSize: 12, color: "var(--severity-warning)", fontFamily: "var(--font-mono)" }}>
					mixed measured + allocated — rows are not summed into one net
				</div>
			)}
			{rollup.rows.length === 0 ? (
				<div style={{ padding: "12px 6px", fontSize: 13, color: "var(--text-tertiary)" }}>No {rollup.dimension} rows yet.</div>
			) : (
				<>
					<div style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: 12, padding: "4px 6px 8px" }}>
						{["", "saved", "infra", "net"].map((h, i) => (
							<span key={i} style={{ fontFamily: "var(--font-mono)", fontSize: 10, textTransform: "uppercase", letterSpacing: "0.06em", color: "var(--text-tertiary)", textAlign: i === 0 ? "left" : "right" }}>
								{h}
							</span>
						))}
					</div>
					{rollup.rows.map((row, i) => {
						const allocated = basisIsModeled(row.costBasis);
						return (
							<div key={row.key || i} data-testid={`rollup-row-${rollup.dimension}-${row.key}`} style={{ display: "grid", gridTemplateColumns: "1fr auto auto auto", gap: 12, alignItems: "center", padding: "9px 6px", borderTop: "1px solid var(--border-subtle)" }}>
								<span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
									<span style={{ fontSize: 13, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{row.label || row.key}</span>
									{allocated && (
										<span data-testid={`rollup-allocated-${row.key}`} style={{ display: "inline-flex" }}>
											<Badge tone="warning" mono>
												allocated est.
											</Badge>
										</span>
									)}
								</span>
								<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-primary)", textAlign: "right" }}>{formatCents(row.measuredSavingsCents)}</span>
								<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: allocated ? "var(--text-secondary)" : "var(--text-primary)", textAlign: "right" }}>
									{allocated ? formatCents(row.infraCostCents, true) : formatCents(row.infraCostCents)}
								</span>
								<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, fontWeight: 600, color: netSignColor(row.netCents), textAlign: "right" }}>
									{/* An allocated net carries the est. marker (e-AC-15); honey never encodes the sign (e-AC-4). */}
									{allocated ? formatCents(row.netCents, true) : formatCents(row.netCents)}
								</span>
							</div>
						);
					})}
				</>
			)}
			{/* e-AC-14: per-user is shown ONLY when the availability flag is true; else an info empty state. */}
			{rollup.dimension === "agent" && !perUserAvailable && (
				<div data-testid="per-user-empty" style={{ marginTop: 10, padding: "10px 12px", background: "var(--severity-info-bg)", border: "1px solid var(--severity-info)", borderRadius: "var(--radius-md)" }}>
					<Caption color="var(--severity-info)">Per-user requires verified login — sign in to attribute ROI per person.</Caption>
				</div>
			)}
		</div>
	);
}

function RollupsSection({ rollups, perUserAvailable }: { rollups: readonly RoiRollup[]; perUserAvailable: boolean }): React.JSX.Element {
	// The dimensions the daemon actually shipped, in display order (the component does NO grouping).
	const available = DIMENSIONS.filter((d) => rollups.some((r) => r.dimension === d));
	const [dim, setDim] = React.useState<RoiRollupDimension>(available[0] ?? "org");
	// Keep the active dimension valid if the available set changes between hydrations.
	const activeDim = available.includes(dim) ? dim : (available[0] ?? "org");
	const active = rollups.find((r) => r.dimension === activeDim);

	return (
		<Panel
			title="Rollups"
			eyebrow="org · team · agent · project"
			right={
				<div style={{ display: "flex", gap: 6 }}>
					{available.map((d) => (
						<DimTab key={d} testid={`rollup-tab-${d}`} label={d} active={d === activeDim} onClick={() => setDim(d)} />
					))}
				</div>
			}
		>
			{available.length === 0 || active === undefined ? (
				<div style={{ padding: "12px 6px", fontSize: 13, color: "var(--text-tertiary)" }}>No rollups yet.</div>
			) : (
				<RollupTable rollup={active} perUserAvailable={perUserAvailable} />
			)}
		</Panel>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// The not-authenticated gate (e-AC-7) — redacted status + a Settings CTA. NO secret.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ledger gate the page shows when the ROI read is `unauthenticated` (e-AC-7). It renders ONLY a
 * redacted status line ("not connected") + a Settings CTA — NO token/secret/credential value reaches the
 * page (the view-model carries none by construction; this gate renders no credential field at all).
 */
function AuthGate(): React.JSX.Element {
	return (
		<Panel title="ROI ledger" eyebrow="locked">
			<div data-testid="auth-gate" style={{ display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 12, padding: "20px 8px" }}>
				<span data-testid="auth-redacted-status" style={{ display: "inline-flex" }}>
					<Badge tone="neutral" mono dot>
						not connected
					</Badge>
				</span>
				<span style={{ fontSize: 14, color: "var(--text-secondary)", maxWidth: 460 }}>
					Connect Honeycomb to read the shared ROI ledger. The dashboard never holds your credentials — the daemon is the sole egress.
				</span>
				<Button variant="primary" size="sm" data-testid="auth-settings-cta" onClick={() => { window.location.hash = SETTINGS_ROUTE; }}>
					Open Settings
				</Button>
			</div>
		</Panel>
	);
}

// ─────────────────────────────────────────────────────────────────────────────
// The routed page.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The ROI page (PRD-060e). Hydrates the composite {@link RoiView} (two `usePoll` loops — billing ~60s,
 * token per-session) + the {@link RoiTrendView} (fetch-on-mount + explicit refetch on a range change,
 * since `usePoll` only re-arms on `ms`). It is a PURE function of those two view-models: it switches each
 * section on its `status` and renders the four-signal measured-vs-modeled language, the honey-frame net,
 * the dimension rollups, and the degraded states — never fetching/computing beyond these hydrations.
 *
 * The whole page is gated behind a Settings CTA when the ROI read is `unauthenticated` (e-AC-7): only a
 * redacted status renders, no ledger.
 */
export function RoiPage({ wire }: PageProps): React.JSX.Element {
	const { scope } = useScope();
	const projectId = scope.project;

	const [view, setView] = React.useState<RoiView>(EMPTY_ROI_VIEW);
	const [trend, setTrend] = React.useState<RoiTrendView>(EMPTY_ROI_TREND);
	const [range, setRange] = React.useState<string>(DEFAULT_RANGE);
	const [retrying, setRetrying] = React.useState(false);

	// Hydrate the composite view. Both poll loops call the SAME read (the daemon assembles billing +
	// token into one view-model); the two cadences exist per the page-frame idiom — a slow billing loop
	// and a faster token loop — so a token change surfaces sooner than the ~60s billing refresh.
	const loadView = React.useCallback(async (): Promise<void> => {
		const next = await wire.roi(projectId);
		setView(next);
	}, [wire, projectId]);

	// Two usePoll loops (e-AC: page-frame idiom): billing (~60s) + token (per-session/faster).
	usePoll(loadView, BILLING_POLL_MS);
	usePoll(loadView, TOKEN_POLL_MS);

	// The trend needs an EXPLICIT fetch-on-change effect: usePoll only re-arms on `ms`, so a range change
	// would not refetch under it. This effect refetches whenever the range (or scope/project) changes.
	React.useEffect(() => {
		let alive = true;
		void (async () => {
			const next = await wire.roiTrend(range, projectId);
			if (alive) setTrend(next);
		})();
		return () => {
			alive = false;
		};
	}, [wire, range, projectId]);

	// The scoped Retry (e-AC-6): re-read the view (and the trend) when billing was unreachable.
	const onRetry = React.useCallback(async (): Promise<void> => {
		setRetrying(true);
		try {
			await loadView();
			const t = await wire.roiTrend(range, projectId);
			setTrend(t);
		} finally {
			setRetrying(false);
		}
	}, [loadView, wire, range, projectId]);

	// e-AC-7: the entire ledger is gated when the savings read is unauthenticated (no credentials). Only a
	// redacted status renders — no figure, no token, no secret.
	const unauthenticated = view.savings.status === "unauthenticated" || view.net.status === "unauthenticated";

	const scopeEyebrow = view.scopedAcrossDevices ? "across devices" : "this device";

	return (
		<PageFrame title="ROI" eyebrow={`net-roi ledger · ${scopeEyebrow}`}>
			{unauthenticated ? (
				<AuthGate />
			) : (
				<div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
					<NetHero net={view.net} onRetry={() => void onRetry()} retrying={retrying} />
					<SavingsSection savings={view.savings} />
					<CostSection
						infraCents={view.infra.cents}
						infraDash={isDashStatus(view.infra.status)}
						infraBasis={view.infra.costBasis}
						pollinationCents={view.pollination.cents}
						pollinationDash={isDashStatus(view.pollination.status)}
						pollinationLines={view.pollination.lines}
					/>
					<Panel
						title="Trend"
						eyebrow="measured (solid) · modeled (dashed)"
						right={
							<div style={{ display: "flex", gap: 6 }}>
								{TREND_RANGES.map((r) => (
									<DimTab key={r} testid={`trend-range-${r}`} label={r} active={r === range} onClick={() => setRange(r)} />
								))}
							</div>
						}
					>
						<RoiTrendChart trend={trend} />
					</Panel>
					<RollupsSection rollups={view.rollups} perUserAvailable={view.perUserAvailable} />

					{/* e-AC-8: the persistent page-foot footnote, sourced from the SAME assumption field as the
					    ⓘ popover (one source, not hardcoded copy). */}
					<div
						data-testid="assumption-footnote"
						style={{ marginTop: 4, padding: "12px 6px", borderTop: "1px solid var(--border-subtle)", fontSize: 12, lineHeight: "18px", color: "var(--text-tertiary)" }}
					>
						<span style={{ fontWeight: 600, color: "var(--text-secondary)" }}>Modeled estimate assumption: </span>
						{view.savings.assumption.assumptionText !== "" ? view.savings.assumption.assumptionText : "Assumption not yet provided."}
						{view.ratesAsOf !== "" && <span style={{ marginLeft: 8, fontFamily: "var(--font-mono)" }}>· rates as of {view.ratesAsOf}</span>}
					</div>
				</div>
			)}
		</PageFrame>
	);
}
