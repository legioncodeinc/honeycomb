# Security Audit — PRD-010 Model & Provider Router

- **Branch:** `prd-010-model-provider-router`
- **Auditor:** security-worker-bee (Hivemind security-stinger)
- **Date:** 2026-06-17
- **Scope:** all PRD-010 deliverables (inference module, `routing_history` table, `honeycomb route` CLI, catalog wiring, `yaml` dep)
- **Ordering:** RUN BEFORE `quality-worker-bee`. No QA report exists for this branch — ordering is correct, QA is cleared to run after this audit.

---

## Executive Summary

**VERDICT: PASS — quality-worker-bee is CLEARED to run.**

PRD-010 introduces the model-provider router: a config contract (`config.ts`), a routing
engine (`router.ts`), an HTTP gateway (`gateway.ts`), a redacted telemetry store
(`history-store.ts` + the `routing_history` catalog table), and the `honeycomb route` CLI.
The central security thesis of the PRD — **a secret/API key or a request/response body must
NEVER be logged, dumped, persisted, or returned to a client** — holds affirmatively and
adversarially across every code path examined.

- **0 Critical** · **0 High** · **2 Medium** · **2 Low** (all Medium/Low documented; none required an in-session fix).
- No remediation diffs were applied. The implementation as delivered already satisfies the
  Critical/High security bar by construction. The working tree is therefore unchanged by this
  audit (`git diff` shows only the implementer's PRD-010 changes, clean and scoped).
- The two Medium and two Low items are forward-looking hardening recommendations for the
  **deferred real `ProviderTransport`** (no real provider HTTP exists in this branch — it is a
  test-faked seam), not live defects on this branch.

The redaction discipline is enforced *by type construction* at every layer, not by a
read-time scrub — the single strongest possible posture for this thesis. The
`RedactedRoutingEvent` shape has no field that can hold a key/prompt/completion, and every
sink (`history-store` write, `/api/inference/history` read, `route status` output, thrown
errors, SSE error frames) consumes only that shape or fully discards thrown messages.

### Gate results (final)

| Gate | Command | Exit |
|---|---|---|
| SQL safety | `npm run audit:sql` | **0** |
| OpenClaw bundle | `npm run audit:openclaw` | **0** |
| Typecheck | `npm run typecheck` | **0** |
| Inference + CLI tests | `vitest run tests/daemon/runtime/inference tests/cli/route.test.ts` | **0** (75/75) |

(`npm run build` and the full `npm run ci` were already green per the EXECUTION_LEDGER root-verify;
the live `routing-history-live.itest` is owned by the orchestrator and was not run here per instruction.)

---

## Thesis verification (affirmative + adversarial)

### 1. Secret never persisted / logged / dumped — PROVEN

**No raw key exists in any persisted or returned structure, by construction.**

- `contracts.ts:150-157` — an `Account` holds `apiKeyRef` (a `${SECRET_REF}` *reference string*)
  and has **no raw-key field**. There is no type anywhere in the contracts that carries a
  resolved key except the transient `ProviderCall.apiKey` (`contracts.ts:404-411`), which is a
  function argument local to one provider call.
- `config.ts:71-77` — the `SecretRef` zod schema rejects any value not matching
  `^\$\{[A-Za-z_][A-Za-z0-9_]*\}$`. An inline raw key is rejected at parse (a-AC-4), and the
  refinement message (`config.ts:75-77`) deliberately does **not** echo the rejected value, so a
  fat-fingered real key never lands in an error string.
- `config.ts:224-249` (`dumpInferenceConfig`) — emits `apiKey: a.apiKeyRef` (the reference), never
  a resolved value. The resolved value does not exist in the `InferenceConfig` structure at all.
- `router.ts:392` / `router.ts:437` — `this.secrets.resolve(account.apiKeyRef)` is the only place a
  resolved key materializes; it lives in a local `apiKey` const handed straight to the transport
  and never written to a `Target`, a `RoutingDecision`, or the recorded event.
- **Zero logging in the entire inference module.** A `grep` for `console.*|logger|.log(|process.stdout|process.stderr`
  across `src/daemon/runtime/inference/**` returns **no matches**. There is no log line that could
  interpolate a key.
- `history-store.ts` — a `grep` for `apiKey|secret|messages|.content|prompt|output` finds only
  doc-comment references; the writer (`toPersistedEvent`, lines 76-86) copies only
  request_id/workload/serving_target/mode/attempts/blocked_candidates.

**Adversarial probes attempted and defeated:**
- Can a resolved key reach the `event` JSONB? No — `record()` accepts only `RedactedRoutingEvent`
  (`history-store.ts:138`), whose type has no key field.
- Can it reach `/api/inference/history`? No — `gateway.ts:167-181` surfaces `historyStore.recent()`
  rows verbatim, and those rows are the same redacted shape.
- Can it reach `route status` output? No — `route.ts` mirrors `RedactedRoutingEvent` as
  `RouteHistoryEvent` (`route.ts:92-99`) with no key/body field; `route.test.ts:448-537` asserts
  `not.toMatch(/sk-[A-Za-z0-9]/)` + no `apiKey`/`apiKeyRef`.
- Can it reach a thrown error? No — see #2.

### 2. Provider error redaction (c-AC-5) — PROVEN

`gateway.ts:490-496` (`redactedError`) **discards the thrown error's message entirely** and
substitutes a fixed status-class string `upstream provider returned status N`. No error message
string from the thrown value is ever forwarded — to the JSON error response (`errorResponse`,
line 499), the OpenAI error envelope (`openAiErrorResponse`, line 505), or the SSE error frame
(`sseStream` catch, `gateway.ts:425-427`). Even a `ProviderError` whose `.message` echoes a key
(the exact attack the test `gateway.test.ts:384-402` plants — `sk-LIVE-SECRET-abc123`) cannot
leak, because the message is replaced, not filtered. This is the correct design (replace, not
scrub).

### 3. Request body never persisted — PROVEN

`InferenceRequest.messages` (`contracts.ts:315-328`) is the prompt body. `toRedactedEvent`
(`contracts.ts:570-579`) — the single sanctioned decision→event projection — copies only
requestId/workload/servingTarget/mode/attempts/blockedCandidates and **never touches `messages`**.
The live itest (`routing-history-live.itest.ts:62-63,137-138,174-177`) plants both a secret and a
request body and asserts neither appears on disk, plus a `sk-` regex check.

### 4. SSRF / URL safety — NOT REACHABLE on this branch (hardening recommended → Medium-1)

A `grep` for `baseUrl|base_url|fetch(|new URL|http://|https://|169.254` across the inference
module returns **no network/URL code**. The `ProviderTransport` is a pure seam; the real HTTP
transport is explicitly deferred (EXECUTION_LEDGER: "live provider calls out of scope … fake
transport"). Critically, the **config side offers no attacker-controllable URL**: the `Account`
schema (`config.ts:80-84`) has only `id`, `provider`, `apiKey` — there is **no `baseUrl`/endpoint
field** a malicious `inference:` block could point at `169.254.169.254` or `file://`. SSRF is
therefore not reachable today. See Medium-1 for the forward-looking requirement when the real
transport lands.

### 5. SQL injection — PROVEN SAFE (`audit:sql` exit 0)

Every interpolation in `history-store.ts` and `routing-history.ts` routes through the PRD-002b
guards:
- `history-store.ts:164` — `sqlIdent(ROUTING_HISTORY_TABLE)`; `ROUTING_HISTORY_TABLE` is the frozen
  literal `"routing_history"` (`routing-history.ts:57`) — passes the `^[A-Za-z_][A-Za-z0-9_]*$`
  identifier check.
- `history-store.ts:167-169` (`recent` SELECT) — `org_id`/`workspace_id` filters go through
  `sLiteral()` (→ `sqlStr`, doubles quotes + backslashes); `LIMIT` is `clampLimit()` (a number,
  `[1, MAX_HISTORY_LIMIT=500]`).
- `history-store.ts:143-152` (`record` INSERT) — every value is a `val.*` `ColumnValue` rendered
  through `renderValue` (`writes.ts:66-77`): `val.str`→`sLiteral`, `val.text`→`eLiteral` (the
  escape-safe `E'...'` form for the JSONB body). Every column name goes through `sqlIdent`
  (`writes.ts:84`).
- **Bypass attempt:** I traced every config-derived string that reaches SQL (workload, request_id,
  org, workspace, the serialized event body). Each is wrapped — none reach the statement unescaped.
  No bypass found; `audit:sql` confirms no hand-interpolation around the helpers.

### 6. Body-size clamp cannot be bypassed (c-AC-5) — PROVEN

`readClampedJson` (`gateway.ts:257-277`) checks **both** the declared `content-length`
(`gateway.ts:258-261`) **and** the real measured byte length via `Buffer.byteLength(raw, "utf8")`
(`gateway.ts:269`). A lying or absent `content-length` cannot smuggle an oversized body past the
guard, because the post-read measurement is authoritative. The limit
(`MAX_REQUEST_BODY_BYTES = 1_048_576`) is a single documented constant.

### 7. Gateway honors permission middleware — PROVEN

`server.ts:85-86` — both `/api/inference` and `/v1` are `protect: true` in `ROUTE_GROUPS`.
`mountInferenceGateway` (`gateway.ts:102-105`) attaches handlers RELATIVE to the
`daemon.group(...)` sub-apps and does **no auth re-wiring** — it inherits the
`permissionMiddleware` (`permission.ts:88-113`) the bootstrap already mounted. In `team`/`hybrid`
mode the check runs before the handler and is **default-deny** until the real auth policy is
wired (`permission.ts:75`). An OpenAI client hitting `/v1/*` must therefore still be authorized.
The gateway's `historyScope()` (`gateway.ts:533-538`) reads `x-honeycomb-org` exactly as the rest
of the daemon does (`permission.ts:61`, `capture-handler.ts:194`, `server.ts:205`) — it follows
the established org-context convention, introducing no new scope-coercion surface.

### 8. DoS / unbounded growth — bounded (one minor note → Low-1)

- `expiredAccounts` (`router.ts:97`) — a `Set<string>` of account ids. Bounded by the number of
  **configured** accounts (config-driven, finite); not attacker-amplifiable.
- `activeStreams` (`router.ts:90`) — keyed by `requestId`; entries are deleted on stream
  completion (`router.ts:473` `finally`), on cancel (`router.ts:458`), and by `cancel()`
  (`router.ts:173`). See Low-1 for the one back-pressure edge case.
- History reads are clamped: `clampLimit` (`history-store.ts:182-185`) caps at
  `MAX_HISTORY_LIMIT=500`; the gateway's `parseLimit` (`gateway.ts:541-546`) defaults bad values.
- Config size: zod bounds the shape; a malformed `inference:` block fails closed at parse
  (`config.ts:204-215`).

---

## Findings

### Critical — None detected
### High — None detected

### Medium

**Medium-1 — Real `ProviderTransport` must enforce SSRF egress controls when implemented (forward-looking).**
- **Where:** `src/daemon/runtime/inference/contracts.ts:420-425` (the `ProviderTransport` seam); the future real transport module.
- **Why:** Today there is no URL/fetch code and no config-supplied endpoint, so SSRF is not
  reachable (see thesis #4). But when the real transport lands and `Account.provider` (or a future
  endpoint/base-URL field) selects a network destination, an attacker-influenced `inference:` block
  could point a target at an internal host (`169.254.169.254`, `file://`, `localhost`-only admin
  ports) if the provider→URL mapping is not allowlisted.
- **Recommendation (for the transport step):** map `provider` to a **fixed allowlist** of known
  provider base URLs in code (never accept a free-form URL from config); if a configurable endpoint
  is ever required, validate the scheme (`https` only), resolve the host, and reject RFC-1918 /
  link-local / loopback ranges before connecting. Document this in the transport's CONVENTIONS.
- **Action:** Documented only (no live defect on this branch). Track as an explicit AC on the real-transport sub-PRD.

**Medium-2 — `/v1/chat/completions` maps an unauthenticated-body `model` field directly to a routing workload.**
- **Where:** `gateway.ts:327-339` (`toOpenAiRequest`) — `workload: b.model`; resolved in
  `router.ts:508-512` (`workloadFor`), which throws `inference: no workload named "<name>"` for an
  unknown workload.
- **Why:** The thrown error is caught by `openAiErrorResponse`→`redactedError`
  (`gateway.ts:490-496`), which collapses it to a generic `internal routing error` / 500 — so the
  unknown workload name is **not** echoed back (no enumeration-via-error-message leak, good). The
  residual concern is purely **error-class hygiene**: an unknown-workload (caller input error) is a
  400-class condition surfaced as a 500. No information disclosure, no injection — the value is
  never interpolated into SQL or a URL (it only does an in-memory `.find()` over configured
  workloads).
- **Recommendation:** optionally distinguish "unknown workload" as a 400 `invalid_request_error`
  rather than a 500 for cleaner client semantics. Under ~5 lines but **not applied** — it touches
  AC-covered error-shape behavior (`gateway.test.ts`) and is cosmetic, not a security fix; left to
  the implementer to avoid contaminating the security diff.
- **Action:** Documented only.

### Low

**Low-1 — Stream cancel handle registered before the consumer iterates.**
- **Where:** `router.ts:452-477` (`streamWithFallback`) — the cancel handle is registered in
  `activeStreams` (line 461) as soon as the first chunk primes; the cleanup `finally`
  (line 472-474) runs only when the returned `chunks()` async generator is iterated to completion or
  cancelled. If a caller obtains a `StreamResult` but never iterates it and never calls
  `cancel()`/`DELETE`, the entry lingers until process exit.
- **Why Low:** The gateway always either streams the chunks (`sseStream` drains them) or cancels on
  the no-serving-target path (`gateway.ts:157,223`), so in practice every stream is drained or
  cancelled. The map is keyed by a unique `requestId`, growth is one entry per truly-abandoned
  stream, and it is daemon-internal (not directly attacker-driven through the protected gateway).
- **Recommendation:** consider a max-size or TTL sweep on `activeStreams` when the real streaming
  transport is wired, as defense-in-depth. Documented only.

**Low-2 — `freshRequestId` uses `Math.random()`.**
- **Where:** `gateway.ts:356-358`.
- **Why Low / non-issue:** the value is a **request-correlation id only** (keys the decision +
  cancel handle); it is never a token, secret, or security boundary. `Math.random` is appropriate
  here. The routing scorer is explicitly deterministic with **no** `Math.random` (`router.ts:588-615`),
  which is the correct place to care. Recorded for completeness; no action.

---

## Category checklist (every category was checked)

| Category | Result |
|---|---|
| Dependency / bundle gate (`npm audit`, OpenClaw) | OpenClaw exit 0; `yaml@2.9.0` is the canonical eemeli/yaml from the official registry — not a typosquat |
| Rules-file backdoor (zero-width / bidi) | N/A — branch adds no `.cursor/rules`/AGENTS.md/CLAUDE.md content |
| Env config & secrets | No committed `.env`, no hardcoded token/JWT/`sk-` in the new code; secret-ref-only enforced at parse |
| API client hardening | N/A — inference module holds no DeepLake client of its own; history-store routes through the guarded storage layer |
| Pre-tool-use gate integrity | N/A — branch does not touch `pre-tool-use.ts` / VFS |
| Deep Lake SQL construction | SAFE — all identifiers via `sqlIdent`, all values via `sLiteral`/`eLiteral`/`val.*`; `audit:sql` exit 0 |
| MCP tool handlers | N/A — branch adds no MCP tools |
| Captured-trace capture path | N/A — branch adds no capture writes; telemetry is redacted-by-construction |
| Prompt-injection surface | N/A — branch does not inject recalled memory / mined skills |
| Credential file handling | N/A — branch does not touch `credentials.json` / auth flow |
| Logging & error paths | Zero logging in the module; errors fully redacted (thesis #2) |
| Org RBAC enforcement | Gateway inherits `protect: true` permission middleware; no new scope-coercion path (thesis #7) |
| Secret never persisted/logged/dumped (thesis #1) | PROVEN by construction |
| Provider error redaction (thesis #2) | PROVEN |
| Request body never persisted (thesis #3) | PROVEN |
| SSRF / URL safety (thesis #4) | Not reachable on this branch; hardening tracked as Medium-1 |
| Body-size clamp (thesis #6) | PROVEN (measures real byte length) |
| DoS / unbounded growth (thesis #8) | Bounded; one defense-in-depth note (Low-1) |

---

## Files reviewed

- `src/daemon/runtime/inference/contracts.ts`, `config.ts`, `router.ts`, `gateway.ts`,
  `history-store.ts`, `index.ts`
- `src/daemon/storage/catalog/routing-history.ts`, `src/daemon/storage/catalog/index.ts`
- `src/daemon/storage/sql.ts`, `src/daemon/storage/writes.ts` (the SQL-guard floor)
- `src/daemon/runtime/server.ts`, `src/daemon/runtime/middleware/permission.ts`
  (auth/route-group inheritance)
- `src/daemon/runtime/pipeline/model-client.ts` (the modified seam — doc-only change)
- `src/cli/route.ts`
- `tests/daemon/runtime/inference/gateway.test.ts`, `tests/cli/route.test.ts`,
  `tests/integration/routing-history-live.itest.ts`

## Remediation applied

**None.** No Critical or High findings. Working tree unchanged by this audit; `git diff` contains
only the implementer's PRD-010 changes (inference module, `routing_history` table, route CLI,
3-line catalog barrel spread, `yaml` dep, library doc moves) — clean and scoped, no unrelated edits.

---

## Verdict

**PASS. quality-worker-bee is CLEARED to run.** The central thesis is proven affirmatively and
adversarially; all four deterministic gates are green; no Critical/High findings. The two Medium
items are forward-looking hardening requirements for the deferred real `ProviderTransport`, not
defects on this branch — they should be tracked as explicit ACs on the real-transport sub-PRD.
