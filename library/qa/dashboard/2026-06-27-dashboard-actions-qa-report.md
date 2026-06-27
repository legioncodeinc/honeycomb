# QA Findings Report — Dashboard ↔ CLI action parity (first pass)

- **Date:** 2026-06-27
- **Auditor:** quality-worker-bee
- **Branch:** `legion/vigilant-kepler-146553`
- **Worktree:** `C:\Users\mario\GitHub\honeycomb\.claude\worktrees\vigilant-kepler-146553`
- **Source plan:** `C:\Users\mario\.claude\plans\eventual-toasting-snail.md` (no PRD/IRD in `library/`)
- **Ordering:** `security-worker-bee` ran first (0 Critical / 0 High; 2 Medium, 3 Low documented, no code changed). Correct security → quality order. No prior QA report on this branch.

---

## Verdict

**PASS (ship-ready), with one verification gap and minor follow-ups.**

The five named actions (embeddings on/off, daemon restart, uninstall, DeepLake login, DeepLake logout) are each wired end-to-end (daemon endpoint ↔ wire method ↔ UI control) and unit-tested. The implementation faithfully follows the plan's `/api/actions` action-endpoint architecture, the local-mode + origin/CSRF + session-header guard, the fail-soft discipline, and the documented "guided v1" uninstall and "graceful-stop-then-respawn" restart, both of which the plan explicitly sanctioned. `tsc`, `npm run dup`, and all three targeted suites are green. The single substantive gap is the one the plan itself flagged: the restart self-respawn is unit-tested only through injected seams and was **not live-exercised** (no dogfood). That is a Warning, not a blocker.

---

## Scorecard

| Axis | Result | Notes |
|------|--------|-------|
| **Completeness** | PASS | All five actions present + wired UI→wire→daemon. Persistence, boot-seed, esbuild target, server route group all present. |
| **Correctness** | PASS | `tsc --noEmit` clean; 29/29 targeted tests pass; guard logic, fail-soft, and echo-checks are sound. |
| **Alignment** | PASS | Matches the plan's architecture, security posture, and sanctioned scope reductions (guided uninstall, graceful-stop fallback). |
| **Gaps** | PARTIAL | Restart not live-exercised (plan-acknowledged). `setEnabled()` + boot-reconcile lack coverage in their home suites. |
| **Detrimental patterns** | PASS | No dead code, no secret leakage, consistent with surrounding conventions, well-documented. |

### Verification commands (all run, honest results)

| Command | Result |
|---------|--------|
| `npx tsc --noEmit` | **PASS** — exit 0, no errors |
| `npm run dup` (jscpd) | **PASS** — 25 clones, 0.36% lines / 0.51% tokens (threshold 7%); all 25 are pre-existing files unrelated to this branch |
| `npx vitest run …actions-api.test.ts …settings-actions.test.tsx …dispatch.test.ts` | **PASS** — 3 files, **29/29** tests (11 + 5 + 13) |
| Pre-existing flaky `tests/hooks/runtime/hook-runtime.test.ts` | Not attributable to this branch (fails identically on main per brief); not run in scope. |

---

## Plan-item traceability

| Action (plan §) | Daemon endpoint | Wire method | UI control | Tests | Status |
|-----------------|-----------------|-------------|------------|-------|--------|
| **Logout** (§1) | `POST /api/actions/logout` → `defaultRemoveCredentials` rm of `credentialsPath()` + `legacyCredentialsPath()` (`actions-api.ts:215`, `:141`) | `wire.logout()` (`wire.ts:2183`) | "Log out" in `DeeplakeAuthSection` (`settings.tsx:229`) | guard ×5, logout ×1 (`actions-api.test.ts`); DOM logout flip (`settings-actions.test.tsx:98`) | ✅ Done |
| **Login** (§2, UI-only) | reuses existing `POST /setup/login` + `GET /setup/state` (no new endpoint) | reuses existing `wire.setupLogin()` / `setupState()` | in-page device flow in `ConnectHandoff` (`settings.tsx:101`); CLI hint kept | DOM `setupLogin` + `user_code` render (`settings-actions.test.tsx:114`) | ✅ Done |
| **Embeddings on/off** (§3) | `POST /api/actions/embeddings` → live `embed.setEnabled()` + persist `embeddings.enabled` (`actions-api.ts:223`) | `wire.setEmbeddings()` (`wire.ts:2189`) | toggle in `EmbeddingsSection` reading `health().reasons.embeddings` (`settings.tsx:531`) | live-actuate+persist, no-store, 400-malformed (`actions-api.test.ts:133`); DOM toggle (`settings-actions.test.tsx:125`) | ✅ Done |
| **Embeddings persistence/boot-seed** (§3) | `EMBEDDINGS_ENABLED_KEY` registered in `KNOWN_SETTING_KEYS` (`vault/api.ts`); boot read `readBootEmbeddingsEnabled` + fire-and-forget reconcile (`assemble.ts:1353`, `:1731`) | n/a | n/a | **none in home suite** (see W-2) | ⚠️ Wired, untested |
| **Restart** (§4) | `POST /api/actions/restart` → spawn helper + deferred SIGTERM (`actions-api.ts:248`); standalone `restart-helper.ts` + esbuild target (`esbuild.config.mjs:148`) | `wire.restartDaemon()` (`wire.ts:2195`) | "Restart" two-step confirm + "restarting…" in `SystemActionsSection` (`settings.tsx:625`) | spawn→ack→deferred shutdown via injected seams (`actions-api.test.ts:165`); DOM confirm flow (`settings-actions.test.tsx:137`) | ⚠️ Done, not live-exercised (W-1) |
| **Uninstall** (§5, guided v1) | `POST /api/actions/uninstall` → `defaultUninstall` (detect harnesses + CLI command, `removed:false`) (`actions-api.ts:188`) | `wire.uninstall()` → `UninstallResultWire \| null` (`wire.ts:2201`) | "Uninstall" danger two-step confirm + honest result render (`settings.tsx:660`) | injected outcome (`actions-api.test.ts:187`); DOM render command+harnesses (`settings-actions.test.tsx:150`) | ✅ Done (scope-reduced per plan §5) |
| **CLI `--help` (login/logout regression)** | n/a | n/a | `usageText()` grouped + ASCII banner; `login`/`logout` added to `VERB_TABLE` (`contracts.ts:97`); already in `AUTH_SUBCOMMANDS` | 5 new tests in `dispatch.test.ts:151` | ✅ Done |
| **Security: local-mode + origin/CSRF + session header** | `actionGuard` (`actions-api.ts:101`) | n/a | n/a | 5 guard tests cover team-mode 403, cross-site 403, untrusted-origin 403, loopback-origin 200, missing-session 403 | ✅ Done |
| **server.ts route group** | `{ path: "/api/actions", protect: true, session: false }` (`server.ts:95`) | n/a | n/a | covered transitively | ✅ Done |

---

## Findings

### Critical (blocks ship)
None.

### Warnings (should fix)

**W-1 — Restart self-respawn is not live-exercised (plan-acknowledged verification gap).**
- **Where:** `src/daemon/restart-helper.ts` (whole module), `src/daemon/runtime/dashboard/actions-api.ts:168` (`defaultSpawnRestart`).
- **What:** The restart path is unit-tested only through the injected `spawnRestart`/`shutdown` seams (`actions-api.test.ts:165`). The real respawn — `defaultSpawnRestart` resolving `restart-helper.js` beside `process.argv[1]`, the helper's `/health` down-poll, the `LOCK_RELEASE_GRACE_MS` window, and the fresh-daemon spawn — has **no test of its own** and was **not run against a live daemon** (no dogfood, despite the plan's Verification §2 calling for it). This is the single highest-risk item in the plan (§4 labels it "highest-risk") and the exact class of race (single-instance lock vs. overlapping start) where unit seams cannot prove the timing is correct.
- **Why it matters:** A subtle bug (helper resolves the wrong entry path under a given bundling, or the lock-release grace is too short and the new daemon hits "already running") would surface only at runtime as a daemon that stops and never comes back. Project memory (`deferred-assembly-completed-not-live`, `dogfood-surfaces-integration-bugs`) is explicit that wiring is not "live" until exercised.
- **Recommendation:** Before declaring the feature done, run the plan's dogfood (build, click Restart, confirm `/health` recovers and the dashboard reconnects). The plan's own fallback (§4) is also acceptable: if respawn proves racy, ship graceful-stop with the "restarts on your next coding turn" message. Either way, record the outcome.

**W-2 — `EmbedSupervisor.setEnabled()` and the boot reconcile have no coverage in their home suites.**
- **Where:** `src/daemon/runtime/services/embed-supervisor.ts:445` (`setEnabled`); `src/daemon/runtime/assemble.ts:1353` (`readBootEmbeddingsEnabled`) + `:1731` (fire-and-forget reconcile).
- **What:** `setEnabled()` is the real live-toggle (it manipulates `started`/`stopping`/`child`, calls `start()`/`stop()`, and is the load-bearing mechanism behind the embeddings action). It is exercised in tests only via a **fake** supervisor in `actions-api.test.ts:39` that records the boolean and does nothing — so the actual spawn/stop reconcile, the idempotency claim ("a double-click never double-spawns"), and the "clear the `stopping` latch / reset `started`" branch are untested. `embed-supervisor.test.ts` exists but was not extended. Likewise `readBootEmbeddingsEnabled` (vault-first precedence, fail-soft to env/default) and the boot reconcile diff (`enabled === !disabled ? skip : setEnabled`) added to `assemble.ts` have no direct test, though `assemble.test.ts` exists.
- **Why it matters:** The plan (§3) makes persistence-survives-restart and live-actuation explicit acceptance behavior. The mechanism is correct on read, but a regression in `setEnabled`'s state machine or the boot precedence would pass CI silently.
- **Recommendation:** Add a focused `embed-supervisor.test.ts` case for `setEnabled(true/false)` idempotency and re-enable-after-stop using the existing injected `spawnChild`/`probeHealth` seams, and an `assemble.test.ts` (or unit) case for `readBootEmbeddingsEnabled` precedence (persisted setting wins; missing → env/default). Low effort given the seams already exist.

### Suggestions (nice-to-have)

**S-1 — Branch HEAD does not contain the feature; it lives entirely in the uncommitted working tree.**
- **Where:** `git diff main..HEAD` shows only an unrelated workspace-layout/secrets-doc change; the full feature (11 modified + 4 new files) is uncommitted (`git status`).
- **Note:** Not a code defect, and QA audits the working tree as instructed. Flagging for hygiene: before opening the PR, ensure the feature is actually committed so CI runs against it and the security/QA snapshot matches what merges. (Ref project memory `merged-pr-branch-runs-no-ci` / `git-add-all-deletes-missing-assets` — verify the commit captures exactly these 15 files and nothing stray.)

**S-2 — `package.json` `files` relies on the `daemon/` directory entry for `restart-helper.js`.**
- **Where:** `package.json:26` (`"daemon"`), `esbuild.config.mjs:154` (outdir `daemon`).
- **Note:** The plan asked to "add `daemon/restart-helper.js` to `package.json` `files`." It is shipped correctly because the whole `daemon/` dir is already allowlisted — no separate entry needed, no gap. Mentioned only so a future reader does not "fix" a non-bug by adding a redundant line. A publish-time `pack-check` confirming `daemon/restart-helper.js` is in the tarball would make this guarantee explicit.

**S-3 — `readEnabled` accepts `"true"`/`"false"`/`1`/`0` coercions the wire client never sends.**
- **Where:** `actions-api.ts:126`.
- **Note:** The dashboard always sends a real boolean (`wire.setEmbeddings` posts `{ enabled }`). The extra coercion is harmless defensiveness for non-dashboard callers and is fine to keep; flagging only as a minor surface-area observation, not a defect.

---

## Detrimental-pattern scan (explicit, per directive)

- **Secret/token leakage:** None. `logout` returns `{ ok }`; `embeddings` returns `{ ok, enabled }`; `restart` returns `{ ok, restarting }`; `uninstall` returns paths/ids/command string only. Login reuses the token-redacted setup flow. Matches plan §Security and security-worker-bee's clean finding.
- **Fail-soft discipline:** Consistent. Credential rm is idempotent and swallows errors; vault persist failure does not block the live toggle; mount failure is caught non-fatally in `assemble.ts:1879`; wire methods degrade to `false`/`null` and never throw into React; the restart helper is bounded by `MAX_WAIT_MS` and never hangs.
- **Dead code:** None found. All new exports are referenced (`mountActionsApi` wired in `assemble.ts`; `EMBEDDINGS_ENABLED_KEY` used in 3 sites; `noopEmbedSupervisor.setEnabled` added to satisfy the interface).
- **Convention consistency:** High. `mountActionsApi`/`mountActionsGroup` mirror `mountHarnessApi`; the wire methods mirror the `postJson`/zod-`.catch()` pattern; UI sections mirror existing `Panel`/`Button`/`Badge`/`data-testid` idioms and the two-step-confirm-without-a-modal approach the plan specified.
- **Doc comments:** Thorough — every new module, seam, and public method carries a rationale-bearing JSDoc.

---

## Notes for the invoker

1. **One real action before "done":** run the live dogfood for **Restart** (W-1). It is the only behavior unit tests structurally cannot prove, and the plan called for it.
2. **Two cheap test additions** (W-2) would close the only coverage holes and are low-effort because the seams already exist.
3. Everything else is ship-ready: architecture, security guard, scope, and the CLI `--help` login/logout fix are all correct and tested.
