# Deeplake — Performance & Reliability Report

**To:** Deeplake / Activeloop engineering & customer success
**From:** Honeycomb (agent-memory platform) — storage integration team
**Date:** 2026-07-12
**Endpoint under test:** `https://api.deeplake.ai`
**Org:** `****eda2` (redacted) · **Workspace:** `honeycomb`
**Re:** Latency, concurrency, and availability issues degrading a production workload — findings and requested improvements

---

## 1. Executive summary

We run an agent-memory product on Deeplake as the primary datastore. Our workload
is deliberately modest — small single-row writes and **indexed single-row point
lookups**, at low-to-moderate concurrency. Over a fresh, controlled battle-test
series we measured behavior that is **functionally correct but operationally too
slow and too fragile for an interactive workload**:

- Indexed single-row point lookups take **0.5–3.6 seconds** (should be
  single-digit milliseconds).
- Building an index (`CREATE TABLE … USING deeplake`) takes **6.7–9.7 seconds**.
- At **16 concurrent reads the backend collapses** — 10 of 16 requests hung until
  our 30 s client timeout aborted them.
- The degradation is **intermittent**: the identical request burst completed in
  ~7 s in one window and had a **63 % timeout rate** minutes later, with no
  signal from the API that the backend was under stress.
- Throughput topped out at **1.4–3.0 operations/second**.

None of this is a data-correctness problem — every request that *completed*
returned `200 OK`. It is a **latency, concurrency-scaling, and availability**
problem. This report documents the measurements and lists, in priority order,
what we need Deeplake to improve.

---

## 2. Our workload profile (so the numbers have context)

| Attribute | Value |
|---|---|
| Dominant read | Indexed single-row lookup: `SELECT id FROM "t" WHERE content_hash = '…' LIMIT 1` |
| Dominant write | Single-row `INSERT` (append-only, version-bumped) |
| Row size | Small (short text + a 768-dim `FLOAT4[]` embedding) |
| Concurrency | Low-to-moderate (single-digit to low-double-digit concurrent statements) |
| Latency expectation | Interactive — this sits in an agent's request path |
| Table lifecycle | Long-lived tables; occasional `CREATE TABLE … USING deeplake` |

This is a mainstream OLTP-style access pattern. It is not analytical, not
high-cardinality scan, not bulk. The performance below is measured against that
modest profile.

---

## 3. Findings (measured)

All figures are from live runs on 2026-07-12 against throwaway tables holding a
handful of dummy rows. Two instruments were used: our production client (with
retry) and a **raw HTTP probe with no retry**, so the numbers reflect the
backend's true per-attempt behavior.

### F1 — Indexed point lookups are 100–1000× slower than expected · **High**

A single-row lookup on an indexed column (`content_hash`), against a table with a
few dozen rows:

| | p50 | p95 | max |
|---|---|---|---|
| `SELECT … WHERE content_hash = '…' LIMIT 1` | **≈ 0.55 s** | 0.8–1.6 s | **3.65 s** |
| Single-row `INSERT` | **≈ 0.54 s** | 0.6–1.6 s | **4.2 s** |

**Impact:** every memory read/write in our product inherits a half-second-plus
floor. This is the single biggest drag on end-to-end latency.
**Ask:** bring warm indexed point-lookup p50 into the **low tens of milliseconds**
and p99 under **250 ms**. Publish the expected latency envelope for an indexed
`WHERE col = … LIMIT 1` so we can hold you to it.

### F2 — Index build (`CREATE TABLE … USING deeplake`) takes 6.7–9.7 s · **Medium**

Measured across four runs: **6727 ms, 7385 ms, 9711 ms, 7108 ms**. `DROP TABLE`
is the same order of magnitude (~6 s; one run hit our 60 s timeout).

**Impact:** schema/index operations block provisioning and migrations for
seconds-to-tens-of-seconds each; a multi-table setup routinely exceeds a 60 s
budget (see F3).
**Ask:** either reduce synchronous index-build time by an order of magnitude, or
make `CREATE … USING deeplake` **asynchronous with a queryable build-status**, so
callers are not blocked on a 7–10 s round trip. Make `DROP TABLE` idempotent and
fast.

### F3 — No graceful degradation under trivial concurrency · **High**

Latency and error rate as concurrency rises (same single-row read):

| Concurrency | p95 latency | Error rate |
|---|---|---|
| 1 | 1.0–1.6 s | 0 % |
| 4 | **≈ 6.0 s** | **20 %** |
| 8 | 4.2–4.6 s | 0 % |
| 16 | **30 s (client timeout)** | **63 %** (10/16 requests hung) |

Throughput measured **1.4–3.0 ops/s**. Past ~8 concurrent statements the backend
does not slow down gracefully — it **stops responding** until the client aborts.
A full 1/4/8/16 concurrency sweep **could not complete within 60 seconds**.

**Impact:** we cannot safely raise parallelism; a small burst of legitimate
traffic produces cascading multi-second hangs and timeouts.
**Ask:** provide **graceful degradation and backpressure** (see F4), publish a
documented per-org/workspace concurrency limit, and ensure throughput scales — or
at least plateaus — rather than collapsing beyond a handful of concurrent
statements.

### F4 — Overload manifests as silent hangs, not backpressure · **High**

When the backend is saturated it does **not** return `429 Too Many Requests` or
any fast rejection — requests simply **hang until the client's timeout fires**
(we observed 30 s and 60 s aborts). There is no `Retry-After`, no queue-depth
signal, nothing that lets a well-behaved client back off.

**Impact:** clients cannot distinguish "slow" from "stuck," so they burn their
full timeout budget on every overloaded request, amplifying the incident.
**Ask:** under load, **fail fast with `429` + `Retry-After`** (or `503` with
backpressure semantics) instead of hanging. This single change would let every
client implement correct exponential backoff and would convert a cascading
outage into an orderly slowdown.

### F5 — Intermittent degraded windows with zero transparency · **High**

The **identical** 16-way read burst:

- One run: all 16 completed, p95 = **7.1 s**.
- A few minutes later: **10 of 16 timed out at 30 s** (p50 = 30 s).

Same client, same SQL, same table. The only variable was **which backend window
we hit** — and nothing in the API, headers, or any status surface told us the
backend was degraded during the bad window.

**Impact:** these windows are exactly when our writes fail; without a signal we
cannot correlate, alert, or route around them, and we cannot tell our users
whether the problem is us or the platform.
**Ask:** (a) a **public status page / health API** that reflects real per-region
(and ideally per-org) degradation; (b) proactive notification for sustained
degraded windows; (c) a per-response **server-timing / queue-time header** so
clients can observe backend latency vs. network latency in real time.

### F6 — Error and API ergonomics · **Low/Medium**

Positives worth keeping: error bodies are JSON, include a `code`
(`INVALID_REQUEST`) and a **`request_id`** — the `request_id` is genuinely useful
for support correlation, thank you. Gaps:

- **Timeouts carry no status** (the request just aborts). A structured
  `503`/`504` with `request_id` would make them traceable like other errors.
- **`DROP TABLE` on a non-existent table returns `400 INVALID_REQUEST`** rather
  than a no-op or `404`; `DROP TABLE IF EXISTS` semantics would make teardown
  idempotent.
- **No documented retryability signal.** We currently infer "retryable" from HTTP
  status (`429`/`5xx`/timeout = transient; `400`/`401`/`403` = terminal). Please
  **document which conditions are safe to retry**, ideally with a machine-readable
  `retryable: true|false` field, so every customer classifies consistently.

**Ask:** structured status on timeouts, `IF EXISTS` DDL semantics, and a
documented/emitted retryability signal.

### F7 — Eventual consistency (informational) · **OK, but document it**

Write→read convergence sampled **clean in these runs** (writes were visible on
the immediate read-back, 0 % non-convergence). We are not reporting a defect
here — but we **do** design around the possibility of read-after-write lag.
**Ask:** publish the consistency model and any convergence bound for
`USING deeplake` tables so customers can design correctly instead of guessing.

---

## 4. Prioritized asks

1. **(F1) Indexed point-lookup latency** → p50 in the low-tens-of-ms, p99 < 250 ms; publish the envelope.
2. **(F4) Fail-fast backpressure** → `429` + `Retry-After` under load instead of hanging.
3. **(F3) Concurrency scaling** → documented limits + graceful degradation; no collapse past ~8 concurrent statements.
4. **(F5) Transparency** → status page/health API, degraded-window notifications, server-timing headers.
5. **(F2) Index/DDL cost** → async index build with status, or ~10× faster; idempotent fast `DROP`.
6. **(F6) Error/retry semantics** → structured timeout status, `IF EXISTS`, documented/emitted retryability.
7. **(F7) Consistency** → publish the model and convergence bound.

We would value **published SLOs** (latency percentiles, availability, and a
concurrency envelope) for the hosted API so we can plan capacity and set honest
expectations with our own users.

---

## 5. How to reproduce

Our harness is self-contained and hits only throwaway tables:

```bash
# (a) Concurrency sweep with per-status/percentile report
HONEYCOMB_STRESS_CONCURRENCY=1,4,8,16 HONEYCOMB_STRESS_OPS=40 npm run deeplake:stress

# (b) Raw single-attempt probe (no client retry) — true backend status + latency
PROBE_INSERTS=30 PROBE_CONCURRENCY=16 node scripts/deeplake-probe.mjs
```

Each run creates throwaway `ci_*` tables and drops them on teardown. We are happy
to share raw JSON artifacts, `request_id`s from the degraded windows, and exact
timestamps to help you correlate against server-side traces — just tell us the
best channel.

---

## 6. Bottom line

Deeplake is returning **correct results** — our issue is purely **performance and
availability**. For an interactive agent-memory workload, sub-second point
lookups, collapse under mild concurrency, silent overload hangs, and opaque
degraded windows are the blockers. The highest-leverage fixes are **fail-fast
backpressure (F4)** and **point-lookup latency (F1)**; together with basic
**operational transparency (F5)** they would move this from "we engineer around
the platform" to "the platform carries the workload." We are glad to partner on
reproduction and validation.
