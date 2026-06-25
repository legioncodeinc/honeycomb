# Execution Ledger — PRD-049 + PRD-050

> Single source of truth for the-smoker run. Status values: OPEN / IN PROGRESS / DONE / VERIFIED / BLOCKED.
> Created 2026-06-25. Branch: `legion/compassionate-darwin-eccb7c`.

## Sequencing (per operator directive)

1. **Wave 1 — 050a + 050c + 050e** (installer, referral login, telemetry). Zero coupling to 049.
2. **Wave 2 — 050b + 050d** (pre-auth dashboard two-phase + Hivemind migration). Nav shell built scope-agnostic.
3. **Wave 3 — 049a** (scope-resolution foundation). Swaps in behind the nav seam from Wave 2.
4. **Wave 4 — 049b + 049c** (memory + skill isolation; consume resolved project_id).
5. **Wave 5 — 049d then 049e** (CLI switchers, then dashboard scope switcher into 050b nav shell).

Shared substrate (build early, Wave 1): `~/.deeplake/onboarding.json` state file + `esbuild` build-time `define`s (`__HONEYCOMB_REF_DEFAULT__`, `__HONEYCOMB_POSTHOG_KEY__`, `__HONEYCOMB_POSTHOG_HOST__`) + `src/shared/globals.d.ts` ambient decls. Consumed by 050a/050c/050e.
> **SUBSTRATE: DONE (2026-06-25)** — `src/daemon/runtime/onboarding/onboarding-store.ts` (+ index barrel), esbuild defines folded into VERSION_DEFINE, globals.d.ts decls, 16-case test suite. `npm run ci` green at the SUBSTRATE snapshot (2997 tests — before the 050a-e/049 waves landed; the authoritative close-out snapshot is the 3110-test run in the roll-up below). Locked exports: `OnboardingState`, `TelemetryEventName`, `TelemetrySentRecord`, `loadOnboarding`/`saveOnboarding`/`getOrCreateInstallId`/`markReported`/`isReported`/`appendSent`. Import via `src/daemon/runtime/onboarding/index.js`.

### Resolved operator decisions
- D1: fnm + pinned Node LTS; scripts in-repo `scripts/install/`; interim host = repo raw/Pages URL; vanity domain + checksum = BLOCKED polish (non-gating).
- D2: dual-send `X-Honeycomb-Referrer` (new) + `X-Hivemind-Referrer` (recognized now); backend recognition of new header = external item (old header carries attribution meanwhile).
- D3: Path A = assume NO → silent-adopt valid creds via `GET /me`; 050e measures upgraders.
- D4: local `~/.deeplake/projects.json` cache over server `projects` table (cross-device identity via git-remote signal in server registry).
- D5 (RESOLVED 2026-06-25): leave free-text `project` values, resolve to inbox on read (non-destructive — no bulk migration).
- D6 (049c promotion): support BOTH explicit flags — promote-to-my-other-projects (this user) AND promote-workspace-wide (teammates); each provenance-recorded, no implicit set.
- D7 (049c project_key): add `project_id` additively; keep `project_key` as legacy alias resolving through the registry (no skill-row rewrite).
- D8 (049b no-cwd): recall falls back to inbox + workspace-global with a VISIBLE warning; capture still lands in inbox (never dropped).

---

## Wave 1 — 050a / 050c / 050e

### 050a — One-Command Bootstrap Installer
> **STATUS: all ACs DONE (2026-06-25), CI-green @3027. Pending VERIFIED in 050-module close-out.** Files: `src/commands/install.ts`, `scripts/install/{install.sh,install.ps1}`, contracts/dispatch/index wiring, `tests/commands/install.test.ts` (21 tests). Pinned LTS = Node 22 (one place per script). BLOCKED non-gating: vanity domain `get.honeycomb.*` + checksum page (interim host = repo raw URL).
| ID | Criterion | Status | Bee |
|---|---|---|---|
| a-AC-1 | Clean machine (no Node/npm): one command installs Node/npm + embedding deps + `@legioncodeinc/honeycomb` global, starts daemon, opens dashboard — exit 0, readable log. | OPEN | ci-release |
| a-AC-2 | Idempotent: second run with all present starts nothing new (no double-bind 3850), re-opens dashboard. | OPEN | ci-release |
| a-AC-3 | Node install needs elevation it can't get → prints exact copy-paste cmd, exits non-zero, one-line explanation, no raw dump. | OPEN | ci-release |
| a-AC-4 | Dashboard opened only after `/health` answers; daemon never binds in budget → "daemon didn't start" + retry, exit non-zero. | OPEN | ci-release |
| a-AC-5 | Both entrypoints exist & equivalent: POSIX `install.sh` (`curl\|sh`) + Windows `install.ps1` (`irm\|iex`); each writes onboarding state "installed". | OPEN | ci-release |
| a-AC-6 | `honeycomb.local` attempted but never required; unresolved → loopback URL opened, run still succeeds. | OPEN | ci-release |

### 050c — Referral-Attributed Login
> **STATUS: all ACs DONE (2026-06-25), CI-green. Pending VERIFIED.** Dual headers `X-Honeycomb-Referrer`+`X-Hivemind-Referrer`, trim-and-omit on empty. Files: `deeplake-issuer.ts`, `auth/index.ts`, `assemble.ts`, `dashboard/setup-login.ts` (new `POST /setup/login`, loopback+local-mode-gated), `tests/.../referral-attribution.test.ts`, `tests/.../setup-login.test.ts`. Contract documented for 050b. External item: Activeloop backend recognition of new header (old header attributes meanwhile).
| ID | Criterion | Status | Bee |
|---|---|---|---|
| c-AC-1 | `POST /auth/device/code` from Honeycomb install carries `X-Hivemind-Referrer: mario` by default; unit test asserts header+default with no `--ref`. | OPEN | typescript-node |
| c-AC-2 | Explicit `--ref <code>` overrides default; empty/whitespace ref omits header entirely (trim-and-omit). | OPEN | typescript-node |
| c-AC-3 | "First time setup" begins flow; dashboard renders `user_code` + verification URI; DeepLake verify/create-account page opens (https-only). | OPEN | typescript-node |
| c-AC-4 | Token never rendered/logged/in-URL — only `user_code`+URI reach page; test asserts no token in `/setup/login` response or any log line. | OPEN | typescript-node |
| c-AC-5 | On approval, mints+persists shared `~/.deeplake/credentials.json` (0600) via existing `persistFromToken`, unchanged but for added header. | OPEN | typescript-node |
| c-AC-6 | Referral header rides only on device-code request, not `/me`, `/organizations`, mint, or any data-plane call. | OPEN | typescript-node |

### 050e — Operator Adoption Telemetry
> **STATUS: all ACs DONE (2026-06-25), CI-green @3057. Pending VERIFIED.** Single chokepoint `src/daemon/runtime/telemetry/emit.ts` + `glass-box.ts` + `telemetry` CLI verb. Allow-list payload, opt-out (`HONEYCOMB_TELEMETRY=0`/`DO_NOT_TRACK=1`), per-machine dedupe, anonymized installId distinct_id, tiered consent, bucketed counts. `installed` wired in install.ts, `first_link` in deeplake-issuer.ts. 050d seam: `emitHivemindUpgrade(ref, {dir})`. Tests: emit/glass-box/chokepoint-structural/wiring/first-link (30 tests).
| ID | Criterion | Status | Bee |
|---|---|---|---|
| e-AC-1 | `honeycomb_installed` / `honeycomb_first_link` / `honeycomb_hivemind_upgrade` each emit exactly once at defined lifecycle point, carrying effective `ref` (default `mario`). | OPEN | typescript-node |
| e-AC-2 | Payload only allow-listed fields; test asserts banned set (token, email, userName, raw cwd/repo paths, repo/branch, query strings, memory/session content, error messages/stacks, secrets, raw account/org/workspace ids) absent from every event. | OPEN | security/typescript-node |
| e-AC-3 | `HONEYCOMB_TELEMETRY=0` OR `DO_NOT_TRACK=1` → no network call for any event (asserted vs injected fetch recorder). | OPEN | typescript-node |
| e-AC-4 | Fire-and-forget: emit timeout/error/4xx/5xx does not change exit code or surface error; user flow byte-identical on vs off (minus network). | OPEN | typescript-node |
| e-AC-5 | Each event deduped per machine via onboarding flag — second run does not re-emit reported event. | OPEN | typescript-node |
| e-AC-6 | `distinct_id` anonymized (random install-id default; never email/raw account id), stable across runs on one machine. | OPEN | typescript-node |
| e-AC-7 | All emit paths funnel through single `emitTelemetry` chokepoint (structural test: no direct capture-endpoint posts). | OPEN | typescript-node |
| e-AC-8 | Glass-box: `honeycomb telemetry --show` (+ dashboard panel) renders plaintext what's been sent / would be sent next, from same local events. | OPEN | typescript-node |
| e-AC-9 | Tiered consent: Tier-1 opt-out, Tier-2 (usage-count) only on opt-in; test asserts default install emits no Tier-2; both env vars silence both tiers. | OPEN | typescript-node |
| e-AC-10 | No item-level egress: structural test asserts no per-memory/per-query/per-file emit path; counts bucketed; all egress daemon/session rollup. | OPEN | typescript-node |

---

## Wave 2 — 050b / 050d

### 050b — Pre-Auth Dashboard & Setup Shell
> **STATUS: all ACs DONE (2026-06-25), CI-green @3081. Pending VERIFIED.** MUST-FIX found+fixed: daemon threw at boot on missing creds (eager storage-config read) → `createLazyStorageClient` (re-attempts per query, typed `connection_error` pre-auth). New `GET /setup/state` (extensible contract), `SetupGate`/`GuidedSetup` React, embed warmup observability. **Scope-switcher seam for 049e planted: `src/dashboard/web/scope-context.tsx` + `ScopeSwitcherSlot` marked region in `sidebar.tsx`; host.ts stays scope-unaware.**
| ID | Criterion | Status | Bee |
|---|---|---|---|
| b-AC-1 | No creds on disk: daemon boots, `GET /dashboard` returns 200 + guided-setup state, no throw/fail-closed, no second daemon. | OPEN | typescript-node |
| b-AC-2 | `GET /setup/state` (loopback, local-mode-only) reports presence of `~/.deeplake`/`~/.honeycomb`/`~/.hivemind`, onboarding phase, prior-tool detection; fail-soft on missing/malformed onboarding file. | OPEN | typescript-node |
| b-AC-3 | Login writes a credential → running daemon serves authenticated surfaces on next request, no restart (test: pre-auth → write creds → authed query on one instance). | OPEN | typescript-node |
| b-AC-4 | Pre-auth shell carries no token/secret (byte-parity with `renderShell`); setup endpoints unreachable in non-local mode. | OPEN | security/typescript-node |
| b-AC-5 | Embedding warmup observably backgrounded: dashboard responds + login completes while model loads; recall falls back to lexical until warm. | OPEN | embeddings-runtime |
| b-AC-6 | "First time setup" button present in fresh-install state, absent once valid credential exists (shows linked/authed state). | OPEN | typescript-node |

### 050d — Hivemind Coexistence & Migration
> **STATUS: all ACs DONE (2026-06-25), CI-green @3110 (1 pre-existing flake `secrets/exec.test.ts`, untouched, passes isolated). Pending VERIFIED.** New `hivemind-uninstall.ts` (timestamped backup→idempotent remove, never touches shared cred), `setup-migrate.ts` (`POST /setup/migrate-from-hivemind` + `/rollback`, migration.phase transactions), `/setup/state` extended (migration block + derived priorTool), `CoexistenceWarning`+`MigrationInterrupted` React. Path A=No silent-adopt via GET /me. `emitHivemindUpgrade` on success only.
| ID | Criterion | Status | Bee |
|---|---|---|---|
| d-AC-1 | Existing Hivemind/credential install: `GET /setup/state` flags prior-tool present; dashboard renders coexistence-warning wizard. | OPEN | typescript-node |
| d-AC-2 | Warning states coexistence unsupported + what "Proceed with Honeycomb" does, before any destructive action. | OPEN | typescript-node |
| d-AC-3 | "Proceed with Honeycomb" backs up Hivemind config, uninstalls Hivemind idempotently, advances to "Link to DeepLake". | OPEN | harness-integration |
| d-AC-4 | "Link to DeepLake" with valid existing creds verifies via `GET /me` + adopts (no redundant device flow); with no valid cred runs 050c `--ref mario` flow. | OPEN | typescript-node |
| d-AC-5 | Failed/partial uninstall surfaces plain-language msg + backup location; does not delete shared credential or leave daemon unusable. | OPEN | harness-integration |
| d-AC-6 | After migration, `GET /setup/state` reports `hivemind: migrated`; dashboard in authenticated phase (one running daemon). | OPEN | typescript-node |
| d-AC-7 | Daemon crash/kill mid-migration: on restart `GET /setup/state` reports non-terminal `migration.phase`; dashboard offers resume or roll back (restore backup) — never presents half-migrated as clean. | OPEN | typescript-node |

---

## Wave 3 — 049a — Project Identity & Resolution
> **STATUS: all ACs DONE (2026-06-25), CI-green @3142 (1 pre-existing flake `secrets/exec.test.ts`). Pending VERIFIED in 049 close-out.** Branch `legion/prd-049-multi-project` off merged main (#100). SCHEMA: `src/daemon/storage/catalog/projects.ts` (tenant-scoped registry, `remote_signal`/`bound_paths`/`is_reserved`, `__unsorted__` reserved+collision-guard = 49a-AC-6, additive heal). RESOLVER: `src/hooks/shared/project-resolver.ts` (`canonicalizeRemote`, pure `resolveScope`, fail-soft zod `projects.json` cache, thin-client) + `resolveRequestScope` in `tenancy-resolution.ts` (per-request Org→Ws→Project, workspaceId fallback-only). projects.json shape: `{schemaVersion,org,workspace,bindings[],projects[]}`. NOTE: nothing CALLS resolveRequestScope on live capture/recall yet — 049b wires it; daemon registry→cache sync writes projects.json (049d).
| ID | Criterion | Status | Bee |
|---|---|---|---|
| 49a-AC-1 | `resolveScope({cwd})` pure/deterministic — same `project_id` for same bound folder across runs & across remote-URL forms (`git@`≡`https`). | OPEN | typescript-node |
| 49a-AC-2 | Two cwds → two projects → two `project_id` simultaneously, no shared mutable global; a third session switching scope perturbs neither. | OPEN | typescript-node |
| 49a-AC-3 | Identity-less folder (no binding, no remote) → workspace `__unsorted__` inbox id + `bound:false`; never throw, never another project's id. | OPEN | typescript-node |
| 49a-AC-4 | Folder with git remote matching a registry project → binds/suggests that project, not inbox. | OPEN | typescript-node |
| 49a-AC-5 | `credentials.json.workspaceId` consulted only as fallback default; structural test: no capture/recall path treats it as authoritative active scope when a binding resolves. | OPEN | typescript-node |
| 49a-AC-6 | `projects` registry enforces reserved `__unsorted__` per workspace; rejects user-created project colliding with it. | OPEN | deeplake-dataset |

## Wave 4 — 049b / 049c

### 049b — Memory Isolation
| ID | Criterion | Status | Bee |
|---|---|---|---|
| 49b-AC-1 | Concurrent capture A & B → rows carry A's/B's resolved `project_id` (per-project read-back), no manual switch. | OPEN | typescript-node |
| 49b-AC-2 | Recall in A → no row with B's `project_id`, even on strong vector / high-degree-entity hit. | OPEN | retrieval |
| 49b-AC-3 | Identity-less session capture → `__unsorted__` inbox (never dropped); recall sees only inbox + workspace-global rows. | OPEN | retrieval |
| 49b-AC-4 | Resolved project: PRD-011e `agent_id` clause still applies within it (isolated/shared/group unchanged). | OPEN | retrieval |
| 49b-AC-5 | Structural/integration test: no capture/recall path reads `workspaceId` directly instead of `resolveScope(cwd)`; `project_id` predicate present on every memory query. | OPEN | typescript-node |

### 049c — Skill Isolation
| ID | Criterion | Status | Bee |
|---|---|---|---|
| 49c-AC-1 | Skill mined in A → not surfaced in B. | OPEN | retrieval |
| 49c-AC-2 | Skill promoted cross-project → surfaced in any of user's projects, with cross-project provenance visible. | OPEN | retrieval |
| 49c-AC-3 | Published skill for A → teammate auto-pull lands in A's scope, surfaced only in A. | OPEN | retrieval |
| 49c-AC-4 | Promotion to cross-project explicit, recorded with provenance; no mining/pull path sets it implicitly. | OPEN | retrieval |
| 49c-AC-5 | Skill mined in identity-less session tagged to workspace `__unsorted__` project (consistent with 049b). | OPEN | retrieval |

## Wave 5 — 049d then 049e

### 049d — Org/Workspace Switching + Project Bind (CLI)
| ID | Criterion | Status | Bee |
|---|---|---|---|
| 49d-AC-1 | `honeycomb org list` == `GET /organizations`; `workspace list` == `GET /workspaces` for active org. | OPEN | typescript-node |
| 49d-AC-2 | `honeycomb project bind <p>` writes folder→project to 049a store; subsequent capture in folder resolves to `<p>`. | OPEN | typescript-node |
| 49d-AC-3 | `org switch <org>` re-mints org-bound token; `workspace use`/`project use` perform no re-mint. | OPEN | typescript-node |
| 49d-AC-4 | Two terminals/two folders: one runs switch/use/bind → other's `status` still reports its own folder's scope, unchanged. | OPEN | typescript-node |
| 49d-AC-5 | `honeycomb status` reports resolved Org/Workspace/Project (or `__unsorted__`) + agent for cwd; marks unbound folder explicitly. | OPEN | typescript-node |
| 49d-AC-6 | Env overrides (`HONEYCOMB_ORG_ID`/`HONEYCOMB_WORKSPACE_ID`/`HONEYCOMB_TOKEN`) still precedence (PRD-011 parity); add `HONEYCOMB_PROJECT_ID`. | OPEN | typescript-node |

### 049e — Dashboard Scope Switcher
| ID | Criterion | Status | Bee |
|---|---|---|---|
| 49e-AC-1 | Switcher lists orgs (`GET /organizations`), workspaces (`GET /workspaces`), projects (049a registry), scoped to privileges; nothing inaccessible appears. | OPEN | typescript-node |
| 49e-AC-2 | Selecting a Project re-scopes codebase graph, memory graph, memories, sync to that `project_id` on next render. | OPEN | typescript-node |
| 49e-AC-3 | Changing Org triggers daemon org-bound token re-mint (PRD-011) before workspace/project enumeration for new org. | OPEN | typescript-node |
| 49e-AC-4 | Dashboard selection viewer-side; does not overwrite per-folder CLI bindings unless explicit bind action taken. | OPEN | typescript-node |
| 49e-AC-5 | No project selected (or none accessible) → project pages render explicit empty/needs-selection state, not another project's data. | OPEN | typescript-node |

---

## Module-level roll-ups (verified at close-out)
- **PRD-050 AC-1..9 — VERIFIED (2026-06-25).** All 5 sub-PRDs (35 sub-ACs) + 9 module ACs PASS. security-worker-bee clean at Medium+ (0 Crit/High/Med, 2 Low documented). quality-worker-bee PASS (report: `prd-050-.../reports/2026-06-25-qa-report.md`). CI green @3110. Shipping as PR-1. Non-gating follow-up: vanity domain + checksum.
- **PRD-049 AC-1..8 — VERIFIED (2026-06-25).** All 5 sub-PRDs (27 sub-ACs) + 8 module ACs PASS. Waves 3-5 (049a resolver+registry, 049b memory isolation, 049c skill isolation, 049d CLI switchers + registry→cache sync, 049e dashboard switcher into 050b seam). Reopened+closed: cross-project skill promotion was unreachable → added `honeycomb skill promote [--workspace-wide]` + `POST /api/skills/promote` (round-trip test proves 49c-AC-2/AC-4 end-to-end). security-worker-bee clean at Medium+ ×2 (full 049 surface + promotion-seam spot-check; load-bearing verdict: forged project_id/header/override CANNOT cross the org/workspace hard partition; 1 Medium fixed: cross-tenant guard parity on diagnostic endpoints). quality-worker-bee PASS (report: `prd-049-.../reports/2026-06-25-qa-report.md`; 49e-AC-2 judged PASS — graphs are workspace-level by data model, row predicate applies to memories+recall). CI green @3252. Shipping as PR-2.
  - Non-defect notes from QA (acceptable): memory/codebase graph re-scope is view-level (ontology tables have no project_id by design); sync page assets are workspace-shared.

## Operator decisions (pending — block listed ACs)
| # | Decision | Blocks | Default/lean |
|---|---|---|---|
| D1 | Node-install mechanism per OS + where install scripts are hosted (curl\|sh URL) | a-AC-1/3/5 | official installer + fnm fallback; host TBD |
| D2 | Referral header name: reuse `X-Hivemind-Referrer` vs mint `X-Honeycomb-Referrer` | c-AC-1, d-AC-4 | reuse `X-Hivemind-Referrer` (zero backend) |
| D3 | Path A: does Activeloop attribute an already-registered account on first Honeycomb touch? | d-AC-4 | assume NO → silent-adopt + 050e measures |
| D4 | 049a binding-registry backing store | 49a-AC-1..6 | local `~/.deeplake/projects.json` cache over server `projects` table |
| D5 | Migrate existing free-text `project` values (backfill vs leave→inbox) | 49b-AC, 49c-AC | leave; resolve to inbox (non-destructive) |

## Close-out — COMPLETE (2026-06-25)
- [x] security-worker-bee: PRD-050 clean at Medium+; PRD-049 clean at Medium+ (×2, incl. promotion-seam spot-check). All Crit/High = 0; 1 Medium fixed (049 diagnostic-endpoint cross-tenant guard parity).
- [x] quality-worker-bee: PRD-050 PASS (9+35 ACs); PRD-049 PASS (8+27 ACs). Reports under each PRD's reports/ folder.
- [x] PRs merged: **PRD-050 → #100** (merged 08:10Z, CodeQL+CodeRabbit clean, all bot findings triaged/fixed). **PRD-049 → #101** (merged 11:17Z, CI+CodeQL+CodeRabbit green, no actionable bot findings).
- **RUN COMPLETE: 10/10 sub-PRDs, 100% of acceptance criteria VERIFIED and shipped to main.**

## Outstanding external / non-gating follow-ups (no AC depends on these)
1. **Activeloop backend must recognize `X-Honeycomb-Referrer`** for the new header to actually attribute (dual-send means `X-Hivemind-Referrer` carries attribution meanwhile — Goal 2 works today, just on the old header). Backend-owned; coordinate with Activeloop.
2. **Installer hosting**: stand up vanity domain `get.honeycomb.*` + published checksum / "inspect before piping" page; repoint the interim repo-raw URL in `scripts/install/*`. Before public launch.

> Lifecycle bookkeeping DONE (2026-06-25, docs PR #102): `prd-049`/`prd-050` folders `git mv`'d backlog/ → `library/requirements/completed/` with QA reports intact, status headers + sub-PRD rows set to Completed (#101 / #100), cross-PRD links repointed.
