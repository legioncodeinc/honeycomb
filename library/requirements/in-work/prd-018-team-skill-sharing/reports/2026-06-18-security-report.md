# Security Audit — PRD-018 Team Skill Sharing

- **Branch:** `prd-018-team-skill-sharing`
- **Auditor:** security-worker-bee (Opus, Wave-3 close-out)
- **Date:** 2026-06-18
- **Scope:** the new/changed PRD-018 attack surface layered on PRD-016 skillify — filesystem + symlink + manifest machinery, the daemon publish/select SQL, scope/config persistence, and the daemon-only invariant.
- **Ordering:** correct. No `*-qa-report.md` exists under this PRD's `reports/` folder; `security-worker-bee` ran BEFORE `quality-worker-bee`. No ordering inversion.

---

## Executive Summary

PRD-018 is well-built and security-conscious: the SQL surface (`publish-endpoint.ts`, `pull-client.ts`, `skills-write.ts`) is statically constructed with every identifier through `sqlIdent` and every value through `sLiteral`/`val.*` (no caller values reach the SELECTs at all), the write-time path sanitizes every `<name>--<author>` segment, the symlink fan-out/heal correctly uses `lstat`+`readlink` containment before any `unlink`, and no token/credential is logged or persisted in config/manifest.

**One real vulnerability class was found and fixed in-session:** the on-disk pull manifest (`~/.honeycomb/state/skillify/pull-manifest.json`) is an **untrusted trust boundary** that was read back and used VERBATIM to drive destructive filesystem operations (`rmSync(..., {recursive, force})` in `unpullSkill`, and symlink link-path construction in `backfillSymlinks`). A value sanitized on write cannot be trusted after a round-trip to a user-writable file. A corrupted or hostile manifest (`installRoot` + a traversal `dirName`) yielded an **arbitrary-directory-delete** primitive and a **write-a-symlink-outside-the-roots** primitive at the privilege of the user running `honeycomb skill unpull` / auto-pull backfill.

This was remediated with a containment floor (`resolveContainedCanonicalDir`) applied at both destructive use-sites, plus 4 named adversarial regression tests. The recorded-symlink removal path (`unlinkIfOurs`) was already safe (it verifies `lstat`+`readlink` resolves to our canonical dir before unlinking) and is unchanged.

All gates re-run green after the fix. **No Critical findings. 2 High (fixed). 1 Low (documented).**

---

## Severity counts

| Severity | Count | Fixed in-session |
|---|---|---|
| Critical | 0 | — |
| High | 2 | 2 |
| Medium | 0 | — |
| Low | 1 | 0 (documented recommendation) |

---

## Findings

### H1 — Arbitrary-directory delete via hostile/corrupted pull manifest (`unpullSkill`) — HIGH — FIXED

- **File:** `src/daemon-client/skillify/install.ts:360` (`unpullSkill`), pre-fix line `rmSync(canonicalDir, { recursive: true, force: true })`.
- **Pattern:** persisted-untrusted-data → destructive filesystem op without use-time containment re-validation (AI-codegen "sanitized once at write, trusted on read" failure).
- **Exploit.** `unpullSkill` resolved `canonicalDir = join(entry.installRoot, entry.dirName)` straight from the manifest JSON. `normalizeEntry` (`manifest.ts:86`) performs type-coercion only — it never validates that `dirName` is a single safe segment or that `installRoot` is a real detected agent root. A manifest record such as `{ installRoot: "/home/me", dirName: "../important-user-data" }` (or `installRoot:"/"`, `dirName:"Users/me/Documents"`) makes `rmSync(..., {recursive:true, force:true})` recursively delete an arbitrary directory the user owns. The manifest lives at a predictable, user-writable path; any local process, a restored/synced dotfiles backup, or a path-confused earlier pull that lands content there gains the delete primitive. The ledger's "unlink safety floor goes through `linkState`" note (watchdog §) is true ONLY for the recorded *symlinks* — the `rmSync` of the canonical dir itself had no floor.
- **Remediation.** Added `resolveContainedCanonicalDir(installRoot, dirName)` which returns a path only when `dirName` is a single safe segment (`isSafeDirSegment`: no `/ \ \0`, not `.`/`..`, and byte-identical to its `canonicalDirName` per-segment sanitization) AND the resolved candidate is a DIRECT child of the resolved `installRoot` (rejects the root itself and any ancestor). `unpullSkill` now refuses (and drops the poisoned record without acting) when the guard returns `null`. Legitimate entries still round-trip.

### H2 — Symlink planted outside detected roots via hostile manifest (`backfillSymlinks`) — HIGH — FIXED

- **File:** `src/daemon-client/skillify/install.ts:309` (`backfillSymlinks`) → `fanOutSymlinks` (`:491`) `linkPath = join(root, dirName)`.
- **Pattern:** same root cause as H1 — manifest `dirName` trusted verbatim, this time feeding a `symlinkSync` link path.
- **Exploit.** `backfillSymlinks` runs at the end of every non-dry-run global pull (and via auto-pull at session start). It iterated manifest entries and called `fanOutSymlinks(otherRoots, entry.dirName, canonicalDir, [])`, where the link path is `join(root, entry.dirName)`. A manifest `dirName` of `../../../../tmp/evil` (or any traversal) plants a symlink OUTSIDE the detected agent roots, pointing at the manifest-controlled canonical dir — a write-a-symlink-anywhere primitive triggered silently on the next session start.
- **Remediation.** `backfillSymlinks` now resolves each entry's canonical dir through `resolveContainedCanonicalDir` and `continue`s past any entry that fails the containment check, so an unsafe `dirName` never reaches `join(root, dirName)`. (The per-row fan-out during a live pull is unaffected — it is fed a freshly-`canonicalDirName`-sanitized `dirName`, never a manifest value.)

### L1 — Manifest `normalizeEntry` does not drop unsafe `dirName`/`installRoot` at read time — LOW — DOCUMENTED

- **File:** `src/daemon-client/skillify/manifest.ts:86` (`normalizeEntry`).
- **Observation.** Defense-in-depth: `normalizeEntry` could additionally reject (or null-out) entries whose `dirName` is not a safe segment or whose `installRoot` is empty, so a poisoned record never even survives a `read()`. With the H1/H2 use-site containment floors now in place this is not exploitable, so it is a hardening recommendation, not a required fix. Recommend adding the `isSafeDirSegment` check to `normalizeEntry` in a follow-up to fail closed at the parse boundary as well.

---

## Threat-foci verdicts (per the audit brief)

1. **Path traversal / symlink attacks.** `sanitizeSegment` correctly neutralizes `/ \ ..` and non-`[A-Za-z0-9._-]` chars and collapses pure-dot segments to `untitled`; the symlink TARGET is always our just-written canonical dir, never attacker-controlled. The gap was that manifest-read `dirName` bypassed sanitization at the destructive use-sites (H1/H2) — **now closed**. Write-path (canonical write, `.bak` backup) uses freshly-sanitized names: clean.
2. **Destructive unlink (self-heal / unpull).** Recorded-symlink removal (`unlinkIfOurs` → `linkState`) does `lstat` (not `stat`), confirms `isSymbolicLink()`, and verifies `readlinkSync` `resolve()`-equals our canonical dir before `unlinkSync` — it never follows a link out and never touches a non-symlink/real dir. Stale-link self-heal only unlinks a path that lstat's as a symlink. Safe. The one unguarded destructive op (`rmSync` of the canonical dir from manifest data) was H1 — **fixed**. No TOCTOU of concern beyond the inherent fs race, which is bounded to the contained child path.
3. **Backup-file write safety.** `backupExisting` renames within `dirname(file)` of a sanitized canonical dir; force-overwrite writes the same contained path. Cannot escape or follow a symlink out. Clean.
4. **SQL injection (`publish-endpoint.ts` select-newer).** `buildSelectNewerSql` / `buildLatestSkillsSql` are STATIC self-joins; table + every column go through `sqlIdent` (rejects `;`, quotes, anything outside `^[a-zA-Z_][a-zA-Z0-9_]*$`); there are NO caller values in the statement (scope is applied daemon-side as a partition filter). `skills-write.ts` routes every value through `val.*` → `sLiteral`/`eLiteral`. `npm run audit:sql` clean (139 files). No hand-quoting, no parameterized-query gap. Clean.
5. **Daemon-only invariant.** All new pull/manifest/config/decideAction/guard logic stays under `src/daemon-client/skillify/`; the publish endpoint under `src/daemon/`. My fix added NO imports (reused already-imported `resolve`/`dirname`/`join`). `tests/daemon/storage/invariant.test.ts` 3/3 green post-fix. Clean.
6. **Secret/token exposure.** `createAuthCheck` reads only PRESENCE of `HONEYCOMB_TOKEN`/probe and never echoes it; disabled/unauth auto-pull paths return `null` silently with no log; no token is written into the manifest, config, or any log line; `redactSecrets` boundary is untouched by this PRD. None detected.
7. **Manifest/config injection.** Malformed/hostile JSON in config or manifest is handled defensively (`try/catch` → defaults; type-guarded coercion) and does not crash. `org`→`team` coercion (`coerceScope`) is read-only/in-memory (D-5) and cannot be abused to widen scope. The traversal-enabling gap was the destructive use of `dirName`/`installRoot` (H1/H2) — **fixed**; L1 recommends adding the same check at the parse boundary.

---

## Files changed (remediation)

| File | Change |
|---|---|
| `src/daemon-client/skillify/install.ts` | Added `isSafeDirSegment` + `resolveContainedCanonicalDir` containment guards; applied at `unpullSkill` (refuse + drop poisoned record) and `backfillSymlinks` (skip unsafe entry). No new imports; ~30 lines added, no behavior change for legitimate entries. |
| `tests/daemon-client/skillify/pull-018.test.ts` | Added 4 named adversarial regression tests (traversal `dirName` refused; installRoot-itself delete refused; backfill skips traversal entry; legit dirName still round-trips). Added `relative` to the `node:path` import. |

`git diff` confirms the remediation touches only these two files and only the security-relevant lines; no opportunistic refactoring.

---

## Post-fix gate results

| Gate | Result |
|---|---|
| `npm run ci` | **exit 0** — 1182 passed, 4 skipped, 103 files (typecheck + jscpd + vitest + audit:sql) |
| `npm run build` | **exit 0** — 1 daemon + 5 hook-harness + 1 OpenClaw + 1 MCP + 1 CLI + 1 embed-daemon bundle |
| `npm run audit:sql` | **exit 0** — 139 files scanned, every interpolation escaped |
| `npm run audit:openclaw` | **exit 0** — no findings |
| `tests/daemon/storage/invariant.test.ts` | **3/3 green** — daemon-only invariant holds |
| `tests/daemon-client/skillify/pull-018.test.ts` | **33/33 green** (28 prior + 4 new security + 1 legit-roundtrip) |

No acceptance criterion was weakened to make a gate pass. The 4 new tests are additive.

---

## VERDICT: **PASS-WITH-FIXES**

- Critical: 0 · High: 2 (both FIXED in-session) · Medium: 0 · Low: 1 (documented).
- **Fixed in-session:** H1 (arbitrary-directory delete via manifest in `unpullSkill`) and H2 (symlink-outside-roots via manifest in `backfillSymlinks`), via the `resolveContainedCanonicalDir` containment floor. Regression coverage: the four `SECURITY …` tests in `tests/daemon-client/skillify/pull-018.test.ts` (notably `"SECURITY unpull REFUSES a traversal dirName and deletes nothing outside the root"` and `"SECURITY backfill SKIPS a traversal manifest entry"`).
- Post-fix gate exit codes: `ci=0`, `build=0`, `audit:sql=0`, `audit:openclaw=0`, invariant 3/3.

**`quality-worker-bee` is CLEARED to run.**
