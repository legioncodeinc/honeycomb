# Security Policy

## Reporting a vulnerability

Do not open a public issue for a security problem. Public disclosure before a fix exists puts every user at risk.

Report it privately to **mario@legioncodeinc.com**. Include:

- What the vulnerability is and the impact you think it has
- Steps to reproduce, or a proof of concept
- Affected version, commit, or component (daemon, CLI, MCP server, a specific harness, embeddings)
- Any suggested fix if you have one

You'll get an acknowledgment within **3 business days**. We'll confirm the issue, work a fix, and keep you posted on progress.

## Disclosure

We follow coordinated disclosure. Once a fix is ready and released, we'll credit you for the report unless you'd rather stay anonymous. Please give us a reasonable window to ship the fix before you disclose publicly.

## Supported versions

Honeycomb is pre-release. Security fixes land on the latest `main` and the most recent release only. There is no back-porting to older versions until the project hits a stable line.

| Version        | Supported |
| -------------- | --------- |
| latest `main`  | yes       |
| older releases | no        |

## Scope

In scope: the daemon, the `honeycomb` CLI, the MCP server, the harness clients, the embeddings daemon, and the SDK in this repository.

Out of scope: vulnerabilities in third-party dependencies (report those upstream), and anything requiring a compromised host or physical access to the machine. The daemon binds loopback only by design, so report any path that exposes it beyond the local machine.
