# Vault module — CONVENTIONS (PRD-032)

The vault subsystem lives under `src/daemon/runtime/vault/` (daemon-only — it touches
`node:fs` + `node:crypto` + the workspace dir, opens NO DeepLake, builds NO SQL, and has
NO catalog table; `audit:sql` stays clean because this module emits no SQL). PRD-032
Wave 1 (032a) built the multi-class core: the record-class contracts + registry, the
`(class, scope, name)` store, the COPY-not-move DeepLake-creds migration + the
vault→env→file resolver, the curated provider→model catalog, and the `/api/settings`
mount. Wave 2 fills the CLI (032b), the dashboard panel (032c), and the assembly
wire-back (032d).

**Read this file before extending the module.**

## It EXTENDS PRD-012 — no new crypto, no SQLite (D-1)

The vault reuses the PRD-012 secret primitives VERBATIM:
- `../secrets/crypto.ts` — `deriveKey` / `encrypt` / `decrypt` (XSalsa20-Poly1305,
  machine-bound HKDF key). The vault adds **zero** new cipher code.
- `../secrets/store.ts` — `createMachineKeyProvider`, `scopeSegment`, the perms
  (`SECRET_FILE_MODE` 0600 / `SECRET_DIR_MODE` 0700), `SECRETS_DIR_NAME`, `DAEMON_DIR_NAME`,
  the injectable `SecretsClock`.
- `../secrets/contracts.ts` — `SecretName` validation (`asSecretName`), `SecretScope`,
  `SecretRecord`, the `MachineKeyProvider` seam + its fake.

If you find yourself adding a cipher, a key-derivation, or a SQLite/relational substrate
here — STOP. That is the wrong direction; D-1 keeps the file store and the PRD-012 crypto.

## The class dimension + the registry is the policy (D-2 / D-7)

The vault generalizes `(scope, name)` to `(class, scope, name)`. The **registry**
(`registry.ts`) is the single source of truth for each class's READ POSTURE and value
SCHEMA — policy as DATA:
- `secret`  → posture `internal-only`  (value never returned to a surface; PRD-012).
- `setting` → posture `daemon-readable` (a typed value MAY be returned to the daemon).
- A new class is **registration** (`registry.registerClass(descriptor)`), not a storage
  rewrite (D-7). The store keys by `(class, scope, name)` and reads posture/schema from
  the registry — there is no per-class `if` in the store.

## The security invariant carries forward UNCHANGED

- **`secret` stays value-never-returned.** `VaultStore.getSecretValue` is the SINGLE
  decrypt-returning path for the `secret` class and it is INTERNAL (resolver/exec only).
  No API handler calls it. `/api/secrets` stays names-only (PRD-012's `api.ts`, untouched).
- **The posture gate enforces it as data.** `VaultStore.getSetting` calls
  `registry.assertReadable(class)` FIRST; a `secret` (or any `internal-only` class) read
  through the setting accessor is REJECTED (`not_readable`). This is the AC-2 boundary.
- **No value on the audit line — for ANY class.** `VaultAuditEvent` carries
  class + name + op + scope + ts + outcome (+ count). There is no value field. A
  `setting`'s VALUE is daemon-readable but is STILL never written to the audit NDJSON.
- **No plaintext at rest.** The on-disk record is the PRD-012 `SecretRecord`
  (`{ nonce, ciphertext, createdAt, scope }`). A `setting`'s scalar value is
  JSON-serialized then ENCRYPTED — the cleartext never lands on disk.

## Back-compat: existing `.secrets/` records keep resolving (AC-7)

The `secret` class's on-disk path is `.secrets/<scope>/<name>` — the SAME path PRD-012
wrote (special-cased in `VaultStore.classScopeDir`). A pre-existing `ANTHROPIC_API_KEY`
record decrypts here unchanged. Other classes live under `.vault/<class>/<scope>/<name>`,
so adding a class never disturbs the secret tree. **Do not move the `secret` class out of
`.secrets/`** — that special-case IS the back-compat contract.

## The DeepLake-creds migration is COPY-not-move (D-3 / AC-3) — the highest-risk item

`migrate.ts` `migrateDeeplakeToken` reads `~/.deeplake/credentials.json` via the existing
`loadDiskCredentials` and writes the token into the vault as the `secret`/`DEEPLAKE_TOKEN`
record. It performs **ZERO writes** to `~/.deeplake` — no `writeFileSync`, `rmSync`,
`chmodSync`, or `renameSync` against the creds path exists anywhere in this module. The
plaintext file stays BYTE-UNCHANGED and authoritative for the shared Hivemind login.
Resolution order is **vault → env → file** (`resolveDeeplakeToken`); a "vault empty" path
still resolves the login from the file (no regression). If you ever add a write to the
creds file here — STOP, that is a Critical finding (it can break the shared login).

## The catalog is single-sourced (D-6)

`catalog.ts` `PROVIDER_CATALOG` is the ONE place provider→model lives. A model id is a
one-line edit. Anthropic/OpenAI are closed lists; OpenRouter is a free-form passthrough.
The CLI (032b) + dashboard (032c) read from here; do not duplicate the list.

## Everything IO-touching is injected

The store takes `baseDir` + `machineKey` + `registry` + `clock`; the migration takes a
`reader` + `scope`. A test runs against a temp dir with a fake machine-key provider and a
fixed clock, never the real workspace, home dir, or `~/.deeplake`.
