# Security Audit — PRD-041 Graph Page

- **Date:** 2026-06-22
- **Auditor:** security-worker-bee (paired Stinger: `security-stinger`)
- **Scope:** the PRD-041 graph-page diff (working tree, uncommitted) — the full-page interactive codebase graph + Codebase↔Memory toggle and its new daemon endpoint.
- **Branch:** `main` (uncommitted working tree)
- **Ordering check:** PASS. No `*-qa-report.md` exists for PRD-041 — this audit runs before `quality-worker-bee`, as required.

## Executive summary

**No Critical, High, or Medium findings. Zero code changed — the diff shipped secure.**

The new attack surface (the `GET /api/diagnostics/memory-graph` daemon endpoint plus the
full-page `graph.tsx` renderer) was audited against the five-item threat checklist and the
three Stinger catalogs (AI-code failure patterns, OWASP Top 10:2025, captured-trace PII /
credential exposure). Every guard the codebase already enforces — `sqlIdent`-gated identifiers,
scope-isolated `storage.query(sql, scope)` reads, React-text-only label rendering, zod-validated
fail-soft wire parsing, and the protected route-group inheritance — holds on the new code. Because
there were no Critical or High findings, **no remediation edits were made**; the working tree is
byte-identical to the session start (confirmed via `git status --short`; nothing under `assets/`
touched).

| Severity | Count |
|---|---|
| Critical | 0 |
| High | 0 |
| Medium | 0 |
| Low | 1 (informational, no action) |

## Gate results

- **`npm run audit:sql`** → PASS. "scanned 200 file(s)… every SQL interpolation routes through an escaping helper."
- **`npm run ci`** (typecheck + jscpd + vitest + audit:sql) → PASS. 226 test files, 2459 passed / 6 skipped / **0 failed**. The new `graph-page.test.tsx` (15) and `wire-graph.test.ts` plus the modified `api.test.ts` (daemon-side memory-graph) all pass. The pre-existing `sources/api.test.ts` load-flake did not manifest (no failures at all).

## Threat-checklist findings

### 1. SQL injection in `fetchMemoryGraphView` — CLEAN

`src/daemon/runtime/dashboard/api.ts:356-406`. The two builders
(`buildMemoryEntitiesSql`, `buildMemoryDependenciesSql`) are **static projections**: every
table/column identifier (`entities`, `entity_dependencies`, `id`, `name`, `type`,
`source_entity_id`, `target_entity_id`, `updated_at`, `created_at`) routes through `sqlIdent`
(`src/daemon/storage/sql.ts:80`, which rejects anything outside `^[a-zA-Z_][a-zA-Z0-9_]*$`).
`MEMORY_GRAPH_LIMIT` is a hard-coded numeric constant (`500`), not interpolated text. **No
request-controlled value reaches the SELECT** — the page sends no params to this endpoint
(`wire.memoryGraph()` is a bare GET, `src/dashboard/web/wire.ts:674-679`), confirmed. There is no
`sLiteral` because there is no literal to bind. `audit:sql` is green.

### 2. Tenancy / scope isolation — CLEAN

The handler is attached via `daemon.group(DASHBOARD_GROUPS.memoryGraph)` where
`memoryGraph: "/api/diagnostics"` (`api.ts:125`, `:573-580`). `server.ts:94` mounts
`/api/diagnostics` with `protect: true`, so the endpoint **inherits the same
`permissionMiddleware` auth/RBAC** as `/api/graph` (`server.ts:87`, also `protect: true`). Scope
is resolved by the shared fail-closed `resolveScopeOrLocalDefault` (`api.ts:523-524`,
`scope.ts:82`) — a request with no resolvable org returns `400 NO_ORG_BODY`, and the cross-tenant
guard in `resolveScopeFromHeaders` (`scope.ts:54-62`) blocks a forged `x-honeycomb-org` from
crossing the validated token's own org. The `entities`/`entity_dependencies` ontology tables have
no `org_id` column (engine tables partitioned by the storage scope), so the read carries no
`org_id` predicate **by design** — isolation rides `storage.query(sql, scope)` (`selectRows`,
`api.ts:159-162`). No cross-tenant read is possible.

### 3. XSS — graph labels as inert text — CLEAN (the highest-risk item, cleared)

The memory graph's node labels are entity/claim text derived from memories (potentially
untrusted), unlike the codebase graph's file paths. Every rendered label is a **React text
child**, never raw HTML:

- SVG `<text>` node label — `graph.tsx:381` `{n.label}`.
- Detail panel label / id — `graph.tsx:235` `{node.label}`, `:241` `{node.id}`.
- Relation neighbor labels — `graph.tsx:190` `{labels.join(", ")}` (joined string, still a text child).
- Search input — `graph.tsx:576-584` controlled `value={search}`, no reflection into markup.
- Kind toggles / legend — `graph.tsx:173` `{kind || "node"}` (text child).

Grep over `src/dashboard` for `dangerouslySetInnerHTML | innerHTML | outerHTML | eval( |
new Function | document.write | insertAdjacentHTML` returns **only comments asserting the absence**
of those sinks — zero live uses. A memory whose `content` is markup renders as literal escaped
text and cannot execute.

### 4. No secret in either endpoint response or the page — CLEAN

`fetchMemoryGraphView` builds its response purely from `entities` (id/name/type) and
`entity_dependencies` (source/target/type) — graph text only (`api.ts:364-377`). No token,
credential, org GUID, or header rides the body. The `creds`/`orgName` references in `api.ts`
are confined to the **settings** view-model (pre-existing, out of PRD-041 scope) and expose only a
display-only friendly org name, never a token. The wire client adds no secret: `memoryGraph()`
validates through the shared `GraphSchema` (id/label/kind, from/to/kind, built) and stamps only the
non-tenant loopback session headers (`DASHBOARD_SESSION_HEADERS`, `wire.ts:478-481`), which carry no
credential. Grep-proven.

### 5. No new attacker-controllable surface from pan/zoom/search — CLEAN

The hand-rolled pan (`onPointerMove`, `graph.tsx:321-329`), bounded zoom
(`onWheel` clamped to `[MIN_ZOOM, MAX_ZOOM]`, `:334-340`), and search filter (`findNode` /
`applyKindFilter`, pure functions over the loaded `GraphWire`, `:106-124`) are **pure client
state** over the already-fetched view-model. Grep over `graph.tsx` for `import( | new Function |
eval( | location. | window.open | history.push` returns no matches. No eval, no dynamic import, no
route injection.

## Other catalog checks

- **Vibe-coding patterns (Stinger guide 02):** no missing-`sqlIdent` on config table names (all
  identifiers are static + gated); no string-gate path bypass (no shell/path handling in scope);
  no unscoped `me|team` query (every read rides `scope`); no hallucinated deps (the page imports
  only existing `graph-layout`, `panels`, `primitives`, `page-frame`, `wire`, `react`); pan/zoom is
  hand-rolled over the SVG viewBox — no new dependency. CLEAN.
- **Hidden-Unicode / control-character backdoor:** `src/dashboard/web/graph-layout.ts` contains 3
  `\0` (NUL) bytes — investigated and **benign**. They are deliberate composite-map-key separators
  inside template literals (`` `${e.kind}\0${e.to}` ``) in the new pure `splitNeighbors` helper, a
  standard idiom to make a collision-proof key from two interpolated parts. The 61 non-ASCII bytes
  are box-drawing characters in JSDoc comment banners. No zero-width/bidi smuggling. CLEAN.
- **Prompt-injection surface:** out of PRD-041's path — this diff reads ontology rows into an inert
  graph view and never injects recalled content into an agent context. N/A.
- **PII / captured-trace exposure (Stinger guide 04):** the memory-graph reads entity NAME + TYPE
  (ontology labels), not raw `sessions`/`memory` prompt bodies; nothing is logged. The endpoint is
  scope-isolated (item 2). No over-capture, no token-in-logs. CLEAN.

## Low / informational (no action required)

- **L-1 (informational):** `src/dashboard/web/graph-layout.ts` shows as a full-file rewrite in
  `git diff` because its line endings flipped LF→CRLF (Windows checkout). The substantive change is
  only the additive pure `splitNeighbors` helper; the rest is identical text. Not a security issue —
  noted so a reviewer is not alarmed by the diff size. The repo's `.gitattributes`/autocrlf policy
  is a hygiene concern for `typescript-node-worker-bee` / `ci-release-worker-bee`, not this audit.

## Remediation

None required. No Critical or High findings; no Medium fixable in <5 lines. **Zero edits made** —
working tree is unchanged from session start (`git status --short` identical; no `assets/` changes).

## Recommendation

Clear to proceed to `quality-worker-bee`. CVE/dependency intelligence (Stinger guide 06) was not
re-pulled this session — no dependency was added by this diff (pan/zoom is hand-rolled), so the
existing `npm audit` / CodeQL posture is unchanged.
