# PRD-001a: Workspace and Package Layout

> **Parent:** [PRD-001](./prd-001-monorepo-foundation-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

Define the monorepo directory and package layout under `@honeycomb/*`, the shared `tsconfig` that drives `tsc` compilation to `dist/`, and the single Biome configuration for linting and formatting across the whole tree. In scope: the source-tree boundaries that keep the daemon, the six harnesses, the CLI, the MCP server, and the embed daemon cleanly separable so per-target bundling (PRD-001b) can address each one. Out of scope: the esbuild bundling step itself, version sync (PRD-001c), and any runtime behavior of the compiled code.

## Goals

- One shared `tsconfig.json` with `strict` enabled compiles every package and emits modular JS to `dist/` with no per-package compiler drift.
- Source roots are organized so the daemon, each harness (`harnesses/claude-code`, `harnesses/codex`, `harnesses/cursor`, `harnesses/hermes`, `harnesses/pi`, `harnesses/openclaw`), `mcp/`, the CLI, and `embeddings/` are independently addressable by the bundler.
- A single Biome config applies tab indentation, 120-character line width, and the recommended lint set (warnings on `noExplicitAny`, `noNonNullAssertion`, `noForEach`) uniformly across all packages.
- The fixed cross-package build order (core, then connector-base, then plugins and native bindings, then connectors, then assembled distribution) is encoded so `bun run build` respects dependency direction.
- A new module can be added without inventing structure: it inherits the shared `tsconfig`, the shared Biome config, and a known output location under `dist/`.

## Non-Goals

- The esbuild per-target bundling configuration (PRD-001b).
- Version synchronization and the release pipeline (PRD-001c).
- Runtime behavior of the daemon, hooks, CLI, or MCP server.
- The DeepLake access path, which lives only in the daemon package (PRD-002).

## User stories

- As a contributor, I want a consistent package layout and one lint/format config so that I can add a module without inventing structure.
- As a build engineer, I want every package to compile against one shared `tsconfig` so that type errors surface uniformly and the bundler has predictable inputs.
- As a reviewer, I want one Biome config so that formatting and lint findings are identical regardless of which package a diff touches.

## Functional requirements

- FR-1: A root `tsconfig.json` enables `strict`, targets the Node runtime used by the daemon and harness bundles, and is extended (not duplicated) by any package-level config that needs path-specific overrides.
- FR-2: `tsc` emits modular JavaScript to `dist/`, preserving the source-tree separation between daemon, harnesses, `mcp/`, CLI, and `embeddings/` so esbuild can pick entry points per target.
- FR-3: The package namespace is `@honeycomb/*`; the CLI, package, path, and config names are lowercase `honeycomb` while the product is written Honeycomb.
- FR-4: A single `biome.json` at the root configures tab indentation, a 120-character line width, the recommended rule set, and warnings on `noExplicitAny`, `noNonNullAssertion`, and `noForEach`, applied to every package.
- FR-5: `npm run typecheck` (`tsc --noEmit`) type-checks the entire monorepo in one pass and exits non-zero on any error.
- FR-6: The build order is fixed and encoded so dependent packages compile after the packages they import (core first, distribution last); `bun run build` respects this order.
- FR-7: No package introduces a second copy of shared constants, config defaults, or dependency lists; shared values are extracted to one source of truth to prevent drift, per the coding standards.
- FR-8: Durable app state is never modeled as JSON or JSONL sidecar files at this layer; the layout reserves durable state for DeepLake (PRD-002), and source files carry no sidecar-state assumptions.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given the workspace, when `tsc` runs, then all packages compile against the shared `tsconfig` and emit to `dist/`. |
| AC-2 | Given any source file, when Biome runs, then lint and format rules apply uniformly across every package. |
| AC-3 | Given `npm run typecheck`, when there is a type error in any package, then the command exits non-zero and names the failing file. |
| AC-4 | Given the source tree, when esbuild later enumerates targets, then daemon, each harness, `mcp/`, CLI, and `embeddings/` are independently addressable entry roots. |
| AC-5 | Given a package-level `tsconfig`, when it is inspected, then it extends the root config rather than redefining `strict` or target settings. |
| AC-6 | Given a new module added under the layout, when it is built, then it compiles with no per-package config and lands at a known `dist/` path. |
| AC-7 | Given a constant or default duplicated across two packages, when CI runs `jscpd`/lint, then the duplication is flagged for extraction. |

## Implementation notes

- Two-stage build: `tsc` emits modular JS to `dist/`, then esbuild bundles (PRD-001b). The layout's only job is to keep the daemon, harnesses, CLI, MCP, and embed sources cleanly separable so per-target bundling can address them by entry point.
- The daemon source root is where the DeepLake access path lives; harness, CLI, and MCP roots import only the thin daemon-client surface. The layout must not place DeepLake imports anywhere a non-daemon bundle would transitively pull them in.
- American spelling, tab indentation, 120-column width, no em dashes in comments or docs. Deeper rules live in the TypeScript standards doc.
- The fixed build order exists because packages depend on each other; encode it in the workspace build script rather than relying on incidental ordering.

## Dependencies

- None upstream; this is the foundation. PRD-001b (bundling) and PRD-001c (version sync) build on this layout.
- External: TypeScript (`tsc`), Biome, the workspace package manager (npm or bun, pending the open question), `jscpd` for duplication checks.

## Open questions

- [ ] Should the workspace use npm workspaces, pnpm, or a single-package layout with internal path aliases?
- [ ] What is the minimum supported Node version for the daemon bundle versus the harness bundles?
- [ ] Do we publish per-harness packages independently or only the unified `@honeycomb/cli`?

## Related

- [parent index](./prd-001-monorepo-foundation-index.md)
- [TypeScript Coding Standards](../../../knowledge/private/standards/coding-standards-typescript.md)
- [Monorepo Build and Release Pipeline](../../../knowledge/private/infrastructure/monorepo-build-release.md)
