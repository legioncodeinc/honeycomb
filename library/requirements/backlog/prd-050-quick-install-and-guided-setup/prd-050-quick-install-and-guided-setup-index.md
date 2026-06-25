# PRD-050: Quick Install and Guided Setup

> **Status:** Backlog
> **Priority:** P0 (growth-critical — the top-of-funnel for every new user)
> **Effort:** XL (> 3d)
> **Schema changes:** None to the DeepLake catalog. Adds a machine-local install/onboarding state file and a referral-attribution header on the existing device-flow request.

---

## Overview

Today a new user becomes a Honeycomb user only after clearing a developer-shaped gauntlet: have a modern Node/npm, install a global package, know to run `honeycomb setup`, know to run a login verb, complete an RFC 8628 device flow **in a terminal**, and only then see anything. Every one of those steps is a cliff a non-expert ("junior vibe coder") falls off. The first thing they ever see is a shell prompt, not the product.

This module inverts that. The deliverable is a **single command** (a `curl … | sh` / `iwr … | iex` quick-install script, plus the `@legioncodeinc/honeycomb` npm bin it bootstraps) that ends with a **browser tab open on a familiar dashboard**, and a **"First time setup" button** that runs the credential-linking flow *for* the user instead of asking them to type it. The terminal is reduced to a progress log; the product is the first surface they touch.

The pivotal architectural realization — and the answer to *"do we need a separate daemon for the dashboard before login?"* — is **no, one daemon, two phases**. The Honeycomb daemon already serves the dashboard over loopback at [`GET /dashboard`](../../../../src/daemon/runtime/dashboard/host.ts) with **no token and no secret in the shell** — the page self-hydrates from local endpoints. And the daemon does not need DeepLake credentials to *boot*; it needs them only for the surfaces that read DeepLake (capture, recall, graph). So the installer brings up the **one** daemon in a **pre-auth "setup" phase** that serves the dashboard shell + the guided-setup wizard locally, the user clicks **First time setup**, the daemon drives the device-flow login (which writes the shared [`~/.deeplake/credentials.json`](../../../../src/daemon/runtime/auth/credentials-store.ts)), and the DeepLake-backed surfaces light up against the **same already-running daemon**. The embeddings runtime is a lazily-warmed sub-daemon that comes up in the background once it is actually needed — it never gates the dashboard.

Two outcomes drive every decision here:

> **Goal 1 — Time-to-dashboard:** one command → a familiar dashboard, with login performed *through the UI*, not the CLI.
> **Goal 2 — Referral capture:** every install authenticates with **`--ref mario`** baked in, so signups originating from this GitHub repo / npm package are attributed to the operator — independent of Activeloop's own repos and package.

The four sub-PRDs cover the bootstrap installer, the pre-auth dashboard + guided-setup shell, the referral-attributed login, and the Hivemind coexistence/migration path.

---

## Goals

- A **one-command install** (`curl -fsSL https://… | sh` on POSIX, `irm https://… | iex` on Windows PowerShell) that is safe to run on a machine with **no Node and no npm**: it detects, and if absent installs, a current stable Node/npm; installs the `@huggingface/transformers` embedding runtime dependency (and anything else the daemon needs); installs `@legioncodeinc/honeycomb` **globally** (`npm i -g`); and brings up the daemon — with a readable progress log, never a stack trace, on each step.
- The install ends by **opening the dashboard in the default browser** against the loopback daemon (aspirationally reachable at a friendly `honeycomb.local` host, with the `127.0.0.1:3850` loopback as the always-works fallback).
- The daemon boots and serves the dashboard **before any DeepLake login** (pre-auth phase). No second daemon is introduced; the dashboard is never gated behind credentials it does not yet have.
- When the user has **no** `~/.deeplake` / `~/.honeycomb` / `~/.hivemind` credentials, the dashboard shows a **guided setup** state with a **"First time setup"** button. Clicking it runs the equivalent of **`honeycomb install --ref mario`**: it starts the device flow, **renders the DeepLake user-code on the setup page itself** (not just the terminal), and opens the DeepLake verification / create-account page in a browser tab.
- When the user **does** have a credential folder (likely a prior **Hivemind** install), the setup surface explains that **running Hivemind and Honeycomb together is unsupported**, and offers **"Proceed with Honeycomb"** → automatic Hivemind uninstall → a **"Link to DeepLake"** step that runs the same `--ref mario` device flow.
- **Every** Honeycomb install attributes its signup with the referral code (`mario` by default), threaded through the existing device-flow request as a header — so attribution is automatic, not a thing the user (or operator) has to remember.

## Non-Goals

- **A new auth backend or a new credential shape.** The device flow, the shared `~/.deeplake/credentials.json` (0600), org pinning, and drift-heal (PRD-011b / PRD-023) are reused verbatim; this module *triggers* them from the UI and *attributes* them, it does not reinvent them.
- **A second daemon, or a public-facing server.** The dashboard stays a **loopback, local-mode-only** surface ([`host.ts`](../../../../src/daemon/runtime/dashboard/host.ts) is mounted only when `mode === "local"`). `honeycomb.local` is a local-resolution convenience, never a remote bind.
- **Designing the npm publish pipeline.** Getting `@legioncodeinc/honeycomb` actually published is **[PRD-048](../prd-048-npm-publishing-pipeline/prd-048-npm-publishing-pipeline-index.md)**; this module *consumes* the published package and assumes its bin exists.
- **Bundling a Node runtime.** We detect/guide/instal­l Node via the platform's standard path; we do not ship a vendored Node.
- **Re-architecting the embeddings daemon.** Its lifecycle (warmup, socket IPC) is owned by the embeddings-runtime work; here it is only *sequenced* (background, non-blocking) relative to the dashboard.
- **Multi-referrer / affiliate management UI.** The referral code is a build-time/install-time default (`mario`), overridable by flag; a dashboard to manage codes is out of scope.

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-050a-…-one-command-bootstrap-installer`](./prd-050a-quick-install-and-guided-setup-one-command-bootstrap-installer.md) | The `curl\|sh` / `irm\|iex` script: Node/npm detect-and-install, `@huggingface/transformers` + deps, `npm i -g @legioncodeinc/honeycomb`, daemon boot on 3850, optional `honeycomb.local`, and the open-the-dashboard handoff — all with a friendly progress log. | Draft |
| [`prd-050b-…-pre-auth-dashboard-and-setup-shell`](./prd-050b-quick-install-and-guided-setup-pre-auth-dashboard-and-setup-shell.md) | The one-daemon / two-phase model: boot the daemon unauthenticated, serve the dashboard + a **guided "First time setup"** wizard with no credentials, detect credential presence, and hydrate the DeepLake surfaces once login completes. | Draft |
| [`prd-050c-…-referral-attributed-login`](./prd-050c-quick-install-and-guided-setup-referral-attributed-login.md) | Thread `--ref mario` into the device-flow request as a referral header; render the user-code **on the setup page** + open the DeepLake verification / create-account page; default the ref to `mario` for every Honeycomb install. | Draft |
| [`prd-050d-…-hivemind-coexistence-and-migration`](./prd-050d-quick-install-and-guided-setup-hivemind-coexistence-and-migration.md) | Detect an existing Hivemind/credential install, explain the unsupported-coexistence rule, and on **"Proceed with Honeycomb"** uninstall Hivemind then run the **"Link to DeepLake"** `--ref mario` flow. | Draft |
| [`prd-050e-…-operator-adoption-telemetry`](./prd-050e-quick-install-and-guided-setup-operator-adoption-telemetry.md) | **Path B** — the daemon emits anonymized install / first-link / Hivemind-upgrade events (tagged with `ref`) to an operator-owned PostHog so upgraders are *measurable* even though registration-time referral can't credit an already-registered account. Opt-out, fail-soft, allow-list payload. | Draft |

---

## Acceptance criteria (module-level)

| ID | Criterion |
|---|---|
| AC-1 | On a clean machine with **no Node/npm**, running the single quick-install command installs a current stable Node/npm, the embedding deps, and `@legioncodeinc/honeycomb` globally, starts the daemon, and **opens the dashboard in a browser** — with the terminal showing a readable step log, no stack trace, on success. |
| AC-2 | The dashboard is reachable and renders **before any DeepLake login** — the daemon serves `GET /dashboard` over loopback with no credentials present, and **no second daemon process** is introduced to do so. |
| AC-3 | Given **no** `~/.deeplake` / `~/.honeycomb` / `~/.hivemind` credentials, the dashboard shows the guided-setup state with a **"First time setup"** button; clicking it begins the device flow, **shows the DeepLake user-code on the page**, and opens the DeepLake verification / account-creation page. |
| AC-4 | Completing the device flow writes the shared `~/.deeplake/credentials.json` (0600) and the **same** running daemon transitions to the authenticated phase — the DeepLake-backed dashboard surfaces hydrate **without restarting the daemon or re-opening the browser**. |
| AC-5 | **Every** completed login from a Honeycomb install carries the referral code (`mario` by default) on the device-code request, and a build/test asserts the header is present and defaults correctly when no `--ref` is passed. |
| AC-6 | Given an existing Hivemind/credential install, the setup surface states that running both is unsupported; **"Proceed with Honeycomb"** uninstalls Hivemind and then runs the **"Link to DeepLake"** `--ref mario` flow to completion. |
| AC-7 | Every failure mode (no network, Node install blocked, port 3850 taken, device flow timed out, Hivemind uninstall failed) surfaces a **plain-language** message and a single suggested next action — never a raw stack trace as the only output. |
| AC-8 | The dashboard shell served pre-auth carries **no token/secret** (parity with [`renderShell`](../../../../src/daemon/runtime/dashboard/host.ts)); the guided-setup endpoints it calls are loopback-only and local-mode-only. |
| AC-9 | A Hivemind→Honeycomb upgrade emits an anonymized, `ref`-tagged adoption event to the operator's PostHog (050e) — at most once per machine, opt-out-respecting, and **never** blocking or erroring the migration — so upgraders are countable even when registration-time referral cannot credit them. |

---

## Data model changes

**No DeepLake catalog changes.** Onboarding is machine-local and credential-adjacent:

- **A machine-local onboarding/install state file** (e.g. `~/.deeplake/onboarding.json` or under the runtime dir) recording install phase, whether first-time setup has completed, the detected prior-tool state (Hivemind present/migrated), and the effective referral code — read fail-soft (missing/malformed → "fresh install", never a throw), mirroring the resilience posture of [`credentials-store.ts`](../../../../src/daemon/runtime/auth/credentials-store.ts). Carries **no secret** (the token stays only in `credentials.json`).
- **Credential presence detection** reads the existing three locations — `~/.deeplake` (shared, current), `~/.honeycomb` (legacy Honeycomb), `~/.hivemind` (Hivemind) — exactly the locations the credential loader already knows about; it does not introduce a new credential format.

---

## API changes

The partition boundary and the auth backend are unchanged. New/changed surface, all **loopback + local-mode-only**:

- **Daemon (new local routes under the dashboard host group):** `GET /setup/state` (credential presence + onboarding phase + prior-tool detection), `POST /setup/login` (begin the device flow and stream back the user-code + verification URI for on-page display), `POST /setup/migrate-from-hivemind` (uninstall Hivemind, then begin the `--ref mario` login). These sit beside [`mountDashboardHost`](../../../../src/daemon/runtime/dashboard/host.ts) and obey the same local-mode gate.
- **Device-flow request gains a referral header** — `X-Hivemind-Referrer: <ref>` on `POST /auth/device/code` (the backend-recognized attribution header, ported from Hivemind's `hivemindReferrerHeader`), defaulted to `mario` for Honeycomb installs. Threaded through [`requestDeviceCode`](../../../../src/daemon/runtime/auth/deeplake-issuer.ts) without ever placing the ref in a URL or a log line. (Header-name choice — reuse the Hivemind-named header the backend already keys on vs a Honeycomb-namespaced one — is an open question below.)
- **CLI:** a referral-aware quick-install verb — the user-facing **`honeycomb install --ref mario`** — that the **"First time setup"** / **"Link to DeepLake"** buttons invoke; it composes the existing `setup` connector engine + the device-flow login with the ref pre-bound. (Whether this is a new `install` verb or `setup --ref` is a 050a decision.)
- **Outbound telemetry (050e, Path B):** the daemon `POST`s anonymized lifecycle events to an operator-owned PostHog capture endpoint (write-only key) — egress that is opt-out (`HONEYCOMB_TELEMETRY=0` / `DO_NOT_TRACK=1`), allow-list-only, and fail-soft. This is the **only** outbound call this module adds beyond the existing `api.deeplake.ai` auth traffic.

---

## Open questions

- [ ] **`honeycomb.local` resolution:** mDNS/Bonjour advertisement, a `/etc/hosts` write (needs elevation), or a documented `http://127.0.0.1:3850/dashboard` fallback as the primary? Lean: loopback URL is the contract; `honeycomb.local` is best-effort polish that **never** gates AC-1.
- [ ] **Referral header name:** reuse `X-Hivemind-Referrer` (the backend already attributes on it) or mint `X-Honeycomb-Referrer` and require a backend change? Reuse is zero-backend-work and ships Goal 2 immediately; namespacing is cleaner long-term. Confirm with the DeepLake/Activeloop backend owner.
- [ ] **Node install mechanism per OS:** official installer, `nvm`/`fnm`, the system package manager, or `winget`/Homebrew? Which require elevation, and what is the no-elevation fallback (print exact copy-paste instructions and stop cleanly)?
- [ ] **Trust posture of `curl | sh`:** publish a checksum + a "read the script first" URL; consider an npm-only path (`npm create @legioncodeinc/honeycomb`) for users who refuse piped-shell installs.
- [ ] **Hivemind uninstall reliability:** how installed (npm global? a harness wiring?), and how to uninstall **idempotently and reversibly** — back up its config before removal, and what to do when the uninstall partially fails (AC-7).
- [ ] **Embeddings sequencing:** confirm the `@huggingface/transformers` model download (≈hundreds of MB) is fully backgrounded and that recall degrades to the BM25 fallback until warm, so a slow model pull never blocks the dashboard or the login.
- [ ] **Auto-login-after-install:** should the installer pre-open the dashboard *on* the First-time-setup state, or auto-start the device flow immediately? Lean: open the dashboard, let the user click — one explicit consent click before a browser-account flow.
- [x] **Credential store substrate — file vs SQLite → RESOLVED: file-based, settled.** Credentials remain the plaintext-shape file at `~/.deeplake/credentials.json` (0600), byte-shared with Hivemind ([`credentials-store.ts`](../../../../src/daemon/runtime/auth/credentials-store.ts)); the pre-auth "boot-without-creds" phase (050b) relies on `loadCredentials()` returning `null` on a **missing file**, and that is the contract 050 builds on. Rationale: SQLite exists in the tree **only** for the durable *log* store (PRD-043a, `node:sqlite`/`DatabaseSync` behind `--experimental-sqlite`, allowed to **degrade to in-memory** when absent) — a degrade-to-memory posture that is fine for logs but unacceptable for a token. The secrets vault independently reached the same conclusion: it forbids SQLite ([`vault/CONVENTIONS.md`](../../../../src/daemon/runtime/vault/CONVENTIONS.md): *"no SQLite"*) and even its DeepLake-token migration is **COPY-not-move**, leaving the credentials file byte-authoritative for the shared Hivemind login ([`vault/migrate.ts`](../../../../src/daemon/runtime/vault/migrate.ts)). The file is therefore the deliberate, audited design across both the auth and secrets layers — not an interim choice. Any future per-session/per-project scope ([PRD-049](../prd-049-multi-project-and-context-switching/prd-049-multi-project-and-context-switching-index.md)) is layered **beside** this file, not by migrating it to a relational store.

---

## Related

- [PRD-011b: Device-Flow Auth](../../completed/prd-011-tenancy-and-auth/prd-011b-tenancy-and-auth-device-flow-auth.md) — the device flow + shared `~/.deeplake/credentials.json` this module triggers from the UI and attributes (the `api.deeplake.ai` adapter is PRD-023's `deeplake-issuer.ts`).
- [PRD-048: npm Publishing Pipeline](../prd-048-npm-publishing-pipeline/prd-048-npm-publishing-pipeline-index.md) — publishes the `@legioncodeinc/honeycomb` package this installer pulls; hard dependency for AC-1 in the field.
- [PRD-021: Go-Live](../../completed/prd-021-go-live/prd-021-go-live-index.md) / [CLI Command Architecture](../../../knowledge/private/operations/cli-command-architecture.md) — the `setup` engine + daemon-ensure path the `install` verb composes.
- [PRD-024: Dashboard UI Parity](../../completed/prd-024-dashboard-ui-parity/prd-024-dashboard-ui-parity-index.md) — the self-hydrating, token-free dashboard shell ([`host.ts`](../../../../src/daemon/runtime/dashboard/host.ts)) the pre-auth phase reuses.
- [Credential Storage](../../../knowledge/private/security/credential-storage.md) · [Auth Architecture](../../../knowledge/private/auth/auth-architecture.md) — the credential locations (`~/.deeplake`, `~/.honeycomb`, `~/.hivemind`) detection reads.
- [Daemon Surface](../../../knowledge/private/architecture/daemon-surface.md) · [Notifications and Health](../../../knowledge/private/operations/notifications-and-health.md) — the daemon lifecycle + health probe the installer waits on.
- Referral mechanic ported from Hivemind's `hivemindReferrerHeader` (`X-Hivemind-Referrer` on `/auth/device/code`): [`hivemind/src/commands/auth.ts`](https://github.com/activeloopai/hivemind/blob/main/src/commands/auth.ts).
- Code touchpoints: [`src/daemon/runtime/dashboard/host.ts`](../../../../src/daemon/runtime/dashboard/host.ts) · [`src/daemon/runtime/auth/deeplake-issuer.ts`](../../../../src/daemon/runtime/auth/deeplake-issuer.ts) · [`src/daemon/runtime/auth/credentials-store.ts`](../../../../src/daemon/runtime/auth/credentials-store.ts) · [`src/commands/daemon.ts`](../../../../src/commands/daemon.ts).
</content>
</invoke>
