# PRD-055c: Signed Command Channel

> **Parent:** [PRD-055](./prd-055-fleet-control-enrollment-and-mint-authority-index.md)
> **Status:** Draft
> **Priority:** P3
> **Effort:** L (1-3d)
> **Schema changes:** Additive (`command` table in the control-plane store)

---

## Goals

Deliver signed commands from the primary to workers over an idempotent polled channel that survives an eventually-consistent transport and keeps workers fully autonomous when the primary is unreachable.

## Scope

- The append-only `command` table (primary is the only writer; workers write only acks).
- A worker poll loop (`GET /api/fleet/commands?agent=`) that verifies, dedupes by nonce, applies idempotently, and acks (`POST /api/fleet/commands/:id/ack`).
- The dashboard request path that asks the primary to mint, never writing commands directly.
- An allowlist of command verbs; unknown verbs are refused.

## Out of scope

- Signing/minting itself (PRD-055b).
- Any low-latency push channel (explicitly deferred; poll-only until proven insufficient).

---

## User stories and acceptance criteria

### US-055c.1 - Idempotent, transport-tolerant delivery

- AC-055c.1.1 Given a command row duplicated or re-read by the flapping store, when a worker processes it, then the nonce/applied-marker makes the second application a no-op.
- AC-055c.1.2 Given a verb not on the allowlist, when a worker reads it, then it is refused and acked as rejected.

### US-055c.2 - Autonomous when the primary is down

- AC-055c.2.1 Given the primary is unreachable, when a worker runs, then it continues local work and heartbeats; it simply receives no new commands (module AC-4).
- AC-055c.2.2 Given the primary returns, when the worker next polls, then pending signed commands are delivered and applied in order.

### US-055c.3 - The dashboard cannot forge

- AC-055c.3.1 Given the dashboard, when it issues an action, then it calls the mint endpoint and the resulting row is primary-signed; a row written by anyone but the primary fails worker verification.

---

## Technical considerations

- Poll cadence rides the heartbeat tick to avoid a second timer. Commands are read-verify-apply-ack; every step is fail-soft.
- Apply must be idempotent because the store flaps stale segments (the same eventual-consistency discipline used for every live read-back: poll until converged, never trust a single read).
- The command channel is strictly additive to the control plane; if it is absent or unreachable, the rest of the fleet system is unaffected.

## Evaluation and study of other codebases

- **Study (no fold):** Quint returns policy updates on the heartbeat response, the benign pull-based control channel this mirrors. agentfab's per-task leases and stale-heartbeat-releases-lease give the "recover without duplicate execution" pattern behind AC-055c.1.1 and AC-055c.2.
- **Concept:** Biscuit's verify-from-public-key means the table is a dumb pipe; trust is in the signature (built in PRD-055b), not the channel.

## Files touched (anticipated)

- New: `src/daemon/runtime/fleet/command-channel.ts` (poll + ack), command store, verb allowlist; the mint request endpoint wiring. Tests under `tests/daemon/runtime/fleet/`.

## Test plan

- Unit: duplicate row applied once (AC-055c.1.1); disallowed verb refused (AC-055c.1.2); primary-down keeps worker alive (AC-055c.2.1); recovery delivers in order (AC-055c.2.2); non-primary row fails verify (AC-055c.3.1).

## Open questions

- [ ] Command TTL and garbage collection so the `command` table does not accumulate (same bounding concern as presence).
- [ ] Per-verb authorization: is "command an agent" one scope, or per-verb scopes (pause vs inject differ in blast radius)?
