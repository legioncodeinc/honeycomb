# PRD-022e: Dogfood and Acceptance (recall through the HTTP API, proven live)

> **Parent:** [PRD-022](./prd-022-data-access-api-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

The behavioral proof that the data-access API works end-to-end, through the HTTP route and not around it, plus the receipts. This sub-PRD owns proving that a real captured turn is recalled THROUGH the `/api/memories/recall` HTTP path: `honeycomb recall "<term>"` (CLI to loopback daemon to `/api/memories/recall` to recall engine to live DeepLake) returns the captured turn, and the SDK `recall()` and the MCP `memory_search` tool return it too, on a real assembled daemon. It owns a gated live golden-path itest that drives recall via the HTTP route rather than direct SQL, and an operator smoke (`npm run smoke:data-api`, or an extension of the existing golden-path smoke). It does not own the handler bodies (022a, 022b, 022c) or the seam firing and client fixes (022d), which supply the surface this proves.

## Goals

- `honeycomb recall "<term>"` returning a previously-captured turn through `/api/memories/recall` on a real assembled daemon against live DeepLake.
- The SDK `recall()` returning the same captured turn through the same HTTP route.
- The MCP `memory_search` tool returning the same captured turn through the same HTTP route.
- A `remember` and store through `/api/memories` that lands a row which is then recallable through the HTTP route.
- A gated live golden-path itest that drives recall via the HTTP route, not direct SQL.
- An operator smoke (`npm run smoke:data-api`, or an extension of the existing golden-path smoke) that drives the data-access surface end-to-end.
- The receipt: `honeycomb recall` actually returning memories.

## Non-Goals

- The handler bodies, the seam firing, and the client fixes, which the other four sub-PRDs own and this consumes.
- Any new business logic or DeepLake schema. The proof exercises the wired engines end-to-end.
- Turning embeddings on. The proof accepts the BM25 and ILIKE lexical fallback; semantic recall is a separate follow-up.
- Hardening every harness or every data route. Recall through the HTTP API by the CLI, SDK, and MCP is the non-negotiable proof; the rest fast-follow.

## User stories

- As a developer, I want `honeycomb recall "<term>"` to return a turn I captured earlier so that recall through the real HTTP path is proven, not theoretical.
- As a developer using the SDK, I want `client.recall()` to return the same turn so that the SDK reaches the wired endpoint, not a 501.
- As an agent, I want the MCP `memory_search` tool to return the same turn so that the memory tool works against a real daemon.
- As a developer, I want a `remember` to land a row I can then recall through the HTTP route so that the write-then-read loop is proven over HTTP.
- As a maintainer, I want a gated live golden-path itest that drives recall through the route, not direct SQL, so that the test proves the HTTP path the users actually use.
- As an operator, I want a one-command data-API smoke so that anyone with credentials can prove the data surface end-to-end in one run.

## Functional requirements

- FR-1: `honeycomb recall "<term>"` returns a previously-captured turn through the full path CLI to loopback daemon to `/api/memories/recall` to the recall engine to live DeepLake, with no 501 and no 400.
- FR-2: The SDK `recall()` returns the same captured turn through the same `/api/memories/recall` HTTP route, stamping the session header.
- FR-3: The MCP `memory_search` tool returns the same captured turn through the same `/api/memories/recall` HTTP route, stamping the session header.
- FR-4: A `remember` and store through `/api/memories` lands a row that is then recallable through the HTTP route, proving the write-then-read loop over HTTP.
- FR-5: A gated live golden-path itest drives recall via the `/api/memories/recall` HTTP route, not direct SQL, so the test exercises the path the clients use.
- FR-6: An operator smoke (`npm run smoke:data-api`, or an extension of the existing golden-path smoke) drives setup, capture, a recall through the HTTP route, and a remember-then-recall in one pass.
- FR-7: Bugs discovered during the first real run of the data surface are routed through security then quality before close-out, consistent with the index first-real-run-finds-bugs decision.
- FR-8: The receipt is captured: `honeycomb recall` actually returning memories, with credentials and sensitive captured-trace content redacted.

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a previously-captured turn, when `honeycomb recall "<term>"` runs, then it returns that turn through the real `/api/memories/recall` HTTP path (no 501, no 400) against live DeepLake. |
| AC-2 | Given the same captured turn, when the SDK `recall()` runs, then it returns that turn through the same HTTP route with the session header stamped. |
| AC-3 | Given the same captured turn, when the MCP `memory_search` tool runs, then it returns that turn through the same HTTP route with the session header stamped. |
| AC-4 | Given a `remember` through `/api/memories`, when it lands a row, then a later recall through the HTTP route returns that row, proving the write-then-read loop over HTTP. |
| AC-5 | Given the gated live golden-path itest, when it runs with credentials, then it drives recall via the HTTP route (not direct SQL) and passes. |
| AC-6 | Given the data-API smoke, when an operator or CI with credentials runs it, then setup, capture, recall-through-HTTP, and remember-then-recall complete in one pass. |

## Implementation notes

- This sub-PRD is the acceptance gate for the whole PRD: AC-1 through AC-3 at the index level are proven here, end-to-end, through the HTTP route. The other four sub-PRDs are done when this one passes.
- The proof must drive recall THROUGH the HTTP route, not around it. The PRD-021 golden-path itest proved the recall engine via direct SQL, which is exactly the gap PRD-022 closes: the engine worked, the route did not. So the new itest must hit `/api/memories/recall`, or it proves nothing new.
- The lexical BM25 and ILIKE fallback is sufficient for the acceptance bar. Do not require the embed daemon for this proof; semantic recall is a separate follow-up.
- First-real-run-finds-bugs is the operating assumption: the PRD-021 dogfood found the workspace-partition bug, the 501 gap, and the session-header gap by running it. Running the data surface for real will find more. The gated live itest plus structured logging make those bugs reproducible, and the security-then-quality close-out is mandatory before this PRD ships. American spelling, direct prose, no em dashes.

## Dependencies

- PRD-022a `/api/memories/recall` and `/api/memories` handlers that this drives.
- PRD-022d fired seams, the session-header client fix, and the libuv exit fix that let the CLI, SDK, and MCP reach the route cleanly.
- PRD-021a assembled daemon serving against live DeepLake.
- PRD-021b CLI runtime and the loopback client the recall verb uses.
- PRD-021f golden-path smoke and live itest harness this extends to the data-access route.
- PRD-019d MCP tool surface and PRD-019e SDK whose `memory_search` and `recall()` this proves.

## Open questions

- [ ] Should the data-API smoke run in CI with stored credentials, or stay an operator-run script gated on real credentials (shared with the PRD-021f smoke question)?
- [ ] Does the acceptance require the embed daemon for semantic recall, or is the BM25 and ILIKE lexical fallback sufficient for the proof (shared with the index)?
- [ ] What is the minimum recall-hit signal that counts as a passing receipt for the data-access proof?

## Related

- [parent index](./prd-022-data-access-api-index.md)
- [Request Lifecycle](../../../knowledge/private/architecture/request-lifecycle.md)
- [Daemon Surface](../../../knowledge/private/architecture/daemon-surface.md)
- [DeepLake Storage](../../../knowledge/private/data/deeplake-storage.md)
- [MCP and SDK](../../../knowledge/private/integrations/mcp-and-sdk.md)
- [CLI Command Architecture](../../../knowledge/private/operations/cli-command-architecture.md)
