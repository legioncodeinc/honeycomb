# EXECUTION LEDGER — PRD-029 Degradation observability

> Orchestrator: `/the-smoker` · Branch: `prd-029-degradation-observability` · SSOT for AC tracking.
> Goal: surface the engine's already-latent degradation signals — recall `degraded`, a richer `/health`
> with per-subsystem reasons, and dashboard rendering — mode-gated, no-secret. Make degradations VISIBLE;
> NON-goal is fixing them. Mostly unit/DOM-testable (no gated live itest required).

## Phase 0 recon facts
- Coarse health TODAY: `assemble.ts` `refreshHealth` does `SELECT 1` → sets `healthBit: "ok"|"degraded"`; `PipelineStatus = "ok"|"degraded"|"unconfigured"`; `/health` reads the cached bit, `/api/status` consumes it. The mode (`local`/`team`/`hybrid`) is resolved in assemble.ts.
- Recall `degraded` ALREADY computed: `memories/recall.ts` `MemoryRecallResult.degraded` (true = embeddings off/absent → lexical BM25/ILIKE only) + `sources` (arm coverage); serialized by `memories/api.ts recallResponse`.
- Embeddings on/off is known at assembly (the no-op vs real embed seam).
- Ring-buffer logger: `src/daemon/runtime/logger.ts` (+ `logs/api.ts` `/api/logs`, `RequestLogRecord` token-leak proof = the redaction precedent).
- Dashboard: `src/dashboard/web/app.tsx` (header health pill + `RecallBar` + log panel), `src/dashboard/contracts.ts`, `src/daemon/runtime/dashboard/api.ts`.

## Pinned contract (so Wave 2 can consume Wave 1)
```ts
type SubsystemState = "ok" | "degraded";              // coarse-compat
interface HealthReasons {
  storage: "reachable" | "unreachable";               // from the SELECT 1 probe
  embeddings: "on" | "off";                            // from the embed seam at assembly
  schema: "ok" | "missing_table";                      // a REQUIRED table missing (best-effort; "ok" when unknown)
}
interface HealthDetail { status: PipelineStatus; reasons?: HealthReasons }  // reasons present in local; absent on public team/hybrid /health
```
`/health` body: local → `{status, reasons}`; team/hybrid PUBLIC → `{status}` only (reasons on the PROTECTED diagnostics surface). Backward-compat: `status` unchanged; `reasons` additive (D-3).

## Acceptance criteria
| AC | Criterion | Status | Owner |
|----|-----------|--------|-------|
| AC-1 | Dashboard shows the fallback: a DOM test asserts a recall response with `degraded:true` renders the "lexical fallback" badge on the recall bar; `false` → no badge. No live backend. | VERIFIED | W2 |
| AC-2 | `/health` structured reason: a unit test asserts when a subsystem is down (SELECT 1 non-ok → storage unreachable, or embeddings off) the `/health` detail NAMES that subsystem+state, not a bare `degraded`; the coarse bit still reports. | VERIFIED | W1 |
| AC-3 | Mode-gated detail: full subsystem detail on `local` `/health`; public `team`/`hybrid` `/health` returns ONLY the coarse bit (detail on the protected diagnostics surface) — no internal topology leaks unauthenticated. | VERIFIED | W1 |
| AC-4 | Structured degraded log: a recall that runs degraded emits a structured log line capturing the degraded mode (lexical fallback / arm coverage) — asserted via the ring-buffer logger. | VERIFIED | W1 |
| AC-5 | No secret anywhere: grep/test proves no token, endpoint credential, full org GUID, or header value in the `/health` detail, the degraded badge payload, or the degraded log line. | VERIFIED | W1/W2/close-out |
| AC-6 | Gates green: `npm run ci`/`build`/`audit:sql`/`audit:openclaw` + invariant + smoke:daemon-bundle. | VERIFIED | close-out |

## Decisions (from the PRD)
- D-1 recall `degraded` stays per-RESPONSE; subsystem health is a daemon-wide STATUS on `/health` (probe loop), not smeared onto every response.
- D-2 `/health` detail graduated by mode (local full; team/hybrid coarse public + detail on protected diagnostics).
- D-3 additive, backward-compatible (coarse bit + consumers unchanged; `reasons` new).
- D-4 reuse the existing probe + flag + assembly-known embed state; NO new pipeline/probe.
- D-5 no secret, grep-proven (subsystem state only).

## Wave plan
**Wave 1 — daemon signals (`typescript-node-worker-bee`).** Extend the health contract to `HealthDetail{status, reasons?}` (additive): populate `reasons.storage` from the `refreshHealth` SELECT 1 result, `reasons.embeddings` from the assembly embed-seam state, `reasons.schema` best-effort (a required table missing → `missing_table`, else `ok`). Mode-gate the `/health` body (local → with reasons; team/hybrid public → status-only; reasons on the protected diagnostics group). Emit a STRUCTURED degraded log line via the ring-buffer logger when a recall runs `degraded` (the recall path / api.ts — capture mode + arm coverage, NO secret). Unit tests AC-2/AC-3/AC-4 + AC-5 redaction (grep/test: no token/org/header in any new field/line). NO dashboard edits.

**Wave 2 — dashboard render (`typescript-node-worker-bee`, after W1).** Render the "lexical fallback" badge on the recall bar when the recall response `degraded:true` (`src/dashboard/web/app.tsx` + contracts), and a per-subsystem health strip reading the new `/health` `reasons`. DOM tests AC-1 (+ the strip). Consume the pinned `HealthDetail` shape. No new data pipeline. AC-5 holds (render subsystem names/states only).

**Close-out** — security-stinger → quality-stinger (focus: AC-3 mode-gating = no topology leak to unauthenticated remote; AC-5 no-secret).

## Constraints (in force)
- Explicit `git add <paths>`, NEVER `-A`. Keep `.agents/.codex/.claude/.cursor`/`AGENTS.md`/`.env.local`/`.secrets`/other PRDs' EXECUTION_LEDGER OUT. Verify new files not gitignore-swallowed. Daemon on 3850 — leave it.

## Status log
- Phase 0 recon complete; branch cut, PRD moved backlog→in-work. Dispatching Wave 1.
