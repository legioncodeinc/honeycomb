# Product decision log (git and ADR)

- Date: 2026-10-04
- Shard: Wave 2 git, product decisions only
- Branch: `legion/kb-sotu-and-prd-lifecycle`
- Read-only against source, knowledge, and ADRs. This file is the only write. No ADR was added. No commit.

Subjects below replace U+2014 with an ASCII hyphen. Full shas are the locking commits from `git log`.

## Bar

An ADR is warranted only when deleting it would lose why the code is shaped that way. Measurements and how-to stay in knowledge docs. Verdicts are an existing ADR id, CANDIDATE, or REJECT because a knowledge doc, PRD, or execution ledger already holds that why. Next free ADR number is 0012. This report does not assign it.

Out of this shard (the other git agent): fleet root, local queue, embeddings, and local ANN. `05e699854714d541d9687db5340ef45260ad8823` (2026-07-10, `feat(recall): per-turn recall fast path (PRD-077) (#281)`) is that agent's latency mechanism, not the injection decision below.

`library/requirements/reports/2026-10-04-kb-prd-standing/prds/completed-009-016.md` was read. Its bucket calls (mostly back to in-work) are standing moves, not shape decisions. Unmounted routes and test-only modules in that shard are absent work, not locked choices. The only overlap is the PRD-011 role name, scored below.

## Score

| Decision | Lock | Verdict |
|---|---|---|
| Keep post-query RRF over `deeplake_hybrid_record` | `cdc909d939f4d856bfaf600b8964790c8cdc327f` 2026-06-24 | ADR-0001 |
| Per-turn recall injection | `6afb337a61911fe73166c1f57ec8201c8d0a74f5` 2026-07-08 | REJECT |
| Role name `member` instead of `operator` | `a3d28daf3b0ffd062f0662f77086b0696bc9a4c3` 2026-06-18 | REJECT |
| Hive portal on 3853 instead of a daemon dashboard | `4b10cc4c74f20c828cb435ad806d438b806e5b8e` 2026-07-01, tightened by `8a30048b184660dc29ac47ef653a2366110179c5` 2026-07-05 | REJECT |
| MCP stdio instead of the daemon `/mcp` route | `c3b587db0dd84cc2891da6f7bc763d1b972001f1` 2026-06-20 | CANDIDATE |
| Capture gate for unbound projects | `4528069ce4368923cf3af5074bb6ef08aadb392d` 2026-07-04 | REJECT |

Candidate count: 1.

## 1. Keep RRF over `deeplake_hybrid_record`

- Verdict: ADR-0001
- Commit: `cdc909d939f4d856bfaf600b8964790c8cdc327f`
- Date: 2026-06-24
- Subject: `feat(prd-047): retrieval quality upgrades - rerank, dedup, recency, MMR, graded nDCG eval (#97)`
- Decision locked: post-query RRF stays the production fusion. `deeplake_hybrid_record` stays unwired. The 2026-06-24 re-run tied RRF (recall@5 0.611 vs 0.611) and failed the tie-or-beat-on-MRR gate, so parity was not a reason to adopt the operator.

The commit message records the ADR landing in the same change (`docs(prd-047): ... keep RRF + ADR-0001`). The why is the ADR body: no package savings, no verified cost cut, and a black-box operator that had just spent a run returning constant-zero scores (`library/knowledge/private/architecture/adr/0001-retrieval-fusion-rrf-vs-native-hybrid.md:68-78`).

Holding pages, do not write a second ADR: the benchmark report `library/requirements/completed/prd-047-retrieval-quality-upgrades/reports/2026-06-22-hybrid-benchmark-decision.md`, and the operator-report header `library/knowledge/private/ai/deeplake-hybrid-record-operator-report.md:3-12`. Wave 1 `knowledge/ai-recall.md` D18 and D26 are stale numbers on sibling pages. Revise those pages. Leave ADR-0001. The 0.611 and 0.72-0.78 bands are measurements and stay out of any new ADR.

## 2. Per-turn recall injection

- Verdict: REJECT
- Commit: `6afb337a61911fe73166c1f57ec8201c8d0a74f5`
- Date: 2026-07-08
- Subject: `PRD-075 + PRD-076: Honeycomb recall arms (on-demand + always-on) & Claude Code plugin packaging (#271)`
- Decision locked: every `UserPromptSubmit` injects query-aware recall. Session-start prime stays a once-per-session blind digest. PRD-075 is the separate on-demand PreToolUse arm.

Why, already written: a session-start prime fires before any query and goes stale, so later turns got no recall (`library/requirements/completed/prd-076-always-on-recall-and-plugin-packaging/prd-076-always-on-recall-and-plugin-packaging-index.md:3-4` and `:19-26`). The same why is in `library/knowledge/private/integrations/hook-lifecycle.md:107-109`.

`library/knowledge/private/ai/three-tier-memory-strategy.md:124-128` still states the superseded boundary ("never auto-inject per turn") and names latency and lost-in-the-middle as the reason. Wave 1 `knowledge/ai-recall.md` D23 marks that sentence FALSE. Revise the paragraph so it points at the PRD-076 floor. Do not add an ADR to overturn it. ADR-0011 is a different decision (in-tree session chunker, still Proposed) and its Related line mislabels PRD-076 as capture-time chunking. Do not reuse ADR-0011 for injection.

## 3. Role name `member` instead of `operator`

- Verdict: REJECT
- Commit: `a3d28daf3b0ffd062f0662f77086b0696bc9a4c3`
- Date: 2026-06-18
- Subject: `feat(prd-011): tenancy & auth - partition isolation, device login, RBAC, API keys`
- Decision locked: four roles, `admin | member | readonly | agent`. `member` is the scoped read-plus-write role. It is not an admin. The PRD-011c prose word `operator` was not the frozen name.

Why, already written: ledger D-1 (`library/ledger/EXECUTION_LEDGER-prd-011.md:20`) and the code note that the ledger reconciled the prose (`src/daemon/runtime/auth/rbac.ts:23-27`). The QA note says the same and asks only for a prose edit (`library/requirements/completed/prd-011-tenancy-and-auth/reports/2026-06-17-qa-report.md:46-73`).

`library/knowledge/private/auth/auth-architecture.md:78` and `library/requirements/completed/prd-011-tenancy-and-auth/prd-011c-tenancy-and-auth-modes-rbac.md:36` still say `operator`. Wave 1 `knowledge/auth-tenancy.md` D1 is a page revise. The capability matrix is the shape; the spelling is the ledger's vocabulary. Deleting a new ADR would not lose a reason the ledger and `rbac.ts` do not already state. No honeycomb ADR covers this name. Do not add one.

## 4. Hive portal on 3853 instead of a daemon dashboard

- Verdict: REJECT
- Commits:
  - `4b10cc4c74f20c828cb435ad806d438b806e5b8e`, 2026-07-01, `Removed portal to migrate to the-hive`. Deletes `src/dashboard/web/` and `src/daemon/runtime/dashboard/host.ts`.
  - `b1da8275e8b6368f05e8c451488b6db9652f7f63`, 2026-07-01, `Add CORS support so thehive's dashboard can call honeycomb cross-origin`. Short-lived. The message says Hive serves the SPA on `127.0.0.1:3853` and Honeycomb keeps `/api/*`.
  - `baffcff4e7154fbab403e6829f786e22cd070d04`, 2026-07-01, `Remove dashboard CORS middleware (superseded by thehive BFF proxy)`. Browser talks only to Hive. Hive proxies to Honeycomb on loopback. Hive ADR-0002 is cited there and is not a file in this repo.
  - `8cea04f6600bd52ee2dc98d325bb45d5feef6118`, 2026-07-03, `docs(knowledge): KB sync for merged PRs #201-#221 [skip-ai-knowledge]`. Writes that arrangement into the knowledge page.
  - `8a30048b184660dc29ac47ef653a2366110179c5`, 2026-07-05, `Release v0.5.4: don't hijack hive's portal; complete Deeplake login on multi-tenancy accounts`. Honeycomb never binds 3853. Fleet install opens no browser because Hive owns the portal.
- Decision locked: the browser UI is the Hive portal at `http://127.0.0.1:3853/`. The daemon stays the loopback API on 3850, serves no dashboard HTML, and ships no CORS middleware.

Why, already written: `library/knowledge/private/frontend/dashboard-architecture.md:22-26` (two processes, Hive owns the SPA origin, Honeycomb keeps `/api/*`), `:42` (in-repo host removed, no `GET /dashboard`), and `:159-163` (BFF, then CORS removed). Install behavior is `library/knowledge/private/operations/install-and-onboarding.md:69` and `:86-87`. The daemon comment is `src/daemon/runtime/server.ts:286-291`. The port constant and the open URL are `src/shared/constants.ts` and `src/commands/install.ts:67-74`.

Wave 1 `knowledge/frontend-dashboard.md` D1 and D2 are revises: the React shell and Hive internals are not in this checkout. Trim those claims. Do not add an ADR to restate the split. `src/dashboard/launch.ts:149` and `src/commands/install.ts:64` cite "ADR-0001" for the portal URL. In this repo ADR-0001 is the RRF decision. That citation is a comment bug. Do not mint a Honeycomb ADR to absorb a Hive cutover id. Hive's ADR is outside this tree (wave 1 D2).

Wave 1 `prds/in-work-020.md` index AC-2 is a standing gap (the CLI discards the view tree). That is unmet product work, not a second reason to ADR the 3853 split.

## 5. MCP stdio instead of the daemon `/mcp` route

- Verdict: CANDIDATE
- Commits:
  - `e42e611a6315fbe3f4b130b3be24bf0e9ab9a28d`, 2026-06-17, `feat(prd-004): daemon runtime - Hono server, durable queue, file watcher, runtime-path`. Scaffolds the daemon group. Live table still has `{ path: "/mcp", protect: true, session: true }` at `src/daemon/runtime/server.ts:104`. Nothing in `src/daemon` attaches a handler, so the group falls through to 501.
  - `b26686239efdbb34698db961797bd6792cb72924`, 2026-06-18, `feat(prd-019): harness integrations - connector base, hook lifecycle, shims, MCP, SDK`. Builds the separate `mcp/` server.
  - `c3b587db0dd84cc2891da6f7bc763d1b972001f1`, 2026-06-20, `feat(prd-021): go-live - assemble + run the daemon end-to-end against live DeepLake`. This is the lock. `mcp/bundle/server.js` answers `initialize` over stdio. `serveHttp` defaults false (`mcp/src/index.ts:109-113`). Auto-start on the bundle entry calls `startMcpServer()` with no HTTP (`mcp/src/index.ts:195-203`). No `src/daemon` caller starts that server.
- Decision locked: a harness speaks MCP by spawning `node mcp/bundle/server.js` on stdio. HTTP `/mcp` on that process is opt-in. The daemon's `/mcp` group is an empty scaffold.

Why this is not already held:

- `library/requirements/in-work/prd-019-harness-integrations/prd-019d-harness-integrations-mcp-server.md:10` and `:34` still require the server inside the daemon, at `/mcp` and on stdio.
- `library/requirements/completed/prd-021-go-live/prd-021e-go-live-mcp-transport.md:14` and `:34` still require both transports connected, and `:67` leaves the process question open: same daemon process, or a separate MCP process. The checkbox is unchecked.
- Committed `library/knowledge/private/integrations/mcp-and-sdk.md:22` says the server binds both stdio and streamable HTTP at `/mcp`. That is the construction seam, not the production choice.
- Working-tree sentences in `daemon-surface.md`, `api-design-conventions.md`, and `mcp-and-sdk.md:58` state the fact (stdio, daemon scaffold returns 501). They do not say why the open question was closed as a separate stdio process.

The why a later reader needs, and that those pages do not keep:

- Harness MCP clients spawn a command. The registration shape is stdio (`harnesses/hermes/.mcp.json`, and the Claude Code plugin `.mcp.json` from the PRD-076 commit). A spawned helper that also listened would open a port the harness does not use.
- The go-live security note records that posture: harness-spawned bundle runs `serveHttp: false`, stdio only, no network listener; `serveHttp: true` would bind loopback only (`library/requirements/completed/prd-021-go-live/reports/2026-06-19-security-report.md:79`).
- MCP stays a thin client of the daemon API. It does not open DeepLake (`prd-021e-go-live-mcp-transport.md:55-56`). That thin-client rule is already in the PRD and in `mcp-and-sdk.md`. The candidate is the transport choice, not the thin-client rule. Do not restate tool lists, header stamps, or handler how-to.

Recommended action: one Accepted ADR, next free number, Nygard context / decision / consequences, status Accepted, with a revisit trigger if a harness needs streamable HTTP on the daemon rather than a spawned stdio child. Link PRD-019d and PRD-021e, including the still-open question at `prd-021e-go-live-mcp-transport.md:67`, and say this ADR is the answer. Do not treat the ADR as a reason to move PRD-019 to completed. Wave 1 `prds/in-work-019.md` leaves that folder in-work for other unmet criteria.

## 6. Capture gate for unbound projects

- Verdict: REJECT
- Commit: `4528069ce4368923cf3af5074bb6ef08aadb392d`
- Date: 2026-07-04
- Subject: `Implement PRD-073: dormant-by-default capture and explicit tenancy selection`
- Also: `0794e6e8c5f31cfa24a1dd2e3a20dc35e9d7921d` (2026-07-04, `Merge pull request #232 from legioncodeinc/feature/prd-073-dormant-capture-tenancy`) and `1e335f648f90b851b2d39ad9fd29a35b8387e49d` (2026-07-04, `Release v0.4.0: dormant-by-default capture and explicit tenancy selection (PRD-073)`).
- Decision locked: capture is per session, and an unbound cwd writes nothing unless `HONEYCOMB_INBOX_CAPTURE` is on. The older one-shot first-run gate (`104a6f24332ab1bb705e8025ac85c10f18e14f7d`, 2026-06-26, `feat(daemon): PRD-059 Wave 1 - capture gate + folder-bind + switch-persist routes`) opened forever after the first binding. PRD-073 replaced that.

Why, already written: Honeycomb must not write until the user has said where and for what. An unbound folder has no project to attribute, and the inbox fallback was scattering rows (`library/requirements/completed/prd-073-dormant-capture-and-explicit-tenancy/prd-073-dormant-capture-and-explicit-tenancy-index.md:12-23`). The knowledge page repeats it (`library/knowledge/private/ai/session-capture.md:23-27`). The handler comment matches (`src/daemon/runtime/capture/capture-handler.ts:206-212`).

The same commit also locks explicit org and workspace selection (PRD-073 Decision 2, index `:16`). That why is in the same PRD section. It is not a second candidate. Wave 1 `knowledge/auth-tenancy.md` D15 is a revise: the page over-claims that skillify and every write pipeline share the gate. Narrow the sentence. Do not add an ADR.

## What the ADR author should do

- Write one ADR, for section 5 only. Do not assign the number in this report. Status Accepted. Do not edit ADR-0001.
- Do not write ADRs for sections 1, 2, 3, 4, or 6.
- Do not score fleet root, the local queue, embeddings, or the local ANN index. ADR-0008, ADR-0006, and ADR-0009 already cover the first two of those.
