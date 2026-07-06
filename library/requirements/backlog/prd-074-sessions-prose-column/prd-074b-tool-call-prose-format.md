# PRD-074b: The `tool_call` Prose Format

> **Parent:** [`prd-074-sessions-prose-column-index.md`](./prd-074-sessions-prose-column-index.md)
> **Status:** Draft

---

## Scope

Define what goes in the `prose` column for `tool_call` events. `user_message` and `assistant_message` events are trivial — their `prose` is `event.text` verbatim. `tool_call` events have no `text` field; they carry `{kind, tool, input, response}`, where `input` and `response` are schemaless per-tool JSON. The format decision lives in this sub-PRD because it is the load-bearing design choice behind the whole effort: get this wrong and we either re-create the bloat we're fixing or strip too much signal to be useful.

This sub-PRD defines: (1) the prose shape per tool kind, (2) the response cap as a named constant, (3) the relationship to the existing `embedTextFor` helper, and (4) why full-response inclusion (the obvious "why not just dump everything?" question) re-creates the bloat we're fixing.

---

## The tension (stated honestly)

The `prose` column serves two masters at once:

1. **The ILIKE match target (the live lexical arm).** It needs enough signal that a search term (`"healthReasons"`, `"dashboard"`, `"session-end"`) actually matches the row.
2. **The harness-bound text.** It ships directly into the agent's context window via `memories/api.ts:361-379`, so every character costs tokens.

These pull in opposite directions. "Tool name only" loses the matched-substring context (a search for `"healthReasons"` matches a `Read` row but the harness only sees `Read` — useless). "Full tool + input + response" preserves everything but re-creates the JSONB bloat for tool-heavy sessions (a `Read` with a 10-KB file response, an `Edit` with a 500-line diff, a `Bash` with multi-KB stdout). The whole point of PRD-074 is to kill that bloat.

The resolution: a **bounded format with a named, tunable cap**, where the tool name + a file path or command preserves match context, and a capped response snippet preserves enough content signal for the harness to decide whether to drill deeper. Full structure always survives in `message` JSONB for downstream parsers — no information is ever lost.

---

## The format

### `proseForToolCall(event: ToolCallEvent): string`

Define in `src/daemon/runtime/capture/event-contract.ts`. Pure, synchronous, no IO.

**Line 1 — the tool + its target:**

The first line carries the tool name and a compact target identifier extracted from `input`. The shape depends on whether `input` carries a path-like field:

| Condition | First line |
|---|---|
| `input` has a `file_path` (Read/Edit/Write/MultiEdit) | `${tool} → ${shortPath(input.file_path)}${rangeSuffix(input)}` |
| `input` has a `path` (generic file/path tools) | `${tool} → ${shortPath(input.path)}` |
| `input` has a `command` (Bash/shell tools) | `${tool}: ${truncate(input.command, 80)}` |
| Otherwise (no recognizable target) | `${tool}` |

Where:
- `shortPath(p)` shortens a long absolute path to `last-three-segments/.../basename` (e.g. `C:\Users\mario\GitHub\the-apiary\hive\src\dashboard\web\pages\dashboard.tsx` → `web/pages/dashboard.tsx`). Windows backslashes are preserved as-is (they're valid path separators; re-escaping is one of the things we're eliminating).
- `rangeSuffix(input)` appends `:${offset}-${offset+limit}` when both `offset` and `limit` are present (the `Read` tool's pagination), e.g. `:175-250`. Empty when absent.
- `truncate(s, n)` collapses whitespace and truncates to `n` chars with `…`.

**Line 2 — the response body (bounded):**

The second line carries the response content, whitespace-collapsed, bounded by the named constant:

```ts
// event-contract.ts (or a sibling constants module)
export const TOOL_PROSE_RESPONSE_CAP = 500 as const;
```

The response extractor is best-effort and per-tool-shape:
- If `response.file.content` exists (Read) → use it.
- If `response.stdout` exists (Bash) → use it.
- If `response` is a string → use it directly.
- If `response` is an object with no recognized content field → `JSON.stringify(response)`, then cap.
- If `response` is absent or null → omit the second line entirely (the first line alone is the prose).

The cap is applied with `truncate(content, TOOL_PROSE_RESPONSE_CAP)`.

**Concrete examples:**

| Event | `prose` |
|---|---|
| `Read` of `dashboard.tsx:175-250`, response 2 KB | `Read → web/pages/dashboard.tsx:175-250\n// 'healthReasons' is no longer polled here — the SHEL…` (~120 chars) |
| `Edit` of `sidebar.tsx`, response `{file: "...", ok: true}` | `Edit → web/sidebar.tsx\n{"file":"...","ok":true}` (~80 chars) |
| `Bash` `git log --oneline -20`, response 4 KB stdout | `Bash: git log --oneline -20\nabc1234 Fleet 0.6.6…def5678 Fleet 0.6.5…` (~100 chars, capped at 500) |
| `WebSearch` "honeycomb recall", response 15 KB | `WebSearch: honeycomb recall\n<hit 1 title>…<hit 2 title>…` (~400 chars, capped at 500) |
| Unknown tool with object response | `UnknownTool\n{...capped JSON...}` |

---

## Why the response cap, not the full response

This is the design call most likely to be second-guessed, so the argument should be explicit.

**The full response is preserved in `message` JSONB.** Downstream parsers (`summaries/worker.ts`, `skillify/miner.ts`, ROI pricing) read the JSONB and get the full-fidelity `input` and `response`. Nothing is lost.

**The `prose` column is the harness-facing match + injection surface, not the analysis surface.** When recall surfaces a `sessions` hit, the harness receives the `prose` text. For a `Read` of a 10-KB file, including the full response in `prose` ships 10 KB into the agent's context for a hit whose purpose is "this conversation touched `healthReasons`." That's the exact bloat PRD-074 exists to kill — re-introducing it for tool-heavy sessions would defeat the PRD for precisely the sessions where the bloat is worst (long coding sessions with many `Read`/`Edit`/`Bash` calls).

**The cap is a signal floor, not a content ceiling.** 500 chars of whitespace-collapsed response is enough for the harness to see "this `Read` returned code mentioning `healthReasons` at line 175" and decide whether to drill deeper (e.g. issue its own `Read` against the current file state). It's not enough to re-derive the full file — and it shouldn't be, because the file may have changed since capture. The `prose` is a recall-and-context hint, not a cache of the file.

**The cap is named and tunable.** `TOOL_PROSE_RESPONSE_CAP = 500` is an exported constant, not a magic number. A deployment that wants richer tool prose (at the cost of more tokens per hit) can raise it without code surgery. The initial 500 is a conservative default; the open question in the parent index recommends measuring a real corpus to tune it to the 90th percentile of response sizes.

---

## Relationship to `embedTextFor`

The capture handler already has `embedTextFor(event: CaptureEvent): string` at `src/daemon/runtime/capture/capture-handler.ts:786-794`, used to feed the embedder. It extracts plain text per event kind:
- `user_message` / `assistant_message` → `event.text`
- `tool_call` → `tool + input + response` joined

**`proseForEvent` and `embedTextFor` are sibling extractors with different purposes:**

| Helper | Purpose | `tool_call` shape | Cap |
|---|---|---|---|
| `embedTextFor` | Feed the embedder (semantic vector) | `tool + input + response` joined | None (the embedder tokenizes anyway) |
| `proseForEvent` | The recall match target + harness-bound text | File-path-aware line 1 + capped response line 2 | `TOOL_PROSE_RESPONSE_CAP` |

They overlap in spirit but diverge in detail. The embedder benefits from raw joined text (its tokenizer handles noise); the lexical-match/harness path benefits from the file-path-aware line 1 (matches `dashboard.tsx` queries) and the bounded response (caps token cost).

**Recommendation:** do NOT collapse them into one helper. The cap and the file-path-aware first line are specific to `proseForEvent`'s dual role. A future refactor could extract a shared "event summary" primitive both consume, but that's an implementation-detail cleanup, not a PRD-level decision. 074b ships them as siblings and documents the relationship; collapsing is out of scope.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| b-AC-1 | `proseForToolCall(event)` is exported from `event-contract.ts`. Pure, synchronous, no IO. |
| b-AC-2 | For a `tool_call` whose `input` carries a `file_path`, the first line is `${tool} → ${shortPath}:${range}` when `offset`+`limit` are present, else `${tool} → ${shortPath}`. |
| b-AC-3 | For a `tool_call` whose `input` carries a `command` but no `file_path`, the first line is `${tool}: ${truncate(command, 80)}`. |
| b-AC-4 | For a `tool_call` with no recognizable target field, the first line is `${tool}`. |
| b-AC-5 | The second line (when a response is present) is whitespace-collapsed and capped at `TOOL_PROSE_RESPONSE_CAP` chars, truncated with `…`. `TOOL_PROSE_RESPONSE_CAP` is an exported named constant (default 500), not a magic number. |
| b-AC-6 | A `Read` of a 10-KB file yields a `prose` row at or under `TOOL_PROSE_RESPONSE_CAP + first-line length` (~600 chars total). The full 10 KB survives in `message` JSONB (asserted by a separate test that `JSON.parse(row.message).response.file.content` is the full 10 KB). |
| b-AC-7 | A `Bash` with multi-KB stdout yields a `prose` row bounded by the cap. |
| b-AC-8 | For `user_message` / `assistant_message` events, `proseForEvent` returns `event.text` verbatim — no cap, no truncation, no transformation. |
| b-AC-9 | Windows path separators in `file_path` are preserved as-is in `prose` (no re-escaping to double-backslashes). This is one of the explicit wins over the JSONB cast. |

---

## Open questions

- **The `TOOL_PROSE_RESPONSE_CAP` default (500).** Conservative. A real measurement against a representative session corpus (the distribution of `response` sizes per tool kind) would let us set this to the 90th percentile rather than guess. Shipped as a follow-up to first deploy; the constant is tunable without code surgery.
- **`shortPath` depth.** Three segments (`web/pages/dashboard.tsx`) is the proposed default. Forth worth a workspace with deep nesting it may collide (multiple files shorten to the same three segments). Mitigation: the `path` column on the row carries the full path for disambiguation; recall's `id` is `path`, so the harness can always recover the full location. Tunable.
- **Per-tool response extractors.** The current shape (`response.file.content` for Read, `response.stdout` for Bash, fallback to `JSON.stringify`) is heuristic. A more robust design would register per-tool extractors (one for Read, one for Bash, one for Edit, etc.). Shipped as a follow-up if the heuristic misfires on real captures; the heuristic is good enough for first deploy.
- **Redaction.** A `Bash` `input.command` may contain secrets (e.g. a shell command that embeds a credential in an HTTP header or env var). The `message` JSONB carries it verbatim (it's the source of truth); the `prose` column is an opportunity to apply a redaction policy at write time. This PRD does NOT add redaction — it's a separate concern with its own threat model — but the `proseForToolCall` seam is where it would land.
