import React from "react";

/**
 * MemoryCard — the signature Honeycomb surface: one recalled or stored
 * memory. Shows a hex cell, the memory key (mono), a snippet, its
 * source provenance, and a relevance score. `verified` marks a
 * source-backed memory (green); `pollinating` marks one being consolidated.
 */
export function MemoryCard({
  memoryKey,
  snippet,
  source,
  score,
  scope = "personal",
  verified = false,
  pollinating = false,
  onClick,
  style,
  ...rest
}) {
  const accent = pollinating ? "var(--pollinate)" : verified ? "var(--verified)" : "var(--honey)";
  const accentBorder = pollinating ? "var(--pollinate-border)" : verified ? "var(--verified)" : "var(--honey-border)";

  return (
    <div
      onClick={onClick}
      style={{
        display: "flex",
        gap: 14,
        padding: 16,
        background: "var(--bg-elevated)",
        border: "1px solid var(--border-default)",
        borderRadius: "var(--radius-lg)",
        cursor: onClick ? "pointer" : "default",
        transition: "border-color var(--dur-base) var(--ease-out)",
        ...style,
      }}
      onMouseEnter={onClick ? (e) => { e.currentTarget.style.borderColor = accentBorder; } : undefined}
      onMouseLeave={onClick ? (e) => { e.currentTarget.style.borderColor = "var(--border-default)"; } : undefined}
      {...rest}
    >
      {/* hex cell */}
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
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)", fontWeight: 600, color: accent, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {memoryKey}
          </span>
          {verified && !pollinating && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--verified)", flex: "none" }}>✓ verified</span>
          )}
          {pollinating && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--pollinate)", flex: "none" }}>pollinating…</span>
          )}
        </div>

        <div style={{ fontSize: "var(--text-sm)", lineHeight: "20px", color: "var(--text-primary)" }}>
          {snippet}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 1 }}>
          {source && (
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 220 }}>
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

      <style>{`@keyframes hc-pollinate-pulse { from { opacity: .5 } to { opacity: 1 } }`}</style>
    </div>
  );
}
