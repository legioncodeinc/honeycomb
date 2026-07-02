# PRD-060 ROI Tracker, Security Report

> Auditor: security-worker-bee (the-smoker close-out, penultimate step) · Date: 2026-06-26
> Branch: `legion/sharp-wilson-029812` · Verdict: **CLEAN, zero findings at any severity. No remediation required.**

## Scorecard

| Severity | Count | Remediated |
|---|---|---|
| Critical | 0 | n/a |
| High | 0 | n/a |
| Medium | 0 | n/a |
| Low | 0 | n/a |

## Verification

| Gate | Result |
|---|---|
| `npm run audit:sql` | PASS (240 files; every SQL interpolation routes through an escaping helper) |
| `tsc --noEmit` | PASS (exit 0) |
| Affected vitest suites (ROI + capture + transport + catalog + page) | 163/163 green |
| Working-tree integrity | No edits required; tree byte-identical post-audit |

## Risk-vector findings (each verified closed by construction)

1. **Outbound billing egress (`roi-billing.ts`):** bearer rides only in the `Authorization` header, never a URL or log path; `getJson` returns `null` on failure (no body-bearing error leak). Base URL is `creds.apiUrl` or the fixed `DEFAULT_DEEPLAKE_API_URL`, not response-controlled (no SSRF). Bounded: `maxRetries=3`, per-attempt 10s `AbortController` timeout, capped backoff (no retry DoS). Injectable `fetch`; sole holder of billing creds, sole egress.
2. **No-creds-in-page:** `RoiView` + page wire schemas carry only cents/labels/status/booleans; a grep for `token|secret|credential|bearer` across the daemon->page boundary found no creds-shaped field. The `unauthenticated` state renders a redacted Settings CTA; zod drops any stray `token` key.
3. **SQL injection (ledger):** `roi-ledger.ts` / `roi-session-writer.ts` / the `api.ts` rollup read route every value through `val.str`/`sLiteral`/`val.num` and identifiers through `sqlIdent`, under the caller's `QueryScope`. `audit:sql` clean.
4. **PII / per-user gate:** `resolveGatedUserId` returns a `user_id` ONLY when `claim.source === 'backend-token'`, else `''`. Negative grep `userInfo|process.env.USER|user.email|hostname|execSync` across the `roi-*` surface = zero hits; no spoofable-identity path exists. Capture widens to token COUNTS only (nullable BIGINT cols); no new prompt/response content column.
5. **Loopback / local-mode gate:** the new `/api/diagnostics/roi(/trend)` routes mount in the same `/api/diagnostics` group, scope resolution, and auth/loopback middleware as the existing view-models. No new public bind.
6. **Inference transport seam:** additive `UsageSink` surfaces token counts + model id only, never content; default no-op preserves prior behavior; sink faults swallowed; provider-key/header builder untouched.

## Handoff
Verified clean. `quality-worker-bee` ran next (final step) and returned PASS.
