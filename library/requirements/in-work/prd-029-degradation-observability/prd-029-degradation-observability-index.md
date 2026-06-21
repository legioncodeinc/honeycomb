# PRD-029 — Degradation observability (surface the silent fallbacks)

> Status: backlog · Owner: `/the-smoker` · Type: S/M (feature)
> Goal: make the engine's degradation modes VISIBLE — in recall responses, in `/health`, and on the
> dashboard — instead of degrading silently with no signal to the operator.

## Why
The engine degrades silently. With embeddings off, recall falls back to lexical BM25/ILIKE; a
missing sibling arm (`memory` / `sessions` not yet created on a fresh partition) yields empty for
that arm. `recallMemories` ALREADY computes and returns `degraded: true`
(`src/daemon/runtime/memories/recall.ts`) and the route already serializes it
(`src/daemon/runtime/memories/api.ts` → `recallResponse`), but NOTHING surfaces it to the user: the
dashboard does not show "lexical fallback", the logs do not record it, and there is no per-subsystem
signal. Worse, the daemon `/health` is COARSE — a bare `ok` / `degraded` / `unconfigured` bit
refreshed by a `SELECT 1` probe (`refreshHealth` in `src/daemon/runtime/assemble.ts`) — so when it
flips to `degraded` there is no WHY: is storage unreachable, are embeddings off, is a table missing?
The dogfood repeatedly hit a degraded engine that LOOKED healthy. This PRD threads the signal the
code already has out to where a human can see it.

## Goal
Surface the three degradation signals already latent in the runtime: (a) recall's `degraded` flag →
dashboard + structured logs; (b) a richer `/health` that reports WHY it is degraded (which subsystem
is down) instead of a bare enum; (c) a per-subsystem dashboard treatment ("semantic: off", "recall:
lexical fallback"). All without leaking a secret (the no-token-in-logs invariant holds).

## Scope / What
- **Recall degraded → surfaced.** The `degraded` boolean (and the `sources` arm-coverage already in
  `MemoryRecallResult`) is rendered on the dashboard recall bar as a badge ("lexical fallback") and
  written as a structured log line when a recall ran degraded.
- **Richer `/health` detail.** Extend the health contract from a bare `ok`/`degraded`/`unconfigured`
  enum to a structured body: the overall bit PLUS per-subsystem reasons — `storage`
  (reachable? from the `SELECT 1` probe), `embeddings` (on/off), `schema` (a required table missing).
  The coarse bit stays for backward-compat; the detail is additive.
- **Dashboard signal.** A per-subsystem health strip + the recall-bar degraded badge, reading the new
  `/health` detail and the recall response's `degraded` — no new data pipeline, just rendering signals
  that already exist.
- **No-secret guarantee.** Every new field + log line is scrubbed: the health detail and degraded logs
  carry subsystem NAMES and states, never a token, endpoint credential, org GUID, or header value
  (the same discipline `RequestLogRecord` and the SQL tracer already enforce).
- NON-goal: fixing the degradations (turning embeddings on, creating the missing table). This PRD makes
  them VISIBLE; remediation is the operator's call (or a separate PRD).

## Decisions
- **D-1 — Degraded state rides the per-response flag; health detail is a status read.** Recall's
  `degraded` stays on the recall RESPONSE (it is per-query — this query fell back), exactly where the
  code already puts it. Subsystem health (storage/embeddings/schema) is a daemon-wide STATUS, so it
  lives on `/health`, refreshed by the existing probe loop — not smeared onto every response.
- **D-2 — `/health` detail is graduated by mode.** In `local` (loopback single-user) the full detail
  is exposed — it is the dogfood operator's own daemon. In `team`/`hybrid` the public `/health` keeps
  the coarse bit (a remote caller learns up/down, not internal topology), and the detail is gated to
  the protected diagnostics surface. No internal subsystem map leaks to an unauthenticated remote.
- **D-3 — Additive, backward-compatible contract.** The bare `ok`/`degraded` bit and its consumers
  (`/api/status`, the connectivity banner) are unchanged; the structured `reasons` are NEW fields. No
  existing caller breaks; the dashboard opts into the richer shape.
- **D-4 — Reuse the existing probe + flag; add no new pipeline.** Storage reachability comes from the
  ALREADY-running `refreshHealth` `SELECT 1` (`assemble.ts`); the embeddings-off state is known at
  assembly (the no-op embed seam, ledger D-4); recall's `degraded` is already computed. This PRD wires
  those three known facts to surfaces — it does not add probes or recompute health.
- **D-5 — No secret, grep-proven.** Reuse the redaction posture: the health detail + degraded logs are
  subsystem state only. A grep/test proves no token/org/header in any new field or line.

## Acceptance criteria
- **AC-1 — Dashboard shows the fallback.** A unit/DOM test asserts that when a recall response carries
  `degraded: true`, the dashboard recall bar renders the "lexical fallback" badge; when `degraded:
  false` it does not. Driven by the recall response shape, no live backend needed.
- **AC-2 — `/health` reports a structured reason.** A unit test asserts that when a subsystem is down
  (e.g. the `SELECT 1` probe returns non-`ok` → storage unreachable, or embeddings are off), `/health`
  detail names that subsystem and its state — not a bare `degraded`. The coarse bit still reports too.
- **AC-3 — Mode-gated detail.** A test proves the full subsystem detail is exposed on `local` `/health`
  but the public `team`/`hybrid` `/health` returns only the coarse bit (the detail is on the protected
  diagnostics surface) — no internal topology leaks unauthenticated.
- **AC-4 — Structured degraded log.** A recall that runs degraded emits a structured log line capturing
  the degraded mode (lexical fallback / which arms covered) — asserted via the ring-buffer logger.
- **AC-5 — No secret anywhere.** A grep/test proves no token, endpoint credential, full org GUID, or
  header value appears in the `/health` detail, the degraded badge payload, or the degraded log line.
- **AC-6 — Gates green.** `npm run ci` / `build` / `audit:sql` / `audit:openclaw` all green.

## Risks / Out of scope
- RISK: over-exposing topology in team/hybrid is itself a security smell — D-2 + AC-3 gate the detail to
  local / the protected surface to contain it.
- OUT: remediating the degradations (embeddings-on is embeddings-runtime's call; auto-creating a missing
  table is the heal engine's, PRD-002c); new recall ranking or schema.

## Dependencies
- Surfaces what PRD-025 / PRD-026 expose: 029 renders the recall `degraded` flag and the subsystem
  health that the recall + health plumbing (PRD-025/026 era) produce — it adds the VISIBILITY layer on
  top of their signals, not new signals.
- Reads recall's existing `degraded` / `sources` (`src/daemon/runtime/memories/recall.ts`) and the
  cached health bit + `refreshHealth` probe (`src/daemon/runtime/assemble.ts`).
- Renders on the dashboard host + diagnostics views (PRD-024 / `src/daemon/runtime/dashboard/api.ts`).

## Reference
- Recall degraded flag: `src/daemon/runtime/memories/recall.ts` (`MemoryRecallResult.degraded` /
  `sources`), serialized in `src/daemon/runtime/memories/api.ts` (`recallResponse`).
- Coarse health today: `src/daemon/runtime/assemble.ts` (`refreshHealth` → `SELECT 1`,
  `PipelineStatus = "ok" | "degraded" | "unconfigured"`), the `/health` + `/api/status` surface.
- Dashboard render targets: `src/daemon/runtime/dashboard/api.ts`, `src/dashboard/contracts.ts`,
  the dashboard web app under `src/dashboard/web/`.
- No-secret precedent: the `/api/logs` `RequestLogRecord` token-leak proof + the SQL tracer redaction
  (`src/daemon/storage/client.ts`).
