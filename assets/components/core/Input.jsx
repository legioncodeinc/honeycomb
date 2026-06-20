import React from "react";

/**
 * Honeycomb text input. `mono` renders the value in JetBrains Mono —
 * use it for memory keys, recall queries, ids, and paths (the texture
 * of trust). Focus lights the honey ring.
 */
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
}) {
  const [focused, setFocused] = React.useState(false);
  const heights = { sm: 32, md: 40, lg: 48 };
  const h = heights[size] || 40;

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
