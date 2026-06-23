# Inference module — CONVENTIONS (PRD-010)

The model-provider router lives under `src/daemon/runtime/inference/` (daemon-only;
the DeepLake path through the history store lives only in the daemon bundle — the
`invariant.test.ts` enforces it). Wave 1 built the shared contracts + the four
seams, 010a (the config contract, FULLY), the router HARNESS, the real routing
history store, and pre-wired the 010b/010c/010d stubs. Wave 2's three Bees each
fill ONE module + its test file, contention-free.

**Read this file before filling a stub.** It is the contract Wave 2 follows.

## The central thesis: the secret is never persisted, logged, or dumped

This is the one invariant the whole PRD is built around (D-2 / D-7, the security
audit's first target):

- An `Account` holds `apiKeyRef` — a `${SECRET_REF}` reference STRING. There is
  **no raw-key field anywhere** in the contracts by construction. An inline raw key
  is **rejected at parse** (a-AC-4); a config dump shows only the reference (a-AC-2).
- The resolved secret VALUE exists only inside `executeWithFallback`'s local scope
  for the duration of one provider call (resolved through the `SecretResolver`
  seam). It never enters a `Target`, a `RoutingDecision`, or a telemetry row.
- Telemetry is **redacted by construction**: `RoutingHistoryStore.record` accepts
  ONLY a `RedactedRoutingEvent`, a shape that cannot hold a secret/key/body. The
  `routing_history.event` JSONB therefore carries only target ids, gate reasons,
  status codes, the decision mode — never a prompt, a completion, or a key. This is
  enforced at the WRITE boundary, not a read-time scrub (c-AC-6 / d-AC-5).

If you find yourself wanting to add a field that could hold key/prompt/completion
text to any contract here, STOP — that is a Wave-1 design change, and almost
certainly the wrong one.

## Shared files — DO NOT TOUCH (Wave-1 surface)

| File | What it owns |
|---|---|
| `contracts.ts` | `PrivacyTier` (+ `tierRank`/`tierSatisfies`), `Capability`, `Account`/`Target`/`Policy`/`Workload`/`InferenceConfig`, `RoutingDecision`/`AttemptRecord`, the OpenAI-shaped `InferenceRequest`/`InferenceResponse`, the `SecretResolver`/`ProviderTransport`/`InferenceRouter`/`RoutingHistoryStore` seams (+ fakes), `RedactedRoutingEvent` + `toRedactedEvent`, `notImplemented`. A genuinely new cross-module field is a Wave-1 change (raise it), not a stub edit. |
| `config.ts` | 010a — FILLED. `parseInferenceConfig` (zod + cross-ref + secret-ref reject), `dumpInferenceConfig` (redacted), `loadInferenceConfigFromYaml` (thin). |
| `history-store.ts` | The real `RoutingHistoryStore` (`record` append-only redacted, `recent` scoped read). `routingEventId` (deterministic). |
| `router.ts` | The router HARNESS + `RouterModelClient` (the D-9 bridge). 010b fills the gate/mode/fallback BODIES inside it (see below). |

A Wave-2 Bee ADDS its own logic to its stub module + its own test; it does NOT edit
any shared file (except 010b, which fills the marked stubs INSIDE `router.ts` — see
the explicit carve-out below).

## The pinned decisions Wave 2 inherits

### PrivacyTier ordering (`PRIVACY_TIERS`, lowest → highest)

`["public", "private", "restricted"]`. Index = strictness rank. The privacy gate
(b-AC-1) admits a target only when `tierSatisfies(target.privacyTier, workload.minPrivacyTier)`
— i.e. `tierRank(target) >= tierRank(floor)`. A target MORE private than the
workload requires passes; a LESS private one is blocked. Use `tierSatisfies` /
`tierRank`; never compare the strings directly.

### Capability vocabulary (`CAPABILITIES`, closed)

`["chat", "streaming", "vision", "tools"]`. A target advertises its set; a workload
declares the required set; the capability gate (b-AC-1) admits a target only when
its set is a SUPERSET of the workload's required set. Closed so a typo in
`agent.yaml` is a parse error. A NEW capability is an additive Wave-1 change to the
frozen array (append only — never reorder/remove).

### Policy modes (`POLICY_MODES`)

`["strict", "automatic", "hybrid"]`. `strict` = explicit `chain` order; `automatic`
= score all surviving candidates; `hybrid` = score within `allowlist` (D-5).

### The `InferenceRouter` shape (010c builds the gateway against it)

- `explain(request): Promise<RoutingDecision>` — resolve the decision, NO execution.
- `execute(request): Promise<{ decision, output }>` — route + run non-streamed.
- `stream(request): Promise<{ decision, chunks: AsyncIterable<ProviderChunk>, cancel() }>`.
- `cancel(requestId): boolean` — cancel an active stream by id (the DELETE route).

`InferenceRequest` is OpenAI-chat-shaped: `{ requestId, workload, messages[],
maxTokens?, stream?, contextTokens? }`. `messages` ARE the request body — they are
NEVER persisted to telemetry. The cancel handle is keyed by `requestId` so
`DELETE /api/inference/requests/:id` reaches it.

## The gates → modes → fallback order (010b)

The router harness wires the pipeline shape; 010b fills the bodies IN ORDER:

1. `selectCandidates(workload, policy)` — the targets the policy reaches (DONE: pure
   config navigation; chain ∪ allowlist, or all targets for an automatic policy).
2. `applyGates(candidates, request)` — drop targets failing **privacy** (`tierSatisfies`),
   **capability** (superset), or **context** (`target.contextWindow >= request.contextTokens`),
   appending a `blocked` AttemptRecord per drop (b-AC-1). **Gates run BEFORE mode
   selection** — a gate failure blocks a candidate outright.
3. `selectByMode(survivors, policy)` — order the survivors by mode (b-AC-2).
4. `executeWithFallback(request, decision)` — call targets in order; 4xx/5xx → next
   allowed, append BOTH attempts (b-AC-4); 401 → add the account to `expiredAccounts`
   (in-memory, process lifetime — b-AC-5); a missing/expired account degrades its
   targets out (b-AC-3). Resolve the secret through the `SecretResolver` HERE — the
   value lives only in this local scope.

**010b's carve-out:** 010b fills the `// WAVE 2 (010b)` stubs INSIDE `router.ts`
(`routeMultiCandidate`/`applyGates`/`selectByMode`/`executeWithFallback`/`streamWithFallback`)
and writes `tests/daemon/runtime/inference/router.test.ts`. The trivial single-target
`explain` already works (Wave 1) — do not break it. Keep `notImplemented` throwers
honest until the real body lands; never fake-pass.

## The fake test posture (no real HTTP, no real secrets)

- `createFakeProviderTransport(script)` — script by target id → `{ text }` (success,
  chunked for stream) | `{ statusCode }` (thrown `ProviderError`). `.calls` records
  the observed attempt order (assert the b-AC-4 fallback sequence). NO real HTTP in
  any unit test — the real transport is a thin LATER addition the seam abstracts.
- `createFakeSecretResolver(table)` — ref → value; an unknown ref rejects. NO real
  `.secrets/` is ever touched; PRD-012 builds the real resolver.
- Drive the router with the fakes + a fake/real `RoutingHistoryStore`. Assert the
  decision, the attempt sequence, the gate reasons, and that the recorded event
  carries NO secret/body.

## Reaching storage / catalog / SQL safety (history store + any live itest)

- `storage` — the `StorageQuery` client. **Never a raw fetch.** The history store's
  writes go through `appendOnlyInsert` (heal-aware via `withHeal`); its reads use
  `sLiteral`/`sqlIdent`. `audit:sql` scans `src/daemon`.
- Resolve the `HealTarget` via `healTargetFor("routing_history")` from
  `catalog/index.js` — never re-state columns.
- `routing_history` is `scope: "none"` + `pattern: "append-only"`. The `org_id` /
  `workspace_id` columns are denormalized telemetry context for the `recent` filter,
  NOT the isolation mechanism (the partition isolates the rows).
- Every value through `val.str()` / `val.text()` or `sLiteral`; every identifier
  through `sqlIdent`. NEVER hand-quote a value.

## Where each Wave-2 module + test lives

| Module | Stub | Test (name each `describe` after the AC it proves) |
|---|---|---|
| 010b routing engine | `router.ts` (fill the marked stubs) | `tests/daemon/runtime/inference/router.test.ts` |
| 010c gateway | `gateway.ts` (fill `mountInferenceGateway`) | `tests/daemon/runtime/inference/gateway.test.ts` |
| 010d route CLI | `src/cli/route.ts` (CREATE — 010d owns it; Wave 1 did NOT create it) | `tests/cli/route.test.ts` |

010d's CLI reads telemetry through `RoutingHistoryStore.recent` (d-AC-2) and calls
`router.explain` for `route explain` (d-AC-1). It is a thin client of the daemon
surface — do NOT import storage into the CLI (the invariant test forbids it); reach
the router/history through the daemon.

Optional opt-in LIVE tests (gated on `HONEYCOMB_DEEPLAKE_TOKEN`, throwaway table,
DROP cleanup): `tests/integration/routing-history-live.itest.ts` (Wave 1, append +
redacted read-back asserting no secret/body on disk). No `.skip`/`.only`;
`vitest run` is CI. If a live read-back reads MORE THAN ONE freshly-written row,
poll-and-union (copy `scanDistinct`/`SCAN_POLLS` from `graph-persist-live.itest.ts`)
— a single immediate scan under-reports on this backend.

## Daemon assembly is DEFERRED (D-9)

Wave 1 is constructed-and-tested, not wired into the running daemon:

- The daemon swaps `noopModelClient` for `new RouterModelClient(router)` — that
  wiring lands in a LATER step (a documented TODO at the assembly site). Tests still
  inject the fake `ModelClient`; the stage code is byte-identical.
- The gateway mounts onto `daemon.group("/api/inference")` / `daemon.group("/v1")`
  via `mountInferenceGateway` when 010c is filled and the assembly step runs.

Keep every export's signature stable so the assembly is a pure wiring step.

## The real Anthropic transport + the ModelClient factory (PRD-026 AC-T)

Wave 1 shipped ONLY the fake transport. PRD-026 adds the real HTTP body + the
assembly swap, packaged so the Wave-1c assembly bee calls ONE function.

### `transport-anthropic.ts` — `createAnthropicTransport(deps?)`

The real `ProviderTransport` against `https://api.anthropic.com/v1/messages`.

- `execute(call)` POSTs with headers `x-api-key: <call.apiKey>`,
  `anthropic-version: 2023-06-01`, `content-type: application/json`. The
  OpenAI-shaped internal request is reshaped via the pure `toAnthropicBody`:
  `role:"system"` messages hoist to the top-level `system` string (newline-joined),
  the rest become `messages:[{role:"user"|"assistant",content}]`, and `max_tokens`
  is ALWAYS sent (`request.maxTokens ?? DEFAULT_MAX_TOKENS = 4096`), `model` from
  `target.model`. The success body is zod-validated at the boundary
  (`AnthropicMessagesResponseSchema`); the `content[]` `type:"text"` blocks are
  joined into `ProviderResult.output`.
- `stream(call)` is a THIN wrapper: a non-stream execute yielding one terminal
  `ProviderChunk` carrying the full text (the pollinating path consumes a whole
  completion, not a token stream). The seam shape is preserved so a real SSE body
  can replace it later without touching the router.
- **Error mapping (load-bearing):** a non-2xx response THROWS
  `new ProviderError(status, "<short status string>")` — exactly the shape
  `router.ts`'s `providerStatus(err)` reads. So 401 → expire-account, other
  4xx/5xx → next-target fallback, identical to the fake. A network failure → 503; a
  malformed body → 502. The key and the response body NEVER appear in a thrown
  message or any log.
- **Seams:** `fetch` (default `globalThis.fetch`) and `baseUrl` (default the
  Anthropic endpoint) are injectable — tests inject a fake fetch (NO real network),
  and an OpenAI-compatible/OpenRouter transport can reuse the reshaping by
  overriding `baseUrl`.

### `model-client-factory.ts` — `buildInferenceModelClient(deps)`

`deps = { scope, secretsStore, config, history? }` where `config` is a resolved
`InferenceConfig` OR a path to load `agent.yaml` from. Constructs
`createSecretResolver(secretsStore, scope)` + `createAnthropicTransport()` +
`createInferenceRouter(...)` and returns `new RouterModelClient(router)` typed as the
006 `ModelClient`. Returns `noopModelClient` (NEVER throws) when the config is
absent, empty, non-routable (no accounts/workloads), or even malformed — a daemon
without inference configured runs recall on lexical fallback and pollinating is simply
unavailable. `history` defaults to `noopRoutingHistoryStore` so the factory stays
storage-free (telemetry wiring is a separate assembly step).

**Wave-1c assembly note:** call `await buildInferenceModelClient({ scope,
secretsStore, config })` and inject the result wherever `noopModelClient` is today
(stages + the pollinating runner). `config` should be the daemon's resolved
`InferenceConfig` (or the `agent.yaml` path). No `agent.yaml` exists yet — the
factory degrades to no-op until one is created, so wiring it is safe before the
config lands.
