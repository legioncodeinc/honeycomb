# PRD-050d: Hivemind Coexistence Detection and Migration

> **Parent:** [PRD-050](./prd-050-quick-install-and-guided-setup-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M (0.5-1d)
> **Schema changes:** None. Reads existing credential locations; records migration state locally.

---

## Overview

Honeycomb and Hivemind are siblings that **share one credential file** (`~/.deeplake/credentials.json`) and overlapping harness wiring — but running **both** against the same machine is unsupported (duplicate capture/recall hooks, competing daemons, ambiguous ownership). A user arriving at the guided setup who **already has a credential folder** almost certainly has a prior **Hivemind** (or legacy Honeycomb) install. Rather than silently colliding, this sub-PRD detects that, **explains the rule in plain language**, and offers a clean one-click path: **"Proceed with Honeycomb"** → uninstall Hivemind → **"Link to DeepLake"** (the 050c `--ref mario` flow).

The detection is exactly the credential-location check 050b's `GET /setup/state` already does (`~/.deeplake` / `~/.honeycomb` / `~/.hivemind`); this module adds the *prior-tool reasoning* on top of it and owns the **uninstall + migration** action.

## Goals

- **Detect a prior install:** distinguish "fresh" (no credential folders) from "has a credential folder" (likely Hivemind), surfacing it in the setup state so the dashboard renders the **coexistence-warning** variant of the wizard instead of plain first-time setup.
- **Explain, don't surprise:** the dashboard states clearly that running Hivemind and Honeycomb together is **not supported**, what "Proceed with Honeycomb" will do (uninstall Hivemind), and that the existing DeepLake account/credential is **reused** (one login serves both — the shared file means the user may not even need to re-auth).
- **One-click migration:** **"Proceed with Honeycomb"** calls a loopback `POST /setup/migrate-from-hivemind` that uninstalls Hivemind **idempotently and reversibly** (back up its config first), then advances to **"Link to DeepLake"** which runs the 050c referral-attributed flow.
- **Reuse the shared credential when valid:** because `~/.deeplake/credentials.json` is byte-compatible across both tools, if a valid credential already exists, "Link to DeepLake" should **verify-and-adopt** it (a `GET /me` check) rather than forcing a redundant device flow — only falling to a fresh `--ref mario` login when none is valid.
- **Safe failure:** a partial/failed uninstall leaves a plain-language message + the backed-up config location, and never bricks the machine or deletes the credential (parent AC-7).

## Non-Goals

- The fresh-install wizard + phase model (050b) and the device-flow/referral mechanics (050c) — this owns detection + uninstall + the migration sequencing only.
- Migrating Hivemind *data* out of DeepLake — the data lives in the shared backend under the same account; nothing to move.
- Supporting genuine side-by-side operation — the explicit decision is that coexistence is unsupported.

## User stories

- As a current Hivemind user, the dashboard tells me I can't run both, offers one button to switch, and — because we share the login — I'm on the Honeycomb dashboard without even re-authenticating.
- As a cautious user, I can see that my Hivemind config was backed up before removal, so switching feels reversible.
- As a user whose uninstall hits a snag, I get a clear message and the backup path, not a broken half-state.

## Acceptance criteria

| ID | Criterion |
|---|---|
| d-AC-1 | Given an existing Hivemind/credential install, `GET /setup/state` flags prior-tool present and the dashboard renders the **coexistence-warning** wizard (not the plain first-time state). |
| d-AC-2 | The warning clearly states coexistence is unsupported and what "Proceed with Honeycomb" does, before any destructive action. |
| d-AC-3 | "Proceed with Honeycomb" backs up the Hivemind config, uninstalls Hivemind idempotently, then advances to "Link to DeepLake". |
| d-AC-4 | "Link to DeepLake" with a **valid** existing `~/.deeplake/credentials.json` verifies it via `GET /me` and adopts it (no redundant device flow); with **no** valid credential it runs the 050c `--ref mario` device flow. |
| d-AC-5 | A failed/partial uninstall surfaces a plain-language message + the backup location and does **not** delete the shared credential or leave the daemon unusable. |
| d-AC-6 | After migration completes, `GET /setup/state` reports `hivemind: migrated` and the dashboard is in the authenticated phase (one running Honeycomb daemon). |

## Implementation notes

- **Detection reuses 050b.** No new scanning logic — the prior-tool flag is derived from the same `~/.deeplake` / `~/.honeycomb` / `~/.hivemind` presence check `GET /setup/state` already performs; this module adds the interpretation ("folder present + not ours → likely Hivemind") and the wizard variant.
- **Uninstall must be honest about how Hivemind was installed.** Likely `@deeplake/hivemind` global npm + harness hook wiring; the uninstall should mirror Honeycomb's own `uninstall` verb shape (detect targets, unwire hooks) and **back up** `~/.hivemind` (and any Hivemind harness markers) to a timestamped path before removal — reversible by design (parent open question on reliability).
- **Adopt-the-shared-credential is the nice surprise.** Because the credential file is shared and byte-compatible ([`credentials-store.ts`](../../../../src/daemon/runtime/auth/credentials-store.ts)), the common case is **no re-auth at all**: validate with `getMe` ([`deeplake-issuer.ts`](../../../../src/daemon/runtime/auth/deeplake-issuer.ts)) and adopt; only a missing/invalid/expired credential triggers the 050c flow (which still carries `--ref mario`).
- **Migration is one guarded transaction in the daemon:** back up → uninstall → re-check credential → (adopt | login) → stamp onboarding `hivemind: migrated`. Each step logs a plain line; any failure stops with a recoverable message, never a trace.
- **Telemetry hook (050e) — this is how upgraders get counted at all.** On a *completed* migration the daemon emits `honeycomb_hivemind_upgrade` (tagged with the resolved `ref`) via the 050e chokepoint. This fires **even on the silent credential-adopt path** where no device flow runs — so it is the **only** signal that captures the adopt-without-re-auth cohort the `X-Hivemind-Referrer` header (050c) structurally misses. Opt-out-respecting, deduped, fail-soft; never blocks the migration.
- **Silent-adopt vs force-relogin (the attribution tradeoff):** the default is silent-adopt (best UX, but the referral header never reaches the backend). **If** Path A lands (the backend attributes an existing-account adoption — the gating open question below), the migration should instead **force a fresh `--ref mario` device flow** so the header is sent; the one extra browser approval is the cost of a shot at backend referral *credit*. Until Path A is confirmed, keep silent-adopt and rely on 050e for measurement.
- **Local-mode + loopback only**, beside the other setup routes (050b host group).

## Open questions

- [ ] How is Hivemind actually installed on a typical user machine (global npm? per-harness wiring?), and what's the precise idempotent uninstall (reuse/extend Honeycomb's `uninstall` verb)?
- [ ] Back up `~/.hivemind` where, and do we ever offer a "restore Hivemind / undo" path, or is the backup just insurance?
- [ ] **Path A (gating, backend-owned): does Activeloop's referral system attribute an *already-registered* account on first Honeycomb-client touch, or only a new signup?** If **yes** → switch the migration default to force a fresh `--ref mario` device flow (don't silently adopt) so the header reaches the backend, and existing-but-*unattributed* upgraders can earn credit (first-touch systems won't reattribute an already-credited account). If **no** → upgraders can never earn Activeloop *referral payout*; measurement falls entirely to 050e (Path B). Confirm with the DeepLake/Activeloop backend owner — this single answer decides the silent-adopt-vs-force-relogin default above.
- [ ] Should migration also re-point any Hivemind-wired harness hooks to Honeycomb, or leave hook wiring to `honeycomb setup`?

## Related

- [`src/daemon/runtime/auth/credentials-store.ts`](../../../../src/daemon/runtime/auth/credentials-store.ts) — the shared/byte-compatible credential + the `~/.deeplake` / `~/.honeycomb` / `~/.hivemind` locations detection reads.
- [`src/daemon/runtime/auth/deeplake-issuer.ts`](../../../../src/daemon/runtime/auth/deeplake-issuer.ts) — `getMe` (verify-and-adopt) and the 050c `--ref mario` flow the migration ends on.
- [`src/commands/daemon.ts`](../../../../src/commands/daemon.ts) — the single-daemon lifecycle migration runs against; the `uninstall` verb shape to mirror.
- [PRD-050b](./prd-050b-quick-install-and-guided-setup-pre-auth-dashboard-and-setup-shell.md) — the `GET /setup/state` detection this interprets. · [PRD-050c](./prd-050c-quick-install-and-guided-setup-referral-attributed-login.md) — the login the "Link to DeepLake" step runs.
- [PRD-050e](./prd-050e-quick-install-and-guided-setup-operator-adoption-telemetry.md) — the `honeycomb_hivemind_upgrade` event (Path B) that counts this migration even when the referral header can't; its Path A gating question is the one above.
- [Harness Integration](../../../knowledge/private/integrations/harness-integration.md) · [Hook Lifecycle](../../../knowledge/private/integrations/hook-lifecycle.md) — the wiring an uninstall must unwind.
</content>
