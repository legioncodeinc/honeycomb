import React from "react";

/**
 * Honeycomb Button. Honey is the brand action; the scarcity rule means
 * one primary (honey) button per visible region. Secondary and ghost
 * carry the rest. Pollinate variant is reserved for Pollinating / maintenance.
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
}) {
  const sizes = {
    sm: { height: 32, padding: "0 12px", font: "var(--text-sm)", gap: 6 },
    md: { height: 40, padding: "0 16px", font: "var(--text-sm)", gap: 8 },
    lg: { height: 48, padding: "0 22px", font: "var(--text-base)", gap: 8 },
  };
  const s = sizes[size] || sizes.md;

  const variants = {
    primary: {
      background: "var(--honey)",
      color: "var(--honey-on)",
      border: "1px solid transparent",
    },
    secondary: {
      background: "var(--bg-elevated)",
      color: "var(--text-primary)",
      border: "1px solid var(--border-strong)",
    },
    ghost: {
      background: "transparent",
      color: "var(--text-secondary)",
      border: "1px solid transparent",
    },
    pollinate: {
      background: "var(--pollinate-subtle)",
      color: "var(--pollinate)",
      border: "1px solid var(--pollinate-border)",
    },
    danger: {
      background: "var(--severity-critical-bg)",
      color: "var(--severity-critical)",
      border: "1px solid var(--severity-critical)",
    },
  };
  const v = variants[variant] || variants.primary;

  const base = {
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
    transition: "background var(--dur-fast) var(--ease-out), transform var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out)",
    whiteSpace: "nowrap",
    userSelect: "none",
    ...v,
    ...style,
  };

  const hoverBg = {
    primary: "var(--honey-hover)",
    secondary: "var(--bg-subtle)",
    ghost: "var(--bg-elevated)",
    pollinate: "var(--pollinate-subtle)",
    danger: "var(--severity-critical-bg)",
  };

  const onEnter = (e) => { if (!disabled) e.currentTarget.style.background = hoverBg[variant] || hoverBg.primary; };
  const onLeave = (e) => { if (!disabled) e.currentTarget.style.background = v.background; };
  const onDown = (e) => { if (!disabled) e.currentTarget.style.transform = "translateY(1px)"; };
  const onUp = (e) => { if (!disabled) e.currentTarget.style.transform = "none"; };

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
