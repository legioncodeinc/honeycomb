import React from "react";

/**
 * Honeycomb status badge / pill. Compact label for memory and session
 * states. Tones map to the semantic palette; `verified` is the
 * source-backed (green) state, `honey` the brand highlight, `pollinate`
 * the consolidation state.
 */
export function Badge({ children, tone = "neutral", mono = false, dot = false, style, ...rest }) {
  const tones = {
    neutral:  { bg: "var(--bg-subtle)",            fg: "var(--text-secondary)", bd: "var(--border-strong)" },
    honey:    { bg: "var(--honey-subtle)",         fg: "var(--honey)",          bd: "var(--honey-border)" },
    verified: { bg: "var(--severity-success-bg)",  fg: "var(--verified)",       bd: "var(--verified)" },
    pollinate:    { bg: "var(--pollinate-subtle)",         fg: "var(--pollinate)",          bd: "var(--pollinate-border)" },
    info:     { bg: "var(--severity-info-bg)",     fg: "var(--severity-info)",  bd: "var(--severity-info)" },
    warning:  { bg: "var(--severity-warning-bg)",  fg: "var(--severity-warning)", bd: "var(--severity-warning)" },
    critical: { bg: "var(--severity-critical-bg)", fg: "var(--severity-critical)", bd: "var(--severity-critical)" },
  };
  const t = tones[tone] || tones.neutral;

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
      {...rest}
    >
      {dot && (
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: t.fg, flex: "none" }} />
      )}
      {children}
    </span>
  );
}
