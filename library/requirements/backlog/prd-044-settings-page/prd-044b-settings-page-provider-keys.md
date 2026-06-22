# PRD-044b: Provider API keys — write-only into the encrypted vault

> **Parent:** [PRD-044 Settings Page](./prd-044-settings-page-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Overview

The provider-API-keys section of the Settings page. A user adds or replaces the API key for each inference provider —
Anthropic (Claude), OpenAI (ChatGPT), OpenRouter, and Cohere — and the key is written WRITE-ONLY into the encrypted
vault. The page never reads a key value back; it shows only NAME presence ("set ✓" / "not set").

This is the security-critical section, and the posture is already proven by the dashboard's existing `SettingsPanel`:
each provider's key lives in the secret class under a conventional NAME (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`OPENROUTER_API_KEY`), the panel reads `GET /api/secrets` (NAMES only) and shows "key set ✓" iff the name is present,
and there is NO value-returning route. PRD-032's vault seals each secret with XSalsa20-Poly1305 keyed to the machine,
stores `{ nonce, ciphertext }` (never plaintext), and exposes `GET /api/secrets` as names-only by construction. This
sub-PRD extends that EXACT model with a WRITE affordance (an input that POSTs the key and clears) and adds Cohere
(`COHERE_API_KEY`) — the one provider key name that does not exist in the codebase yet.

## Goals

- Let a user add or replace the API key for Anthropic, OpenAI, OpenRouter, and Cohere via the existing write-only
  secrets path (`POST /api/secrets/:name` with a `{ value }` body), one provider per row.
- Show each provider's key PRESENCE ("set ✓" / "not set") from `GET /api/secrets` (names only) — extending the
  existing `PROVIDER_KEY_NAME` presence-badge model already in `panels.tsx`.
- Add Cohere to the presence map (`cohere → COHERE_API_KEY`), the first use of that name in the codebase.
- Guarantee, by construction, that NO endpoint ever returns a secret value and that the page never asks for one — the
  input is write-only and cleared after a successful submit.
- Reuse the injected `PageProps.wire` and the existing primitives (`Input`, `Button`, `Badge`); add no new design
  system and no new crypto.

## Non-Goals

- Reading, displaying, or "revealing" a stored key value — there is no value-returning secrets route and this section
  never introduces one (PRD-032 D-2).
- Re-implementing the vault, the encryption, the machine-binding key derivation, or the redacted audit log — those are
  PRD-032 / PRD-012. This section is a thin client of `POST /api/secrets/:name` + `GET /api/secrets`.
- Adding Cohere as a selectable INFERENCE provider in the model router / catalog (`PROVIDER_CATALOG` in
  `src/daemon/runtime/vault/catalog.ts`). Wiring Cohere into the router is owned by PRD-010 (model-provider-router);
  this section adds only the Cohere KEY (write-only vault + presence). See OQ-1.
- Validating that a key actually works against the provider API (a live "test key" call). Flagged as OQ-2, not the
  baseline.
- Deleting a key. `DELETE /api/secrets/:name` exists in the daemon; a remove affordance is OQ-3, not the baseline.

## User Stories

- As a developer, I want to paste my Anthropic API key into the settings and have it stored securely, so the daemon
  can call Claude without me exporting an env var.
- As a developer, I want to add keys for OpenAI, OpenRouter, and Cohere the same way, so I can switch providers.
- As a developer, I want to see at a glance WHICH provider keys are set without ever seeing the secret value, so I can
  audit my config safely.
- As a security-conscious user, I want certainty that a stored key cannot be read back through any endpoint or
  rendered on the page, so a screenshot of my settings leaks nothing.

## Implementation Notes

- **Section component:** a `ProviderKeysSection` rendered by `src/dashboard/web/pages/settings.tsx`. It renders one
  row per provider: the provider label, a write-only `Input` (a password-type field), a "Save key" `Button`, and the
  presence `Badge`. It receives the injected `wire` and the `secretNames` list (already hydrated for the dashboard).
- **Presence map (extend the existing one):** reuse `PROVIDER_KEY_NAME` in `src/dashboard/web/panels.tsx` —
  `{ anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", openrouter: "OPENROUTER_API_KEY" }` — and ADD
  `cohere: "COHERE_API_KEY"`. The presence badge (`ProviderKeyBadge`) already renders "key set ✓" / "not set" from
  `secretNames.includes(keyName)`; it works unchanged for the new entry. `COHERE_API_KEY` is a new name — grep
  confirms it does not exist anywhere yet, so this is its introduction.
- **Wire method to add (`src/dashboard/web/wire.ts`):** `setSecret(name: string, value: string): Promise<boolean>` →
  `POST /api/secrets/:name` with a JSON `{ value }` body, stamping `DASHBOARD_SESSION_HEADERS`, path-encoding the name
  (the daemon validates `name` against `[A-Za-z0-9_.-]+`, traversal-proof). Returns `true` on the daemon's 2xx accept;
  any non-2xx (400 invalid name/value, 502 store failure) reads as "not accepted". On a successful write the caller
  RE-READS `secretNames()` so the presence badge reflects the persisted truth — mirroring the existing `saveSetting`
  re-read pattern in `app.tsx`. There is NO `getSecret` method, and none is ever added.
- **Write-only input discipline:** the key `Input` is a password field; on a successful submit the field is CLEARED
  (no lingering value in component state, no value echoed in the response — `POST /api/secrets/:name` echoes the NAME,
  never the value, per the secrets handler). The input never pre-fills from any stored value (there is no value to
  fetch). A submitted-but-empty value is rejected client-side before the POST.
- **Provider set:** the four providers are Anthropic, OpenAI, OpenRouter, Cohere. Anthropic/OpenAI/OpenRouter map to
  the existing catalog providers (`vault/catalog.ts`); Cohere is key-only here (OQ-1). The row order and labels reuse
  the catalog `label` where available and a literal "Cohere" otherwise.
- **Security discipline (the load-bearing invariant):** the page reads ONLY `GET /api/secrets` (names) — never a
  value. The write POSTs a value but reads nothing back but the name. No secret value appears in the page state, the
  rendered DOM, the response the page parses, or a log line. This is the grep-proven invariant of AC-3.

## Acceptance Criteria

- [ ] **AC-1 — Add/replace each provider key.** A user can enter and save an API key for Anthropic, OpenAI,
  OpenRouter, and Cohere; each save POSTs `POST /api/secrets/:name` with the conventional name and a `{ value }` body;
  the input clears on success. Unit-tested with a mocked `wire` asserting the POST name/body and the clear.
- [ ] **AC-2 — Presence shown, names only.** Each provider row shows "key set ✓" when its conventional name is present
  in `GET /api/secrets` and "not set" otherwise; after a successful save the row re-reads and flips to "set ✓". The
  presence comes from names only — never a value.
- [ ] **AC-3 — No value ever returned or rendered.** No secrets endpoint returns a value, the page adds no
  value-returning wire method, and no secret value appears in page state, the DOM, the parsed response, or a log line
  — grep-proven. The Cohere name (`COHERE_API_KEY`) joins the presence map; the write-only model is identical for it.
- [ ] **AC-4 — Thin client, reused wire + posture.** The section uses the injected `PageProps.wire`, reuses the
  existing `secretNames()` read and the `PROVIDER_KEY_NAME` presence model (extended to Cohere), and adds only the
  write-only `setSecret` method with the re-read-after-write pattern — no `getSecret`, no `any` across the boundary.
- [ ] **AC-5 — Security.** Inputs are password-type and write-only (cleared after submit, never pre-filled);
  LOCAL-MODE-ONLY inherited from the shell; the daemon-side write is the existing validated, machine-bound, sealed
  vault path (PRD-032). `audit:openclaw` / `audit:sql` stay green; a DOM/unit test asserts no value is rendered.

## Open Questions

- **OQ-1 (parent OQ-3) — Cohere as a router provider.** This section adds the Cohere KEY (write-only vault + presence)
  only. Making Cohere a selectable inference provider (adding it to `PROVIDER_CATALOG` / the model router) is a larger
  change owned by PRD-010. Proposed: keep 044b key-only; flag the catalog/router add for PRD-010. Confirm the split.
- **OQ-2 — "Test key" affordance.** Should a saved key get an optional "test" button that asks the daemon to make a
  cheap provider call (validating the key works) and reports ok/fail WITHOUT returning the key? Useful but adds a new
  daemon surface; flagged as a fast-follow, not baseline.
- **OQ-3 — Remove-key affordance.** `DELETE /api/secrets/:name` exists. Should each row offer a "remove" action that
  DELETEs the secret and flips the badge to "not set"? Proposed for a fast-follow; confirm whether 044b ships it now.
