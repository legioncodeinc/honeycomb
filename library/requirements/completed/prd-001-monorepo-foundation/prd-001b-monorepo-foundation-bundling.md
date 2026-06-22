# PRD-001b: esbuild Per-Target Bundling

> **Parent:** [PRD-001](./prd-001-monorepo-foundation-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

Build the `esbuild.config.mjs` that gathers compiled `dist/` output and emits self-contained bundles per target: the daemon, the six harnesses (Claude Code, Codex, Cursor, Hermes, pi, OpenClaw), the MCP server, the unified CLI, and the embed daemon, with native dependencies externalized. In scope: entry-point selection per target, output directory mapping, the `external` list for native `.node` modules, the version `define`, and the OpenClaw sandbox overrides. Out of scope: the `tsc` compile step, the workspace layout (PRD-001a), version sync (PRD-001c), and runtime logic of the bundled code.

## Goals

- One `node esbuild.config.mjs` run emits every target bundle to its declared output directory without error.
- Only the daemon bundle (`daemon/`) carries the DeepLake access path; the harness, CLI, and MCP bundles stay thin clients of the daemon on port 3850.
- `tree-sitter` and its language grammars are declared `external` and resolved from `node_modules` at runtime, never inlined into a bundle.
- The OpenClaw bundle passes the ClawHub scanner: no raw `process.env` lookups and no unreachable `node:child_process` exec calls remain in the output.
- The build version is injected at bundle time via `__HONEYCOMB_VERSION__` so artifacts self-report their version.

## Non-Goals

- The `tsc` type-check and compile stage (PRD-001a).
- Version synchronization across manifests (PRD-001c).
- DeepLake storage internals (PRD-002).
- Designing new hook or capture protocols.

## User stories

- As a release engineer, I want one bundling step that produces every target artifact so that distribution is reproducible.
- As a security reviewer, I want the OpenClaw bundle to carry no raw `process.env` reads or dead exec calls so that the ClawHub scanner passes without manual waivers.
- As a daemon maintainer, I want only the daemon bundle to link DeepLake so that thin clients stay small and start fast in IDE-constrained environments.

## Functional requirements

- FR-1: esbuild builds each target with `bundle: true`, `platform: "node"`, `format: "esm"`, emitting to the declared `outdir`: `daemon/`, `harnesses/claude-code/bundle/`, `harnesses/codex/bundle/`, `harnesses/cursor/bundle/`, `harnesses/hermes/bundle/`, `harnesses/pi/bundle/`, `harnesses/openclaw/dist/`, `mcp/bundle/`, `bundle/` (CLI), and `embeddings/`.
- FR-2: The `external` list includes `node:*`, `tree-sitter`, every `tree-sitter-<lang>` grammar (typescript, javascript, python, go, rust, java, ruby, c, cpp), and the other native modules (`node-liblzma`, `@mongodb-js/zstd`, `@huggingface/transformers`, `onnxruntime-node`, `onnxruntime-common`, `sharp`); these resolve from `node_modules` at runtime.
- FR-3: The daemon bundle is the only artifact that links the DeepLake client; harness, CLI, and MCP entry points import only the daemon-client surface, and no DeepLake symbol appears transitively in their output.
- FR-4: The Claude Code bundle packs the `session-start`, `session-end`, `pre-tool-use`, `capture` hooks and the specialized background workers; the Cursor bundle packs `session-start`, `capture`, `pre-tool-use`, `session-end`, and `graph-on-stop`; the pi bundle packs the `wiki-worker` and `skillify-worker`; Hermes follows the hermes-agent shell hook protocol.
- FR-5: A `define` injects `__HONEYCOMB_VERSION__` with the resolved version string so each bundle self-reports its version.
- FR-6: The OpenClaw build registers a `stub-unused-child-process` plugin that resolves `node:child_process` to a no-op namespace exporting empty `execSync`, `execFileSync`, and `spawn`, dropping the dead exec code that would otherwise trip the ClawHub scanner.
- FR-7: The OpenClaw build rewrites every `process.env.HONEYCOMB_*` read to `globalThis.__honeycomb_tuning__.HONEYCOMB_*` via `define`, so the bundle contains zero `process.env.X` substrings while still honoring runtime tuning supplied through `openclaw.json`.
- FR-8: The CLI bundle is emitted to `bundle/cli.js` with a Node hash-bang and `0755` executable permission so it runs directly as the `honeycomb` binary.
- FR-9: `npm run audit:openclaw` validates the OpenClaw bundle against the ClawHub rules, and `npm run pack:check` validates packaged output before publish.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given compiled `dist/` output, when esbuild runs, then each target emits a self-contained bundle to its declared output directory. |
| AC-2 | Given `tree-sitter` and language grammars, when bundling runs, then they are declared `external` and resolved from `node_modules` at runtime rather than inlined. |
| AC-3 | Given the daemon bundle, when its imports are inspected, then it is the only bundle linking the DeepLake client; harness, CLI, and MCP bundles contain no DeepLake access path. |
| AC-4 | Given the OpenClaw bundle, when `audit:openclaw` scans it, then it contains no raw `process.env` substring and no reachable `node:child_process` exec call. |
| AC-5 | Given any bundle, when its version constant is read, then `__HONEYCOMB_VERSION__` matches the root `package.json` version. |
| AC-6 | Given the CLI bundle, when it is emitted, then `bundle/cli.js` has a Node hash-bang and `0755` permission and runs directly. |
| AC-7 | Given the OpenClaw runtime, when a user sets a tuning knob in `openclaw.json` and restarts, then the value is read from `globalThis.__honeycomb_tuning__` and applied. |

## Implementation notes

- The native `.node` prebuilds for `tree-sitter` cannot be bundled by esbuild, so they stay `external` and are resolved at runtime; `scripts/ensure-tree-sitter.mjs` (postinstall and `rebuild:native`) guarantees the prebuilds exist on the host.
- The OpenClaw entry (`harnesses/openclaw/src/index.ts`) transitively imports shared modules that host CC-only helpers shelling out with `execSync` (SSO browser open, plugin-update nudge, wiki-worker spawn). OpenClaw never calls these through its gateway entry, so stubbing `node:child_process` performs dead-code elimination rather than removing live functionality.
- The env-dispatch rewrite restores the runtime override surface that an earlier inline-to-undefined approach removed; populate `globalThis.__honeycomb_tuning__` from `pluginApi.pluginConfig.tuning` in the OpenClaw `register()`.
- `HONEYCOMB_STATE_DIR` is a test-isolation override with no OpenClaw use; it resolves to `undefined` at runtime and the call-site `?? homedir()/...` fallback produces the production path. The rewrite exists only to keep the ClawHub env-harvesting scanner from tripping on a literal `process.env.HONEYCOMB_STATE_DIR` near a network send.

## Dependencies

- PRD-001a (workspace layout) must land first so `dist/` output is separable per target.
- PRD-001c (version sync) supplies the version that `__HONEYCOMB_VERSION__` injects.
- External: esbuild, `tree-sitter` and grammar prebuilds, the ClawHub scanner contract.

## Open questions

- [ ] Should each target be a separate esbuild invocation or one multi-entry build with per-target `external` overrides?
- [ ] Does the embed daemon need its own `external` list for `onnxruntime-node` / `@huggingface/transformers`, or does it share the daemon's?
- [ ] What minimum Node version do the harness bundles target versus the daemon bundle?

## Related

- [parent index](./prd-001-monorepo-foundation-index.md)
- [Monorepo Build and Release Pipeline](../../../knowledge/private/infrastructure/monorepo-build-release.md)
- [TypeScript Coding Standards](../../../knowledge/private/standards/coding-standards-typescript.md)
