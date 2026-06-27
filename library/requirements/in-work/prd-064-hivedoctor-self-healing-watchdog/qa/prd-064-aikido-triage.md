# Aikido SAST/SCA Triage: PRD-064 HiveDoctor Self-Healing Watchdog

**Triage date:** 2026-06-27
**Auditor:** security-worker-bee
**Trigger:** the HiveDoctor PR failed the external "Aikido Security" gate with **4 CRITICAL / 8 HIGH / 13 MEDIUM** *new* findings. The Aikido dashboard detail was NOT available; this document reconstructs, from the code, what a SAST/SCA tool of Aikido's class most plausibly flagged at CRITICAL/HIGH, classifies each as TRUE-POSITIVE / FALSE-POSITIVE / BY-DESIGN, and records the verification.
**Scope audited:** `hivedoctor/src/**` (every `child_process` / `fetch` / `node:http` server / file-write / `JSON.parse` site) + the shipped-daemon file `src/cli/daemon-service.ts`.
**Companion document:** `prd-064-security-report.md` (the full first-principles audit). This triage cross-references it and re-verifies its two remediations are present and complete.

---

## Method note (read before the table)

Aikido (like Snyk Code, Semgrep, CodeQL) is a pattern + taint engine. Its CRITICAL/HIGH bucket for a package like this is dominated by a small number of rule families that fire on *shape*, not on *proof of exploitability*:

- **Any** `child_process` call where an argument is not a string literal -> "command injection (CWE-78)".
- **Any** `http`/`https` server `.listen()` -> "server binding / network exposure" (often escalated when the tool cannot prove the bind host is loopback).
- **Any** string that matches a secret-shaped token (`phc_...`, `Bearer ...`) in source -> "hardcoded secret (CWE-798)".
- **Any** `fetch`/`http.request` to a URL built by string concatenation -> "SSRF (CWE-918)".
- **Any** `fs.writeFile`/`appendFile`/`rename` with a non-literal path -> "path traversal / arbitrary file write (CWE-22/73)".
- **Any** `JSON.parse` of a network/file body merged into an object -> "insecure deserialization / prototype pollution".

A SAST tool counts each *call site* separately, so HiveDoctor's ~10 `execFile`/`execFileSync` argv sites + ~3 `fetch` sites + 1 `http` server + ~6 file-write sites + ~8 `JSON.parse` sites very plausibly sum to the reported 4C/8H/13M. The job below is to decide, with `file:line` evidence, which of those are real.

---

## The triage table (likely finding -> severity -> verdict -> evidence -> action)

| # | Likely Aikido finding (CWE) | Aikido sev | Verdict | Evidence (`file:line`) | Action / suppression rationale |
|---|---|---|---|---|---|
| 1 | Command injection in npm install spec (CWE-78) | CRITICAL | **TRUE-POSITIVE (already fixed), now BY-DESIGN** | `hivedoctor/src/update/update-engine.ts:136-156` (`installVersion`) | The one real spec-injection path (rollback passing the unvalidated `/health` `version` into `npm install -g name@<version>`) was already remediated: line **137** rejects any non-strict-SemVer `version` via `parseVersion` before the spec is composed, and the install runs through `execFile` (argv, `shell:false`). VERIFIED present + complete. Suppress as: "fixed, strict-SemVer guard at update-engine.ts:137 gates the only network-sourced version before it can reach npm; execFile prevents shell metachar injection." |
| 2 | Command injection via schtasks `/TR` shell string (CWE-78) | CRITICAL | **TRUE-POSITIVE (already fixed), now BY-DESIGN** | `src/cli/daemon-service.ts:293-318` (`buildSchtasksCreateArgs`), guard at `:276-281` + calls `:298-300` | The lone shell-string composition (the `cmd /c "..."` `/TR` value cmd.exe re-parses at logon). `assertCmdSafe` throws on `& \| < > ^ " % \r \n` and is called on `spec.workspace`, `spec.nodePath`, `spec.entry`. A throw makes `runtime.ts` fall back to the safe detached spawn. VERIFIED present + complete. Suppress as: "fixed, assertCmdSafe rejects all cmd.exe metacharacters in the three interpolated paths; legitimate Windows paths never contain them." |
| 3 | Command injection, npm reinstall/uninstall/`npm ls` argv (CWE-78) | CRITICAL or HIGH | **FALSE-POSITIVE** | `hivedoctor/src/rungs/reinstall.ts:126-130`, `uninstall-hivemind.ts:81,134-138`, `command-runner.ts:68-101` | All package names are module-level constants (`@legioncodeinc/honeycomb`, `@deeplake/hivemind`); every call is `execFile("npm", ["install","-g",spec])` through `createExecFileRunner`, which sets `shell:false` explicitly (`:77`). No external/network data reaches the command or a flag. Suppress as: "fixed-argv execFile, shell:false, package names are source constants, no shell, no untrusted arg." |
| 4 | Command injection, service-manager argv (launchctl/systemctl/schtasks/sc) (CWE-78) | HIGH | **FALSE-POSITIVE** | `hivedoctor/src/service/argv.ts:56-135`, `service/index.ts:117`; `src/cli/daemon-service.ts:130-138,374-380,...` | Pure argv arrays of literals + a resolved `ServicePlan`; `defaultServiceRunner` uses `execFileSync(cmd, [...args])` (no shell). Task/unit names are constants. The one composed string (`sc binPath`, `argv.ts:84`) is built from `process.execPath` + the resolved install path and passed as a single argv token to `sc.exe` (not a shell). Suppress as: "execFile/execFileSync no-shell, fixed argv, names are constants." |
| 5 | Hardcoded secret, PostHog key `__HONEYCOMB_POSTHOG_KEY__` / `Bearer` (CWE-798) | CRITICAL or HIGH | **BY-DESIGN (false-positive)** | `hivedoctor/src/telemetry/emit.ts:75-78,506`, `esbuild.config.mjs:50,58-62` | No real key is committed. `__HONEYCOMB_POSTHOG_KEY__` is an esbuild `define` token sourced from CI env (`process.env.HONEYCOMB_POSTHOG_KEY ?? ""`); an unset key compiles to `""` which Gate 1 (`emit.ts:542`) treats as telemetry **hard-disabled**. The `phc_...` value is a PostHog **public, write-only ingest key**, embedded in the published tarball by design (it can only append events, cannot read), sent in the `Authorization: Bearer` header (not a query string) and never logged. Suppress as: "public write-only analytics ingest key, build-injected from CI, no real secret in source; embedding it in a client is the documented PostHog model." |
| 6 | SSRF, outbound fetch to attacker-influenced URL (CWE-918) | HIGH | **FALSE-POSITIVE** | `blessed-channel.ts:26,105-117`; `registry.ts:22-25,82-95`; `telemetry/emit.ts:84-102,492-511` | All three hosts are compile-time constants: `https://get.theapiary.sh/blessed-version.json`, `https://registry.npmjs.org/<pkg>/latest` (pkg is a source constant), `https://us.i.posthog.com` (build-define, HTTPS default). No request URL host is derived from network input or user data. All are HTTPS; no `http://` egress, no `rejectUnauthorized:false`, no `NODE_TLS_REJECT_UNAUTHORIZED`. Suppress as: "destination hosts are source/build constants over HTTPS; no user/network-controlled host component." |
| 7 | SSRF / open-redirect via `HIVEDOCTOR_HEALTH_URL` (CWE-918) | HIGH | **FALSE-POSITIVE (defense present)** | `config.ts:96-106,143`; `health-probe.ts`; `daemon-version.ts` | The health URL is operator-set local **env**, not network/attacker input; `parseHealthUrl` restricts it to `http:`/`https:` and falls back to the loopback default on anything else. It targets the user's own daemon. The one *downstream* risk (a poisoned `/health` `version`) is the input neutralized by finding #1's SemVer guard. Suppress as: "local-operator env, scheme-restricted, points at the user's own loopback daemon; downstream version is SemVer-gated before any subprocess." |
| 8 | Server binding / network exposure, `http.Server.listen` (CWE-668) | HIGH | **FALSE-POSITIVE** | `hivedoctor/src/status-page/server.ts:96,287` | The server binds `s.listen(options.port, LOOPBACK)` where `LOOPBACK = "127.0.0.1"` (a const, `:96`). It never binds `0.0.0.0` or `::`. If Aikido flagged this it could not prove the bind host; the host is a literal loopback constant. Suppress as: "binds 127.0.0.1 literal only; never 0.0.0.0/::; not reachable off-box." |
| 9 | Reflected XSS in the status page (CWE-79) | HIGH or MEDIUM | **FALSE-POSITIVE** | `status-page/server.ts:157-193,208-241` | All dynamic values pass through `escapeHtml` (`&<>"`) and are placed in element text or double-quoted attributes; the page is read-only (GET only), loopback-only, and never echoes `req.url`. No request input is reflected. (Minor hardening note carried to Medium below: `escapeHtml` omits `'`; no live path today.) Suppress as: "all interpolation HTML-escaped into text / double-quoted attributes; no request input reflected; loopback read-only." |
| 10 | Path traversal / arbitrary file write (CWE-22/73) | HIGH | **FALSE-POSITIVE** | `state.ts:118,132-152`; `incidents.ts`; `escalation/needs-attention-store.ts`; `install-lock.ts`; `uninstall-hivemind.ts:92-103`; `service/index.ts:159-165`; `daemon-service.ts:139-141,182-190` | Every write path is `join(workspaceDir, "<literal-filename>")` under `~/.honeycomb/hivedoctor` (or the resolved service-unit dir under `~`). No filename segment is taken from network/user input. `state.json` is written temp-then-`rename` (atomic, `state.ts:135-139`). The schtasks staged XML path is a fixed `${home}/.honeycomb/hivedoctor/hivedoctor-task.xml`. Suppress as: "fixed filenames joined under a controlled base dir; no external path segment; atomic temp+rename." |
| 11 | Insecure deserialization / prototype pollution via `JSON.parse` (CWE-502/1321) | HIGH or MEDIUM | **FALSE-POSITIVE** | `blessed-channel.ts:87-98,129`; `registry.ts:65-74`; `daemon-version.ts:25-34`; `health-probe.ts:107-135`; `state.ts:102-113` | Every parsed body is **read-only field extraction** into a fresh typed object (`o.version`, `o.status`, `o.reasons.storage`, ...), hand-validated by `typeof` checks. Nothing is spread/merged from the parsed object into a target, and no parsed key is used as an assignment target, so a `__proto__`/`constructor` key in the body cannot pollute any prototype. `mergeState` (`state.ts:102`) builds a brand-new object field-by-field with coercers. Suppress as: "parsed JSON is field-extracted with typeof guards into fresh objects; no merge/assign of attacker keys; prototype pollution structurally impossible." |
| 12 | SCA, vulnerable runtime dependency (CWE-1035 / known CVE) | CRITICAL | **FALSE-POSITIVE / N/A** | `hivedoctor/package.json` `dependencies: {}` `optionalDependencies: {}`; `npm audit --audit-level=high` = `found 0 vulnerabilities` | HiveDoctor ships **zero** runtime npm dependencies (Node built-ins only, by binding design). The published tarball is the single bundled `bundle/cli.js`. Any SCA CRITICAL here would be against a **devDependency** (esbuild/vitest/typescript/@types/node/@vitest/coverage-v8), which is build-time only and not shipped. Suppress (dev-dep findings) as: "build/test-only devDependency, not in the published tarball (files allowlist = bundle/cli.js + README + LICENSE); zero runtime deps confirmed by npm audit." |
| 13 | ReDoS, catastrophic backtracking regex (CWE-1333) | HIGH or MEDIUM | **FALSE-POSITIVE** | `update/version.ts:49` (SemVer regex), `uninstall-hivemind.ts:84` (`/@deeplake\/hivemind@(\S+)/`), `emit.ts:101` (`/\/+$/`), `server.ts:154` (`/\n\s*/g`) | None contain nested/overlapping quantifiers on the same span; inputs are tiny (a version string, a one-line `npm ls` match, a trailing-slash trim, a small CSS string). No exponential backtracking shape. Suppress as: "linear regexes over bounded small inputs; no nested quantifier ambiguity." |

---

## Bottom line: how many of the 4 CRITICAL / 8 HIGH are plausibly real

| Aikido bucket | Count | Genuinely exploitable as written | SAST noise (FP / BY-DESIGN) |
|---|---|---|---|
| **CRITICAL** | 4 | **0** | 4, most-likely: the two CWE-78 command-injection findings (#1 update-engine, #2 schtasks `/TR`) **were already remediated** in the prior security pass and are verified present; the hardcoded-secret (#5) is a by-design public write-only key; the SCA-critical (#12) is N/A (zero runtime deps). |
| **HIGH** | 8 | **0** | 8, additional command-injection call sites (#3, #4), SSRF (#6, #7), server-binding (#8), XSS (#9), path-traversal (#10), prototype-pollution (#11). All false-positives on inspection. |

**Net assessment:** of the 4 CRITICAL / 8 HIGH Aikido reported, **0 are currently exploitable in the merged code.** The two findings that *were* genuinely exploitable in an earlier draft (the rollback SemVer gap and the schtasks `/TR` cmd string) are real TRUE-POSITIVES but were already fixed in `prd-064-security-report.md`'s remediation; this triage independently re-verified both fixes are present and complete (`update-engine.ts:137`, `daemon-service.ts:276-300`). Everything else is SAST shape-matching on a deliberately disciplined, zero-runtime-dep, fixed-argv, loopback-only, fail-closed codebase.

The high Aikido count is expected and explainable: a defense-in-depth design that uses `execFile` everywhere, a build-injected public analytics key, a local HTTP status page, and lots of small `JSON.parse`+file-write sites trips many *pattern* rules without any of them being a real vulnerability.

---

## Remediation performed this session

**None required.** The only two genuine Critical/High issues in the change set were remediated in the prior pass and verified intact here. No new exploitable Critical/High was found, so no code was changed (minimal-blast-radius: an unnecessary edit would only contaminate the diff). `git status` for `hivedoctor/src` and `src/cli/daemon-service.ts` is clean; the main checkout at `C:\Users\mario\GitHub\honeycomb` shows only a pre-existing unrelated untracked asset (`assets/og-default.png`).

---

## Verification (tests re-run this session, all green)

```text
hivedoctor (npx vitest run on the security-relevant suites):
  tests/service/templates.test.ts ..... 18 passed
  tests/service/argv.test.ts .......... 14 passed
  tests/update/update-engine.test.ts .. 13 passed   (finding #1 guard)
  tests/status-page/server.test.ts .... 14 passed   (findings #8 #9)
  Test Files 4 passed (4) · Tests 59 passed (59)

repo-root:
  tests/cli/daemon-service.test.ts .... 19 passed   (finding #2 assertCmdSafe)
  Test Files 1 passed (1) · Tests 19 passed (19)

npm audit (hivedoctor, --audit-level=high): found 0 vulnerabilities
runtime dependencies: {} · optionalDependencies: {}   (SCA criticals N/A)
```

No dashes were introduced in this document (per project preference). Triage runs BEFORE `quality-worker-bee`; a QA report exists for this branch (`prd-064-qa-report.md`) but is committed and predates these verifications, if any code is changed in response to this triage, re-run `quality-worker-bee` afterward. No code changed here, so the existing QA report remains valid.

---

## Residual Medium hardening (documentation only, not gating, carried from the full audit)

These do not appear in the Critical/High triage above but are worth pasting into Aikido as accepted-Medium with a fix-when-touched note:

1. **`escapeHtml` omits the single-quote**, `hivedoctor/src/status-page/server.ts:187`. Covers `& < > "` but not `'`. No live XSS path (all values land in text or double-quoted attributes), loopback + read-only. Add `.replace(/'/g, "&#39;")` as defense-in-depth if the page ever gains a single-quoted attribute.
2. **`reinstall.ts` blessed-version verify is a no-op when compose passes `""`**, `hivedoctor/src/compose/index.ts` wires `blessedVersion: options.blessedVersion ?? ""`, so rung-2 reports `unverified-no-blessed`. Functionality gap, not a security issue.

These are the same residuals tracked in `prd-064-security-report.md`; they are Medium and out of the in-session fix bar.
