# Memory-pipeline conventions (PRD-006 scaffold seam) — READ BEFORE FILLING A STUB

Wave 1 (`typescript-node-worker-bee`) built the **shared pipeline scaffold**: the
config flags, the `ModelClient` seam, the cross-stage **contracts**
(`Fact` / `EntityTriple` / `Proposal`), the **stage-worker harness**, the job-type
routing, and the **fully-implemented extraction stage (006a)**. It pre-wired
**four stage stubs** (006b/c/d/e) so each Wave-2 Bee fills **only its own stage
module + its own test file** with **zero contention** on the scaffold or any
sibling stub — the same pattern that kept PRD-003/004/005's parallel waves clean.

The whole point: **the worker already imports, routes, and runs your stage.** You
swap your stub's body for the real impl in your module and register your real deps
through `createPipelineHandlers`. You never edit `stage-worker.ts`, `contracts.ts`,
`config.ts`, `model-client.ts`, `extraction.ts`, `handlers.ts`, or another stage's
stub.

---

## 0. The cross-stage contracts (fixed — code against these, do not change them)

From `contracts.ts` (zod schemas + inferred TS types + drop-invalid helpers):

```ts
// Fact — extraction output → decision input (006a → 006b)
interface Fact { content: string; type: string; confidence: number /* 0..1 */ }

// EntityTriple — extraction output → graph input (006a → 006d)
interface EntityTriple { source: string; relationship: string; target: string }

// Proposal — decision output → controlled-writes input (006b → 006c); the
// memory_history payload shape. Wire JSON key `target_id` maps to TS `targetId`.
type ProposalAction = "add" | "update" | "delete" | "none";
interface Proposal { action: ProposalAction; targetId?: string; confidence: number; reason: string }

// ExtractionResult — what extraction (006a) produces for the decision stage.
interface ExtractionResult { facts: Fact[]; entities: EntityTriple[]; droppedCount: number }
```

Drop-invalid helpers (a-AC-4 / FR-8 — NEVER `.parse()`-throw on a model field):
`parseFact(x) → Fact | null`, `parseEntityTriple(x) → EntityTriple | null`,
`parseProposal(x) → Proposal | null`. Use these at every model/JSON boundary; drop
the `null`s with a warning, keep the valid items, never fail the whole job.

If you believe a contract field is missing, **flag it** — do not edit `contracts.ts`
mid-wave (it is shared by all four of you). A contract change is a Wave-1 amendment.

---

## 1. The `ModelClient` seam (the router is NOT built — PRD-010)

From `model-client.ts`. Stages that need an LLM call ONE typed seam:

```ts
interface ModelClient {
  complete(workload: ModelWorkload, prompt: string): Promise<string>; // raw text back
}
type ModelWorkload = "memory_extraction" | "memory_decision";
```

- The stage names the **workload**; the router (later) maps it to a provider+model.
  Your stage holds **no** provider knowledge (006a FR-3).
- `complete` returns the **raw** model string — you strip CoT / parse / validate
  yourself (see extraction.ts for the reference defensive parser).
- Tests: inject `createFakeModelClient({ memory_decision: '<canned JSON>' })`. It
  records `.calls` so you can assert the model WAS / WAS NOT called (e.g. 006b
  b-AC-2: no-candidate short-circuit makes NO model call → assert `model.calls`
  is empty).
- Default is `noopModelClient` (returns `""`). 006c/006d/006e do not call the model.

---

## 2. The stage-handler signature + how a stage is registered

From `stage-worker.ts`. A stage is a `StageHandler`:

```ts
type StageHandler = (job: StageJob) => Promise<void>;

interface StageJob {
  id: string;
  kind: PipelineJobKind;            // your stage's kind
  attempt: number;                  // 1-based run number (queue attempt)
  scope: { org: string; workspace: string; agentId: string }; // 006a FR-10 tenancy
  payload: Record<string, unknown>; // your stage's input (you interpret the shape)
}
```

- A handler **returns** on success; the worker then calls `queue.complete(id)`.
- A handler **throws** to fail the job; the worker routes the throw to
  `queue.fail(id, message)` (the queue applies backoff and, at max attempts,
  `dead`). **Exception — graph persistence (006d) must NOT throw**: a graph failure
  is non-fatal (d-AC-3), so 006d catches its own storage errors, logs, and returns.
- A handler **never** touches the queue — completion/failure is the harness's job.
- The five job kinds (`memory_jobs.type` discriminator): `memory_extraction`,
  `memory_decision`, `memory_controlled_write`, `memory_graph_persist`,
  `memory_retention`. Your stub already owns its kind.

**Registration** is in `handlers.ts` via `createPipelineHandlers(deps)`. Wave 1
already routes all five kinds (extraction filled, your four as stubs). You fill the
body of your `create<Stage>Handler(deps)` factory and **widen your stub's
`<Stage>HandlerDeps`** to carry your real deps (storage/scope/model/config/embed).
The map's shape in `handlers.ts` does not change — only your factory's body + deps.

To wire your real deps into the worker in YOUR test:

```ts
const handlers = createPipelineHandlers({
  extraction: { config, model },                 // Wave-1 default
  decision:   { /* your widened deps */ },        // your stage
});
const worker = createStageWorker({ queue, handlers });
await worker.runOnce(); // leases one job, routes by kind, runs, completes/fails
```

---

## 3. How a stage reaches storage / catalog / embed / config

The pipeline is **daemon-side** (`src/daemon/`) — the daemon is the ONLY DeepLake
client, and the daemon-only invariant test must stay green. Reach storage exactly
like the job queue does (`runtime/services/job-queue.ts` is the reference):

- Inject `StorageQuery` + `QueryScope` as **constructor/factory deps** (widen your
  `<Stage>HandlerDeps`). Run every statement through `storage.query(sql, scope)` —
  **never** a raw `fetch`, **never** `import` `storage/transport.ts`.
- Branch on the result `kind` via `isOk(...)`; do not wrap a storage call in a bare
  try/catch hunting a thrown shape.
- Build SQL with the **`writes.ts` primitives** (`appendOnlyInsert`,
  `appendVersionBumped`, `selectBeforeInsert`, `updateOrInsertByKey`, `buildInsert`,
  `renderValue`, `val`) + `healTargetFor(<table>)` from `catalog/index.js`. Every
  value goes through `sLiteral`/`sqlStr`/`sqlLike`/`eLiteral` and every identifier
  through `sqlIdent` — **never hand-quote a value.** `npm run audit:sql` scans
  `src/daemon` and FAILS the build on a raw interpolation.
- Catalog you'll need:
  - 006b decision → `MEMORY_HISTORY_COLUMNS`, `SHADOW_ACTOR`, `healTargetFor("memory_history")`.
  - 006c writes  → `MEMORIES_COLUMNS`, `contentHash`, `buildDedupCheckSql`,
    `NOT_SOFT_DELETED`/`SOFT_DELETED`, `healTargetFor("memories")`.
  - 006d graph   → the PRD-003b graph tables (`catalog/knowledge-graph.ts` — confirm
    it's filled when you start; coordinate if still a stub).
  - 006e retention → reuse the queue's `purgeRetained()` windowed-delete as the
    model; `is_deleted` tombstones for memories.
- **Embed seam (006c, c-AC-6):** inject the 005b `EmbedClient` from
  `services/embed-client.js` and PREFETCH the vector BEFORE the write, so no network
  call happens during the commit.
- **Pipeline config:** inject the resolved `PipelineConfig` (from `config.ts`). Read
  your gates off it — never `process.env` in a stage. Scope is on `job.scope`.

---

## 4. Where each of you writes (one stub file + one test) + the no-touch list

| PRD | Bee | Stub module (edit) | Test file (new) | Live test (opt-in) |
|---|---|---|---|---|
| 006b decision | `retrieval-worker-bee` | `decision.ts` | `tests/daemon/runtime/pipeline/decision.test.ts` | — |
| 006c controlled-writes | `deeplake-dataset-worker-bee` | `controlled-writes.ts` | `tests/daemon/runtime/pipeline/controlled-writes.test.ts` | `tests/integration/controlled-writes-live.itest.ts` |
| 006d graph-persist | `deeplake-dataset-worker-bee` | `graph-persist.ts` | `tests/daemon/runtime/pipeline/graph-persist.test.ts` | `tests/integration/graph-persist-live.itest.ts` |
| 006e retention | `deeplake-dataset-worker-bee` | `retention.ts` | `tests/daemon/runtime/pipeline/retention.test.ts` | `tests/integration/retention-live.itest.ts` |

**Shared files you must NOT edit** (contention seams — flag a gap instead of
editing): `config.ts`, `model-client.ts`, `contracts.ts`, `stage-worker.ts`,
`extraction.ts`, `handlers.ts`, `index.ts`, and any sibling stage's stub. You also
do not edit the catalog barrel (`catalog/index.ts`) or `writes.ts`/`sql.ts` — those
are PRD-002/003 shared. If 006d needs the graph tables and `knowledge-graph.ts` is
still a stub, that is a real dependency — coordinate / flag, don't fork the catalog.

---

## 5. Testing posture (verification = in-process, no real network)

- Build a `FakeDeepLakeTransport` (`tests/helpers/fake-deeplake.ts`) wrapped in a
  real `StorageClient` (`createStorageClient`). For a stateful table, use a small
  SQL-aware responder like `InMemoryJobs` in `job-queue.test.ts` (the reference).
- Inject `createFakeModelClient(...)` for the model; assert on `.calls`.
- Drive your stage with `worker.runOnce()` (lease → route → run → complete/fail),
  OR test your handler/core function directly with a hand-built `StageJob`.
- Name each test after the AC it proves (`b-AC-1 …`, `c-AC-2 …`) — one-to-one to
  the ledger. **No `.skip` / `.only`** (`vitest run` is CI).
- Opt-in LIVE tests use the `.itest.ts` suffix under `tests/integration/` (run only
  by `npm run test:integration`, never `npm run test`/`ci`). Each uses an authorized
  workspace + a per-scenario throwaway table prefix + DROP cleanup (the
  PRD-004/005 pattern). 006e: **verify the purge mechanism LIVE (D-8)** — hard
  DELETE may silently no-op; fall back to tombstone / DROP-batch.

---

## 6. The shared scaffold files you must NOT touch (recap)

`config.ts`, `model-client.ts`, `contracts.ts`, `stage-worker.ts`, `extraction.ts`,
`handlers.ts`, `index.ts` — and any other stage's `*.ts` stub. All four stages flow
into the worker through `createPipelineHandlers`; there is no edit to make in any
shared file. If you think you need one, you've found a seam gap: flag it so the
parallel wave stays contention-free.
