# QA Report: PRD-073 Dormant-by-Default Capture and Explicit Tenancy Selection

**Plan document:** `library/requirements/backlog/prd-073-dormant-capture-and-explicit-tenancy/` (index + 073a/b/c/d)
**Audit date:** 2026-07-04
**Base branch:** `main`
**Head:** `feature/prd-073-dormant-capture-tenancy` (uncommitted working tree)
**Auditor:** quality-worker-bee

Ordering: `security-worker-bee` ran first for this branch and returned clean (no Critical/High; 3 documented Lows) at `library/qa/security/2026-07-04-security-audit-prd-073-dormant-capture-tenancy.md`. The ordering invariant is intact.

Fix applied during this audit (dispatched with the QA task, per the invoker's explicit instruction): the security audit's Low-1 defense-in-depth guard was added to `POST /setup/tenancy/workspaces` (`src/daemon/runtime/dashboard/setup-tenancy.ts:470-474`), which now validates `org` against the pending window's enumerated orgs exactly as `POST /setup/tenancy/select` does, with the AC-named test `073c-AC-1.3 (create-path guard, security Low-1): an org NOT in the enumerated pending list is rejected 400 with no create call` (`tests/daemon/runtime/dashboard/setup-tenancy.test.ts:305-321`). `npm run ci` was re-run after the change and passes (output below).

## Summary

**Verdict: PASS WITH WARNINGS.** All 10 module-level acceptance criteria and every sub-PRD AC trace to implementation with AC-named passing tests; the dormancy gate ladder (tenancy confirmed, then bound project), the two-phase link (no persist for a pending multi-org link; select validates, re-mints for the chosen org, and stamps the marker), grandfathering (`selected` mirrors the capture gate's `resolveTenancyConfirmation` predicate with the additive `confirmedBy`), the inbox opt-in (default OFF), and workspace creation are all correct against the reconciled contracts. `npm run ci` passes cleanly (typecheck + jscpd + 4184 tests + SQL-safety audit). Three Warnings remain: the canonical contract's `autoSelected` field is declared but never emitted by `GET /setup/tenancy`, AC-073d.1.2 (half-pinned prompt) has no named test, and the pending-link TTL expiry path is untested. None blocks ship.

## Scorecard

| Category      | Status | Notes |
|---------------|--------|-------|
| Completeness  | ⚠️ | Every AC implemented and AC-named-tested except two test gaps (073d-AC-1.2 named test; TTL expiry test) and one unemitted contract field |
| Correctness   | ✅ | Gate ladder order, two-phase no-persist, validation-before-persist, grandfathering, and fail-open posture all verified against the contracts |
| Alignment     | ⚠️ | `autoSelected` declared in the canonical contract but dead on the daemon side; the 059a first-run predicate was unwired rather than "kept as a fast-path" (behavior-superior, but drifts from 073a scope prose) |
| Gaps          | ✅ | No silent drops: gated ack reasons, hook exit reasons, health reasons, counters, and the notice all present |
| Detrimental   | ✅ | No duplication (jscpd green), no SQL surface added, no tier-boundary violation, no token in any body/log |

## Critical Issues (must fix)

None.

## Warnings (should fix)

- [ ] **`autoSelected` is declared in the canonical `GET /setup/tenancy` contract but never emitted**, `src/daemon/runtime/dashboard/setup-tenancy.ts:121` (declaration), `:229` (the only producer), `src/daemon/runtime/dashboard/setup-login.ts:149` (where the value is discarded)

  The reconciled contract (PRD-073c and the hive mirror `tenancy-contracts.ts:33`) declares `autoSelected?: { orgId, workspaceId }` on the `GET /setup/tenancy` body. The pending-link runner returns `{ autoSelected }`, but `mountSetupLogin` fires the runner as `void runDeviceFlow(deps).catch(...)` so the value is dropped, and no branch of the `GET /setup/tenancy` handler ever sets the field. Parent AC-8's dashboard surfacing is met only indirectly (`selected: true` + `confirmedBy: "selection"` + the org/workspace pair), and hive tolerates the absence because its schema marks the field optional, so nothing breaks today; but a declared-and-mirrored contract field that can never appear is drift waiting to confuse the next consumer. Either emit it (stash the auto-selection beside the pending store and report it on the next `GET /setup/tenancy`) or strike it from both contract mirrors.

  ```ts
  // setup-login.ts:149 — the runner's { autoSelected } return value goes nowhere:
  void runDeviceFlow(deps).catch((err: unknown) => rejectGrant(err));
  ```

- [ ] **AC-073d.1.2 has no named test (half-pinned prompt: `--org` given, only the workspace prompt renders)**, `tests/cli/auth-tenancy.test.ts` (absent), implementation at `src/cli/auth.ts` (`resolveOrg` flag branch + `resolveWorkspace` prompt branch)

  The sub-PRD requires: given `--org` but multiple workspaces on a TTY, only the workspace prompt renders. The implementation supports it (the org half resolves from the flag without prompting; the workspace half prompts), but no test proves the org prompt is skipped. Every sibling 073d AC has a named test; this one is the only gap. Add a scripted-prompt test asserting exactly one prompt invocation.

- [ ] **Pending-link TTL expiry is implemented but untested**, `src/daemon/runtime/dashboard/setup-tenancy.ts:177-184` (the TTL branch), test absent

  AC-073c.1.4's bounded-TTL design (and the 073c test plan's "TTL expiry cleans the pending slice") is implemented with an injectable `now` seam built for exactly this test, but no test drives a past-TTL `get()` to assert the slot nulls and the short-lived token is discarded. The restart-loss half of AC-1.4 IS tested (`setup-tenancy.test.ts:270-280`). Add a two-line test advancing the injected clock past `DEFAULT_PENDING_LINK_TTL_MS`.

## Suggestions (consider improving)

- [ ] **073a scope prose says the 059a first-run predicate is "kept as a cheap fast-path short-circuit"; the assembly instead unwired it**, `src/daemon/runtime/assemble.ts:962-967` (`firstRunGate: true` replaced by `boundProjectGate: true`)

  The production outcome is strictly better than the prose: in the zero-bindings state the old `firstRunGateClosed` short-circuit (`capture-handler.ts:316-318`) returns a reason-LESS gated ack and skips the tenancy check and the gated counter, while the new ladder returns the reasoned ack the parent AC-1 requires and counts it. Keeping the predicate wired would have violated AC-1's reasoned-ack shape for the zero-binding state, so the drift is justified; the `firstRunGate` dep is retained for direct-construction tests as documented. Recommend a one-line note in 073a when the PRD moves to completed, so the prose and the wiring agree.

- [ ] **`createSessionBindNoticeGate` inlines its own `HONEYCOMB_INBOX_CAPTURE` parse**, `src/hooks/shared/session-start.ts:100-101`

  The hooks tier cannot import the daemon's `resolveInboxCaptureEnabled` (tier direction), so the inline `"true"/"1"` check is structurally justified and jscpd passes; but the two parsers can drift (the daemon side accepts anything `BoolFlag` accepts). If `BoolFlag` ever widens, move the flag parse into `src/shared`.

## Plan Item Traceability

Status legend: ✅ implemented + AC-named passing test; ⚠️ implemented with a noted gap; 🟦 verified not-touched (Non-Goal).

### Index (module-level) ACs

| # | Plan Requirement | Status | Implementation Location | Notes |
|---|---|---|---|---|
| AC-1 | Unbound cwd + inbox OFF: no row, no enqueue, gated ack `no_bound_project` | ✅ | `capture-handler.ts:326-331`, `:641-655`; wired `assemble.ts:962-967` | Test `073a-AC-1.1` asserts no INSERT, no enqueue, ack shape, counter |
| AC-2 | Hook exit reports the gate reason; session-start notice once | ✅ | `src/hooks/shared/capture.ts:99-123`; `session-start.ts:96-149` | Tests `073b-AC-2.1` (4 cases incl. old-shape ack), `073b-AC-2.2` (renders once) |
| AC-3 | Zero bindings: daemon serves normally, zero capture writes, machine-readable health reason | ✅ | `health.ts:64-71`, `:191-229`; live probe `assemble.ts:2310-2323` | Tests `073b-AC-1.1` (guidance string, clears on bind), `073a-AC-1.3` (zero storage calls) |
| AC-4 | Inbox opt-in ON restores PRD-049a verbatim | ✅ | `capture-handler.ts:651-653`; `capture-config.ts:105-117` | Test `073a-AC-3.1` (`__unsorted__` row + pipeline-entry enqueued) |
| AC-5 | Existing installs grandfathered: no re-onboarding, tenancy confirmed | ✅ | `tenancy-confirmation.ts:65-77`; `setup-tenancy.ts:303-336` | Tests: grandfather suite in `tenancy-selection.test.ts:195-236`, the AC-5 route test at `setup-tenancy.test.ts:135-164` asserting the route and the capture-gate seam agree |
| AC-6 | Multi-org link persists NOTHING until explicit selection; lists surfaced | ✅ | `deeplake-issuer.ts` (`authenticateDeviceFlow`, `resolveTenancyChoice`, `TenancySelectionRequiredError`); runner `setup-tenancy.ts:215-239` | Tests `073c-AC-1.1` (no file written), CLI `073d-AC-2.1` (refusal, nothing written) |
| AC-7 | Selection persists chosen pair + marker, re-mints for the CHOSEN org, visible on `/api/auth/status` | ✅ | `persistSelectedTenancy` (issuer), select route `setup-tenancy.ts:412-458`; `status-api.ts:72-86`, `:129-149` | Tests `073c-AC-1.2` (issuer and route), `status-tenancy.test.ts` (marker + grandfather + disconnected) |
| AC-8 | Single-org single-workspace auto-selects, MUST surface the selection, stamps marker | ⚠️ | `computeAutoSelection` (issuer); CLI print in `loginWithDeviceFlow` ("Using org X ..., workspace Y."); route surfacing via `selected` + `confirmedBy` | Tests `073c-AC-2.1`, `073d-AC-3.1`. Warning: the contract's `autoSelected` field is never emitted by `GET /setup/tenancy` |
| AC-9 | Unconfirmed tenancy gates capture with `tenancy_unconfirmed` regardless of bindings | ✅ | `capture-handler.ts:641-650` (tenancy checked FIRST); seam `tenancy-confirmation.ts:84-86` | Test `073c-AC-3.1` (bound cwd still gated), plus fail-open and proceed cases |
| AC-10 | Env pins keep precedence, count as explicit selection, surfaced | ✅ | `resolvePinnedTenancy` + pins branches of `resolveTenancyChoice` (issuer) | Tests `073c-AC-2.2`, `073d-AC-3.2` |

### PRD-073a sub-ACs

| # | Plan Requirement | Status | Implementation Location | Notes |
|---|---|---|---|---|
| AC-073a.1.1 | Gated ack `{ ok, gated, reason: "no_bound_project" }`, nothing written/enqueued/embedded | ✅ | `capture-handler.ts:326-331` | Named test; `fake.requests.length === 0` proves not even heal introspection runs |
| AC-073a.1.2 | Per-session, not first-run: unbound cwd gated even with other bound projects | ✅ | `capture-handler.ts:651-653` | Named test |
| AC-073a.1.3 | Zero bindings: row counts unchanged across repeated captures | ✅ | same gate | Named test |
| AC-073a.2.1 | Bound cwd captures exactly as pre-073 | ✅ | `resolveCaptureScope` `capture-handler.ts:606-630` | Named test (201 + `'proj-api'` in the INSERT) |
| AC-073a.2.2 | `HONEYCOMB_PROJECT_ID` override never gated | ✅ | override-first in `resolveCaptureScope` | Named test |
| AC-073a.3.1 | Inbox ON restores 049a verbatim | ✅ | `evaluateDormancyGate` inbox bypass | Named test |
| AC-073a.3.2 | Flag unset resolves OFF | ✅ | `resolveInboxCaptureEnabled` | Named test (unset, garbage, "true", "1") |

### PRD-073b sub-ACs

| # | Plan Requirement | Status | Implementation Location | Notes |
|---|---|---|---|---|
| AC-073b.1.1 | `/health` carries `capture_dormant_no_project` + guidance while zero bindings; clears on bind | ✅ | `health.ts:191-229`; live per-call probe `assemble.ts:2321` | Named tests (present with guidance / absent) |
| AC-073b.1.2 | `capture_blocked_tenancy_unconfirmed` while unconfirmed; clears on confirm | ✅ | same | Named test |
| AC-073b.1.3 | Team/hybrid public body strips the reasons (PRD-029 split preserved) | ✅ | mode-gated reasons block (pre-existing) | Named test (local keeps, team drops) |
| AC-073b.2.1 | Shim result carries the gate reason; never a plain success for a gated event | ✅ | `capture.ts:99-123` (`gatedReasonOf` reads `reason` only when `gated: true`) | Named tests incl. old-shape ack degradation |
| AC-073b.2.2 | Cwd-specific bind notice once per session | ✅ | `BIND_PROJECT_CWD_NOTICE` + `createSessionBindNoticeGate`, `session-start.ts:52-149` | Named tests: cwd-variant, fresh-install variant, bound cwd none, inbox-on none, logged-out none |
| AC-073b.3.1 | Gated-captures counter partitioned by reason on the health detail | ✅ | `gated-captures.ts`; `health.ts` capture block; increment `capture-handler.ts:329` | Named tests (increments; block omitted when unwired) |

### PRD-073c sub-ACs

| # | Plan Requirement | Status | Implementation Location | Notes |
|---|---|---|---|---|
| AC-073c.1.1 | Multi-org: authentication completes, NO file written, pending read reports the org list | ✅ | `makePendingLinkRunner` parks; `TenancySelectionRequiredError` | Named test + route tests (pending body, orgs list) |
| AC-073c.1.2 | Valid select: mint for the chosen org, persist pair + marker, ack `{ selected, org, workspace, reminted }` | ✅ | select route `setup-tenancy.ts:412-458`; `persistSelectedTenancy` | Named tests (route and issuer); D-4 no-token-in-ack asserted |
| AC-073c.1.3 | Off-list selection rejected 400, nothing persisted | ✅ | `setup-tenancy.ts:422-435`; create-path guard `:470-474` (added this audit) | Named tests for select AND (new) create |
| AC-073c.1.4 | Restart mid-pending degrades safely (memory-only token) | ⚠️ | single-slot store `setup-tenancy.ts:169-189` | Restart-loss named test passes; the TTL-expiry branch is untested (Warning) |
| AC-073c.2.1 | Single-tenancy auto-select + marker + surfaced | ✅ | `computeAutoSelection`; runner auto-select branch | Named test |
| AC-073c.2.2 | Env pins select with existing precedence + marker + surfaced | ✅ | pins branches of `resolveTenancyChoice` | Named test |
| AC-073c.3.1 | Pending link + bindings: capture gates `tenancy_unconfirmed` | ✅ | gate ladder order (tenancy first) | Named test |
| AC-073c.3.2 | Pre-073 credential reads confirmed, capture unchanged | ✅ | `resolveTenancyConfirmation` grandfather branch | Named tests (incl. legacy `~/.honeycomb` fallback via `loadDiskCredentials`) |

### PRD-073d sub-ACs

| # | Plan Requirement | Status | Implementation Location | Notes |
|---|---|---|---|---|
| AC-073d.1.1 | TTY multi-org: org picker then workspace picker, persist + marker, print; no credential before the choice | ✅ | `buildTenancySelector` / `promptPick` in `src/cli/auth.ts` | Named test (scripted prompts) |
| AC-073d.1.2 | `--org` given, multiple workspaces: only the workspace prompt renders | ⚠️ | `resolveOrg` flag branch (no prompt) + `resolveWorkspace` prompt | Implemented; NO named test (Warning) |
| AC-073d.2.1 | Non-TTY, no flags, no pins, multi-org: hard error naming orgs + flags, nothing written | ✅ | `refusalMessage`; refusal throw in `resolveOrg`/`resolveWorkspace` | Named test (exit non-zero, no file, `--org` in the message) |
| AC-073d.2.2 | Flags resolve by name or id; unknown value exits non-zero, nothing written | ✅ | `resolveOrg`/`resolveWorkspace` match logic | Named tests (name+id resolution; unknown refuses) |
| AC-073d.3.1 | Single-tenancy auto-select prints "Using org X, workspace Y" | ✅ | `loginWithDeviceFlow` reporter line | Named test |
| AC-073d.3.2 | Env pins succeed non-TTY, printed | ✅ | pins short-circuit before the selector | Named test; headless `--token` matrix also tested |

### Non-Goals (verified untouched)

| # | Non-Goal | Status | Notes |
|---|---|---|---|
| NG-1 | Hive onboarding UI | 🟦 | No hive-repo file in this diff (hive work is the parallel PRD; audit scope is honeycomb only) |
| NG-2 | `~/.deeplake/projects.json` schema / bind flow | 🟦 | `project-resolver.ts`, `onboarding-api.ts` unmodified |
| NG-3 | Recall / read paths | 🟦 | No recall/context/dashboard-read file in the diff |
| NG-4 | `~/.apiary` state-root migration (PRD-072) | 🟦 | No file moved; no state-root change |
| NG-5 | Multi-org token federation / `org switch` mechanics | 🟦 | `src/cli/org.ts`, `scope-switch-api.ts` unmodified |
| NG-6 | Retroactive cleanup of wrong-org / inbox rows | 🟦 | No migration/pruning code |

## `npm run ci` output

Run by this auditor on the final tree (after the Low-1 guard + test landed). Exit code 0; typecheck, jscpd duplication, vitest, and the SQL-safety audit all pass.

```
Test Files  394 passed (394)
     Tests  4184 passed | 12 skipped (4196)
  Duration  17.05s

> @legioncodeinc/honeycomb@0.3.0 audit:sql
> node scripts/audit-sql-safety.mjs

SQL-safety audit: scanned 296 file(s) under src/daemon, src/daemon-client/
OK - every SQL interpolation routes through an escaping helper.
```

(The pre-fix baseline was 4183 passed; the +1 is the new create-path guard test.)

## Files Changed

- `library/requirements/backlog/prd-073-dormant-capture-and-explicit-tenancy/prd-073c-...-link-time-tenancy-selection.md` (M), orchestrator-reconciled `selected` semantics + `confirmedBy` on the canonical contract
- `src/cli/auth.ts` (M), PRD-073d tenancy selector: TTY numbered pickers, `--org`/`--workspace` resolution, non-TTY refusal, injectable prompt/TTY seams
- `src/daemon/runtime/assemble.ts` (M), wires `boundProjectGate`/inbox flag/tenancy seam/gated counter into capture, the pending-link runner into `/setup/login`, mounts `/setup/tenancy*` local-mode only, live dormancy probes on the health detail
- `src/daemon/runtime/auth/credentials-store.ts` (M), additive `tenancyConfirmedAt` field on `DiskCredentials`
- `src/daemon/runtime/auth/deeplake-issuer.ts` (M), two-phase split: `authenticateDeviceFlow`, `resolveTenancyChoice` (pins > auto-select > selector > refusal), `persistSelectedTenancy` (re-mint for the CHOSEN org + marker), `createWorkspace` client call, `TenancySelectionRequiredError`
- `src/daemon/runtime/auth/index.ts` (M), barrel exports for the new tenancy surface
- `src/daemon/runtime/auth/status-api.ts` (M), additive `tenancyConfirmed` / `tenancyConfirmedAt` on `/api/auth/status`
- `src/daemon/runtime/auth/tenancy-confirmation.ts` (A), the ONE effective-confirmation predicate (marker OR grandfathered non-empty orgId) + the `isTenancyConfirmed` gate seam
- `src/daemon/runtime/capture/attach.ts` (M), threads the new gate deps through the hooks attach surface
- `src/daemon/runtime/capture/capture-config.ts` (M), `resolveInboxCaptureEnabled` (`HONEYCOMB_INBOX_CAPTURE`, default OFF, malformed reads OFF)
- `src/daemon/runtime/capture/capture-handler.ts` (M), the per-session dormancy gate ladder (tenancy first, then bound-project), reasoned gated acks, resolve-once scope reuse
- `src/daemon/runtime/capture/gated-captures.ts` (A), the per-reason gated-captures counter
- `src/daemon/runtime/dashboard/setup-tenancy.ts` (A), the `/setup/tenancy*` route family, pending-link store (TTL), pending-link runner, workspace-create route (+ the Low-1 enumerated-org guard added by this audit)
- `src/daemon/runtime/health.ts` (M), dormancy reason codes + guidance strings + gated-counts block on the health detail
- `src/hooks/runtime.ts` (M), swaps in `createSessionBindNoticeGate` as the production notice gate
- `src/hooks/shared/capture.ts` (M), threads the daemon's gated-ack reason into the shim result (old-shape acks degrade to plain ok)
- `src/hooks/shared/contracts.ts` (M), additive optional `noticeText` on `OnboardingNoticeGate`
- `src/hooks/shared/index.ts` (M), exports the new notice gate + cwd notice
- `src/hooks/shared/session-start.ts` (M), `BIND_PROJECT_CWD_NOTICE` + the per-session notice gate (cwd-specific vs workspace-level copy, inbox-on suppression, fail-soft)
- `tests/cli/auth-tenancy.test.ts` (A), 073d AC matrix
- `tests/daemon/runtime/auth/deeplake-issuer.test.ts` (M), single-tenancy auto-select supersedes the `"default"` guess; disk shape gains the marker
- `tests/daemon/runtime/auth/status-tenancy.test.ts` (A), status confirmation matrix
- `tests/daemon/runtime/auth/tenancy-selection.test.ts` (A), 073c issuer-level AC matrix
- `tests/daemon/runtime/capture/capture-bound-project-gate.test.ts` (A), 073a + 073c-tie AC matrix
- `tests/daemon/runtime/dashboard/setup-tenancy.test.ts` (A), the canonical route contract suite (+ the new create-path guard test)
- `tests/daemon/runtime/health-dormancy.test.ts` (A), 073b health/counter matrix
- `tests/hooks/shared/capture-gated-reason.test.ts` (A), shim reason threading
- `tests/hooks/shared/session-bind-notice.test.ts` (A), per-session notice matrix
