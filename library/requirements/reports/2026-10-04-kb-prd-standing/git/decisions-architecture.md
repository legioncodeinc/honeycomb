# Architecture decision log

Wave 2 git pass for architecture decisions. Branch `legion/kb-sotu-and-prd-lifecycle`. Date: 2026-10-04.
No ADR was written. No source or knowledge file was edited. No commit.

`library/requirements/reports/2026-10-04-kb-prd-standing/code/` does not exist. This log uses the wave 1 ADR report, the ADR index, `git log`, and the cited source and PRD lines.

Next free ADR number is 0012. This report does not assign it.

Candidate count: 0

An ADR is warranted only when deleting it would lose why the code is shaped that way. A row below is an existing ADR id, or `CANDIDATE`, or `REJECT`. `REJECT` means a PRD, an existing ADR, a knowledge page, or a source comment already holds that why.

Subjects below are the git subjects. Where git used a punctuation dash (U+2014), this file writes an ASCII hyphen.

## Summary

| Decision | Locking commit | Date | Subject | Record |
|---|---|---|---|---|
| Fleet root and `~/.apiary` | `5f43e8b5a27c27efa2a58b065bf651bd79e1dfc4` | 2026-07-04 | Implement PRD-072: apiary state-root migration (ADR-0003) | ADR-0008 |
| Local queue default | `750a25d25b32969cf32f6f20b543598e3fc7446a` | 2026-07-05 | Fix the memory pipeline: local-queue default + BoolFlag + observability + memory-formation health (#248) | ADR-0009 |
| Embeddings default-on | `d47bd025ee02d513e20666cb3630501bfa462292` | 2026-06-21 | feat(prd-025): semantic recall on by default (the <#> cosine path ships lit) | REJECT |
| Local ANN index | `e4e3d6625e342e63a1d18bd6338bab71cd65adb1` | 2026-07-10 | feat(recall): in-daemon local ANN recall index (PRD-078) (#283) | REJECT |
| Est. savings | `1d78736ee5a806a51c4ef84dc9689a2114328fea` | 2026-07-08 | docs: pivot "Est. savings" KPI to recall-weighted savings (IRD-278, ADR-0010) (#279) | ADR-0010 |
| Service label `com.legioncode.honeycomb` | `26e72f98642a2c3f1ed3e4c12be924e20228961c` | 2026-07-02 | feat(service): rename OS service units to the fleet scheme (decision #32) | REJECT |
| DeepLake transport stays in the daemon | `d4e83016c1137bc0de347435e8d856b891dfc19e` | 2026-06-17 | feat(prd-001): monorepo foundation - workspace, bundling, version sync | REJECT |

## Fleet root and ~/.apiary

Record: ADR-0008. Not a candidate.

The code lock is `5f43e8b5a27c27efa2a58b065bf651bd79e1dfc4`, 2026-07-04, subject `Implement PRD-072: apiary state-root migration (ADR-0003)`. It moves runtime state to `~/.apiary/honeycomb/`, adds the absolute-only fleet-root helper, and pins `APIARY_HOME` on the service unit.

The ADR text was locked the same day, before that implementation:

- `55be09a79491a3bfe32a43be10f166d9d161bb52`, 2026-07-04, `docs(adr): add new ADR for fleet directory ownership and neutral state root`
- `626cc70cdb0d6255cda5d67bd22ed272cc5acf8f`, 2026-07-04, `docs(adr): update ADR-0008 status to accepted and confirm decisions`

`626cc70` accepts the three resolutions: root name `~/.apiary`, `$XDG_STATE_HOME` only when explicitly set and absolute, and the registry compatibility window. ADR-0008 is the honeycomb mirror of superproject ADR-0003. Wave 1 marks it HOLDS (`architecture-adrs.md` ADR-0008 section). Deleting a new ADR would not add a why that 0008 lacks.

Later commits apply the same root. They do not replace it:

- `8a8efcfee784835dd159b2a259b64bff043b84b9`, 2026-07-05, `Fix fleet connectivity: live-reload tenancy/projects, clean APIARY_HOME, real-JWT tenancy, legacy scoping (#236)`
- `b224dfb2068d3b3df55bb2541d860d4ffcd5ae4c`, 2026-07-11, `fix(daemon): anchor the memory-pipeline local queue on the fleet state root (~/.apiary/honeycomb) (#285)`

Chain in code: `src/shared/fleet-root.ts:78-95`. Resolutions in `0008-fleet-directory-ownership-and-neutral-state-root.md:12-28`.

## Local queue default

Record: ADR-0009. Not a candidate. Do not write a second ADR for this.

The lock is `750a25d25b32969cf32f6f20b543598e3fc7446a`, 2026-07-05, subject `Fix the memory pipeline: local-queue default + BoolFlag + observability + memory-formation health (#248)`. That commit makes the local SQLite queue the default for an undeclared or `single_machine` topology, keeps `HONEYCOMB_LOCAL_QUEUE_ENABLED` as the explicit override, adds the shared-path guard, and adds ADR-0009 in the same change.

The why in the commit body is the one ADR-0009 records: the shared DeepLake `memory_jobs` append-only version scheme collides under read-after-write lag, so completed jobs re-lease forever and the pipeline forms zero memories. DeepLake stays the memory store.

The earlier queue commit is a different decision, already ADR-0006:

- `85b3877a4d049e37a383d2ec4ad87064b600d234`, 2026-06-29, `Reduce idle cost by routing jobs through the local queue (#186)`

That commit introduced the local queue as opt-in idle-cost control. ADR-0009 evolves it to default-on. Wave 1 marks 0009 HOLDS and says not to add another ADR (`architecture-adrs.md` ADR-0009 section and "Considered and not ADD").

## Embeddings default-on

Record: REJECT.

The lock is `d47bd025ee02d513e20666cb3630501bfa462292`, 2026-06-21, subject `feat(prd-025): semantic recall on by default (the <#> cosine path ships lit)`.

`git log -L` on `resolveEmbedClientOptions` shows that function changed only in this commit (and its introduction in `2d58546e4c51e56dc8d5cb92ee9bac489a265d3c`, 2026-06-17, which defaulted embeddings off). The live resolver is still the PRD-025 D-1 inversion: unset means enabled, and only an explicit `false` or `0` disables (`src/daemon/runtime/services/embed-client.ts:160-172`). PRD-025 states that decision at `prd-025-semantic-recall-default-index.md:54-56`. The PRD does not mention a vault key. A later search of that index finds no vault section.

A later commit adds a persisted override and keeps the same default:

- `d7b7212e0e2c721e93360eafabe05324c67d5cbc`, 2026-06-27, `feat(dashboard): perform CLI lifecycle actions from the dashboard`

`readBootEmbeddingsEnabled` is vault-first, then the env resolver, and a missing setting falls through to default-on (`src/daemon/runtime/assemble.ts:2376-2394`). The supervisor comment states the same precedence (`src/daemon/runtime/services/embed-supervisor.ts:144-148`). That is a settings surface on top of D-1. It does not replace D-1.

These later commits repair spawn and liveness. They do not edit `embed-client.ts`:

- `f473c452c61bc9f8a57812eb25a401af03113ca6`, 2026-07-05, `Fix the embed-daemon spawn path (embeddings never ran) + honest /health state (#242)`
- `27e34de7426b3d2d39bc74d5cd2edc620f2a386f`, 2026-07-12, `fix: embed daemon liveness probe, honest health states, recall fast-skip when not warm (#301)`

The log does not show a default-on decision that PRD-025 fails to hold. Wave 1 already rejected an embeddings ADR (`architecture-adrs.md` "Considered and not ADD").

## Local ANN index

Record: REJECT.

Wave 1 marked this HOLE / ADD and did not number it (`architecture-adrs.md` "HOLE" / "In-daemon local ANN index"). This git pass overturns that ADD. The why is already standing in a PRD and in a committed knowledge page, and the module header repeats it. Deleting a new ADR would not drop the reason.

The lock is `e4e3d6625e342e63a1d18bd6338bab71cd65adb1`, 2026-07-10, subject `feat(recall): in-daemon local ANN recall index (PRD-078) (#283)`. `git log -S DEFAULT_LOCAL_ANN_INDEX` returns only this commit. The commit body locks the shape PRD-078 already decided: in-RAM flat cosine, Deep Lake remains the store, `<#>` SQL is the fail-soft fallback, kill-switch `HONEYCOMB_LOCAL_ANN_INDEX` default on.

PRD-078 holds the architectural choices at `prd-078-local-ann-recall-index-index.md:63-70`:

- D-1 keeps Deep Lake as the durable store and rejects a backend migration for this change.
- D-2 is flat in-RAM cosine for v1, because Deep Lake has no index.
- D-3 preserves `<#>` ranking.
- D-4 keeps `<#>` SQL as the cold and disabled fallback.

The overview at `prd-078-local-ann-recall-index-index.md:13` records the measured fact: `CREATE INDEX ... USING vector` and `USING hnsw` are rejected, and `<#>` is a full-column scan. a-AC-5 at line 59 leaves the flag default to rollout. The rollout commit set it on. `DEFAULT_LOCAL_ANN_INDEX = true` is at `src/daemon/runtime/memories/amplification-config.ts:42-48`. The module header restates the same constraint at `src/daemon/runtime/memories/local-vector-index.ts:1-17`.

The knowledge page already carries that why, including default-on, at `library/knowledge/private/ai/retrieval.md:119-123`. `git show HEAD` of that file contains the same section. It was synced in `4ca4b8cdf10986548f9e9524101a069a60e6c783`, 2026-07-10, subject `docs(knowledge): sync recall KB for per-turn fast path + local ANN index (PRD-077, PRD-078; issues #282, #284)`. Measurements stay in `library/knowledge/private/storage/deeplake-recall-and-capture-findings-2026-07-10.md`, which the retrieval page links.

A later touch of the index module does not change the decision: `cd97668acc4cbed0e5207121baf1c9d289ef486b`, 2026-07-12, `fix: recall hits carry actionable memory identity + search/list corpus parity (ISS-006) (#307)`.

## Est. savings

Record: ADR-0010. A successor ADR is REJECT.

The decision commit is docs-only: `1d78736ee5a806a51c4ef84dc9689a2114328fea`, 2026-07-08, subject `docs: pivot "Est. savings" KPI to recall-weighted savings (IRD-278, ADR-0010) (#279)`. It adds ADR-0010 and renumbers the sessions-chunking draft to 0011. It does not change `fetchEstimatedSavings`.

The live proxy was introduced earlier: `5dd0f546b3437d40ed5c6c0469be8c2a63f44a7b`, 2026-06-22, subject `feat(dashboard): broken-first fixes - Turns, Est. savings, graph render, skill discovery (PRD-035 + PRD-036) (#65)`.

A later commit keeps that proxy and adds a second meter: `9bf4ce7d3470fa979c676aa91d48489a3fc0f436`, 2026-07-12, subject `feat: injected-token metering, live KPI, real ROI trend, partial net (#298)`. Its message says the `estimatedSavings` comment now calls the figure a corpus-mass proxy, and `injectedTokens` is the measured meter. That does not retire `fetchEstimatedSavings` or `buildEstimatedSavingsSql`. Wave 1 already found those functions live at `src/daemon/runtime/dashboard/api.ts:313-352` and said not to add a second savings ADR (`architecture-adrs.md` ADR-0010 section). The status-line mismatch (Accepted in the file, proxy still in the tree) is a revision of ADR-0010, not a new number.

Docs follow-up, still not an implementation: `142b2e023180087ed8686c2c1c438bc53837ff0d`, 2026-07-08, `docs(knowledge): forward-point Est. savings KPI docs to ADR-0010 (issue #280)`.

## Service label com.legioncode.honeycomb

Record: REJECT.

The lock is `26e72f98642a2c3f1ed3e4c12be924e20228961c`, 2026-07-02, subject `feat(service): rename OS service units to the fleet scheme (decision #32)`. `git log -S com.legioncode.honeycomb` on source returns this commit. The subject and the constants cite nectar decision #32.

That decision, signed off 2026-07-02, is row 32 of `nectar/library/requirements/PRD-DECISIONS-AND-DEFAULTS.md`: fleet-wide launchd `com.legioncode.<name>`, systemd `<name>.service`, schtasks `<name>`, and a best-effort legacy deregister on every register. Honeycomb's constants match it at `src/cli/daemon-service.ts:50-67`: `SERVICE_LABEL` is `com.legioncode.honeycomb`, `SERVICE_SYSTEMD_UNIT` is its own constant `honeycomb.service`, and the legacy names stay only so register can remove them.

Knowledge already states the live label and the legacy removal: `library/knowledge/private/architecture/daemon-surface.md:100` and `library/knowledge/private/operations/install-and-onboarding.md:102`. Deleting a honeycomb ADR would not lose the why. The signed record is the nectar decisions file, and the source comment points at it.

`c1cb6bf5674ca169728e79433bf035e0d3d1483c`, 2026-07-14, `feat(cli): standardize Honeycomb service interface (#316)`, edits the service module. The label string was not introduced there.

## DeepLake transport stays in the daemon

Record: REJECT.

The confinement decision is `d4e83016c1137bc0de347435e8d856b891dfc19e`, 2026-06-17, subject `feat(prd-001): monorepo foundation - workspace, bundling, version sync`. The commit body says the daemon is the sole home of the DeepLake path. PRD-001 states the same goal at `prd-001-monorepo-foundation-index.md:17` and AC-2 at line 40: the daemon bundle is the only artifact that opens DeepLake.

The client landed the same day: `4dcb2828ca6acb0d7178708f682fc599c4081141`, 2026-06-17, subject `feat(prd-002): DeepLake storage adapter - client, SQL-safety, healing, write-patterns, vector search`. `git log --follow` on `src/daemon/storage/transport.ts` has this single commit. The file was created under `src/daemon/storage/` and has not moved.

Standing copies of the why:

- `BUILD.md:29-32` (DeepLake access path lives only in `src/daemon`).
- `src/daemon/runtime/server.ts:13-16` (the daemon is the only DeepLake client; handlers use the injected client).
- The daemon-only invariant test arrives in the PRD-002 commit (`tests/daemon/storage/invariant.test.ts`).

A second backend stayed inside the daemon: `9fac3c3444b6abda7da0884df87e93ba221dd94c`, 2026-06-26, `feat(storage): add PgDeepLakeTransport direct self-hosted Postgres backend`, file `src/daemon/storage/pg-transport.ts`.

Two later imports do not move the transport out of the daemon. `0abf837f917d3ca3e4edc561c0bb12b4eedb412d`, 2026-06-21, `feat(prd-034): resilient live-test strategy - IRL-faithful gate + on-demand DeepLake stress harness (#62)`, imports the transport type from `src/eval/deeplake-stress.ts`. `src/daemon-client` imports SQL helpers, not `transport.ts`. Neither commit is a new confinement decision.

## Files read

- Plan Wave 2: `/home/marioaldayuz/.cursor/plans/kb_prd_standing_fleet_9354246d.plan.md`
- `library/knowledge/private/architecture/adr/README.md`
- `library/knowledge/private/architecture/adr/0008-fleet-directory-ownership-and-neutral-state-root.md`
- `library/knowledge/private/architecture/adr/0009-local-queue-as-default-deeplake-is-not-a-queue.md`
- `library/knowledge/private/architecture/adr/0010-recall-weighted-est-savings.md`
- `library/requirements/reports/2026-10-04-kb-prd-standing/knowledge/architecture-adrs.md`
- `library/requirements/completed/prd-025-semantic-recall-default/prd-025-semantic-recall-default-index.md`
- `library/requirements/in-work/prd-078-local-ann-recall-index/prd-078-local-ann-recall-index-index.md`
- `library/requirements/completed/prd-001-monorepo-foundation/prd-001-monorepo-foundation-index.md`
- `library/knowledge/private/ai/retrieval.md` (ANN section, including `git show HEAD`)
- `BUILD.md`, `src/daemon/runtime/server.ts`, `src/daemon/runtime/services/embed-client.ts`, `src/daemon/runtime/assemble.ts`, `src/daemon/runtime/services/embed-supervisor.ts`, `src/daemon/runtime/memories/local-vector-index.ts`, `src/daemon/runtime/memories/amplification-config.ts`, `src/cli/daemon-service.ts`
- Nectar decision #32: `/home/marioaldayuz/Desktop/development/active/nectar/library/requirements/PRD-DECISIONS-AND-DEFAULTS.md`
