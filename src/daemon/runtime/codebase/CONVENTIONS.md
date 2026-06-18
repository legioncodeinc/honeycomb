# Codebase-graph conventions (PRD-014) — READ BEFORE FILLING A WAVE-2 SEAM

Wave 1 (014a) established these. Wave 2 (014b ‖ 014c ‖ 014d) follows them **verbatim**.
The seam wiring is designed so a Wave-2 Bee edits **only its own seam + its own test
file** and never touches the contracts, the extractor framework, the cache, discovery,
or the catalog.

---

## 1. The thesis (every rule descends from this)

- **AST-ONLY.** Every node and edge comes from a tree-sitter parse of the file on disk
  — **never** an LSP, a type checker, or an LLM. A symbol we cannot see in the syntax
  tree does not exist in the graph. This is the speed + determinism contract.
- **DETERMINISM by field discipline (D-6).** Every contract field is tagged **STABLE**
  (hashed into `snapshot_sha256`) or **VOLATILE** (excluded). The volatile data lives
  under an `observation` key — `NodeObservation` per node, `SnapshotObservation` per
  snapshot. **Identical source content on two worktrees → identical hash → one stored
  row.** Any NEW field you add MUST be classified, and a volatile one MUST go under an
  `observation` block or dedup silently breaks.
- **HIGH-CONFIDENCE edges only (014b).** A per-file extraction emits PLACEHOLDER edges
  whose unresolved targets are `external:<specifier>`. The 014b resolve pass repoints
  ONLY the ones it can prove (named/namespace imports → a real repo file) and DROPS the
  ambiguous rest (default imports, barrels, dynamic `import()`, bare specifiers). Never
  guess an edge.

## 2. The parser is `web-tree-sitter` (WASM), NOT native (D-1)

The parser is **`web-tree-sitter`** (a WASM/emscripten runtime) + **`tree-sitter-wasms`**
(prebuilt `.wasm` grammars for the nine languages). This was chosen over native
`tree-sitter` + `tree-sitter-<lang>` bindings because WASM needs **no native
compile/postinstall** and is **deterministic across the CI matrix** (ubuntu Node 22/24
+ windows-smoke) — there is no node-gyp, no C/C++ toolchain, no per-platform/per-ABI
build that could break Windows or linux-arm64.

- Pinned: `web-tree-sitter@0.22.6` ↔ `tree-sitter-wasms@^0.1.13` (the grammars are built
  for the 0.20-era tree-sitter ABI; `web-tree-sitter` 0.21–0.22 loads all ten grammar
  `.wasm` files — including ruby, which 0.20.x could not). **Do not bump
  `web-tree-sitter` past the ABI window without re-pairing the grammar pack** — a
  mismatch surfaces as a `getDylinkMetadata` WASM load failure.
- The framework (`extract.ts`) owns the parser lifecycle: it `Parser.init()`s once,
  loads each grammar `.wasm` LAZILY from `tree-sitter-wasms/out/` (resolved via
  `require.resolve`) and caches it. The extractors NEVER import `web-tree-sitter` — they
  walk the minimal `SyntaxCursorNode` surface the framework adapts.
- Build wiring: `esbuild.config.mjs` keeps `web-tree-sitter` + `tree-sitter-wasms`
  **external** (the WASM runtime + grammar `.wasm` files load from `node_modules` at
  runtime; they are data, not bundleable modules). `scripts/ensure-tree-sitter.mjs` is
  now a **presence check, not a compiler** — it confirms the runtime + ten grammars
  resolved and exits 0 (non-fatal; strict only under `HONEYCOMB_STRICT_POSTINSTALL=1`).

## 3. The pinned contracts (what Wave 2 codes against)

Single-sourced in `contracts.ts`. **Wave 2 does not change a field.**

- **`FileExtraction`** — the ONE shape every extractor returns: `{ sourceFile,
  language, nodes, edges, parseErrors, tsCrossFileInputs?, contentSha256 }`.
- **`GraphNode`** — a `file` or `symbol` node. STABLE: `id` / `kind` / `name` /
  `sourceFile` / `language` / `symbolKind?` / `exported?`. VOLATILE: `observation`
  (`startLine`/`endLine`/`fanIn?`/`fanOut?`/`isEntrypoint?`).
- **`GraphEdge`** — a `calls`/`imports`/`extends`/`implements`/`method_of` edge. ALL
  STABLE. `id` is **prefixed by `sourceFile`** (`<source_file>::<relation>::<src>-><dst>[:ord]`)
  so a rename rewrite + per-file re-extraction touch only that file's edges. An
  unresolved `dst` is `external:<specifier>`.
- **`Snapshot`** — NetworkX node-link JSON (`{ directed, multigraph, graph, nodes,
  links, observation }`). STABLE: everything but `observation` (VOLATILE).
- **`Extractor`** — the per-language seam: `extract({ sourceFile, content,
  contentSha256, handle }) → FileExtraction`. PURE, stateless, NEVER throws on a
  malformed file.
- **`TsCrossFileInputs`** — TS/JS-only: `importBindings` (named/default/namespace +
  `typeOnly`) + `rawCalls` (callee + object). The richness 014b's resolve pass consumes.

### STABLE vs VOLATILE — the table 014b's hash MUST honor

| Field | Where | STABLE (hashed) | VOLATILE (excluded) |
|---|---|---|---|
| node `id`/`kind`/`name`/`sourceFile`/`language`/`symbolKind`/`exported` | `GraphNode` | ✅ | |
| node `observation.startLine`/`endLine` | `NodeObservation` | | ✅ |
| node `observation.fanIn`/`fanOut`/`isEntrypoint` | `NodeObservation` (014b) | | ✅ |
| edge `id`/`relation`/`src`/`dst`/`confidence`/`ord`/`specifier` | `GraphEdge` | ✅ | |
| snapshot `directed`/`multigraph`/`graph`/`nodes`/`links` | `Snapshot` | ✅ | |
| snapshot `observation.*` (timestamp/branch/worktree/version/counts) | `SnapshotObservation` | | ✅ |

`computeSnapshotSha256` (014b) hashes ONLY the STABLE columns and EXCLUDES every
`observation` block — both the snapshot-level one AND each node's. That is the entire
determinism guarantee (014b-AC-2 / index AC-1).

## 4. The nine languages (D-2)

`extractFile` routes by EXTENSION to one `Extractor` per language: TypeScript,
JavaScript, Python, Go, Rust, Java, Ruby, C, C++. The framework is uniform — every
language emits file/symbol nodes + call/import/heritage edges + parse errors.

- **TS/JS is the RICHEST** (`extractors/ts-js.ts`): it additionally fills
  `tsCrossFileInputs` so 014b resolves calls + imports across files. Do it fully.
- **The other seven** (`extractors/structural.ts`): a spec-driven driver grounded in
  each language's real grammar (verified node types + field names). "Lighter but real,
  not a stub" — symbols + imports + calls + heritage, no cross-file inputs.
- `.tsx`/`.jsx` route to the TS/JS extractor with the `tsx` grammar variant.
- A new language beyond the nine implements exactly the `Extractor` seam and registers
  in `extract.ts`'s `EXTRACTORS` + a `LanguageSpec` (structural) or its own module (rich).

## 5. Malformed → skip, never abort (a-AC-4)

An extractor NEVER throws on a malformed file. When the tree `hasError`, it returns a
`FileExtraction` with a single file node + a populated `parseErrors`. The harness
(`buildAggregateSnapshot`) then keeps ONLY the file node (the degraded marker) and
SKIPS the untrusted symbols/edges — **the build continues**. A grammar that fails to
load or an extractor that unexpectedly throws is caught in `extractFile` and reported
as a parse error, not an abort.

## 6. The content-addressed cache (a-AC-2 / a-AC-5)

`ExtractionCache` (in `cache.ts`) keys entries by content sha256 at
`<baseDir>/.cache/<sha>.json`. **Content-addressed ⇒ automatic invalidation.** On a hit:
- a RENAME/COPY (same content, new path) **rewrites** `source_file` + every node id
  prefix + every edge-id prefix + every same-file `src`/`dst` to the current path
  WITHOUT re-parsing (a-AC-2 / FR-10). An `external:` target is NOT a path, so it is left
  intact.
- `CACHE_SCHEMA_VERSION` mismatch ⇒ the entry is ignored and the file re-extracted
  (a-AC-5). **Bump `CACHE_SCHEMA_VERSION` whenever the extractor output shape changes.**
- a corrupt entry (bad JSON / wrong sha / missing fields) falls through to a fresh
  extraction that overwrites it (FR-11).

## 7. Discovery (a-AC-3 / a-AC-6)

`discoverSourceFiles` prefers `git ls-files --cached --others --exclude-standard -z`
(honors `.gitignore` EXACTLY — no re-implementation) and falls back to a manual walk
(skips dotfiles/dot-dirs + `node_modules`/`dist`/… ; never follows symlinks) when git is
unavailable. BOTH modes exclude `.d.ts` and keep only recognized source extensions,
apply the `~/.honeycomb/graph-ignore.json` safety net (FR-5), and BOUND the result at
`MAX_DISCOVERED_FILES` (the DoS guardrail).

## 8. The `codebase` catalog table is final (`catalog/product.ts`)

The `codebase` table is NOT new to PRD-014 — it was laid down by **PRD-003d**
(`catalog/product.ts`, `CODEBASE_COLUMNS`, ported from hivemind-v1). PRD-014 is the
FEATURE that fills it; Wave 1 does NOT add a second table (doing so collides — the
registry rejects a duplicate name). It is already `pattern: "select-before-insert"`,
`scope: "tenant"` (explicit `org_id` + `workspace_id`), keyed by the identity tuple
`(org_id, workspace_id, repo_slug, user_id, worktree_id, commit_sha)`, with
`snapshot_jsonb` (canonical node-link bytes), `snapshot_sha256` (the drift comparator),
and drift-diagnostic columns (`generator_version`, `schema_version`, `parent_sha`). The
runtime `SnapshotIdentity` (`org`/`workspace`/`repo`/`user`/`worktree`/`commit`) maps
onto those columns at push time.

**Push (014c) is SELECT-before-INSERT** (PRD-002 `selectBeforeInsert`; the dedup probe
is `product.ts`'s `buildSnapshotDedupSql`): matching hash → `already-current`; differing
hash → log `drift` + REFUSE overwrite; >1 row → `inserted-with-duplicate-race`. **Pull
(014c)** revalidates the recomputed stable-hash == claimed `snapshot_sha256` or REFUSES.
**Wave 2 does not change a column** — the columns are single-sourced and final. A
column/DDL change is handed to **deeplake-dataset-worker-bee**.

## 9. Where each Wave-2 Bee writes

| Sub-PRD | Seam (fill the stub) | Test file (edit this) | Must NOT touch |
|---------|----------------------|-----------------------|----------------|
| 014b resolution + snapshot | `snapshot.ts` (`resolveCrossFile`/`annotateNodeDegrees`/`computeSnapshotSha256`/`writeSnapshotAtomic`), plus a new `resolve.ts` if helpful | `tests/daemon/runtime/codebase/snapshot.test.ts` | `contracts.ts`, `extract.ts`, `extractors/*`, `cache.ts`, `discovery.ts`, `catalog/codebase.ts` |
| 014c push/pull | `snapshot.ts` (`pushSnapshot`/`pullSnapshot`), plus a `deeplake-push.ts`/`deeplake-pull.ts` if helpful | `tests/daemon/runtime/codebase/push-pull.test.ts` + the live itest | the extractor framework, the cache, the contracts |
| 014d query surface | `snapshot.ts` (`handleGraphVfs`), plus a `render/*` module | `tests/daemon/runtime/codebase/query.test.ts` | the extractor framework, the cache, the contracts |

Each seam already has a fixed signature + a `notImplemented(...)` stub naming its PRD.
A Wave-2 Bee REPLACES the stub body; it does not change the signature.

> **014b landed (moved stubs out for zero contention).** The 014c `pushSnapshot`/
> `pullSnapshot` and 014d `handleGraphVfs` stubs were REMOVED from `snapshot.ts` (and
> from `index.ts`): 014c creates `push-pull.ts`, 014d creates `query.ts`, each owning a
> clean file. `snapshot.ts` now holds the 014b finalize seams + `finalizeSnapshot`
> (resolve → `buildSnapshot` sort → `annotateNodeDegrees` → `computeSnapshotSha256` →
> `writeSnapshotAtomic`), delegating to `resolve.ts` / `degrees.ts` / `hash.ts`.
> `computeSnapshotSha256` stays EXPORTED for 014c's pull-revalidation.

## 10. SQL safety (the catalog + any 014c builder)

Every dynamic SQL fragment routes through the 002b helpers: `sqlIdent` (identifiers),
`sLiteral`/`eLiteral` (values via the `val.*` constructors). The 014c push/pull goes
through the heal-aware `selectBeforeInsert` primitive (→ guarded `buildInsert`). `npm
run audit:sql` scans `src/daemon` and fails CI on a raw interpolation. **Daemon-only
storage:** the extractor framework + cache + discovery touch ONLY the local filesystem;
the `codebase`-table push (014c) is daemon-side. CLIs import no storage.

## 11. Deferred daemon-assembly wiring (NOT 014a)

The graph build runs as a `memory_jobs` worker (PRD-004): in production the daemon
constructs the identity tuple, calls `buildAggregateSnapshot` → the 014b finalize → the
014c push. 014a does NOT wire `server.ts` or the worker registry — it provides the
harness + seams the assembly step calls. **PRD-015 owns the VFS intercept that mounts
`graph/`; THIS module owns only the `handleGraphVfs` renderer (014d).** The build-lock,
git-hook install, and on-stop triggers the recall stinger's guide describes are later
wiring, not 014a.
