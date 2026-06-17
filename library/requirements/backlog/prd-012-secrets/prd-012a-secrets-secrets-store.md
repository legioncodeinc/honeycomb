# PRD-012a: Secrets Store

> **Parent:** [PRD-012](./prd-012-secrets-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Scope

The `honeycomb.secrets` core plugin and the machine-bound encrypted store under `.secrets/`: XSalsa20-Poly1305 ciphertext with a key derived from a machine identifier, names listable but values never returned, every operation audited. This is the one class of data that does not live in DeepLake; it sits encrypted on the daemon host so a full dump of the store yields no credentials. This sub-PRD owns storage, encryption, the list/store/delete API surface, and the audit log. The exec model that uses secrets without revealing them is PRD-012b.

## Goals

- Break the link between an agent and a raw credential: secrets are encrypted at rest and agents can cause them to be used but never receive the decrypted values.
- Bind encryption to the host machine so a stolen copy of `.secrets/` is useless on another box.
- Make secret access an explicit, grantable plugin capability with every operation audited.
- Expose names so an agent can reference a secret, while guaranteeing no value-returning endpoint exists.

## Non-Goals

- The `secret_exec` model and external-manager resolution (PRD-012b).
- The daemon's own device-flow credentials file, which is a separate store with separate rules (credential-storage doc).
- Storing secrets in DeepLake; secrets deliberately never enter the store.
- OS keychain and passphrase-protected backends, noted as planned and treated as not-yet-implemented.

## User stories

- As a security-conscious operator, I want secrets encrypted with a machine-bound key so that a stolen copy of `.secrets/` is useless on another host.
- As an agent, I want to list secret names so that I can reference a secret without ever reading its value.
- As an auditor, I want every secret operation logged so that I can trace who stored, listed, or used a secret.

## Functional requirements

- FR-1: Secrets MUST be owned by the bundled core plugin `honeycomb.secrets` under `plugins/core/secrets`, so the capability is explicit and can be granted or denied.
- FR-2: Secrets MUST be stored in `$HONEYCOMB_WORKSPACE/.secrets/` as encrypted JSON at mode `0600`, with human-readable names and ciphertext values, and MUST NOT be written to DeepLake.
- FR-3: Encryption MUST be XSalsa20-Poly1305 via libsodium `crypto_secretbox_easy`, with a random nonce prepended to each value's ciphertext.
- FR-4: The encryption key MUST be derived by hashing a machine-bound identifier (`/etc/machine-id` on Linux, `IOPlatformUUID` on macOS, hostname-plus-username fallback) stretched to 32 bytes.
- FR-5: The API MUST expose `GET /api/secrets` (list names only), `POST /api/secrets/:name` (store), and `DELETE /api/secrets/:name` (delete).
- FR-6: There MUST be no `GET /api/secrets/:name` or any other endpoint, SDK call, MCP tool, dashboard view, connector, or plugin diagnostic that returns a decrypted value.
- FR-7: Every operation MUST be audited as structured NDJSON under `.daemon/` with events including `secret.listed`, `secret.stored`, and `secret.resolved_for_exec`, with sensitive fields redacted before storage.
- FR-8: All operations MUST be scoped to the org/workspace and `agent_id`, so one agent cannot list or delete another agent's secrets.
- FR-9: Copying `.secrets/` to a different machine MUST yield unusable ciphertext, because the derived key depends on the host machine identity.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a stored secret, when written, then it lands as `crypto_secretbox_easy` ciphertext with a random nonce in `$HONEYCOMB_WORKSPACE/.secrets/` at mode `0600`. |
| AC-2 | Given the API, when an agent lists secrets, then it receives names only and there is no value-returning endpoint. |
| AC-3 | Given a `.secrets/` directory copied to another host, when the daemon there tries to decrypt, then decryption fails because the machine-bound key differs. |
| AC-4 | Given any secret operation, when it completes, then an NDJSON audit event is appended under `.daemon/` with sensitive fields redacted. |
| AC-5 | Given an attempt to read a secret value through SDK, MCP, dashboard, or plugin diagnostics, when made, then no decrypted value is ever returned. |
| AC-6 | Given two agents under one workspace, when one lists secrets, then it sees only secrets in its own scope. |

## Implementation notes

- Key derived by hashing a machine-bound identifier (`/etc/machine-id`, `IOPlatformUUID`, hostname-plus-username fallback) stretched to 32 bytes.
- Routing access through the plugin makes the capability grantable and every op auditable (`secret.listed`, `secret.stored`, ...). Audit NDJSON lives under `.daemon/`.
- Secrets are the one class of data that does not live in DeepLake; they sit encrypted on the daemon host, separate from the daemon's own device-flow credentials file.

## Dependencies

- libsodium for `crypto_secretbox_easy`.
- Workspace layout (`$HONEYCOMB_WORKSPACE/.secrets/`, `.daemon/` audit log).
- Plugin capability/grant system for `honeycomb.secrets`.
- Consumed by PRD-012b exec and PRD-010 router account resolution.

## Open questions

- [ ] How does the hostname-plus-username fallback behave under containerization where `/etc/machine-id` may be ephemeral?
- [ ] How are secrets rotated or re-keyed when a machine identifier legitimately changes (hardware migration)?

## Related

- [parent index](./prd-012-secrets-index.md)
- [Secrets](../../../knowledge/private/security/secrets.md)
