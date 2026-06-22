# PRD-033: Asset Sync Substrate

> **Status:** In Work (reopened 2026-06-22)
> **Priority:** P2
> **Effort:** L
> **Schema changes:** Additive

---

> **⚠ Reopened 2026-06-22 — partial implementation.** A daemon-wiring liveness audit found this PRD only
> partially live; moved back to `in-work/`. See
> [`../prd-045-daemon-wiring-closeout/reports/2026-06-22-daemon-wiring-liveness-audit.md`](../prd-045-daemon-wiring-closeout/reports/2026-06-22-daemon-wiring-liveness-audit.md).
> **Remaining:** `/api/assets` + the `honeycomb asset` CLI are live, but the session-start asset auto-pull is
> dead code (`daemon-client/assets/install.ts:258` is never called; `session-start.ts:72` auto-pulls only
> skills). Coordinate the shared session-start seam fix with [PRD-045g](../prd-045-daemon-wiring-closeout/prd-045g-daemon-wiring-closeout-team-skill-sharing.md).

---

## Overview

A config-sync substrate — "dotfiles-over-DeepLake" for harness artifacts — that lets a user register a skill or agent and control how far it propagates via an explicit promotion lattice. Every artifact occupies exactly one cell of a two-axis lattice: a **tier** (`Local` → `Device` → `Team`) that sets the propagation blast radius, and a **style** (`Repository` XOR `User`) that sets the physical install location. A dedicated registry file (`.honeycomb/registry.json`, evolving the existing skillify pull manifest) is the source of truth for tier, style, harness, hashes, version, provenance, and device set. Promotion widens the blast radius; demotion retracts it via append-only tombstone rows that the next pull honors. All DeepLake access goes through the honeycomb daemon (port 3850); hooks and the CLI never open DeepLake directly.

This substrate is **distinct from skillify (PRD-016)**: skillify *produces* new skills via an LLM gate, while this substrate *syncs and propagates* existing artifacts under explicit user control. Architecturally, skillify becomes one **producer** that emits rows into this registry; this PRD does not modify skillify itself — it defines the substrate skillify (and manual registration) write into. v1 ships skills and agents only, stores the verbatim native artifact keyed by `(assetType, harness)`, and reserves a `canonical` blob column plus a per-`(assetType, harness)` adapter seam so cross-harness install can later light up with no schema change or re-sync.

## Goals

- Define the tier × style promotion lattice (6 states) and a registry (`.honeycomb/registry.json`) that is the single source of truth for an artifact's tier, style, harness, version, hashes, provenance, and device set across all asset types.
- Sync skills and agents through the daemon, keyed by `(assetType, harness)`, with native-per-harness storage and install onto a matching harness in v1.
- Reserve a `canonical` blob column and a `render(canonical)→native` / `parse(native)→canonical` adapter interface, shipping only the identity adapter in v1 so cross-harness install is additive later.
- Promote (Local→Device→Team, jumps allowed) and demote (the inverse) under explicit user control, retracting from the wider blast radius via tombstone rows on demotion.
- Apply last-writer-wins + `.bak` backup on remote-newer pull, capturing three hashes per artifact (last-synced / local / remote) so real three-way merge data exists from day one.

## Non-Goals

- Hooks, rules, and commands as asset types. Hooks are executable, auto-firing code and a config-merge (not a file-drop) with arbitrary-code-execution risk; they get their own security-gated PRD later. Rules and commands carry prompt-injection risk and will need explicit accept-on-pull when added.
- Real three-way conflict merge — the three hashes are captured in v1, but the merge action is deferred to v2.
- Canonical cross-harness **render** adapters — only the seam and the identity adapter ship in v1.
- Any change to the skillify mining gate or `SKILL.md` authoring (PRD-016 owns that); skillify is a producer into this registry, not modified here.
- An org-wide ("everyone") tier — a future fourth rung above Team, not a redefinition of the v1 lattice.

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-033a-asset-sync-substrate-registry-identity`](./prd-033a-asset-sync-substrate-registry-identity.md) | Registry, identity, hashing, and the additive DeepLake synced-assets schema. | Draft |
| [`prd-033b-asset-sync-substrate-promotion-lifecycle`](./prd-033b-asset-sync-substrate-promotion-lifecycle.md) | Promotion/demotion lifecycle, tombstone retraction, and CLI. | Draft |
| [`prd-033c-asset-sync-substrate-sync-engine`](./prd-033c-asset-sync-substrate-sync-engine.md) | Sync engine (publish + pull) with the adapter seam and last-writer-wins backup. | Draft |

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a skill or agent, when it is registered, then `registry.json` records its tier, style, harness, content hash, and `honeycomb_id`; an artifact at the `Local` tier never writes to DeepLake. |
| AC-2 | Given an artifact promoted to `Device`, when the same user starts a session on a second device (matching style), then the artifact appears there; it does NOT appear for a user in a different workspace. |
| AC-3 | Given an artifact promoted to `Team`, when another author in the same workspace pulls, then the artifact appears for them; it does NOT appear for a user in a different workspace. |
| AC-4 | Given a locally-edited (hash-divergent) artifact, when a remote-newer pull lands, then the existing copy is backed up to `.bak` and overwritten (last-writer-wins). |
| AC-5 | Given a demotion or revocation, when it is applied, then a tombstone row is written and the next pull retracts the local copy across the blast radius. |
| AC-6 | Given v1, when an artifact installs, then it lands only on a matching harness; the `canonical` column and adapter interface exist and the identity adapter round-trips `parse(render(x)) == x`. |
| AC-7 | Given a pull with nothing changed, when it runs, then it is a no-op and never blocks session start (idempotent, fail-soft, consistent with skillify's 5s-budget auto-pull). |

## Data model changes

Additive. A new synced-assets DeepLake table (created lazily on first `INSERT`, per the skillify-table precedent) holds versioned rows with the native artifact blob, a reserved optional `canonical` blob, `harness`, `asset_type`, `version`, a `tombstone` flag, `honeycomb_id`, content hash, and `org` / `workspace` / `author` tenancy columns plus the device set for `Device`-tier rows. Local registry state (`.honeycomb/registry.json`) lives on disk, not in DeepLake, and is the source of truth for tier/style/hashes/provenance. The existing skillify pull manifest is subsumed into or coexists with this registry (see Open questions). No breaking changes.

## API changes

Additive daemon endpoints for publishing a synced-asset version, selecting newer assets for a `(user, workspace, device-set)` audience honoring tombstones, and writing a tombstone on demotion. No breaking changes; hooks and the CLI continue to reach DeepLake only through the daemon.

## Open questions

- [ ] What is the stable device-identity source — a machine-id read, or a generated UUID persisted in `~/.honeycomb` — and how does a user list and revoke a device from their "my devices" set?
- [ ] Should the existing skillify pull manifest be migrated into the unified `registry.json`, or should the two coexist during a transition window?
- [ ] Can agent frontmatter safely carry `honeycomb_id` across all six harnesses without confusing any native parser, or must some harnesses fall back to registry-only identity?
- [ ] On demotion, is the correct retraction UX to delete the local file outright, or to leave it in place but mark it unmanaged?

## Related

- [Skillify Pipeline](../../../knowledge/private/ai/skillify-pipeline.md)
- [Team Skills Sharing](../../../knowledge/private/collaboration/team-skills-sharing.md)
- [PRD-016 Skillify](../../in-work/prd-016-skillify/prd-016-skillify-index.md)
- [PRD-018 Team Skill Sharing](../../in-work/prd-018-team-skill-sharing/prd-018-team-skill-sharing-index.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)
- [Org and Workspace Model](../../../knowledge/private/multi-tenant/org-workspace-model.md)
