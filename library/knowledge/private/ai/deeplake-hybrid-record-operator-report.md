# DeepLake `deeplake_hybrid_record` — zero-score report

> Category: Ai | Version: 1.1 | Date: June 2026 | Status: RESOLVED (fixed by DeepLake, verified 2026-06-24) | Audience: Activeloop / DeepLake engineering

> **✅ RESOLVED 2026-06-24.** DeepLake has fixed the operator. A re-run of the same benchmark
> (`npm run bench:hybrid`, live) shows `deeplake_hybrid_record` now returns real, varying,
> **weight-sensitive** scores and ranks at parity with our post-query RRF (recall@5 0.611 vs 0.611,
> MRR 0.589 vs 0.593) — the constant-zero degeneracy described below is gone. This report is retained
> as the historical root-cause record. Honeycomb still keeps RRF as the default (parity, not a win)
> per [ADR-0001](../architecture/adr/0001-retrieval-fusion-rrf-vs-native-hybrid.md); the operator is
> now a viable candidate to revisit. See the re-run section of the
> [benchmark decision report](../../../requirements/completed/prd-047-retrieval-quality-upgrades/reports/2026-06-22-hybrid-benchmark-decision.md).

A technical report for DeepLake on the `deeplake_hybrid_record` hybrid-search operator returning a
constant `0` score for every row on our managed dataset. Every statement below is a directly
observed result from runs against the live endpoint on 2026-06-22. Vectors are abbreviated for
readability; the real query vectors were 768-dim `nomic-embed-text-v1.5` embeddings.

**Related:** [`retrieval.md`](retrieval.md) · [`../data/deeplake-storage.md`](../data/deeplake-storage.md)

---

## Summary

The `deeplake_hybrid_record` operator **parses and executes without error** (`kind=ok`) on our
`memories` table, but **returns `score = 0.000000` for every row**, regardless of vector-literal
format or weight split. As a result, `ORDER BY score DESC` produces an arbitrary ordering. On the
same table and the same `content_embedding` column, the plain `<#>` vector operator returns correct,
varying similarity scores — so the embeddings are present, 768-dim, and queryable. The hybrid
operator is the only component producing degenerate output.

---

## Environment (observed)

- **Endpoint:** DeepLake managed SQL HTTP API at `api.deeplake.ai` (the parameterless query
  endpoint; values are escaped and interpolated client-side).
- **Dataset:** a `USING deeplake` dataset; the table under test is `memories`.
- **Embedding model:** `nomic-ai/nomic-embed-text-v1.5`, 768-dim, stored as `FLOAT4[]`.
- **DeepLake docs referenced:** `https://docs.deeplake.ai/4.6/examples/hybrid-rag/` and
  `https://docs.deeplake.ai/4.6/examples/agent-memory` (both show the operator with no
  index-creation step).

## Schema under test (`memories`, relevant columns)

```sql
-- created with USING deeplake
id                TEXT NOT NULL DEFAULT ''
content           TEXT NOT NULL DEFAULT ''
content_embedding FLOAT4[]            -- nullable, 768-dim (no dedicated index created)
is_deleted        BIGINT NOT NULL DEFAULT 0
```

We did **not** create a dedicated BM25/full-text index on `content` or a vector index on
`content_embedding` prior to issuing the hybrid query. The `content_embedding` column is a plain
nullable `FLOAT4[]`. The documented examples (4.6 hybrid-rag, agent-memory) likewise show no
index-creation step.

---

## What works: the plain `<#>` vector operator (baseline)

Query text: `"how do we refresh the auth token"`.

```sql
SELECT id AS id,
       ((1 + (content_embedding <#> ARRAY[/* 768 float4 */]::float4[])) / 2) AS score
FROM "memories"
WHERE ARRAY_LENGTH(content_embedding, 1) > 0
ORDER BY score DESC
LIMIT 15;
```

**Observed top scores:** `0.7933, 0.7929, 0.7921, 0.7898, 0.7886, …` — varying, correctly ordered.
This confirms the embeddings are stored, 768-dim, non-null, and semantically queryable on this
column.

---

## What fails: `deeplake_hybrid_record`

Query text: `"the build is timing out on the pack step"` (chosen because it is an **exact substring**
of one stored `content` value, so the BM25/text half should match it strongly).

```sql
SELECT id AS id,
       ((content_embedding, content)::deeplake_hybrid_record
          <#> deeplake_hybrid_record('{/* 768 float4 */}'::float4[],
                                      'the build is timing out on the pack step',
                                      0.5, 0.5)) AS score
FROM "memories"
WHERE ARRAY_LENGTH(content_embedding, 1) > 0
ORDER BY score DESC
LIMIT 5;
```

**Observed:** `kind=ok`, 5 rows, **all `score = 0.000000`.**

### Isolation matrix (same query, same warm dataset)

| # | Vector literal form | Weights (vector / text) | Result |
|---|---|---|---|
| A | `ARRAY[…]::float4[]` | 0.5 / 0.5 | all rows `0.000000` |
| B | `'{…}'::float4[]` (the form in DeepLake's docs) | 0.5 / 0.5 | all rows `0.000000` |
| C | `'{…}'::float4[]` | 1.0 / 0.0 (vector only) | all rows `0.000000` |
| D | `'{…}'::float4[]` | 0.0 / 1.0 (text only) | all rows `0.000000` |
| E | `ARRAY[…]::float4[]` | 1.0 / 0.0 (vector only) | all rows `0.000000` |

This rules out the candidate causes we could test client-side:
- **Not the vector-literal format.** The documented `'{…}'::float4[]` string form (B/C/D) returns
  the same all-zero result as the `ARRAY[…]::float4[]` form (A/E).
- **Not the weight split.** Balanced (A/B), vector-only (C/E), and text-only (D) all return `0`.
- **The text half also returns 0** for a query that is an exact substring of a stored `content`
  value (D), so the BM25/keyword component is not scoring either.

---

## Downstream impact (measured)

We A/B-tested this operator against our own post-query Reciprocal-Rank-Fusion over the same `<#>`
vector arm, on a 36-pair labeled recall set (live, embeddings on, reads polled to convergence):

| Path | recall@1 | recall@5 | MRR |
|---|---|---|---|
| RRF over the `<#>` arm (our current) | 0.583–0.611 | 0.722–0.778 | 0.644–0.664 |
| `deeplake_hybrid_record` (0.5/0.5) | 0.028 | 0.139 | 0.081 |
| `deeplake_hybrid_record` (0.9/0.1) | 0.028 | 0.167 | 0.083 |

`recall@1 = 0.028 ≈ 1/36`, i.e. ordering uncorrelated with relevance — the expected consequence of a
constant `0` score under `ORDER BY score DESC`.

---

## Open questions / requested actions for DeepLake

We have not been able to determine the cause from the client side. Grounded in the observations
above, the questions that would let us resolve or close this:

1. **Is a pre-created index a prerequisite?** Does `deeplake_hybrid_record` require a BM25/full-text
   index on the text column and/or a vector index on the embedding column before it returns non-zero
   scores? The 4.6 hybrid-rag and agent-memory examples show no index-creation step. If an index is
   required, please document the exact DDL.
2. **Silent zero vs. error.** Independent of the root cause, when the operator's prerequisites are
   unmet it currently returns `kind=ok` with an all-zero score rather than an error or warning. We
   recommend the operator **fail loudly (error or documented warning) instead of returning a silent
   all-zero ranking**, so callers cannot ship a silently degraded result.
3. **Availability on a standard `USING deeplake` dataset.** The operator parses and executes (no
   error), so it appears registered. Please confirm it is fully functional on a dataset created via
   ordinary `USING deeplake` DDL (our `memories` table), versus requiring a specific ingestion or
   dataset type.
4. **Column-type contract.** Does the composite cast `(embedding, content)::deeplake_hybrid_record`
   require the embedding column to be a dedicated vector type (vs. our plain `FLOAT4[]`) or the text
   column to be of a specific/indexed type? The plain `<#>` operator works on our `FLOAT4[]` column;
   please confirm hybrid's requirements.
5. **A minimal end-to-end example.** A runnable sequence — `CREATE TABLE … USING deeplake` → any
   required index DDL → `INSERT` with an embedding → the hybrid query returning **non-zero, ordered**
   scores — that we can diff against our setup.
6. **Score semantics.** Confirm whether the operator yields a similarity (`ORDER BY … DESC`) or a
   distance (`ASC`), and the value range. (Currently moot while every score is `0`, but needed for
   correct adoption.)

---

## Minimal reproduction

1. A `USING deeplake` table with `content TEXT` and a nullable 768-dim `content_embedding FLOAT4[]`,
   with ≥1 row whose `content_embedding` is a real 768-dim embedding and whose `content` contains a
   known phrase.
2. Embed a query string to a 768-dim vector.
3. Run the hybrid query (variant B above), `ORDER BY score DESC LIMIT 5`.
4. **Observed:** every returned row has `score = 0.000000`. **Expected:** non-zero scores that vary
   by row and rank the phrase-matching / semantically-near rows highest.
5. Control: the plain `<#>` query in the "What works" section returns varying `~0.79` scores on the
   same column, confirming the data and embeddings are valid.
