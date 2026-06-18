# Secrets module — CONVENTIONS (PRD-012)

The secrets subsystem lives under `src/daemon/runtime/secrets/` (daemon-only — it
touches `node:fs` + `node:crypto` + the workspace dir, opens NO DeepLake, builds
NO SQL, and has NO catalog table; `tests/daemon/storage/invariant.test.ts` enforces
that non-daemon roots never reach storage, and `audit:sql` stays clean because this
module emits no SQL). Wave 1 (012a) built the FULL store: contracts + seams, the
machine-bound XSalsa20-Poly1305 crypto, the `.secrets/` 0600 store, the names-only
`/api/secrets` API, the NDJSON audit, scope isolation, and the REAL `SecretResolver`
(wiring PRD-010's seam). Wave 2 (012b) fills `exec.ts` + the vault providers.

**Read this file before extending the module.** It is the contract 012b follows.

## The central thesis: an agent can CAUSE a secret to be USED but NEVER receives a decrypted value

This is the one invariant the whole PRD is built around, and the security audit's
first target. A prompt injection must not be able to exfiltrate `OPENAI_API_KEY`.

- **No value on ANY surface.** The API (`api.ts`) mounts `GET /api/secrets` (NAMES),
  `POST /api/secrets/:name` (store), `DELETE /api/secrets/:name` (delete). It
  DELIBERATELY mounts NO `GET /api/secrets/:name` and no other value-returning route
  (a-AC-2 / a-AC-5 / FR-6). The absence is the security property — a probe to
  `GET /api/secrets/:name` does not match a route → 404. A `POST` accepts a value in
  its body but the response echoes only the NAME, never the value.
- **The SINGLE decrypt-returning path is internal.** `SecretsStore.getSecretValue`
  decrypts, and `createSecretResolver` wraps it as PRD-010's `SecretResolver`. It is
  consumed ONLY by the router (`router.ts:392/437`) for one in-process provider call;
  the value lives in a local var, never logged, never on a `Target`, never in
  telemetry, never returned to an agent surface (D-5). No API handler calls it.
- **Redaction by construction.** The audit event (`SecretsAuditEvent`) carries
  name + op + scope + ts + outcome (+ count for a list). It CANNOT hold a value —
  there is no value field, exactly like PRD-010's `RedactedRoutingEvent`. Enforced at
  the WRITE boundary, not a read-time scrub (a-AC-4 / FR-7).
- **No plaintext at rest.** `SecretRecord` is `{ nonce, ciphertext, createdAt, scope }`.
  There is no plaintext field by construction (FR-2 / FR-3).

If you find yourself adding a value-returning endpoint, a value field on a contract,
or a `console.*` that could print a key/plaintext — STOP. That is the wrong direction
for this module and a Critical security finding.

## Machine binding (D-2 / a-AC-3 / FR-4 / FR-9)

The encryption key derives from a STABLE host machine identifier via the
`MachineKeyProvider` seam, so a copy of `.secrets/` moved to another host derives a
DIFFERENT key and the Poly1305 tag fails → `decrypt` returns a typed failure, never
plaintext garbage.

- `deriveKey(machineId, scope)` = HKDF-SHA256(ikm = machineId, salt = APP_SALT,
  info = "honeycomb.secrets.v1|org|workspace|agentId", len = 32). The SCOPE is folded
  into `info`, so a different scope derives a different key (cross-scope isolation on
  top of the per-scope directory).
- The real provider (`createMachineKeyProvider`) prefers an OS machine id (Linux
  `/etc/machine-id` || `/var/lib/dbus/machine-id`; macOS `IOPlatformUUID` via `ioreg`;
  win `MachineGuid` from the registry), then falls back to a generate-once 32-byte
  random key file at `~/.honeycomb/.machine-key` (mode 0600) — OUTSIDE `.secrets/`, so
  copying `.secrets/` ALONE yields nothing. Last resort: the hostname+user hint.
- The "different host" AC is a DIFFERENT provider → a different derived key → decrypt
  fails (a-AC-3). The seam is injectable; the fake is
  `createFakeMachineKeyProvider(id)`.

## The cipher (D-1 / FR-3)

XSalsa20-Poly1305 (libsodium `crypto_secretbox_easy`) via `@noble/ciphers`
(`xsalsa20poly1305`, audited, zero-dependency) — combined mode, 32-byte key,
**random 24-byte nonce per write** (no nonce reuse, no equality oracle), 16-byte
Poly1305 tag inside the ciphertext. `decrypt` translates a tag-mismatch THROW into a
typed `{ ok: false }` so a forgery can never be mistaken for a value.

## Storage discipline (a-AC-1 / FR-2 / a-AC-6)

- One file per secret at `$HONEYCOMB_WORKSPACE/.secrets/<scopeSegment>/<name>`, file
  mode `0600`, dir mode `0700` — enforced on POSIX; on win32 the bits are a documented
  best-effort no-op (NTFS ACLs apply) and the perm-assert test guards on
  `process.platform !== "win32"` (mirrors `credentials-store`).
- `SecretName` is validated traversal-proof (`[A-Za-z0-9_.-]+`, not `.`/`..`, no
  separators, ≤128 chars) so a name can never escape `.secrets/`.
- Scope → a single sanitized directory segment (`scopeSegment`), so two agents in one
  workspace are isolated by `agentId` (a-AC-6). `listSecretNames` returns names ONLY,
  from the requester's scope dir.
- The base dir + clock + `MachineKeyProvider` are all INJECTED, so a test runs against
  a temp dir with a fake provider + fixed clock — never the real workspace/home/clock.

## Secrets are NOT in DeepLake (deliberate)

Secrets are the one data class that does not live in DeepLake (data model: NONE). No
catalog table, no `ColumnDef`, no SQL, no `StorageQuery`. They sit encrypted on the
daemon host, separate from the daemon's own device-flow credentials file
(`auth/credentials-store.ts` — a different store with different rules). Do NOT add a
catalog table for secrets.

## What 012b owns (exec.ts + vault providers) — IMPLEMENTED (Wave 2)

`exec.ts` is now the real `SecretExecRunner` (build it with `createSecretExecRunner`).

- **`secret_exec` (b-AC-1 / b-AC-6):** `submit()` returns a jobId SYNCHRONOUSLY (the API
  maps it to a **202**) and queues the spawn behind a BOUNDED worker pool (`poolSize`,
  default 4). Concurrent submits beyond the pool QUEUE (bounded by `maxQueue`, default
  64); a submit when BOTH the pool and the queue are full is REJECTED with `queue_full`
  (the API → **429**) — the DoS guard, the same capped posture as `auth/rate-limit.ts`.
- **No shell (the hard rule):** the subprocess is spawned via `child_process.spawn` with
  `shell: false` and a command + **args array** (`systemSpawner`). Each arg is passed
  verbatim and is NEVER re-parsed by `/bin/sh`, so there is no shell-injection surface.
- **Resolution → env only (FR-2):** requested secret NAMES resolve through the Wave-1
  `store.getSecretValue` (the single decrypt path, consumed not edited); vault REFs
  resolve through the `VaultProvider` seam. Resolved values are injected ONLY into the
  child `env` (layered over a SANITIZED `process.env`) — never the response, a log, or
  anything persisted. A missing/undecryptable secret or unresolved vault ref FAILS the
  job closed.
- **Env hygiene — the daemon's OWN credentials are STRIPPED from the inherited env
  (security fix):** `inheritableEnv()` copies `process.env` (so PATH etc. resolve the
  executable) but REMOVES the daemon's own credential-bearing vars first
  (`isSensitiveEnvName` — exact `HONEYCOMB_DEEPLAKE_TOKEN`, plus any name containing
  `TOKEN`/`SECRET`/`API_KEY`/`PASSWORD`/`CREDENTIAL`/`PRIVATE_KEY`). WHY: those values are
  the daemon's ambient credentials (e.g. the Activeloop token read by `storage/config.ts`,
  or a provider API key) — they are NOT job-resolved, so they are NOT in the redaction
  set. Without the strip, a child that simply echoed `process.env` would leak them
  verbatim through the (un-redacted) status surface — the exact prompt-injection
  exfiltration the thesis forbids. The job's EXPLICITLY-requested secrets are layered on
  top AFTER the strip, so requesting a secret named `MY_API_KEY` still works (and is still
  redacted). Do NOT relax the strip to inherit the daemon's credentials.
- **Redaction (b-AC-2 / b-AC-3):** `RollingRedactor` ACCUMULATES the raw stdout/stderr
  into a capped buffer and redacts on read, so every occurrence of every resolved value
  → `[REDACTED]` over the FULL contiguous buffer. Because matching runs over the whole
  buffer (not per-chunk), a value split across OS read-chunk boundaries is still caught
  by construction (the chunk-boundary case). Buffer capped at `MAX_CAPTURED_BYTES` (1 MB)
  on the RAW bytes before redaction.
- **Timeout kill (b-AC-1 / b-AC-5):** `clampTimeout` → 5 min default, 30 min ceiling,
  1 ms floor. On the deadline the job is marked terminal `timed_out`, SIGTERM is sent,
  then SIGKILL after `killGraceMs` — so a runaway can never outlive its deadline. The
  view returns the redacted PARTIAL output and no raw credential.
- **Scope (FR-8 / b-AC-3):** `getStatus(jobId, scope)` returns a job ONLY to the scope
  that submitted it; a different scope gets `null` (the API → **404**, so a jobId is not
  a cross-scope oracle).
- **Vault by reference (b-AC-4):** `VaultProvider` (`contracts.ts`) resolves a
  Bitwarden/1Password ref BY REFERENCE at use-time into the child env; the value is NOT
  duplicated into `.secrets/`. The fake is `createFakeVaultProvider(table)`.
- **Audit (FR-7):** an injected `ExecAuditSink` records redacted NDJSON events
  (`resolved_for_exec` / `exec_started` / `exec_finished` / `exec_rejected`) carrying
  op + jobId + scope + outcome — NEVER a value.
- **API wiring:** `mountSecretsApi(group, { store, execRunner })` turns the `POST /exec`
  + `GET /exec/:jobId` routes into real handlers (registered FIRST so the static `/exec`
  path wins over `/:name`). Omitting `execRunner` keeps them as honest 501 stubs (the
  deferred-assembly posture). The `bitwarden/*` + `1password/*` routes never return a
  value — vault resolution happens by-reference inside a submission's `vaultRefs`.

## Daemon assembly is DEFERRED (mirrors PRD-010 / PRD-011 D-9)

Wave 1 is constructed-and-tested, not wired into the running daemon. The assembly step
(a documented TODO at `createDaemon`) will:

1. construct a `SecretsStore` with `baseDir = $HONEYCOMB_WORKSPACE`, the real
   `createMachineKeyProvider()`, and the system clock;
2. `mountSecretsApi(daemon.group("/api/secrets"), { store })` AFTER `createDaemon(...)`
   so the handlers inherit the already-mounted auth/RBAC middleware (no `server.ts`
   edit);
3. inject the real `SecretResolver` (`createSecretResolver(store, scope)`) into the
   inference router in place of the fake, so `account.apiKeyRef` resolves against the
   real `.secrets/` store — the ONE legitimate internal decrypt consumer.

Keep every export's signature stable so the assembly is a pure wiring step.
