/* @ds-bundle: {"format":3,"namespace":"HoneycombDesignSystem_d60529","components":[{"name":"Badge","sourcePath":"components/core/Badge.jsx"},{"name":"Button","sourcePath":"components/core/Button.jsx"},{"name":"Card","sourcePath":"components/core/Card.jsx"},{"name":"Input","sourcePath":"components/core/Input.jsx"},{"name":"Kpi","sourcePath":"components/honeycomb/Kpi.jsx"},{"name":"MemoryCard","sourcePath":"components/honeycomb/MemoryCard.jsx"}],"sourceHashes":{"components/core/Badge.jsx":"f22ad3c8f75c","components/core/Button.jsx":"7b5fab0e695d","components/core/Card.jsx":"84e59b812781","components/core/Input.jsx":"5bc39059626a","components/honeycomb/Kpi.jsx":"b8efd7d02894","components/honeycomb/MemoryCard.jsx":"9f80d90338bf","ui_kits/dashboard/components.jsx":"033009c77c1b","ui_kits/dashboard/data.js":"637e7459b336"},"inlinedExternals":[],"unexposedExports":[]} */

(() => {

const __ds_ns = (window.HoneycombDesignSystem_d60529 = window.HoneycombDesignSystem_d60529 || {});

const __ds_scope = {};

(__ds_ns.__errors = __ds_ns.__errors || []);

// components/core/Badge.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Honeycomb status badge / pill. Compact label for memory and session
 * states. Tones map to the semantic palette; `verified` is the
 * source-backed (green) state, `honey` the brand highlight, `pollinate`
 * the consolidation state.
 */
function Badge({
  children,
  tone = "neutral",
  mono = false,
  dot = false,
  style,
  ...rest
}) {
  const tones = {
    neutral: {
      bg: "var(--bg-subtle)",
      fg: "var(--text-secondary)",
      bd: "var(--border-strong)"
    },
    honey: {
      bg: "var(--honey-subtle)",
      fg: "var(--honey)",
      bd: "var(--honey-border)"
    },
    verified: {
      bg: "var(--severity-success-bg)",
      fg: "var(--verified)",
      bd: "var(--verified)"
    },
    pollinate: {
      bg: "var(--pollinate-subtle)",
      fg: "var(--pollinate)",
      bd: "var(--pollinate-border)"
    },
    info: {
      bg: "var(--severity-info-bg)",
      fg: "var(--severity-info)",
      bd: "var(--severity-info)"
    },
    warning: {
      bg: "var(--severity-warning-bg)",
      fg: "var(--severity-warning)",
      bd: "var(--severity-warning)"
    },
    critical: {
      bg: "var(--severity-critical-bg)",
      fg: "var(--severity-critical)",
      bd: "var(--severity-critical)"
    }
  };
  const t = tones[tone] || tones.neutral;
  return /*#__PURE__*/React.createElement("span", _extends({
    style: {
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
      ...style
    }
  }, rest), dot && /*#__PURE__*/React.createElement("span", {
    style: {
      width: 6,
      height: 6,
      borderRadius: "50%",
      background: t.fg,
      flex: "none"
    }
  }), children);
}
Object.assign(__ds_scope, { Badge });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Badge.jsx", error: String((e && e.message) || e) }); }

// components/core/Button.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Honeycomb Button. Honey is the brand action; the scarcity rule means
 * one primary (honey) button per visible region. Secondary and ghost
 * carry the rest. Pollinate variant is reserved for Pollinating / maintenance.
 */
function Button({
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
    sm: {
      height: 32,
      padding: "0 12px",
      font: "var(--text-sm)",
      gap: 6
    },
    md: {
      height: 40,
      padding: "0 16px",
      font: "var(--text-sm)",
      gap: 8
    },
    lg: {
      height: 48,
      padding: "0 22px",
      font: "var(--text-base)",
      gap: 8
    }
  };
  const s = sizes[size] || sizes.md;
  const variants = {
    primary: {
      background: "var(--honey)",
      color: "var(--honey-on)",
      border: "1px solid transparent"
    },
    secondary: {
      background: "var(--bg-elevated)",
      color: "var(--text-primary)",
      border: "1px solid var(--border-strong)"
    },
    ghost: {
      background: "transparent",
      color: "var(--text-secondary)",
      border: "1px solid transparent"
    },
    pollinate: {
      background: "var(--pollinate-subtle)",
      color: "var(--pollinate)",
      border: "1px solid var(--pollinate-border)"
    },
    danger: {
      background: "var(--severity-critical-bg)",
      color: "var(--severity-critical)",
      border: "1px solid var(--severity-critical)"
    }
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
    ...style
  };
  const hoverBg = {
    primary: "var(--honey-hover)",
    secondary: "var(--bg-subtle)",
    ghost: "var(--bg-elevated)",
    pollinate: "var(--pollinate-subtle)",
    danger: "var(--severity-critical-bg)"
  };
  const onEnter = e => {
    if (!disabled) e.currentTarget.style.background = hoverBg[variant] || hoverBg.primary;
  };
  const onLeave = e => {
    if (!disabled) e.currentTarget.style.background = v.background;
  };
  const onDown = e => {
    if (!disabled) e.currentTarget.style.transform = "translateY(1px)";
  };
  const onUp = e => {
    if (!disabled) e.currentTarget.style.transform = "none";
  };
  return /*#__PURE__*/React.createElement("button", _extends({
    type: type,
    disabled: disabled,
    onClick: onClick,
    style: base,
    onMouseEnter: onEnter,
    onMouseLeave: onLeave,
    onMouseDown: onDown,
    onMouseUp: onUp
  }, rest), iconLeft, children, iconRight);
}
Object.assign(__ds_scope, { Button });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Button.jsx", error: String((e && e.message) || e) }); }

// components/core/Card.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Honeycomb surface Card. Background bg.elevated, 1px border, 12px
 * radius, no shadow (the brand uses border, not elevation, for cards).
 * Set `glow` to lift a single focused card with the honey/pollinate glow.
 */
function Card({
  children,
  glow = "none",
  padding = 20,
  interactive = false,
  style,
  ...rest
}) {
  const glows = {
    none: "none",
    honey: "var(--glow-honey)",
    pollinate: "var(--glow-pollinate)"
  };
  const borderColor = glow === "honey" ? "var(--honey-border)" : glow === "pollinate" ? "var(--pollinate-border)" : "var(--border-default)";
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      background: "var(--bg-elevated)",
      border: `1px solid ${borderColor}`,
      borderRadius: "var(--radius-lg)",
      boxShadow: glows[glow] || "none",
      padding,
      transition: interactive ? "border-color var(--dur-base) var(--ease-out), background var(--dur-base) var(--ease-out)" : "none",
      ...style
    },
    onMouseEnter: interactive ? e => {
      e.currentTarget.style.borderColor = "var(--border-strong)";
    } : undefined,
    onMouseLeave: interactive ? e => {
      e.currentTarget.style.borderColor = borderColor;
    } : undefined
  }, rest), children);
}
Object.assign(__ds_scope, { Card });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Card.jsx", error: String((e && e.message) || e) }); }

// components/core/Input.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Honeycomb text input. `mono` renders the value in JetBrains Mono —
 * use it for memory keys, recall queries, ids, and paths (the texture
 * of trust). Focus lights the honey ring.
 */
function Input({
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
  const heights = {
    sm: 32,
    md: 40,
    lg: 48
  };
  const h = heights[size] || 40;
  return /*#__PURE__*/React.createElement("div", {
    style: {
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
      ...style
    }
  }, iconLeft && /*#__PURE__*/React.createElement("span", {
    style: {
      display: "inline-flex",
      color: "var(--text-tertiary)",
      flex: "none"
    }
  }, iconLeft), /*#__PURE__*/React.createElement("input", _extends({
    type: type,
    value: value,
    defaultValue: defaultValue,
    onChange: onChange,
    placeholder: placeholder,
    disabled: disabled,
    onFocus: () => setFocused(true),
    onBlur: () => setFocused(false),
    style: {
      flex: 1,
      minWidth: 0,
      background: "transparent",
      border: "none",
      outline: "none",
      color: "var(--text-primary)",
      fontFamily: mono ? "var(--font-mono)" : "var(--font-sans)",
      fontSize: mono ? "var(--text-sm)" : "var(--text-base)",
      letterSpacing: mono ? "0.01em" : "0"
    }
  }, rest)));
}
Object.assign(__ds_scope, { Input });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/core/Input.jsx", error: String((e && e.message) || e) }); }

// components/honeycomb/Kpi.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * Kpi — a dashboard metric tile. Renders one big mono value with a
 * label and optional delta. Used for the dashboard KPIs panel
 * (memories, sessions, estimated savings). Honey accent by default.
 */
function Kpi({
  label,
  value,
  unit,
  delta,
  accent = "honey",
  style,
  ...rest
}) {
  const accents = {
    honey: "var(--honey)",
    pollinate: "var(--pollinate)",
    verified: "var(--verified)",
    neutral: "var(--text-primary)"
  };
  const c = accents[accent] || accents.honey;
  const deltaUp = typeof delta === "number" ? delta >= 0 : null;
  return /*#__PURE__*/React.createElement("div", _extends({
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 8,
      padding: 18,
      background: "var(--bg-elevated)",
      border: "1px solid var(--border-default)",
      borderRadius: "var(--radius-lg)",
      ...style
    }
  }, rest), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--text-xs)",
      textTransform: "uppercase",
      letterSpacing: "0.08em",
      color: "var(--text-tertiary)"
    }
  }, label), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "baseline",
      gap: 6
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 30,
      fontWeight: 700,
      lineHeight: 1,
      color: c,
      letterSpacing: "-0.01em"
    }
  }, value), unit && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--text-sm)",
      color: "var(--text-tertiary)"
    }
  }, unit)), delta !== undefined && delta !== null && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 12,
      color: deltaUp ? "var(--verified)" : "var(--severity-critical)"
    }
  }, deltaUp ? "▲" : "▼", " ", Math.abs(delta), unit === "%" ? "" : "", " this week"));
}
Object.assign(__ds_scope, { Kpi });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/honeycomb/Kpi.jsx", error: String((e && e.message) || e) }); }

// components/honeycomb/MemoryCard.jsx
try { (() => {
function _extends() { return _extends = Object.assign ? Object.assign.bind() : function (n) { for (var e = 1; e < arguments.length; e++) { var t = arguments[e]; for (var r in t) ({}).hasOwnProperty.call(t, r) && (n[r] = t[r]); } return n; }, _extends.apply(null, arguments); }
/**
 * MemoryCard — the signature Honeycomb surface: one recalled or stored
 * memory. Shows a hex cell, the memory key (mono), a snippet, its
 * source provenance, and a relevance score. `verified` marks a
 * source-backed memory (green); `pollinating` marks one being consolidated.
 */
function MemoryCard({
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
  return /*#__PURE__*/React.createElement("div", _extends({
    onClick: onClick,
    style: {
      display: "flex",
      gap: 14,
      padding: 16,
      background: "var(--bg-elevated)",
      border: "1px solid var(--border-default)",
      borderRadius: "var(--radius-lg)",
      cursor: onClick ? "pointer" : "default",
      transition: "border-color var(--dur-base) var(--ease-out)",
      ...style
    },
    onMouseEnter: onClick ? e => {
      e.currentTarget.style.borderColor = accentBorder;
    } : undefined,
    onMouseLeave: onClick ? e => {
      e.currentTarget.style.borderColor = "var(--border-default)";
    } : undefined
  }, rest), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: "none",
      paddingTop: 2
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      width: 34,
      height: 38,
      clipPath: "polygon(50% 0, 100% 25%, 100% 75%, 50% 100%, 0 75%, 0 25%)",
      background: accent,
      opacity: pollinating ? 0.9 : 1,
      animation: pollinating ? "hc-pollinate-pulse var(--dur-pollinate) var(--ease-in-out) infinite alternate" : "none"
    }
  })), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1,
      minWidth: 0,
      display: "flex",
      flexDirection: "column",
      gap: 7
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: "var(--text-sm)",
      fontWeight: 600,
      color: accent,
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis"
    }
  }, memoryKey), verified && !pollinating && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 11,
      color: "var(--verified)",
      flex: "none"
    }
  }, "\u2713 verified"), pollinating && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 11,
      color: "var(--pollinate)",
      flex: "none"
    }
  }, "pollinating\u2026")), /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: "var(--text-sm)",
      lineHeight: "20px",
      color: "var(--text-primary)"
    }
  }, snippet), /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      marginTop: 1
    }
  }, source && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 11,
      color: "var(--text-tertiary)",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis",
      maxWidth: 220
    }
  }, source), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 11,
      color: "var(--text-tertiary)"
    }
  }, scope), typeof score === "number" && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 11,
      fontWeight: 600,
      color: "var(--text-secondary)"
    }
  }, score.toFixed(2)))), /*#__PURE__*/React.createElement("style", null, `@keyframes hc-pollinate-pulse { from { opacity: .5 } to { opacity: 1 } }`));
}
Object.assign(__ds_scope, { MemoryCard });
})(); } catch (e) { __ds_ns.__errors.push({ path: "components/honeycomb/MemoryCard.jsx", error: String((e && e.message) || e) }); }

// ui_kits/dashboard/components.jsx
try { (() => {
/* Honeycomb dashboard — panel components. Exported to window for the
   index app. Composes the design-system primitives (Badge). */

const dsNS = () => window.HoneycombDesignSystem_d60529 || {};

/* ---- A titled dashboard panel ------------------------------------ */
function Panel({
  title,
  eyebrow,
  right,
  children,
  style
}) {
  return /*#__PURE__*/React.createElement("section", {
    style: {
      background: "var(--bg-surface)",
      border: "1px solid var(--border-default)",
      borderRadius: "var(--radius-lg)",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      ...style
    }
  }, /*#__PURE__*/React.createElement("header", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "13px 16px",
      borderBottom: "1px solid var(--border-subtle)"
    }
  }, /*#__PURE__*/React.createElement("h2", {
    style: {
      fontSize: "var(--text-base)",
      fontWeight: 600,
      color: "var(--text-primary)",
      margin: 0,
      letterSpacing: "-0.01em"
    }
  }, title), eyebrow && /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 11,
      color: "var(--text-tertiary)"
    }
  }, eyebrow), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), right), /*#__PURE__*/React.createElement("div", {
    style: {
      padding: 16,
      flex: 1
    }
  }, children));
}

/* ---- Sessions table ---------------------------------------------- */
const AGENT_DOT = {
  "cursor": "var(--severity-info)",
  "claude-code": "var(--honey)",
  "codex": "var(--pollinate)",
  "openclaw": "var(--verified)"
};
function SessionsPanel({
  sessions
}) {
  const {
    Badge
  } = dsNS();
  return /*#__PURE__*/React.createElement(Panel, {
    title: "Sessions",
    eyebrow: `${sessions.length} captured`
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column"
    }
  }, sessions.map((s, i) => /*#__PURE__*/React.createElement("div", {
    key: s.sessionId,
    style: {
      display: "grid",
      gridTemplateColumns: "84px 1fr auto auto",
      alignItems: "center",
      gap: 12,
      padding: "10px 6px",
      borderTop: i === 0 ? "none" : "1px solid var(--border-subtle)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 13,
      fontWeight: 600,
      color: "var(--honey)"
    }
  }, s.sessionId), /*#__PURE__*/React.createElement("span", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 8,
      minWidth: 0
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 7,
      height: 7,
      borderRadius: "50%",
      background: AGENT_DOT[s.agent] || "var(--text-tertiary)",
      flex: "none"
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 13,
      color: "var(--text-secondary)",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis"
    }
  }, s.project), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 11,
      color: "var(--text-tertiary)"
    }
  }, s.agent)), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 12,
      color: "var(--text-tertiary)"
    }
  }, s.startedAt, " \xB7 ", s.eventCount, "e"), /*#__PURE__*/React.createElement(Badge, {
    tone: s.status === "summarized" ? "verified" : "neutral",
    mono: true
  }, s.status)))));
}

/* ---- Rules list -------------------------------------------------- */
function RulesPanel({
  rules
}) {
  return /*#__PURE__*/React.createElement(Panel, {
    title: "Rules",
    eyebrow: "org-wide"
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 2
    }
  }, rules.map(r => /*#__PURE__*/React.createElement("div", {
    key: r.id,
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10,
      padding: "9px 6px"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 8,
      height: 8,
      borderRadius: "50%",
      background: r.active ? "var(--verified)" : "var(--text-disabled)",
      flex: "none"
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontSize: 14,
      color: r.active ? "var(--text-primary)" : "var(--text-tertiary)"
    }
  }, r.title), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 11,
      color: "var(--text-tertiary)"
    }
  }, r.id)))));
}

/* ---- Skill-sync -------------------------------------------------- */
const SYNC_TONE = {
  shared: "verified",
  pulled: "honey",
  pending: "warning"
};
function SkillSyncPanel({
  skills
}) {
  const {
    Badge
  } = dsNS();
  return /*#__PURE__*/React.createElement(Panel, {
    title: "Skill-sync",
    eyebrow: `${skills.length} skills`
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 8
    }
  }, skills.map(s => /*#__PURE__*/React.createElement("div", {
    key: s.name,
    style: {
      display: "flex",
      alignItems: "center",
      gap: 10
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 13,
      color: "var(--text-primary)",
      whiteSpace: "nowrap",
      overflow: "hidden",
      textOverflow: "ellipsis"
    }
  }, s.name), /*#__PURE__*/React.createElement("span", {
    style: {
      flex: 1
    }
  }), /*#__PURE__*/React.createElement("span", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 11,
      color: "var(--text-tertiary)"
    }
  }, s.scope), /*#__PURE__*/React.createElement(Badge, {
    tone: SYNC_TONE[s.syncState] || "neutral",
    mono: true,
    dot: true
  }, s.syncState)))));
}

/* ---- Codebase graph canvas --------------------------------------- */
const NODE_POS = {
  daemon: {
    x: 60,
    y: 40
  },
  capture: {
    x: 200,
    y: 28
  },
  recall: {
    x: 200,
    y: 120
  },
  pipeline: {
    x: 330,
    y: 70
  },
  store: {
    x: 460,
    y: 110
  },
  pollinating: {
    x: 360,
    y: 160
  }
};
const KIND_COLOR = {
  file: "var(--honey)",
  function: "var(--severity-info)",
  class: "var(--pollinate)"
};
function GraphCanvas({
  graph,
  pollinating
}) {
  if (!graph.built) {
    return /*#__PURE__*/React.createElement(Panel, {
      title: "Codebase graph"
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        padding: "24px 8px",
        textAlign: "center"
      }
    }, /*#__PURE__*/React.createElement("div", {
      style: {
        fontSize: 14,
        color: "var(--text-tertiary)",
        marginBottom: 8
      }
    }, "No graph built for this workspace."), /*#__PURE__*/React.createElement("code", {
      style: {
        fontFamily: "var(--font-mono)",
        fontSize: 13,
        color: "var(--honey)"
      }
    }, "honeycomb graph build")));
  }
  return /*#__PURE__*/React.createElement(Panel, {
    title: "Codebase graph",
    eyebrow: `${graph.nodes.length} nodes · ${graph.edges.length} edges`
  }, /*#__PURE__*/React.createElement("svg", {
    viewBox: "0 0 540 200",
    style: {
      width: "100%",
      height: 200,
      display: "block"
    }
  }, graph.edges.map((e, i) => {
    const a = NODE_POS[e.from],
      b = NODE_POS[e.to];
    if (!a || !b) return null;
    return /*#__PURE__*/React.createElement("line", {
      key: i,
      x1: a.x,
      y1: a.y,
      x2: b.x,
      y2: b.y,
      stroke: "var(--border-strong)",
      strokeWidth: "1.5"
    });
  }), graph.nodes.map(n => {
    const p = NODE_POS[n.id];
    if (!p) return null;
    const isPollinate = pollinating && n.id === "pollinating";
    return /*#__PURE__*/React.createElement("g", {
      key: n.id
    }, /*#__PURE__*/React.createElement("circle", {
      cx: p.x,
      cy: p.y,
      r: "7",
      fill: isPollinate ? "var(--pollinate)" : KIND_COLOR[n.kind] || "var(--text-tertiary)"
    }, isPollinate && /*#__PURE__*/React.createElement("animate", {
      attributeName: "opacity",
      values: "0.5;1;0.5",
      dur: "0.9s",
      repeatCount: "indefinite"
    })), /*#__PURE__*/React.createElement("text", {
      x: p.x + 12,
      y: p.y + 4,
      fontFamily: "var(--font-mono)",
      fontSize: "11",
      fill: "var(--text-secondary)"
    }, n.label));
  })));
}

/* ---- Live log ---------------------------------------------------- */
function LiveLog({
  lines
}) {
  return /*#__PURE__*/React.createElement(Panel, {
    title: "Live log",
    right: /*#__PURE__*/React.createElement("span", {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 6
      }
    }, /*#__PURE__*/React.createElement("span", {
      style: {
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: "var(--verified)"
      }
    }), /*#__PURE__*/React.createElement("span", {
      style: {
        fontFamily: "var(--font-mono)",
        fontSize: 11,
        color: "var(--text-tertiary)"
      }
    }, "streaming"))
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      flexDirection: "column",
      gap: 6
    }
  }, lines.map((l, i) => /*#__PURE__*/React.createElement("code", {
    key: i,
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 12,
      color: i === 0 ? "var(--text-primary)" : "var(--text-tertiary)",
      whiteSpace: "pre"
    }
  }, l))));
}

/* ---- Connectivity banner (daemon down) --------------------------- */
function ConnectivityBanner({
  url,
  onRetry
}) {
  return /*#__PURE__*/React.createElement("div", {
    style: {
      display: "flex",
      alignItems: "center",
      gap: 14,
      padding: "14px 18px",
      background: "var(--severity-critical-bg)",
      border: "1px solid var(--severity-critical)",
      borderRadius: "var(--radius-lg)"
    }
  }, /*#__PURE__*/React.createElement("span", {
    style: {
      width: 9,
      height: 9,
      borderRadius: "50%",
      background: "var(--severity-critical)",
      flex: "none"
    }
  }), /*#__PURE__*/React.createElement("div", {
    style: {
      flex: 1
    }
  }, /*#__PURE__*/React.createElement("div", {
    style: {
      fontSize: 14,
      fontWeight: 600,
      color: "var(--text-primary)"
    }
  }, "Daemon not reachable"), /*#__PURE__*/React.createElement("code", {
    style: {
      fontFamily: "var(--font-mono)",
      fontSize: 12,
      color: "var(--text-tertiary)"
    }
  }, url)), /*#__PURE__*/React.createElement("button", {
    onClick: onRetry,
    style: {
      height: 34,
      padding: "0 16px",
      background: "transparent",
      border: "1px solid var(--severity-critical)",
      color: "var(--severity-critical)",
      borderRadius: "var(--radius-md)",
      fontFamily: "var(--font-sans)",
      fontSize: 13,
      fontWeight: 600,
      cursor: "pointer"
    }
  }, "Retry"));
}
Object.assign(window, {
  Panel,
  SessionsPanel,
  RulesPanel,
  SkillSyncPanel,
  GraphCanvas,
  LiveLog,
  ConnectivityBanner
});
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/dashboard/components.jsx", error: String((e && e.message) || e) }); }

// ui_kits/dashboard/data.js
try { (() => {
/* Honeycomb dashboard — canned view-model data.
   Shapes mirror src/dashboard/contracts.ts (KpisView, SessionRow,
   SettingsView, GraphView, RuleRow, SkillSyncRow). */

window.HC_DATA = {
  settings: {
    orgId: "org_8f3a21",
    orgName: "Activeloop",
    workspace: "deeplake-core",
    daemonUrl: "http://127.0.0.1:3850",
    settings: {
      "Capture": "on",
      "Embeddings": "768-dim · nomic",
      "Pollinating": "auto · 100k tok",
      "Recall": "hybrid (BM25 + cosine)"
    }
  },
  kpis: {
    memoryCount: 1284,
    sessionCount: 312,
    estimatedSavings: "2.4M",
    skills: 47
  },
  // memories returned by a recall query
  memories: [{
    memoryKey: "deploy/prd-022",
    snippet: "We deploy from the prd-022 branch, never from main. CI gate must pass first.",
    source: "~/.honeycomb/memory/deploy.md",
    score: 0.94,
    scope: "team",
    verified: true
  }, {
    memoryKey: "auth/token-drift",
    snippet: "Heal a drifted org token before building the session-start context block — re-mint against the correct org.",
    source: "session a7f3c · cursor",
    score: 0.88,
    scope: "org",
    verified: true
  }, {
    memoryKey: "storage/escaping",
    snippet: "DeepLake query endpoint takes no bound params — hand-escape SQL. Writes are append-only, version-bumped.",
    source: "data/deeplake-storage.md",
    score: 0.79,
    scope: "team",
    verified: false
  }, {
    memoryKey: "daemon/loopback",
    snippet: "The daemon is the sole storage client and binds 127.0.0.1:3850 — loopback only, single machine.",
    source: "architecture/system-overview.md",
    score: 0.74,
    scope: "org",
    verified: true
  }],
  sessions: [{
    sessionId: "a7f3c",
    project: "deeplake-core",
    startedAt: "14:32",
    eventCount: 48,
    status: "summarized",
    agent: "cursor"
  }, {
    sessionId: "b1e90",
    project: "deeplake-core",
    startedAt: "13:05",
    eventCount: 31,
    status: "summarized",
    agent: "claude-code"
  }, {
    sessionId: "c4d22",
    project: "honeycomb",
    startedAt: "11:48",
    eventCount: 67,
    status: "captured",
    agent: "codex"
  }, {
    sessionId: "d8a17",
    project: "honeycomb",
    startedAt: "10:12",
    eventCount: 22,
    status: "summarized",
    agent: "openclaw"
  }, {
    sessionId: "e2b44",
    project: "deeplake-core",
    startedAt: "09:40",
    eventCount: 19,
    status: "captured",
    agent: "claude-code"
  }],
  rules: [{
    id: "r_01",
    title: "Never deploy from main",
    active: true
  }, {
    id: "r_02",
    title: "All findings cite a source",
    active: true
  }, {
    id: "r_03",
    title: "Hand-escape every SQL string",
    active: true
  }, {
    id: "r_04",
    title: "Prefer team skills over re-derivation",
    active: false
  }],
  skills: [{
    name: "deeplake-query-builder",
    scope: "team",
    syncState: "shared"
  }, {
    name: "harness-hook-wiring",
    scope: "org",
    syncState: "pulled"
  }, {
    name: "session-summarizer",
    scope: "team",
    syncState: "pulled"
  }, {
    name: "drift-healer",
    scope: "personal",
    syncState: "pending"
  }],
  graph: {
    built: true,
    nodes: [{
      id: "daemon",
      label: "daemon.ts",
      kind: "file"
    }, {
      id: "capture",
      label: "capture()",
      kind: "function"
    }, {
      id: "recall",
      label: "recall()",
      kind: "function"
    }, {
      id: "pipeline",
      label: "Pipeline",
      kind: "class"
    }, {
      id: "store",
      label: "DeepLake",
      kind: "file"
    }, {
      id: "pollinating",
      label: "pollinating()",
      kind: "function"
    }],
    edges: [{
      from: "capture",
      to: "pipeline",
      kind: "calls"
    }, {
      from: "pipeline",
      to: "store",
      kind: "calls"
    }, {
      from: "recall",
      to: "store",
      kind: "calls"
    }, {
      from: "daemon",
      to: "capture",
      kind: "imports"
    }, {
      from: "daemon",
      to: "recall",
      kind: "imports"
    }, {
      from: "pollinating",
      to: "store",
      kind: "calls"
    }]
  },
  log: ["14:32:08  capture   session a7f3c · tool_call · 48 events", "14:32:09  embed     768-dim · nomic · 12ms", "14:31:55  recall    \"how do we deploy\" → 4 hits · 0.94 top", "14:30:02  summary   session b1e90 summarized · 1.2k tok"]
};
})(); } catch (e) { __ds_ns.__errors.push({ path: "ui_kits/dashboard/data.js", error: String((e && e.message) || e) }); }

__ds_ns.Badge = __ds_scope.Badge;

__ds_ns.Button = __ds_scope.Button;

__ds_ns.Card = __ds_scope.Card;

__ds_ns.Input = __ds_scope.Input;

__ds_ns.Kpi = __ds_scope.Kpi;

__ds_ns.MemoryCard = __ds_scope.MemoryCard;

})();
