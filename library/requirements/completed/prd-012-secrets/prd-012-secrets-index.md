# PRD-012: Secrets

> **Status:** Completed
> **Priority:** P1
> **Effort:** M
> **Schema changes:** None

---

## Overview

If an agent can read `OPENAI_API_KEY`, a single prompt injection can exfiltrate it. The secrets subsystem breaks that link: secrets are encrypted at rest, agents can cause them to be used, and agents never receive the decrypted values. Secrets are the one class of data that does not live in DeepLake; they sit encrypted on the daemon host so that even a full dump of the store yields no credentials. The subsystem is owned by a bundled core plugin (`honeycomb.secrets`) so the capability is explicit, grantable, and audited. Values are stored as XSalsa20-Poly1305 ciphertext under `$HONEYCOMB_WORKSPACE/.secrets/` with a key derived from a machine-bound identifier, so copying the store to another box yields nothing usable. The API exposes names but never values; the only way to use a secret is `secret_exec`, which queues a subprocess with secrets in its environment and redacts any secret value from stdout and stderr before the caller sees it. The router's inference accounts reference secrets here rather than embedding raw keys.

## Goals

- Encrypt secrets at rest with machine-bound XSalsa20-Poly1305 and store them outside DeepLake under `.secrets/` at mode `0600`.
- Expose secret names but never values through any surface (API, SDK, MCP, dashboard, connector, diagnostics).
- Let an agent use a secret only through `secret_exec`, with redacted output and bounded subprocess execution.
- Integrate external secret managers (Bitwarden, 1Password) by reference rather than duplication.

## Non-Goals

- The device-flow credentials file (PRD-011); that is a separate store with separate rules.
- Making any secret recallable as memory; secrets must never enter chat, logs, memory rows, or source files.
- OS keychain and passphrase-protected backends (noted as planned, treated as not-yet-implemented).

## Sub-features

| Sub-PRD | Scope | Status |
|---|---|---|
| [`prd-012a-secrets-secrets-store`](./prd-012a-secrets-secrets-store.md) | Secrets plugin and machine-bound encrypted store. | Draft |
| [`prd-012b-secrets-secret-exec`](./prd-012b-secrets-secret-exec.md) | `secret_exec` with redacted output and provider integrations. | Draft |

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a stored secret, when the `.secrets/` store is copied to a different machine, then the value cannot be decrypted because the key is machine-bound. |
| AC-2 | Given any API, SDK, MCP, or dashboard surface, when an agent attempts to read a secret value, then only the name is available and no value-returning endpoint exists. |
| AC-3 | Given a `secret_exec` job whose command prints a secret, when output returns, then every secret value in stdout/stderr is replaced with `[REDACTED]`. |

## Data model changes

None. Secrets live encrypted on disk under `.secrets/`, deliberately outside DeepLake.

## API changes

Additive: `/api/secrets` (GET list names), `POST /api/secrets/:name`, `DELETE /api/secrets/:name`, `POST /api/secrets/exec`, `GET /api/secrets/exec/:jobId`, and provider routes under `/api/secrets/bitwarden/*` and `/api/secrets/1password/*`. No `GET /api/secrets/:name` by design.

## Open questions

- [ ] What is the fallback machine identifier on platforms lacking `/etc/machine-id` or `IOPlatformUUID` beyond hostname-plus-username?
- [ ] Should the `secret_exec` worker pool size and 30-minute max timeout be configurable per-workspace?
- [ ] How are external-manager references revalidated if the upstream vault item is rotated or deleted?

## Related

- [Secrets](../../../knowledge/private/security/secrets.md)
- [Credential Storage](../../../knowledge/private/security/credential-storage.md)
- [Scoping and Visibility](../../../knowledge/private/security/scoping-and-visibility.md)
- [Model and Provider Router](../../../knowledge/private/ai/model-provider-router.md)
