# PRD-032 — Unified local encrypted vault (settings + secrets, extensible)

> Status: backlog · Owner: `/the-smoker` · Type: L (feature)
> Goal: give the daemon ONE local, machine-bound, encrypted vault for typed records — provider API keys
> (secrets), app settings (active provider/model, feature toggles, dashboard prefs), and an extensible
> typed-record seam for future classes — surfaced via the CLI and the dashboard, and wired back so the
> inference provider/model and the dreaming-enabled flag are DRIVEN by the vault instead of a committed
> `agent.yaml` + an env var. Reuse the PRD-012 encryption primitive; do NOT regress the shared DeepLake login.

## Why

Two real holes today. First, the inference credential and the dreaming switch are NOT first-class
settings: the provider/model come from a COMMITTED `agent.yaml` at the workspace root
(`buildInferenceModelClient`, `src/daemon/runtime/inference/config.ts`), and dreaming is flipped by an
env var (`HONEYCOMB_DREAMING_ENABLED`, read in `src/daemon/runtime/dreaming/config.ts`). A user can't pick
"Anthropic → Opus 4.8" or toggle dreaming from a UI; they hand-edit YAML or set an env var. Second — and
the user's stated motivation — operational credentials sit in plaintext on disk: the DeepLake login lives
in `~/.deeplake/credentials.json` (`src/daemon/runtime/auth/credentials-store.ts`), a plaintext file
holding an org-bound bearer token. That is a security hole: any local process or backup sweep reads it.

PRD-012 already solved the encryption problem for ONE class (secrets): a machine-bound XSalsa20-Poly1305
store under `$HONEYCOMB_WORKSPACE/.secrets/<scope>/<name>`, file `0600` / dir `0700`, key derived from a
stable machine id with a generate-once `~/.honeycomb/.machine-key` fallback, scope-bound, value-never-
returned (`src/daemon/runtime/secrets/store.ts`). What's missing is BREADTH: the same crypto, extended to
hold typed SETTINGS (readable/writable, not just secrets) and architected so a future record class slots in
without a schema rewrite. This PRD builds that unified vault, migrates the inference credential into it,
provides a safe (non-destructive, fallback-preserving) path to protect the DeepLake login, and makes
provider/model + dreaming-on first-class settings a user picks from the CLI and the dashboard.

## Scope / What

Build ONE local, daemon-mediated, machine-bound encrypted vault that stores THREE record classes behind one
typed seam, and surface + wire it. In scope:

- **The vault core (032a).** One local encrypted store keyed by `(class, scope, name)`, reusing the PRD-012
  encryption primitive (machine-bound key, no plaintext at rest, `0600`/`0700`). A typed record-class
  registry so `secret`, `setting`, and a future class are rows of the SAME store, not bespoke stores.
- **Three record classes (032a).** (a) **secrets** — provider API keys (`ANTHROPIC_API_KEY`,
  `OPENAI_API_KEY`, `OPENROUTER_API_KEY`) + the DeepLake login migrated off plaintext; secrets are
  value-never-returned (read-only-internal, exactly PRD-012's posture). (b) **settings** — typed app config
  (active inference provider + model, `dreaming.enabled` and sibling feature toggles, dashboard prefs);
  settings are readable AND writable through the daemon. (c) an **extensible typed-record seam** so a future
  class (cached tokens, connector configs) registers without rewriting the storage layer.
- **The DeepLake-creds migration (032a).** A SAFE, NON-DESTRUCTIVE migration of the
  `~/.deeplake/credentials.json` token into the vault with a documented fallback — NEVER a destructive move
  of the user's live shared login (D-3).
- **CLI surface (032b).** Keep the existing `honeycomb secret …` (names-only) posture; add
  `honeycomb settings get|set|list` and a provider→model selector flow, all loopback-daemon-only.
- **Dashboard surface (032c).** A Settings panel in the existing dashboard (`src/dashboard/web`) where the
  user picks provider (Anthropic / OpenAI / OpenRouter) → that provider's model list loads → picks a model;
  plus feature-flag toggles (dreaming on/off). Writes go through the daemon to the vault.
- **Wire-back (032d).** The inference provider/model + the dreaming-enabled flag are DRIVEN by vault
  settings: assembly reads the active provider/model and the dreaming toggle from the vault (D-5), with the
  committed `agent.yaml` and the env var as a fallback, not the source of truth.

Out: making the vault a DeepLake table (it is machine-local BY DESIGN — that's the whole point; D-1);
rotating or re-architecting the shared `~/.deeplake` login flow (PRD-023 owns that — this PRD adds an
encrypted-at-rest option, not a new auth model); a hosted/synced settings backend; per-record audit beyond
PRD-012's existing redacted NDJSON; a live model-list fetch (curated static catalog ships; live fetch is a
flagged enhancement, D-6).

## Decisions

- **D-1 — Storage substrate: extend the proven file-store, NOT a new SQLite DB (recommended).** The user
  floated a small SQLite vault. RECOMMENDATION: do NOT add SQLite; extend the existing machine-bound
  `.secrets/` file store (`src/daemon/runtime/secrets/store.ts`) into a typed multi-class vault. Rationale:
  (1) the encryption primitive, machine-binding, `0600`/`0700` discipline, scope-segmentation, and redacted
  audit are ALREADY built, proven, and `audit:sql`-clean (secrets deliberately touch no SQL); (2) SQLite
  adds a native dependency + a second at-rest encryption story (the file is encrypted PER-RECORD today —
  SQLite would need SQLCipher or app-level field encryption to match, re-deriving the same machine key
  anyway); (3) the typed-record seam (a `class` segment + a per-class JSON value schema) gives queryable,
  transactional-enough, extensible records WITHOUT a DB — a settings read is one file read, a settings write
  is one atomic file write. The queryability SQLite would buy is not needed at this scale (tens of settings,
  a handful of secrets per scope). If a future class needs real relational queries, revisit then; this PRD
  keeps the substrate the one we already trust. EITHER WAY the encryption primitive (machine-bound key, no
  plaintext at rest, `0600`) is preserved — that invariant is non-negotiable.
- **D-2 — One vault, three classes, addressed by `(class, scope, name)`.** The store gains a `class`
  dimension (`secret` | `setting` | future) layered ABOVE the existing scope segment, so a record path is
  `.vault/<class>/<scope>/<name>` (generalizing today's `.secrets/<scope>/<name>`). Secrets keep their exact
  PRD-012 read posture (value-never-returned, internal-only decrypt via the resolver/exec path). Settings get
  a NEW readable/writable accessor — settings are not secrets, so `getSetting` MAY return its decrypted value
  to the daemon's own surfaces (still never opening a raw-value route for the `secret` class). The class
  registry declares per-class read posture (secret = internal-only; setting = daemon-readable) so the policy
  is data, not scattered conditionals.
- **D-3 — DeepLake-creds migration is ADDITIVE and FALLBACK-PRESERVING, never destructive.** The shared
  `~/.deeplake/credentials.json` is the user's LIVE login, byte-cross-compatible with Hivemind (PRD-023). The
  migration MUST NOT move or delete it. Instead: on first vault-enabled boot, COPY the token into the vault
  as a `secret`-class record (e.g. `DEEPLAKE_TOKEN`) and prefer the vault value when present; the plaintext
  file remains as the fallback and the Hivemind-compat surface. A follow-up (separate change, gated on this
  proving out) MAY tighten the plaintext file's perms or offer an opt-in "remove plaintext after migration"
  — but THIS PRD never makes the user's login unrecoverable. The credential resolution order becomes
  vault → env → plaintext file, with the file still authoritative for the SHARED Hivemind login until a
  later PRD changes that contract.
- **D-4 — Security posture is inherited from PRD-012, unchanged.** Machine-bound key (no plaintext at rest),
  file `0600` / dir `0700`, scope-bound records (org/workspace, like the secret store), loopback-daemon-only
  mediation (no direct disk access from a surface), and names-only for the `secret` class on every surface.
  The vault is LOCAL and is NOT a DeepLake table. Copying the vault to another host yields nothing (different
  machine key → decrypt fails), exactly as PRD-012 AC-1.
- **D-5 — Wire-back: assembly READS settings from the vault directly; the vault does NOT generate
  `agent.yaml` (recommended).** Two options: (A) the vault writes/overwrites `agent.yaml`, or (B) assembly
  reads the active provider/model + dreaming toggle from the vault at boot. RECOMMENDATION: (B) — assembly
  resolves `provider/model` and `dreaming.enabled` from the vault, falling back to the committed `agent.yaml`
  / `HONEYCOMB_DREAMING_ENABLED` env when no vault setting exists. Rationale: generating `agent.yaml`
  (option A) creates a write-back loop and a committed-file-vs-vault drift trap (which wins?), and muddies the
  "this file is committed and contains NO secret" guarantee `agent.yaml` documents today. Reading directly
  (option B) keeps `agent.yaml` as a static, committed fallback/example and makes the vault the single live
  source of truth — one direction, no drift. The inference credential `${SECRET_REF}` already resolves
  through the vault (the secret class), so only the provider/model/target selection and the dreaming toggle
  move to vault-driven settings.
- **D-6 — Provider→model lists are a curated static catalog; live fetch is a flagged enhancement.** The
  dashboard's provider→model selector ships with a curated, version-pinned catalog (Anthropic: Sonnet 4.6,
  Opus 4.8; OpenAI: gpt-4o and siblings; OpenRouter: passthrough/free-form model id). The catalog lives in
  one place so model IDs are updatable in one edit. A LIVE per-provider model-list fetch (calling the
  provider's models endpoint) is an explicit OPTIONAL enhancement behind a flag, not in the shipped default —
  it needs a resolved API key and adds a network dependency to the settings UI.
- **D-7 — Extensibility is a registered class + a per-class value schema, not a migration.** A future record
  class (cached tokens, connector configs) is added by registering a class descriptor (id, read posture,
  zod value schema) — no storage-layer rewrite, no file-format migration of existing classes. Existing
  `secret` / `setting` records are untouched when a class is added (the class is just another path segment).

## Acceptance criteria

- **AC-1 — One machine-bound vault, three classes, reusing the PRD-012 primitive.** The vault stores
  `secret`, `setting`, and a registered test/future class under `(class, scope, name)`, each record encrypted
  with the machine-bound key at file `0600` / dir `0700`. Copying the vault dir to a host with a different
  machine key fails to decrypt (mirrors PRD-012 AC-1). Unit-tested against a temp dir + a fake machine-key
  provider + a fixed clock (the existing injectable seams).
- **AC-2 — Secrets stay value-never-returned; settings are readable/writable.** For the `secret` class, no
  surface (CLI, dashboard, API) exposes a decrypted value — only names — and the sole decrypt path stays the
  internal resolver/exec (PRD-012 posture). For the `setting` class, `getSetting`/`setSetting` round-trip a
  typed value through the daemon: a written setting reads back equal. Unit-tested per class; an attempt to
  read a `secret`-class value through the settings accessor is rejected by the class registry.
- **AC-3 — DeepLake-creds migration is safe and fallback-preserving.** Given a plaintext
  `~/.deeplake/credentials.json`, when the vault migration runs, then the token is copied into the vault as a
  `secret`-class record AND the original plaintext file is left intact and still loadable (the shared
  Hivemind login is never broken). Resolution prefers the vault value when present, falls back to env, then to
  the plaintext file. Proven by a test that seeds a plaintext creds file, runs migration, asserts the vault
  holds the token, the file is byte-unchanged, and a login resolves from the vault — and a "vault empty"
  case still resolves from the file.
- **AC-4 — `honeycomb settings` CLI + provider/model selector.** `honeycomb settings list` shows current
  settings (provider, model, dreaming flag, dashboard prefs) without printing any secret value; `settings get
  <key>` / `settings set <key> <value>` round-trip through the daemon to the vault; a provider/model selector
  flow lets the user pick provider then a model from that provider's catalog. The existing `honeycomb
  secret …` names-only posture is preserved (no value-returning verb added). All loopback-daemon-mediated.
  Unit-tested against the dispatcher with a fake daemon client.
- **AC-5 — Dashboard Settings panel writes to the vault.** The dashboard (`src/dashboard/web`) renders a
  Settings panel where the user selects provider (Anthropic / OpenAI / OpenRouter) → the catalog model list
  for that provider loads → picks a model; and toggles dreaming on/off. Each change POSTs through a daemon
  endpoint that writes the `setting`-class record; on reload the panel reflects the persisted vault value. No
  secret value is ever rendered (only "key set ✓" / "not set"). The panel reads only through daemon
  endpoints (never opens the vault directly), consistent with PRD-020b.
- **AC-6 — Wire-back: provider/model + dreaming are vault-driven.** With a `setting`-class active
  provider/model present, assembly builds the inference model client for THAT provider/model (vault wins over
  the committed `agent.yaml`); with the `dreaming.enabled` setting true, the live `POST /api/diagnostics/dream`
  stops returning `reason:"disabled"` (the PRD-026 behavior) WITHOUT setting the env var. With no vault
  setting, assembly falls back to `agent.yaml` / `HONEYCOMB_DREAMING_ENABLED` (no regression for existing
  installs). Proven by an assembly test toggling the vault setting and asserting the resolved
  provider/model/dreaming state.
- **AC-7 — Extensible: a new class registers without a rewrite.** Registering a new record-class descriptor
  (id + read posture + zod value schema) makes that class storable/readable through the SAME vault, with
  existing `secret`/`setting` records untouched and re-readable. Proven by a test that registers a throwaway
  class, writes+reads a record, and asserts the pre-existing secret and setting records still resolve.
- **AC-8 — Safety + gates green.** No plaintext at rest for any vault record; perms `0600`/`0700` asserted
  (POSIX, with the documented win32 ACL gap from PRD-012); no secret value crosses any surface or audit line
  (the redacted NDJSON posture holds for the new classes); the DeepLake plaintext file is never deleted or
  corrupted by migration; `npm run ci`, `build`, `audit:sql` (the vault touches NO SQL — file-only), and
  `audit:openclaw` all pass; any live proof (e.g. a real provider-key round-trip) is gated (creds-only,
  skipped in CI).

## Sub-PRDs

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-032a-encrypted-vault-core`](./prd-032a-encrypted-vault-core.md) | The multi-class machine-bound vault (extend the PRD-012 store), the typed record-class registry, the secret/setting classes, and the safe DeepLake-creds migration. | Draft |
| [`prd-032b-encrypted-vault-cli`](./prd-032b-encrypted-vault-cli.md) | `honeycomb settings get/set/list` + the provider→model selector; preserve `honeycomb secret …` names-only. | Draft |
| [`prd-032c-encrypted-vault-dashboard`](./prd-032c-encrypted-vault-dashboard.md) | The dashboard Settings panel: provider→model selection + feature-flag toggles, writing through the daemon to the vault. | Draft |
| [`prd-032d-encrypted-vault-wireback`](./prd-032d-encrypted-vault-wireback.md) | Assembly reads provider/model + dreaming-enabled from the vault (vault-driven, `agent.yaml`/env as fallback). | Draft |

## Risks / Out of scope

- **Risk — breaking the user's live shared DeepLake login.** The single highest risk. Mitigated by D-3 /
  AC-3: migration is COPY-not-move, the plaintext file stays intact and authoritative for the Hivemind-shared
  login, resolution falls back to it, and no perm-tightening or deletion happens in this PRD.
- **Risk — model IDs going stale in the curated catalog.** Mitigated by D-6: the catalog is single-sourced in
  one module (current pins: Anthropic Sonnet 4.6 / Opus 4.8, OpenAI gpt-4o, OpenRouter passthrough), and the
  OpenRouter passthrough accepts a free-form id so a brand-new model is usable before the catalog is updated.
  A live fetch is the deferred enhancement.
- **Risk — vault-vs-`agent.yaml` drift.** Mitigated by D-5: assembly READS the vault (one direction); the
  vault never generates `agent.yaml`, so there is no write-back loop and no "which file wins" ambiguity — the
  vault wins when set, the committed file is a static fallback/example.
- **Risk — win32 perms are best-effort.** The `0600`/`0700` discipline is a no-op on NTFS (POSIX bits don't
  apply); the documented platform gap from PRD-012 (per-user profile dir ACL) carries over unchanged.
- **Out of scope.** A SQLite/relational substrate (D-1 chooses the file store); re-architecting the shared
  `~/.deeplake` auth model or rotating the login (PRD-023); a hosted/synced settings backend; a live
  provider model-list fetch (flagged enhancement, D-6); making the vault a DeepLake table (machine-local by
  design, D-1/D-4); deleting the plaintext DeepLake creds file (deferred, D-3).

## Dependencies

- **PRD-012 (Secrets)** — the crypto primitive, machine-bound key provider, scope segmentation, `0600`/`0700`
  discipline, and redacted audit this vault EXTENDS (`src/daemon/runtime/secrets/{store.ts,crypto.ts,contracts.ts}`).
  This PRD generalizes that store into a multi-class vault; it adds no new crypto.
- **PRD-010 (Model & Provider Router)** — the `inference:` config + `${SECRET_REF}` resolution the wire-back
  drives; the provider/model/target selection moves to vault-driven settings (D-5), and the credential keeps
  resolving through the secret class.
- **PRD-020 (Surfaces)** — the CLI dispatcher (`src/cli`, `src/commands`) the `settings` verb extends (020a)
  and the daemon-served dashboard (`src/dashboard/web`, 020b) the Settings panel lives in.
- **PRD-011 (Tenancy & Auth)** — the org/workspace scope the vault records are bound to, and the
  `~/.deeplake/credentials.json` shared login the migration protects.
- **PRD-023 (DeepLake connect parity)** — owns the shared `~/.deeplake/credentials.json` Hivemind-compatible
  login contract; the D-3 migration is additive and must not regress that contract (`src/daemon/runtime/auth/credentials-store.ts`).
- **PRD-026 (Dreaming loop enablement)** — supplies the `dreaming.enabled` toggle semantics the wire-back
  drives from a vault setting instead of `HONEYCOMB_DREAMING_ENABLED` (`src/daemon/runtime/dreaming/config.ts`).

## Reference

- Encryption primitive to extend: `src/daemon/runtime/secrets/store.ts` (`SecretsStore`, `createMachineKeyProvider`,
  `scopeSegment`, `0600`/`0700`, machine-bound key), `crypto.ts`, `contracts.ts`.
- Inference config + wire-back: `src/daemon/runtime/inference/config.ts` (`resolveInferenceConfig`),
  `model-client-factory.ts` (`buildInferenceModelClient`), `agent.yaml` (committed fallback),
  `src/daemon/runtime/assemble.ts` (`AGENT_CONFIG_FILE_NAME`, the boot path that reads config).
- Dreaming toggle: `src/daemon/runtime/dreaming/config.ts` (`HONEYCOMB_DREAMING_ENABLED`),
  `src/daemon/runtime/dreaming/api.ts` (`POST /api/diagnostics/dream`).
- DeepLake login to protect (migration target): `src/daemon/runtime/auth/credentials-store.ts`
  (`~/.deeplake/credentials.json`, the shared Hivemind login; legacy `~/.honeycomb` read-fallback).
- CLI surfaces: `src/cli/index.ts` (entry), `src/commands/index.ts` + `src/commands/storage-handlers.ts`
  (the `secret` → `/api/secrets` verb the `settings` verb sits beside).
- Dashboard: `src/dashboard/web/{app.tsx,panels.tsx,wire.ts}` (the Settings panel host).
