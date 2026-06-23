/* Honeycomb dashboard — panel components. Exported to window for the
   index app. Composes the design-system primitives (Badge). */

const dsNS = () => window.HoneycombDesignSystem_d60529 || {};

/* ---- A titled dashboard panel ------------------------------------ */
function Panel({ title, eyebrow, right, children, style }) {
  return (
    <section style={{
      background: "var(--bg-surface)",
      border: "1px solid var(--border-default)",
      borderRadius: "var(--radius-lg)",
      overflow: "hidden",
      display: "flex",
      flexDirection: "column",
      ...style,
    }}>
      <header style={{ display: "flex", alignItems: "center", gap: 10, padding: "13px 16px", borderBottom: "1px solid var(--border-subtle)" }}>
        <h2 style={{ fontSize: "var(--text-base)", fontWeight: 600, color: "var(--text-primary)", margin: 0, letterSpacing: "-0.01em" }}>{title}</h2>
        {eyebrow && <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>{eyebrow}</span>}
        <span style={{ flex: 1 }} />
        {right}
      </header>
      <div style={{ padding: 16, flex: 1 }}>{children}</div>
    </section>
  );
}

/* ---- Sessions table ---------------------------------------------- */
const AGENT_DOT = {
  "cursor": "var(--severity-info)",
  "claude-code": "var(--honey)",
  "codex": "var(--pollinate)",
  "openclaw": "var(--verified)",
};
function SessionsPanel({ sessions }) {
  const { Badge } = dsNS();
  return (
    <Panel title="Sessions" eyebrow={`${sessions.length} captured`}>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {sessions.map((s, i) => (
          <div key={s.sessionId} style={{
            display: "grid",
            gridTemplateColumns: "84px 1fr auto auto",
            alignItems: "center",
            gap: 12,
            padding: "10px 6px",
            borderTop: i === 0 ? "none" : "1px solid var(--border-subtle)",
          }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 600, color: "var(--honey)" }}>{s.sessionId}</span>
            <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
              <span style={{ width: 7, height: 7, borderRadius: "50%", background: AGENT_DOT[s.agent] || "var(--text-tertiary)", flex: "none" }} />
              <span style={{ fontSize: 13, color: "var(--text-secondary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.project}</span>
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>{s.agent}</span>
            </span>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>{s.startedAt} · {s.eventCount}e</span>
            <Badge tone={s.status === "summarized" ? "verified" : "neutral"} mono>{s.status}</Badge>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/* ---- Rules list -------------------------------------------------- */
function RulesPanel({ rules }) {
  return (
    <Panel title="Rules" eyebrow="org-wide">
      <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
        {rules.map((r) => (
          <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "9px 6px" }}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", background: r.active ? "var(--verified)" : "var(--text-disabled)", flex: "none" }} />
            <span style={{ fontSize: 14, color: r.active ? "var(--text-primary)" : "var(--text-tertiary)" }}>{r.title}</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>{r.id}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/* ---- Skill-sync -------------------------------------------------- */
const SYNC_TONE = { shared: "verified", pulled: "honey", pending: "warning" };
function SkillSyncPanel({ skills }) {
  const { Badge } = dsNS();
  return (
    <Panel title="Skill-sync" eyebrow={`${skills.length} skills`}>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {skills.map((s) => (
          <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 10 }}>
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--text-primary)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{s.name}</span>
            <span style={{ flex: 1 }} />
            <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>{s.scope}</span>
            <Badge tone={SYNC_TONE[s.syncState] || "neutral"} mono dot>{s.syncState}</Badge>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/* ---- Codebase graph canvas --------------------------------------- */
const NODE_POS = {
  daemon:   { x: 60,  y: 40 },
  capture:  { x: 200, y: 28 },
  recall:   { x: 200, y: 120 },
  pipeline: { x: 330, y: 70 },
  store:    { x: 460, y: 110 },
  pollinating: { x: 360, y: 160 },
};
const KIND_COLOR = { file: "var(--honey)", function: "var(--severity-info)", class: "var(--pollinate)" };
function GraphCanvas({ graph, pollinating }) {
  if (!graph.built) {
    return (
      <Panel title="Codebase graph">
        <div style={{ padding: "24px 8px", textAlign: "center" }}>
          <div style={{ fontSize: 14, color: "var(--text-tertiary)", marginBottom: 8 }}>No graph built for this workspace.</div>
          <code style={{ fontFamily: "var(--font-mono)", fontSize: 13, color: "var(--honey)" }}>honeycomb graph build</code>
        </div>
      </Panel>
    );
  }
  return (
    <Panel title="Codebase graph" eyebrow={`${graph.nodes.length} nodes · ${graph.edges.length} edges`}>
      <svg viewBox="0 0 540 200" style={{ width: "100%", height: 200, display: "block" }}>
        {graph.edges.map((e, i) => {
          const a = NODE_POS[e.from], b = NODE_POS[e.to];
          if (!a || !b) return null;
          return <line key={i} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="var(--border-strong)" strokeWidth="1.5" />;
        })}
        {graph.nodes.map((n) => {
          const p = NODE_POS[n.id];
          if (!p) return null;
          const isPollinate = pollinating && n.id === "pollinating";
          return (
            <g key={n.id}>
              <circle cx={p.x} cy={p.y} r="7" fill={isPollinate ? "var(--pollinate)" : KIND_COLOR[n.kind] || "var(--text-tertiary)"}>
                {isPollinate && <animate attributeName="opacity" values="0.5;1;0.5" dur="0.9s" repeatCount="indefinite" />}
              </circle>
              <text x={p.x + 12} y={p.y + 4} fontFamily="var(--font-mono)" fontSize="11" fill="var(--text-secondary)">{n.label}</text>
            </g>
          );
        })}
      </svg>
    </Panel>
  );
}

/* ---- Live log ---------------------------------------------------- */
function LiveLog({ lines }) {
  return (
    <Panel title="Live log" right={<span style={{ display: "flex", alignItems: "center", gap: 6 }}><span style={{ width: 7, height: 7, borderRadius: "50%", background: "var(--verified)" }} /><span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--text-tertiary)" }}>streaming</span></span>}>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {lines.map((l, i) => (
          <code key={i} style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: i === 0 ? "var(--text-primary)" : "var(--text-tertiary)", whiteSpace: "pre" }}>{l}</code>
        ))}
      </div>
    </Panel>
  );
}

/* ---- Connectivity banner (daemon down) --------------------------- */
function ConnectivityBanner({ url, onRetry }) {
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 14,
      padding: "14px 18px",
      background: "var(--severity-critical-bg)",
      border: "1px solid var(--severity-critical)",
      borderRadius: "var(--radius-lg)",
    }}>
      <span style={{ width: 9, height: 9, borderRadius: "50%", background: "var(--severity-critical)", flex: "none" }} />
      <div style={{ flex: 1 }}>
        <div style={{ fontSize: 14, fontWeight: 600, color: "var(--text-primary)" }}>Daemon not reachable</div>
        <code style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)" }}>{url}</code>
      </div>
      <button onClick={onRetry} style={{
        height: 34, padding: "0 16px", background: "transparent",
        border: "1px solid var(--severity-critical)", color: "var(--severity-critical)",
        borderRadius: "var(--radius-md)", fontFamily: "var(--font-sans)", fontSize: 13, fontWeight: 600, cursor: "pointer",
      }}>Retry</button>
    </div>
  );
}

Object.assign(window, { Panel, SessionsPanel, RulesPanel, SkillSyncPanel, GraphCanvas, LiveLog, ConnectivityBanner });
