# Architecture Decision Records (ADRs)

Standing records of significant, hard-to-reverse architecture decisions, the *why* behind a choice,
captured once so it doesn't have to be re-litigated from memory.

## Convention

- One file per decision: `NNNN-kebab-title.md` (4-digit zero-padded, sequential). Take `max+1`.
- Format: Nygard-style **Context → Decision → Consequences**, plus a `Status` line and explicit
  **Revisit triggers** where a decision is conditional on future evidence.
- `Status`: `Proposed` → `Accepted` → `Superseded by ADR-XXXX` (never edit a superseded ADR's
  substance; write a new one that supersedes it).
- ADRs record the decision; the supporting measurements/PRDs live in `library/requirements/` and the
  detailed knowledge docs alongside this folder, link them, don't duplicate them.

## Index

| ADR | Title | Status | Date |
|---|---|---|---|
| [0001](0001-retrieval-fusion-rrf-vs-native-hybrid.md) | Retrieval fusion: keep post-query RRF over native `deeplake_hybrid_record` | Accepted | 2026-06-24 |
| [0002](0002-orchestrator-custodian-for-fleet-memory-plane.md) | Orchestrator-custodian for fleet memory-plane enrollment | Superseded by queen ADR-0002 (relocated 2026-07-03) | 2026-06-29 |
| [0003](0003-trusted-device-custody-and-headless-enrollment.md) | Trusted device custody and headless enrollment | Superseded by queen ADR-0003 (relocated 2026-07-03) | 2026-06-29 |
| [0004](0004-honeycomb-control-plane-and-postgres-boundary.md) | Honeycomb control plane and Postgres boundary | Superseded by queen ADR-0004 (relocated 2026-07-03); queen runtime topology later superseded by queen ADR-0010 | 2026-06-29 |
| [0005](0005-recovery-revocation-and-escrow-policy.md) | Recovery, revocation, and escrow policy | Superseded by queen ADR-0005 (relocated 2026-07-03) | 2026-06-29 |
| [0006](0006-local-queue-as-interim-idle-cost-control.md) | Local queue as interim idle-cost control | Accepted (evolved by ADR-0009) | 2026-06-29 |
| [0007](0007-daemon-readiness-over-boot-time-deeplake-and-graph-work.md) | Daemon readiness over boot-time DeepLake and graph work | Accepted | 2026-06-30 |
| [0008](0008-fleet-directory-ownership-and-neutral-state-root.md) | Fleet directory ownership and neutral state root (mirror of superproject ADR-0003) | Accepted | 2026-07-04 |
| [0009](0009-local-queue-as-default-deeplake-is-not-a-queue.md) | Local queue as the default; DeepLake is a store, not a job-coordination primitive | Accepted | 2026-07-05 |
| [0010](0010-recall-weighted-est-savings.md) | Recall-weighted "Est. savings"; the corpus-length proxy is retired | Proposed | 2026-07-08 |
| [0011](0011-sessions-recall-chunking-strategy.md) | Sessions recall chunking: build in-tree, do not pull a chunker dependency | Proposed | 2026-07-05 |
| [0012](0012-mcp-stdio-child-and-daemon-scaffold.md) | MCP is a spawned stdio child; the daemon `/mcp` group stays a scaffold | Accepted | 2026-10-04 |
