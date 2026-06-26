# PRD-055b: Primary Daemon Mint/Sign Authority

> **Parent:** [PRD-055](./prd-055-fleet-control-enrollment-and-mint-authority-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** L (1-3d)
> **Schema changes:** None (consumes `agent_identity`, writes `command` signatures)

---

## Goals

Stand up a single primary daemon that mints and Ed25519-signs every command and brokers credentials, so trust lives in the signature, not the transport, and a stolen dashboard session can never forge a command.

## Scope

- Ed25519 keypair management for the primary (generation, encrypted-at-rest custody, public-key distribution).
- A `sign(command)` path on the primary and a `verify(command)` path on every worker, pinning the primary's public key.
- The credential-broker role: the primary is the token-exchange endpoint PRD-055a calls.
- Audit logging of every mint (requester + payload).

## Out of scope

- The command table and polling (PRD-055c).
- Choosing where the primary physically runs (parent index open question).

---

## User stories and acceptance criteria

### US-055b.1 - Minting means signing

- AC-055b.1.1 Given the primary mints a command, when it is emitted, then it carries a valid Ed25519 signature over the canonical command bytes.
- AC-055b.1.2 Given a worker with the pinned public key, when it receives a command, then it executes only if the signature verifies; a tampered payload fails verification and is ignored (AC-3 at module level).

### US-055b.2 - Authority is singular

- AC-055b.2.1 Given the dashboard, when it wants a command, then it requests the primary to mint; it never holds the signing key and never writes a signed command itself (AC-5 at module level).
- AC-055b.2.2 Given a rogue/substituted primary, when a worker checks a command, then it fails because the public key does not match the pinned key.

### US-055b.3 - Key custody

- AC-055b.3.1 Given the signing key, when stored, then it is encrypted at rest (`creds_key` minimum, keychain/HSM preferred) and never present on a worker.
- AC-055b.3.2 Given any mint, when it occurs, then an audit record captures requester and signed payload.

---

## Technical considerations

- **Primitive:** `@noble/ed25519` (MIT), pure-ESM, no native binding. Sign over a canonical serialization (stable field order) so verification is deterministic across hosts.
- Key custody reuses the existing encrypted-vault / `creds_key` machinery (see [`security/credential-storage.md`](../../../knowledge/private/security/credential-storage.md)); the signing key is the most sensitive secret in the system.
- Workers pin the primary's public key at enrollment so a swapped primary fails closed.

## Evaluation and study of other codebases

- **Fold (MIT):** `@noble/ed25519` is the sign/verify implementation, chosen for tiny size, audited lineage, and zero native deps.
- **Build, do not fold:** Biscuit (Apache-2.0) is the conceptual model for signed, attenuable tokens but has no TS impl; we implement the minimal subset on noble. Concept borrowed, no code, no attribution.
- **Study (no fold):** agentfab's "signed, version-matched fabrics enforced at admission" and "node does not self-authorize" validate signature-at-the-boundary and worker-side verification.

## Files touched (anticipated)

- New: `src/daemon/runtime/fleet/mint-authority.ts` (sign), `command-verify.ts` (worker verify), key custody under the existing vault module. Tests under `tests/daemon/runtime/fleet/`.

## Test plan

- Unit: round-trip sign/verify (AC-055b.1.1); tampered payload fails (AC-055b.1.2); wrong key fails (AC-055b.2.2); key never serialized to a worker path (AC-055b.3.1); mint writes an audit row (AC-055b.3.2).

## Open questions

- [ ] Key rotation: how is a new primary public key redistributed to already-enrolled workers without a flag day?
