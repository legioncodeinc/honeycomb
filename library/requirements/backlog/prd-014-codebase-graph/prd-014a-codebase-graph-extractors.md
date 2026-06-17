# PRD-014a: Extractors and Cache

> **Parent:** [PRD-014](./prd-014-codebase-graph-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** L

## Scope

The per-file, language-routed tree-sitter extractors (nine languages) producing a uniform `FileExtraction`, plus the content-addressed per-file cache keyed by content sha256 that turns a full rebuild into tens of milliseconds when one file changed. The feature is AST-only: tree-sitter parsers, never an LSP, type checker, or LLM. The build is owned by the honeycomb daemon (port 3850); only the daemon talks to DeepLake.

## Goals

- Extract files, symbols, and per-file relationships from nine languages into one uniform shape.
- Keep the snapshot builder and cross-file passes language-agnostic by funneling every extractor through the same `FileExtraction`.
- Make rebuilds near-instant when only a few files changed via a content-addressed cache.

## Non-Goals

- Cross-file resolution (covered by PRD-014b).
- Any use of LSP, type checkers, or LLMs.
- Ingesting `.d.ts` declaration files (no implementation to extract).

## User stories

- As the graph worker, I want each file extracted to a uniform shape so that the snapshot builder and cross-file passes stay language-agnostic.
- As a developer, I want a rebuild after a one-file change to be near-instant so that the post-commit hook does not slow my workflow.
- As an operator, I want malformed files reported rather than silently dropped so that coverage gaps are visible.

## Functional requirements

- FR-1: `extractFile` MUST route a file to the language-appropriate extractor by extension, covering TypeScript, JavaScript, Python, Go, Rust, Java, Ruby, C, and C++.
- FR-2: Every extractor MUST produce the same `FileExtraction` shape carrying nodes, edges, and any tree-sitter parse errors.
- FR-3: The TypeScript extractor MUST additionally populate `raw_calls` (unresolved-in-file call sites) and `import_bindings` (imports tagged named, default, or namespace, each with a `type_only` flag) for the cross-file passes.
- FR-4: Source discovery MUST prefer `git ls-files --cached --others --exclude-standard -z`, honoring `.gitignore` exactly, with a fallback manual recursive walk when git is unavailable that skips dotfiles and ignored directory names.
- FR-5: A user-editable ignore set at `~/.honeycomb/graph-ignore.json` MUST be applied as a safety net for tracked directories.
- FR-6: `.d.ts` declaration files MUST be excluded; source files MUST be recognized by extension.
- FR-7: A malformed file MUST report its parse errors and be skipped, never silently lost.
- FR-8: Each file MUST be content-hashed and looked up in the per-repo cache at `~/.honeycomb/graphs/<repo-key>/.cache/<content-sha256>.json` before extraction; the repo key MUST derive from the normalized git remote URL.
- FR-9: The cache MUST be content-addressed so invalidation is automatic; a `CACHE_SCHEMA_VERSION` embedded in each entry MUST invalidate old entries wholesale on an extractor-output change.
- FR-10: On a cache hit after a rename or copy, `readCache` MUST rewrite every `source_file` field, every edge id prefix, and every module node label to the caller's current path so a reused entry never leaks the original path.
- FR-11: A corrupt cache entry MUST fail validation and fall through to a fresh extraction that overwrites it.
- FR-12: `writeCache` MUST key entries by content sha256 so identical content across files, branches, or users shares one entry.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a source file, when `extractFile` runs, then it routes by extension to the right extractor and returns a `FileExtraction` with nodes, edges, parse errors, and TS cross-file inputs. |
| AC-2 | Given an unchanged file on rebuild, when the cache is consulted, then the prior `FileExtraction` is reused by content sha256, and a renamed/copied file rewrites `source_file`, edge id prefixes, and module labels to the current path. |
| AC-3 | Given a repo with a `.gitignore`, when discovery runs, then ignored files are excluded via git ls-files and `.d.ts` files are excluded. |
| AC-4 | Given a malformed file, when extraction runs, then parse errors are reported and the file is skipped without aborting the build. |
| AC-5 | Given an extractor-output change, when `CACHE_SCHEMA_VERSION` is bumped, then old entries are ignored and re-extracted. |
| AC-6 | Given no git available, when discovery runs, then the manual walk skips dotfiles and ignored directory names. |

## Implementation notes

- Cache at `~/.honeycomb/graphs/<repo-key>/.cache/<content-sha256>.json`; content-addressed so invalidation is automatic, with a `CACHE_SCHEMA_VERSION` for wholesale invalidation.
- `.d.ts` excluded; malformed files report parse errors and are skipped, not silently lost.
- AST-only via tree-sitter; no LSP, type checker, or LLM.

## Dependencies

- tree-sitter grammars for the nine supported languages.
- The git CLI for ignore-aware discovery (with manual-walk fallback).
- PRD-014b consumes the `FileExtraction` outputs.

## Open questions

- [ ] Confirm whether tree-sitter grammars are bundled as `external` or vendored into the daemon build.

## Related

- [parent index](./prd-014-codebase-graph-index.md)
- [Codebase Graph](../../../knowledge/private/data/codebase-graph.md)
