# PRD-033b: Promotion/Demotion Lifecycle and CLI

> **Parent:** [PRD-033](./prd-033-asset-sync-substrate-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** M

## Scope

Define the lifecycle that moves an artifact through the tier × style lattice under explicit user control, and the CLI that drives it. This covers registering an artifact, raising and lowering its tier, switching its style, tombstone-based retraction on demotion, and the workspace-scoped semantics of the `Team` tier. It operates on the registry and schema from PRD-033a and is carried out by the sync engine in PRD-033c.

## Goals

- Provide CLI commands to register a skill or agent and to set, raise, or lower its tier and switch its style.
- Enforce the legal promotion path `Local → Device → Team` (jumps allowed) and the inverse demotion path.
- On demotion or revocation, write a tombstone row so the artifact is retracted from the wider blast radius across every consuming device or author.
- Define the `Team` tier boundary as the **workspace**, reusing existing org / workspace tenancy scoping.

## Non-Goals

- The registry schema, hashing, and identity model (PRD-033a).
- The publish/pull engine mechanics, the adapter seam, and last-writer-wins backup (PRD-033c).
- Org-wide ("everyone") propagation — a future fourth tier, not part of this lifecycle.

## User stories

- As a developer, I want to register a skill and choose how far it propagates so that a work-in-progress stays `Local` while a polished one reaches my `Team`.
- As a developer, I want to lower an artifact's tier and have it disappear from everyone it had reached so that revocation is real, not just a flag I set.
- As a team lead, I want `Team` to mean my workspace so that propagation respects existing tenancy boundaries.

## Functional requirements

- **FR-1 Register.** A CLI command registers an existing skill or agent into the substrate, recording it in `registry.json` at the `Local` tier by default with an explicit style. Registration assigns a `honeycomb_id` (PRD-033a) and does not by itself write to DeepLake.
- **FR-2 Set / raise / lower tier.** A CLI command sets an artifact's tier. The legal promotion path is `Local → Device → Team` and may jump rungs (e.g. `Local → Team`); demotion is the inverse (`Team → Device → Local`) and may also jump.
- **FR-3 Set style.** A CLI command sets an artifact's style (`Repository` XOR `User`). Style is orthogonal to tier; changing it changes the physical install location keying (project vs machine-global) recorded in the registry.
- **FR-4 Promotion publishes.** Raising the tier to `Device` or `Team` causes the artifact to be published into the synced-assets table (via PRD-033c) at the blast radius the new tier implies. Promotion to `Local` publishes nothing (`Local` is unmanaged).
- **FR-5 Demotion retracts via tombstone.** Lowering the tier (or an explicit revocation) writes a `tombstone` row for the artifact at the tiers it is leaving. Append-only versioning has no delete, so the tombstone is the retraction primitive; the next pull (PRD-033c) honors it and removes the local copy across the blast radius.
- **FR-6 Workspace-scoped Team.** The `Team` tier propagates to all authors in the same **workspace** (not org). Team publishes and selects are scoped by `org` + `workspace` using the existing tenancy scoping; a user in a different workspace never receives the artifact.
- **FR-7 Device-scoped Device tier.** The `Device` tier propagates only to the same user's other devices, keyed by author identity + the "my devices" set from PRD-033a; it never reaches a different user.
- **FR-8 Daemon-only writes.** All publishes and tombstone writes go through the daemon; the CLI never opens DeepLake directly.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given an unregistered skill or agent, when the user registers it, then it appears in `registry.json` at the `Local` tier with an explicit style and a `honeycomb_id`, and nothing is written to DeepLake. |
| AC-2 | Given a `Local` artifact, when the user promotes it to `Team`, then it is published at the workspace blast radius; given a `Team` artifact, when demoted to `Local`, then a tombstone is written. |
| AC-3 | Given an artifact promoted to `Device`, when a second device of the same user pulls, then the artifact appears there and does NOT appear for any other user. |
| AC-4 | Given an artifact promoted to `Team`, when another author in the same workspace pulls, then the artifact appears; a user in a different workspace never receives it. |
| AC-5 | Given a demotion, when the next pull runs on a device that had the artifact, then the local copy is retracted across the blast radius per the tombstone. |
| AC-6 | Given any tier or style change, when it is applied, then it goes through the daemon and the registry reflects exactly one tier × style cell afterward. |

## Implementation notes

- Demotion is strictly the inverse of promotion across the lattice; a jump demotion (`Team → Local`) writes tombstones for every wider tier the artifact is leaving so no consuming audience is missed.
- The `Team` boundary deliberately reuses the existing org / workspace tenancy scoping (the same scoping used by team skill sharing in PRD-018), rather than introducing a new boundary.
- "Team + Repository" is a deliberate, narrow cell: it earns its keep only when the user cannot or will not `git commit` the artifact into the repo (no write access, or no PR desired) — it is a shadow overlay decoupled from repo write access. This is its explicit justification; without that constraint, committing to the repo is the simpler path.

## Dependencies

- PRD-033a for the registry, the tier × style state machine, `honeycomb_id`, and the device set.
- PRD-033c for the publish and tombstone-honoring pull that promotion and demotion drive.
- The existing org / workspace tenancy scoping for the `Team` boundary.

## Open questions

- [ ] On demotion, is the correct retraction UX to delete the local file, or to leave it in place but mark it unmanaged?
- [ ] How does a user list and revoke a device, which directly affects the `Device`-tier audience?

## Related

- [parent index](./prd-033-asset-sync-substrate-index.md)
- [Team Skills Sharing](../../../knowledge/private/collaboration/team-skills-sharing.md)
- [PRD-018 Team Skill Sharing](../../in-work/prd-018-team-skill-sharing/prd-018-team-skill-sharing-index.md)
- [Org and Workspace Model](../../../knowledge/private/multi-tenant/org-workspace-model.md)
