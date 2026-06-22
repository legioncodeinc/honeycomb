# PRD-046 follow-up — durable-key generator + live prime-eval finding

> Date: 2026-06-22 · Branch: `legion/prd-046-followup` (post-#77 merge) · Two logged follow-ups addressed.

## 1. Durable-key generator (`046b-durable-key-sharpen`) — DONE

The one half-built spot from PRD-046: `memories.key` had a column + a `content` read-fallback but no
generator. Closed by `retrieval-worker-bee`:

- `deriveDurableKey(content)` in `src/daemon/runtime/summaries/key.ts` — a **deterministic** derivation
  (redact-secrets → first sentence → cap), reusing the existing key helpers; no second LLM/gate
  round-trip (a `memories` fact is already a distilled, concise truth). Grounded by construction
  (`isKeyGroundedInText`, sharing a single token-set core with the episodic `isKeyGrounded`).
- Populated on the write path at `src/daemon/runtime/pipeline/controlled-writes.ts` (`buildMemoryRow`),
  covering ADD + version-bumped UPDATE. Additive/heal-safe (column already existed from 046b).
- The prime's durable list now surfaces the **real** key for keyed facts; the `content` fallback still
  serves un-keyed legacy rows.
- Verified independently: `controlled-writes.ts:557` populates it; 53 tests (key 16 + prime-keys 8 +
  controlled-writes 29) pass on a fresh run; `audit:sql` clean. Bee `npm run ci` = 2717 passed.

## 2. Live prime-eval — gate STAYS ADVISORY (honest non-flip)

Goal: run `npm run eval:prime` live and flip the gate from advisory to enforced. **Outcome: did NOT
flip — the live data says it isn't safe to.**

Ran live against `workspace=default` (the only workspace this token can write — `honeycomb_ci` is 403):

| Run | pull-through | search-reduction | beats cold? |
|---|---|---|---|
| run0 | — | — | failed at convergence barrier (eventual-consistency flake) |
| run1 | 1.000 | 2.600 | ✅ true |
| run2 | 0.400 | 1.100 | ✅ true |

**Directional result is solid** — priming beats cold every run (cold pull-through is structurally 0).
**But the magnitude is unstable** — a 0.4↔1.0 pull-through swing, ~12× the ε=0.05 the baseline assumed.

Root cause: the prime digest is assembled from the **whole** workspace, recency-ordered + token-bounded,
so this run's seeded targets compete with everything already in `default` (real memories + the 36
hybrid-benchmark seeds + prior prime-eval seeds); which targets survive the budget shuffles run-to-run.
This is the **same shared-workspace instability PRD-027's recall-eval fixed** with per-run isolation /
relevance-class scoring — which this newer 046f eval lacks. In the fresh per-run `honeycomb_ci`
workspace the eval was designed for, the digest would contain only this run's seeds and pull-through
would be stable ~1.0 — but this token can't reach that workspace.

**Decision:** keep `eval/prime-baseline.json` `placeholder: true` (advisory). Flipping to enforced from
a busy shared workspace would either be meaningless (a floor low enough to never fail) or flap-red.
Recorded the measurement + the path-to-enforce in the baseline `//` notes.

**Follow-up `046f-prime-eval-isolation`:** either run the eval in CI (authorized `honeycomb_ci`, per-run
fresh) and confirm N stable runs before flipping, OR harden the 046f itest to score against a
per-run-scoped digest (mirror recall-eval's two-phase barrier) so it's stable in any workspace.

Note: ~10 synthetic scenario memories were seeded into `default` and left (per the standing
"seed-into-default, leave them" choice); they're run-id-stamped and harmless.
