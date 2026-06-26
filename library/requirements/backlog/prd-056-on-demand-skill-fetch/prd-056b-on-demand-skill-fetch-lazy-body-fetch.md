# PRD-056b: Lazy Body Fetch

> **Parent:** [PRD-056](./prd-056-on-demand-skill-fetch-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** M (3-8h)
> **Schema changes:** None

---

## Goals

Fetch exactly one skill's body when it triggers (Level 2), so a short-lived agent pays the body cost only for skills it actually uses.

## Scope

- A `GET /api/skills/:author/:name/body` read endpoint returning the single highest-version `body` for one skill.
- The client trigger-to-fetch path: when a catalog skill matches the task, fetch its body and load it.
- Idempotent, poll-until-converged read so a flapped segment never returns a stale or partial body.

## Out of scope

- The catalog itself (PRD-056a) and the mode switch (PRD-056c).
- Writing fetched bodies into the eager symlink fan-out (lazy fetch loads into context, it does not re-create the eager on-disk layout).

---

## User stories and acceptance criteria

### US-056b.1 - One skill, on demand

- AC-056b.1.1 Given a triggered skill in lazy mode, when its body is fetched, then exactly that one body returns at its highest version, no other bodies.
- AC-056b.1.2 Given an untriggered skill, when the session ends, then its body was never fetched and cost zero body tokens.

### US-056b.2 - Correct and scoped

- AC-056b.2.1 Given a body fetch, when scope resolves, then it stays inside the caller's org partition, identical to the existing skills read.
- AC-056b.2.2 Given the backend flaps a stale segment, when the body is fetched, then the read polls until converged rather than trusting a single immediate read.

---

## Technical considerations

- Narrow the existing versioned read to a single `(name, author)` key returning `body` at max version.
- The fetch is fail-soft: a miss degrades to "skill body unavailable", never a crash.
- Optionally gate a fetched body through a security scan before use (see open question; mirrors skillshare's audit-on-install).

## Evaluation and study of other codebases

- **Prior art:** Agent Skills Level-2 (full `SKILL.md` body loaded only on trigger); MCP "inspect" step that fetches a full definition for one candidate tool only.
- **Pattern (MIT, Go):** skillshare's per-skill operations resolve one skill at a time; its security-audit-on-install is the model for an optional pre-load scan.
- **Study (AGPL):** honcho fetches deeper context per query rather than loading everything, the same on-demand economics.

## Files touched (anticipated)

- New: a single-skill body read endpoint; client trigger-to-fetch under `src/daemon-client/skillify/`. Tests for single-body projection, scope, and poll-until-converged.

## Test plan

- Route: single highest-version body (AC-056b.1.1); org-scoped (AC-056b.2.1); convergence polling on flaps (AC-056b.2.2).
- Integration: untriggered skill never fetched (AC-056b.1.2).

## Open questions

- [ ] Gate fetched bodies through a prompt-injection / exfiltration scan before loading (skillshare-style)?
