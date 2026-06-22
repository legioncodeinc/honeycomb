# PRD-047d — Recency dampening

> Status: backlog · Parent: PRD-047 · Wave: W1 · Type: S
> Goal: agent memory goes stale faster than documents. Demote old hits with a multiplicative
> age-decay on the fused score so last week's fact can outrank a six-month-old one — without ever
> DROPPING a durable fact by age.

## Why
`src/daemon/runtime/recall/config.ts` carries a recency dampening knob (the `D-5` stub) that
`recall.ts` never applies. Without it, ranking is age-blind: a stale fact that matches strongly
outranks a fresher, equally-relevant one. For agent memory — where "what did we decide LAST sprint"
matters more than a year-old note — that is the wrong default. A multiplicative dampener fixes the
ordering while keeping old-but-durable facts recallable.

## What (scope)
- Apply an age-decay multiplier to each hit's fused score before final ordering:
  `score' = score × decay(age)`, where `decay` is a smooth function with a TUNED half-life (e.g.
  `0.5 ^ (age_days / half_life_days)`), read from the existing recency config. Never a hard cutoff —
  the oldest row is demoted, not removed.
- Use the row's creation/version timestamp already on the table (no new column); rows without a
  usable timestamp get `decay = 1` (no penalty), never an error.
- Make the half-life a single named, eval-tuned knob (like `RRF_K`), defaulting to OFF-equivalent
  (a very long half-life) until the eval picks a value, so the change is measured before it bites.

## Acceptance criteria
- **d-AC-1 — Newer wins on a tie.** Two equally-relevant hits of different age order newest-first
  under the dampener. Unit-tested with controlled timestamps + scores.
- **d-AC-2 — Nothing dropped by age.** The oldest hit is demoted but still present in the result
  (no age cutoff). Unit-tested.
- **d-AC-3 — Missing timestamp is safe.** A hit with no usable timestamp gets `decay = 1`, never an
  exception. Unit-tested.
- **d-AC-4 — Eval-tuned, non-regressing.** The half-life is chosen on the golden set; recall@5 / MRR
  / nDCG hold at-or-above baseline (recency should help or be neutral on the synthetic set, which is
  age-agnostic — the real win shows in dogfood). Recorded in `reports/`.

## Risks / Out of scope
- **Risk — penalizing durable facts.** Some facts (conventions, schema) stay true for months; an
  aggressive half-life buries them. Mitigated by a conservative, eval-tuned half-life and the
  no-drop guarantee (d-AC-2); a future refinement could exempt a `durable` class.
- **Risk — the golden set is age-agnostic.** The synthetic eval can't fully prove a recency win.
  Mitigated by keeping the dampener conservative + measuring the real effect in dogfood recall.
- **Out of scope — TTL / retention.** Deleting old rows is a storage-lifecycle concern, not recall
  shaping.

## Dependencies
- `src/daemon/runtime/recall/config.ts` (the recency knob — already defined), `recall.ts` (final
  ordering), the row timestamp columns, PRD-047f (the metric instrument).
