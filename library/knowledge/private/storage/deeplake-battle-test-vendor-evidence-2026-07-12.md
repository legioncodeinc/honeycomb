# Deeplake Battle-Test — Vendor-Side Evidence (2026-07-12)

> **Scope:** A fresh series of live battle tests against the Deeplake backend
> (Activeloop hosted, `https://api.deeplake.ai`, org `****eda2`, workspace
> `honeycomb`), run to answer one question: when the memory loop stalls, is it
> **our** code or **their** backend? **Verdict: it is them.** Every functional
> operation that *completes* returns `200 OK`; the failures are backend latency
> and timeouts, not our logic. Details, method, and reproduction below.

---

## 1. TL;DR

- **A single-row indexed read** (the exact BUG-04 dedup-probe shape,
  `SELECT id FROM "<t>" WHERE content_hash = '…' LIMIT 1`) takes **p50 ≈ 0.54 s,
  p95 ≈ 0.8–1.6 s**, worst observed **3.65 s** — against a throwaway table
  holding a handful of dummy rows. A healthy indexed point-lookup is single-digit
  milliseconds.
- **Building the index** (`CREATE TABLE … USING deeplake`) takes **6.7 – 9.7 s
  every time**. This is "the index that takes forever."
- **Under trivial concurrency the backend collapses.** At 16 concurrent reads,
  **10 of 16 requests timed out at 30 s** in one window. At 8 concurrent, p95
  blew out to **4.2 – 4.6 s** (no timeouts). At 4 concurrent, the stress harness
  measured a **20 % error rate** and **p95 ≈ 6 s**.
- **It is intermittent.** The *identical* 16-way read burst completed at
  p95 7.1 s in one run and had a 63 % timeout rate a few minutes later — the
  textbook "degraded window" that BUG-04 is about.
- **A full 1/4/8/16 concurrency sweep could not finish inside 60 s** — the
  harness is fine; the backend cannot service the load in time.
- **Zero of the failures were ours.** When we sent well-formed SQL, the only
  non-`200` outcomes were `timeout` (transient backend saturation). The single
  non-backend error we saw during setup was a bug *in our probe* (referencing a
  non-existent column) — it returned a **`400`**, which our classifier correctly
  treats as a genuine, non-transient fault. That contrast is itself the proof
  that the "them vs us" discriminator works.

---

## 2. Method — how we separate "them" from "us"

Two independent instruments, both driving the **real** backend:

1. **The stress harness** (`npm run deeplake:stress` →
   `tests/integration/deeplake-stress-live.itest.ts`). Drives append bursts,
   immediate read-backs, version-seeding, and a concurrency sweep through the
   **production storage client** (with its retry + classification), wrapped in a
   `RecordingTransport` that captures every raw per-attempt outcome. Emits
   latency percentiles, error-by-status, eventual-consistency convergence, and
   throughput-vs-concurrency to a JSON artifact.

2. **A raw-transport probe** (`scripts/deeplake-probe.mjs`, added for this
   investigation). Talks to `HttpDeepLakeTransport` **directly — no retry, no
   result shaping** — so we see the backend's **true per-attempt HTTP status and
   latency**, not what our client makes of it. This is the instrument that
   settles the argument: it records the actual status code (`200` / `400` /
   `429` / `5xx` / `timeout`) for each attempt.

**The discriminator.** Our client's `isTransientResult` splits failures into two
classes:

- **"Them" (transient):** `429`, `5xx`, connection drops, and **timeouts** —
  the backend faulted or was too slow. These are retried and (post PRD-079/080)
  routed to the durable outbox.
- **"Us" (genuine):** `400` syntax, `401/403` permission, `42P01` missing-table —
  a request *we* built wrong. These are thrown, never silently retried.

So the test is simple: **classify every non-`200` outcome by its real status.**
If they cluster in the transient class, it is them. They did.

**Isolation & secret-safety.** Every table is a throwaway `ci_stress_*` /
`ci_probe_*` containing **only dummy data** (no user content), DROPped on
teardown. The probe redacts the token and any long hex run defensively; because
the payloads are dummy, the error bodies carry nothing sensitive. Runs targeted
the `honeycomb` workspace the credential is scoped for — the same org/endpoint
the fleet daemon uses, so backend health is measured exactly as production sees
it.

---

## 3. Evidence

### 3.1 Baseline latency — slow even at concurrency 1

Raw-transport probe, single-row ops against a fresh indexed table (4 rounds):

| Operation | p50 | p95 | max | success |
|---|---|---|---|---|
| `CREATE TABLE … USING deeplake` (index build) | **7.1 s** | — | **9.7 s** | 4/4 |
| Single-row `INSERT` (sequential) | **≈ 0.54 s** | 0.6 – 1.6 s | **4.2 s** | 70/70 |
| Single-row `SELECT` dedup-probe (sequential) | **≈ 0.55 s** | 0.8 – 1.6 s | **3.65 s** | 100/100 |
| `DROP TABLE` | **≈ 6.4 s** | — | **60 s (timeout)** | 3/4 |

Every completed operation returned `200`. There is no correctness defect here —
the backend simply takes **half a second to multiple seconds** to service a
single-row indexed operation, and **6–10 seconds** for schema/index DDL.

### 3.2 The index that takes forever

`CREATE TABLE … USING deeplake` (which builds the Deeplake index) timing across
runs: **6727 ms, 7385 ms, 9711 ms, 7108 ms** (probe) and **p50 5973 ms /
max 7400 ms** (stress harness, measured as the `other`/DDL statement class).
`DROP TABLE` is the same order of magnitude (≈ 6 s, one 60 s timeout). This is
inherent backend cost — nothing in our code path executes during a `CREATE
TABLE` round-trip except the `await`.

### 3.3 Saturation under trivial concurrency

| Concurrency | p95 latency | Error rate | Notes |
|---|---|---|---|
| 1 (sequential) | 1.0 – 1.6 s | 0 % | baseline |
| 4 | **≈ 6.0 s** | **20 %** | stress harness, `battle_cal2` |
| 8 | **4.2 – 4.6 s** | 0 % | probe rounds 3–4 |
| 16 | **30 s (timeout)** | **63 %** | probe round 2 — 10 of 16 requests aborted at the 30 s ceiling |

Throughput measured **1.4 – 3.0 ops/s**. The backend degrades non-linearly:
doubling concurrency past ~8 does not slow it down, it **falls over** into
30-second hangs.

### 3.4 Intermittency — the degraded window, reproduced

The same 16-way concurrent read burst:

- **Round 1:** all 16 completed, p95 = **7108 ms**.
- **Round 2** (minutes later): **10 of 16 timed out at 30 s**, p50 = 30011 ms.

Identical client, identical SQL, identical table shape — the only variable is
*which backend window we hit*. This is precisely the intermittent degradation
BUG-04 documented (101 controlled-write jobs × 5 attempts = 505 stage failures
during degraded windows), now reproduced on demand.

### 3.5 The full sweep can't finish in a minute

The heavy round (`concurrency=1,4,8,16 ops=40 versions=5`) **exceeded the 60 s
harness ceiling and was killed mid-run** ("Test timed out in 60000ms"). The
harness did not error — the backend could not service four indexed-table
lifecycles plus their read/write/version load inside 60 seconds. A slow backend
is data, and the data is: it is very slow.

---

## 4. The one "us" artifact we found — and why it strengthens the verdict

During probe setup, an early round showed a **38.5 % error rate** — alarming
until we read the actual messages:

```
400: {"error":"Column does not exist: column \"org\" of relation \"ci_probe_…\" does not exist","code":"INVALID_REQUEST"}
```

That was **our bug**: the probe's `INSERT` named `org`/`workspace` columns, which
do not exist on the `memories` shape (org/workspace are partition **headers**,
not columns). We fixed the probe and re-ran. Two things this proves:

1. **Honesty of the instrument.** The raw-transport probe surfaces *our* mistakes
   just as loudly as the backend's — a `400` for a bad column is unmistakable.
2. **The classifier is correct.** That `400` is a *non-transient* status. Our
   `isTransientResult` gate would (and does) classify it as **genuine → throw**,
   never route it to the retry/outbox path. Contrast the backend's `timeout`s,
   which classify as **transient → retry/defer**. The two failure modes are
   cleanly distinguishable, and only the backend's lands in the "them" bucket.

After the fix, **every remaining non-`200` outcome was a `timeout`** — 100 %
backend, 0 % us.

---

## 5. Mapping to BUG-04 and what we shipped

BUG-04's live symptom was the `memory_controlled_write` dedup probe intermittently
failing, retrying 5×, then dropping the distilled memory. This battle test
reproduces the mechanism directly: that dedup probe is a single-row indexed
`SELECT`, and §3.1/§3.4 show it runs at **0.5–3.6 s and intermittently times
out** on this backend. The failure is Deeplake latency/availability, not our
query, scope, or classification (all three were independently verified correct in
the BUG-04a investigation, PR #293).

Because we cannot fix the vendor, we insulated the memory loop from it on all
three axes:

- **Recall** — tolerant fallback (PRD-077/078).
- **Capture** — durable retry outbox (PRD-079).
- **Formation** — durable controlled-write outbox (PRD-080), which defers a
  transient-failed write to local SQLite and replays it when the backend
  recovers, so a memory formed during one of these degraded windows is **not
  lost**.

The battle test is the empirical justification for that architecture: the backend
*will* have these windows, so the client *must* survive them.

---

## 6. Reproduction

```bash
cd honeycomb
set -a; . ./.env.local; set +a          # load the gitignored live creds

# (a) Production-path stress harness → JSON artifact under .stress-report/
HONEYCOMB_STRESS_CONCURRENCY=1,4 HONEYCOMB_STRESS_OPS=10 npm run deeplake:stress

# (b) Raw-transport probe → true per-attempt status + latency histogram
PROBE_RUN_ID=repro PROBE_INSERTS=30 PROBE_CONCURRENCY=16 node scripts/deeplake-probe.mjs
```

Both are on-demand only, gated on `HONEYCOMB_DEEPLAKE_TOKEN`, and touch only
throwaway `ci_*` tables.

---

## 7. Raw data

- Stress JSON: `.stress-report/battle_cal2.json` (c=1,4 run),
  `.stress-report/battle_r1_heavy.log` (the 60 s DNF sweep).
- Probe stdout: rounds `battle_probe1`..`battle_probe4` (see §3 tables).
- Backend: `https://api.deeplake.ai`, org `****eda2`, workspace `honeycomb`.
- Client build: `dist/` @ honeycomb `v0.12.2`; daemon under test reported
  `v0.9.0` (installed fleet daemon).

> **Bottom line:** the storage layer's correctness is intact and its failures are
> classified honestly. The stalls, timeouts, and multi-second point-lookups
> originate at the Deeplake backend. **It's a them problem, not an us problem** —
> and the outbox architecture (PRD-079/080) is what makes the product survive it.
