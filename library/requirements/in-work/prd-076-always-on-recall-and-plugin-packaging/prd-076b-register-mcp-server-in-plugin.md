# PRD-076b: Register the Honeycomb MCP Server in the Claude Code Plugin

> **Parent:** [`prd-076-always-on-recall-and-plugin-packaging-index`](./prd-076-always-on-recall-and-plugin-packaging-index.md)
> **Status:** Draft
> **Priority:** P1 (the biggest single lever)
> **Effort:** S (~2-4h, front-loaded by the plugin-contract-pinning task)
> **Schema changes:** None.

---

## Goal

Give the model first-class, callable recall tools in a Claude Code session by registering the Honeycomb MCP server (which already exists and bundles to `mcp/bundle/server.js`) with the Claude Code plugin. Today the plugin bundles only hooks and its `plugin.json` carries no MCP registration, so the model cannot call `memory_search` / `hivemind_search` / `hivemind_read` / `memory_store` even though a sibling harness (`harnesses/hermes/.mcp.json`) already registers the identical server. This is registration and packaging only: no new tools, no daemon changes. It is the single largest lever in PRD-076 because it turns the whole existing tool surface on for the reference harness at once, and it is what the per-turn reminder (076a) and the bundled skill (076c) point AT.

## Non-Goals

- **No new MCP tools and no handler changes.** The existing `mcp/src/tools.ts` surface is registered as-is; nothing is added, removed, or altered.
- **No daemon changes.** The server already routes every tool through the daemon over loopback; this sub-PRD does not touch the daemon or the recall engine.
- **No always-on recall wiring.** That is 076a.
- **No skill or slash-command bundling.** That is 076c.
- **No non-claude-code harness registration.** Only the Claude Code plugin is wired; the hermes registration is the precedent, not a target.

---

## Code-grounded starting point

| # | Fact | Code |
|---|---|---|
| 1 | The MCP server already exposes the full recall tool surface: `memory_search`, `hivemind_search` (routes to `POST /api/memories/recall`), `hivemind_read` (zoom a ref to summary/raw turns), `memory_store`, `memory_get`/`memory_list`/`memory_modify`/`memory_forget`, plus browse/goals/codebase/secrets clusters. | `mcp/src/tools.ts:77-138` (`TOOL_SPECS`; `memory_search` `:79`, `hivemind_search` `:115-119`, `hivemind_read` `:107-111`, `memory_store` `:80`) |
| 2 | The server bundles to `mcp/bundle/server.js` (esbuild bundles it from `mcp/src/index.ts`); every tool routes through the daemon over loopback, stamping `x-honeycomb-runtime-path: plugin` + actor headers. | `mcp/src/index.ts:7` (esbuild target), `:~10` (runtime-path stamp), `mcp/bundle/server.js` (built output) |
| 3 | The Claude Code plugin does NOT register the server: `plugin.json` carries only name/description/version/author/license/keywords. | `harnesses/claude-code/.claude-plugin/plugin.json:1-14` |
| 4 | A sibling harness registers the identical server via a standalone `.mcp.json`: `{ mcpServers: { honeycomb: { command: "node", args: ["mcp/bundle/server.js"], env: {} } } }`. This is the registration shape and its conformance test. | `harnesses/hermes/.mcp.json:1-10`, `tests/mcp/registration.test.ts` (asserts a `honeycomb` stdio server pointing at the built bundle) |
| 5 | The MCP-via-install convention is documented: the connector registers the server during `honeycomb connect` so the `honeycomb_*` tools appear in the harness's native tool list, with no separate "add an MCP server" step; the registration is the stdio entry `node mcp/bundle/server.js`. | `library/knowledge/private/integrations/mcp-and-sdk.md:50-56` |
| 6 | The plugin is published through the marketplace manifest, plugin source `./harnesses/claude-code`; the hooks config contract is pinned as an executable oracle under `references/claude-code/`. | `.claude-plugin/marketplace.json:10-17`, `references/claude-code/hooks-schema.ts` |
| 7 | The hooks reference `${CLAUDE_PLUGIN_ROOT}` to resolve the bundle path relative to the installed plugin root. | `harnesses/claude-code/hooks/hooks.json:9` (`node "${CLAUDE_PLUGIN_ROOT}/bundle/index.js"`) |

---

## Design

### Step 1 - Pin the plugin MCP-registration mechanism (do this first)

Determine, against the references gate, how a Claude Code plugin registers MCP servers. The two candidate mechanisms, in the plugin contract:

1. **A bundled `.mcp.json` at the plugin root** (the shape `harnesses/hermes/.mcp.json` already uses). This is the strongest precedent in-repo and mirrors the standalone convention documented at `mcp-and-sdk.md:50-56`.
2. **An `mcpServers` key inside `plugin.json`** (if the Claude Code plugin manifest supports inline MCP server declarations).

Pick the plugin-contract-correct mechanism. Confirm it against the Claude Code plugin documentation and encode it as an executable oracle under `references/claude-code/` (extend the references gate the way `hooks-schema.ts` pins the hooks config), so the registration is checked, not guessed.

### Step 2 - Confirm the bundle-path resolution

The registration `args` must resolve `mcp/bundle/server.js` relative to the INSTALLED plugin root, not the repo. The hooks use `${CLAUDE_PLUGIN_ROOT}/bundle/index.js` (`hooks.json:9`) for exactly this reason. Confirm whether the MCP registration needs the same `${CLAUDE_PLUGIN_ROOT}` prefix (or a plugin-relative path), and whether `mcp/bundle/server.js` ships inside the plugin package (source `./harnesses/claude-code`) or is referenced from the repo root. Resolve the path so the server actually launches from an installed plugin, and encode the expectation in the oracle.

### Step 3 - Add the registration artifact

Add the registration to the Claude Code plugin using the Step-1 mechanism, mirroring the hermes shape:

```json
{
  "mcpServers": {
    "honeycomb": {
      "command": "node",
      "args": ["<plugin-root-relative>/mcp/bundle/server.js"],
      "env": {}
    }
  }
}
```

Keep the server name `honeycomb` (matching hermes and the conformance test's expectation). No env secrets are inlined (the server reads the credential from disk over the same loopback path as every other thin client). Wire the artifact into the build/version-sync path if the plugin manifest version is single-sourced (mirror how the hooks and manifests are already synced).

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| b-AC-1 | The plugin MCP-registration mechanism is pinned against the references gate and encoded as an executable oracle under `references/claude-code/`. A test parses the emitted registration against it. |
| b-AC-2 | The Claude Code plugin registers a `honeycomb` MCP server pointing at the built `mcp/bundle/server.js`, via the Step-1 mechanism. A test asserts the registration artifact parses and lists the `honeycomb` server, mirroring the shape `tests/mcp/registration.test.ts` asserts for hermes. |
| b-AC-3 | The registration `args` path resolves the bundle relative to the installed plugin root (e.g. `${CLAUDE_PLUGIN_ROOT}` or a plugin-relative path), not the repo root. A test asserts the path shape is install-safe. |
| b-AC-4 | The registered server, when launched, answers `initialize` and lists the existing `honeycomb_*` / `hivemind_*` / `memory_*` tool surface unchanged (`memory_search`, `hivemind_search`, `hivemind_read`, `memory_store`, ...). A test asserts the tool list matches `TOOL_NAMES` from `mcp/src/tools.ts` (no tools added or removed by this PRD). |
| b-AC-5 | `plugin.json` and the hooks bundle are otherwise unchanged (the hooks still register the seven lifecycle events); the registration is additive. A test asserts the hooks config still parses against `references/claude-code/hooks-schema.ts`. |
| b-AC-6 | If the plugin manifest version is single-sourced, the registration artifact stays version-consistent with the manifest (no hand-edited drift). A test/scan asserts version parity if applicable. |

---

## Files touched

**New**
- `harnesses/claude-code/.mcp.json` (if the mechanism is a bundled `.mcp.json`) - the `honeycomb` server registration, mirroring `harnesses/hermes/.mcp.json`.
- `references/claude-code/mcp-registration-schema.ts` (or an extension of the existing references gate) - the pinned plugin-MCP-registration oracle.
- `tests/mcp/claude-code-registration.test.ts` (or extend `tests/mcp/registration.test.ts`) - b-AC-1..b-AC-6.

**Modified (only if the mechanism is inline)**
- `harnesses/claude-code/.claude-plugin/plugin.json` - add the `mcpServers` key (ONLY if Step 1 concludes inline registration is the plugin-contract-correct mechanism).
- The version-sync script/config - include the new artifact if the manifest version is single-sourced.

---

## Test plan

- **Contract:** parse the emitted registration against the `references/claude-code/` oracle (b-AC-1).
- **Registration artifact:** assert the `honeycomb` server is listed and points at the built bundle, mirroring the hermes test (b-AC-2); assert the install-safe path shape (b-AC-3).
- **Tool-surface parity:** launch/initialize the server and assert the tool list equals `TOOL_NAMES` (`mcp/src/tools.ts`), proving no tool was added/removed (b-AC-4).
- **Additive:** the hooks config still parses against `hooks-schema.ts` (b-AC-5); version parity if single-sourced (b-AC-6).

---

## Open questions

- **The registration mechanism (bundled `.mcp.json` vs inline `mcpServers` in `plugin.json`).** The hermes precedent and the documented convention both point at a standalone `.mcp.json`; confirm the Claude Code PLUGIN contract (as opposed to a user-level `.mcp.json`) accepts a bundled `.mcp.json` at the plugin root, or whether the plugin manifest expects an inline `mcpServers` key. Resolve against the references gate before writing the artifact.
- **Bundle-path resolution from an installed plugin.** Whether the `args` need `${CLAUDE_PLUGIN_ROOT}` (as the hooks do) and whether `mcp/bundle/server.js` ships inside the plugin package (plugin source `./harnesses/claude-code`) or is referenced relative to the repo. If the bundle is not inside the plugin source tree, confirm the packaging step that makes it reachable from the installed plugin.
- **`env` and credential path.** The hermes registration passes `env: {}` and the server reads the credential from disk. Confirm no plugin-specific env (e.g. a runtime-path marker) is needed for the Claude Code plugin path, matching the `x-honeycomb-runtime-path: plugin` stamp the server already applies (`mcp/src/index.ts`).
