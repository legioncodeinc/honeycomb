/**
 * The Honeycomb design-system PRIMITIVES, ported to TSX — PRD-024 Wave 2 (AC-1, D-5).
 *
 * These are the SAME five primitives the design system exposes at runtime as
 * `window.HoneycombDesignSystem_d60529` (`assets/components/core/*` +
 * `assets/components/honeycomb/*`). The UI kit's `index.html` pulls them from that global
 * via in-browser Babel; D-1 forbids that (no CDN React, no `@babel/standalone`). So we PORT
 * the JSX sources into real typed TSX modules that esbuild compiles at build time and
 * bundles — the design is reused verbatim (same tokens, same markup, same variants), not
 * forked. Every visual value comes from a `var(--…)` design token (`assets/styles.css`).
 */

import React from "react";

// ── Button ────────────────────────────────────────────────────────────────────

/** Button visual variants (honey is the brand action; pollinate is the Pollinating/maintenance state). */
export type ButtonVariant = "primary" | "secondary" | "ghost" | "pollinate" | "danger";
/** Button sizes (`lg` is the recall-bar action). */
export type ButtonSize = "sm" | "md" | "lg";

/** Props for {@link Button}. Extends a native button so `onClick`/`title`/etc. pass through. */
export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
	variant?: ButtonVariant;
	size?: ButtonSize;
	iconLeft?: React.ReactNode;
	iconRight?: React.ReactNode;
}

/**
 * The Honeycomb button (ported from `assets/components/core/Button.jsx`). One primary (honey)
 * action per region; `pollinate` is reserved for the Pollinating trigger. The hover/press handlers
 * mutate inline style exactly as the DS source does.
 */
export function Button({
	children,
	variant = "primary",
	size = "md",
	disabled = false,
	iconLeft,
	iconRight,
	onClick,
	type = "button",
	style,
	...rest
}: ButtonProps): React.JSX.Element {
	const sizes: Record<ButtonSize, { height: number; padding: string; font: string; gap: number }> = {
		sm: { height: 32, padding: "0 12px", font: "var(--text-sm)", gap: 6 },
		md: { height: 40, padding: "0 16px", font: "var(--text-sm)", gap: 8 },
		lg: { height: 48, padding: "0 22px", font: "var(--text-base)", gap: 8 },
	};
	const s = sizes[size] ?? sizes.md;

	const variants: Record<ButtonVariant, React.CSSProperties> = {
		primary: { background: "var(--honey)", color: "var(--honey-on)", border: "1px solid transparent" },
		secondary: { background: "var(--bg-elevated)", color: "var(--text-primary)", border: "1px solid var(--border-strong)" },
		ghost: { background: "transparent", color: "var(--text-secondary)", border: "1px solid transparent" },
		pollinate: { background: "var(--pollinate-subtle)", color: "var(--pollinate)", border: "1px solid var(--pollinate-border)" },
		danger: { background: "var(--severity-critical-bg)", color: "var(--severity-critical)", border: "1px solid var(--severity-critical)" },
	};
	const v = variants[variant] ?? variants.primary;

	const base: React.CSSProperties = {
		display: "inline-flex",
		alignItems: "center",
		justifyContent: "center",
		gap: s.gap,
		height: s.height,
		padding: s.padding,
		fontFamily: "var(--font-sans)",
		fontSize: s.font,
		fontWeight: 600,
		letterSpacing: "-0.01em",
		lineHeight: 1,
		borderRadius: "var(--radius-md)",
		cursor: disabled ? "not-allowed" : "pointer",
		opacity: disabled ? 0.45 : 1,
		transition:
			"background var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)",
		whiteSpace: "nowrap",
		userSelect: "none",
		...v,
		...style,
	};

	const hoverBg: Record<ButtonVariant, string> = {
		primary: "var(--honey-hover)",
		secondary: "var(--bg-subtle)",
		ghost: "var(--bg-elevated)",
		pollinate: "var(--pollinate-subtle)",
		danger: "var(--severity-critical-bg)",
	};

	const onEnter = (e: React.MouseEvent<HTMLButtonElement>): void => {
		if (!disabled) e.currentTarget.style.background = hoverBg[variant] ?? hoverBg.primary;
	};
	const onLeave = (e: React.MouseEvent<HTMLButtonElement>): void => {
		if (!disabled) e.currentTarget.style.background = String(v.background);
	};
	const onDown = (e: React.MouseEvent<HTMLButtonElement>): void => {
		if (!disabled) e.currentTarget.style.transform = "translateY(1px)";
	};
	const onUp = (e: React.MouseEvent<HTMLButtonElement>): void => {
		if (!disabled) e.currentTarget.style.transform = "none";
	};

	return (
		<button
			type={type}
			disabled={disabled}
			onClick={onClick}
			style={base}
			onMouseEnter={onEnter}
			onMouseLeave={onLeave}
			onMouseDown={onDown}
			onMouseUp={onUp}
			{...rest}
		>
			{iconLeft}
			{children}
			{iconRight}
		</button>
	);
}

// ── Badge ───────────────────────────────────────────────────────────────────

/** Badge tones map to the semantic palette (`verified` green, `honey` brand, `pollinate` violet). */
export type BadgeTone = "neutral" | "honey" | "verified" | "pollinate" | "info" | "warning" | "critical";

/** Props for {@link Badge}. */
export interface BadgeProps {
	children?: React.ReactNode;
	tone?: BadgeTone;
	mono?: boolean;
	dot?: boolean;
	style?: React.CSSProperties;
}

/** The Honeycomb status pill (ported from `assets/components/core/Badge.jsx`). */
export function Badge({ children, tone = "neutral", mono = false, dot = false, style }: BadgeProps): React.JSX.Element {
	const tones: Record<BadgeTone, { bg: string; fg: string; bd: string }> = {
		neutral: { bg: "var(--bg-subtle)", fg: "var(--text-secondary)", bd: "var(--border-strong)" },
		honey: { bg: "var(--honey-subtle)", fg: "var(--honey)", bd: "var(--honey-border)" },
		verified: { bg: "var(--severity-success-bg)", fg: "var(--verified)", bd: "var(--verified)" },
		pollinate: { bg: "var(--pollinate-subtle)", fg: "var(--pollinate)", bd: "var(--pollinate-border)" },
		info: { bg: "var(--severity-info-bg)", fg: "var(--severity-info)", bd: "var(--severity-info)" },
		warning: { bg: "var(--severity-warning-bg)", fg: "var(--severity-warning)", bd: "var(--severity-warning)" },
		critical: { bg: "var(--severity-critical-bg)", fg: "var(--severity-critical)", bd: "var(--severity-critical)" },
	};
	const t = tones[tone] ?? tones.neutral;

	return (
		<span
			style={{
				display: "inline-flex",
				alignItems: "center",
				gap: 6,
				height: 22,
				padding: "0 9px",
				background: t.bg,
				color: t.fg,
				border: `1px solid ${t.bd}`,
				borderRadius: "var(--radius-full)",
				fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
				fontSize: "var(--text-xs)",
				fontWeight: 600,
				letterSpacing: mono ? "0.02em" : "0",
				lineHeight: 1,
				whiteSpace: "nowrap",
				...style,
			}}
		>
			{dot && <span style={{ width: 6, height: 6, borderRadius: "50%", background: t.fg, flex: "none" }} />}
			{children}
		</span>
	);
}

// ── Input ───────────────────────────────────────────────────────────────────

/** Props for {@link Input}. `mono` renders the value in JetBrains Mono (recall queries, ids). */
export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, "size" | "style"> {
	mono?: boolean;
	size?: ButtonSize;
	iconLeft?: React.ReactNode;
	style?: React.CSSProperties;
}

/** The Honeycomb text input (ported from `assets/components/core/Input.jsx`). Focus lights the honey ring. */
export function Input({
	value,
	defaultValue,
	onChange,
	placeholder,
	mono = false,
	size = "md",
	disabled = false,
	iconLeft,
	type = "text",
	style,
	...rest
}: InputProps): React.JSX.Element {
	const [focused, setFocused] = React.useState(false);
	const heights: Record<ButtonSize, number> = { sm: 32, md: 40, lg: 48 };
	const h = heights[size] ?? 40;

	return (
		<div
			style={{
				display: "flex",
				alignItems: "center",
				gap: 8,
				height: h,
				padding: "0 12px",
				background: "var(--bg-surface)",
				border: `1px solid ${focused ? "var(--honey)" : "var(--border-default)"}`,
				borderRadius: "var(--radius-md)",
				boxShadow: focused ? "0 0 0 3px var(--honey-subtle)" : "none",
				transition: "border-color var(--dur-fast) var(--ease-out), box-shadow var(--dur-fast) var(--ease-out)",
				opacity: disabled ? 0.5 : 1,
				...style,
			}}
		>
			{iconLeft && <span style={{ display: "inline-flex", color: "var(--text-tertiary)", flex: "none" }}>{iconLeft}</span>}
			<input
				type={type}
				value={value}
				defaultValue={defaultValue}
				onChange={onChange}
				placeholder={placeholder}
				disabled={disabled}
				onFocus={() => setFocused(true)}
				onBlur={() => setFocused(false)}
				style={{
					flex: 1,
					minWidth: 0,
					background: "transparent",
					border: "none",
					outline: "none",
					color: "var(--text-primary)",
					fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
					fontSize: mono ? "var(--text-sm)" : "var(--text-base)",
					letterSpacing: mono ? "0.01em" : "0",
				}}
				{...rest}
			/>
		</div>
	);
}

// ── Kpi ───────────────────────────────────────────────────────────────────────

/** Kpi accent colors. */
export type KpiAccent = "honey" | "pollinate" | "verified" | "neutral";

/** Props for {@link Kpi} — one dashboard metric tile. */
export interface KpiProps {
	label: string;
	value: string | number;
	unit?: string;
	delta?: number;
	accent?: KpiAccent;
	style?: React.CSSProperties;
}

/** The dashboard metric tile (ported from `assets/components/honeycomb/Kpi.jsx`). */
export function Kpi({ label, value, unit, delta, accent = "honey", style }: KpiProps): React.JSX.Element {
	const accents: Record<KpiAccent, string> = {
		honey: "var(--honey)",
		pollinate: "var(--pollinate)",
		verified: "var(--verified)",
		neutral: "var(--text-primary)",
	};
	const c = accents[accent] ?? accents.honey;
	const deltaUp = typeof delta === "number" ? delta >= 0 : null;

	return (
		<div
			style={{
				display: "flex",
				flexDirection: "column",
				gap: 8,
				padding: 18,
				background: "var(--bg-elevated)",
				border: "1px solid var(--border-default)",
				borderRadius: "var(--radius-lg)",
				...style,
			}}
		>
			<span
				style={{
					fontFamily: "var(--font-mono)",
					fontSize: "var(--text-xs)",
					textTransform: "uppercase",
					letterSpacing: "0.08em",
					color: "var(--text-tertiary)",
				}}
			>
				{label}
			</span>
			<div style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 30, fontWeight: 700, lineHeight: 1, color: c, letterSpacing: "-0.01em" }}>
					{value}
				</span>
				{unit && <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", color: "var(--text-tertiary)" }}>{unit}</span>}
			</div>
			{delta !== undefined && delta !== null && (
				<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: deltaUp ? "var(--verified)" : "var(--severity-critical)" }}>
					{deltaUp ? "▲" : "▼"} {Math.abs(delta)} this week
				</span>
			)}
		</div>
	);
}

// ── MemoryCard ─────────────────────────────────────────────────────────────────

/** Props for {@link MemoryCard} — one recalled or stored memory. */
export interface MemoryCardProps {
	memoryKey: string;
	snippet: string;
	source?: string;
	score?: number;
	scope?: string;
	verified?: boolean;
	pollinating?: boolean;
	/** Provenance class from the recall engine (PRD-027): distilled `memory` vs raw `session`. */
	kind?: "memory" | "session";
	/** `true` iff a drill-down raw session row — the card visually demotes it (dim + a tag). */
	secondary?: boolean;
	style?: React.CSSProperties;
}

/** The signature Honeycomb surface (ported from `assets/components/honeycomb/MemoryCard.jsx`). */
export function MemoryCard({
	memoryKey,
	snippet,
	source,
	score,
	scope = "personal",
	verified = false,
	pollinating = false,
	kind,
	secondary = false,
	style,
}: MemoryCardProps): React.JSX.Element {
	const accent = pollinating ? "var(--pollinate)" : verified ? "var(--verified)" : "var(--honey)";

	return (
		<div
			style={{
				display: "flex",
				gap: 14,
				padding: 16,
				background: "var(--bg-elevated)",
				border: "1px solid var(--border-default)",
				borderRadius: "var(--radius-lg)",
				transition: "border-color var(--dur-base) var(--ease-out)",
				// PRD-027 AC-4: a raw-session drill-down hit is visually demoted (dimmed) below
				// the distilled facts the engine ranked above it — the score+order are the engine's.
				opacity: secondary ? 0.72 : 1,
				...style,
			}}
		>
			<div style={{ flex: "none", paddingTop: 2 }}>
				<div
					style={{
						width: 34,
						height: 38,
						clipPath: "polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%)",
						background: accent,
						opacity: pollinating ? 0.9 : 1,
						animation: pollinating ? "hc-pollinate-pulse var(--dur-pollinate) var(--ease-in-out) infinite alternate" : "none",
					}}
				/>
			</div>

			<div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 7 }}>
				<div style={{ display: "flex", alignItems: "center", gap: 8 }}>
					<span
						style={{
							fontFamily: "var(--font-mono)",
							fontSize: "var(--text-sm)",
							fontWeight: 600,
							color: accent,
							whiteSpace: "nowrap",
							overflow: "hidden",
							textOverflow: "ellipsis",
						}}
					>
						{memoryKey}
					</span>
					{verified && !pollinating && (
						<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--verified)", flex: "none" }}>✓ verified</span>
					)}
					{(secondary || kind === "session") && !pollinating && (
						<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", flex: "none" }}>session</span>
					)}
					{pollinating && <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--pollinate)", flex: "none" }}>pollinating…</span>}
				</div>

				<div style={{ fontSize: "var(--text-sm)", lineHeight: "20px", color: "var(--text-primary)" }}>{snippet}</div>

				<div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 1 }}>
					{source && (
						<span
							style={{
								fontFamily: "var(--font-mono)",
								fontSize: 11,
								color: "var(--text-tertiary)",
								whiteSpace: "nowrap",
								overflow: "hidden",
								textOverflow: "ellipsis",
								maxWidth: 220,
							}}
						>
							{source}
						</span>
					)}
					<span style={{ flex: 1 }} />
					<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>{scope}</span>
					{typeof score === "number" && (
						<span style={{ fontFamily: "var(--font-mono)", fontSize: 11, fontWeight: 600, color: "var(--text-secondary)" }}>
							{score.toFixed(2)}
						</span>
					)}
				</div>
			</div>

			<style>{"@keyframes hc-pollinate-pulse { from { opacity: .5 } to { opacity: 1 } }"}</style>
		</div>
	);
}
