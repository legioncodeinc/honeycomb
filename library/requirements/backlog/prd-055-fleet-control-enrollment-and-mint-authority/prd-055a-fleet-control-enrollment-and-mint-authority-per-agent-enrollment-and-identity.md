# PRD-055a: Per-Agent Enrollment and Identity

> **Parent:** [PRD-055](./prd-055-fleet-control-enrollment-and-mint-authority-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** L (1-3d)
> **Schema changes:** Additive (`agent_identity`, `enrollment_token`)

---

## Goals

Give every agent, including ephemeral sub-agents, its own attributable, revocable identity, and a frictionless non-interactive way to obtain it at spawn.

## Scope

- The `agent_identity` and `enrollment_token` records (parent index, Data model).
- Join-token issuance (short-lived, low-privilege, single-use or bounded `max_uses`).
- The token-to-per-agent-credential exchange (`POST /api/fleet/enroll`).
- The warm-host vouch path (`POST /api/fleet/vouch`): an enrolled daemon mints a child identity locally.
- TTL on per-agent identities and reaping coordinated with PRD-054a presence.

## Out of scope

- Signing commands (PRD-055b) and the command channel (PRD-055c).
- The presence store itself (PRD-054a).

---

## User stories and acceptance criteria

### US-055a.1 - Warm host: the daemon vouches for its children

- AC-055a.1.1 Given a sub-agent spawned under an enrolled daemon, when it starts, then the daemon vouches and a child `agent_identity` is created with `parent_agent_id` set, no human action, no per-agent token.
- AC-055a.1.2 Given a vouched child, when it heartbeats, then it appears in the fleet under its own `agent-instance-id`.

### US-055a.2 - Cold host: a join token bootstraps identity

- AC-055a.2.1 Given a fresh host with a valid join token, when the agent calls `POST /api/fleet/enroll`, then it receives its own per-agent credential and identity.
- AC-055a.2.2 Given a join token that has been consumed (or expired), when reused, then enrollment is rejected (single-use / expiry enforced, per the SPIRE "expire immediately after use" rule).

### US-055a.3 - Attributable and revocable

- AC-055a.3.1 Given an identity, when revoked, then that one agent loses access without affecting any other agent (no shared key).
- AC-055a.3.2 Given an ephemeral identity past its TTL, when reaped, then it is removed in step with presence reaping.

---

## Technical considerations

- Identity = device-id (the UUID per the PRD-033 ruling) + a minted `agent-instance-id`. Tenancy falls out of the existing `x-honeycomb-org` partition, so a presence/identity row is automatically scoped and attributable.
- Enrollment tokens are injected per harness by the existing six adapters (the protocol is harness-agnostic; only the injection point differs). See [`integrations/harness-integration.md`](../../../knowledge/private/integrations/harness-integration.md).
- The exchange must never hand a long-lived secret to a worker; per-agent credentials are short-lived and renewable.

## Evaluation and study of other codebases

- **Study (no fold):** SPIRE join tokens expire immediately after use (AC-055a.2.2) and its two-phase attestation maps onto warm-vouch (node) then per-agent (workload). Quint's `fleet:enroll`-scoped deploy token with revocation informs token scoping (AC-055a.3.1). honcho's shared-peer-ID-across-harnesses is the identity-unification model.
- **Pattern (MIT, Go):** clawmatrix's sidecar registers agents on boot and OpenClaw autodiscovers all its agents in one call, the warm-vouch path in practice.

## Files touched (anticipated)

- New: `src/daemon/runtime/fleet/identity.ts`, `enrollment.ts` (`/enroll`, `/vouch`), token store; harness-adapter injection points under `src/cli/install-*.ts`. Tests under `tests/daemon/runtime/fleet/`.

## Test plan

- Vouch creates a scoped child with parent set (AC-055a.1.1); token exchange issues a per-agent credential (AC-055a.2.1); consumed/expired token rejected (AC-055a.2.2); revoke isolates one agent (AC-055a.3.1).

## Open questions

- [ ] Credential format: a minimal noble-signed token now, or wait on PRD-055b's signing primitive and reuse it for credentials too? (Likely reuse.)
