# Build order and layout (PRD-001a)

Honeycomb is a **single-package** TypeScript monorepo. There are no npm
workspaces. `@honeycomb/*` is implemented as **tsconfig path aliases**
(`tsconfig.json` `compilerOptions.paths`); esbuild (PRD-001b) addresses each
target by its entry root.

## Two-stage build

1. `npm run build` -> `tsc` emits modular ESM JS to `dist/`, preserving the
   source-tree separation so each target is independently addressable.
2. PRD-001b appends `&& node esbuild.config.mjs` to the `build` script to bundle
   each target. That seam is intentional and currently empty.

## Fixed build order (dependency direction)

The order below is enforced by **import direction**, not by separate compiler
invocations: one `tsc` pass type-checks the whole graph, and no dependent ever
imports upward. Tier N may import only from tiers `< N`.

| Tier | Name | Roots | May import |
|---|---|---|---|
| 1 | core | `src/shared`, `src/daemon-client` | (nothing internal except tier 1) |
| 2 | connector-base | `src/daemon` | tier 1 |
| 3 | plugins / native | `embeddings/src` | tier 1 |
| 4 | connectors | `harnesses/*/src`, `mcp/src`, `src/cli` | tier 1 (daemon-client + shared) |
| 5 | assembled distribution | esbuild bundles (PRD-001b) | all |

**DeepLake confinement:** the DeepLake access path lives ONLY in `src/daemon`
(tier 2, PRD-002). Tier 4 connectors import the thin `src/daemon-client`
surface, never the daemon core, so no harness / CLI / MCP bundle can
transitively pull in DeepLake (index AC-2).

## Per-target entry roots (for esbuild, PRD-001b)

| Target | Entry file |
|---|---|
| daemon | `src/daemon/index.ts` |
| CLI | `src/cli/index.ts` |
| MCP server | `mcp/src/index.ts` |
| embed daemon | `embeddings/src/index.ts` |
| harness: claude-code | `harnesses/claude-code/src/index.ts` |
| harness: codex | `harnesses/codex/src/index.ts` |
| harness: cursor | `harnesses/cursor/src/index.ts` |
| harness: hermes | `harnesses/hermes/src/index.ts` |
| harness: pi | `harnesses/pi/src/index.ts` |
| harness: openclaw | `harnesses/openclaw/src/index.ts` |

## dist/ layout

`tsc` mirrors the source tree under `dist/` (rootDir is the repo root), e.g.
`src/daemon/index.ts` -> `dist/src/daemon/index.js`,
`harnesses/codex/src/index.ts` -> `dist/harnesses/codex/src/index.js`,
`mcp/src/index.ts` -> `dist/mcp/src/index.js`.

## Single source of truth

Shared constants (daemon port, version seam, product slug) live only in
`src/shared/constants.ts`. The build-time version token is
`__HONEYCOMB_VERSION__` (declared in `src/shared/globals.d.ts`), replaced by
PRD-001b esbuild `define` / PRD-001c sync-versions. Do not re-declare shared
values in any target; `npm run dup` (jscpd) flags duplication.
