# Coding Standards (TypeScript)

> Category: Standards | Version: 1.0 | Date: June 2026 | Status: Active

The TypeScript conventions Honeycomb holds itself to: strict types, validation at the edges, closed result shapes, LOC discipline, and the naming and commit rules.

**Related:**
- [API Design Conventions](api-design-conventions.md)
- [Documentation Framework](documentation-framework.md)
- [DeepLake Storage](../data/deeplake-storage.md)
- [Auth Architecture](../auth/auth-architecture.md)

---

## The mindset

The standards exist to keep the codebase small, honest, and hard to break in the ways that matter for a team-shared memory daemon: scoping leaks, silent fallbacks, and drift. Code is the authority. Docs follow code, not the other way around. A change should leave the tree at least as tight as it found it.

## Types

`strict` is on in `tsconfig.json`. Avoid `any`; prefer real types, `unknown` with explicit narrowing, or narrow adapters. No `@ts-nocheck`. Lint suppressions are allowed only when intentional and explained. Prefer `as const` unions over enums and `readonly` for fields that should not move. Keep APIs narrow: export only what the current caller needs, and keep types and helpers local by default.

## Validate at the boundary

External inputs, config, CLI flags, request bodies, and environment variables are validated where they enter, using `zod` or the existing schema helpers. Clamp counters, limits, latencies, intervals, offsets, and retry values to sane non-negative ranges, and reject out-of-range values with clear structured errors. Fail closed for auth, graph policy, mutation gates, and source access. This is the coding-standards expression of the same fail-closed posture described in [Auth Architecture](../auth/auth-architecture.md).

## Make impossible states unrepresentable

Runtime branching uses discriminated unions and closed result shapes, not freeform strings or semantic sentinels like `?? 0` or an empty object standing in for a real value. When valid combinations matter, return one closed mode-or-result shape rather than a handful of parallel nullable fields and derived booleans that callers have to keep in sync. Prefer early returns over nested condition pyramids, and structure code as gather, normalize, decide, act.

```typescript
// Prefer a closed result over parallel nullable fields.
type RouteResult =
  | { kind: "routed"; target: string }
  | { kind: "blocked"; reason: "privacy" | "capability" | "context" }
  | { kind: "degraded"; reason: "account_expired" | "rate_limited" };
```

## LOC discipline

Code size is treated as a cost. Refactors should reduce non-test LOC unless they remove a larger architectural cost, and before closeout the expectation is to run `git diff --numstat` and, if non-test LOC grew, either trim it or justify why fewer paths now exist. Prefer deleting branches, modes, adapters, and tests over preserving them; a refactor that adds a second path has probably failed unless the old path is a cited shipped contract. New helpers and files must pay rent immediately: fewer call paths, fewer concepts, or less repeated logic. There are no helpers for one-off compat, naming translation, or speculative resilience. Split files around 700 LOC when clarity or testability improves.

## Don't create drift

Do not duplicate constants, maps, dependency types, config defaults, package lists, or descriptions across files; extract a shared source of truth when duplication would create drift. DeepLake is the canonical store: durable app state lives in DeepLake tables, not local JSON sidecars. JSON, JSONL, and sidecar files are not acceptable as the default for app state, caches, queues, indexes, or cursors. The storage substrate, and how durable state is shaped against it, is documented in [DeepLake Storage](../data/deeplake-storage.md).

## Tests

Every bug fix needs a test that would fail before the fix. Test behavior, not implementation plumbing, and prefer integration-style tests when a contract crosses modules. Add edge cases for scoping, invalid inputs, timer lifecycle, permission checks, fallback behavior, generated manifests, and publish output. Keep prompt and model-dependent tests opt-in unless the command already defines a model-backed loop. The runner is Vitest (`tests/` mirrors `src/`); run focused suites directly rather than a bare root run, which would also pick up third-party tests under `references/`.

When a test drives a real subprocess that carries its own timeout, the Vitest test-level timeout must be budgeted **above** the subprocess budget, not just the subprocess. A test that passes a 60s budget to a command runner but leaves the Vitest default at 5s will be killed by the framework before the subprocess returns, surfacing as an opaque framework timeout rather than a clean assertion failure, the failure mode behind the HiveDoctor real-npm smoke flake on busy Windows runners. Set the per-test timeout deliberately (a named constant above the subprocess budget) so a genuine subprocess timeout fails as an assertion; keep fast suites that inject a fake runner on the 5s default so they still catch hangs.

```bash
npx vitest run tests/daemon/recall.test.ts   # one focused suite (tests/ mirrors src/)
npm run build                                # tsc + esbuild, respects the build order
```

## Naming and style

The product and docs are written Honeycomb; the CLI, package, path, and config are `honeycomb`. American spelling. No em dashes in code comments or docs. Use named intermediates only for domain meaning or readability, not temp-variable soup. The formatter (Biome) uses tab indentation and a 120-character line width, with recommended lint rules and warnings on `noExplicitAny`, `noNonNullAssertion`, and `noForEach`.

## Commits and PRs

Conventional commits, `type(scope): subject`. Reserve `feat:` for user-facing features, since it drives a minor version bump; use `fix:`, `refactor:`, `chore:`, `perf:`, `test:`, `docs:`, `build:`, or `ci:` for internal changes. Branch as `<username>/<feature>` off `main`, rebase on latest `origin/main` with no merge commits, and keep one PR to one issue or topic. PRs over roughly 5,000 changed lines need a heads-up first, and unrelated fixes do not get bundled together. Never reset, checkout, or delete a user's changes unless asked, and do not delete or rename unexpected files; ask if it blocks you, otherwise leave them.

## Workspace commands

```bash
npm install
npm run build       # tsc && node esbuild.config.mjs, respects the fixed build order
npm run test        # vitest run
npm run lint        # biome check
npm run format      # biome format --write
npm run typecheck   # tsc --noEmit
npm run ci          # the full gate: typecheck + dup (jscpd) + test + audit:sql
```

The build order is fixed because packages depend on each other: core first, then connector-base, then the plugins and native bindings, then the connectors, then the assembled distribution. The route-group conventions these commands build toward are documented in [API Design Conventions](api-design-conventions.md).
