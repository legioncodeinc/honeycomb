# Security Report — PRD-063c (Cohere reranking via Portkey)

> Auditor: security-worker-bee (security-stinger). Date: 2026-06-27. Branch: `legion/prd-063c-rerank` (stacked on 063b).
> Verdict: **CLEAN at Medium and above.** 0 Critical, 0 High, 1 Medium fixed in-session (doc-only). Scoped to the NEW 063c surface (063a/063b covered by `2026-06-27-security-report.md`).

## Findings

| # | Severity | Location | Issue | Disposition |
|---|---|---|---|---|
| 1 | Medium | `library/knowledge/private/security/portkey-privacy-tier.md` | The privacy-tier note covered only INFERENCE egress; 063c adds a second channel — `cohere` rerank egresses recalled memory TEXTS to Cohere via Portkey. | **FIXED** (doc-only): added the "Rerank egresses RECALL CONTENT" section. No runtime gate (opt-in + default-off twice over). |
| 2 | Pass | `rerank-portkey.ts`, `transport-portkey.ts` | `PORTKEY_API_KEY` resolved via `${SECRET_REF}` at call time, only in `x-portkey-api-key`; never logged/thrown/returned (grep-proven; c-AC-2 test). | None |
| 3 | Pass | `transport-portkey.ts` | `PORTKEY_RERANK_URL` is a fixed TLS constant; `portkey.config` rides a header, not the URL. No SSRF. | None |
| 4 | Pass | `recall.ts`, `rerank-portkey.ts` | Fail-soft un-weaponizable: bounded timeout (default 1000ms) always wins → RRF; zod-validated response; no unbounded buffering; out-of-range index filtered. No hang/DoS/crash. | None |
| 5 | Pass | `transport-portkey.ts`, `vault/api.ts`, `config.ts` | Body via `JSON.stringify`; `portkey.config` control-char-rejected at the vault boundary (063b); `cohereModel` `.min(1)`, body-only (no header injection). | None |
| 6 | Pass | whole surface | No query construction added (reranks already-fetched hits). `audit:sql` OK. | None |

## Verification

- `npx tsc --noEmit` → exit 0
- `npx vitest run tests/daemon/runtime/recall tests/daemon/runtime/memories tests/daemon/runtime/inference` → 548 passed, 0 failed
- `npm run audit:sql` → OK

## Verdict

CLEAN at Medium+. Safe to proceed to quality. The rerank data-egress is documented (conscious, default-off twice over, fail-soft); any future Honeycomb-side enforcement would be its own PRD.
