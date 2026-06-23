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
      "Recall": "hybrid (BM25 + cosine)",
    },
  },

  kpis: {
    memoryCount: 1284,
    sessionCount: 312,
    estimatedSavings: "2.4M",
    skills: 47,
  },

  // memories returned by a recall query
  memories: [
    {
      memoryKey: "deploy/prd-022",
      snippet: "We deploy from the prd-022 branch, never from main. CI gate must pass first.",
      source: "~/.honeycomb/memory/deploy.md",
      score: 0.94, scope: "team", verified: true,
    },
    {
      memoryKey: "auth/token-drift",
      snippet: "Heal a drifted org token before building the session-start context block — re-mint against the correct org.",
      source: "session a7f3c · cursor",
      score: 0.88, scope: "org", verified: true,
    },
    {
      memoryKey: "storage/escaping",
      snippet: "DeepLake query endpoint takes no bound params — hand-escape SQL. Writes are append-only, version-bumped.",
      source: "data/deeplake-storage.md",
      score: 0.79, scope: "team", verified: false,
    },
    {
      memoryKey: "daemon/loopback",
      snippet: "The daemon is the sole storage client and binds 127.0.0.1:3850 — loopback only, single machine.",
      source: "architecture/system-overview.md",
      score: 0.74, scope: "org", verified: true,
    },
  ],

  sessions: [
    { sessionId: "a7f3c", project: "deeplake-core", startedAt: "14:32", eventCount: 48, status: "summarized", agent: "cursor" },
    { sessionId: "b1e90", project: "deeplake-core", startedAt: "13:05", eventCount: 31, status: "summarized", agent: "claude-code" },
    { sessionId: "c4d22", project: "honeycomb",     startedAt: "11:48", eventCount: 67, status: "captured",   agent: "codex" },
    { sessionId: "d8a17", project: "honeycomb",     startedAt: "10:12", eventCount: 22, status: "summarized", agent: "openclaw" },
    { sessionId: "e2b44", project: "deeplake-core", startedAt: "09:40", eventCount: 19, status: "captured",   agent: "claude-code" },
  ],

  rules: [
    { id: "r_01", title: "Never deploy from main", active: true },
    { id: "r_02", title: "All findings cite a source", active: true },
    { id: "r_03", title: "Hand-escape every SQL string", active: true },
    { id: "r_04", title: "Prefer team skills over re-derivation", active: false },
  ],

  skills: [
    { name: "deeplake-query-builder", scope: "team", syncState: "shared" },
    { name: "harness-hook-wiring",    scope: "org",  syncState: "pulled" },
    { name: "session-summarizer",     scope: "team", syncState: "pulled" },
    { name: "drift-healer",           scope: "personal", syncState: "pending" },
  ],

  graph: {
    built: true,
    nodes: [
      { id: "daemon",    label: "daemon.ts",      kind: "file" },
      { id: "capture",   label: "capture()",      kind: "function" },
      { id: "recall",    label: "recall()",       kind: "function" },
      { id: "pipeline",  label: "Pipeline",       kind: "class" },
      { id: "store",     label: "DeepLake",       kind: "file" },
      { id: "pollinating",  label: "pollinating()",     kind: "function" },
    ],
    edges: [
      { from: "capture", to: "pipeline", kind: "calls" },
      { from: "pipeline", to: "store", kind: "calls" },
      { from: "recall", to: "store", kind: "calls" },
      { from: "daemon", to: "capture", kind: "imports" },
      { from: "daemon", to: "recall", kind: "imports" },
      { from: "pollinating", to: "store", kind: "calls" },
    ],
  },

  log: [
    "14:32:08  capture   session a7f3c · tool_call · 48 events",
    "14:32:09  embed     768-dim · nomic · 12ms",
    "14:31:55  recall    \"how do we deploy\" → 4 hits · 0.94 top",
    "14:30:02  summary   session b1e90 summarized · 1.2k tok",
  ],
};
