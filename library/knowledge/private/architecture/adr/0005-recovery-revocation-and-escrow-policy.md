# ADR-0005, Recovery, revocation, and escrow policy

> **SUPERSEDED (2026-07-03):** Relocated to Queen, the fleet orchestrator. Canonical copy: `queen/library/knowledge/private/architecture/ADR-0005-recovery-revocation-and-escrow-policy.md`. Retained here for history only; do not update.

> **Status:** Proposed (exploratory) | **Date:** 2026-06-29
> **Supersedes:** none | **Superseded by:** queen ADR-0005 (relocated)
> **Owners:** security, auth, support, cloud-control-plane | **Related:** ADR-0002, ADR-0003, ADR-0004

## Context

ADR-0002 and ADR-0003 establish the default custody model: Honeycomb cloud coordinates devices and
fleets, but it does not receive plaintext DeepLake credentials. Custodian devices and fleet
orchestrators hold the ability to decrypt or rewrap credential keys. This gives Honeycomb a strong
privacy story, but it creates recovery and revocation realities that must be documented before the
product is implemented.

The hard cases are:

- a user loses every custodian device;
- a laptop is stolen;
- an employee leaves a team;
- an OpenClaw/Hermes orchestrator is compromised;
- a VPS image accidentally includes enrollment material;
- a user wants convenience and expects cloud recovery;
- support is asked to "just unlock it."

The default answer cannot be improvised in support tickets. It is part of the architecture.

## Decision drivers

- **Default mode remains zero-knowledge for DeepLake credential sync.**
- **Recovery must be honest.** If Honeycomb cannot decrypt, Honeycomb cannot recover without user
  recovery material or a new DeepLake link.
- **Revocation must distinguish Honeycomb access from DeepLake access.**
- **Cloud escrow can exist only as explicit opt-in, not as a hidden default.**
- **Users need clear UI language for compromised devices and lost custodians.**

## Considered options

### Option A, Re-link only on total custodian loss (CHOSEN default)

If all custodians are lost, the user links DeepLake again from a new device. Honeycomb does not
recover the old encrypted blob.

This is the cleanest zero-knowledge default. It is less convenient, but easy to explain and does not
create hidden cloud custody.

### Option B, Recovery key or passphrase recovery

During setup, the user stores a recovery key or creates a passphrase that can unwrap a recovery copy
of the credential data key.

This preserves the "Honeycomb cannot decrypt alone" promise if implemented correctly, but it adds
UX, support, and forgotten-passphrase complexity. It is a good fast-follow after the basic device
model is proven.

### Option C, Team admin recovery

For organizations, a policy may require multiple admin custodian devices so one admin can approve or
recover another admin's device.

This is appropriate for teams, but it is not a substitute for personal recovery. It also requires
clear role policy and audit.

### Option D, Honeycomb escrow

Honeycomb stores a backend-readable credential or backend-readable unwrap path so it can provision
new devices immediately.

This is the best convenience mode and the biggest trust shift. It may be offered later as explicit
escrow, especially for businesses that prefer managed recovery, but it is not the default.

## Decision

Adopt **Option A** as the default recovery policy: if all custodian devices and fleet custodians are
lost, the user must re-link DeepLake.

Allow **Option B** and **Option C** as future recovery upgrades. Allow **Option D** only as explicit
opt-in escrow with product copy that says Honeycomb can recover/provision DeepLake access in that
mode.

Revocation must be explicit about its limits. Removing a device from Honeycomb prevents future
control-plane access, future wrapped-key downloads, future rewrap approvals, and future enrollment
privileges. It does not necessarily invalidate a DeepLake credential already present on that device.
For full containment after compromise, the user must rotate/revoke DeepLake credentials too.

## Revocation classes

| Event | Honeycomb action | DeepLake action | User-facing message |
|---|---|---|---|
| User removes old laptop | Revoke device and stop serving wrapped keys | Usually none | Device removed from Honeycomb. |
| Laptop stolen | Revoke device, invalidate sessions, block rewrap authority | Rotate DeepLake credential | Rotate DeepLake to fully cut off memory access. |
| Employee leaves org | Remove membership, revoke devices/agents tied to user | Rotate if credential was shared locally | Access removed; rotate shared credentials if needed. |
| Orchestrator compromised | Revoke fleet custodian, block worker grants | Rotate DeepLake credential | Fleet memory access is unsafe until re-linked. |
| Enrollment token leaked | Revoke token; reject future exchanges | None if token had no memory access | Token cannot read memory; revoke and regenerate. |
| Deploy token leaked | Revoke token; inspect registrations during token window | Usually none | Review devices created during exposure window. |

## Credential rotation

Credential rotation is the containment step when a compromised device may already hold plaintext
DeepLake access locally. Honeycomb should guide the user through:

1. revoke the compromised Honeycomb device or fleet custodian;
2. rotate/re-link DeepLake so old tokens are invalid;
3. have remaining custodians encrypt and upload a fresh credential blob;
4. rewrap the fresh credential data key for approved devices and fleets;
5. mark all stale wrapped keys as superseded.

If no healthy custodian remains, rotation becomes a new DeepLake link from the new trusted device.

## Escrow policy

Default product copy:

```text
Honeycomb cannot decrypt your DeepLake credential by default. If every trusted device is lost, link
DeepLake again from a new device.
```

Future escrow mode copy must be equally explicit:

```text
Managed recovery lets Honeycomb recover and provision DeepLake access for your devices. Enable this
only if you want Honeycomb to act as a credential custodian for convenience and support recovery.
```

Escrow mode must be separately auditable and visible in the cloud console. Users should be able to
turn it off. The off-switch must not only prevent future escrow-backed blobs; it must also retire
any existing backend-readable recovery material. Prior escrow-backed blobs must be purged, rewrapped
into zero-knowledge custody, or otherwise rendered unreadable through the backend-read path before
the UI can claim escrow is disabled.

## Consequences

**Positive**

- The default trust promise stays simple: Honeycomb cannot decrypt DeepLake credentials.
- Support cannot accidentally promise recovery that the architecture cannot provide.
- Device revocation and DeepLake rotation are separated honestly.
- Future escrow can be built deliberately instead of creeping into the default path.

**Negative / accepted**

- Some users will have to re-link DeepLake after losing all custodians.
- Compromise containment is a two-step story: revoke in Honeycomb and rotate in DeepLake.
- Recovery-key/passphrase UX remains future work and must be designed carefully.
- Managed escrow customers will have a different trust posture from default users.

## Required invariants

- Default recovery cannot depend on Honeycomb secretly being able to decrypt.
- Revocation events are audit logged with actor, target, reason, and timestamp.
- Revoked devices cannot approve rewraps or receive new wrapped keys.
- The UI must not imply that Honeycomb revocation alone invalidates already-local DeepLake tokens.
- Escrow mode must be explicit, visible, reversible, and separately audited.

## Revisit triggers

Re-open this decision if any of these become true:

1. DeepLake exposes scoped per-device tokens with remote revocation, reducing the local-credential
   rotation gap.
2. Support volume from lost custodians becomes high enough to prioritize recovery keys.
3. Business customers require Honeycomb-managed recovery as a standard plan feature.
4. A security review rejects local-only custody for a target enterprise segment.

## Links

- ADR-0002: `library/knowledge/private/architecture/adr/0002-orchestrator-custodian-for-fleet-memory-plane.md`
- ADR-0003: `library/knowledge/private/architecture/adr/0003-trusted-device-custody-and-headless-enrollment.md`
- ADR-0004: `library/knowledge/private/architecture/adr/0004-honeycomb-control-plane-and-postgres-boundary.md`
- Credential storage: `library/knowledge/private/security/credential-storage.md`
- Secrets: `library/knowledge/private/security/secrets.md`
- Trust boundaries: `library/knowledge/private/security/trust-boundaries.md`
