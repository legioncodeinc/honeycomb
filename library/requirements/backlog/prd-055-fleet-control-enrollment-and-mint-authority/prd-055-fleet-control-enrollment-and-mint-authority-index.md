# PRD-055: Fleet Control, Enrollment, Identity and Mint/Sign Authority

> **Status:** Backlog
> **Priority:** P2
> **Effort:** XL (> 3d)
> **Schema changes:** Additive (per-agent identity records; no Deep Lake change)

---

## Overview

PRD-054 lets us *see* the fleet. This PRD lets us *steer* it, safely. It adds per-agent identity (so individual sub-agents, not just orchestrators, are addressable), a join-token enrollment flow (so a freshly spawned agent phones home without a human opening a dashboard), a **primary daemon as the single mint/sign authority** (so commands are signed and trust does not live in the transport), and an idempotent, signed command channel.

The ordering is deliberate: this is phase two, built only once the read-only fleet view from PRD-054 exists and the pain of not having control is real. Commanding an autonomous agent is the most sensitive surface in the system, so the design concentrates authority in one auditable place and keeps workers autonomous when it is unreachable.

Source of truth: [`fleet-observation-and-on-demand-skills.md`](../../../knowledge/private/collaboration/fleet-observation-and-on-demand-skills.md).

---

## Goals

- Every agent, including ephemeral sub-agents, gets its own attributable, revocable identity: `(org, host device-id, agent-instance-id)`.
- A short-lived, low-privilege **join token** bootstraps a per-agent credential; no shared forever-key, no interactive login per spawn.
- Two enrollment paths: a warm host where the already-enrolled daemon vouches for its children, and a cold host where a join token is the non-interactive first-contact credential.
- A **primary daemon** mints and Ed25519-signs commands and brokers credentials; workers verify against a pinned public key.
- Commands flow by idempotent poll with applied/acked markers, surviving the eventually-consistent transport.
- The primary is required to *issue* commands, never to *run* workers: if it is down, workers keep working and heartbeating.

## Non-Goals

- The observe-half presence/dashboard (PRD-054, a dependency).
- A real-time push command channel (Tailscale-style reach-in). Explicitly deferred unless sub-second control is proven necessary.
- Skill distribution changes (PRD-056).

---

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-055a-per-agent-enrollment-and-identity`](./prd-055a-fleet-control-enrollment-and-mint-authority-per-agent-enrollment-and-identity.md) | Per-agent identity, join-token issue + exchange, warm-vouch + cold-token paths, TTL | Draft |
| [`prd-055b-mint-sign-authority`](./prd-055b-fleet-control-enrollment-and-mint-authority-mint-sign-authority.md) | Primary daemon as Ed25519 mint/sign authority + worker verify + key custody | Draft |
| [`prd-055c-signed-command-channel`](./prd-055c-fleet-control-enrollment-and-mint-authority-signed-command-channel.md) | Idempotent polled command table, signed + acked, autonomous-on-primary-down | Draft |

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a sub-agent spawned on an enrolled host, when it starts, then the host daemon vouches for it and it appears in the fleet with its own `agent-instance-id`, without any human action. |
| AC-2 | Given a fresh VM with a join token, when the agent boots, then it exchanges the token for its own per-agent credential and the token cannot be reused after expiry. |
| AC-3 | Given a command minted and signed by the primary, when a worker receives it, then it executes only after verifying the signature against the pinned public key; a tampered or unsigned row is ignored. |
| AC-4 | Given the primary daemon is down, when a worker runs, then it continues its local work and heartbeats and merely cannot receive new commands (degrade to autonomous, not dead). |
| AC-5 | Given a stolen read-only dashboard session, when it attempts to command an agent, then it can request but never forge a signed command (mint authority is the primary's alone). |

---

## Data model changes

Additive, in the control-plane store (not Deep Lake):

- `agent_identity`: `(org, agent_id)` with `device_id`, `parent_agent_id`, `public_key`, `issued_at`, `expires_at` (TTL), `revoked_at` nullable.
- `enrollment_token`: `(org, token_id)` with `scope`, `issued_by`, `expires_at`, `consumed_at` (single-use), `max_uses`.
- `command`: `(org, command_id)` append-only, with `target_agent_id`, `verb`, `payload`, `signature`, `nonce`, `applied_at`, `acked_at`. Primary is the only writer; workers write only acks.

## API changes

- `POST /api/fleet/enroll` (join-token first contact): exchange a token for a per-agent credential.
- `POST /api/fleet/vouch` (warm-host path): an enrolled daemon registers a child identity.
- `POST /api/fleet/commands` (primary-only mint): request returns a signed command row; the dashboard calls this, it never writes commands directly.
- `GET /api/fleet/commands?agent=` + `POST /api/fleet/commands/:id/ack` (worker poll + ack).

---

## Evaluation and study of other codebases

Fold rule: **MIT code only**; Apache-2.0 and AGPL are study-only. Verified June 2026.

**Fold (MIT):**
- [`@noble/ed25519`](https://github.com/paulmillr/noble-ed25519) (MIT, TypeScript, ~4KB, zero deps, cure53-audited lineage) is the entire sign/verify primitive for the mint authority and worker verification (PRD-055b). Pure ESM, no native binding, which fits the strict-ESM Node 22 stack and avoids the native-dep healing pain seen with tree-sitter.

**Build, do not fold:**
- [`eclipse-biscuit/biscuit`](https://github.com/eclipse-biscuit/biscuit) (Apache-2.0, Rust, no first-class TS) is the ideal token *model*: offline attenuation, public-key verification from a root key, an Ed25519 signature chain, read-vs-command as different checks. We borrow the attenuation concept (a design idea, no attribution owed) and implement minimal attenuable signed tokens on noble, keeping the whole path MIT and full-TS.

**Study only (ideas inform, code is never vendored):**
- SPIFFE/SPIRE (Apache-2.0): two ideas worth stealing, join tokens that **expire immediately after use** (AC-2) and the two-phase node-then-workload attestation framing (maps onto host-daemon-vouches-for-child, AC-1). The full server-plus-per-node-agent stack is too heavy for BYOC anywhere-install, so concept only.
- [`plastic-labs/honcho`](https://github.com/plastic-labs/honcho) (AGPL-3.0): its **shared stable peer ID that unifies memory across `claude_code`/`cursor`/`opencode`/`hermes`** is precisely our cross-harness identity model. The peer paradigm (users and agents are both peers) validates treating every agent as a first-class addressable identity. AGPL means study the model, never the code.
- clawmatrix (MIT, Go) and Quint (Apache-2.0): clawmatrix's sidecar-registers-on-boot plus OpenClaw autodiscovery, and Quint's `fleet:enroll`-scoped deploy token with revocation, are the enrollment flow in the wild. clawmatrix is MIT but Go, so pattern-only.

**Our own code reused:** the protected-group mount + `resolveScopeOrLocalDefault` tenancy ([`propagation-api.ts`](../../../../src/daemon/runtime/skillify/propagation-api.ts)); the UUID device-id identity primitive (PRD-033 ruling) and credential persistence ([`auth/auth-architecture.md`](../../../knowledge/private/auth/auth-architecture.md), [`security/credential-storage.md`](../../../knowledge/private/security/credential-storage.md)).

---

## Open questions

- [ ] **Where the primary lives:** hosted under theapiary.sh (clean ops, but every fleet depends on our box and key) or a designated user daemon (pure BYOC, key in the user's trust domain). This decides the entire key-custody story and is the lead decision. (Lean: designated user daemon, hosted tier later.)
- [ ] Warm-vouch trust depth: does a vouched child get a full credential or a constrained delegation that cannot itself vouch?
- [ ] Command verbs for v1: which actions are allowlisted (pause, force-pull) and which are explicitly forbidden?

---

## Related

- [`prd-054`](../prd-054-fleet-observation-control-plane/prd-054-fleet-observation-control-plane-index.md) - the presence/dashboard this builds on (dependency).
- [`prd-056`](../prd-056-on-demand-skill-fetch/prd-056-on-demand-skill-fetch-index.md) - on-demand skills (independent).
- [`security/trust-boundaries.md`](../../../knowledge/private/security/trust-boundaries.md), [`auth/auth-architecture.md`](../../../knowledge/private/auth/auth-architecture.md), [`multi-tenant/org-workspace-model.md`](../../../knowledge/private/multi-tenant/org-workspace-model.md).
