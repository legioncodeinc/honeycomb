# PRD-025 — Semantic recall on by default (the `<#>` cosine path ships lit, not dark)

> Status: completed · Owner: `/the-smoker` · Type: M (feature)
> Goal: a fresh `honeycomb login` user gets **hybrid lexical + 768-dim semantic** recall out of the box —
> the daemon installs/enables embeddings as part of normal setup (not an opt-in afterthought), the store
> path actually populates `content_embedding` / `message_embedding`, and recall reaches the `<#>` cosine
> path, with BM25/ILIKE as the *graceful* fallback — not the default.

## Why
Running the real daemon this session, EVERY recall printed `(lexical fallback)`. The product's headline is
"hybrid lexical + 768-dim semantic recall," but semantic ships **OFF by default** and the lexical path is
all anyone gets. Three concrete causes in the live tree:
- **The store path defaults to a no-op embedder.** `src/daemon/runtime/services/embed-client.ts` ships
  `noopEmbedClient` (`async embed() { return null; }`) as the default seam, and `store.ts` /
  `mountMemoriesApi` both default `embed` to it. So every stored row lands with `content_embedding` NULL
  (and captured `sessions` rows with `message_embedding` NULL) — there is no vector to match against.
- **Recall is hard-coded lexical-only.** `src/daemon/runtime/memories/recall.ts` runs only the BM25/ILIKE
  arms (`buildMemoriesArmSql` / `buildMemoryArmSql` / `buildSessionsArmSql`) and returns
  `degraded: true` UNCONDITIONALLY (line 255). The `<#>` cosine engine already exists —
  `vectorSearch` / `buildVectorSearchSql` in `src/daemon/storage/vector.ts` — but `/api/memories/recall`
  never calls it.
- **Enablement is an env afterthought.** The real `DaemonEmbedClient` (already built in 005b, same file)
  only activates when `HONEYCOMB_EMBEDDINGS=true|1` AND the embed daemon at
  `HONEYCOMB_EMBED_URL` (default `http://127.0.0.1:3851`) is reachable. Nothing in `honeycomb login`
  installs the ~600 MB embedding deps, downloads the model, or starts that daemon — so the default-off
  path is the *only* path a real user ever hits.

The user has APPROVED the ~600 MB embedding-deps cost ("nobody will complain"). So the bar is no longer
"can embeddings be turned on" — they can — it is **"embeddings are on for a fresh user, semantic recall is
the default, and lexical is the fallback only when embeddings are genuinely unavailable."**

## What (scope)
Make the daemon do hybrid lexical + semantic recall out of the box. Five coupled pieces:
1. **Default-on enablement + zero-config install.** `honeycomb login` (or first daemon run) installs the
   embedding deps + model and starts/owns the embed daemon, so a fresh user has the `<#>` path without any
   flag. The `HONEYCOMB_EMBEDDINGS` toggle inverts to **on by default** (opt-OUT, not opt-in); an explicit
   off still degrades cleanly.
2. **The store path populates the vector.** Swap the default `embed` seam from `noopEmbedClient` to the real
   `createEmbedAttachment(...)` pair at daemon construction (`mountMemoriesApi`, the capture handler's
   `EmbedAttachment`), so a deliberately-stored memory AND a captured turn land with a real 768-dim
   `FLOAT4[]` embedding (`content_embedding` / `message_embedding`).
3. **Recall reaches the cosine path.** `/api/memories/recall` runs the semantic `<#>` arm (`vectorSearch`)
   when embeddings are available, fusing/ordering it with the lexical arms, and sets `degraded` HONESTLY —
   `false` when the semantic path ran, `true` only on genuine fallback. (The *ranking* of that fusion is
   PRD-027; this PRD's bar is that the semantic arm RUNS and is reflected in `degraded`.)
4. **Embed-daemon lifecycle robustness.** Warmup (first-call latency absorbed, not on the turn path),
   crash recovery (a dead daemon restarts or recall degrades — never hangs), and the Unix-socket/NDJSON
   IPC contract are hardened so the embed daemon is a dependable daemon-owned process, not a flaky sidecar.
5. **The dim invariant holds end-to-end.** `EMBEDDING_DIMS = 768` (`src/daemon/storage/vector.ts`) ↔ the
   schema `FLOAT4[]` columns ↔ the embed daemon's model output stay locked; a non-768 vector is rejected
   to NULL (already enforced in `embed-client.ts` / `assertEmbeddingDim`), never silently written.

## Decisions
- **D-1 — Default-on, not opt-in.** Embeddings are ENABLED by default for a fresh user. `HONEYCOMB_EMBEDDINGS`
  flips to opt-OUT semantics: unset/`true`/`1` → on; an explicit `false`/`0` → off (clean lexical-only). This
  is the inversion of today's `embed-client.ts` `resolveEmbedClientOptions` (which treats unset as off).
- **D-2 — First-run download over bundling the 600 MB (RECOMMENDED), with a bundled-offline escape hatch.**
  Ship the embedding deps as install-time/first-run acquisition (npm `optionalDependencies` + a guarded
  model download on first `login`/daemon start, mirroring the `ensure-tree-sitter` postinstall pattern)
  rather than inflating the published `@deeplake/hivemind` tarball by ~600 MB. Rationale: keeps `npm i`
  fast for everyone, keeps the npm artifact lean (the `files` allowlist + `pack-check` stay green), and the
  cost lands once on the machines that actually run the daemon. Trade-off: a first-run network dependency —
  mitigated by (a) a clear "downloading embedding model (~600 MB, one time)" progress line, (b) a cached
  model dir reused across upgrades, and (c) a documented offline/air-gapped install that pre-stages the
  model. **Open sub-decision** to confirm in 025a: pin model + revision for reproducibility.
- **D-3 — Default-on means default-on-after-first-install, not blocking login.** The model download does NOT
  block the `honeycomb login` completion or the first recall; it warms in the background. Until the daemon is
  warm, recall degrades to lexical and `degraded: true` — the SAME graceful path as "unavailable" (D-4), so
  the user is never blocked, never hung, and never sees an error. First recall after warmup is semantic.
- **D-4 — "Unavailable" degrades to lexical, cleanly and observably.** Genuinely unavailable = embeddings
  explicitly off (D-1), model not yet downloaded/warming (D-3), embed daemon unreachable/crashed, per-call
  timeout (`HONEYCOMB_EMBED_TIMEOUT_MS`, default 5 000 ms), or a wrong-dim/ malformed daemon response. In
  EVERY case recall falls back to the BM25/ILIKE arms and returns `degraded: true`. Recall NEVER throws and
  NEVER hangs on the embed path — the existing `embed-client.ts` null-on-failure contract is the floor; this
  PRD extends it to recall-read parity. `degraded` is the honest, surfaced semantic-vs-lexical signal.
- **D-5 — Reuse the built engine, don't fork.** The `<#>` cosine engine (`vector.ts` `vectorSearch` /
  `buildVectorSearchSql`, scope-filtered, over-fetched, normalized 0..1) and the real `DaemonEmbedClient`
  (`embed-client.ts`) ALREADY EXIST and are individually tested. This PRD WIRES them on by default + makes
  the store path feed them; it adds no new vector SQL and no new embedding client. (Fusion/ranking of the
  semantic + lexical arms is PRD-027, not duplicated here.)
- **D-6 — The daemon owns the embed process.** The embed daemon is started, health-checked, and crash-restarted
  by the Hivemind daemon (warmup off the turn path; a single supervised child over the documented
  Unix-socket/NDJSON IPC), not left to the user to launch. A crashed embed daemon → restart attempt → recall
  degrades meanwhile (D-4), never a stuck recall.

## Acceptance criteria
- **AC-1 — Default-on for a fresh user.** After a clean `honeycomb login` on a machine with no prior config,
  the daemon has embeddings ENABLED with no flag set (D-1). A unit test asserts `resolveEmbedClientOptions`
  treats unset as enabled; a gated check confirms `login` provisions/owns the embed daemon.
- **AC-2 — Stored + captured rows carry a real vector.** A memory stored via `POST /api/memories` AND a
  captured turn land with a non-NULL 768-dim `content_embedding` / `message_embedding` (the default seam is
  the real `createEmbedAttachment`, not `noopEmbedClient`). Proven against a real assembled daemon by reading
  the row back (polling to convergence per the DeepLake eventual-consistency rule).
- **AC-3 — Recall reaches the cosine path and reports it honestly.** With embeddings available,
  `POST /api/memories/recall` runs the `<#>` semantic arm and returns `degraded: false`; with embeddings
  explicitly off (or daemon down), it returns `degraded: true` from the lexical arms. The hard-coded
  `degraded: true` in `recall.ts` (line 255) is gone. Unit-tested on both branches.
- **AC-4 — Semantic beats lexical on a lexical-miss query (the behavioral bar, GATED LIVE ITEST).** A gated
  live itest captures a turn, waits for embedding convergence, then issues a recall query that a pure
  BM25/ILIKE match would MISS (no shared surface tokens — e.g. captured "the build is timing out on the
  pack step," queried "CI keeps failing during publish") and asserts the semantic path SURFACES the captured
  memory while the lexical-only arm does not. This is the proof that semantic recall is real, on, and adding
  recall the lexical path could not. (The query set + metrics that GENERALIZE this are PRD-027's eval harness.)
- **AC-5 — Graceful, non-hanging degrade.** With the embed daemon killed mid-session, recall still answers
  200 with `degraded: true` within the timeout budget (never hangs, never 500s); on daemon
  restart/warmup, a subsequent recall returns `degraded: false`. Proven by a gated live toggle.
- **AC-6 — The dim invariant holds.** `EMBEDDING_DIMS = 768` ↔ schema `FLOAT4[]` ↔ model output stay locked;
  a non-768 / malformed vector is rejected to NULL and the row stays lexically recallable (never a silent
  bad write). Unit-tested (the existing `assertEmbeddingDim` / dim-reject path) + asserted on the live store.
- **AC-7 — Gates green.** `npm run ci` / `build` / `audit:sql` / `audit:openclaw` / invariant stay green; no
  secret/credential in the embed IPC, the model-download logs, or the recall path (grep-proven). The npm
  artifact does NOT balloon by 600 MB (`files` allowlist + `pack-check` confirm the model is acquired, not
  packed — D-2).

## Risks / Out of scope
- **Risk — first-run latency + download size.** ~600 MB + warmup can surprise a fresh user. Mitigated by the
  background-warm posture (D-3), a clear progress line, and a cached model dir. ACCEPTED by the user.
- **Risk — embed daemon flakiness.** A crash loop could keep recall lexical. Mitigated by D-6 supervision +
  the D-4 clean degrade; the embeddings-runtime hardening is in-scope (warmup/crash recovery).
- **Out of scope — recall RANKING / result shaping / the eval harness.** How the semantic + lexical arms are
  *fused and ordered*, how `[memory]` facts outrank raw `[sessions]` dumps, and the golden-set eval that
  *measures* the recall lift — all PRD-027. This PRD's bar is the semantic arm RUNS by default and is proven
  to add recall on a single lexical-miss query (AC-4); PRD-027 generalizes that into a measured, gated bar.
- **Out of scope — swapping the embedding model / changing the dimension.** Stays `nomic-embed-text-v1.5`,
  768-dim. A model/dim change is a separate PRD (it ripples the `FLOAT4[]` schema invariant).
- **Out of scope — hosted/remote inference.** Local embed daemon only; a hosted-inference option is a follow-up.

## Dependencies
- **The embedding runtime** — `src/daemon/runtime/services/embed-client.ts` (the real `DaemonEmbedClient` +
  `createEmbedAttachment`, already built in 005b), the shipped `embeddings/embed-daemon.js`, and the
  `EMBEDDING_DIMS = 768` ↔ `FLOAT4[]` invariant in `src/daemon/storage/vector.ts`. This PRD turns that
  runtime ON by default and makes the store/recall paths feed + read it.
- **The recall + store wiring** — `src/daemon/runtime/memories/{recall.ts,store.ts,api.ts}` (PRD-022a), which
  currently default to the no-op embedder and the lexical-only arms.
- **The store/capture write path** — `src/daemon/runtime/pipeline/controlled-writes.ts` + the capture handler's
  `EmbedAttachment` seam, which must receive the real embedder.
- **PRD-027 (coupled).** PRD-027's recall-eval harness is the VALIDATION INSTRUMENT for this PRD: 025 turns
  semantic on and proves it on one lexical-miss query (AC-4); 027's golden-set eval PROVES the recall lift
  generalizes and GATES regressions. 025 can ship its AC-4 bar independently, but 027 is what keeps it honest.
- **DeepLake eventual consistency.** Every live read-back of an attached embedding must poll to convergence
  (per project memory), never a single immediate read.
