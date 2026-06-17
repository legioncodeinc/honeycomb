# PRD-001: Monorepo Foundation

> **Status:** In-Work
> **Priority:** P0
> **Effort:** L
> **Schema changes:** None

---

## Overview

Honeycomb ships as a single TypeScript monorepo that builds a long-lived daemon plus thin clients for six coding harnesses, the unified `honeycomb` CLI, the MCP server, and the embed daemon. This module establishes that foundation: the workspace and package layout under `@honeycomb/*`, a shared `tsconfig` and Biome configuration, the two-stage `tsc` then esbuild build, per-target bundles where only the daemon carries the DeepLake access path, and a version-sync plus release pipeline that keeps every plugin manifest and the marketplace definition pinned to one version. Everything downstream depends on this scaffold compiling and packaging cleanly.

## Goals

- One `npm run build` runs `tsc` then esbuild and emits self-contained bundles for the daemon, each harness, the CLI, the MCP server, and the embed daemon.
- The daemon bundle is the only artifact that opens DeepLake; hooks, CLI, and MCP bundles stay thin clients.
- A single source version propagates idempotently to all plugin manifests and the marketplace file before every build.
- Native dependencies (`tree-sitter` grammars) are declared `external` and resolved from `node_modules` at runtime, never bundled.

## Non-Goals

- Runtime behavior of the daemon, hooks, or CLI commands (covered by PRD-004 and later modules).
- DeepLake storage internals (PRD-002).
- Designing new authentication or capture protocols.

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-001a-monorepo-foundation-workspace-layout`](./prd-001a-monorepo-foundation-workspace-layout.md) | Workspace and package layout, shared `tsconfig`, Biome lint/format config. | Draft |
| [`prd-001b-monorepo-foundation-bundling`](./prd-001b-monorepo-foundation-bundling.md) | esbuild per-target bundles with native deps externalized. | Draft |
| [`prd-001c-monorepo-foundation-version-release`](./prd-001c-monorepo-foundation-version-release.md) | Version sync across manifests and the release pipeline. | Draft |

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a clean checkout, when `npm run build` runs, then `tsc` type-checks the whole monorepo and esbuild emits every target bundle without error. |
| AC-2 | Given the daemon bundle, when its imports are inspected, then it is the only bundle that links the DeepLake client; harness, CLI, and MCP bundles contain no DeepLake access path. |
| AC-3 | Given a bumped version in the root `package.json`, when `prebuild` runs, then every plugin manifest and the marketplace file are updated to match, and re-running makes no further writes. |
| AC-4 | Given `tree-sitter` and its grammars, when a target is bundled, then those modules are marked `external` and resolved from `node_modules` at runtime. |

## Data model changes

None.

## API changes

None.

## Open questions

- [ ] Should the workspace use npm workspaces, pnpm, or a single-package layout with internal path aliases?
- [ ] Do we publish per-harness packages independently or only the unified `@honeycomb/cli`?
- [ ] What is the minimum supported Node version for the daemon bundle versus the harness bundles?

## Related

- [Monorepo Build and Release Pipeline](../../../knowledge/private/infrastructure/monorepo-build-release.md)
- [TypeScript Coding Standards](../../../knowledge/private/standards/coding-standards-typescript.md)
- [System Overview](../../../knowledge/private/architecture/system-overview.md)
