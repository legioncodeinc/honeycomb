# EXECUTION LEDGER — PRD-012 Secrets

> /the-smoker run. Branch `prd-012-secrets` off main (PRD-001..011 + CI merged). PR → main.

**Scope:** index + 012a (machine-bound encrypted secrets store + names-only API + NDJSON audit) / 012b (`secret_exec` subprocess with redacted output + Bitwarden/1Password by reference). 12 sub-ACs + 3 index ACs. The thesis: **an agent can CAUSE a secret to be used but NEVER receives the decrypted value** — so a prompt injection can't exfiltrate `OPENAI_API_KEY`. Secrets are the one data class that does NOT live in DeepLake; they sit encrypted on the daemon host. **Makes PRD-010's `SecretResolver` seam real.**

**Builds on:**
- PRD-010 `inference/contracts.ts` `SecretResolver { resolve(ref): Promise<string> }` seam — the router (`router.ts:392/437`) resolves `account.apiKeyRef` to a key for an in-process provider call (value lives only in a local var, never logged/returned to an agent). 012a provides the REAL resolver. This is the ONE legitimate internal decrypt consumer; no agent-facing surface returns a value.
- PRD-004 server `/api/secrets` route group (ALREADY in ROUTE_GROUPS, `protect:true`) — handlers attach via `daemon.group("/api/secrets")`. PRD-011 RBAC gates it (the secrets capability is grantable).
- PRD-011 `credentials-store.ts` 0600-file pattern (mirror for `.secrets/` perms) + the auth NDJSON-audit shape. PRD-005 capped-counter / PRD-011 bounded-pool DoS posture (the exec pool).
- No DeepLake (data model: NONE). No jwt/nacl dep yet → add an audited XSalsa20-Poly1305 lib (`@noble/ciphers` `xsalsa20poly1305` recommended — zero-dep, audited; `tweetnacl` `secretbox` acceptable; both = libsodium `crypto_secretbox_easy`). External vaults (Bitwarden/1Password) are a SEAM (fake in tests — no vault creds in this env).

## Verification posture
Vitest (no DeepLake, no network): crypto round-trip (encrypt→decrypt); machine-bound — a DIFFERENT `MachineKeyProvider` (simulating another host) → Poly1305 auth FAILS to decrypt (AC-1/012a-AC-3); `.secrets/` files 0600 (POSIX-guarded, win32 best-effort); names-only API via `app.request` — list returns names, NO `GET :name` value endpoint exists (AC-2/012a-AC-2/AC-5); NDJSON audit appended with secret fields redacted (012a-AC-4); scope isolation (an agent lists only its scope, 012a-AC-6); `secret_exec` — real `child_process.spawn` of a test command (e.g. `node -e`) with resolved secrets in env, stdout/stderr `[REDACTED]` substitution (AC-3/012b-AC-2), timeout kill (5min default/30max) → terminal status + redacted partial output (012b-AC-1/AC-5), 202 queue + `GET exec/:jobId` redacted status (012b-AC-3), bounded pool → excess queues (012b-AC-6), Bitwarden/1Password resolve via a fake provider seam by reference, not duplicated into `.secrets/` (012b-AC-4). Out of scope: real vault APIs (seam), OS keychain/passphrase backends (Non-Goal), making secrets recallable (forbidden).

## Decisions (defaults)
| # | Q | Decision |
|---|---|---|
| D-1 | cipher | XSalsa20-Poly1305 (`crypto_secretbox_easy`) — combined mode, 24-byte random nonce per write, 32-byte key. Add `@noble/ciphers` (xsalsa20poly1305) or tweetnacl. |
| D-2 | key derivation | machine-bound: derive the 32-byte key from a stable machine identifier (Linux `/etc/machine-id`, macOS IOPlatformUUID, win `MachineGuid`) via HKDF/scrypt, behind a `MachineKeyProvider` SEAM (injectable for the "different host" test). Fallback: a generate-once machine key stored OUTSIDE `.secrets/` (so copying `.secrets/` alone yields nothing). |
| D-3 | storage | one file per secret under `$HONEYCOMB_WORKSPACE/.secrets/` (dir 0700, files 0600), `{nonce, ciphertext}`. No plaintext, no reversible form ever on disk. |
| D-4 | API surface | `/api/secrets` GET (names ONLY), `POST /:name` (set), `DELETE /:name`, `POST /exec`, `GET /exec/:jobId`, `…/bitwarden/*`, `…/1password/*`. **NO `GET /:name` value endpoint — by design.** Names exposed everywhere; values NOWHERE (API/SDK/MCP/dashboard/diagnostics). |
| D-5 | resolver | the real `SecretResolver` (010 seam) decrypts in-process for the router ONLY; the value never leaves the daemon process, never logged, never returned to an agent surface. |
| D-6 | secret_exec | submit → 202 + jobId; spawn subprocess with resolved secrets in env; bounded pool (excess queues — D-7 DoS); timeout 5min default / 30 max → kill → terminal status; redact EVERY known secret value (substring) from stdout+stderr → `[REDACTED]` before any caller sees it; never a raw credential in output/status. |
| D-7 | audit | every secret op appends an NDJSON event under `.daemon/` with sensitive fields redacted (name + op + scope + ts; NEVER the value). |
| D-8 | providers | Bitwarden/1Password integrate BY REFERENCE via a `VaultProvider` SEAM (fake in tests): an exec job resolves a vault ref at use-time, the value is NOT duplicated into `.secrets/`. |

## Scaffold/seam plan
Wave 1 (012a): secrets contracts (`SecretName`, `SecretRecord`, `MachineKeyProvider` seam, `VaultProvider` seam, audit event) + the machine-bound `crypto` module (keygen/encrypt/decrypt) + the `.secrets/` store (set/list-names/delete, 0600) + the names-only `/api/secrets` API handlers + NDJSON audit + scope isolation + the REAL `SecretResolver` impl (wires 010) + 012b stub + CONVENTIONS.md. Wave 2 (012b): `secret_exec` (pool + spawn + env + redaction + timeout + 202/status) + vault provider-by-reference. Single Wave-2 sub-feature → serial, not parallel.

---

## AC Ledger (12 sub-ACs + 3 index)

### 012a Secrets Store — Wave 1 (`typescript-node-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| a-AC-1 | Stored secret → `crypto_secretbox_easy` ciphertext + random nonce under `.secrets/` at 0600. | VERIFIED |
| a-AC-2 | API list → names ONLY; no value-returning endpoint exists. | VERIFIED |
| a-AC-3 | `.secrets/` copied to another host → decrypt FAILS (machine-bound key differs). | VERIFIED |
| a-AC-4 | Any secret op → NDJSON audit event under `.daemon/` with sensitive fields redacted. | VERIFIED |
| a-AC-5 | Read a value via SDK/MCP/dashboard/diagnostics → NO decrypted value ever returned. | VERIFIED |
| a-AC-6 | Two agents in one workspace → one lists only its own scope's secrets. | VERIFIED |

### 012b secret_exec — Wave 2 (`typescript-node-worker-bee`)
| ID | Criterion | Status |
|---|---|---|
| b-AC-1 | `secret_exec` → queues (202), spawns subprocess with resolved secrets in env, enforces timeout (5min default/30 max). | VERIFIED |
| b-AC-2 | Command emits a secret to stdout/stderr → every occurrence → `[REDACTED]` before the caller sees it. | VERIFIED |
| b-AC-3 | `GET /api/secrets/exec/:jobId` → status + redacted output, NEVER a raw secret. | VERIFIED |
| b-AC-4 | Bitwarden/1Password ref → value pulled from the vault by reference, NOT duplicated into `.secrets/`. | VERIFIED |
| b-AC-5 | Job exceeds timeout → killed → terminal status + redacted partial output, no raw credential. | VERIFIED |
| b-AC-6 | Concurrent exec beyond pool size → excess jobs QUEUE rather than overwhelm the host. | VERIFIED |

### Index roll-ups
| Index AC | by | Status |
|---|---|---|
| AC-1 store copied to another machine → undecryptable (machine-bound) | a-AC-3 | VERIFIED |
| AC-2 every surface exposes names never values | a-AC-2, a-AC-5 | VERIFIED |
| AC-3 secret_exec output → secret values `[REDACTED]` | b-AC-2 | VERIFIED |

**Totals:** 15 ACs (12 sub + 3 index) · **15 VERIFIED** · 0 OPEN — fully VERIFIED (crypto/machine-binding/names-only-API/audit/scope + secret_exec redaction/timeout/pool all unit-proven; no DeepLake surface), close-out unlocked.

## Wave plan
```
Wave 1 (012a store + crypto + names-only API + audit + SecretResolver + 012b stub) ──► Wave 2 (012b secret_exec + vault refs) ──► Wave 3 (security → quality) ──► Ship
```
- Wave 1 · `typescript-node-worker-bee` opus — secrets contracts + seams, machine-bound XSalsa20-Poly1305 crypto, `.secrets/` 0600 store, names-only `/api/secrets` API, NDJSON audit, scope isolation, the real `SecretResolver`, 012b stub, CONVENTIONS.md. Add the crypto dep.
- Wave 2 · `typescript-node-worker-bee` opus — `secret_exec` (bounded pool, spawn+env, stdout/stderr `[REDACTED]`, timeout kill, 202+status) + Bitwarden/1Password VaultProvider-by-reference.
- Wave 3 · `security-worker-bee` (opus — THE secrets layer; audit hardest: no value on ANY surface/log/audit, machine-binding real, 0600, redaction can't be evaded, no command injection via exec, no secret in env-dump/error, vault refs not duplicated) → `quality-worker-bee` (sonnet).

## Watchdog / event log
- PRDs 001–011 merged (11 done); main GREEN incl. gated live job (PRD-011 api_keys revoke fix held). PRD-012 moved→in-work, branched off main (d649870).
- Infra scan: `/api/secrets` group scaffolded; PRD-010 `SecretResolver` seam is the integration target; NO DeepLake (data model none → no live DL test); no machine-id/.secrets code yet (net-new); crypto dep to add. Wave 1 dispatched.
- Wave 1 DONE (012a, opus): `@noble/ciphers` `xsalsa20poly1305` (= crypto_secretbox_easy); machine-bound HKDF-SHA256 key (machineId + scope in `info` → cross-scope isolation; OS readers + generate-once fallback key OUTSIDE `.secrets/`); `.secrets/` store 0600/0700 `{nonce,ciphertext}` no-plaintext; names-only `/api/secrets` API — NO `GET /:name` value route (the absence IS the property); redacted NDJSON audit; scope isolation; real `createSecretResolver` (the ONLY internal decrypt path, router-only); 012b stub honest 501. SecretName traversal-proof. a-AC-1..6 VERIFIED. ci=0 (823). Pinned seams: `MachineKeyProvider`/`VaultProvider`/`SecretResolver`, `SecretName` validation.
- Wave 2 DONE (012b, opus): `SecretExecRunner` — `POST /exec`→202+jobId (429 on full queue), spawn `shell:false` (no shell-injection; hostile-arg test proves inert), resolved secrets in child env only, `RollingRedactor` redacts every secret value over the FULL buffer (chunk-boundary-safe — the Bee caught+fixed a real boundary bug its own tests exposed), `GET /exec/:jobId` scoped redacted status, timeout clamp 5min/30max + SIGTERM→SIGKILL(2s grace)→`timed_out`+redacted partial, bounded pool(4)+FIFO queue(64) DoS guard, vault-by-reference via `VaultProvider` seam NOT duplicated into `.secrets/`, redacted audit. b-AC-1..6 VERIFIED. Orchestrator root-verify: ci=0 (841/4-skip), build/audit:openclaw/audit:sql=0, invariant 3/3, secrets 58 tests, 0 console.* in secrets, shell:false confirmed.
- All 15 ACs VERIFIED. Daemon-assembly wiring deferred+documented (mount the secrets API, inject the real SecretResolver into the router). Wave 3 (security → quality) dispatched — THE secrets layer; security audit paramount.
