# Wave 1b PRD standing: backlog 051-057

Shard: Wave 1b only. Read-only. Base examined in the working tree on `legion/kb-sotu-and-prd-lifecycle`. Source search skipped `node_modules`, `daemon/`, `bundle/`, `mcp/bundle/`, `harnesses/*/bundle/`, and `embeddings/embed-daemon.js`.

| PRD | Files read | Acceptance criteria | MET | UNMET | UNVERIFIABLE | Recommended bucket |
|---|---|---:|---:|---:|---:|---|
| 051 | 1 index | 0 | 0 | 0 | 0 | archive |
| 052 | 1 index | 0 | 0 | 0 | 0 | archive |
| 053 | index + 053a + 053b | 20 | 0 | 20 | 0 | backlog |
| 054 | 1 index | 0 | 0 | 0 | 0 | archive |
| 055 | 1 index | 0 | 0 | 0 | 0 | archive |
| 056 | index + 056a + 056b + 056c + qa placeholder | 17 | 0 | 17 | 0 | backlog |
| 057 | index + 057a + 057b + 057c + qa placeholder | 17 | 0 | 17 | 0 | backlog |
| Total | 15 markdown files | 54 | 0 | 54 | 0 | |

No QA report exists in any of these folders. `prd-056` and `prd-057` contain only `qa/.gitkeep` placeholders. `prd-051`, `prd-052`, `prd-053`, `prd-054`, and `prd-055` have no `qa/` directory.

Verdict rule used here: `MET` requires the criterion's behavior in source. `ABSENT` means a search of `src/`, `tests/`, `harnesses/*/src`, `mcp/src`, `sdk/`, and `embeddings/src` found no symbol that implements that criterion. Nearest files are cited so a later pass can tell lookalikes from this work.

---

## PRD-051 Repository Health and Knowledge Drift

Files:

- `library/requirements/backlog/prd-051-repository-health-and-knowledge-drift/prd-051-repository-health-and-knowledge-drift-index.md` (stub, 16 lines)
- No lettered children. No QA note.

Acceptance criteria in this folder: none. The index is a move stub. Status line at `prd-051-repository-health-and-knowledge-drift-index.md:3`: "MOVED (2026-07-12)". Canonical pointer at lines 4-5 and 15: Hive `prd-015-repository-health-and-knowledge-drift-index.md`. That Hive file exists and its own status line is still `Backlog` (`hive/library/requirements/backlog/prd-015-repository-health-and-knowledge-drift/prd-015-repository-health-and-knowledge-drift-index.md:5`). Hive's provenance line says daemon data-plane paths remain in honeycomb. This honeycomb folder does not restate those paths as acceptance criteria.

Honeycomb source has no repository-health or knowledge-drift engine. Searches for `repositoryHealth`, `knowledgeDrift`, `prd-to-knowledge`, and `health band` in `src/**/*.ts` returned no matches. `src/daemon/runtime/sources/contracts.ts:262` is a source-provider health snapshot (PRD-013), a different object.

Recommended bucket: **archive**. The honeycomb copy is withdrawn product ownership, not shipped work. Leave Hive PRD-015 in Hive's backlog. Do not mark this stub completed.

---

## PRD-052 Join Repository to Hive

Files:

- `library/requirements/backlog/prd-052-join-repository-to-hive/prd-052-join-repository-to-hive-index.md` (stub, 16 lines)
- No lettered children. No QA note.

Acceptance criteria in this folder: none. Status line at `prd-052-join-repository-to-hive-index.md:3`: "MOVED (2026-07-12)". Canonical pointer at lines 4-5 and 15: Hive `prd-016-join-repository-to-hive-index.md`. That Hive file exists and its status line is still `Backlog` (`hive/library/requirements/backlog/prd-016-join-repository-to-hive/prd-016-join-repository-to-hive-index.md:5`).

Honeycomb source has no join-repository scaffold under this name. Searches for `join repository` and `knowledge gap` in `src/**/*.ts` returned no matches.

Recommended bucket: **archive**. Same reason as PRD-051. The product PRD lives in Hive and is still backlog there.

---

## PRD-053 Coaching and Reminder Loop

Files:

- `library/requirements/backlog/prd-053-coaching-and-reminder-loop/prd-053-coaching-and-reminder-loop-index.md` (status `Backlog`, line 3)
- `prd-053a-coaching-and-reminder-loop-signal-to-nudge-engine.md` (status `Draft`, line 4)
- `prd-053b-coaching-and-reminder-loop-nudge-surface-and-dismissal.md` (status `Draft`, line 4)
- No QA note.

Shared evidence for every criterion below:

- `GET /coach/nudges` and `POST /coach/nudges/:id/dismiss`: ABSENT. No `coach` route in `src/`.
- Machine-local nudge-state for coaching: ABSENT.
- `src/dashboard/web/panels.tsx`, `primitives.tsx`, and `wire.ts`, named by 053b lines 48-49: ABSENT. The repo has no `.tsx` dashboard. The live dashboard is `src/dashboard/html.ts`, `src/dashboard/views.ts`, and `src/dashboard/dashboard.ts`.
- Repository Health page: ABSENT in honeycomb (owned by the Hive PRD-015 stub above).
- Lookalike, different PRD: `src/hooks/shared/user-prompt-recall.ts:64` defines `RECALL_REMINDER`, the PRD-076a empty-recall reminder. Header at `user-prompt-recall.ts:12` names PRD-076a. It is a prompt-injection throttle, with no Hive signal, no `/knowledge-stinger` prompt, and no dismiss endpoint.
- Existing notification drain, the surface 053 says it would reuse: `src/hooks/runtime.ts:103` (`GET /api/diagnostics/notifications`, PRD-020d). No coaching consumer is wired to it.

Recommended bucket: **backlog**. Every criterion is unmet and no child has left Draft. Stay out of in-work and completed. Stay out of archive: this folder is still the honeycomb-owned coaching PRD, and Hive 015/016 (its inputs) are themselves still backlog.

### Index AC-1

- Quote: "When a PRD/IRD moves to `completed/` and Hive PRD-015's PRD-to-knowledge gap signal flags it, a specific nudge appears suggesting `/knowledge-stinger`, naming the PRD and the affected docs/code, with a one-click copy of the relevant prompt."
- PRD: `library/requirements/backlog/prd-053-coaching-and-reminder-loop/prd-053-coaching-and-reminder-loop-index.md:59`
- Verdict: UNMET
- Evidence: ABSENT. No `/knowledge-stinger` nudge, no completed-folder watcher, no copy-prompt affordance in `src/` or `tests/`.

### Index AC-2

- Quote: "Every nudge is **evidence-backed**: it links to the exact Hive PRD-015 signal that produced it; a test asserts no nudge can fire without a corresponding live signal."
- PRD: `prd-053-coaching-and-reminder-loop-index.md:60`
- Verdict: UNMET
- Evidence: ABSENT. No coaching engine and no test naming this signal gate.

### Index AC-3

- Quote: "Nudges are **non-blocking and read-only**: surfacing or dismissing a nudge never blocks an action, never mutates the repo, and never runs a Stinger; a test asserts the working tree is unchanged across the nudge lifecycle."
- PRD: `prd-053-coaching-and-reminder-loop-index.md:61`
- Verdict: UNMET
- Evidence: ABSENT. No nudge lifecycle to assert against.

### Index AC-4

- Quote: "The coaching layer is **opt-out** and respects the product's existing do-not-disturb posture; when disabled, no nudge is computed or shown."
- PRD: `prd-053-coaching-and-reminder-loop-index.md:62`
- Verdict: UNMET
- Evidence: ABSENT. Search for `do-not-disturb` / `doNotDisturb` / `dnd` in `src/**/*.{ts,tsx}` returned no matches, and no coaching opt-out gate exists.

### Index AC-5

- Quote: "Nudges are **rate-limited and dismissal-aware**: a dismissed nudge does not reappear until its underlying condition materially changes; a test drives dismiss -> unchanged-signal -> assert-no-reappearance, then changed-signal -> assert-reappearance."
- PRD: `prd-053-coaching-and-reminder-loop-index.md:63`
- Verdict: UNMET
- Evidence: ABSENT. No dismiss store and no such test.

### Index AC-6

- Quote: "No nudge fires on a clean signal; a healthy repo shows zero nudges (the calm-by-default guarantee), asserted by a test."
- PRD: `prd-053-coaching-and-reminder-loop-index.md:64`
- Verdict: UNMET
- Evidence: ABSENT.

### Index AC-7

- Quote: "Nudges render on the Repository Health page and/or the existing dashboard notification surface, reusing existing UI; no new modal/notification framework is introduced."
- PRD: `prd-053-coaching-and-reminder-loop-index.md:65`
- Verdict: UNMET
- Evidence: ABSENT. Notification pipeline exists at `src/hooks/runtime.ts:103` and `src/notifications/` (PRD-020d). Nothing in that pipeline renders a coaching nudge.

### 053a a-AC-1

- Quote: "A PRD/IRD entering `completed/` that Hive PRD-015 flags as a knowledge gap produces exactly one post-ship `/knowledge-stinger` nudge, carrying the PRD name, affected docs, and the prompt payload."
- PRD: `prd-053a-coaching-and-reminder-loop-signal-to-nudge-engine.md:46`
- Verdict: UNMET
- Evidence: ABSENT.

### 053a a-AC-2

- Quote: "Every emitted nudge references the specific live Hive PRD-015 signal backing it; a test asserts the engine emits nothing when the backing signal is absent."
- PRD: `prd-053a-coaching-and-reminder-loop-signal-to-nudge-engine.md:47`
- Verdict: UNMET
- Evidence: ABSENT.

### 053a a-AC-3

- Quote: "The engine emits zero nudges for a clean repo (all signals healthy); asserted by a test."
- PRD: `prd-053a-coaching-and-reminder-loop-signal-to-nudge-engine.md:48`
- Verdict: UNMET
- Evidence: ABSENT.

### 053a a-AC-4

- Quote: "Rate-limiting holds: the same nudge type does not re-emit within its limit; a test drives repeated computation and asserts a single active nudge."
- PRD: `prd-053a-coaching-and-reminder-loop-signal-to-nudge-engine.md:49`
- Verdict: UNMET
- Evidence: ABSENT. The turn throttle at `src/hooks/shared/user-prompt-recall.ts:68` (`NUDGE_INTERVAL_TURNS = 5`) belongs to PRD-076a (`user-prompt-recall.ts:12`), and it limits recall reminders per session turn.

### 053a a-AC-5

- Quote: "Dismissal memory holds: after a dismissal recorded in nudge-state, the engine does not re-emit while the signal-state is unchanged, and does re-emit once the "materially changed" predicate is satisfied; a test drives both directions."
- PRD: `prd-053a-coaching-and-reminder-loop-signal-to-nudge-engine.md:50`
- Verdict: UNMET
- Evidence: ABSENT. No material-change predicate in `src/`.

### 053a a-AC-6

- Quote: "With coaching opted out / do-not-disturb on, the engine computes and emits nothing; asserted by a test."
- PRD: `prd-053a-coaching-and-reminder-loop-signal-to-nudge-engine.md:51`
- Verdict: UNMET
- Evidence: ABSENT.

### 053a a-AC-7

- Quote: "Nudge-state writes touch only the machine-local record, never the repository; a test asserts an unchanged working tree across emit + dismiss."
- PRD: `prd-053a-coaching-and-reminder-loop-signal-to-nudge-engine.md:52`
- Verdict: UNMET
- Evidence: ABSENT. No coaching nudge-state writer.

### 053b b-AC-1

- Quote: "Active nudges render on the Repository Health page (and/or the existing notification surface), scoped to the selected project, each showing its evidence and suggested action."
- PRD: `prd-053b-coaching-and-reminder-loop-nudge-surface-and-dismissal.md:39`
- Verdict: UNMET
- Evidence: ABSENT. Dashboard blocks in `src/dashboard/views.ts` cover KPIs, sessions, settings, codebase graph, rules, and skill-sync (`src/dashboard/dashboard.ts:14`). No nudge block.

### 053b b-AC-2

- Quote: "The flagship nudge offers a one-click copy of the `/knowledge-stinger` prompt; copying performs no repo write and runs nothing."
- PRD: `prd-053b-coaching-and-reminder-loop-nudge-surface-and-dismissal.md:40`
- Verdict: UNMET
- Evidence: ABSENT.

### 053b b-AC-3

- Quote: "Dismissing a nudge calls the dismiss endpoint, removes it from view immediately, and it does not reappear until 053a re-emits it on a material change; an end-to-end test drives this."
- PRD: `prd-053b-coaching-and-reminder-loop-nudge-surface-and-dismissal.md:41`
- Verdict: UNMET
- Evidence: ABSENT. No dismiss route and no end-to-end test.

### 053b b-AC-4

- Quote: "Nudges are non-blocking and inline (no blocking modal); a healthy repo with no active nudges renders an empty/quiet state."
- PRD: `prd-053b-coaching-and-reminder-loop-nudge-surface-and-dismissal.md:42`
- Verdict: UNMET
- Evidence: ABSENT.

### 053b b-AC-5

- Quote: "The surface reuses existing dashboard primitives; no new modal/notification framework is added."
- PRD: `prd-053b-coaching-and-reminder-loop-nudge-surface-and-dismissal.md:43`
- Verdict: UNMET
- Evidence: ABSENT as a coaching surface. The primitives the child names (`src/dashboard/web/panels.tsx`, `primitives.tsx`, `wire.ts` at lines 48-49 of this child) are themselves ABSENT. Current dashboard primitives live in `src/dashboard/views.ts`.

### 053b b-AC-6

- Quote: "Interacting with the surface (view, copy, dismiss) leaves the working tree unchanged; only machine-local nudge-state is written on dismiss."
- PRD: `prd-053b-coaching-and-reminder-loop-nudge-surface-and-dismissal.md:44`
- Verdict: UNMET
- Evidence: ABSENT.

---

## PRD-054 Fleet Observation, Control Plane and Read-Only Dashboard

Files:

- `library/requirements/backlog/prd-054-fleet-observation-control-plane/prd-054-fleet-observation-control-plane-index.md` (stub, 16 lines)
- No lettered children. No QA note.

Acceptance criteria in this folder: none. Status line at `prd-054-fleet-observation-control-plane-index.md:3`: "MOVED (2026-07-03 / confirmed 2026-07-12)". Canonical pointer at lines 4-5 and 15: Queen `prd-007-fleet-observation-control-plane-index.md`. That Queen file exists and its status line is still `Backlog` (`queen/library/requirements/backlog/prd-007-fleet-observation-control-plane/prd-007-fleet-observation-control-plane-index.md:8`).

Honeycomb names that look similar belong to other PRDs:

- `src/daemon/runtime/ontology/control-plane.ts:2` is the ontology control plane, header "PRD-008c".
- `src/daemon/runtime/sources/contracts.ts:262` is a source-provider health snapshot.

Searches for fleet presence, fleet observation, and enrollment in `src/**/*.ts` returned no fleet-dashboard implementation.

Recommended bucket: **archive**. Withdrawn from honeycomb. Queen PRD-007 remains Queen's backlog. Do not mark completed.

---

## PRD-055 Fleet Control, Enrollment, Identity and Mint/Sign Authority

Files:

- `library/requirements/backlog/prd-055-fleet-control-enrollment-and-mint-authority/prd-055-fleet-control-enrollment-and-mint-authority-index.md` (stub, 16 lines)
- No lettered children. No QA note.

Acceptance criteria in this folder: none. Status line at `prd-055-fleet-control-enrollment-and-mint-authority-index.md:3`: "MOVED (2026-07-03 / confirmed 2026-07-12)". Canonical pointer at lines 4-5 and 15: Queen `prd-008-fleet-control-enrollment-and-mint-authority-index.md`. That Queen file exists and its status line is still `Backlog` (`queen/library/requirements/backlog/prd-008-fleet-control-enrollment-and-mint-authority/prd-008-fleet-control-enrollment-and-mint-authority-index.md:8`).

Searches for `enrollment`, `mintAuthority`, and `fleet token` in `src/**/*.ts` returned no matches.

Recommended bucket: **archive**. Withdrawn from honeycomb. Queen PRD-008 remains Queen's backlog. Do not mark completed.

---

## PRD-056 On-Demand Skill Fetch

Files:

- `library/requirements/backlog/prd-056-on-demand-skill-fetch/prd-056-on-demand-skill-fetch-index.md` (status `Backlog`, line 3)
- `prd-056a-on-demand-skill-fetch-skill-catalog-metadata-sync.md` (status `Draft`, line 4)
- `prd-056b-on-demand-skill-fetch-lazy-body-fetch.md` (status `Draft`, line 4)
- `prd-056c-on-demand-skill-fetch-eager-lazy-mode-switch.md` (status `Draft`, line 4)
- `qa/.gitkeep` (placeholder sentence only; no QA report)

Shared evidence:

- `GET /api/skills/catalog`: ABSENT.
- `GET /api/skills/:author/:name/body`: ABSENT.
- `skillMode` (`eager` | `lazy` | `auto`): ABSENT. `SkillifyConfig` at `src/daemon-client/skillify/config.ts:51-58` has `scope`, `team`, and `install` only. `RawConfigFile` at lines 84-88 has the same three fields.
- Session start always posts the eager pull. `src/hooks/shared/session-start-seams.ts:67` sets `SKILLS_PULL_ENDPOINT = "/api/skills/pull"`. `createSessionStartSeams` calls it from `autoPullSkills` at lines 133-136, with an env kill switch at line 135 and no mode branch.
- Eager pull route: `src/daemon/runtime/skillify/propagation-api.ts:275` (`POST /api/skills/pull`). Registered verbs on that module are POST only (`propagation-api.ts:232`, `:275`, `:278`, `:282`, `:290`, `:307`). Comment at lines 217-218 says this module does not own `GET /api/skills`.
- Existing org read: `mountSkillsReadApi` at `src/daemon/runtime/product/api.ts:281-300` serves `GET /` on the skills group. `fetchSkills` at lines 226-256 projects `id`, `name`, `scope`, `visibility`, `project_id`, promotion columns, and `version` (column list at line 242). That projection omits `author`, `description`, `triggerText`, and `body`. It is the PRD-022 / PRD-049c read, and it is a different contract from the Level-1 catalog in 056a.
- Highest-version body read used by eager pull: `buildSelectNewerSql` at `src/daemon/runtime/skillify/publish-endpoint.ts:112-119` selects `name`, `author`, `version`, and `body`. `selectNewerForOrgUsers` polls at lines 85-100 (`RESOLVE_POLLS`). That is the eager pull's convergent read of every newer skill body, which is the behavior lazy mode is specified to avoid.
- Tests: no matches for `skillMode`, `skills/catalog`, or a lazy body route under `tests/`.

Recommended bucket: **backlog**. The lazy catalog, single-body fetch, and mode switch are absent. The eager auto-pull that 056c wants to preserve is already shipped under PRD-016c / PRD-045g. That baseline is a reason to keep 056 unstarted in backlog, and it is not an implementation of 056.

### Index AC-1

- Quote: "Given lazy mode, when a session starts, then only skill metadata (no bodies) is synced into the catalog, and no bodies are written to disk up front."
- PRD: `prd-056-on-demand-skill-fetch-index.md:49`
- Verdict: UNMET
- Evidence: ABSENT. Session start writes bodies through `POST /api/skills/pull` (`session-start-seams.ts:133-136`, `propagation-api.ts:188-206`).

### Index AC-2

- Quote: "Given a skill triggers in lazy mode, when its body is needed, then exactly that one body is fetched at its highest version, with poll-until-converged read discipline."
- PRD: `prd-056-on-demand-skill-fetch-index.md:50`
- Verdict: UNMET
- Evidence: ABSENT as a single-skill lazy fetch. Poll-until-converged exists for the all-skills eager select at `publish-endpoint.ts:85-100`, and that select returns every skill's `body` (`publish-endpoint.ts:119`).

### Index AC-3

- Quote: "Given eager mode (default), when a session starts, then behaviour is identical to today's auto-pull (no regression)."
- PRD: `prd-056-on-demand-skill-fetch-index.md:51`
- Verdict: UNMET
- Evidence: `skillMode` is ABSENT (`config.ts:51-58`). Today's session start does call auto-pull (`session-start-seams.ts:133-136`). That call is the pre-056 baseline (comment at `session-start-seams.ts:15` names PRD-045g). The eager-mode branch this criterion names was never added.

### Index AC-4

- Quote: "Given a workspace catalog larger than the configured threshold, when mode is auto, then it flips to lazy and logs the switch."
- PRD: `prd-056-on-demand-skill-fetch-index.md:52`
- Verdict: UNMET
- Evidence: ABSENT. No `auto` mode, no threshold, no switch log.

### Index AC-5

- Quote: "Given a body fetch in lazy mode, when scope is resolved, then it stays inside the caller's org partition exactly as the existing skills read does."
- PRD: `prd-056-on-demand-skill-fetch-index.md:53`
- Verdict: UNMET
- Evidence: ABSENT. The lazy body route does not exist. Org scope on the existing read is `resolveScopeOrLocalDefault` inside `mountSkillsReadApi` (`product/api.ts:290-298`).

### 056a AC-056a.1.1

- Quote: "Given lazy mode, when the catalog syncs, then rows contain `name`/`author`/`description`/`triggerText` and never `body`."
- PRD: `prd-056a-on-demand-skill-fetch-skill-catalog-metadata-sync.md:31`
- Verdict: UNMET
- Evidence: ABSENT. `fetchSkills` (`product/api.ts:242-256`) returns neither `author`/`description`/`triggerText` nor `body`. Publish stores `triggerText` (`propagation-api.ts:110`, `skills-write.ts:192`) and the eager select returns `body` (`publish-endpoint.ts:119`). No metadata-only catalog route projects the four fields.

### 056a AC-056a.1.2

- Quote: "Given a skill with multiple versions, when the catalog lists it, then only the highest-version metadata appears."
- PRD: `prd-056a-on-demand-skill-fetch-skill-catalog-metadata-sync.md:32`
- Verdict: UNMET
- Evidence: ABSENT for the catalog. Highest-version selection exists for other reads: `buildHighestVersionSql` (`product/api.ts:186-190`) and `buildSelectNewerSql` (`publish-endpoint.ts:112-119`). Neither is a metadata catalog endpoint.

### 056a AC-056a.2.1

- Quote: "Given a caller in org X, when the catalog is read, then only org-X skills appear, via the same scope resolution as `GET /api/skills`."
- PRD: `prd-056a-on-demand-skill-fetch-skill-catalog-metadata-sync.md:36`
- Verdict: UNMET
- Evidence: ABSENT. Catalog route missing. Existing scope resolution for `GET /api/skills` is `product/api.ts:290`.

### 056a AC-056a.2.2

- Quote: "Given the catalog read, when measured, then payload size is bounded by metadata, not body size."
- PRD: `prd-056a-on-demand-skill-fetch-skill-catalog-metadata-sync.md:37`
- Verdict: UNMET
- Evidence: ABSENT. No catalog payload to measure. The eager select includes `body` (`publish-endpoint.ts:119`).

### 056b AC-056b.1.1

- Quote: "Given a triggered skill in lazy mode, when its body is fetched, then exactly that one body returns at its highest version, no other bodies."
- PRD: `prd-056b-on-demand-skill-fetch-lazy-body-fetch.md:32`
- Verdict: UNMET
- Evidence: ABSENT. `selectNewerForOrgUsers` returns every highest-version skill, each with `body` (`publish-endpoint.ts:85-100` and `:119`).

### 056b AC-056b.1.2

- Quote: "Given an untriggered skill, when the session ends, then its body was never fetched and cost zero body tokens."
- PRD: `prd-056b-on-demand-skill-fetch-lazy-body-fetch.md:33`
- Verdict: UNMET
- Evidence: ABSENT. Session start pulls all newer bodies (`session-start-seams.ts:133-136`, `propagation-api.ts:179-182`).

### 056b AC-056b.2.1

- Quote: "Given a body fetch, when scope resolves, then it stays inside the caller's org partition, identical to the existing skills read."
- PRD: `prd-056b-on-demand-skill-fetch-lazy-body-fetch.md:37`
- Verdict: UNMET
- Evidence: ABSENT. No single-skill body route. Existing skills read scope is `product/api.ts:290-298`.

### 056b AC-056b.2.2

- Quote: "Given the backend flaps a stale segment, when the body is fetched, then the read polls until converged rather than trusting a single immediate read."
- PRD: `prd-056b-on-demand-skill-fetch-lazy-body-fetch.md:38`
- Verdict: UNMET
- Evidence: ABSENT on a lazy body route. The eager select polls at `publish-endpoint.ts:89-99`.

### 056c AC-056c.1.1

- Quote: "Given no config (or `skillMode: eager`), when a session starts, then behaviour is byte-for-byte today's auto-pull (no regression)."
- PRD: `prd-056c-on-demand-skill-fetch-eager-lazy-mode-switch.md:31`
- Verdict: UNMET
- Evidence: `skillMode` is ABSENT (`config.ts:51-58`). A missing config file resolves to `DEFAULT_CONFIG` (`config.ts:60-64`, read at `config.ts:105-111`), which has no mode field. Session start then runs today's pull (`session-start-seams.ts:133-136`). The `skillMode: eager` arm and the regression test named in this child's test plan (`prd-056c` line 58) are absent.

### 056c AC-056c.2.1

- Quote: "Given `skillMode: lazy`, when a session starts, then only the metadata catalog syncs and bodies are fetched on trigger."
- PRD: `prd-056c-on-demand-skill-fetch-eager-lazy-mode-switch.md:35`
- Verdict: UNMET
- Evidence: ABSENT. `autoPullSkills` has no lazy branch (`session-start-seams.ts:133-136`).

### 056c AC-056c.2.2

- Quote: "Given `skillMode: auto` and a catalog larger than the threshold, when a session starts, then it runs lazy and logs the switch with the catalog size and threshold."
- PRD: `prd-056c-on-demand-skill-fetch-eager-lazy-mode-switch.md:36`
- Verdict: UNMET
- Evidence: ABSENT.

### 056c AC-056c.2.3

- Quote: "Given `skillMode: auto` and a small catalog, when a session starts, then it runs eager."
- PRD: `prd-056c-on-demand-skill-fetch-eager-lazy-mode-switch.md:37`
- Verdict: UNMET
- Evidence: ABSENT. There is no `auto` mode. Session start runs the eager pull unconditionally aside from the kill switch at `session-start-seams.ts:135`.

---

## PRD-057 Memory Graph to Obsidian Vault

Files:

- `library/requirements/backlog/prd-057-memory-graph-obsidian-vault/prd-057-memory-graph-obsidian-vault-index.md` (status `Backlog`, line 3)
- `prd-057a-memory-graph-obsidian-vault-markdown-export.md` (status `Draft`, line 4)
- `prd-057b-memory-graph-obsidian-vault-open-in-obsidian.md` (status `Draft`, line 4)
- `prd-057c-memory-graph-obsidian-vault-plugins-and-sync.md` (status `Draft (exploratory - mostly open questions, NOT v1 scope)`, line 4). No acceptance-criteria section. Open questions only (lines 46-61).
- `qa/.gitkeep` (placeholder sentence only; no QA report)

Shared evidence:

- `ontologyToVault`, `writeVaultAtomic`, `mountVaultApi`, `POST /api/vault/export`, `honeycomb vault export`: ABSENT in `src/` and `tests/`.
- `src/cli/vault.ts`, named at `prd-057a` line 130: ABSENT.
- CLI verb table `src/commands/contracts.ts:107-236` has `graph` (line 158) and `ontology` (line 153) and `pollinate` (line 121). It has no `vault` verb.
- `src/dashboard/web/pages/graph.tsx` and `build-graph-button.tsx`, named at `prd-057b` lines 80-83: ABSENT. No `.tsx` files in the repo. Dashboard graph view is the codebase canvas in `src/dashboard/views.ts:125-137`, empty copy `GRAPH_BUILD_PROMPT` at `views.ts:57` ("Run `honeycomb graph build` to build the codebase graph.").
- `dangerouslySetInnerHTML`: ABSENT in `src/`.
- Memory graph read that 057a says it would consume: `fetchMemoryGraphView` at `src/daemon/runtime/dashboard/api.ts:561`. Empty graph returns `{ built: false, nodes: [], edges: [] }` at lines 579-581. Route `GET /api/diagnostics/memory-graph` at lines 1388-1399. This is PRD-041b (comment at line 1388). It returns a JSON view. It writes no vault.
- Obsidian code that already exists is the inbound source provider, PRD-013c: `src/daemon/runtime/sources/providers/obsidian.ts:1-11`. It reads an external vault into artifacts. It does not export the memory graph.
- `src/daemon/runtime/vault/catalog.ts:1-6` is the PRD-032a provider/model catalog. It is unrelated to an Obsidian directory.
- The exact empty-state sentence "no memory graph yet - run `honeycomb pollinate trigger --compact`" is ABSENT as a vault-export response. `honeycomb pollinate trigger --compact` exists as the compaction CLI (`src/cli/pollinate.ts:153` and `src/commands/pollinate.ts:26`).

057c adds no acceptance criteria. Its open questions stay open. The folder should move only with the parent.

Recommended bucket: **backlog**. Export, deep link, and reconciliation are absent. The memory-graph JSON read (PRD-041b) and the Obsidian ingest provider (PRD-013c) are inputs and lookalikes, and they do not satisfy 057. 057c is exploratory and has nothing to mark completed on its own.

### Index AC-1

- Quote: "Given a populated memory graph, when the user runs the export, then a valid Obsidian vault exists at the canonical per-scope path with one Markdown note per entity and `[[wikilinks]]` between related entities, openable in stock Obsidian with no plugin."
- PRD: `prd-057-memory-graph-obsidian-vault-index.md:73`
- Verdict: UNMET
- Evidence: ABSENT. No exporter. `fetchMemoryGraphView` (`dashboard/api.ts:561-596`) returns nodes and edges as JSON.

### Index AC-2

- Quote: "Given a vault has been exported, when the user clicks "Open in Obsidian" on the dashboard, then Obsidian launches focused on that vault (or shows the honest fallback when Obsidian is not installed/registered)."
- PRD: `prd-057-memory-graph-obsidian-vault-index.md:74`
- Verdict: UNMET
- Evidence: ABSENT. No "Open in Obsidian" control in `src/dashboard/`. No `obsidian://` URI builder in `src/`.

### Index AC-3

- Quote: "Given an empty memory graph (`built:false`), when the user attempts to export, then the surface shows the honest "no memory graph yet — run `honeycomb pollinate trigger --compact`" state and writes no vault, never a faked one."
- PRD: `prd-057-memory-graph-obsidian-vault-index.md:75`
- Verdict: UNMET
- Evidence: ABSENT as an export path. `built: false` on an empty entity read is `dashboard/api.ts:579-581`. That response has no pollinate sentence and writes no files. The dashboard empty copy that does exist is the codebase-graph prompt at `src/dashboard/views.ts:57`.

### Index AC-4

- Quote: "Given untrusted entity names/text (path separators, `]]`, frontmatter-breaking chars), when the vault is written, then filenames are sanitized (no traversal), wikilinks/frontmatter are escaped, and no secret/token appears in any file."
- PRD: `prd-057-memory-graph-obsidian-vault-index.md:76`
- Verdict: UNMET
- Evidence: ABSENT. No vault filename sanitizer and no vault secret scan. `fetchMemoryGraphView`'s comment at `dashboard/api.ts:558-559` says the JSON labels are graph text rendered as React text; that is the in-app graph, and the React page it names is not in this tree.

### Index AC-5

- Quote: "Given the export runs twice, then it is idempotent into the canonical dir (a re-export reflects the current graph; stale notes for deleted entities are removed or tombstoned per 057a's reconciliation rule)."
- PRD: `prd-057-memory-graph-obsidian-vault-index.md:77`
- Verdict: UNMET
- Evidence: ABSENT. No canonical `~/.honeycomb/obsidian/<scope-key>/` writer.

### 057a a-AC-1

- Quote: "The pure mapper turns a fixture ontology (N entities, M dependencies) into N entity notes + a Home note, with every dependency rendered as a `[[wikilink]]` under its relation heading. Unit-asserted with no filesystem."
- PRD: `prd-057a-memory-graph-obsidian-vault-markdown-export.md:106`
- Verdict: UNMET
- Evidence: ABSENT. No `ontologyToVault` and no unit test. Anticipated at `prd-057a` lines 120-121.

### 057a a-AC-2

- Quote: "Writing the vault produces a directory openable in stock Obsidian: the graph view shows the entities connected by the wikilinks; no plugin is needed for graph/backlinks/search."
- PRD: `prd-057a-memory-graph-obsidian-vault-markdown-export.md:107`
- Verdict: UNMET
- Evidence: ABSENT. No vault directory writer. Stock Obsidian behavior was not runnable because the writer is absent.

### 057a a-AC-3

- Quote: "A `built:false` (empty) graph writes NO vault and returns the honest "no memory graph yet — run `honeycomb pollinate trigger --compact`" message (parity with the in-app empty state)."
- PRD: `prd-057a-memory-graph-obsidian-vault-markdown-export.md:108`
- Verdict: UNMET
- Evidence: ABSENT on the export API. Empty memory graph JSON is `dashboard/api.ts:579-581`. The pollinate command string is help text at `src/cli/pollinate.ts:153`, and it is the compaction verb.

### 057a a-AC-4

- Quote: "Entity names are sanitized to safe single-segment filenames (no `/ \\ .. : *` traversal/illegal chars); a name collision after sanitization is disambiguated by an id suffix; the original name is preserved in `aliases:` so wikilinks still resolve."
- PRD: `prd-057a-memory-graph-obsidian-vault-markdown-export.md:109`
- Verdict: UNMET
- Evidence: ABSENT.

### 057a a-AC-5

- Quote: "Untrusted entity text cannot break the file: frontmatter values are YAML-escaped/quoted, wikilink targets with `]]`/`[[`/`\\|` are escaped or aliased, and a scan of the output contains no secret/token (reuse the dashboard no-secret guard)."
- PRD: `prd-057a-memory-graph-obsidian-vault-markdown-export.md:110`
- Verdict: UNMET
- Evidence: ABSENT. No vault renderer applying that escape or scan.

### 057a a-AC-6

- Quote: "Re-exporting reconciles: notes for entities no longer in the graph are removed (or moved to an `_archive/`), so a stale note never lingers. The op is idempotent for an unchanged graph (no spurious diffs)."
- PRD: `prd-057a-memory-graph-obsidian-vault-markdown-export.md:111`
- Verdict: UNMET
- Evidence: ABSENT.

### 057a a-AC-7

- Quote: "`honeycomb vault export` (CLI) and `POST /api/vault/export` (daemon) both run the writer and report the vault root path + counts (`{ vaultPath, entityCount, edgeCount }`); the daemon writes daemon-side only (local FS), never the client."
- PRD: `prd-057a-memory-graph-obsidian-vault-markdown-export.md:112`
- Verdict: UNMET
- Evidence: ABSENT. No `vault` entry in `src/commands/contracts.ts:107-236`. No `/api/vault/export` handler under `src/daemon/runtime/`.

### 057b b-AC-1

- Quote: "Clicking "Open in Obsidian" calls `POST /api/vault/export` exactly once, then navigates to a correctly URI-encoded `obsidian://open?path=…/Home.md`; double-clicks are guarded (one export)."
- PRD: `prd-057b-memory-graph-obsidian-vault-open-in-obsidian.md:72`
- Verdict: UNMET
- Evidence: ABSENT. No button, no `exportVault` wire helper, no `obsidian://open` builder.

### 057b b-AC-2

- Quote: "When the memory graph is empty, the button is replaced by the honest "no memory graph yet — run `honeycomb pollinate trigger --compact`" state (no export, no dead link) — parity with 057a a-AC-3."
- PRD: `prd-057b-memory-graph-obsidian-vault-open-in-obsidian.md:73`
- Verdict: UNMET
- Evidence: ABSENT. See a-AC-3. Dashboard empty graph copy is `src/dashboard/views.ts:57`.

### 057b b-AC-3

- Quote: "First-run / failure path shows the exact canonical vault path with a copy affordance and a one-line "Open folder as vault in Obsidian once" instruction; it never leaves a silent dead button."
- PRD: `prd-057b-memory-graph-obsidian-vault-open-in-obsidian.md:74`
- Verdict: UNMET
- Evidence: ABSENT.

### 057b b-AC-4

- Quote: "The `obsidian://` URI contains only a local filesystem path — no token, org, workspace, or header — and the page renders the path as React text (XSS-safe), never `dangerouslySetInnerHTML`."
- PRD: `prd-057b-memory-graph-obsidian-vault-open-in-obsidian.md:75`
- Verdict: UNMET
- Evidence: ABSENT. No `obsidian://` URI is built. `dangerouslySetInnerHTML` is also absent, because there is no React page. That absence is the missing page, and it is not a satisfied safety control for this button.

### 057b b-AC-5

- Quote: "The action degrades safely when the daemon is down (the shell's existing daemon-down swap) and when the export returns `builtFalse` (shows b-AC-2 state)."
- PRD: `prd-057b-memory-graph-obsidian-vault-open-in-obsidian.md:76`
- Verdict: UNMET
- Evidence: ABSENT. No export client to degrade. `builtFalse` does not appear in `src/`. The memory-graph field that does exist is `built: false` at `dashboard/api.ts:581`.

### 057c

No acceptance criteria. Status at `prd-057c-memory-graph-obsidian-vault-plugins-and-sync.md:4` says the child is exploratory and outside v1. Plugin menu (lines 24-32) and the pollinate-convergence watcher (lines 36-44) have no matching exporter or watcher in `src/daemon/runtime/pollinating/runner.ts` (that runner applies ontology mutations; a search for `vault` under `src/daemon/runtime` found only `src/daemon/runtime/vault/catalog.ts`, the provider catalog).

Verdict for the child: no criteria to score. Leave it in backlog with PRD-057.

---

## Bucket summary for the writer wave

| PRD | Bucket | Why |
|---|---|---|
| 051 | archive | Honeycomb stub only. Product PRD is Hive PRD-015, still Backlog. Zero criteria here. Signal engine absent in honeycomb `src/`. |
| 052 | archive | Honeycomb stub only. Product PRD is Hive PRD-016, still Backlog. Zero criteria here. |
| 053 | backlog | 20/20 criteria UNMET. Children still Draft. Depends on Hive 015/016. |
| 054 | archive | Honeycomb stub only. Product PRD is Queen PRD-007, still Backlog. Ontology control plane in `src/` is PRD-008c. |
| 055 | archive | Honeycomb stub only. Product PRD is Queen PRD-008, still Backlog. Enrollment/mint code absent. |
| 056 | backlog | 17/17 criteria UNMET. Eager auto-pull is pre-existing PRD-016c/045g. Lazy catalog, body route, and `skillMode` are absent. |
| 057 | backlog | 17/17 criteria UNMET. 057c has no criteria. Memory-graph JSON is PRD-041b. Obsidian ingest is PRD-013c. Vault export and Open in Obsidian are absent. |

Do not move any of these to `completed/` or `in-work/` on this evidence.
