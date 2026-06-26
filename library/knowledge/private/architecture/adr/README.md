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
