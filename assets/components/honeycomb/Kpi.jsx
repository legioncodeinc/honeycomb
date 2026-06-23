import React from "react";

/**
 * Kpi — a dashboard metric tile. Renders one big mono value with a
 * label and optional delta. Used for the dashboard KPIs panel
 * (memories, sessions, estimated savings). Honey accent by default.
 */
export function Kpi({ label, value, unit, delta, accent = "honey", style, ...rest }) {
  const accents = {
    honey: "var(--honey)",
    pollinate: "var(--pollinate)",
    verified: "var(--verified)",
    neutral: "var(--text-primary)",
  };
  const c = accents[accent] || accents.honey;
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
      {...rest}
    >
      <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-xs)", textTransform: "uppercase", letterSpacing: "0.08em", color: "var(--text-tertiary)" }}>
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
          {deltaUp ? "▲" : "▼"} {Math.abs(delta)}{unit === "%" ? "" : ""} this week
        </span>
      )}
    </div>
  );
}
