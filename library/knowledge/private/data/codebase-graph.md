# Codebase Graph

> Category: Data | Version: 1.0 | Date: June 2026 | Status: Active

How Honeycomb builds a live graph of files, symbols, and edges from source code: the discover-extract-snapshot build pipeline, the tree-sitter extractors for nine languages, cross-file resolution, content-addressed caching, deterministic snapshot hashing, cloud push through the `codebase` table, the `pullSnapshot` read, and the synthesized `graph/` query surface agents read.

**Related:**
- [`deeplake-storage.md`](deeplake-storage.md)
- [`schema.md`](schema.md)
- [`memory-virtual-filesystem.md`](memory-virtual-filesystem.md)
- [`../ai/knowledge-graph-ontology.md`](../ai/knowledge-graph-ontology.md)
- [`../architecture/daemon-surface.md`](../architecture/daemon-surface.md)
- [`../architecture/request-lifecycle.md`](../architecture/request-lifecycle.md)
- [`../overview.md`](../overview.md)

---

## Why a code graph

Recall over raw conversation traces tells an agent what was discussed; a code graph tells it how the code is actually wired. The graph subsystem (`src/daemon/runtime/codebase/`) extracts files, symbols, and relationships directly from source so an agent can ask "who calls this function", "what is the blast radius of changing this symbol", or "walk me through this subsystem" and get answers grounded in the current checkout rather than in prose.

The output deliberately mirrors the NetworkX node-link JSON format (a directed multigraph) so any tool that already understands NetworkX graphs can consume a snapshot. The feature is AST-only: it uses tree-sitter parsers, never an LSP, a type checker, or an LLM, which keeps builds fast and deterministic. Nine languages are supported: TypeScript, JavaScript, Python, Go, Rust, Java, Ruby, C, and C++.

The build is owned by the honeycomb daemon (port 3850), which runs the codebase-graph worker as a background job. `honeycomb graph build` POSTs `/api/graph/build`. Only the daemon talks to DeepLake when it comes time to push a snapshot to the cloud.

---

## The build pipeline

`honeycomb graph build` asks the daemon to walk the repo, extract every supported source file, aggregate the results into one snapshot, and write it under `honeycombStateDir()/graphs/<repo-key>/` (`join(honeycombStateDir({ home }), "graphs", repoKey)` in `src/daemon/runtime/codebase/snapshot.ts`, `~/.apiary/honeycomb/graphs/<repo-key>/` on a default install).

```mermaid
flowchart TD
    build["honeycomb graph build"] --> daemon["daemon runs graph worker"]
    daemon --> discover["discoverSourceFiles"]
    discover --> gitls["git ls-files honors gitignore"]
    discover --> walk["fallback manual walk"]
    gitls --> perFile["per file"]
    walk --> perFile
    perFile --> cacheCheck{"content-hash cached"}
    cacheCheck -->|hit| reuse["reuse FileExtraction"]
    cacheCheck -->|miss| extract["extractFile tree-sitter"]
    extract --> writeCacheStep["writeCache by content sha256"]
    reuse --> aggregate["buildSnapshot"]
    writeCacheStep --> aggregate
    aggregate --> resolve["cross-file calls imports heritage"]
    resolve --> degrees["annotateNodeDegrees"]
    degrees --> sortStep["sort nodes edges canonical"]
    sortStep --> writeStep["writeSnapshot atomic"]
    writeStep --> push["pushSnapshot via daemon best-effort"]
```

Source discovery prefers git's own ignore engine: `git ls-files --cached --others --exclude-standard -z` lists tracked plus untracked-not-ignored files, honoring `.gitignore` exactly (anchoring and nested rules included). A user-editable ignore set, `graph-ignore.json` under `honeycombStateDir()`, is applied as a safety net for directories the repo happens to track, with a legacy `~/.honeycomb/graph-ignore.json` fallback (`src/daemon/runtime/codebase/discovery.ts`). When git is unavailable (a loose source directory), discovery falls back to a manual recursive walk that skips dotfiles and ignored directory names. Source files are recognized by extension; `.d.ts` declarations are excluded because they carry no implementation.

Each file is content-hashed and looked up in the per-repo cache before extraction. The repo key is derived from the normalized git remote URL, so the same project resolves to the same storage directory across checkouts.

---

## Extraction: per-file, language-routed

`extractFile` routes a file to the language-appropriate extractor by extension. Every extractor produces the same `FileExtraction` shape, which keeps the snapshot builder and the cross-file passes language-agnostic.

```typescript
export async function extractFile(
  sourceFile: string,
  content: string,
  sha?: string,
): Promise<FileExtraction | null>
```

`languageForFile` and `EXTENSION_LANGUAGE` (`src/daemon/runtime/codebase/extract.ts`) route TypeScript, JavaScript, Python, Go, Rust, Java, Ruby, C, and C++. `.d.ts`, `.d.mts`, and `.d.cts` return null. An unsupported file returns null. A malformed file comes back as a `FileExtraction` with `parseErrors` populated, and the build continues.

A `FileExtraction` carries the nodes and edges found in that file, any tree-sitter parse errors (so a malformed file is reported and skipped rather than silently lost), and two optional cross-file inputs the TypeScript extractor populates: `raw_calls` (call sites that could not be resolved within the file) and `import_bindings` (the file's imports, each tagged named, default, or namespace, with a `type_only` flag).

---

## The node and edge model

A node is a file or a symbol (`kind` is `file` or `symbol`, `src/daemon/runtime/codebase/contracts.ts`). A file node's `id` is the source file. A symbol node's `id` is `<source_file>#<name>`, with an optional `:<ord>` when overloads need a disambiguator.

| Node field | Meaning |
|---|---|
| `id` | File: the source file. Symbol: `<source_file>#<name>` with optional `:<ord>` |
| `kind` | `file` or `symbol` |
| `name` | Symbol name, or the file basename for a file node |
| `sourceFile` | Repo-relative path |
| `language` | One of the nine supported languages |
| `symbolKind` | `function`, `method`, `class`, `interface`, `struct`, `enum`, `type`, `variable`, `constant`, or `module` (absent on a file node) |
| `exported` | Whether the symbol is exported |
| `observation` | Volatile block excluded from the content hash: `startLine`, `endLine`, `fanIn`, `fanOut`, `isEntrypoint` |

Edges are directed and typed. The `relation` is one of `imports`, `calls`, `extends`, `implements`, or `method_of`, and each edge carries a `confidence` of `EXTRACTED`, `INFERRED`, or `AMBIGUOUS` (current edges are almost entirely `EXTRACTED` because they are concrete AST facts). An optional `ord` disambiguates multigraph edges that share the same source, target, and relation (a function calling another twice).

```mermaid
flowchart LR
    moduleNode["file module"] -->|imports| exportedFn["b.ts foo function"]
    callerFn["a.ts bar function"] -->|calls| exportedFn
    subclass["a.ts Child class"] -->|extends| baseClass["b.ts Base class"]
    classNode["a.ts Svc class"] -->|method_of| methodNode["a.ts Svc.run method"]
```

---

## Cross-file resolution

After every file is extracted, `buildSnapshot` runs three resolution passes that turn per-file placeholders into real cross-file edges. Resolution is high-confidence only; ambiguous cases are dropped, not guessed.

The calls pass (`resolveCrossFileCalls`) matches each unresolved `raw_call` against the file's import bindings and the global export index. It emits an edge only for a named import (including `as` aliases) whose matching export exists in a resolvable local file, or a namespace call `ns.foo()` where `ns` is `import * as ns from "./local"` and the local file exports `foo`. Default imports, bare (npm) specifiers, tsconfig path aliases, barrel re-exports, instance dispatch, and dynamic `import()` are deliberately skipped.

The imports pass (`repointImportEdges`) repoints an `imports` edge from a placeholder `external:<specifier>` to the real module node when the specifier is relative and resolves to a known repo file; bare and unresolvable specifiers keep their `external:` target so "our code versus a dependency" stays distinguishable. The heritage pass (`resolveHeritageEdges`) resolves `extends` and `implements` placeholders to a same-file declaration or a named-import cross-file base type.

Module resolution (`resolveModule`) tries the common TS suffixes in a deterministic order (the explicit extension first, then the importer's own family, then the other), and falls through to `index` files. Python files route to `resolvePythonModule`, which handles dot-relative imports by climbing package levels and dotted-absolute imports by anchoring on a unique path suffix; an ambiguous suffix match is dropped.

Once edges are fully resolved, `annotateNodeDegrees` sets `fan_in`, `fan_out`, and `is_entrypoint` (`exported && fan_in === 0`) from the complete edge set, so degrees reflect cross-file relationships rather than just intra-file ones.

---

## Snapshots: deterministic and content-addressed

A snapshot is canonicalized before it is hashed or written. `buildSnapshot` sorts nodes by `id` and edges by `(source, target, relation, ord)`, and `canonicalJSON` serializes with object keys sorted at every nesting level and no inserted whitespace. The same code therefore always serializes to the same bytes.

The content hash covers only the stable fields:

```typescript
export function computeSnapshotSha256(snapshot: GraphSnapshot): string {
  const stable = {
    directed: snapshot.directed,
    multigraph: snapshot.multigraph,
    graph: snapshot.graph,
    nodes: snapshot.nodes,
    links: snapshot.links,
  };
  return createHash("sha256").update(canonicalJSON(stable)).digest("hex");
}
```

The `observation` field (timestamp, branch, worktree path, generator version, file counts) is deliberately excluded so two builds of identical code on different worktrees, branches, or at different times produce the same `snapshot_sha256` and dedup correctly. Any new field that is volatile must go into `observation`, never into `graph`, or this hash silently breaks dedup.

`writeSnapshot` writes atomically (temp file plus `renameSync` in the same directory, so a crash leaves either the old file or the new one, never a partial). The snapshot lands at `<baseDir>/snapshots/<commit-sha>.json`, or `<snapshot-sha256>.json` when there is no commit context. Per-worktree singletons (`latest-commit.txt` and `.last-build.json`) live under `worktrees/<worktree-id>/` so two checkouts of the same repo on one machine do not clobber each other's metadata, while snapshots and the cache stay shared at the repo level. The worktree id is a sha256 of the absolute worktree path, truncated to 16 characters.

---

## Caching: content-addressed, self-healing

The per-file cache turns a full rebuild from seconds into tens of milliseconds when only one file changed. Its key is the sha256 of the file content, not the path, so identical content across files, branches, or users shares one entry.

```
<honeycombStateDir>/graphs/<repo-key>/.cache/<content-sha256>.json
```

On a default install that directory is `~/.apiary/honeycomb/graphs/<repo-key>/`.

Because the cache is content-addressed, invalidation is automatic: different content yields a different key, so a stale read is impossible. A `CACHE_SCHEMA_VERSION` embedded in each entry lets an extractor-output change invalidate old entries wholesale, since readers ignore mismatched-schema entries and fall through to re-extraction. On a cache hit after a rename or copy, `readCache` rewrites every `source_file` field, every edge id prefix, and every module node label to the caller's current path, so a reused entry never leaks the original path back into the snapshot. Corrupt entries fail validation and fall through to a fresh extraction that overwrites them.

---

## Cloud sync: push and pull

A successful build pushes the snapshot to the `codebase` table (see [`schema.md`](schema.md)) through the daemon when the user is authenticated. The daemon owns the connection to DeepLake; the worker hands it the canonical bytes. Push is best-effort: the local snapshot is the source of truth, and any failure logs without blocking the build. Push is skipped silently when there is no auth, no commit context, or `HONEYCOMB_GRAPH_PUSH=0`.

`pushSnapshot` uses SELECT-before-INSERT with drift detection, the same pattern the rest of Honeycomb uses to work around DeepLake's UPDATE-coalescing quirk. It selects the row for the full identity key `(org, workspace, repo, user, worktree, commit)`. If a row exists with a matching `snapshot_sha256` it is a no-op (`already-current`); if it exists with a different hash it logs a `drift` warning and refuses to overwrite, because the same commit producing different content means extractor-version drift that a human should investigate. With no existing row it inserts, storing the canonical bytes in the `snapshot_jsonb` jsonb column. Because the identity key has no server-side UNIQUE constraint, the function re-selects after insert and reports `inserted-with-duplicate-race` if more than one row is found, making the race observable rather than silent; the SessionEnd auto-build path also takes a cross-process build lock to serialize the most common concurrent caller.

`pullSnapshot` answers the opposite question: the freshest snapshot of the current HEAD for this user, from any worktree. It relaxes the identity key to drop `worktree_id` and takes `ORDER BY created_at DESC LIMIT 1` (`src/daemon/runtime/codebase/push-pull.ts`). `CODEBASE_COLUMNS` has `created_at`. Identical source content extracts to identical bytes regardless of which checkout produced it. Before writing anything to disk it validates the payload shape and recomputes the stable-field hash, refusing a payload whose hash does not match the claimed `snapshot_sha256` so a corrupt row never poisons the local cache. It also gates the local-newer comparison on the local build referring to the same commit, so checking out an older commit correctly pulls rather than wrongly reporting "local newer". The function is not mounted as a route in `src/daemon/runtime/codebase/api.ts`.

---

## The query surface

Agents read the graph through the synthesized `graph/` subtree of the memory mount (the bridge is described in [`memory-virtual-filesystem.md`](memory-virtual-filesystem.md)). `handleGraphVfs` reads only the local snapshot and renders text on the fly:

| Endpoint | Returns |
|---|---|
| `index.md` | Overview: commit, node and edge counts, node and edge kind breakdowns, top files, limitations |
| `find/<pattern>` | Case-insensitive substring search on node id and label, numbered handles, fuzzy fallback on no match |
| `query/<pattern>` | The 2-in-1: find plus a 1-hop neighbor expansion of the top matches grouped by relation |
| `show/<handle-or-pattern>` | Full node detail plus incoming and outgoing edges grouped by relation |
| `impact/<pattern>` | Transitive dependents (blast radius) of a symbol |
| `neighborhood/<file>` | Symbols in a file plus their cross-file neighbors |
| `layers` | Architectural subsystem grouping by path heuristic |
| `tour` | Deterministic dependency-ordered walkthrough |
| `path/<from>/<to>` | Shortest path between two symbol patterns |

Search ranks exact label over prefix over id-contains over label-contains, tie-broken by id. A single token with no substring hit falls back to a bounded zero-dependency Levenshtein fuzzy match (typo tolerance like `pushSnaphot` to `pushSnapshot`). `find/` persists numbered handles per worktree in `.find-handles.json` so a follow-up `show/<N>` resolves the right node, and `show/` re-validates that the handle still points at a node present in the current snapshot.

The renderers carry an honest caveat: cross-file `calls` are resolved only for relative named and namespace imports, so a node reading "Incoming (0)" is not proof of dead code (a caller may reach it through an unresolved import path), and a snapshot whose source files have been edited since the build is stale and should be cross-checked against live source.

---

## CLI and daemon surface

`honeycomb graph` is a storage verb routed to `/api/graph` (`src/commands/contracts.ts`, `src/commands/storage-handlers.ts`). `honeycomb graph build` POSTs `/api/graph/build`. The daemon graph mount is that POST and `GET /api/graph` (`src/daemon/runtime/codebase/api.ts`). The local snapshot remains the authoritative source for every read.
