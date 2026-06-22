# PRD-039c: Per-Harness Sub-Pages + Harness-Specific Capability Descriptors

> **Status:** Backlog
> **Priority:** P1
> **Effort:** M
> **Parent:** [PRD-039 Harnesses Page](./prd-039-harnesses-page-index.md)

## Overview

This sub-PRD builds the **per-harness detail page** — a route per harness (e.g. `#/harnesses/cursor`,
`#/harnesses/claude-code`) reached from the 039b overview. Each detail page shows two things:

1. **That harness's live activity** — a live stream of its turns, reusing the existing `/api/logs` SSE infra
   (`src/daemon/runtime/logs/api.ts`), filtered to the harness — NOT a second log pipe (parent D-4).
2. **That harness's specific capabilities** — the real divergences between harnesses, expressed as a data-driven
   **capability descriptor** so each page renders only the panels its harness actually has. The motivating example:
   Cursor exposes `cursor-agent` "agents" and `workspace_roots` (`src/hooks/cursor/shim.ts`) where Claude Code does
   not; Claude Code is the full six-event REFERENCE lifecycle (`src/hooks/claude-code/shim.ts`) and shows no agents
   panel. The descriptor pattern keeps this from becoming six bespoke pages — it mirrors the shim "thin override, not
   a fork" thesis in `src/hooks/contracts.ts`.

## Goals

- Add a per-harness detail route (`#/harnesses/<name>`) as the PRD-037 037c DYNAMIC registry entries, resolved from the
  039a live harness list.
- Show each harness's live activity by reusing `/api/logs` (SSE) filtered to the harness — no new streaming surface.
- Define a capability-descriptor pattern so each harness page renders the feature panels it genuinely supports and
  omits the rest (Cursor agents present; Claude Code agents absent).
- Ground the capability set in the REAL shim divergences (runtime path, context channel, host CLI, agents,
  MCP registration, contracted tools) so the page reflects the code, not a marketing template.

## Non-Goals

- The overview page / cards / matrix (that is 039b).
- The telemetry endpoint (that is 039a) — this page reads 039a for the harness's summary stats and `/api/logs` for its
  live stream.
- Changing the shims or adding a capture path. Capabilities are READ from the existing shim contracts/behaviour.
- A new SSE endpoint. The live stream is the existing `/api/logs/stream`, filtered (parent D-4 / OQ-2).

## User Stories

- As an operator on the Cursor detail page, I watch Cursor's turns stream live AND see a "Agents" panel listing
  `cursor-agent` (with the `claude` fallback) — a capability Claude Code's page does not show.
- As an operator on the Claude Code detail page, I see its full six-event lifecycle + `legacy` runtime path + `claude -p`
  host CLI, and NO agents panel (it has none) — the page omits what doesn't apply.
- As an operator, I open the Hermes page and see its MCP-server-registration capability surfaced where other harnesses
  show their own specifics.

## Capability descriptor

Each harness's specific surface is a data-driven descriptor; the detail page renders the panels the descriptor declares
and omits the absent ones. Capabilities are grounded in the shim contracts (`src/hooks/contracts.ts`,
`src/hooks/<harness>/shim.ts`):

```
HarnessCapabilities {
  name: string                 // canonical harness id
  runtimePath: string          // "legacy" (hook scripts) | "plugin" (extension) | …
  contextChannel: string       // "model-only" | "user-visible"
  hostCli: { bin: string; args: string[]; fallbackBin?: string }   // e.g. cursor-agent → claude
  lifecycleEvents: string[]    // the native events the shim maps (claude-code = the full six)
  agents?: { kind: string; binary: string }   // Cursor's cursor-agent agents; ABSENT for Claude Code
  mcpRegistration?: boolean    // Hermes registers the MCP server
  contractedTools?: boolean    // OpenClaw's contracted tools
  // …additive: a new capability is a new optional field + a panel that renders only when present
}
```

- **Cursor** declares `agents` (`{ kind: "cursor-agent", binary: "cursor-agent" }`), `runtimePath: "plugin"`,
  `hostCli: { bin: "cursor-agent", fallbackBin: "claude" }`, plus the `Shell`-tool / `workspace_roots` divergences.
- **Claude Code** declares the full six `lifecycleEvents`, `runtimePath: "legacy"`, `hostCli: { bin: "claude",
  args: ["-p"] }`, and NO `agents` — so its page omits the agents panel.
- **Hermes** declares `mcpRegistration: true`; **OpenClaw** declares `contractedTools: true`; etc.

The descriptor is the SINGLE place a harness's specifics live; adding a capability is a new optional field + a panel
that renders only when the field is present — not a new bespoke page (parent D-5).

## Implementation Notes

- **Route + registry.** `#/harnesses/<name>` are the 037c DYNAMIC registry entries, resolved at render from the 039a
  harness list (parent D-6). The router (037b) renders the detail component with the `<name>` param.
- **Live stream.** Subscribe to the existing `GET /api/logs/stream` (SSE) and filter to the harness. Filtering source
  is parent OQ-2: client-side over a harness-tagged signal, or a `?harness=` server param if the request-log record
  shape gains the `agent` tag. The records carry NO secret by construction (`logs/api.ts` records method/path/status,
  not headers/body/token), so the filtered stream inherits that guarantee (parent AC-8).
- **Summary stats.** Read the harness's `HarnessStatus` (installed/active/last-seen/turns) from the 039a endpoint for
  the page header — one source (parent D-3).
- **Capability source.** Build the descriptor from the shim-declared statics (`HostCli`, `ContextChannel`,
  `RuntimePath`, the event map) so the page reflects the actual code. Keep it data-driven; the panel set is computed
  from the descriptor, not hardcoded per harness.
- **Omission, not blanks.** A harness without a capability simply does not render that panel (no empty "Agents: none"
  card for Claude Code) — the descriptor's absent field drives omission.

## Acceptance Criteria

- [ ] **c-AC-1 — Per-harness route.** Each harness has a detail route `#/harnesses/<name>` reachable from the 039b
  overview, registered as a 037c DYNAMIC registry entry resolved from the 039a live list.
- [ ] **c-AC-2 — Live stream, reused.** The detail page shows that harness's live activity via the existing
  `/api/logs` SSE stream filtered to the harness — no new streaming endpoint; no secret in any streamed line.
- [ ] **c-AC-3 — Capability descriptor drives panels.** Each page renders the feature panels its harness's descriptor
  declares and OMITS the rest — Cursor shows an Agents panel (`cursor-agent` + `claude` fallback); Claude Code shows
  none.
- [ ] **c-AC-4 — Capabilities are real.** The descriptors reflect the actual shim divergences (runtime path, context
  channel, host CLI, lifecycle events, Cursor agents, Hermes MCP registration, OpenClaw contracted tools), grounded in
  `src/hooks/<harness>/shim.ts` + `contracts.ts` — not a fixed template duplicated per harness. A test asserts Cursor's
  descriptor carries `agents` and Claude Code's does not.
- [ ] **c-AC-5 — DS-only + production-clean + secure.** Built from existing DS tokens/primitives, bundled by the
  existing esbuild entry, no token/secret in the page, the route, or the streamed lines. A DOM/unit test renders the
  Cursor detail (asserts the Agents panel present) and the Claude Code detail (asserts it absent); `npm run ci` /
  `build` / `audit:openclaw` green.

## Open Questions

- **c-OQ-1** — Per-harness log filter: client-side (filter `/api/logs/stream` records) or server-side (`?harness=`)?
  The request-log record currently carries method/path/status, NOT the `agent` tag, so a server filter needs a small
  record-shape addition. Lean: client-side over a `sessions`-derived activity view if the request log can't be tagged
  cheaply. (Parent OQ-2.)
- **c-OQ-2** — Should the descriptor be assembled on the SERVER (extend 039a's response with a `capabilities` block) or
  on the CLIENT (a static descriptor table in the page)? Server keeps one source and lets it reflect live shim state;
  client avoids growing the endpoint. Lean: server, folded into 039a, since the statics already live in the shims.
- **c-OQ-3** — How deep does the live activity stream go — request-log lines only, or the harness's captured `sessions`
  turns (richer, but a different source)? Lean: start with the `/api/logs` reuse (parent D-4) and consider a
  `sessions`-turn view as a fast-follow.
- **c-OQ-4** — Beyond Cursor agents / Hermes MCP / OpenClaw contracted tools, which other divergences are worth a panel
  (e.g. pi's `AGENTS.md` surface, Codex's user-visible login line)? The descriptor is additive, so these land as new
  optional fields when prioritized.
