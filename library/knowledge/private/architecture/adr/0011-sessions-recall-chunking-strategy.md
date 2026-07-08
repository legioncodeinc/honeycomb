# ADR-0011, Sessions recall chunking: build in-tree, do not pull a chunker dependency

> **Status:** Proposed · **Date:** 2026-07-05
> **Supersedes:** none · **Superseded by:** none
> **Owners:** retrieval, typescript-node · **Related:** PRD-074 (the prose column that surfaced this gap), PRD-047a / ADR-0001 (RRF over native hybrid), the planned PRD-075 (window-on-match) and PRD-076 (capture-time chunking)

## Context

PRD-074 shipped a `prose` TEXT column on `sessions` so the live lexical recall arm stops casting the JSONB `message` envelope to `::text` and shipping the full escaped JSON blob to the harness context window. That fixed the JSON-structure overhead. It surfaced a deeper problem: **the prose is a head-and-cap slice, not a window around the matched term.** A `Read` tool call whose matched substring sits at character offset 4800 of a 10 KB response surfaces with a 500-char snippet that *ends well before the match* — the hit is invisible to the harness, just burned context.

Two follow-up PRDs will close this:

- **PRD-075 (read-time, fast):** window-on-match in `proseForToolCall` (slice ~200 chars before + the match + ~200 after, capped at 500) + an optional `matchRange: { start, end }` field on `MemoryRecallHit` so the harness can drill a precise follow-up `Read`.
- **PRD-076 (capture-time, schema event):** true per-event chunking — each `sessions` event persisted as multiple chunk rows with line/char bounds; recall ranks chunks, not events. Aligns `sessions` with how `memories.normalized_content` (one distilled row per fact) and the codebase-graph tree-sitter extractor (AST chunks) already work.

Mario asked whether an MIT-licensed chunker (LangChain's `RecursiveCharacterTextSplitter`, LlamaIndex's `SentenceSplitter`, etc.) should be pulled from npm to sit between the LLM and DeepLake as the chunker for these PRDs. This ADR records the decision and grounds it in the codebase's actual state.

## Decision drivers

- **Dependency posture.** Honeycomb runs 8 runtime deps (all MIT-compatible). The codebase has a documented "no new deps without justification" ethos — `CONVENTIONS.md`, the heal path's "no `IF NOT EXISTS`" rule, and the dependency-audit-worker-bee gate all encode it. A new dep means a new SBOM entry, a new supply-chain audit surface (`audit:openclaw`, CodeQL, socket.dev), and a permanent `npm audit` triage burden.
- **Prior art already in-tree.** Two chunkers already exist in the daemon; a third (AST-aware) lives in the codebase-graph extractor.
- **Token-budget alignment.** Chunking for recall has to align with the embedding model's token window; a chunker that ignores tokens produces chunks the embedder silently truncates.
- **Cross-repo scope.** PRD-076 is a honeycomb + nectar arc (both products have invisible-file problems); the chunker decision sets a contract both repos consume.
- **Reversibility.** Read-time windowing (PRD-075) is fully reversible in one commit. Capture-time chunking (PRD-076) is a schema event; the chunker choice is much harder to reverse once chunks land in DeepLake.

## Grounding: what's already in the tree

Three relevant pieces of prior art were verified during recon for this ADR.

### 1. `chunkText` — the existing character-stride chunker

**`src/daemon/runtime/sources/document-worker.ts:202-213`**

```ts
export function chunkText(content: string, config: DocumentChunkConfig): string[] {
    const { chunkSize, chunkOverlap } = config;
    if (content.length <= chunkSize) return [content];
    const stride = Math.max(1, chunkSize - chunkOverlap);
    const out: string[] = [];
    for (let start = 0; start < content.length; start += stride) {
        out.push(content.slice(start, start + chunkSize));
        if (start + chunkSize >= content.length) break;
    }
    return out;
}
```

A fixed-stride character window. Dumb but real. Defaults via `DEFAULT_CHUNK_SIZE = 2_000` and `DEFAULT_CHUNK_OVERLAP = 200` (`document-worker.ts:128-132`), configurable under `pipeline.chunkSize` / `pipeline.chunkOverlap` in `agent.yaml`. Used by the document worker (the `013b` external-doc ingestion pipeline) to chunk uploaded documents into `document_chunk` rows.

### 2. `chunksFor` — the existing heading-aware markdown splitter

**`src/daemon/runtime/sources/providers/obsidian.ts:393-412`**

The Obsidian source provider splits a note by markdown headings, emits one chunk per section, and crucially **carries line-range bounds** in `metadata`:

```ts
metadata: {
    path: file.relPath,
    heading: section.heading,
    lineStart: section.lineStart,
    lineEnd: section.lineEnd,
    lines: [section.lineStart, section.lineEnd],
}
```

This is the structural shape PRD-076 wants for `sessions`: chunks with provenance and bounds, not just text windows.

### 3. The `document_chunk` table — the existing chunk schema

**`src/daemon/storage/catalog/sources.ts:202-243`** — `DOCUMENT_CHUNK_COLUMNS`:

| Column | Purpose |
|---|---|
| `id` | deterministic sha256 |
| `artifact_id` | the owning document |
| `content` | the chunk text |
| `content_hash` | sha256 — the shared-embedding dedup key (two identical chunks across documents share ONE embedding) |
| `chunk_embedding` | nullable FLOAT4[768] |
| `ordinal` | BIGINT — chunk order within the artifact |
| `metadata` | JSONB — `lineStart`/`lineEnd`/`heading`/etc |
| `status` | lifecycle (`active` / soft-deleted via version bump) |
| `version` | BIGINT — append-only version for soft-delete / purge |

**This is the schema PRD-076 should mirror for `sessions` chunks.** Every column PRD-076 needs already has a proven shape: bounds in `metadata`, dedup via `content_hash`, lifecycle via version-bump, embedding nullable for fail-soft.

### 4. The codebase-graph extractor — AST-aware chunking already on the tree-sitter stack

**`src/daemon/runtime/codebase/extract.ts` + `extractors/{structural,ts-js,walk}.ts`**

The codebase-graph extractor parses source via `web-tree-sitter` (WASM grammars, already a runtime dep) and emits `file` + `symbol` `GraphNode`s with byte-range provenance. This is AST-aware chunking for source code — exactly what a `Read` tool call's `response.file.content` would want. The infrastructure (parser lifecycle, per-language grammar loading, malformed-input skip-never-abort) is already paid for.

### 5. The embeddings daemon's silent truncation

**`embeddings/src/index.ts:187`** — the daemon calls `pipeline("feature-extraction", MODEL_ID, ...)` for `nomic-embed-text-v1.5` (8192-token max). transformers.js silently tokenizes + truncates input at the model's max sequence length. **Today, an over-long text reaches the embedder and gets truncated with no chunking, no bounds preservation, and no caller awareness.** This is a third invisible-data source (alongside the PRD-074 prose cap and the PRD-075 windowing gap) that capture-time chunking closes.

## Considered options

### Option A — Pull LangChain's `RecursiveCharacterTextSplitter` (MIT)

The industry-default prose chunker. ~80 lines of actual logic; the dep value is the dep itself, not the algorithm.

- **For:** proven, well-tested, immediately familiar to anyone who's done RAG.
- **Against:** LangChain-the-framework is heavy (megabytes of transitive deps); we'd use 0.1% of it. The codebase's dependency posture is anti-framework for exactly this reason. A new runtime dep adds a permanent SBOM / `npm audit` / supply-chain surface for an algorithm that fits in 80 lines.
- **Verdict: rejected.** Pulling a framework to get a 80-line algorithm violates the dependency posture. The algorithm is the asset; the dep is the cost.

### Option B — Pull a focused chunker (`sentence-splitter`, `langchain-text-splitters`)

Smaller surface than the full LangChain framework.

- **For:** smaller dep, focused scope.
- **Against:** still a new runtime dep for an algorithm we already have variants of in-tree. The codebase already has TWO chunkers (`chunkText` + `chunksFor`) solving adjacent problems; adding a third via a dep instead of factoring a shared seam in-tree fragments the chunking surface.
- **Verdict: rejected.** Same dependency-posture reasoning, weaker because the in-tree alternatives are closer.

### Option C — Build the chunker in-tree, factoring a shared seam

A single new module — `src/daemon/runtime/capture/chunker.ts` — exposing one function: `chunkEvent(event: CaptureEvent): Chunk[]`. Internally dispatches on `event.kind`:

- `user_message` / `assistant_message` → recursive-character split (the LangChain algorithm ported verbatim with an MIT-attribution header), chunk size ~512 tokens with ~64-token overlap.
- `tool_call` whose `response.file.content` is source → tree-sitter split via the existing `codebase/extractors/` infrastructure, chunk by AST node.
- `tool_call` Bash / other → recursive-character on stdout.

Three strategies behind one seam. The seam is what PRD-076's recall path consumes; the strategies are independent and tunable.

- **For:** no new runtime dep (the algorithms are ported or build on existing tree-sitter; `@huggingface/transformers` is already a peer dep for tokenizer-aware boundaries). Consolidates the chunking surface — `chunkText`, `chunksFor`, and the new `chunkEvent` share a seam. Builds on the codebase-graph tree-sitter infrastructure that's already paid for. Aligns with the existing dependency posture.
- **Against:** we own the chunker code forever. Porting the recursive-character algorithm correctly (boundary hierarchy, overlap handling) is ~1-2 days of careful work + tests.
- **Verdict: accepted.** See Decision.

### Option D — Use `@huggingface/transformers` (already a peer dep) for everything

It ships tokenizer utilities and is already a peer dep, so no new dep.

- **For:** no new dep; tokenizer-native.
- **Against:** transformers.js is an inference library, not a chunker. Its tokenizer utilities handle encoding/truncation, not boundary-aware chunking (paragraph/sentence/AST). We'd still need a chunker on top.
- **Verdict: partial.** Use it for tokenizer-aware boundary alignment (chunk size in tokens, not chars), but it does not replace the chunker itself.

## Decision

**Build the chunker in-tree (Option C). Do not pull a chunker dependency.**

Concretely, for the planned PRDs:

1. **PRD-075 (read-time windowing) does not need a chunker.** Window-on-match is a single-string slice around a known term — `chunkText` is not involved. Ship 075 as the fast unblock; it stands alone.

2. **PRD-076 (capture-time chunking) ships a new `chunker.ts` module** with three strategies behind one `chunkEvent(event)` seam:
   - Port LangChain's `RecursiveCharacterTextSplitter` algorithm (~80 lines) with a clear `// Adapted from LangChain (MIT)` header for the prose cases.
   - Extend the existing `codebase/extractors/` tree-sitter chunker for source-shaped `tool_call` responses.
   - Recursive-character on `Bash` stdout.

3. **The chunk schema mirrors `document_chunk`.** Every column PRD-076 needs (`ordinal`, `metadata` JSONB for `lineStart`/`lineEnd`, `content_hash`, nullable embedding, version-bump lifecycle) already has a proven shape in `DOCUMENT_CHUNK_COLUMNS`. PRD-076 does not invent a new shape; it adapts the existing one to `sessions`.

4. **Tokenizer-aware boundaries via the existing peer dep.** `@huggingface/transformers` is already optional; PRD-076 can use it for chunk-size-in-tokens without adding a dep. Char-based chunking (the `chunkText` default) is the fallback when transformers is absent.

5. **The existing chunkers feed the seam over time.** `chunkText` and `chunksFor` are not deprecated; they're the strategies the new seam dispatches to (character-stride for prose, heading-aware for markdown). A future cleanup can refactor them behind `chunkEvent`'s dispatch without breaking callers.

## Consequences

**Positive:**

- **No new runtime dependency.** The supply-chain surface stays at 8 deps. `audit:openclaw`, CodeQL, `npm audit`, and socket.dev have nothing new to scan.
- **One chunking surface, not three.** Today `chunkText`, `chunksFor`, and the codebase-graph extractor are parallel implementations of adjacent problems. The `chunkEvent` seam is the long-overdue consolidation.
- **Builds on paid-for infrastructure.** Tree-sitter WASM grammars, the parser lifecycle, and the malformed-input-skip-never-abort discipline are all already in place.
- **Reversibility.** The chunker code is ours; if PRD-076's design is wrong, we change it without a dep upgrade or vendor lock-in.

**Negative:**

- **We own the chunker.** Bug fixes and feature additions (new boundary strategies, e.g. language-specific sentence splitting) are on us. Mitigation: the recursive-character algorithm is stable and well-documented; the tree-sitter extension builds on maintained grammars.
- **Porting has a cost.** ~1-2 days to port the recursive-character algorithm correctly with tests, plus the dispatch seam. A dep would be 5 minutes to install. The trade is upfront cost for permanent surface control.

**Neutral:**

- The LangChain algorithm carries MIT attribution; the port keeps the attribution header. No license issue, but the attribution is permanent in the source.

## Revisit triggers

- **If a focused, well-maintained chunker library emerges that aligns with the dependency posture** (single-purpose, no transitive framework, MIT, small) AND the in-tree chunker has accumulated enough maintenance burden to justify the dep — reconsider. The trigger is "the in-tree chunker costs more to maintain than the dep costs to audit," not "a dep would be easier."
- **If the chunking strategies proliferate** beyond the three named here (prose, source, stdout) — e.g. per-language sentence splitters, PDF structure, code-documentation extraction — the in-tree approach may no longer be the right shape, and a dep or a dedicated chunking package may pay for itself.
- **If transformers.js exposes a first-class chunker** in a future version (tokenizer-native boundary-aware splitting), Option D becomes viable and the in-tree recursive-character port can be retired in favor of it.

## Links

- **PRD-074** (`library/requirements/backlog/prd-074-sessions-prose-column/`) — the prose column that surfaced this gap. Ships the head-and-cap slice; explicitly defers windowing and chunking.
- **PRD-047a** (`library/requirements/completed/prd-047-retrieval-quality-upgrades/prd-047a-native-hybrid-benchmark.md`) + **ADR-0001** — the closed decision to keep RRF. The chunker feeds the lexical arm of RRF; it does not revisit the fusion decision.
- **`src/daemon/runtime/sources/document-worker.ts:202`** — `chunkText`, the existing character-stride chunker.
- **`src/daemon/runtime/sources/providers/obsidian.ts:393`** — `chunksFor`, the existing heading-aware markdown splitter with line-range bounds.
- **`src/daemon/storage/catalog/sources.ts:202-243`** — `document_chunk` schema, the proven shape PRD-076 mirrors.
- **`src/daemon/runtime/codebase/extractors/`** — the AST-aware tree-sitter chunker for source code.
- **`embeddings/src/index.ts:187`** — the embeddings daemon's silent token-level truncation, a third invisible-data source PRD-076 closes.
- **Planned PRD-075** (read-time windowing + `matchRange`) and **PRD-076** (capture-time chunking for sessions + nectar descriptions) — the consuming PRDs.
