# PRD-050e: Operator Adoption Telemetry (Path B)

> **Parent:** [PRD-050](./prd-050-quick-install-and-guided-setup-index.md)
> **Status:** Completed — shipped with PRD-050 (merged #100, 2026-06-25)
> **Priority:** P1 (this is the floor for Goal 2 measurement — works with zero backend dependency)
> **Schema changes:** None to the DeepLake catalog. Adds anonymized lifecycle events to an operator-owned PostHog project + a dedupe flag in the local onboarding file.

---

## Overview

Honeycomb's only built-in attribution — the `X-Hivemind-Referrer` header (050c) — attributes **new DeepLake registrations**. It structurally cannot credit a **Hivemind→Honeycomb upgrader**, who is an *already-registered* account (and who, per [050d](./prd-050d-quick-install-and-guided-setup-hivemind-coexistence-and-migration.md), often migrates by **adopting the shared credential without re-authenticating at all** — so no device-code request is even issued). The referral header is therefore blind to exactly the cohort Goal 2 most wants to count.

This sub-PRD is the **operator-owned measurement floor** that closes that gap without depending on Activeloop. Because Honeycomb is the operator's **own** npm package and repo, the Honeycomb **daemon** emits a small set of **anonymized lifecycle events** — install, first-link, and Hivemind-upgrade — to an operator-controlled **PostHog** project, each tagged with the effective referral code. The operator then measures their true install→link→upgrade funnel and the upgrade volume attributable to them, **regardless** of whether Activeloop's referral system ever credits an existing-account adoption.

The honest boundary, stated up front so the doc never over-promises: **this is measurement, not monetization.** It lets the operator *count* upgraders and *prove the number*; it does not make Activeloop *pay* for them. Backend adoption-attribution (Path A — the gating open question in [050d](./prd-050d-quick-install-and-guided-setup-hivemind-coexistence-and-migration.md)) is the only path that turns these counts into referral credit. Path B is the always-works complement to it.

The design is constrained hard by this codebase's trust posture — the same PII/credential discipline that keeps the bearer token out of every log line in [`deeplake-issuer.ts`](../../../../src/daemon/runtime/auth/deeplake-issuer.ts) governs every byte that leaves the machine here.

## Goals

- **Three anonymized lifecycle events**, emitted by the daemon at the points the other sub-PRDs own:
  - `honeycomb_installed` — daemon first boot after install (050a hook).
  - `honeycomb_first_link` — a fresh-user device flow completes (050c hook).
  - `honeycomb_hivemind_upgrade` — a Hivemind migration completes (050d hook).
- **A strict allow-list payload** carrying only non-PII: an anonymized `distinct_id`, the `ref` code, `source_tool`, `honeycomb_version`, coarse platform (`os`/`arch`/`node`), and a timestamp. A test **asserts** the token, email, `userName`, raw cwd/repo paths, and any memory/secret content are **never** in the payload.
- **A single emit chokepoint** — one `emitTelemetry(event, props)` module that applies the allow-list, the opt-out gate, and redaction in one place, so no call site can leak a field.
- **Opt-out, disclosed:** honor `HONEYCOMB_TELEMETRY=0` and `DO_NOT_TRACK=1`, document it in the README and surface it on first run; emit nothing when opted out.
- **Fire-and-forget, fail-soft:** bounded timeout, failure swallowed — telemetry **never** blocks or errors install, login, or migration.
- **Idempotent:** each event is reported at most once per machine (a dedupe flag in the local onboarding file), so a re-run of the installer or migration never double-counts.
- **Operator measurement:** the events power an install→link→upgrade funnel and a `count(honeycomb_hivemind_upgrade) by ref` trend in the operator's PostHog.
- **Trustworthy by construction:** every emitted property passes the content/operation bright line + shrug test (see the event catalog below), Tier-2 usage signals are opt-in, and a glass-box `telemetry --show` proves to the user that the displayed set *is* the egress set.

## Non-Goals

- **Backend referral credit (Path A).** Turning an upgrade into an Activeloop payout is 050d's gating backend question, not this module.
- **Content, ever — and any item-level event.** The hard, non-negotiable exclusion is the *content the tool handles* (memory/session text, code, prompts, recall queries, file paths, cwd, repo/branch names, org/workspace names, identities, secrets) and any *per-item* event (per-memory, per-query, per-file — the cardinality itself reads as surveillance for a memory tool). Operational/health signals (Tier 1) and **bucketed** usage *counts* (Tier 2, opt-in) are in scope per the event catalog below; raw content and item-level egress never are.
- **A self-hosted analytics backend.** v1 posts directly to PostHog's public capture endpoint with a write-only key; an operator-owned forwarding proxy is a later option, not v1.
- **Cross-device identity resolution** beyond the optional salted-hash id below.

## Event catalog and egress policy — the content/operation bright line

The governing rule: telemetry may describe **how the tool behaves** (counts, durations, versions, states, error *classes*); it must never describe **the content the tool handles**. The operational test for any proposed property — the **shrug test** — is *"would the user shrug if they saw this value in plaintext?"* If they'd lean in and squint, it is over the line. Honeycomb captures coding sessions and memories (the most sensitive data a dev tool touches), so this line is the difference between trustworthy telemetry and a perceived exfiltration channel.

**Tier 1 — ship, opt-out, self-evidently safe (operational facts about the tool, not the user's work):**

| Event / property | Value | Why safe |
|---|---|---|
| `honeycomb_installed` / `honeycomb_first_link` / `honeycomb_hivemind_upgrade` | lifecycle + `ref` | a moment, no content |
| `honeycomb_uninstalled` | lifecycle | churn signal; no content |
| `daemon_started` (throttled ≤1/day) | timestamp + install-id | DAU/retention proxy |
| harness mix | enum (`claude-code`/`cursor`/`codex`/`hermes`/`pi`/`openclaw`) | a platform name, never a project |
| `honeycomb_version` / `os` / `arch` / `node` | version strings | already in the base payload |
| embeddings outcome | `warm` \| `bm25_fallback` | a boolean-ish enum |
| daemon crash/restart count + **error class** | coarse taxonomy (`deeplake_429`, `embed_timeout`) | class only — **never the message or stack** |
| coarse perf timings | boot ms, recall p50/p95 | pure numbers |

Tier 1 composes the **activation funnel** (`installed → linked → first_capture → first_recall`) — the metric that proves the product delivers value — entirely from non-content lifecycle events.

**Tier 2 — safe but opt-in (or loudly disclosed); these smell like "usage", so they must be earned:**

| Event / property | Value | Guard |
|---|---|---|
| feature-on booleans | `embeddings_on`, `team_skills_on`, `mcp_registered` | opt-in |
| **bucketed** counts | `memories: 0 / 1–10 / 11–100 / 100+` | bucketed (never precise — precision fingerprints), opt-in |
| MCP tool-name invocation counts | `hivemind_search: N` | tool **name** + count only, never args/results, opt-in |

**Never — regardless of how useful it sounds:** error *messages* or stack traces (carry paths + code); recall query strings, memory/session text, prompts; repo names/URLs **even hashed** (a hash of a public repo is dictionary-reversible); file paths, cwd, branch names, env values, secrets, email, raw account/org/workspace ids; precise per-item counts; per-memory/per-query/per-file events.

**Trust-builders (counts-not-content is necessary but not sufficient):**
- **Glass-box it.** Ship `honeycomb telemetry --show` (and a dashboard panel) that displays *exactly* what has been/would be sent — the events exist locally, so "here is literally everything we phone home, in plaintext" is a stronger argument than any policy. For a memory tool this is the decisive conversion move.
- **Aggregate-only egress** — daemon/session-level rollups sampled from the health signals the daemon already computes ([notifications-and-health](../../../knowledge/private/operations/notifications-and-health.md), the PRD-043a log store), never item-level instrumentation.
- **Buckets over precision; random install-id over any content-derived id** (e-AC-6).
- **Tiered consent:** Tier 1 = opt-out (legitimate interest); Tier 2 = opt-in. `DO_NOT_TRACK` / `HONEYCOMB_TELEMETRY=0` silence everything.
- **Self-host conservatism:** a session pointed at BYOC/self-hosted DeepLake is an enterprise user who will firewall egress anyway — default Tier-2 off (and consider Tier-1 minimal) in that mode, before they ask.

This whole catalog rides the **existing** `emitTelemetry` chokepoint + allow-list (e-AC-2/e-AC-7): adding an event is adding an allow-listed field, and the banned-list assertion just grows to cover it. No new egress path, no new substrate. The bright-line rule is recorded durably in [Trust Boundaries → Telemetry Egress Boundary](../../../knowledge/private/security/trust-boundaries.md).

## User stories

- As the operator, I can see in my own dashboard how many Hivemind users upgraded to Honeycomb under my ref, even though Activeloop's referral system can't credit an existing account.
- As a privacy-conscious user, I can set `HONEYCOMB_TELEMETRY=0` (or `DO_NOT_TRACK=1`) and the client sends nothing, and the README told me so.
- As the operator, a telemetry outage or a user behind a firewall never breaks anyone's install — the event just doesn't arrive.

## Acceptance criteria

| ID | Criterion |
|---|---|
| e-AC-1 | `honeycomb_installed`, `honeycomb_first_link`, and `honeycomb_hivemind_upgrade` each emit exactly once at their defined lifecycle point, carrying the effective `ref` (default `mario`). |
| e-AC-2 | The payload contains only allow-listed fields; a test asserts the **banned set** — bearer token, email, `userName`, raw cwd/repo paths, repo/branch names, recall query strings, memory/session content, error *messages*/stack traces, secrets, and raw account/org/workspace ids — is **absent** from every event (the banned-list grows with each new event but the assertion is one structural test). |
| e-AC-3 | With `HONEYCOMB_TELEMETRY=0` **or** `DO_NOT_TRACK=1` set, **no** network call is made for any event (asserted against an injected fetch recorder). |
| e-AC-4 | Telemetry is fire-and-forget: an emit that times out, errors, or 4xx/5xxs does **not** change the exit code or surface an error in install/login/migration; the user-facing flow is byte-identical with telemetry on vs off (minus the network call). |
| e-AC-5 | Each event is deduped per machine via the onboarding flag — a second installer/migration run does not re-emit an already-reported event. |
| e-AC-6 | The `distinct_id` is anonymized (random install-id by default; never the email or raw account id), stable across runs on one machine. |
| e-AC-7 | All emit paths funnel through the single `emitTelemetry` chokepoint (a structural test: no call site posts to the capture endpoint directly). |
| e-AC-8 | **Glass-box:** `honeycomb telemetry --show` (and a dashboard panel) renders, in plaintext, exactly what has been sent and what would be sent next — sourced from the same local events, so the displayed set and the egress set are provably identical. |
| e-AC-9 | **Tiered consent:** Tier-1 (operational) events emit under opt-out; Tier-2 (usage-count) events emit **only** when the user has opted in — a test asserts a default install emits **no** Tier-2 event, and `DO_NOT_TRACK`/`HONEYCOMB_TELEMETRY=0` silences both tiers. |
| e-AC-10 | **No item-level egress:** a structural test asserts there is no per-memory / per-query / per-file emit path; counts are bucketed (the precise number never leaves the machine) and all egress is daemon/session-level rollup. |

## Implementation notes

- **Daemon emits, not the shell script.** The installer (050a) finishing triggers the daemon's first boot; the daemon is where the migration (050d) and login (050c) complete, and it already has the hardened-fetch + redaction posture. Keep `curl`/`iwr` out of the analytics business — the shell scripts stay dumb.
- **The chokepoint** is a small daemon-side module (e.g. `src/daemon/runtime/telemetry/emit.ts`) exporting `emitTelemetry(event, props)`. It: (1) reads the build-injected `__HONEYCOMB_POSTHOG_KEY__` and returns immediately if it is empty (telemetry-disabled — the fail-soft default for unkeyed dev builds); (2) checks the opt-out env vars and returns if set; (3) builds the payload from the **allow-list only**; (4) posts to `__HONEYCOMB_POSTHOG_HOST__` with a bounded timeout; (5) `catch`es and drops everything. It mirrors the injectable-`fetch` seam in [`deeplake-issuer.ts`](../../../../src/daemon/runtime/auth/deeplake-issuer.ts) so tests never hit the network. The key/host/ref-default arrive via esbuild `define` (the `__HONEYCOMB_POSTHOG_KEY__` / `__HONEYCOMB_POSTHOG_HOST__` / `__HONEYCOMB_REF_DEFAULT__` wiring spec'd in [050a](./prd-050a-quick-install-and-guided-setup-one-command-bootstrap-installer.md)), never a runtime `process.env` read.
- **Transport + destination (pinned):** `POST https://us.i.posthog.com/i/v0/e/` with `{ api_key, event, properties, distinct_id }`, ingesting into the operator-owned PostHog project **"Honeycomb" (id `485287`, US cloud, org Legion Code Inc.)** — deliberately separate from the product-analytics project (`legionsight.ai`, 448151) so the publicly-shipped write key's blast radius is the install-funnel project only. The PostHog **project API key (`phc_…`) is write-only** and safe to ship in the published package (it can ingest, not read). Single timeout, no retry (a dropped marketing event is acceptable; a hung install is not). The key itself is **not** committed to the repo as a secret-management concern — it is a public ingest key, but source it via build-time `define`/env so rotation is one place.
- **`distinct_id`:** default = a random UUID generated once and stored in the local onboarding file (fully anonymous; same human on two machines counts twice — acceptable for v1). Optional upgrade: `sha256(accountId + fixed_salt)` for cross-machine dedupe — pseudonymous, so it requires the disclosure copy to say so. Start with the random id.
- **Dedupe** via an `onboarding.json` field per event (`reported.installed`, `reported.first_link`, `reported.upgrade`), fail-soft like the rest of that file. PostHog-side dedup on an event uuid is a backstop, not the primary guard.
- **Opt-out + disclosure** is a first-class deliverable, not a footnote: README section, a one-line first-run notice, and both `HONEYCOMB_TELEMETRY=0` and `DO_NOT_TRACK=1` honored. Given the repo's trust culture, err toward loud disclosure even though the data is anonymous.
- **`ref` plumbing:** the effective referral (default `mario`, override `--ref`) is already resolved for 050c's header; the same resolved value is passed into the event props so the header and the telemetry agree on the code.

## Open questions

- [ ] **Anonymous install-id vs salted-account-hash** as `distinct_id` — ship anonymous (lean), upgrade to hashed only if cross-machine dedupe proves necessary (and then add the pseudonymity disclosure).
- [ ] **Opt-in vs opt-out** for the EU cohort — anonymous install-funnel events are typically legitimate-interest opt-out, but confirm the disclosure copy is sufficient or whether a first-run consent prompt is wanted.
- [ ] **Write-key abuse:** a public write-only key can be spammed with fake events. Acceptable for v1 marketing measurement; a forwarding proxy with light validation is the mitigation if it ever matters.
- [ ] **Reconciliation with Path A:** if Activeloop later credits adoptions, the anonymous Path-B ids won't perfectly reconcile with Activeloop's account-level attribution — decide whether that matters enough to switch to the hashed-account id.
- [x] **Destination project → RESOLVED:** operator-owned PostHog project **"Honeycomb" (id `485287`, US cloud)**, separate from `legionsight.ai` (448151). Still TODO at implementation time: paste the project's write-only `phc_…` key into the build (Project settings → Project API Key).
- [x] **Event endpoint → RESOLVED:** pin the PostHog US-Cloud capture path `POST https://us.i.posthog.com/i/v0/e/` with body `{ api_key, event, properties, distinct_id }`. The legacy `/capture/` alternative is dropped. (Implementation may still smoke-test one real event against project 485287 before first release, but the endpoint is no longer an open decision.)

## Related

- [PRD-050d](./prd-050d-quick-install-and-guided-setup-hivemind-coexistence-and-migration.md) — the upgrade event's emit point; its gating backend question is **Path A** (the monetization complement to this measurement floor).
- [PRD-050c](./prd-050c-quick-install-and-guided-setup-referral-attributed-login.md) — the `ref` resolution + first-link event point; the header and these events share the resolved code.
- [PRD-050a](./prd-050a-quick-install-and-guided-setup-one-command-bootstrap-installer.md) — the install event point + the onboarding-file writer this stamps dedupe flags into.
- [`src/daemon/runtime/auth/deeplake-issuer.ts`](../../../../src/daemon/runtime/auth/deeplake-issuer.ts) — the injectable-fetch + token-redaction posture the emit chokepoint mirrors.
- [Trust Boundaries](../../../knowledge/private/security/trust-boundaries.md) · [Scoping and Visibility](../../../knowledge/private/security/scoping-and-visibility.md) — the PII/egress discipline the allow-list enforces.
</content>
