# Daemon-Wiring Liveness Audit — Completed PRDs

> Category: Report | Version: 1.0 | Date: 2026-06-22 | Status: Active
> Scope: every PRD in `library/requirements/completed/` (001–040, **excluding 017** — fixed in a separate worktree).
> Method: verified each PRD's deliverable against real runtime **invocation sites** in `src/` — the daemon
> composition root [`src/daemon/runtime/assemble.ts`](../../../../../src/daemon/runtime/assemble.ts)
> (`assembleDaemon()` → `assembleSeams()`), the `server.ts` route mounts, and CLI/hook registration —
> **not** PRD header comments or `Status: Completed`. See project-memory note "Completed ≠ live (deferred assembly)".

This audit backs **[PRD-045: Daemon-Wiring Close-out](../prd-045-daemon-wiring-closeout-index.md)**.

---

## The "Stub" premise

There is **no literal `Stub` status** anywhere in `completed/`. Every PRD's `Status:` reads `Completed`/`completed`;
sub-PRDs read `Draft`; the word "stub" appears only as incidental prose. The audit therefore reclassified each
completed PRD by **actual runtime reachability**.

Verdict legend:

- 🟢 **LIVE** — the deliverable is genuinely reachable at runtime (cited invocation site).
- 🟡 **PARTIAL** — partly wired (a sibling route deferred, a surface unmounted, or wired-but-dormant-by-design).
- 🔴 **NOT LIVE** — code + tests exist but **nothing invokes it at runtime** (the "missing daemon wiring" set).

---

## What "wired into the daemon" means here

`assembleDaemon()` is the single production composition root (called from `src/daemon/index.ts`). Its
`assembleSeams()` fires the mount/attach seams exactly once. A route that is **not** mounted falls through to a
`501 not_implemented` scaffold in `src/daemon/runtime/server.ts`. So "live" = a seam is fired (or a CLI verb /
hook is registered) **and** reaches a real engine, proven by an invocation site — never by a doc comment.

---

## Master verdict table (001–040, excl. 017)

| PRD | Verdict | Reality (with evidence) |
|---|---|---|
| 001 monorepo-foundation | 🟢 LIVE (foundation) | Build emits all bundles; everything rides on it. |
| 002 deeplake-storage-adapter | 🟢 LIVE (foundation) | The one live DeepLake client, constructed at `assemble.ts:1024`. |
| 003 core-data-model | 🟢 LIVE (foundation) | Catalog loaded/consumed. **Doc rot:** `src/daemon/storage/catalog/index.ts:15-34` still says "(stub)" / "DO NOT TOUCH — Wave 2" for 3 fully-built groups. |
| 004 daemon-runtime | 🟢 LIVE | Hono server + real services swapped in (`assemble.ts:1036-1050`). |
| 005 capture-intake | 🟢 LIVE | `attachHooks` fired `assemble.ts:564`; `/api/hooks/capture` real (`capture/capture-handler.ts`). |
| **006 memory-pipeline** | 🔴 **NOT LIVE** | **No pipeline worker constructed** (`assemble.ts` builds only the pollinating worker, `:1265`); capture enqueues only `summary`/`skillify` cues (`capture/capture-handler.ts:268-275`), never the 5 pipeline kinds. Engine exists (`pipeline/stage-worker.ts:238`, `pipeline/handlers.ts:51`) but is never leased. **→ PRD-045a** |
| **007 retrieval** | 🟡 PARTIAL → 🔴 for the engineered engine | Recall works via `recallMemories` lexical+vector RRF (`memories/recall.ts:549`, LIVE). But the spec'd 5-phase `RecallEngine` (authz boundary / currentness / confidence gate) has **zero callers** + no-op phase defaults (`recall/engine.ts:121-124,149`). **→ PRD-045b** |
| **008 knowledge-graph-ontology** | 🟡 PARTIAL → 🔴 for surface + linker | Inline entity linker `inlineLinkMemory` (`ontology/entity-model.ts:506`) has **zero callers** (AC-1). **No `/api/ontology/*` mount** (`server.ts:96` scaffold → 501). Apply/supersession run **only via the dormant pollinating runner** (`pollinating/runner.ts:284`). **→ PRD-045c** |
| **009 pollinating-loop** | 🟡 PARTIAL (dormant) | Fully wired (`buildGatedPollinatingWorker` `assemble.ts:926`, started `:1265-1266`) but **gated OFF by default**. It is the sole live consumer of 008 apply + 010 router, so its dormancy strands them. **→ PRD-045d** |
| 010 model-provider-router | 🟡 PARTIAL | Router engine used only by the dormant pollinating path (`assemble.ts:979`). `/api/inference/*` + `/v1/*` gateway built (`inference/gateway.ts:102`) but **never mounted** → 501. (Surface follow-up; engine activates with 045d.) |
| 011 tenancy-and-auth | 🟢 LIVE (mode-gated) | Authenticator + RBAC enforced on `protect:true` groups (`server.ts:299-306`); local-open / team-hybrid deferral is by design. |
| 012 secrets | 🟡 PARTIAL | Names-API + `${SECRET_REF}` inference resolver live (`inference/router.ts:392,437`); `secret_exec` + bitwarden/1password are honest 501 stubs (`secrets/api.ts:109-161`). |
| **013 sources-and-documents** | 🔴 **NOT LIVE** | `/api/sources` deliberately deferred → 501 (`resolveProductDataDeps` omits it, `assemble.ts:732-749`; `product/api.ts:281` skips mount); CLI `honeycomb sources` lands on the 501; `/api/documents` 501 (`sources/api.ts:218-225`); providers are dead code. **→ PRD-045e** |
| 014 codebase-graph | 🟢 LIVE | `mountGraph` fired `assemble.ts:689-696`; real build + `GET /api/graph` + `honeycomb graph build`. |
| 015 virtual-filesystem | 🟢 LIVE | `/memory/*` mounted `assemble.ts:627`; pre-tool-use hook intercept wired (`src/hooks/runtime.ts:204-206`). |
| **016 skillify** | 🔴 **NOT LIVE (mining)** | Skillify jobs enqueued (`session-end.ts:112`, `capture/turn-counters.ts:150`) but **no worker leases `["skillify"]`** (pollinating worker leases only `["pollinating"]`, `pollinating/worker.ts:212-214`); `skillify pull` CLI verb unregistered (`src/cli/skillify.ts:19`). `/api/skills` read is live. **→ PRD-045f** |
| **018 team-skill-sharing** | 🔴 **NOT LIVE** | Publish endpoint never mounted (`skillify/publish-endpoint.ts:71`; `/api/skills` GET-only `product/api.ts:180`); session-start auto-pull resolves to a **no-op** (`src/hooks/runtime.ts:198` builds `SessionStartDeps` with no `seams`); fan-out only via unregistered CLI (`src/cli/skillify.ts:79`). **→ PRD-045g** |
| 019 harness-integrations | 🟡 PARTIAL (1 of 6) | **Claude Code fully live**; Cursor/Codex partial; **Hermes, pi, OpenClaw built-not-wired**; MCP-via-install met for none (registry registers only claude-code + cursor, `src/cli/connector-runner.ts:55-70`). Its own QA report flags 019c deferred. **→ reopened to in-work.** |
| 020 surfaces | 🟡 PARTIAL | CLI + dashboard data API + notifications live; **Cursor extension UI** is an unbuilt source shell (`harnesses/cursor/extension/` — no manifest/installer). **→ reopened to in-work.** |
| 021 go-live | 🟢 LIVE (foundation) | Daemon assembles + all 3 hook endpoints attached (`capture/attach.ts:127-128`). Gaps: daemon `/mcp` HTTP transport + MCP registration into a harness's native tool list. |
| 022 data-access-api | 🟢 LIVE | memories/vfs/goals/kpis/skills/rules/secrets mounted (`assemble.ts:621,627,635`); `/api/sources` deferred (= PRD-013). |
| 023 deeplake-connect-parity | 🟢 LIVE (caveat) | Org-drift heal runs on `honeycomb status` (`status.ts:116-117`); re-mint intentionally inert on real creds (anti-clobber guard, `cli/runtime.ts:263-273`). |
| 024 dashboard-ui-parity | 🟢 LIVE | "Pollinate now" `POST /api/diagnostics/pollinate` mounted `assemble.ts:648`; dashboard consumes live views (`src/dashboard/web/wire.ts`). |
| 025 semantic-recall-default | 🟢 LIVE | Embed attach default-on (`assemble.ts:1095`) + supervisor spawns embed daemon (`embed-supervisor.ts:43`) + recall hits the `<#>` arm (`memories/recall.ts:444-524`). |
| 026 pollinating-loop-enablement | 🟡 PARTIAL (dormant) | Worker built/started behind the gate; OFF by default by design (see 009 / **045d**). |
| 027 recall-ranking-and-eval | 🟢 LIVE + test-infra | RRF ranking on the live recall path (`memories/recall.ts:83,100-103,255-297`); eval harness is a script/itest (`scripts/eval-recall.mjs`) by design. |
| 028 storage-read-consistency | 🟡 PARTIAL | `readConverged` seam live (`storage/converge.ts:273`), but its only `src/` consumer is asset-sync (`assets/sync.ts:187`) — **the doc-named store→recall path never adopted it** (`memories/store.ts` has zero usage). **→ reopened to in-work.** |
| 029 degradation-observability | 🟢 LIVE | `recall.degraded` event (`memories/api.ts:245`) + `/api/diagnostics/health` reasons (`diagnostics-health.ts`, fired `assemble.ts:674`). |
| 030 memory-compaction | 🟢 LIVE | `POST /api/diagnostics/compact` mounted `assemble.ts:660-665` + `maintenance compact` CLI. |
| 031 live-integration-test-net | 🟢 LIVE (test-infra) | Assembled-daemon harness (`tests/integration/_daemon-harness.ts`) + skip-safe CI; ~47 itests. |
| 032 encrypted-vault | 🟢 LIVE | `/api/settings` mounted `assemble.ts:1149-1156` + boot-time `DEEPLAKE_TOKEN` migration (`:1241-1255`) + vault wire-back + CLI. |
| 033 asset-sync-substrate | 🟡 PARTIAL | `/api/assets` + `honeycomb asset` CLI live (`assemble.ts:1167-1180`); **session-start asset auto-pull is dead code** (`daemon-client/assets/install.ts:258` never called; `session-start.ts:72` only auto-pulls skills). **→ reopened to in-work.** |
| 034 resilient-live-test-strategy | 🟢 LIVE (test-infra) | push-soft/nightly-hard split + `workflow_dispatch` stress harness all present. |
| 035 dashboard-data-fixes | 🟢 LIVE | All 3 fixes live (`dashboard/api.ts:220-242`, `dashboard/web/panels.tsx:326`). |
| 036 skill-asset-discovery | 🟢 LIVE | Scanner + union skill view + Team-skills KPI on mounted endpoints (`dashboard/api.ts:462-504,610-616`). |
| 037 dashboard-nav-shell | 🟢 LIVE (local-only) | Shell + hash router + registry are the live dashboard entry (`dashboard/web/main.tsx:32-35`). |
| 038 dashboard-home | 🟢 LIVE (local-only) | All 3 zones read real endpoints, no mocks. |
| 039 harnesses-page | 🟢 LIVE | `mountHarness` fired `assemble.ts:707-714`; page consumes `/api/diagnostics/harnesses`. |
| 040 memories-page | 🟢 LIVE (local-only) | Browse/search/CRUD/compact/pollinate/watch all on live endpoints. |

---

## The actionable set — "missing wiring into the daemon"

These Completed PRDs are **not reachable at runtime**. They are the scope of **PRD-045** (sub-PRDs a–g):

| PRD | Sub-PRD | Core gap | Priority |
|---|---|---|---|
| 006 memory-pipeline | 045a | No worker constructed; capture never enqueues pipeline jobs. **Largest gap** — also strands the 010 router. | P0 |
| 007 retrieval | 045b | Five-phase `RecallEngine` (authz/currentness/confidence) has zero callers + no-op phases. | P1 |
| 008 ontology | 045c | Entity linker uncalled; `/api/ontology/*` unmounted; apply only via dormant pollinating. | P1 |
| 009 pollinating-loop | 045d | Wired but dormant-by-default; the activation point for 008 apply + 010 router — needs default-posture decision + live proof. | P1 |
| 013 sources-and-documents | 045e | `/api/sources` + `/api/documents` deferred → 501; providers dead code. | P1 |
| 016 skillify | 045f | Mining jobs enqueued but no worker leases them; `skillify pull` CLI unregistered. | P1 |
| 018 team-skill-sharing | 045g | Publish endpoint unmounted; auto-pull a no-op; fan-out via unregistered CLI. Depends on 045f. | P2 |

**Reopened to `in-work/` as their own PRDs** (PARTIAL — substantial remaining work, but not whole-engine-dead like the set above):

- **019 harness-integrations** — 5 of 6 harness adapters incomplete; MCP-via-install for none.
- **020 surfaces** — Cursor extension UI unbuilt.
- **028 storage-read-consistency** — the store→recall read-your-writes call site never adopted the seam.
- **033 asset-sync-substrate** — session-start asset auto-pull not hooked into the lifecycle.

**Wired-but-dormant by design (not gaps):** 009 / 026 pollinating worker (needs the enable flag) — tracked under 045d as an activation/decision item, not a defect.

---

## Cross-cutting notes

1. **Pervasive doc rot (cosmetic).** Every Completed index still lists its sub-PRDs as `Draft`, and
   `src/daemon/storage/catalog/index.ts:15-34` carries stale `(stub)` / "Wave 2 — DO NOT TOUCH" comments on
   three fully-built catalog groups. Recommend a dedicated `library-stinger` sync-audit pass (guide 06) to flip
   sub-PRD statuses repo-wide; out of scope for PRD-045's wiring work.
2. **Latent route collision (non-breaking).** Both `mountDashboardApi` and `mountGraphApi` register
   `GET /api/graph`; registration order makes the dashboard's `{nodes,edges}` shape win (correct for the widget),
   so `mountGraphApi`'s status shape is shadowed. Doesn't break anything today, but flagged given this repo's
   history with route collisions (project-memory: "Dogfood surfaces integration bugs").
3. **One unresolved discrepancy to confirm during 045f/045g.** Investigators diverged on the **session-start
   auto-pull** path: one read the seam as live, the other found `src/hooks/runtime.ts:198` builds
   `SessionStartDeps` with **no `seams`**, making `autoPullSkills` a no-op. The deeper read (no seams passed) is
   the more likely-correct one; confirm directly before fixing.

---

## How this maps to lifecycle moves

- **PRD-045** created in `in-work/` with sub-PRDs a–g for the 🔴 NOT-LIVE / engine-dead set (006/007/008/009/013/016/018).
- **019 / 020 / 028 / 033** moved `completed/` → `in-work/`; their index `Status` flipped to **In Work** with a reopened note.
- **006 / 007 / 008 / 009 / 013 / 016 / 018** remain in `completed/` (per the lifecycle-in-folder invariant — they are not being relocated) but each index carries a **reconciliation banner** pointing to its PRD-045 sub-PRD.
