# EXECUTION LEDGER — PRD-001 Monorepo Foundation

> Single source of truth for the /the-smoker run. Survives context loss.
> Status legend: OPEN · IN PROGRESS · DONE (implemented + locally proven) · VERIFIED (independently graded) · BLOCKED

**Run scope:** `library/requirements/in-work/prd-001-monorepo-foundation` (index + 001a + 001b + 001c)
**Branch:** `prd-001-monorepo-foundation` (to be created)
**Reference template:** `hivemind-v1/` — near-exact architecture; adapt by renaming `@deeplake/hivemind`→`honeycomb`, `__HIVEMIND_VERSION__`→`__HONEYCOMB_VERSION__`, `HIVEMIND_*`→`HONEYCOMB_*`, `__hivemind_tuning__`→`__honeycomb_tuning__`.

---

## Resolved foundational decisions (PRD open questions defaulted, not blocked)

| # | Question | Decision | Rationale |
|---|---|---|---|
| D-1 | npm vs pnpm vs bun | **npm** scripts (`npm run build/typecheck`) | Index + 001b + 001c all say `npm run`; only 001a FR-6 says `bun run` — normalized to npm. Reference `hivemind-v1` uses npm. |
| D-2 | workspaces vs single-package | **Single-package + `@honeycomb/*` tsconfig path aliases**, esbuild multi-entry | Matches `hivemind-v1`; lowest-risk reading that satisfies every AC; esbuild addresses targets by entry root. |
| D-3 | Min Node version | **Node 22** (ESM, Node16 module resolution, ES2022 target) | Matches the Army stack and `hivemind-v1`. |
| D-4 | Publish per-harness vs unified | Deferred — no AC tests it; marketplace + plugin manifests cover distribution | Non-blocking; documented open question. |

Platform note: dev host is **Windows/PowerShell**. `chmod 0755` is a POSIX no-op on Windows — esbuild must still stamp the CLI file mode; verification of the bit is best-effort on win32.

---

## AC Ledger

### PRD-001a — Workspace & Package Layout — Owner: `typescript-node-worker-bee` (Wave 1)

| ID | Criterion | Status | Owner |
|---|---|---|---|
| a-AC-1 | `tsc` compiles all packages against shared `tsconfig`, emits to `dist/`. | VERIFIED | typescript-node-worker-bee |
| a-AC-2 | Biome lint+format rules apply uniformly across every package. | VERIFIED | typescript-node-worker-bee |
| a-AC-3 | `npm run typecheck` exits non-zero and names the failing file on a type error. | VERIFIED | typescript-node-worker-bee |
| a-AC-4 | daemon, each harness, `mcp/`, CLI, `embeddings/` are independently addressable entry roots. | VERIFIED | typescript-node-worker-bee |
| a-AC-5 | Package-level `tsconfig` extends root; does not redefine `strict`/target. | VERIFIED | typescript-node-worker-bee |
| a-AC-6 | A new module compiles with no per-package config and lands at a known `dist/` path. | VERIFIED | typescript-node-worker-bee |
| a-AC-7 | A constant duplicated across two packages is flagged by `jscpd`/lint for extraction. | VERIFIED | typescript-node-worker-bee |

### PRD-001b — esbuild Per-Target Bundling — Owner: `ci-release-worker-bee` (Wave 2)

| ID | Criterion | Status | Owner |
|---|---|---|---|
| b-AC-1 | esbuild emits a self-contained bundle per target to its declared outdir. | VERIFIED | ci-release-worker-bee |
| b-AC-2 | `tree-sitter` + grammars declared `external`, resolved from `node_modules` at runtime. | VERIFIED | ci-release-worker-bee |
| b-AC-3 | Daemon is the only bundle linking DeepLake; harness/CLI/MCP carry no DeepLake path. | VERIFIED* | ci-release-worker-bee |
| b-AC-4 | `audit:openclaw` finds no raw `process.env` substring and no reachable `child_process` exec. | VERIFIED | ci-release-worker-bee |
| b-AC-5 | Every bundle's `__HONEYCOMB_VERSION__` matches root `package.json` version. | VERIFIED | ci-release-worker-bee |
| b-AC-6 | `bundle/cli.js` has a Node hash-bang + `0755` and runs directly. | VERIFIED | ci-release-worker-bee |
| b-AC-7 | OpenClaw tuning knob in `openclaw.json` is read from `globalThis.__honeycomb_tuning__`. | VERIFIED | ci-release-worker-bee |

> *b-AC-3: architectural confinement is VERIFIED — no non-daemon entry can transitively reach `src/daemon`; the DeepLake access path itself is a PRD-002 seam not yet wired, so the symbol count is vacuously 0 in every bundle today. Re-assert this AC when PRD-002 lands a real DeepLake import.

### PRD-001c — Version Sync & Release Pipeline — Owner: `ci-release-worker-bee` (Wave 2)

| ID | Criterion | Status | Owner |
|---|---|---|---|
| c-AC-1 | New root version → all scalar manifests + marketplace metadata + plugin entries updated. | VERIFIED | ci-release-worker-bee |
| c-AC-2 | Re-run on a synced tree performs no file writes (idempotent). | VERIFIED | ci-release-worker-bee |
| c-AC-3 | `prebuild` runs sync ahead of `build` so every manifest is synced before esbuild. | VERIFIED | ci-release-worker-bee |
| c-AC-4 | Sync logs each `old -> new` transition and a final write/skip count. | VERIFIED | ci-release-worker-bee |
| c-AC-5 | Marketplace `metadata.version` and every `plugins[].version` match root. | VERIFIED | ci-release-worker-bee |
| c-AC-6 | Malformed manifest JSON fails with a clear error naming the file; no partial write. | VERIFIED | ci-release-worker-bee |

### Index roll-ups (satisfied transitively)

| Index AC | Satisfied by | Status |
|---|---|---|
| AC-1 build runs tsc+esbuild, emits all targets | a-AC-1 + b-AC-1 | VERIFIED |
| AC-2 daemon-only DeepLake bundle | b-AC-3 | VERIFIED* |
| AC-3 version fans out idempotently | c-AC-1 + c-AC-2 + c-AC-3 | VERIFIED |
| AC-4 tree-sitter external | b-AC-2 | VERIFIED |

**Totals:** 20 granular ACs · **20 VERIFIED** · 0 DONE · 0 OPEN · 0 BLOCKED — ledger fully VERIFIED, close-out (security → quality) unlocked.

---

## Wave plan

- **Wave 1 — Foundation (PRD-001a)** · `typescript-node-worker-bee` · model: **opus** (matrix: `claude-opus-4-8-thinking-high` — deep autonomous multi-file foundation scaffolding; drift/duplication discipline is load-bearing).
  Exit: `npm run typecheck` passes, `tsc` emits to `dist/` per target, Biome + jscpd configured, all target entry roots exist and are independently addressable.
- **Wave 2 — Build & Release pipeline (PRD-001b + PRD-001c)** · `ci-release-worker-bee` · model: **opus** (matrix ideal: `gpt-5.3-codex-high` build/release specialist — not spawnable in this harness; mapped to opus for frontier code+build correctness). Combined into one Bee because both edit the npm `scripts` block + esbuild/version-define and are tightly coupled.
  Exit: `npm run build` emits every target bundle; tree-sitter external; daemon-only DeepLake; `__HONEYCOMB_VERSION__` matches; CLI hashbang+0755; sync idempotent + logged; `audit:openclaw` + `pack:check` pass.
- **Wave 3 — Close-out** · `security-worker-bee` (opus) → then `quality-worker-bee` (sonnet). Security before quality, always.

Dependency: Wave 1 → Wave 2 is hard (esbuild needs separable `dist/`; sync needs manifests). 001b and 001c run inside one Wave-2 Bee, sequentially internal, to avoid `package.json` script conflicts.

```
Wave 1 (001a)  ──►  Wave 2 (001b + 001c)  ──►  Wave 3 (security ──► quality)  ──►  Ship (commit/push/PR/CI)
```

---

## Watchdog / event log

- Wave 1 (001a) dispatched → `typescript-node-worker-bee` (opus). Returned all 7 a-AC DONE.
- Orchestrator independent verify from repo root: `npm run typecheck` exit 0, `npm run dup` exit 0, `biome check .` exit 0; 10/10 entry roots present; daemon/DeepLake refs are comments-only (daemon-client imports only `shared/constants.js`); a-AC-3 reproduced (names `src/_v.ts`, exit 2). → **a-AC-1..7 flipped to VERIFIED.**
- Wave 2 (001b + 001c) dispatched → `ci-release-worker-bee` (opus).
- Orchestrator independent verify (from repo root, clean build): `npm run build` exit 0 emits all 10 bundles; OpenClaw bundle `process.env`=0 / `child_process`=0 + `audit:openclaw` exit 0; `0.1.0` baked in bundles = root; `bundle/cli.js` hashbang + `-rwxr-xr-x` + runs (`honeycomb v0.1.0 (daemon down)`); tree-sitter + 9 grammars in external list; sync idempotent (0 written x2); bump fans out to all 5 scalars + marketplace metadata + plugins[]; prebuild runs before tsc/esbuild; malformed codex manifest → REAL exit 1 naming the file, marketplace untouched; b-AC-7 register()→`globalThis.__honeycomb_tuning__` wiring + define-rewrite present; `npm run ci` exit 0, `npm run pack:check` exit 0 (27 files). → **b-AC-1..7 + c-AC-1..6 + index roll-ups flipped to VERIFIED.** Ledger fully VERIFIED.
- Wave 3 close-out dispatched: `security-worker-bee` (opus) → then `quality-worker-bee` (sonnet).
- `security-worker-bee` returned: **0 Critical / 0 High / 0 Medium.** Data-plane catalogs N/A (no DeepLake/auth/hooks/capture yet). One Low (F-1) fixed: prototype-pollution hardening in `harnesses/openclaw/src/index.ts` (`FORBIDDEN_TUNING_KEYS` filter on `__proto__`/`constructor`/`prototype`). Report: `library/requirements/in-work/prd-001-monorepo-foundation/reports/2026-06-17-security-report.md`. Orchestrator confirmed fix present + `build`/`audit:openclaw`/`typecheck` exit 0, OpenClaw bundle still 0 `process.env` / 0 `child_process`. **No blocking findings.**
- `quality-worker-bee` (sonnet) dispatched to verify implementation against the source PRDs.
- `quality-worker-bee` returned **PASS-WITH-FINDINGS**: 20/20 ACs PASS, no Medium+ findings, clean to ship. One sub-threshold Warning (FR-4 per-harness hook enumeration — plan-ambiguity vs PRD-001b Non-Goals; deferred to hook-integration PRD as a doc clarification, not reopenable). Report: `.../reports/2026-06-17-qa-report.md`. Both close-out gates clean at medium+ → loop terminates.
- **Phase 3 Ship:** commit `d4e8301` (230 files, foundation + library; `.claude`/`.cursor` left untracked per user). Pushed `prd-001-monorepo-foundation`. PR opened: https://github.com/legioncodeinc/honeycomb/pull/1.
- **CI monitor:** no `.github/workflows/` in repo (CI/Actions architecture is out of PRD-001 scope; PRD-001c defers publish/tag steps). No remote checks to monitor; local gate is the CI-equivalent and is fully green (`ci`/`build`/`audit:openclaw`/`pack:check`/`npm audit` all exit 0).
- **RUN COMPLETE:** 100% of PRD-001 (index + 001a/b/c), 20/20 ACs VERIFIED, close-out clean, shipped. PRD-001 stays in `in-work/` until PR #1 merges, then moves to `completed/`.
- Wave 2 RETURNED all 13 ACs DONE with captured evidence (2026-06-17):
  - Created `esbuild.config.mjs` (10 targets, per-target invocation), `scripts/sync-versions.mjs`, `scripts/pack-check.mjs` (win32-safe), `scripts/audit-openclaw-bundle.mjs`, `scripts/ensure-tree-sitter.mjs` (greenfield/win32 no-op). Installed `esbuild@^0.28.1` devDep.
  - Created manifests: `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json`, `harnesses/claude-code/.claude-plugin/plugin.json`, `harnesses/openclaw/openclaw.plugin.json`, `harnesses/openclaw/package.json`, `harnesses/codex/package.json` (all `honeycomb`, v0.1.0). Plus `harnesses/openclaw/skills/SKILL.md`, `harnesses/openclaw/openclaw.example.json`.
  - Wired `package.json`: `prebuild`=sync-versions, `build`=`tsc && node esbuild.config.mjs`, `bundle`, `audit:openclaw`, `pack:check`, `rebuild:native`, `postinstall`, `prepack`=build; added `bin` (`honeycomb`→`bundle/cli.js`) + `files` allowlist. Extended `src/cli/index.ts` (direct-run guard), `harnesses/openclaw/src/index.ts` (register()/tuning/version), `src/shared/globals.d.ts` (`__honeycomb_tuning__`). Extended `.gitignore` for `/daemon/`, `/harnesses/openclaw/dist/`, `/embeddings/embed-daemon.js`.
  - Proofs: build exit 0 (10 bundles); audit:openclaw exit 0 (0 process.env, 0 child_process); pack:check exit 0 (27 files, no secrets/.ts); sync x2 idempotent (6 written on bump, 0 on re-run); malformed JSON fails naming codex/package.json, no partial write; `__HONEYCOMB_VERSION__`=0.1.0 baked in daemon/cli/mcp/openclaw; CLI hashbang+0755 runs (`honeycomb v0.1.0`); b-AC-7 tuning round-trip PASS; tree-sitter externalized (empirical); thin clients 0 daemon/DeepLake refs; typecheck+dup+ci all exit 0.
  - NEXT: orchestrator independent verify, then flip b-AC-1..7 + c-AC-1..6 to VERIFIED; then Wave 3 (security → quality).
