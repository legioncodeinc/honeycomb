# PRD-012b: Secret Exec

> **Parent:** [PRD-012](./prd-012-secrets-index.md)
> **Status:** Draft
> **Priority:** P1
> **Effort:** M

## Scope

The `secret_exec` model that lets a secret be used without being revealed: an async job that resolves secret references from the PRD-012a store, spawns a bounded subprocess with secrets injected into its environment, enforces a timeout, bounds the worker pool, and redacts any secret value from output before the caller sees it. Plus external-manager (Bitwarden, 1Password) reference resolution so a workspace can reference items in an existing vault rather than duplicating them. The whole flow runs inside the honeycomb daemon on port 3850; the agent never receives the credential.

## Goals

- Let an agent cause a secret to be used (authenticate to an external service, run a credentialed command) without the credential ever passing through its context.
- Run exec asynchronously: queue a job, return immediately, let the caller poll for the result.
- Redact every occurrence of a secret value from stdout and stderr before returning, so output is safe even if a command echoes a credential.
- Pull from external secret managers by reference, so a workspace need not duplicate vault items into `.secrets/`.

## Non-Goals

- Storing, encrypting, or listing secrets (PRD-012a).
- Returning decrypted values to the agent under any circumstance; exec returns redacted output only.
- Implementing the external managers themselves; this resolves references against their existing APIs.

## User stories

- As an agent, I want to run a command that authenticates to an external service so that I get the result without the credential ever passing through my context.
- As an operator, I want exec jobs bounded by timeout and pool size so that a runaway credentialed command cannot exhaust the host.
- As a workspace owner, I want to reference a Bitwarden or 1Password item so that I do not duplicate vault secrets into the local store.

## Functional requirements

- FR-1: `POST /api/secrets/exec` MUST queue a job and return immediately with a 202 and a job id, rather than blocking on execution.
- FR-2: The daemon MUST resolve the job's secret references from `.secrets/` (PRD-012a) and inject the resolved values into the subprocess environment, never into the agent's context.
- FR-3: The daemon MUST spawn the subprocess with the secrets in its environment, enforce a timeout (5 minutes default, 30 minutes max), and bound the worker pool.
- FR-4: Before returning output, the daemon MUST replace every occurrence of any injected secret value in stdout and stderr with `[REDACTED]`.
- FR-5: `GET /api/secrets/exec/:jobId` MUST let the caller inspect a queued or completed exec job and retrieve its redacted output.
- FR-6: The subsystem MUST resolve external-manager references via `/api/secrets/bitwarden/*` and `/api/secrets/1password/*`, pulling items by reference rather than duplicating values into `.secrets/`.
- FR-7: Every exec operation MUST be audited (`secret.resolved_for_exec`, `secret.exec_started`, and so on) as NDJSON under `.daemon/` with sensitive fields redacted.
- FR-8: All exec jobs MUST be scoped to the requesting org/workspace and `agent_id`, so an agent cannot exec with another agent's secrets.
- FR-9: A timed-out or killed job MUST still return redacted partial output and a terminal status, never a raw credential.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a `secret_exec` request, when it is submitted, then it queues a job (202), spawns the subprocess with resolved secrets in env, and enforces the timeout (5 min default, 30 max). |
| AC-2 | Given a command that emits a secret value to stdout or stderr, when output returns, then every occurrence is replaced with `[REDACTED]` before the caller sees it. |
| AC-3 | Given a queued job id, when `GET /api/secrets/exec/:jobId` is called, then the caller sees job status and redacted output but never a raw secret. |
| AC-4 | Given a Bitwarden or 1Password reference, when an exec job resolves it, then the value is pulled from the vault by reference and not duplicated into `.secrets/`. |
| AC-5 | Given a job exceeding the timeout, when it is killed, then it returns a terminal status with redacted partial output and no raw credential. |
| AC-6 | Given concurrent exec requests beyond the pool size, when submitted, then excess jobs queue rather than overwhelming the host. |

## Implementation notes

- Worker pool is bounded; jobs inspectable via `GET /api/secrets/exec/:jobId`. Default pool size is an open question below.
- External managers resolve items by reference under `/api/secrets/bitwarden/*` and `/api/secrets/1password/*` rather than duplicating values.
- Redaction must run over the exact injected values, including any that appear partially or base64-encoded if the command transforms them; scope of redaction beyond literal match is an open question.
- The router's inference accounts use this same store by reference, so a config dump never contains a credential (see model-provider-router).

## Dependencies

- PRD-012a secrets store (reference resolution, audit log, scoping).
- Daemon HTTP server on port 3850 and worker-pool/job-queue infrastructure.
- Bitwarden and 1Password APIs for external-manager resolution.

## Open questions

- [ ] What is the default worker-pool size, and is it configurable per workspace?
- [ ] Should redaction cover transformed secret values (base64, URL-encoded) or only literal matches?

## Related

- [parent index](./prd-012-secrets-index.md)
- [Secrets](../../../knowledge/private/security/secrets.md)
- [Model and Provider Router](../../../knowledge/private/ai/model-provider-router.md)
