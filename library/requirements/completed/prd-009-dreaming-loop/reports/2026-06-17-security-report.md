# Security Audit — PRD-009 Dreaming Loop

- **Date:** 2026-06-17
- **Auditor:** security-worker-bee
- **Branch:** prd-009-dreaming-loop
- **Scope:** PRD-009 dreaming loop (penultimate /the-smoker step, run BEFORE quality)
- **Result:** PASS — 0 Critical, 0 High. No remediation required; no source changed.

---

## Executive Summary

The PRD-009 dreaming loop reasons over the knowledge graph with a stronger model and
applies structural mutations through the 008c ontology control plane. I audited all
in-scope files against the SQL-injection, scope-isolation, mutation-safety,
counter-DoS, prompt-injection, and supply-chain focus areas.

**No Critical or High findings.** The implementation correctly carries the
repo's three load-bearing controls into the new surface:

1. **SQL safety** — every identifier routes through `sqlIdent`, every value through
   `sLiteral`/`sqlLike`/`val.*`; no hand-quoted value, no raw fetch. `audit:sql`
   scans 68 files under `src/daemon` clean.
2. **Scope isolation** — the org/workspace partition is credential-bound (`QueryScope`,
   never caller/model-named); every dreaming read carries the `agent_id` conjunct. A
   pass cannot read or mutate another agent's graph, and cross-org is structurally
   impossible (backend 403 on an invented partition).
3. **Mutation trust boundary** — every model-proposed mutation is submitted via
   `submitProposal`; destructive ops (`merge_entities`/`delete_entity`/
   `delete_attribute`/`supersede_attribute`) map to operations OUTSIDE
   `DIRECT_APPLY_OPERATIONS`, so the risk router ALWAYS routes them to the pending
   review queue. A crafted/poisoned model response cannot force a direct destructive
   apply or rewrite raw artifacts/transcripts.

3 Medium / Low hardening notes are documented below (no control weakened; none is a
fix the report mandates this session).

**Ordering:** Confirmed correct. No `*-qa-report.md` exists for this branch under
`library/qa/` or the PRD-009 `reports/` folder, so security runs before quality as
required. Quality may run after this report.

**Coverage note (not reduced):** `audit:sql` defaults to `src/daemon` and does NOT
scan `src/cli/dream.ts`. This is acceptable: `dream.ts` is a thin client that imports
no storage path, holds no storage handle, and builds NO SQL (verified by read +
grep) — it can only call the injected enqueuer/reader seams. There is no SQL sink in
the CLI to scan.

---

## Findings Table

| # | Severity | Focus | File:Line | Status |
|---|----------|-------|-----------|--------|
| 1 | Medium | Counter wedge (availability) | `src/daemon/runtime/dreaming/trigger.ts:208` | Documented — design-acknowledged; verify at daemon assembly |
| 2 | Low | Counter integer overflow (integrity) | `src/daemon/runtime/dreaming/trigger.ts:313` | Documented |
| 3 | Low | `audit:sql` does not scan the CLI | `scripts/audit-sql-safety.mjs:48` / `src/cli/dream.ts` | Documented — no SQL sink in CLI |

No Critical. No High.

---

## Focus-area verification

### 1. SQL injection (highest priority) — CLEAR

Every interpolation in trigger / incremental / compaction / dreaming-state / control-plane
is guarded:

- `trigger.ts` — `latestRow` and `appendVersion`: identifiers via `sqlIdent`, the
  `id`/`agent_id` values via `sLiteral`, counter value via `val.num(Math.max(0,
  Math.trunc(...)))`. The optional `tableName` override is validated through `sqlIdent`
  (trigger.ts:214) so the LIVE-smoke throwaway table name cannot inject.
- `incremental.ts` — `readLastPassAt`, `readNewSummaries`, `readChangedGraph`, and the
  graph-query tool (`findEntitiesByName`, `findAttributesForEntity`): all identifiers
  via `sqlIdent`; the model-supplied free-text `fragment` goes through
  `sLiteral(`%${sqlLike(fragment)}%`)` (incremental.ts:382) — a crafted name with `%`,
  `_`, `'`, `\`, or `;` is inert, neither a wildcard nor a statement break. `entityId`
  in the subquery goes through `sLiteral` (incremental.ts:399).
- `compaction.ts` — `loadFullGraph` + `loadRecentSummaries`: identifiers via `sqlIdent`,
  the `agent_id` value via `sLiteral`. `LIMIT` is a JS number constant, never
  attacker text. The COMPACTION_SYSTEM/`buildCompactionPrompt` is prompt text, not SQL.
- `dreaming-state.ts` — defines columns only; every `NOT NULL` carries a `DEFAULT` so
  the heal `ALTER … ADD COLUMN` succeeds. No statement building.
- The attacker-influenced surfaces — a crafted **summary**, **entity name**, and the
  model's **mutation payload** — are all neutralized: summaries/names are read via
  guarded SELECTs and never re-interpolated; the mutation payload is written by the
  control plane via `val.text(JSON.stringify(payload))` → `eLiteral` (escape-safe).

`audit:sql` → **OK, 68 files, every interpolation routes through an escaping helper.**

CLI: `src/cli/dream.ts` builds no SQL (thin client, injected seams). Acceptable that
`audit:sql` does not reach it.

### 2. Scope isolation (FR-7 / FR-10) — CLEAR

- The **org/workspace** half of the key is the `QueryScope` partition, supplied by the
  daemon from the credential context (`envCredentialProvider` → `resolveStorageConfig`),
  never named by the caller or model. The live itest confirms "an invented partition is
  rejected 403 by the scoped token" — cross-org is structurally impossible.
- The **agent_id** inner ring is on EVERY dreaming read: counter reads
  (`trigger.ts:263`), `readLastPassAt`/`readNewSummaries`/`readChangedGraph`, the
  graph-query tool's two methods, and both compaction loaders all carry
  `agent_id = sLiteral(agentId)`.
- The **graph-query tool** the model calls is bound to `(scope, agentId)` at
  construction (`createGraphQueryTool`, incremental.ts:374) — the model supplies only a
  search `fragment`/`entityId`, never the agent or partition, so it cannot be prompted
  to read another agent's graph.
- Compaction's **full-graph load** threads `agentId` from the job payload on all four
  table reads — a compaction pass never spans agents.
- The runner scopes every apply by `actor = { agentId: job.agentId }`; `job.agentId` is
  set at enqueue by the trigger from the daemon's resolved scope, not by the model.

### 3. Mutation safety (the trust boundary) — CLEAR

- `MUTATION_KIND_TO_OPERATION` (contracts.ts:144) maps the four destructive kinds to
  `entity.merge` / `entity.archive` / `claim.archive` / `claim.supersede`. The first
  three are NOT in `DIRECT_APPLY_OPERATIONS` (control-plane.ts:101), and `routeProposal`
  returns `pending` for any operation outside that set — destructive ops can NEVER
  direct-apply. A non-empty `riskNote`, confidence below the 0.5 floor, or a batch
  payload also force `pending`.
- `submitProposal` for a `pending` route writes ONLY the pending audit row and STOPS —
  nothing is applied (control-plane.ts:413). A crafted model response cannot bypass the
  queue.
- Raw artifacts/transcripts: the apply path touches only graph engine tables
  (`entities`/`entity_aspects`/`entity_attributes`); there is no code path from a
  mutation to `sessions`/`source`/`memory` rows (FR-8/FR-5 honored, c-AC-3).
- **Defensive parse:** `parseModelOutput` (runner.ts:232) strips a `<think>` block and a
  code fence, balanced-brace-extracts the first JSON object, `JSON.parse`s in a
  try/catch, and validates via zod `safeParse` — any malformed/truncated/huge body
  yields an EMPTY set and the pass completes (never throws past the boundary, never
  crashes the job). A malicious or oversized mutation set cannot crash or over-apply.

### 4. Counter DoS / integrity — CLEAR (one Medium, one Low)

- **Crashed pass does NOT permanently wedge in the assembled system.** If the runner
  dies before `recordPassComplete`, `pending_job_id` stays set; the next tick consults
  the injected `pendingTerminal` probe (`isPendingJobTerminal`, reading `memory_jobs`),
  which clears the guard when the job is dead/done so a fresh pass can queue. See
  Finding 1 for the Wave-1 default-probe caveat.
- **Reset-subtract cannot underflow into SQL.** `resetTokens = tokens - threshold` may go
  negative, but `appendVersion` floors every counter write with `Math.max(0,
  Math.trunc(...))` (trigger.ts:289) — no negative value is ever interpolated.
- **No lost-write on the reset race** — verified live: 180 − 100 → 80 carried forward,
  not hard-zeroed (`dreaming-counter-live.itest.ts`, both tests pass).
- **Overflow** — see Finding 2 (Low): no upper clamp on accumulation; not a security
  boundary breach (the value is the scope's own daemon-accounted token total, not
  attacker free-text).

### 5. Model prompt-injection — CLEAR

The defense is structural, not textual: a prompt-injected summary can steer the model
to PROPOSE a destructive mutation, but every destructive op routes to the 008c pending
review queue (Focus 3), and every apply is scoped to the pass's own agent (Focus 2). A
poisoned summary therefore cannot escalate to an unreviewed destructive change or reach
another agent. The model's `summary`/`payload` outputs are never interpolated into SQL
unescaped (control-plane writes them via `val.text` → `eLiteral`). The `DREAMING.md`
task prompt is dreaming-only by construction (reached only from
`IncrementalPayloadStrategy.loadPayload`).

### 6. Supply chain — CLEAR

- `npm audit --omit=dev` → **found 0 vulnerabilities.**
- `npm run audit:openclaw` → **OK, no findings, bundle clean against ClawHub rules.**

---

## Medium / Low findings (documented, not remediated this session)

### Finding 1 — Counter wedge if the terminal probe is not wired at daemon assembly (Medium, availability)

`src/daemon/runtime/dreaming/trigger.ts:208`

```ts
this.pendingTerminal = deps.pendingTerminal ?? (() => Promise.resolve(false));
```

The default terminal probe reports a pending job as NEVER terminal. This is the correct
*conservative* default (never enqueue a second pass on a guess), and the Wave-1 module is
constructed-and-tested with daemon assembly deferred. BUT: if the daemon maintenance-loop
assembly wires the trigger WITHOUT injecting the real `isPendingJobTerminal`
(`memory_jobs`-backed) probe, a single crashed pass leaves `pending_job_id` set forever
and the scope wedges — no further dreaming passes for that (org, workspace, agent_id).

This is an availability risk with a documented mitigation path, not a security-boundary
breach, so it is Medium (not Critical/High) and not remediated here.

**Recommendation:** the daemon-assembly step (deferred) MUST inject a real terminal probe
that resolves the pending job's status from `memory_jobs`. Add an assembly-level test
asserting that a dead/abandoned `pending_job_id` is cleared on a later tick (the wedge
regression). Track as a Wave-assembly acceptance item.

### Finding 2 — Counter accumulation has no upper bound (Low, integrity)

`src/daemon/runtime/dreaming/trigger.ts:313`

```ts
const next = state.tokensSinceLastPass + delta;
```

`incrementDreamingCounter` floors `delta` at 0 and truncates it, but applies no upper
clamp. A pathological `tokens` (or a long-running disabled-but-accumulating loop) could
drive `tokens_since_last_pass` past the BIGINT range, producing a counter that no longer
reads back faithfully. Not attacker-controlled free-text (tokens come from the daemon's
own summary-write accounting), so Low.

**Recommendation:** clamp the accumulated value to a sane ceiling (e.g.
`Number.MAX_SAFE_INTEGER` or a config multiple of `tokenThreshold`) in `appendVersion`,
mirroring the existing `Math.max(0, Math.trunc(...))` floor. ~1 line; deferred so the
diff stays empty for QA.

### Finding 3 — `audit:sql` scope excludes `src/cli` (Low, defense-in-depth)

`scripts/audit-sql-safety.mjs:48` (`SCAN_DIR ?? "src/daemon"`) / `src/cli/dream.ts`

The SQL-safety gate scans `src/daemon` only; the CLI is not covered. Today this is safe
because `src/cli/dream.ts` builds no SQL and holds no storage handle (verified). But a
future CLI that grows a storage path would not be caught by the gate.

**Recommendation:** when any `src/cli` command gains a storage/SQL path, extend the
`audit:sql` invocation to include `src/cli` (it already accepts a dir arg). No action
needed for PRD-009 as shipped.

---

## Category checklist (every category checked)

| Category | Result |
|----------|--------|
| SQL injection into Deep Lake (missing `sqlIdent`/`sLiteral`) | None detected |
| Cross-org read/write | None detected (credential-bound partition) |
| Cross-agent read/write | None detected (`agent_id` conjunct on every read) |
| Destructive mutation bypassing pending review | None detected (router enforces) |
| Raw artifact/transcript rewrite | None detected (no code path) |
| Model-output parse crash / over-apply | None detected (defensive parse) |
| Counter wedge / underflow / lost-write | None detected at runtime; 1 assembly-time Medium (F1) |
| Prompt-injection → unreviewed destructive change | None detected (structural defense) |
| Token / credential in logs | None detected (no logging of secrets in any dreaming file) |
| Credential file modes | N/A (no credential handling in scope) |
| Supply chain (`npm audit --omit=dev`, OpenClaw) | None detected |

---

## Gate results

| Gate | Command | Result |
|------|---------|--------|
| CI (typecheck + jscpd + test + audit:sql) | `npm run ci` | exit 0 — 50 files, 604 tests passed |
| Build (tsc + esbuild multi-harness) | `npm run build` | exit 0 — all bundles built @ 0.1.0 |
| OpenClaw bundle scan | `npm run audit:openclaw` | exit 0 — clean |
| SQL-safety | `npm run audit:sql` | exit 0 — 68 files, all guarded |
| Production deps | `npm audit --omit=dev` | exit 0 — 0 vulnerabilities |
| Live dreaming counter | `vitest run … dreaming-counter-live.itest.ts` | exit 0 — 2/2 passed |

---

## Files changed

None. The audit found no Critical or High findings; no source was modified. `git diff`
on the in-scope files is empty (clean audit).

---

## Unresolved Critical / High

None.
