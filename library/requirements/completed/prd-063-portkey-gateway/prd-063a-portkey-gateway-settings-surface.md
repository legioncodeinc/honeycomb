# PRD-063a: Portkey Gateway, Settings Surface

> **Parent:** [PRD-063 Portkey Gateway](./prd-063-portkey-gateway-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** M
> **Schema changes:** None (additive vault `setting` keys + one `secret` name)

## Overview

The user-facing half of PRD-063: a "Use Portkey gateway" toggle, a Portkey config / virtual-key field, a
`PORTKEY_API_KEY` write-only row, and an opt-in "fall back to provider key if Portkey is unreachable" toggle on the
Settings page (`#/settings`, PRD-044). This sub-PRD stands up the configuration surface and the additive vault
plumbing; it does NOT change inference routing (that is 063b), turning the toggle on with this sub-PRD alone persists
the intent and shows presence, and 063b makes it take effect.

## Goals

- Add a Portkey section (or sub-section of the existing provider-keys section) to `src/dashboard/web/pages/settings.tsx`:
  a labeled on/off toggle, a `portkey.config` text input, and a `PORTKEY_API_KEY` write-only field with a presence
  badge, built only from existing DS tokens/primitives.
- Register `portkey` in the provider catalog (`src/daemon/runtime/vault/catalog.ts` `PROVIDERS` + `PROVIDER_CATALOG`,
  `openEnded: true` like OpenRouter, since the Portkey config id is free-form).
- Add `portkey.enabled` (boolean), `portkey.config` (string), and `portkey.fallbackToProvider` (boolean, default
  false) to `KNOWN_SETTING_KEYS` and extend `validateSettingSemantics()` (`src/daemon/runtime/vault/api.ts`) so the
  POST allow-list accepts and validates them.
- Extend the dashboard wire layer (`src/dashboard/web/wire.ts`) zod schema so the new settings + the `PORTKEY_API_KEY`
  presence parse with `.catch()` defaults, a partial/older payload degrades to "off / not set", never a throw.
- Reuse the EXISTING `POST /api/secrets/PORTKEY_API_KEY` write path and the names-only `GET /api/secrets` presence read
  no new secrets route, no value ever returned.

## Non-Goals

- Any inference or rerank behavior change, 063b / 063c own that. With only 063a shipped, the toggle is persisted and
  shown but inference still uses the per-provider path.
- A Portkey config builder/validator inside Honeycomb, the `portkey.config` field is a free-form id the user copies
  from their Portkey dashboard; Honeycomb stores it verbatim (sanitized as a scalar `setting`).
- Greying-out logic that depends on routing state beyond the local toggle value (any cross-field UX that needs the
  live gateway is deferred to 063b's health signal).

## User stories

- *As an operator,* I flip "Use Portkey gateway" on, paste my Portkey API key (write-only) and my config id, hit Save,
  and the page confirms the key is "set ✓" and the toggle is on, without ever showing me a stored value back.
- *As an operator,* with Portkey on I see the per-provider key rows still present but visually de-emphasized / labeled
  "superseded by Portkey" so I understand they are no longer the active path (final UX per OQ-2).

## Acceptance criteria

| ID | Criterion |
|---|---|
| a-AC-1 | The Settings page renders a Portkey toggle, a `portkey.config` text field, a `PORTKEY_API_KEY` write-only input with a presence badge, and an opt-in `portkey.fallbackToProvider` toggle, using existing DS tokens/primitives; served production-clean by the existing esbuild entry. |
| a-AC-2 | Toggling the switches persists `portkey.enabled` and `portkey.fallbackToProvider` (true/false) via `POST /api/settings/:key`; editing + saving the config persists `portkey.config`; all three round-trip through `GET /api/settings` and re-hydrate on reload. |
| a-AC-3 | `portkey` is a catalog provider (`openEnded: true`); `portkey.enabled` + `portkey.config` + `portkey.fallbackToProvider` are accepted by `isKnownSettingKey` and validated by `validateSettingSemantics` (a non-boolean toggle or a non-string `portkey.config` is rejected 400). |
| a-AC-4 | `PORTKEY_API_KEY` writes via the existing `POST /api/secrets/PORTKEY_API_KEY`; presence shows from `GET /api/secrets` (names only). No value-returning route exists or is added (grep-proven, as in PRD-032 D-2). |
| a-AC-5 | The wire schema (`wire.ts`) parses the new settings + key presence with `.catch()` defaults; a partial/older daemon payload degrades to `{ enabled: false, config: "" }` + "not set", never a throw into React. |
| a-AC-6 | Security: the key input is write-only and cleared after submit; no token/secret value renders in the page, in any data response the page reads, or in a log line; LOCAL-MODE-ONLY inherited. |

## Implementation notes

- **Catalog** (`src/daemon/runtime/vault/catalog.ts:29-84`): add `"portkey"` to `PROVIDERS` and a `PROVIDER_CATALOG`
  entry `{ id: "portkey", label: "Portkey", models: [], openEnded: true }`. `openEnded` signals the UI to render a
  free-form text input (the config id), mirroring OpenRouter's passthrough handling.
- **Setting keys** (`src/daemon/runtime/vault/api.ts:44-79, 210-243`): append `portkey.enabled`, `portkey.config`,
  and `portkey.fallbackToProvider` to `KNOWN_SETTING_KEYS`; in `validateSettingSemantics()`, type-check the two
  toggles as boolean and `portkey.config` as a non-empty string when `portkey.enabled === true`. The scalar
  `SettingValueSchema` (`vault/registry.ts`) already accepts string|number|boolean, so no registry/store change.
- **Secret slot** (`src/daemon/runtime/secrets/api.ts`): none, `PORTKEY_API_KEY` is just another name on the existing
  write-only surface, encrypted by the existing machine-bound store.
- **Page** (`src/dashboard/web/pages/settings.tsx:21-26` `ProviderKeysSection` + `panels.tsx` `PROVIDER_KEY_NAME`):
  add `portkey → PORTKEY_API_KEY` to the presence map; add the toggle + config field bound to the
  `vaultSettings`/`setSetting` wire methods already used for `activeProvider`/`pollinating.enabled`.
- **Wire** (`src/dashboard/web/wire.ts`): extend `VaultSettingsSchema` (the `settings` record already tolerates new
  keys) and the page's read of `portkey.enabled`/`portkey.config`; `SecretNamesSchema` already covers
  `PORTKEY_API_KEY` presence with no change.

## Open questions

- [ ] **a-OQ-1 (→ parent D-2).** Final UX for the per-provider rows when Portkey is on: greyed-out + "superseded"
  label vs hidden. Proposed: keep them visible but de-emphasized with a "superseded by Portkey" hint, so turning
  Portkey off restores them without re-entry. Confirm with `ux-ui-worker-bee`.
- [ ] **a-OQ-2.** Should the `portkey.config` field accept BOTH a config id and a virtual-key id (Portkey supports
  either), with a small selector, or just one free-form field documented as "config or virtual key"? Proposed: one
  free-form field labeled accordingly in v1.

## Related

- [PRD-044b Settings Page, Provider Keys](../../completed/prd-044-settings-page/prd-044b-settings-page-provider-keys.md):
  the exact presence-badge + write-only pattern this extends.
- [PRD-032 Encrypted Vault](../../completed/prd-032-encrypted-vault/prd-032-encrypted-vault-index.md):
  the `setting` catalog + scalar contract + the names-only secrets surface.
