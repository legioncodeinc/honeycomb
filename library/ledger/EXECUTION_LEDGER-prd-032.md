# EXECUTION LEDGER — PRD-032 Unified local encrypted vault

> Orchestrator: `/the-smoker` · Branch: `prd-032-encrypted-vault` · SSOT for AC tracking.
> Goal: ONE local machine-bound encrypted vault for typed records — `secret` (provider keys + DeepLake login),
> `setting` (active provider/model, pollinating toggle, dashboard prefs), + an extensible class seam — surfaced
> via CLI + dashboard and wired back so provider/model + pollinating are vault-driven. EXTEND the PRD-012 crypto
> primitive (no new crypto, no SQLite). NEVER regress the shared DeepLake login (copy-not-move migration).

## Phase 0 recon facts
- `src/daemon/runtime/secrets/store.ts`: `SecretsStore` (`setSecret`/`getSecretValue` INTERNAL-only/`listSecretNames`), machine-bound `deriveKey(machineId, scope)` (XSalsa20-Poly1305, `crypto.ts`), `.secrets/<scope>/<name>` at file `0o600`/dir `0o700`, `createMachineKeyProvider` (`~/.honeycomb/.machine-key` fallback), redacted NDJSON audit, injectable clock + machine-key seams. THIS is the primitive to extend — add NO crypto.
- `/api/secrets` (`secrets/api.ts`): names-only, protected group; `GET /api/secrets` (names), `POST /api/secrets/:name` (store, returns ok-no-value), `DELETE`. NO value-returning route (the security property). Existing local secret records (e.g. `ANTHROPIC_API_KEY`) live under `.secrets/<scope>/` — the vault MUST keep resolving them (back-compat).
- Wire-back targets: `inference/config.ts` `resolveInferenceConfig` + `model-client-factory.ts` `buildInferenceModelClient` (reads the committed `agent.yaml`), `pollinating/config.ts` (`HONEYCOMB_POLLINATING_ENABLED`), `assemble.ts` (`buildGatedPollinatingWorker`, `AGENT_CONFIG_FILE_NAME`, `buildInferenceModelClient` call). DeepLake login: `auth/credentials-store.ts` (`~/.deeplake/credentials.json`, the SHARED Hivemind login — migration is COPY-not-move).

## Acceptance criteria (master, from the index)
| AC | Criterion (abbrev) | Status | Sub-PRD |
|----|--------------------|--------|---------|
| AC-1 | One machine-bound vault, 3 classes (`secret`/`setting`/future) addressed by `(class,scope,name)`, encrypted `0600`/`0700`; copy-to-other-machine fails to decrypt (PRD-012 AC-1). | VERIFIED | 032a |
| AC-2 | Secrets value-never-returned (names-only, internal decrypt only); settings readable/writable round-trip; reading a `secret` via the settings accessor is REJECTED by the registry. | VERIFIED | 032a |
| AC-3 | DeepLake-creds migration SAFE + fallback-preserving: COPY token into vault (`DEEPLAKE_TOKEN` secret), plaintext file BYTE-UNCHANGED + still loadable; resolution vault→env→file; "vault empty" still resolves from file. | VERIFIED | 032a |
| AC-4 | `honeycomb settings get/set/list` + provider→model selector; secret names-only posture preserved (no value-returning verb); loopback-daemon-mediated. | VERIFIED | 032b |
| AC-5 | Dashboard Settings panel: provider (Anthropic/OpenAI/OpenRouter)→catalog model list→pick; pollinating on/off toggle; writes via daemon endpoint to the `setting` class; reload reflects persisted value; NO secret value rendered. | VERIFIED | 032c |
| AC-6 | Wire-back: provider/model + pollinating vault-DRIVEN (vault wins over `agent.yaml`/env); with vault `pollinating.enabled` true, `/api/diagnostics/pollinate` not `disabled` WITHOUT the env var; no vault setting → falls back (no regression). | VERIFIED | 032d |
| AC-7 | Extensible: register a new class descriptor (id + read posture + zod value schema) → storable/readable through the SAME vault; existing `secret`/`setting` records untouched + re-readable. | VERIFIED | 032a |
| AC-8 | Safety + gates: no plaintext at rest; `0600`/`0700` asserted (POSIX; documented win32 ACL gap); no secret crosses any surface/audit line; DeepLake plaintext file never deleted/corrupted; `ci`/`build`/`audit:sql`(file-only, no SQL)/`audit:openclaw`; live proofs gated. | DONE (032a/close-out) | all/close-out |

## Decisions locked (from the index)
- D-1 EXTEND the `.secrets/` file store (no SQLite); preserve the encryption primitive.
- D-2 one vault, `(class, scope, name)`; secret=internal-only-decrypt, setting=daemon-readable; registry declares per-class read posture (policy as data).
- D-3 DeepLake-creds migration COPY-not-move; resolution vault→env→file; plaintext stays authoritative for the shared Hivemind login.
- D-4 PRD-012 security posture unchanged (machine-bound, 0600/0700, scope-bound, loopback-only, names-only for secrets, NOT a DeepLake table).
- D-5 wire-back READS the vault (option B); never generates `agent.yaml` (one direction, no drift).
- D-6 curated static provider→model catalog (Anthropic Sonnet 4.6/Opus 4.8; OpenAI gpt-4o; OpenRouter free-form id); live fetch deferred.
- D-7 extensibility = registered class + per-class zod schema, no migration of existing classes.

## Wave plan
**Wave 1 — vault core + daemon settings API (`typescript-node-worker-bee`).** Read `prd-032a-encrypted-vault-core.md`. EXTEND `secrets/store.ts` (or a sibling `vault/` module reusing its crypto/machine-key) into a multi-class vault keyed by `(class, scope, name)`; a record-class REGISTRY (secret=internal-only, setting=daemon-readable, + a registerClass seam, D-7); `getSetting`/`setSetting` (typed, zod per-class schema); the secret class keeps its EXACT names-only/internal-decrypt posture + back-compat with existing `.secrets/` records; the COPY-not-move DeepLake-creds migration (AC-3); a daemon `/api/settings` API (settings-class GET list/get + POST set; secret class STAYS names-only on `/api/secrets`); the curated provider→model catalog (D-6, single module). Unit tests AC-1/AC-2/AC-3/AC-7 + AC-8 safety (temp dir + fake machine-key + fixed clock). Exposes the vault API + `/api/settings` + the catalog for Wave 2. NO assemble/CLI/dashboard edits (Wave 2 owns those).

**Wave 2 (parallel after W1) — surfaces + wire-back:**
- 032b CLI (`typescript-node-worker-bee`): `honeycomb settings get/set/list` + provider→model selector → `/api/settings`; preserve `honeycomb secret …` names-only. AC-4. Owns `src/commands`/`src/cli`.
- 032c dashboard (`typescript-node-worker-bee`): Settings panel (provider→model + pollinating toggle) → `/api/settings`; no secret rendered. AC-5. Owns `src/dashboard/web`.
- 032d wire-back (`typescript-node-worker-bee`): assembly reads provider/model + pollinating-enabled from the vault (vault wins; `agent.yaml`/env fallback). AC-6. Owns `assemble.ts`.

**Close-out** — security-stinger (CRITICAL — credential vault + DeepLake-creds migration; scrutinize: no plaintext at rest, no secret-value egress on any surface/audit, the migration NEVER deletes/corrupts the live login, scope/machine binding) → quality-stinger.

## Constraints (in force)
- Explicit `git add <paths>`, NEVER `-A`. Keep `.agents/.codex/.claude/.cursor`/`AGENTS.md`/`.env.local`/`.secrets`/`.vault`/`.settings`/other PRDs' EXECUTION_LEDGER OUT (gitignore the new vault runtime dirs like `.secrets`/`.daemon` already are). NEVER touch `~/.deeplake/credentials.json` destructively. Daemon on 3850 — leave it.

## Status log
- Phase 0 recon complete; branch cut, PRD moved backlog→in-work. Dispatching Wave 1 (vault core + settings API).
- Wave 1 (032a) DONE: `src/daemon/runtime/vault/**` — VaultStore (secret+setting+generic classes), registry (D-7), COPY-not-move migration + vault→env→file resolver, curated catalog, `/api/settings` protected mount. 26 vault tests, back-compat with existing `.secrets/` records preserved, all gates green.
- Wave 2 DONE: 032b `settings` CLI verb + provider/model selector (AC-4, 21 tests); 032c dashboard Settings panel (AC-5, 18 DOM/wire tests, no-secret-render proof); 032d assembly vault-driven provider/model + pollinating wire-back (AC-6).
- **Security close-out (CRITICAL) PASS** — no Critical/High. Verdicts proven not assumed: no secret-value egress on any surface (secret class names-only, posture gate rejects secret-via-getSetting, CLI/dashboard render names+state only); no plaintext at rest (reused PRD-012 XSalsa20-Poly1305, 0600/0700, audit NDJSON valueless for all classes); migration NON-DESTRUCTIVE (grep-proven zero write/rm/rename/chmod against the creds path, byte-unchanged); machine+scope binding intact, no `(class,scope,name)` path traversal; `/api/settings` inherits PRD-011 auth (protect:true); zod boundary + catalog-gated config can't inject arbitrary provider/model. Security bee flagged **finding #1 (INFO): the migration + resolver were built+tested but NOT wired into any boot caller** → the COPY never ran at boot (AC-3 wiring gap, not a security defect).
- **AC-3 wiring CLOSED:** orchestrator wired `migrateDeeplakeToken` into `assemble.ts` `start()` (after `startServices()`, fail-soft, guarded `vault instanceof VaultStore`). Deliberately OFF the storage-connection path — the live DeepLake connection keeps reading the AUTHORITATIVE plaintext file (env-over-file), so D-3 "plaintext stays authoritative" holds and the shared login can never be broken by a vault read; the vault is an additive cache (the migration COPIES file→vault at each boot, idempotent). 2 hermetic boot-wiring tests added to `assemble.test.ts` (COPY fires + plaintext byte-unchanged; no-creds fail-soft boot). Full suite 2131 passed / 0 failed; build + smoke:daemon-bundle + audit:sql green.
- **Quality close-out PASS — SHIP.** All 8 master ACs + D-1..D-7 VERIFIED against the actual code+tests (not the ledger's say-so); ordering correct (security ran first). Gates (run by QA): typecheck PASS · test **2131 passed / 0 failed** · build PASS · smoke:daemon-bundle PASS · audit:sql PASS · audit:openclaw PASS · dup ~0.54% (< 7). Report: `library/requirements/in-work/prd-032-encrypted-vault/reports/2026-06-21-qa-report.md`.
  - **S-1 (Suggestion, addressed):** `resolveDeeplakeToken` is tested+exported but not yet consumed by the live connection — QA judged this design-consistent with D-3 ("plaintext authoritative until a later PRD changes the contract"), i.e. intentional staging, NOT an AC miss. Added an explicit "INTENTIONALLY STAGED, not yet on the live-connection path (D-3)" note to `vault/migrate.ts` so it reads as staged, not dead.
  - **S-2 (informational, out of scope):** a vault `openai`/`openrouter` selection still routes through `createAnthropicTransport()` (`model-client-factory.ts`) — a pre-existing PRD-010 transport-breadth limitation, not PRD-032's scope. Follow-up.
- ALL ACs VERIFIED + close-out clean. Committing → push → PR → CI.
- Wave 2 / 032d wire-back (AC-6 / D-5) DONE. `src/daemon/runtime/assemble.ts` now READS the vault `setting` class
  (vault-first, fail-soft) and fires the Wave-1 `/api/settings` mount:
  - **Vault construction:** assembly builds ONE `VaultStore` over the SAME `$HONEYCOMB_WORKSPACE` base dir +
    `createMachineKeyProvider()` + `createVaultRegistry()` the secrets store uses (so the vault, `.secrets/`, and the
    `${SECRET_REF}` resolver agree on ONE location). Built ONLY for the real assembly (skipped when a fake `storage`
    is injected with no `vault`), so the deterministic unit suite never touches the workspace. Injectable via the new
    additive `AssembleDaemonOptions.vault` (`VaultSettingsReader = Pick<VaultStore,"getSetting">`) for tests.
  - **`/api/settings` mount:** `mountSettingsApi(daemon, { store: vault })` fired ONCE, fail-soft (wrapped in
    try/catch → a mount error never crashes boot; falls through to the 501 scaffold). `setting` class only — the
    registry posture gate rejects any `secret` read, so no secret crosses the surface.
  - **Provider/model vault-driven (FR-1):** `buildGatedPollinatingWorker` reads `activeProvider` + `activeModel` from the
    vault, catalog-validates the pair, and feeds it as an ADDITIVE `providerModelOverride` to `buildInferenceModelClient`
    (new optional param, existing signature/tests untouched). The override rewrites the resolved `agent.yaml` config's
    `account.provider` + `target.model` (vault wins) while keeping each account's `${SECRET_REF}` `apiKeyRef` UNTOUCHED
    (FR-2 — the key still resolves through the `secret` class). Absent/invalid → `agent.yaml` selection stands (no
    regression). Fixed a real wiring bug found by the new test: the router was built from the un-overridden `config`.
  - **Pollinating vault-driven (FR-3 / d-AC-2):** precedence is VAULT-FIRST — when the vault `setting` `pollinating.enabled`
    is present it WINS (a vault `true` enables pollinating WITHOUT `HONEYCOMB_POLLINATING_ENABLED`; a vault `false` disables
    even when the env says true); absent it, the gate falls back to `resolvePollinatingConfig().enabled` (PRD-026 env).
    The effective flag is threaded into the existing default-OFF worker gate.
  - **D-5 one direction:** the wire-back only READS the vault; it never writes a setting and never generates `agent.yaml`.
  - **Fail-soft everywhere:** every vault read is wrapped — a missing/malformed/undecryptable setting degrades to the
    fallback, never a boot throw.
  - **Tests:** `tests/daemon/runtime/inference/model-client-factory.test.ts` (+2: d-AC-1 override-wins, d-AC-3 no-override
    no-regression) and `tests/daemon/runtime/assemble.test.ts` (+7: vault-first pollinating true/false precedence, env
    fallback both ways, vault provider/model consulted, `/api/settings` mounted + responds, empty-vault fail-soft boot).
    All injected fakes — NO live run.
  - **Gates (repo root):** `typecheck` clean; `test` 199 files / 2129 passed / 6 skipped / **0 failed** (no flakes this run);
    `build` OK (all bundles @ 0.1.0); `smoke:daemon-bundle` OK (daemon bundle still loads after the assembly edit);
    `audit:sql` OK (179 files, file-only — no SQL added); `audit:openclaw` OK; `dup` 0.54% (threshold 7).
