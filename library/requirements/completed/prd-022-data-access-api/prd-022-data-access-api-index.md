# PRD-022: Data-Access API: wire the read/write surface the CLI, SDK, and MCP call

> **Status:** Completed
> **Priority:** P0
> **Effort:** XL
> **Schema changes:** None

---

## Overview

A real dogfood of the assembled daemon (PRD-021) against live DeepLake surfaced the gap PRD-022 closes: the daemon RUNS and CAPTURES end-to-end (a real hook turn to `/api/hooks/capture` to 201 to a real `sessions` row, proven live), and the live dashboard plus log work, but the DATA-ACCESS HTTP API that the CLI verbs, the SDK methods, and the MCP tools all call is still the PRD-004 scaffold: `POST /api/memories/recall` and `POST /api/memories` (remember) return `501 not_implemented`, and most data route groups (`/api/memories`, `/memory`, `/api/goals`, `/api/kpis`, `/api/sources`, `/api/secrets`, `/api/skills`, `/api/rules`) have no handler wired into `assembleDaemon`. So `honeycomb recall`, `honeycomb remember`, `client.recall()`, and the MCP `memory_search` tool all 501 against a real daemon. The recall ENGINE works (`src/daemon/runtime/recall/`, proven by the golden-path itest via direct SQL) and the write engine works (`src/daemon/runtime/pipeline/controlled-writes.ts`), they were just never wired to the HTTP routes. PRD-022 builds the data-access HTTP API by wiring these EXISTING engines to their routes, fires every data-API mount seam in the composition root, and proves it by dogfooding recall THROUGH the HTTP API (not around it). No new business logic, no new DeepLake schema (Schema changes: None), it is the data-surface twin of PRD-021's runtime assembly.

Concretely, PRD-021 proved the daemon assembles and the capture path runs, but it left the read/write surface unbuilt. Capture is one half of the memory loop (turns flow in); recall and the product-data reads and writes are the other half (turns and goals and skills flow back out), and that half answers to the data-access HTTP API. Every one of `recall`, `remember`, `memory_get`, `memory_list`, the `/memory/*` VFS browse, goals, KPIs, skills, rules, sources, and secrets is a thin client of a daemon HTTP route, and today those routes are either a 501 scaffold or simply never mounted by `assembleDaemon`. The engines those routes should call were each built and individually tested behind seams in PRDs 006, 007, 008, 012, 013, 015, 016, and the 003d goals and KPIs tables. PRD-022 is the single place where the data-access HTTP routes meet those existing engines and the read/write surface runs for the first time against live DeepLake. The acceptance bar is behavioral: a real captured turn is recalled THROUGH the `/api/memories/recall` HTTP route, on a real assembled daemon, by the CLI and the SDK and the MCP tool alike.

## Goals

- A mounted `/api/memories/*` API wiring the existing recall engine (`src/daemon/runtime/recall/`) and the existing write engine (`src/daemon/runtime/pipeline/controlled-writes.ts`) to their HTTP routes, so `recall` and `remember` stop returning 501 and return real data and real writes.
- A mounted `/memory/*` VFS browse API wiring the daemon-side reads (read, search, list, find) that the PRD-015 `DeepLakeFs` client, the pre-tool-use intercept, and the MCP browse trio all dispatch to, read-only, with writes on memory paths denied with guidance.
- The remaining product-data routes (`/api/goals`, `/api/kpis`, `/api/skills`, `/api/rules`, `/api/sources`, `/api/secrets`) wired to their existing engines, tenancy-scoped and value-safe, including wiring the already-built `mountSourcesApi` and secrets `api.ts` that ship unwired.
- Every data-API mount seam fired exactly once by `assembleDaemon`'s `assembleSeams()`, extending the PRD-021 a-AC-2 exactly-once invariant to the data surface.
- The two dogfood-found client bugs fixed: the loopback `DaemonClient` not stamping `x-honeycomb-session` for session-scoped verbs, and a Windows libuv teardown crash on CLI exit.
- A behavioral end-to-end proof: a real captured turn recalled THROUGH the `/api/memories/recall` HTTP path, by the CLI, the SDK, and the MCP `memory_search` tool, on a real assembled daemon against live DeepLake.

## Non-Goals

- Any new business logic. PRD-022 wires existing, individually-tested engines to their HTTP routes and adds none of its own.
- Any new DeepLake schema, table, column, or index. Schema changes: None. The engines and tables already exist.
- The team-mode `x-honeycomb-org` hardening follow-up. Local single-user mode is the first-class dogfood target; team and hybrid tenancy stay behind the existing auth and ship as a separate ticket.
- Turning embeddings on for semantic recall. The acceptance bar accepts the BM25 and ILIKE lexical fallback; wiring the embed daemon for semantic recall is its own follow-up.
- Weakening the thin-client invariant. The handlers are daemon-side; the CLI, SDK, and MCP stay thin clients of the loopback daemon's data-access routes.
- The `/v1` agent routes and `/api/ontology` data routes, unless the open question resolves them into scope; otherwise they are a fast-follow.

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-022a-data-access-api-memories`](./prd-022a-data-access-api-memories.md) | `mountMemoriesApi`: recall, remember, get, list, modify, forget wired to the existing engines. | Draft |
| [`prd-022b-data-access-api-vfs-browse`](./prd-022b-data-access-api-vfs-browse.md) | `/memory/*` VFS browse reads (cat, grep, ls, find) wired read-only, writes denied. | Draft |
| [`prd-022c-data-access-api-product-data`](./prd-022c-data-access-api-product-data.md) | `/api/goals`, `/api/kpis`, `/api/skills`, `/api/rules`, `/api/sources`, `/api/secrets` wired. | Draft |
| [`prd-022d-data-access-api-assembly-and-clients`](./prd-022d-data-access-api-assembly-and-clients.md) | Fire every data-API seam in `assembleSeams()`; fix the session-header and libuv client bugs. | Draft |
| [`prd-022e-data-access-api-dogfood-acceptance`](./prd-022e-data-access-api-dogfood-acceptance.md) | The behavioral proof: recall through the HTTP API by CLI, SDK, and MCP; live golden path; smoke. | Draft |

## Decisions

- Wiring-only. This PRD introduces no new business logic and no new DeepLake schema. The engines exist (PRD-006 controlled writes, PRD-007 recall, PRD-008 ontology reads, PRD-012 secrets, PRD-013 sources, PRD-015 VFS, PRD-016 skills, plus the PRD-003d goals and KPIs tables); PRD-022 wires them to their HTTP routes. It is the data-surface twin of PRD-021's runtime assembly.
- The composition root fires every data-API mount seam exactly once, after construction. This extends the PRD-021 a-AC-2 exactly-once invariant from the capture, dashboard, notifications, and prune seams to the full data-access surface.
- The thin-client invariant is preserved. The data-access handlers are daemon-side, inside `src/daemon/`; the CLI, SDK, and MCP stay thin clients of the loopback daemon's routes and never import the engines directly.
- Local single-user mode is the first-class dogfood target. It sidesteps the open team-mode `x-honeycomb-org` hardening follow-up, which stays a separate ticket. Team and hybrid run behind the existing auth.
- Lexical recall is sufficient for the acceptance bar. The recall engine's BM25 and ILIKE fallback proves the data-access route end-to-end without the embed daemon; embeddings-on semantic recall is a separate follow-up.
- First-real-run-finds-bugs is a known risk and a mandate. The PRD-021 dogfood found the workspace-partition bug, the 501 gap, and the session-header gap by actually running it; running the data surface for real will find more. The mitigation is the live recall-through-HTTP golden path plus structured logging, and discovered bugs route through security then quality before close-out.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a previously-captured turn, when `honeycomb recall "<term>"` runs, then it returns that turn through the real `/api/memories/recall` HTTP path (no 501, no 400) against live DeepLake. |
| AC-2 | Given a `remember`/store through `/api/memories`, when it runs, then it lands a row that is then recallable, and modify and forget require a reason and are audited. |
| AC-3 | Given the assembled daemon, when it is inspected, then every data route group the CLI, SDK, and MCP target (`/api/memories`, `/memory`, `/api/goals`, `/api/kpis`, `/api/sources`, `/api/secrets`, `/api/skills`, `/api/rules`) is implemented (no 501) and fired by `assembleDaemon`, tenancy-scoped and value-safe. |

## Data model changes

None. The data-access API mounts handlers that call the existing storage client and the existing engines. No table, column, or index is added or altered. Recall reads the existing `memory` and `sessions` tables; remember writes through the existing controlled-writes engine; goals, KPIs, skills, rules, sources, and secrets read and write existing tables. Schema changes: None.

## API changes

None that are new in contract. PRD-022 mounts data-access routes that were specified and built but never wired into the assembled daemon, and replaces the PRD-004 `501 not_implemented` scaffold bodies on `/api/memories/recall` and `/api/memories` with the real engine calls. The route groups it mounts are `/api/memories/*` (recall, remember, get, list, modify, forget), `/memory/*` (read, search, list, find), `/api/goals`, `/api/kpis`, `/api/skills`, `/api/rules`, `/api/sources`, and `/api/secrets`. No endpoint contract changes; this is the wiring that makes them answer.

## Open questions

- [ ] Should the one-shot CLI mint a per-invocation session id, or should `/api/memories` be a non-session group (the session-group requirement may be wrong for stateless data reads)?
- [ ] Embeddings on (semantic recall) versus the BM25 fallback for the acceptance bar: does PRD-022 require the embed daemon wired, or is lexical sufficient for the data-API proof (embeddings-on is its own follow-up)?
- [ ] The `/v1` agent routes and the `/api/ontology` data routes: in PRD-022 scope or a fast-follow?

## Related

- [System Overview](../../../knowledge/private/architecture/system-overview.md)
- [Daemon Surface](../../../knowledge/private/architecture/daemon-surface.md)
- [Request Lifecycle](../../../knowledge/private/architecture/request-lifecycle.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)
- [MCP and SDK](../../../knowledge/private/integrations/mcp-and-sdk.md)
- [Hook Lifecycle](../../../knowledge/private/integrations/hook-lifecycle.md)
- [CLI Command Architecture](../../../knowledge/private/operations/cli-command-architecture.md)
