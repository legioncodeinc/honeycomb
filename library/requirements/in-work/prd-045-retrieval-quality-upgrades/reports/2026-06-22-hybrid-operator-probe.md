# PRD-045a — live operator probe (partial decision input)

> Date: 2026-06-22 · Scope: de-risk the native-hybrid premise before the full recall@k A/B.

## What was tested
A throwaway live probe (since deleted) connected to live DeepLake with the developer's
`~/.deeplake/credentials.json` creds and ran `buildHybridArmSql` (the PRD-045a `hybrid-recall.ts`
builder) against the `memories` table with a synthetic unit 768-dim vector — no embed daemon
needed, because the question was OPERATOR AVAILABILITY + SQL VALIDITY, not recall quality.

## Result
- **Connectivity: OK.** `SELECT COUNT(*) FROM "memories"` returned `kind=ok` (n=1 in the resolved
  workspace). The file creds + endpoint + workspace resolve and the storage client connects.
- **`deeplake_hybrid_record` EXISTS and EXECUTED: OK.** The native hybrid statement
  (`(content_embedding, content)::deeplake_hybrid_record <#> deeplake_hybrid_record(<vec>, <text>,
  0.5, 0.5)`) returned `kind=ok`, `rows=0`. The operator is available on this backend and the SQL
  the slice emits is valid against the real engine. `rows=0` is expected: embeddings are disabled
  on this machine (`~/.deeplake/config.json` → `embeddings.enabled:false`), so the lone memory has
  a null `content_embedding` and is excluded by the `ARRAY_LENGTH(content_embedding,1) > 0` guard.

## Verdict (partial)
The biggest unknown behind PRD-045a — "does the native operator even exist / does our SQL run on
the live engine?" — is **answered YES**. The native-hybrid path is viable; adoption now hinges
purely on the recall@k / MRR comparison vs RRF.

## What's still required for the full A/B (a-AC-1 / a-AC-3)
The head-to-head recall@k numbers need BOTH, neither present on this machine:
1. **The embed daemon up** with `nomic-embed-text-v1.5` — the model is NOT cached here and
   embeddings are disabled, so this is a ~600 MB download + warmup (`ensure:embed-deps` then the
   embed supervisor), not a flip of a switch.
2. **A throwaway workspace to seed** — the benchmark seeds ~36 synthetic golden memories and polls
   to embedding convergence. Seeding into the developer's REAL workspace would pollute live memory;
   it should target `honeycomb_ci` (if the token authorizes it) or a disposable workspace.

Run, once both are in place:
`HONEYCOMB_EMBEDDINGS=true npm run bench:hybrid` (with the `HONEYCOMB_DEEPLAKE_*` creds loaded).
