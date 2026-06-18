# Security Audit — PRD-008 Knowledge Graph Ontology

- **Date:** 2026-06-17
- **Auditor:** security-worker-bee (Hivemind security close-out)
- **Branch:** `prd-008-knowledge-graph-ontology`
- **Repo root:** `C:\Users\mario\GitHub\honeycomb`
- **Phase:** Penultimate step of the /the-smoker run (runs BEFORE quality-worker-bee)
- **Scope:** `src/daemon/runtime/ontology/**`, `src/cli/ontology.ts`, `tests/daemon/runtime/ontology/**`, `tests/integration/ontology-*.itest.ts`. (hivemind-v1 / otherhive-v1 explicitly excluded.)

---

## Executive Summary

PRD-008 adds the knowledge-graph ontology: the entity model + inline linker (008a),
the dependency edges + append-only supersession (008b), and the control plane (008c)
with its `honeycomb ontology` CLI. This is a graph/control-plane surface whose highest
risks are (1) SQL injection via attacker-controllable entity names / proposal payloads /
assertion content / CLI args, (2) cross-agent scope leakage, and (3) a control-plane
trust-boundary bypass (a risky op tricked into direct-apply, a constraint auto-superseded,
or a raw transcript rewritten).

**Result: NO Critical or High findings. Zero code changes were required.** Every
SQL interpolation across all five ontology modules and the CLI routes through the
`sqlIdent` / `sLiteral` / `eLiteral` / `val.*` guards; the `audit:sql` gate passes on
both `src/daemon` (61 files) and `src/cli` (2 files). Scope isolation is structurally
enforced (the storage client has no unscoped `query` overload; every engine-table
statement carries the `agent_id` conjunct). The control-plane router is pure and
allow-list-driven, the constraint-exemption and no-auto-promote rules hold, and no apply
path can reach `sessions` / `source` / memory tables. The dry-run CLI is structurally
non-mutating (no storage handle; `planApply` takes none).

Two Low / informational items are documented for defense-in-depth. Neither weakens a
control and neither is in scope for in-session remediation.

**Ordering check:** The only QA report on disk is `library/qa/cursor-extension/2026-06-12-qa-report.md`
— a different feature, dated before this branch's work. No quality-worker-bee report
exists for `prd-008-knowledge-graph-ontology`, so there is no ordering inversion. This
audit ran in the correct position (before quality).

---

## 1. Findings Table

| # | Severity | Category | Location | Status |
|---|----------|----------|----------|--------|
| — | — | SQL injection (entity names / payload / assertion / CLI) | all 5 modules + CLI | None detected |
| — | — | Cross-agent / cross-scope read or write | all graph writes/reads | None detected |
| — | — | Control-plane review-queue bypass | `control-plane.ts:151` `routeProposal` | None detected |
| — | — | Constraint auto-superseded | `dependencies.ts:421`, `supersede.ts` | None detected |
| — | — | Raw artifact / transcript rewrite | `control-plane.ts:284` apply path | None detected |
| — | — | Epistemic assertion auto-promote into truth | `control-plane.ts:468` `recordAssertion` | None detected |
| — | — | Supersession version-chain corruption / resurrection | `supersede.ts` | None detected |
| — | — | CLI `--dry-run` mutation / cross-tenant leak | `cli/ontology.ts` | None detected |
| — | — | Credential / token / PII leakage to logs | all ontology modules | None detected |
| — | — | Supply chain (production deps) | `npm audit --omit=dev` | None detected |
| L1 | Low | Defense-in-depth: `audit:sql` does not scan `src/cli` in CI | `scripts/audit-sql-safety.mjs:48`, `package.json` | Documented (recommend) |
| L2 | Low | Empty-string `agentId` coerces to the `"default"` agent | `entity-model.ts:126` `agentClauseFor` | Documented (recommend) |

---

## 2. Critical / High Findings + Fixes

**None.** No remediation was applied because no Critical or High vulnerability was found.
The sections below are the affirmative proof for each focus area the mission demanded.

### 2.1 SQL injection across all 5 modules + the CLI — INERT

The DeepLake HTTP endpoint binds no parameters, so the `src/daemon/storage/sql.ts`
helpers ARE the parameter binding. Every value/identifier sink in the ontology surface
was traced:

- **`entity-model.ts` (attacker-controllable entity names from the linker):** the inline
  linker scans memory content (attacker-controllable) for proper nouns
  (`extractProperNounCandidates`), canonicalises each, and resolves it via
  `resolveExistingEntityId` — the candidate is interpolated with `sLiteral(canonicalName)`
  (line 555) for an EXACT match, never `sqlLike` (no wildcard semantics), under the
  `agentClauseFor` conjunct. Table/column names go through `sqlIdent`. A crafted entity
  name like `'); DROP TABLE entities; --`, a `%`/`_` wildcard, or unicode is doubled-quoted
  by `sqlStr` and collapses to one inert literal — it can match no entity and link nothing.
  Writes (`writeEntity` / `writeAspect` / `writeAttribute` / `writeMention`) use the `val.*`
  constructors exclusively (→ `renderValue` → `sLiteral`/`eLiteral`).
- **`dependencies.ts` (edge fields + conflict content):** `writeDependencyEdge` routes every
  column through `val.*`; the `reason`/`content` go through `val.text` (`eLiteral`). The
  conflict detector is pure string work (no SQL). The dedup probe interpolates the
  deterministic `dep_` id via `sLiteral`.
- **`supersede.ts` (claim content / slot keys):** both appends (`appendNewVersion`,
  `appendPriorSuperseded`) use `val.*`; the reads (`readCurrentStateById`,
  `readMaxClaimVersion`, `readPriorActiveId`) build their SELECTs with `sqlIdent` +
  `sLiteral` (and the catalog's `buildHighestActiveVersionSql`, itself guarded). Slot keys
  are sha256-hashed (`slotClaimKey` / `attributeVersionId`), so even a malicious slot value
  becomes a hex digest before it touches SQL.
- **`control-plane.ts` (the jsonb proposal payload):** the schemaless `payload` is
  serialized with `JSON.stringify` and written through `val.text` (`eLiteral`, escape-safe)
  — the sanctioned JSONB pattern. Projected payload fields (`payloadStr`/`payloadNum`) are
  fed into the entity-model writers, which re-escape them via `val.*`. The dry-run preview
  SQL in `planApply` is built with `sqlIdent` + `sLiteral`.
- **`cli/ontology.ts` (CLI args):** the CLI constructs **no SQL at all** — it imports no
  storage path, holds no storage handle, and issues no query/fetch/exec (verified by grep).
  The only SQL it ever surfaces is a preview *string* returned from the daemon's pure
  `planApply` (already escaped). A crafted `--proposal '<json>'` arg is `JSON.parse`d and
  handed to the pure plan builder; a parse failure is swallowed to `undefined`.

**Proof:** `npm run audit:sql` (scope `src/daemon`, 61 files) → `OK`. A confirmatory scan
of `src/cli` (2 files) → `OK`. Grep for raw `${...}` interpolations outside the safe-helper
set across `src/daemon/runtime/ontology` → no matches. Grep for `query(` / `fetch(` /
`exec(` / `child_process` in the CLI → no matches.

### 2.2 Scope isolation on every graph write/read — STRUCTURAL

- **API-level:** `StorageClient.query(sql, scope)` requires a `QueryScope` (`org` mandatory);
  there is no `query(sql)` overload that omits it (`client.ts:101`, a-AC-2). An unscoped
  tenant query is structurally un-issuable.
- **Engine ring:** the ontology tables are `scope: "agent"` (catalog `knowledge-graph.ts`):
  `agent_id` + `visibility`, no `org_id`/`workspace_id` columns. Every read in the ontology
  modules carries the `agentClauseFor(agentId)` conjunct (`entity-model.ts:147,552`), and
  every write threads `agent_id` via `val.str(agentId)`. The linker's `resolveExistingEntityId`
  matches `name = '<canonical>' AND agent_id = '<self>'`, so it can only ever return THIS
  agent's entity under THIS partition — the cross-agent boundary is unreachable (a-AC-6).
- **Control plane + CLI:** the `ControlPlaneActor.agentId` is threaded onto every
  `ontology_proposals` / `epistemic_assertions` row; `planApply` binds and echoes
  `org`/`workspace`/`agentId`; the CLI passes the parsed scope straight through. A crafted
  scope cannot reach another agent's entities because the agent conjunct is on the statement,
  not derived from user-controlled data.

### 2.3 Control-plane integrity — TRUST BOUNDARY HOLDS

- **Two-mode router (D-6):** `routeProposal` (`control-plane.ts:151`) is **pure** and
  **allow-list driven**. Direct-apply requires ALL of: operation ∈ `DIRECT_APPLY_OPERATIONS`,
  empty `riskNote`, `confidence ≥ 0.5`, and a non-batch payload. Any failure → `pending`
  (not applied). A risky/broad/destructive/generated op cannot reach direct-apply because
  merge/archive/extract/consolidate are absent from the allow-list, a non-empty `riskNote`
  forces review, and a payload carrying a `batch`/`items`/`entities`/`claims`/`operations`
  array (length > 1) forces review.
- **Crafted confidence/risk_note cannot flip routing:** routing runs on the *validated*
  `Proposal`. `parseProposal` (zod) rejects `NaN`/`Infinity`/out-of-range confidence
  (verified empirically with zod 4.4.3: `NaN`, `Infinity`, `1.5`, `-0.1` all fail) — a
  malformed proposal returns `null` → `failed` outcome, recorded nowhere, applied nowhere.
  So the `confidence < FLOOR` comparison can never see a non-finite value, and a malicious
  payload cannot smuggle a wider confidence past the floor.
- **Constraints NOT auto-superseded (D-7):** `supersedeOnConflict` (`dependencies.ts:421`)
  returns `null` immediately when `prior.kind === "constraint"`, BEFORE conflict detection.
  A deliberate `claim.supersede` of a constraint through the control plane IS intended,
  audited behavior (CONVENTIONS §"supersedeClaim … is MECHANISM, not POLICY", lines 81-83) —
  not a bypass: it requires a well-formed, risk-routed, audited proposal.
- **Raw artifacts NEVER rewritten (c-AC-3):** `applyBoundedOperation` (`control-plane.ts:284`)
  writes ONLY `entities` / `entity_aspects` / `entity_attributes` (via the entity-model
  writers + `supersedeClaim`). Grep confirms no `sessions` / `source` / memory-table write
  and no `UPDATE`/`DELETE`/`DROP` statement anywhere in the ontology modules (all such tokens
  are in JSDoc only). The apply path has no code path that reaches a source/transcript table.
- **Epistemic assertions do NOT auto-promote (FR-8):** `recordAssertion` (`control-plane.ts:468`)
  writes ONLY `epistemic_assertions` and never touches `entity_attributes`. Promotion to a
  claim requires a separate `submitProposal` call.

### 2.4 Supersession integrity — APPEND-ONLY, CONVERGENT

`supersede.ts` is append-only: the new claim is appended at version N+1 (`appendNewVersion`),
and the prior sibling is marked superseded by APPENDING a new version of the prior id
(`appendPriorSuperseded`) — never an in-place UPDATE (which does not converge on the live
backend). The version high-water mark is read across ALL statuses (`readMaxClaimVersion`),
so N+1 can never collide with a superseded row's version, and the "resurrect a superseded
claim" path is closed: the current claim is always the highest-version *active* row per
`claim_key` (`buildHighestActiveVersionSql`), and the prior id's current state is its
highest version (superseded). Reads are poll-convergent (a stale segment can only
under-report, never invent), so the highest-version read cannot be tricked into returning
a stale active row over a durable superseded one. Content is copied forward UNCHANGED on the
mark (b-AC-2), so the chain cannot be corrupted by the mark itself.

### 2.5 CLI dry-run safety — STRUCTURALLY NON-MUTATING

`cli/ontology.ts` imports no daemon storage path and holds no storage handle. The dry-run
plan is produced by the daemon's **pure** `planApply` (no storage parameter), injected as a
`PlanBuilder`. A live `stream apply` (no `--dry-run`) is **refused** with exit code 2
("requires --dry-run in this build"). Every command returns `mutated: false`. The plan echoes
only the bound `org`/`workspace`/`agent` scope the caller supplied — no other tenant's data is
read or surfaced (the live listing/merge-plan reads are deferred to the daemon RPC and not yet
wired, so the CLI cannot leak cross-tenant data today).

---

## 3. Verification — Gate Exit Codes + Test Counts

All commands run from repo root after the audit (no code changed, so these prove the
branch state the audit certifies):

| Gate | Command | Result | Exit |
|------|---------|--------|------|
| SQL-safety (daemon) | `node scripts/audit-sql-safety.mjs` | scanned 61 files — OK | 0 |
| SQL-safety (CLI, confirmatory) | `node scripts/audit-sql-safety.mjs src/cli` | scanned 2 files — OK | 0 |
| CI (typecheck + dup + test + audit:sql) | `npm run ci` | **542 tests passed (44 files)** | 0 |
| Build (tsc + esbuild multi-harness) | `npm run build` | 1 daemon + 5 hook + 1 OpenClaw + 1 MCP + 1 CLI + 1 embed bundle @ 0.1.0 | 0 |
| OpenClaw bundle scan | `npm run audit:openclaw` | scanned 1 file — clean against ClawHub rules | 0 |
| Supply chain (prod deps) | `npm audit --omit=dev` | **found 0 vulnerabilities** | 0 |

**Live ontology tests:** NOT re-run. The rule requires them only "if you touch
supersession/graph writes" — this audit touched no code, so the supersession/graph-write
paths are byte-for-byte the code the prior `/the-smoker` waves already proved live (ledger
tasks #30–#34: 3+ clean consecutive live runs of `ontology-*.itest.ts`). Re-running would
prove nothing new about a security change that does not exist. `.env.local` is present, so
the live suite remains runnable on demand.

**Working-tree diff (remediation):** none. `git diff` over `src/cli/ontology.ts` and
`src/daemon/runtime/ontology/*` is empty — the audit introduced zero changes. (The untracked
PRD-008 implementation files and the backlog→in-work PRD move are pre-existing branch work,
not audit edits.)

---

## 4. Medium / Low Findings (documented; no control weakened)

### L1 — `audit:sql` does not scan `src/cli` in CI (Low / defense-in-depth)

`scripts/audit-sql-safety.mjs` defaults to `src/daemon` and `package.json`'s `audit:sql`
script passes no directory, so `src/cli` is not gated in CI. Today this is harmless: the CLI
constructs no SQL and imports no storage path (the storage-import invariant test enforces it),
and a confirmatory manual scan of `src/cli` passes. But if a future CLI change ever
hand-builds a statement, CI would not catch it.

**Recommendation (not remediated — out of in-session scope; would change the CI contract):**
when the daemon-assembly step wires the CLI to issue RPCs or any direct SQL, extend the
`audit:sql` script (or add a second invocation) to cover `src/cli`. Keep the storage-import
invariant test as the primary guard.

### L2 — Empty `agentId` coerces to the shared `"default"` agent (Low / by design, flag)

`agentClauseFor` (`entity-model.ts:126`) maps `agentId === ""` to the literal `"default"`
agent, and the control-plane / CLI default `agentId` is `"default"`. This is the documented
catalog default (`agent_id … DEFAULT 'default'`), so an unscoped caller reads/writes the
shared default-agent partition rather than erroring. This is not a cross-tenant leak — the
`org`/`workspace` partition still isolates tenants, and the default agent is per-partition —
but a caller that forgets to set `agentId` silently lands in a shared agent bucket rather than
failing loud.

**Recommendation (not remediated — would change documented default behavior):** when the
daemon assembly wires real agent identity end-to-end, consider requiring an explicit
non-empty `agentId` at the control-plane / CLI boundary (fail-closed) rather than defaulting,
so a missing agent scope is an error, not a silent merge into `default`. Track as a hardening
follow-up, not a vulnerability.

---

## 5. Unresolved Critical / High

**None.** No Critical or High findings were identified, so none remain unresolved. The branch
is clear for `quality-worker-bee`.

### CVE / intelligence freshness note

`npm audit --omit=dev` reports 0 production-dependency vulnerabilities and the OpenClaw bundle
scan is clean. (The Stinger's `research/cve-watchlist.md` freshness gate was not separately
inspected this run; if its `Last refreshed` date exceeds 120 days, recommend re-running
`forge-stinger` to refresh the dependency/bundle intelligence — standard escalation, not a
finding against PRD-008.)
