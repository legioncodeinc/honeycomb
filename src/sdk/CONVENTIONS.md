# `@honeycomb/sdk` — CONVENTIONS (PRD-019e)

The SDK lives under `src/sdk/`. It is a typed HTTP client with NO native dependencies (safe in
Node, Bun, and the browser) wrapping the daemon API, plus React bindings, a Vercel AI SDK helper,
and an OpenAI tool helper. Wave 1 (019e scaffold) ships the client interface + typed errors + the
fetch/retry seams + the three entry-point stubs; Wave 2 fills the bodies.

## The central rule: fetch-only THIN CLIENT, no native dependency (FR-1 / FR-3 / e-AC-3 / D-2)

- **`src/sdk` is in `NON_DAEMON_ROOTS`** (`tests/daemon/storage/invariant.test.ts`). The SDK opens
  NO DeepLake; it reaches the daemon over HTTP only.
- **Standard `fetch` ONLY** — via the injectable `Fetch` seam (default: global `fetch`). No
  Node-only HTTP module, no native dep, so the client runs in Node, Bun, AND the browser (e-AC-3).
  A Wave-2 test drives the client against a stub `Fetch` — no network.

## The actor + token model (FR-2 / FR-6 / e-AC-1)

The client is constructed with `{ daemonUrl, token?, actor, actorType }`. Every authenticated call
carries the configured token + actor + actorType (the same model as the rest of the daemon). The
`remember`/`recall` ergonomic helpers and every grouped method stamp them; a Wave-2 test asserts
the headers are present (e-AC-1).

## Typed errors + the retry split (FR-4 / FR-5 / e-AC-2)

- `ApiError` (non-2xx; carries status + body), `NetworkError` (transport), `TimeoutError` (past
  budget). All extend `HoneycombError` so a caller can catch the base.
- **GET retries, mutations do NOT** — the `RetryPolicy` seam (`maxAttempts(method)`) expresses the
  split so the SDK never double-applies a non-idempotent write. `defaultRetryPolicy` is GET→3,
  mutations→1. A Wave-2 test drives the split deterministically (no real backoff delay). Retry
  covers BOTH a transient transport failure (`NetworkError`) AND a transient status (429/5xx); a
  `TimeoutError` (past budget) is terminal and never retried.
- **`recall`/`memory.search` is a POST** (the query rides in the body) and therefore does NOT retry,
  even though a search read is logically idempotent. The split keys conservatively off the HTTP
  method, so a body-carrying read is treated like a mutation for retry purposes. `memory.get`/
  `memory.list` are true GETs and DO retry. This is deliberate: it keeps the rule one-line and
  guarantees no body-carrying request is ever silently re-sent.
- **Timeout** is enforced with a standard `AbortController` + `setTimeout` (browser-safe globals).
  The per-request budget defaults to `DEFAULT_TIMEOUT_MS` (30s) and is overridable per client via
  `timeoutMs` in the options (the PRD open question on a per-call override is noted below).

## Value-safe secrets (FR-9 / e-AC-6)

`client.secrets.list()` returns NAMES only (`SecretName[]`); `client.secrets.exec()` returns
REDACTED output only. The SDK never returns a raw secret value — the type surface enforces it
(there is no value field) and the Wave-3 security audit verifies it.

## Framework helpers ship as SEPARATE entry points (FR-7 / FR-8 / e-AC-4 / e-AC-5)

`react.ts`, `vercel.ts`, `openai.ts` are separate modules so the core client stays dependency-free
for browser use. They REUSE the core client's token + actor model — they adapt its methods, never
re-implement HTTP. The barrel (`index.ts`) does NOT re-export them; an app imports `@honeycomb/sdk`
for the core and `@honeycomb/sdk/react` (etc.) for a helper.

**Wave 2 build wiring (DONE — PRD-019e).** The three helpers ship as separate package exports:
- `package.json#exports` subpaths are wired: `.` → `./sdk/index.js`, `./react` → `./sdk/react.js`,
  `./vercel` → `./sdk/vercel.js`, `./openai` → `./sdk/openai.js`. `sdk` is added to `package.json#files`.
- `esbuild.config.mjs` builds the four SDK entry points (`dist/src/sdk/{index,react,vercel,openai}.js`)
  into `sdk/` as ESM (`platform: node`, `format: esm`, ESM marker stamped). The `react` entry marks
  `react` external; the `vercel` entry marks `ai` external — they are `peerDependencies`, never bundled.
  The core (`.`) and `openai` entries pull in NEITHER peer dep, keeping the core browser-safe.
- `peerDependencies` (`react >=18`, `ai >=3`) are declared OPTIONAL via `peerDependenciesMeta`, so the
  core entry installs and runs with no peer dep present.

**React is an INJECTED runtime seam, not a static import.** `react` is a peer dep with no `@types/react`
in this repo, so a static `import … from "react"` would not typecheck under the existing `tsc` pass.
`react.ts` defines a minimal local `ReactRuntime` interface (`useState`/`useEffect`/`useCallback`) and
the bindings take it as a parameter; an app threads its real `React`, a test passes a tiny fake. This
keeps the module compiling with zero new deps while the bindings run against real React at app runtime.

**Honest deferral.** The SDK is constructed, bundled, and tested as subpath exports of this repo.
PUBLISHING `@honeycomb/sdk` as its own npm package (vs. these subpath exports) is out of scope for 019e.

## Open questions (recorded, not resolved)

- Separate published packages vs subpath exports of `@honeycomb/sdk` for the helpers (PRD open Q).
- The default timeout budget + per-call override (`DEFAULT_TIMEOUT_MS` is the Wave-1 placeholder).

## What Wave 2 fills (signatures STABLE — pure fill)

- `createHoneycombClient` request pipeline (URL + actor headers + token, fetch dispatch, retry
  split, error mapping) and every grouped method body.
- `react.ts` (`useRecall`/`useRemember` + provider), `vercel.ts` (`createVercelAiTools`),
  `openai.ts` (`createOpenAiTools` + `dispatchOpenAiToolCall`) against the core client.
