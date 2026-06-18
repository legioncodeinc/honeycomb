# EXECUTION LEDGER — PRD-014 Codebase Graph

> /the-smoker run. Branch `prd-014-codebase-graph` off main (PRD-001..013 + CI merged). PR → main.

**Scope:** index + 014a (tree-sitter extractors + content-addressed cache + discovery) / 014b (cross-file resolution + deterministic snapshot + canonical hash) / 014c (push/pull to the `codebase` table + drift detection) / 014d (read-only `graph/` query surface). 24 sub-ACs + 4 index. A live, **AST-only** graph of files/symbols/edges built from the current checkout: who-calls, blast-radius, subsystem walk — grounded in HEAD. Daemon owns the build worker; the snapshot mirrors NetworkX node-link JSON.

**Builds on:**
- PRD-004 daemon + `memory_jobs` worker (the codebase-graph build runs as a worker). PRD-003 catalog ColumnDef pattern (new additive `codebase` table). PRD-002 `selectBeforeInsert` (push drift detection = SELECT-before-INSERT) + escaping. PRD-011 auth (push needs auth/commit context; `HONEYCOMB_GRAPH_PUSH=0` skips). PRD-015 owns the VFS intercept that mounts `graph/`; THIS module owns the renderers (014d) only.
- **NEW:** tree-sitter (NOT a dep yet — greenfield). 9 languages. **DECISION D-1: prefer `web-tree-sitter` (WASM grammars) over native `tree-sitter` + `tree-sitter-<lang>` native modules** — WASM is deterministic, needs no native compile/postinstall, and won't break the cross-platform CI matrix (ubuntu Node 22/24 + windows-smoke). The Bee confirms `npm run build` + windows build stay green; if WASM is genuinely unworkable, native + an `ensure-tree-sitter` postinstall is the fallback (must keep windows-smoke green).
- **NEW table:** `codebase` — `snapshot_jsonb` (canonical bytes) keyed by the identity tuple `(org, workspace, repo, user, worktree, commit)` + `snapshot_sha256`. Local on-disk snapshots/cache/history under `~/.honeycomb/graphs/<repo-key>/`.

## Verification posture
Vitest (no network, no DeepLake for most): extraction against SOURCE FIXTURES (parse a known TS/JS/Python file → assert nodes/edges/parse-errors; .gitignore + .d.ts discovery; malformed→skip-not-abort; content-addressed cache reuse + rename rewrite + CACHE_SCHEMA_VERSION bump); resolution (high-confidence-only, drop ambiguous; default-import/barrel/dynamic skipped; relative-import repoint; annotateNodeDegrees); **determinism — identical content on two worktrees → identical `snapshot_sha256` (observation excluded)**; atomic write (never partial); `graph/` renderers (find/impact/neighborhood/show/tour, Levenshtein fuzzy, handles, zero-network, dead-code caveat) over a built fixture snapshot. **Opt-in LIVE: push/pull to the `codebase` table** — push (SELECT-before-INSERT → already-current / drift-refuse), pull (hash revalidation), duplicate-race; poll-convergent reads; append/SELECT the proven pattern. Out of scope: LSP/type-checking/LLM extraction (AST-only), `.d.ts`, the VFS mount mechanics (PRD-015).

## Decisions (defaults)
| # | Q | Decision |
|---|---|---|
| D-1 | parser | `web-tree-sitter` (WASM) preferred — deterministic, no native build, CI-matrix-safe. Native fallback only if WASM unworkable, must keep windows-smoke green. |
| D-2 | languages | the nine the PRD names; the framework (`extractFile` ext-routing → `FileExtraction`) is uniform; TS/JS is the richest (cross-file inputs). Each language emits nodes (file/symbol) + edges (call/import/heritage) + parse errors. |
| D-3 | cache | per-file content-addressed by sha256; reuse unchanged; a rename/copy REWRITES `source_file` + edge-id prefixes + module labels to the current path; `CACHE_SCHEMA_VERSION` bump invalidates. |
| D-4 | discovery | `git ls-files` honoring `.gitignore`, EXCLUDE `.d.ts`; no-git → manual walk skipping dotfiles + ignored dir names. |
| D-5 | resolution | HIGH-CONFIDENCE ONLY — named/namespace imports emit edges; default imports, barrels, dynamic imports, bare specifiers → NO edge (drop, never guess). Relative import → repoint to the real module node; unresolvable → keep `external:` target. |
| D-6 | determinism | `computeSnapshotSha256` hashes ONLY stable fields; the volatile `observation` fields are EXCLUDED → identical content anywhere → identical hash (AC-1 / 014b-AC-2). Canonical serialization (sorted keys, stable order). |
| D-7 | push/pull | `codebase` table keyed by the identity tuple; push = SELECT-before-INSERT: matching hash → `already-current` no-op; differing hash → log `drift`, REFUSE to overwrite; >1 row after insert → `inserted-with-duplicate-race`. Pull → revalidate the recomputed stable-hash == claimed `snapshot_sha256` or REFUSE (no corrupt row poisons the cache). No auth / no commit / `HONEYCOMB_GRAPH_PUSH=0` → skip silently; push failure → non-blocking, local stays authoritative. |
| D-8 | query surface | `graph/find/impact/neighborhood/show/tour` renderers over the LOCAL snapshot — ZERO network; ranked substring + numbered handles + Levenshtein fuzzy fallback; `show/<N>` re-validates the handle against the current snapshot; the "Incoming (0) is not proof of dead code" caveat. |
| D-9 | atomic write | snapshot write is atomic (temp + rename) → the file is the prior OR the new version, never partial (014b-AC-6). |

## Scaffold/seam plan
Wave 1 (014a + framework + snapshot skeleton): tree-sitter integration (D-1) + the `extractFile` ext-router + the TS/JS extractor (the repo's language, richest) + the 8 other language extractors (uniform framework, node/edge/parse-error) + content-addressed cache + git/manual discovery + the `FileExtraction`/`Snapshot`/node-link contracts + the `codebase` catalog table + the snapshot-builder harness (aggregate → [resolve stub] → [canonicalize stub]) + 014b/c/d stubs + CONVENTIONS.md. Wave 2 fills 014b (resolution + deterministic hash + degrees + atomic write) ‖ 014c (push/pull + drift, live) ‖ 014d (graph/ renderers). 014c/014d both consume the snapshot the Wave-1 harness + 014b produce.

---

## AC Ledger (24 sub + 4 index)

### 014a Extractors — Wave 1 (`retrieval-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| a-AC-1 | `extractFile` routes by extension → `FileExtraction` {nodes, edges, parse errors, TS cross-file inputs}. | VERIFIED (tests/daemon/runtime/codebase/extract.test.ts) |
| a-AC-2 | Unchanged file → prior `FileExtraction` reused by content sha256; rename/copy rewrites source_file + edge-id prefixes + module labels. | VERIFIED (tests/daemon/runtime/codebase/cache.test.ts) |
| a-AC-3 | `.gitignore` honored via `git ls-files`; `.d.ts` excluded. | VERIFIED (tests/daemon/runtime/codebase/discovery.test.ts) |
| a-AC-4 | Malformed file → parse errors reported, file skipped, build NOT aborted. | VERIFIED (extract.test.ts + snapshot.test.ts) |
| a-AC-5 | `CACHE_SCHEMA_VERSION` bump → old entries ignored + re-extracted. | VERIFIED (tests/daemon/runtime/codebase/cache.test.ts) |
| a-AC-6 | No git → manual walk skips dotfiles + ignored directory names. | VERIFIED (tests/daemon/runtime/codebase/discovery.test.ts) |

> **Wave 1 (014a) landed.** Parser = `web-tree-sitter@0.22.6` (WASM) + `tree-sitter-wasms@^0.1.13`
> grammars (D-1: no native compile, CI-matrix-safe; esbuild externals + `ensure-tree-sitter.mjs`
> reconciled to WASM presence-check). The `codebase` table is the EXISTING PRD-003d
> `catalog/product.ts` table (NOT a new one — the watchdog "NEW table" note was superseded; a
> duplicate was removed). Gates green from root: `npm run ci` exit 0 (84 files, 942 passed, 4
> skipped), `npm run build` exit 0 (parser bundles external + clean), `audit:openclaw` + `audit:sql`
> clean, invariant test passes. 014b/c/d seams stubbed honest.

### 014b Resolution + Snapshot — Wave 2 (`retrieval-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| b-AC-1 | Unresolved calls/imports/heritage → only high-confidence emit edges; ambiguous DROPPED, not guessed. | VERIFIED |
| b-AC-2 | Two builds of identical content → same `computeSnapshotSha256` (only stable fields hashed; `observation` excluded). | VERIFIED |
| b-AC-3 | Default import / bare specifier call site → NO edge emitted. | VERIFIED |
| b-AC-4 | Relative import → edge repointed to the real module node; unresolvable specifier keeps `external:` target. | VERIFIED |
| b-AC-5 | `annotateNodeDegrees` → fan_in/fan_out/is_entrypoint reflect cross-file edges. | VERIFIED |
| b-AC-6 | Crash during write → snapshot file is prior OR new, never partial (atomic). | VERIFIED |

### 014c Push / Pull — Wave 2 (`deeplake-dataset-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| c-AC-1 | Existing row matching hash → `already-current` no-op; differing hash → log `drift` + REFUSE overwrite. | VERIFIED |
| c-AC-2 | Pulled payload → recomputed stable-hash must == claimed `snapshot_sha256` or REFUSED (no corrupt row poisons cache). | VERIFIED |
| c-AC-3 | No auth / no commit / `HONEYCOMB_GRAPH_PUSH=0` → push skipped SILENTLY. | VERIFIED |
| c-AC-4 | Push failure → logs, does NOT block the build; local snapshot stays authoritative. | VERIFIED |
| c-AC-5 | >1 row after insert → reports `inserted-with-duplicate-race`. | VERIFIED |
| c-AC-6 | Older commit checked out locally → pull (not "local newer"). | VERIFIED |

### 014d Query Surface — Wave 2 (`retrieval-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| d-AC-1 | `graph/find/<pattern>` → ranked substring matches + numbered handles + fuzzy fallback on no match. | VERIFIED |
| d-AC-2 | `graph/impact/<pattern>` → transitive dependents; `graph/neighborhood/<file>` → file's symbols + cross-file neighbors. | VERIFIED |
| d-AC-3 | `show/<N>` → the handle resolves to the right node, re-validated against the current snapshot. | VERIFIED |
| d-AC-4 | One-char typo in a single-token pattern → Levenshtein fallback returns the intended node. | VERIFIED |
| d-AC-5 | Any endpoint → `handleGraphVfs` makes ZERO network calls, reads only the local snapshot. | VERIFIED |
| d-AC-6 | Node with no resolved incoming edges → "Incoming (0) is not proof of dead code" caveat shown. | VERIFIED |

### Index roll-ups
| Index AC | by | Status |
|---|---|---|
| AC-1 identical content → same snapshot_sha256 (observation excluded) | b-AC-2 | VERIFIED |
| AC-2 unresolved call → edge only for high-confidence named/namespace import | b-AC-1, b-AC-3 | VERIFIED |
| AC-3 push drift → log + refuse overwrite | c-AC-1 | VERIFIED |
| AC-4 `graph/impact` → transitive dependents (blast radius) | d-AC-2 | VERIFIED |

**Totals:** 28 ACs (24 sub + 4 index) · **28 VERIFIED** · 0 OPEN — fully VERIFIED (extractors/resolution/snapshot-determinism/query-surface unit-proven; push/pull drift + hash-revalidation live-proven on the real backend), close-out unlocked.

## Wave plan
```
Wave 1 (014a extractors + framework + codebase table + snapshot harness + stubs) ──► Wave 2 (014b ‖ 014c ‖ 014d) ──► Wave 3 (security → quality) ──► Ship
```
- Wave 1 · `retrieval-worker-bee` opus (owns the tree-sitter codebase graph) — parser integration (D-1, keep CI green), `extractFile` router + 9 extractors + cache + discovery + contracts + the `codebase` table + the snapshot-builder harness + 014b/c/d stubs + CONVENTIONS.md. + opt-in live push/pull itest scaffold.
- Wave 2 · 3 parallel — 014b resolution+snapshot (`retrieval-worker-bee` opus), 014c push/pull (`deeplake-dataset-worker-bee` opus, live drift), 014d query surface (`retrieval-worker-bee` opus).
- Wave 3 · `security-worker-bee` (opus — extraction can't be driven to read outside the repo root / follow symlinks out; push respects auth + scope + drift-refuse [no clobber]; pull hash-revalidation can't be bypassed [no poisoned cache]; the graph snapshot carries no secret/token from source; `git ls-files`/manual-walk can't be tricked into traversal; bounded on a huge repo [DoS]) → `quality-worker-bee` (sonnet).

## Watchdog / event log
- PRDs 001–013 merged (13 done); main GREEN incl. gated live job (PRD-013 sources purge fix held). PRD-014 moved→in-work, branched off main (3e9dd8f).
- Infra scan: tree-sitter is greenfield (NOT a dep) → D-1 prefer web-tree-sitter WASM (CI-matrix-safe); `codebase` table is NEW; `selectBeforeInsert` (002) = the push drift primitive; PRD-015 owns the VFS mount (014d = renderers only); no existing graph/codebase code. Wave 1 dispatched.
- Wave 2 DONE: 014b resolution+snapshot (retrieval, opus — high-confidence resolve [named/namespace resolve; default/barrel/dynamic/bare DROP], deterministic `computeSnapshotSha256` over STABLE fields only [`observation` excluded → identical content anywhere = same hash], annotateNodeDegrees, atomic temp+rename write; moved push/pull/vfs stubs out of snapshot.ts → clean files for c/d). 014c push/pull (deeplake, opus — `push-pull.ts`: SELECT-before-INSERT drift [matching=already-current, differing=drift-REFUSE-no-clobber], duplicate-race detect, pull recomputes hash + REFUSES a tampered payload, commit-ordering pull, skip on no-auth/no-commit/HONEYCOMB_GRAPH_PUSH=0, push-failure non-blocking; PushOutcome union; native throwaway-table isolation via injectable resolveTable + poll-convergent reads — NOT a SQL-string proxy). 014d query surface (retrieval, opus — `query.ts`: find ranked+handles+Levenshtein-fuzzy, impact=reverse-BFS transitive dependents, neighborhood, show/<N> handle re-validated against snapshot hash, ZERO network [imports only contracts], Incoming(0)-not-dead-code caveat). Orchestrator root-verify: ci=0 (998/4-skip), build/audit:openclaw/audit:sql=0 (a query.ts message false-tripped audit:sql's FROM heuristic → reworded), invariant green, codebase suite 88 tests. **Live push/pull 3/3 clean** (insert→already-current→drift-refused→pull+revalidate).
- All 28 ACs VERIFIED. Parser web-tree-sitter WASM keeps the CI matrix safe (pack:check green). Daemon-assembly wiring (the build worker, the graph/ VFS mount [PRD-015 owns it], the push trigger) deferred+documented. Wave 3 (security → quality) dispatched.
