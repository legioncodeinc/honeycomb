# PRD-050c: Referral-Attributed Login (`--ref mario`)

> **Parent:** [PRD-050](./prd-050-quick-install-and-guided-setup-index.md)
> **Status:** Draft
> **Priority:** P0 (this is Goal 2 — referral capture — in one sub-PRD)
> **Effort:** M (0.5-1d)
> **Schema changes:** None. Adds a referral header to the existing device-flow request.

---

## Overview

This is the **growth engine**. Every Honeycomb signup originates from the operator's GitHub repo and the `@legioncodeinc/honeycomb` npm package — both **separate from Activeloop/DeepLake's own repos and package** — so every signup should be **attributed** to the operator. Hivemind already has the mechanic: a referral code carried as an HTTP header, `X-Hivemind-Referrer: <ref>`, on the `POST /auth/device/code` request (`hivemindReferrerHeader` in [`hivemind/src/commands/auth.ts`](https://github.com/activeloopai/hivemind/blob/main/src/commands/auth.ts)). The backend uses it for affiliate signup attribution on new registrations.

Honeycomb shares that backend and already ports Hivemind's auth verbatim ([`deeplake-issuer.ts`](../../../../src/daemon/runtime/auth/deeplake-issuer.ts)). So this sub-PRD: (1) ports the referrer header and threads a `ref` through `requestDeviceCode`; (2) **defaults the ref to `mario`** for every Honeycomb install (the `honeycomb install --ref mario` the buttons run); and (3) wires the **"First time setup"** click to begin the device flow and **render the DeepLake user-code on the setup page itself**, opening the DeepLake verification / create-account page in a browser tab — so the user sees the code in the UI, not buried in a terminal.

## Goals

- **Port the referral header** into Honeycomb's device-flow request: thread an optional `ref` into [`requestDeviceCode`](../../../../src/daemon/runtime/auth/deeplake-issuer.ts) / `loginWithDeviceFlow`, emitting `X-Hivemind-Referrer: <ref>` (the backend-recognized header — header-name choice is the parent open question) on `POST /auth/device/code`, **only when non-empty**, mirroring `hivemindReferrerHeader`'s trim-and-omit logic.
- **Default `ref` sourced from build metadata, not a hard literal.** The default is the build-injected `__HONEYCOMB_REF_DEFAULT__` (the esbuild `define` wired in [050a](./prd-050a-quick-install-and-guided-setup-one-command-bootstrap-installer.md), settable via the `HONEYCOMB_REF_DEFAULT` CI var) — which **ships as `mario`** but is one build-var change for a fork or a future operator, never a name baked into source. The `install` / "First time setup" / "Link to DeepLake" paths bind that default unless an explicit `--ref <code>` overrides it — attribution is automatic, never something the user must supply. Throughout this PRD, "`--ref mario`" is shorthand for "the configured default ref (shipped: `mario`)."
- **On-page user-code display:** the **"First time setup"** button calls a loopback `POST /setup/login` that begins the flow and returns the `user_code` + `verification_uri` for the **dashboard to render**, while also opening the validated `verification_uri_complete` (https-only — D-4) so the user lands on the DeepLake **login-or-create-account** page.
- **Secret discipline preserved:** the bearer/device token is **never** rendered, logged, or URL-embedded (only `user_code` + URI reach the page) — full parity with the existing flow's D-4 posture.
- **Attribution is testable:** a unit test asserts the header is present with the default `mario` when no override is passed, omitted only when the ref is explicitly blank, and never leaks into a URL or log.

## Non-Goals

- The install script (050a) and the phase model / `/setup/state` (050b).
- Hivemind detection + uninstall (050d) — though the "Link to DeepLake" step it ends on **reuses this exact referral flow**.
- A backend change to the attribution mechanic — if a Honeycomb-namespaced header is wanted, that is a backend coordination item (parent open question), not a blocker for shipping with the recognized header.
- Multi-code / per-campaign referral management UI.

## User stories

- As the operator, every user who installs from my repo is attributed to me automatically — I never have to tell them to type a code.
- As a new user, I click "First time setup," see a short code **on the page**, a DeepLake tab opens, I approve, and I'm in — I never copy anything out of a terminal.
- As an advanced user, I can override the referral with `honeycomb install --ref <someone-else>` and that code is what's attributed.

## Acceptance criteria

| ID | Criterion |
|---|---|
| c-AC-1 | `POST /auth/device/code` issued by a Honeycomb install carries `X-Hivemind-Referrer: mario` by default; a unit test asserts the header + default value with no `--ref` passed. |
| c-AC-2 | An explicit `--ref <code>` overrides the default; an empty/whitespace ref omits the header entirely (trim-and-omit parity with Hivemind). |
| c-AC-3 | The "First time setup" button begins the flow and the dashboard **renders the `user_code` + verification URI**; the DeepLake verification / create-account page opens in a browser (https-only validated). |
| c-AC-4 | The device/bearer token is never rendered, logged, or placed in any URL — only `user_code` + URI reach the page; a test asserts no token in the `/setup/login` response or any log line. |
| c-AC-5 | On approval, the flow mints + persists the shared `~/.deeplake/credentials.json` (0600) via the existing `persistFromToken` path — unchanged except for the added attribution header. |
| c-AC-6 | The referral header rides **only** on the device-code request (attribution-on-registration), not on `/me`, `/organizations`, mint, or any data-plane call. |

## Implementation notes

- **Smallest possible diff to the auth client.** Add `referrerHeader(ref?)` beside the existing header builders in [`deeplake-issuer.ts`](../../../../src/daemon/runtime/auth/deeplake-issuer.ts), spread it into the `requestDeviceCode` POST headers next to `DEEPLAKE_CLIENT_HEADER`, and plumb an optional `ref` down through `loginWithDeviceFlow` → `requestDeviceCode`. Everything else (poll, mint, `/me`, persist) is untouched.
- **Default binding lives at the install/CLI layer, not the auth client.** The auth client stays neutral (`ref` optional); the **`install` verb** / setup endpoint supplies `mario` as the default so the attribution policy is one obvious place, overridable by `--ref`.
- **`POST /setup/login`** (the button's handler, registered in 050b's host group) starts `loginWithDeviceFlow` with the bound ref and a **reporter that captures `user_code` + URI for the HTTP response** instead of `console.log` — the existing `DeviceFlowReporter` seam already separates the prompt sink from the token, so the on-page display is a reporter swap, not a security change.
- **Open the account page:** reuse `validateVerificationUrl` + `defaultBrowserOpener` (https-only, fixed-argv) already in the module; new users hit DeepLake's create-account/login at the verification URI.
- **Header name** defaults to the recognized `X-Hivemind-Referrer` (zero backend work); leave a single constant so swapping to `X-Honeycomb-Referrer` later is one edit (parent open question).
- **Telemetry hook (050e):** on a fresh-user device flow completing, the daemon emits `honeycomb_first_link` tagged with the **same resolved `ref`** this header carries — header and event agree on the code by construction (one resolved value, two consumers).

## Open questions

- [ ] `X-Hivemind-Referrer` (recognized now) vs `X-Honeycomb-Referrer` (needs backend) — confirm with the DeepLake backend owner; ship recognized, migrate later behind the constant.
- [ ] Where the `mario` default is sourced: hard-coded constant, build-time `define` (like the version single-sourcing), or an installer-written onboarding-file field? Lean: a constant + `--ref` override; revisit if per-build codes are ever needed.
- [ ] Should the user-code also be copyable + the flow auto-poll the moment the page renders, or wait for the user to confirm they've approved? Lean: auto-poll on render (matches the existing flow's poll loop).

## Related

- [`src/daemon/runtime/auth/deeplake-issuer.ts`](../../../../src/daemon/runtime/auth/deeplake-issuer.ts) — `requestDeviceCode` / `loginWithDeviceFlow` / `DeviceFlowReporter` / `defaultBrowserOpener` the header threads into.
- [`hivemind/src/commands/auth.ts`](https://github.com/activeloopai/hivemind/blob/main/src/commands/auth.ts) — `hivemindReferrerHeader` (`X-Hivemind-Referrer` on `/auth/device/code`), the verbatim source.
- [PRD-050b](./prd-050b-quick-install-and-guided-setup-pre-auth-dashboard-and-setup-shell.md) — the `POST /setup/login` host group + on-page render this drives.
- [Auth Architecture](../../../knowledge/private/auth/auth-architecture.md) · [Credential Storage](../../../knowledge/private/security/credential-storage.md) — the device flow + 0600 persist this extends.
</content>
