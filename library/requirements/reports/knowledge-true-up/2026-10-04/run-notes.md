# Swarm audit run notes

Task: Swarm the Honeycomb repository and library/knowledge/private, then true up those knowledge documents to the working tree.
Start time: 2026-10-04T05:22:55+00:00 (date -Is at scout).
Questions: None. Owner pre-authorized the full swarm.

## Opt-in and ceilings

Owner text includes SWARM and "Authorization approved yes do it." Ceilings: at most 100 in-flight agents, one workflow at min(16, CPUs - 2). This host has 24 CPUs, so the per-wave cap is 16. Check-in every 10 minutes. Stalls are stopped and respawned. Nothing unreviewed is dropped silently.

## Runtime substitution

This environment has no Workflow runtime tool. The fleet is implemented with Cursor Task subagents (generalPurpose), logged here. The script at swarm-audit-workflow.js was authored from the stinger template (withRetry, coverage ledger, checkpoints, critic loop, reconciliation) and was not executed as a Workflow. Sonnet 5 and Opus 5 are not in the available model list (inherit, composer-2.5-fast, grok-4.7-high-fast). The user did not name a model. Every role uses inherit, which is the parent model. Do not pretend a Workflow run id exists.

## Plan executed (full swarm)

Question: What is true of this repository now, where do library/knowledge/private documents disagree with the tree, and what true-up edits does that evidence support?

Lenses (16, one investigator each, wave 1 at the concurrency cap):

1. git-branches
2. knowledge-architecture
3. knowledge-ai-data
4. knowledge-surfaces
5. daemon-runtime
6. storage-catalog
7. retrieval
8. harnesses-mcp
9. cli-install
10. dashboard-code
11. security-code
12. deps-licenses
13. infra-ci
14. prd-lifecycle
15. auth-tenancy
16. embeddings-queue

Then: adversarial refuters on material findings (evidence and materiality), interpreters for branch inventory, state of the union, knowledge drift, and next steps, a completeness critic, and an editor. True-up of library/knowledge/private happens only after verified findings. Audit master files under library/requirements/reports/knowledge-true-up/.

Projection from measured medians (investigators 24 min, refuters 8 min, interpreters 12 min, critic 18 min) does not map 1:1 onto Task wall clock. Expected live agents: 16 investigators, then refuters bounded by the cap of 16 in flight, 4 interpreters, 1 critic, gap fills, 1 editor. Scratch: /tmp/honeycomb-swarm-audit-2026-10-04. Args: date 2026-10-04, repo the honeycomb path, scratch that directory, fleetCap 100, criticRounds 2, maxVerify null.

npm ci was not run. node_modules is absent. No second lens needs an install, so there is no install race. Live typecheck and vitest are UNVERIFIABLE-HERE until dependencies exist. terraform and go are absent.

## Smaller alternative recorded and not run

Four lenses only: one combined knowledge-drift pass, one daemon-and-constants pass, one harness-cli-dashboard pass, one git-and-PRD pass. One critic round. Verify high and critical findings only. Skip branch forensics beyond the scout table and skip license, cost, and access-hygiene lenses. The owner asked to swarm the entire repository, so this alternative was not launched.

## Drones

- swarm-audit-wasp-drone paired with swarm-audit-stinger. The orchestrator loaded the stinger and ran scout, observe, and assemble inline because the drone must not launch the fleet and this host has no Workflow tool.
- knowledge-wasp-drone paired with knowledge-stinger. Loaded for the true-up format (category header, related links, domain folders). Edits stay accuracy-scoped.
- library-wasp-drone paired with library-stinger. Loaded for path conventions. Reports go to library/requirements/reports/. library/notes is not edited.

## Ledger

Filled as products complete. A product is complete only with a producer and a reviewer.
