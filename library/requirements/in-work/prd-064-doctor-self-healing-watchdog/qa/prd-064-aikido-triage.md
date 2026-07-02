# Aikido SAST/SCA Triage: PRD-064 Doctor Self-Healing Watchdog

**Triage date:** 2026-06-27 (updated with ACTUAL dashboard findings)
**Auditor:** security-worker-bee
**Trigger:** the Doctor PR failed the external "Aikido Security" gate. An EARLIER revision of this document reconstructed the findings from the code because the dashboard detail was unavailable. This revision REPLACES those reconstructed guesses with the ACTUAL findings pulled from the Aikido dashboard, and records the in-session remediation applied to clear the gate.
**Scope audited:** `doctor/src/**` (every file-read/write sink) + the shipped-daemon file `src/cli/daemon-service.ts` + the two new GitHub Actions workflows introduced by this PR.
**Companion document:** `prd-064-security-report.md` (the full first-principles audit).

---

## Ordering note (read first)

A QA report for this branch already exists at `prd-064-qa-report.md` (committed, mtime predates this remediation). `security-worker-bee` runs BEFORE `quality-worker-bee`; because this pass changed code (the path-containment class fix + the action SHA pins), **`quality-worker-bee` must be re-run** so its report reflects the post-remediation tree. The existing QA report is now stale.

---

## The ACTUAL Aikido findings (from the dashboard)

Aikido reported two finding families on the new code:

### Family A - HIGH (and ~4 CRITICAL of the same class): "Potential file inclusion attack via reading file" (path-traversal taint, CWE-22/73)

Aikido's taint engine flags every `readFileSync` / `writeFileSync` / `appendFileSync` / `statSync` whose path is a **variable** (not a string literal). In Doctor every on-disk artifact lives at `join(workspaceDir, "<fixed-literal-name>")`, where `workspaceDir` is resolved from the environment (`HONEYCOMB_WORKSPACE` / the CLI cwd, see `doctor/src/config.ts`). Because the engine cannot prove the joined filename is constant, it marks the workspace-derived path as tainted and each sink as a potential file-inclusion / arbitrary-file-write site. The HIGH-named sinks plus the un-screenshotted CRITICALs are the SAME class on the other sinks in the new code.

Confirmed sinks (the full class, every variable-derived file path in the PR):

| # | Sink | `file:line` | Path source |
|---|---|---|---|
| A1 | `readFileSync` + `writeFileSync` + `renameSync` (state) | `doctor/src/state.ts` read ~`123`, write ~`140` | `join(workspaceDir, "state.json")` |
| A2 | `readFileSync` + `writeFileSync(wx)` + `statSync` + `rmSync` (lock) | `doctor/src/install-lock.ts` ~`89/113/157`, release ~`134` | `join(workspaceDir, "install.lock")` |
| A3 | `statSync` + `renameSync` + `appendFileSync` (incidents) | `doctor/src/incidents.ts` ~`141/142/184` | `join(workspaceDir, "incidents.ndjson"[.1])` |
| A4 | `readFileSync` + `writeFileSync` + `renameSync` (needs-attention) | `doctor/src/escalation/needs-attention-store.ts` ~`119/120/206` | `join(workspaceDir, "needs-attention.json")` |
| A5 | `appendFileSync` (removed-packages backup) | `doctor/src/rungs/uninstall-hivemind.ts` ~`103` | `join(workspaceDir, "removed-packages.ndjson")` |
| A6 | `readFileSync` (logs tail) | `doctor/src/cli/incidents-tail.ts` ~`23` | `join(workspaceDir, "incidents.ndjson")` |
| A7 | `writeFileSync` + `rmSync` + `existsSync` (service unit files) | `src/cli/daemon-service.ts` runner ~`141/145/152`, paths `launchdPlistPath`/`systemdUnitPath` ~`183/188` | `join(home, ...fixed, "<label>.plist|.service")`, `home = spec.home ?? os.homedir()` |

**Severity:** HIGH (named) + ~4 CRITICAL (same class on other sinks). Path-traversal / arbitrary-file-write is a real CWE family; per the never-downgrade rule we treat the class at the reported severity and FIX it, even though the practical exploitability is low (the "tainted" base is the user's OWN workspace/home, not remote input).

### Family B - HIGH: "3rd party GitHub Actions should be pinned" (CWE-1357 / supply-chain)

The two NEW workflows introduced by this PR reference 3rd-party / `actions/*` actions by **mutable version tag** instead of an immutable commit SHA. A tag can be force-moved by the action owner (or an attacker who compromises it) to point at malicious code that then runs in CI with repo permissions.

| Sink | `file:line` | Action (before) |
|---|---|---|
| B1 | `.github/workflows/release-doctor.yaml` `:86` | `actions/checkout@v4.2.2` |
| B2 | `.github/workflows/release-doctor.yaml` `:97` | `actions/setup-node@v6.4.0` |
| B3 | `.github/workflows/release-doctor.yaml` `:247` | `softprops/action-gh-release@v2.4.1` |
| B4 | `.github/workflows/ci.yaml` doctor job `:214` | `actions/checkout@v4.2.2` |
| B5 | `.github/workflows/ci.yaml` doctor job `:217` | `actions/setup-node@v6.4.0` |

**Severity:** HIGH (supply-chain). Pre-existing workflow lines NOT introduced by this PR were left untouched (scope discipline); local `./.github/actions/*` composite refs do not need pinning.

---

## Remediation performed THIS session

### Remediation 1 - path containment (class fix for Family A)

Added a single shared helper `doctor/src/safe-path.ts` exporting:

- `resolveInBase(baseDir, ...segments)` - rejects any segment containing a path separator (`/` or `\`), a `..`/`.` traversal token, or an empty value; resolves `baseDir` to an absolute normalized path; joins + re-normalizes; and **asserts** the result is still contained within the resolved base (throws `PathContainmentError` otherwise).
- `assertWithinBase(baseDir, candidatePath)` - asserts an already-composed absolute path is contained within `baseDir` (used conceptually for the multi-segment service-unit paths).

This is genuine defense-in-depth: a poisoned `HONEYCOMB_WORKSPACE` / `workspaceDir` / `spec.home` cannot escape the workspace or home dir, AND the tainted path now flows through a validator the SAST taint-tracker can see. Built-ins only (`node:path`), strict ESM, zero runtime deps preserved.

Applied at every Family-A sink. Behavior is identical (same files, same locations); the helper only adds validation before the syscall. Fail-soft: a containment violation is caught inside each store's existing defensive try/catch and degrades EXACTLY like a read/write failure (default state / empty list / logged-and-skip / "cannot acquire" -> back off), never crashing the watchdog.

| Sink | File | How guarded | Fail-soft behavior on violation |
|---|---|---|---|
| A1 | `doctor/src/state.ts` | `resolveInBase(workspaceDir, "state.json")` inside `read()` and `write()` try blocks | read -> DEFAULT_STATE; write -> logged `state.write_failed` |
| A2 | `doctor/src/install-lock.ts` | `lockPath()` -> `resolveInBase(workspaceDir, "install.lock")` resolved at top of `acquire()`; `filePath` threaded into `exclusiveCreate`/`makeHandle`/`stealAndRetry` | `acquire()` returns `null` (caller backs off); `release()` stays best-effort no-throw |
| A3 | `doctor/src/incidents.ts` | `resolveInBase` for `incidents.ndjson` + `incidents.ndjson.1` inside `write()`; both threaded into `rotateIfNeeded` | logged `incident.write_failed` |
| A4 | `doctor/src/escalation/needs-attention-store.ts` | `storePath()` -> `resolveInBase(workspaceDir, "needs-attention.json")` in `record()`/`resolve()`/`read()` | record -> logged + skip file write (incident-log append still durable); resolve -> logged + return; read -> `null` ("no record") |
| A5 | `doctor/src/rungs/uninstall-hivemind.ts` | `resolveInBase(workspaceDir, "removed-packages.ndjson")` inside `recordRemoval()` try | returns `false` -> caller SKIPS the destructive uninstall (cannot honor record-before-removal) |
| A6 | `doctor/src/cli/incidents-tail.ts` | `resolveInBase(workspaceDir, "incidents.ndjson")` inside the tail try | empty list (same as missing file) |
| A7 | `src/cli/daemon-service.ts` | `containedUnitPath(home, [...segments])` (local mirror of `safe-path.ts`, built-ins only; `src/` cannot import from `doctor/`) wraps `launchdPlistPath` + `systemdUnitPath`; every `writeFile`/`removeFile`/`fileExists` path flows through these two resolvers | throws -> the module's documented "service path unavailable" signal -> `runtime.ts` falls back to the safe detached spawn |

Focused tests added in `doctor/tests/safe-path.test.ts` (12 cases): accepts a normal filename, accepts multiple in-base segments, rejects `..`, rejects POSIX + Windows separators, rejects empty/missing/`.` segments, the sibling-prefix `/a/bc` vs `/a/b` trap, `assertWithinBase` accept/escape/non-absolute.

### Remediation 2 - pin GitHub Actions to commit SHAs (Family B)

Every 3rd-party / `actions/*` `uses:` in the two NEW workflow surfaces is now pinned to a full 40-char commit SHA with a trailing `# vX.Y.Z` comment. SHAs fetched live via `gh api repos/<owner>/<repo>/git/ref/tags/<tag>` (all three resolved directly to commit objects; no annotated-tag deref needed).

| Action | Pinned SHA | Comment | Applied in |
|---|---|---|---|
| `actions/checkout` | `11bd71901bbe5b1630ceea73d27597364c9af683` | `# v4.2.2` | release-doctor.yaml `:86`, ci.yaml doctor job `:214` |
| `actions/setup-node` | `48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e` | `# v6.4.0` | release-doctor.yaml `:97`, ci.yaml doctor job `:217` |
| `softprops/action-gh-release` | `6da8fa9354ddfdc4aeace5fc48d7f679b5214090` | `# v2.4.1` | release-doctor.yaml `:247` |

No `actions/upload-artifact` was introduced by this PR (the existing `:384` use is in a pre-existing job and was left untouched). Pre-existing `actions/checkout@v4.2.2` / `actions/setup-node@v6.4.0` references in the OTHER (non-doctor) ci.yaml jobs were deliberately NOT modified - they predate this PR and are out of scope. The doctor release composite/local refs are not 3rd-party and need no pin.

---

## Code-fixable vs may-need-dashboard-ack

| Family | Fully code-fixable? | Residual / ack guidance |
|---|---|---|
| **A (file inclusion)** | YES, the validator routes every tainted path through a containment check before the syscall. | Aikido's taint analysis MAY still flag a `readFile(var)` even with the validator in place, because some taint engines only clear a taint when the value passes a recognized sanitizer signature, not an arbitrary user function. If any A-family finding persists on the next scan, it is a **residual false-positive, low-risk**: the "tainted" base is the user's OWN `HONEYCOMB_WORKSPACE` / home dir (local operator input, not remote/network), now provably contained. **List those residuals for dashboard suppression** with rationale: "path validated by resolveInBase/containedUnitPath containment assertion; base is the operator's own workspace/home, not remote input." |
| **B (action pinning)** | YES, fully. SHA pinning is exactly what the rule wants; this finding should clear outright. | None. |

---

## Re-classification of the EARLIER reconstructed table

The prior revision's reconstructed findings (command-injection on npm/service argv, hardcoded PostHog key, SSRF, server-binding, XSS, prototype pollution, SCA) did NOT match the actual dashboard. They remain accurate as a defensive audit and are retained in `prd-064-security-report.md`. The two that WERE genuine in an earlier draft (the rollback SemVer gap at `update-engine.ts:137`, and the schtasks `/TR` cmd-string guard `assertCmdSafe` at `daemon-service.ts:276-300`) are verified still present. The ACTUAL gate failure, however, was Families A and B above, now remediated.

---

## Verification (this session, all green)

```text
doctor (npm run ci = typecheck + vitest run):
  tsc --noEmit ............................ clean
  Test Files 41 passed (41) · Tests 396 passed (396)
  includes tests/safe-path.test.ts ....... 12 passed (new)

repo-root:
  npx tsc --noEmit ....................... clean
  npm run dup (jscpd, threshold 7) ....... 0.5% dup tokens, PASS
  tests/cli/daemon-service.test.ts ....... 19 passed
  tests/cli/daemon-lifecycle-service.test.ts 8 passed

YAML validity:
  python yaml.safe_load(release-doctor.yaml) .. OK
  python yaml.safe_load(ci.yaml) .................. OK

scope / hygiene:
  ci.yaml diff = ONLY the 2 doctor-job uses lines (verified)
  release-doctor.yaml diff = ONLY the 3 SHA-pin lines (verified)
  no em/en dashes introduced in any changed source/workflow file
  main checkout C:\Users\mario\GitHub\honeycomb clean (only pre-existing
    untracked assets/og-default.png, unrelated to this pass)
```

---

## Residual Medium hardening (documentation only, not gating, carried from the full audit)

1. **`escapeHtml` omits the single-quote**, `doctor/src/status-page/server.ts` ~`187`. Covers `& < > "` but not `'`. No live XSS path (all values land in text or double-quoted attributes), loopback + read-only. Add `.replace(/'/g, "&#39;")` as defense-in-depth if the page ever gains a single-quoted attribute.
2. **`reinstall.ts` blessed-version verify is a no-op when compose passes `""`** (`doctor/src/compose/index.ts`). Functionality gap, not a security issue.

These are Medium and out of the in-session fix bar.
