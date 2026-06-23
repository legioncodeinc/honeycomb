import React from "react";

/**
 * Honeycomb surface Card. Background bg.elevated, 1px border, 12px
 * radius, no shadow (the brand uses border, not elevation, for cards).
 * Set `glow` to lift a single focused card with the honey/pollinate glow.
 */
export function Card({ children, glow = "none", padding = 20, interactive = false, style, ...rest }) {
  const glows = {
    none: "none",
    honey: "var(--glow-honey)",
    pollinate: "var(--glow-pollinate)",
  };
  const borderColor =
    glow === "honey" ? "var(--honey-border)" :
    glow === "pollinate" ? "var(--pollinate-border)" :
    "var(--border-default)";

  return (
    <div
      style={{
        background: "var(--bg-elevated)",
        border: `1px solid ${borderColor}`,
        borderRadius: "var(--radius-lg)",
        boxShadow: glows[glow] || "none",
        padding,
        transition: interactive
          ? "border-color var(--dur-base) var(--ease-out), background var(--dur-base) var(--ease-out)"
          : "none",
        ...style,
      }}
      onMouseEnter={interactive ? (e) => { e.currentTarget.style.borderColor = "var(--border-strong)"; } : undefined}
      onMouseLeave={interactive ? (e) => { e.currentTarget.style.borderColor = borderColor; } : undefined}
      {...rest}
    >
      {children}
    </div>
  );
}
