# PRD-032a — Vault core: multi-class machine-bound store + record-class registry + creds migration

> **Parent:** [PRD-032](./prd-032-encrypted-vault-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Scope

The storage heart of the vault: generalize the PRD-012 machine-bound `.secrets/` store into a ONE local
encrypted vault addressed by `(class, scope, name)`, with a typed record-class registry that declares each
class's read posture and value schema. Ship two classes — `secret` (value-never-returned, PRD-012 posture)
and `setting` (daemon-readable/writable) — plus a SAFE, non-destructive migration of the plaintext DeepLake
login token into the vault. This sub-PRD owns the store, the registry, the two classes, and the migration;
it does NOT own the CLI verb (032b), the dashboard panel (032c), or the assembly wire-back (032d).

## Goals

- One machine-bound encrypted vault, reusing the PRD-012 primitive verbatim (machine-bound key, no plaintext
  at rest, file `0600` / dir `0700`, scope-bound, redacted audit) — extended with a `class` dimension.
- A typed record-class registry: each class declares an id, a read posture (`secret` = internal-only;
  `setting` = daemon-readable), and a zod value schema, so adding a class is registration, not a rewrite.
- Secrets keep their exact PRD-012 read posture; settings gain a readable/writable typed accessor.
- A safe, fallback-preserving DeepLake-creds migration that NEVER moves or deletes `~/.deeplake/credentials.json`.

## Non-Goals

- The `honeycomb settings` CLI verb and provider/model selector (032b).
- The dashboard Settings panel (032c).
- Reading vault settings at assembly to drive inference/dreaming (032d).
- A SQLite/relational substrate (PRD-032 D-1 keeps the file store); a hosted/synced backend; deleting or
  perm-tightening the plaintext DeepLake file (deferred, PRD-032 D-3).

## Functional requirements

- FR-1: The vault stores records under `(class, scope, name)`, generalizing the existing
  `.secrets/<scope>/<name>` to `.vault/<class>/<scope>/<name>` (or an equivalent class segment), each record
  encrypted with the machine-bound key at file `0600` / dir `0700` (PRD-012 `crypto.ts` + machine-key provider).
- FR-2: A record-class registry declares per class: id, read posture (`internal-only` | `daemon-readable`),
  and a zod value schema validated on write. The registry is the single source of truth for read policy.
- FR-3: The `secret` class preserves PRD-012 exactly: `setSecret`/`listSecretNames`/`deleteSecret` and an
  internal-only `getSecretValue` (the sole decrypt-returning path, used by the resolver/exec); NO value-
  returning accessor is exposed for this class.
- FR-4: The `setting` class adds `getSetting`/`setSetting`/`listSettings`: a written setting round-trips
  (reads back equal), the value is zod-validated on write, and `getSetting` MAY return its decrypted value to
  the daemon's own callers (it is daemon-readable, not internal-only).
- FR-5: Records remain scope-bound (org/workspace) via the existing `scopeSegment` discipline; a hostile
  tenancy value cannot traverse out of the vault dir.
- FR-6: A migration routine copies the token from a present `~/.deeplake/credentials.json` into the vault as a
  `secret`-class record (e.g. `DEEPLAKE_TOKEN`) WITHOUT moving, deleting, or rewriting the plaintext file; the
  file remains intact and loadable (the shared Hivemind login is never broken).
- FR-7: Credential/setting resolution order is vault → env → plaintext file; a "vault empty" path still
  resolves the DeepLake login from the existing file (no regression).
- FR-8: All IO-touching deps (base dir, machine-key provider, clock) stay injected so tests run against a temp
  dir with a fake provider and a fixed clock, never the real workspace, home dir, or `~/.deeplake`.

## Acceptance criteria

| ID | Criterion |
|---|---|
| a-AC-1 | Given the vault, when records of class `secret`, `setting`, and a registered test class are written under `(class, scope, name)`, then each is encrypted at file `0600` / dir `0700`, and copying the vault dir to a host with a different machine key fails to decrypt (mirrors PRD-012 AC-1). |
| a-AC-2 | Given the `secret` class, when any accessor is used, then only names are listable and the sole decrypt path is the internal resolver/exec — no value-returning accessor exists; an attempt to read a `secret` value via the settings accessor is rejected by the registry. |
| a-AC-3 | Given the `setting` class, when a typed value is written then read, then it reads back equal; an invalid value (failing the class zod schema) is rejected on write. |
| a-AC-4 | Given a present plaintext `~/.deeplake/credentials.json`, when migration runs, then the token is stored in the vault as a `secret`-class record AND the plaintext file is byte-unchanged and still loadable. |
| a-AC-5 | Given a stored vault token, when the DeepLake login resolves, then it prefers the vault value; given an empty vault, then it falls back to env, then to the plaintext file — the login resolves in every case. |
| a-AC-6 | Given a newly registered record-class descriptor, when a record of that class is written and read, then it round-trips AND the pre-existing `secret`/`setting` records still resolve (no migration, no rewrite). |

## Implementation notes

- Extend `SecretsStore` (`src/daemon/runtime/secrets/store.ts`) rather than fork it: add a `class` segment
  above `scopeSegment`, keep `deriveKey`/`encrypt`/`decrypt` (`crypto.ts`) untouched. The class registry can
  live beside `contracts.ts`. Consider renaming the public seam to a vault while keeping `secret`-class
  behavior bit-for-bit (PRD-012 ACs must still pass).
- The migration is COPY-not-move: read the token via the existing `loadCredentials`
  (`src/daemon/runtime/auth/credentials-store.ts`), write it as a `secret` record, and DO NOT touch the file.
- Settings values are small typed JSON (active provider/model, `dreaming.enabled` bool, dashboard prefs);
  zod-validate per the class schema so a malformed write is rejected at the boundary.
- Keep `audit:sql` clean — the vault is file-only, no catalog table, no SQL (the PRD-012 invariant).

## Dependencies

- PRD-012 secrets store, crypto, machine-key provider, scope segmentation (`src/daemon/runtime/secrets/*`).
- PRD-011/PRD-023 credentials store for the migration source (`src/daemon/runtime/auth/credentials-store.ts`).

## Related

- [parent index](./prd-032-encrypted-vault-index.md)
- [Secrets](../../../knowledge/private/security/secrets.md)
- [Credential Storage](../../../knowledge/private/security/credential-storage.md)
- [Scoping and Visibility](../../../knowledge/private/security/scoping-and-visibility.md)
