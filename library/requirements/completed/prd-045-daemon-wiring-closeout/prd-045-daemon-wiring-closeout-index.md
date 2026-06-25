# PRD-045: Daemon-Wiring Close-out

> **Status:** Completed (2026-06-25 — all engines verified live at the composition root; QA rev 3 PASS)
> **Priority:** P0
> **Effort:** XL
> **Schema changes:** None (the engines + tables already exist; this PRD wires them)

---

## Overview

A liveness audit on 2026-06-22 (see [`reports/2026-06-22-daemon-wiring-liveness-audit.md`](./reports/2026-06-22-daemon-wiring-liveness-audit.md))
checked every Completed PRD against real runtime **invocation sites** and found a recurring failure mode: several
PRDs shipped a built-and-tested engine but **the daemon never invokes it**. The work was "code + tests done" yet
the deliverable is unreachable at runtime — the exact "Completed ≠ live (deferred assembly)" trap the project
already knows. A route that is never mounted in the composition root
([`src/daemon/runtime/assemble.ts`](../../../../src/daemon/runtime/assemble.ts)) falls through to the
`501 not_implemented` scaffold in `src/daemon/runtime/server.ts`; a job kind that nothing leases is enqueued and
never consumed.

PRD-045 is the **wiring close-out**: it does not (re)build business logic. For each affected PRD it fires the
missing mount/worker seam in the composition root, registers the missing CLI verb or hook seam, and proves the
deliverable end-to-end against a real assembled daemon. It is the data-engine twin of PRD-021 (runtime assembly)
and PRD-022 (data-access wiring) — the place where already-built engines from PRDs 006/007/008/009/013/016/018
finally meet a live invocation site.

The acceptance bar is **behavioral and per-engine**: a captured turn flows through the memory pipeline; recall
applies its shaping phases; an entity gets linked and `/api/ontology` answers; a pollinating pass runs to completion;
`/api/sources` and `/api/documents` return real data; a session-end mines a skill that a teammate then pulls.

## Goals

- Construct + start the **memory-pipeline worker** and enqueue pipeline jobs on capture, so captured turns run the
  extraction → decision → controlled-write → graph-persist → retention stages (045a).
- Put the **retrieval shaping engine** on the live recall path, or formally de-scope the dormant five-phase engine
  and reconcile the PRD — no silent gap between doc and runtime (045b).
- Invoke the **inline entity linker** on a live path and mount **`/api/ontology/*`** (045c).
- Decide the **pollinating default posture** and prove the loop end-to-end (it is the activation point for 008 apply
  and the 010 router) (045d).
- Fire **`mountSourcesApi`** + the document worker + provider instantiation so `/api/sources` and `/api/documents`
  stop 501ing (045e).
- Construct + start the **skillify mining worker** and register the `skillify pull` CLI verb (045f).
- Mount the **skill publish endpoint**, wire the real **session-start auto-pull seam**, and register the skill CLI
  verbs so **team skill sharing** actually propagates (045g).
- Each sub-PRD lands with a **live integration test** proving the path through a real assembled daemon (per the
  PRD-031 test-net) — invocation-site evidence, never a header comment.

## Non-Goals

- **No new business logic and no new DeepLake schema.** The engines and tables exist; this PRD wires them. Where a
  sub-PRD must fill a stub handler (e.g. 006's four non-extraction stages), that is the minimum to make the wired
  path produce real output, not a redesign.
- **The 010 model-provider-router HTTP gateway** (`/api/inference/*`, `/v1/*`) and the **021 `/mcp` HTTP transport**
  are out of scope here — the router engine is reactivated as a side effect of 045d (pollinating), but its external
  HTTP surface is a separate follow-up.
- **The four reopened PRDs (019 / 020 / 028 / 033)** are tracked as their **own** in-work PRDs, not as PRD-045
  sub-PRDs (their remaining work is feature completion, not whole-engine wiring). See Related.
- **Repo-wide doc-rot cleanup** (sub-PRD `Draft` statuses, stale `catalog/index.ts` comments) — a separate
  `library-stinger` sync-audit pass (guide 06).
- **PRD-017** (wiki-summaries) — explicitly excluded; being fixed in a separate worktree.

## Sub-features

| Sub-PRD | Source PRD | Scope | Status |
|---|---|---|---|
| [`prd-045a-...-memory-pipeline`](./prd-045a-daemon-wiring-closeout-memory-pipeline.md) | 006 | Construct + start the pipeline worker; enqueue pipeline jobs on capture; fill the 4 stub stages. | Completed |
| [`prd-045b-...-retrieval-engine`](./prd-045b-daemon-wiring-closeout-retrieval-engine.md) | 007 | Wire the five-phase `RecallEngine` onto the recall route (or de-scope + reconcile). | Resolved — DE-SCOPED |
| [`prd-045c-...-ontology-surface`](./prd-045c-daemon-wiring-closeout-ontology-surface.md) | 008 | Invoke the inline entity linker on capture/pipeline; mount `/api/ontology/*` + CLI. | Completed |
| [`prd-045d-...-pollinating-activation`](./prd-045d-daemon-wiring-closeout-pollinating-activation.md) | 009 | Decide default posture; prove the pollinating pass end-to-end (enqueue→lease→model→apply→state). | Completed |
| [`prd-045e-...-sources-documents`](./prd-045e-daemon-wiring-closeout-sources-documents.md) | 013 | Fire `mountSourcesApi`; wire the document worker + providers. | Completed |
| [`prd-045f-...-skillify-mining`](./prd-045f-daemon-wiring-closeout-skillify-mining.md) | 016 | Construct + start a `["skillify"]` worker; register the `skillify pull` CLI verb. | Completed |
| [`prd-045g-...-team-skill-sharing`](./prd-045g-daemon-wiring-closeout-team-skill-sharing.md) | 018 | Mount publish endpoint; wire session-start auto-pull seam; register skill CLI verbs. | Completed |

## Decisions

- **Wiring-only, mirrors PRD-021/022.** PRD-045 introduces no new schema and adds business logic only where a
  stub handler must produce real output for the wired path to mean anything (006's four stages). The composition
  root chooses the order and fires each seam once.
- **Every fix lands with a live invocation-site proof.** The recurring root cause was trusting "Completed"
  headers over runtime reachability. Each sub-PRD's acceptance criteria are behavioral and cite the new invocation
  site (`assemble.ts` seam line, leased job kind, registered CLI verb), and add a live itest under the PRD-031 net.
- **Dormant-by-design is not a defect.** 045d treats the pollinating default-OFF posture as a **decision** to make
  explicit (and prove when ON), not a bug — but its dormancy currently strands 008 apply + 010 router, so the
  loop must be proven end-to-end at least under the enable flag.
- **The four reopened PRDs are separate.** 019/020/028/033 move back to `in-work/` and carry their own reopened
  status; PRD-045 is scoped to the seven whole-engine-dead deliverables so the close-out stays coherent.
- **Sequence.** 045a (pipeline) is P0 and unblocks 045c (the graph-persist stage is a live apply path) and feeds
  045d. 045f (skillify mining) precedes 045g (team sharing needs mined skills to propagate).

## Acceptance Criteria

- [x] **AC-1** — Each of 006/007/008/009/013/016/018 has a cited **runtime invocation site** in `src/` (a fired
      `assemble.ts` seam, a leased job kind, or a registered CLI/hook seam) — no deliverable reachable only from tests.
- [x] **AC-2** — A captured turn is observably processed by the **memory pipeline** (extraction produces facts),
      proven by a live itest (045a).
- [x] **AC-3** — `/api/ontology/*` (045c), `/api/sources` + `/api/documents` (045e) return real data (no 501) on a
      real assembled daemon.
- [x] **AC-4** — A **pollinating pass** runs to completion when enabled (enqueue → lease → model → ontology apply →
      append-only state), proven by a live itest (045d).
- [x] **AC-5** — A session-end **mines a skill** (045f) that is then **published and pulled** by a second
      workspace/harness (045g), proven end-to-end.
- [x] **AC-6** — The retrieval shaping phases are either **on the live recall path** or formally **de-scoped**, with
      PRD-007's doc reconciled to match runtime (045b).
- [x] **AC-7** — Each affected Completed PRD index carries an accurate reconciliation note, and no `Status:`
      overstates runtime reality.

## Related

- **Audit basis:** [`reports/2026-06-22-daemon-wiring-liveness-audit.md`](./reports/2026-06-22-daemon-wiring-liveness-audit.md)
- **Reopened sibling PRDs (own in-work folders):** PRD-019 harness-integrations · PRD-020 surfaces ·
  PRD-028 storage-read-consistency · PRD-033 asset-sync-substrate
- **Precedent wiring PRDs:** PRD-021 (runtime assembly) · PRD-022 (data-access wiring)
- **Composition root:** [`src/daemon/runtime/assemble.ts`](../../../../src/daemon/runtime/assemble.ts)
- Project-memory: "Completed ≠ live (deferred assembly)" · "Dogfood surfaces integration bugs"
