# `product/` — Product-Data API (PRD-022c)

Daemon-side wiring for the product-data routes the CLI/SDK/MCP target. **Wiring-only
(D-1):** no new business logic, no new DeepLake schema. The engines + tables
(PRD-003d goals/kpis, 016/018 skills, rules, 013 sources, 012 secrets) all exist; this
group wires them to their HTTP routes.

## Layout

| File | Owns |
|---|---|
| `keyed-engine.ts` | The shared GET+POST engine for the two keyed tables (`goals`, `kpis`). Zod body, tenancy scope, `updateOrInsertByKey` upsert, read-back. `goals/api.ts` + `kpis/api.ts` mount it bound to their table — ONE engine, no duplication (jscpd-7). |
| `api.ts` | `/api/skills` + `/api/rules` read-only handlers (highest-version-per-id), the daemon-seam wrappers for the existing `mountSourcesApi` / `mountSecretsApi`, and the single `mountProductDataApi` facade the assembly (022d) fires. |
| `index.ts` | Barrel — the import surface for 022d + tests. |
| `../goals/api.ts` | `mountGoalsApi(daemon, { storage })` → `/api/goals`. |
| `../kpis/api.ts` | `mountKpisApi(daemon, { storage })` → `/api/kpis`. |

## Mount-seam signatures (for the 022d assembly)

The composition root (`assembleSeams()`) fires ONE call:

```ts
import { mountProductDataApi } from "./product/index.js";

mountProductDataApi(daemon, {
  storage,                 // the live StorageClient (goals/kpis/skills/rules reads + writes)
  sources: sourcesApiDeps, // optional: the existing SourcesApiDeps (013) — wires /api/sources
  secrets: secretsApiDeps, // optional: the existing SecretsApiDeps (012) — wires /api/secrets
});
```

`mountProductDataApi` internally fires, each ONCE, resolving its own already-mounted +
already-protected route group (no `server.ts` edit):

- `mountGoalsApi(daemon, { storage })`        → `/api/goals` GET + POST (upsert by key)
- `mountKpisApi(daemon, { storage })`         → `/api/kpis` GET + POST (upsert by key)
- `mountSkillsReadApi(daemon, storage)`       → `/api/skills` GET (read-only)
- `mountRulesReadApi(daemon, storage)`        → `/api/rules` GET (read-only, active)
- `mountProductSourcesApi(daemon, sources)`   → `/api/sources` (delegates to `mountSourcesApi`)
- `mountProductSecretsApi(daemon, secrets)`   → `/api/secrets` (delegates to `mountSecretsApi`, names-only)

If the assembly prefers per-group control it can call the inner mounts directly; they are
all exported from `product/index.js`. The sources/secrets wrappers are no-ops when their
group is not mounted, so calling order is unconstrained.

### How the assembly builds the sources + secrets deps

`mountSourcesApi` and `mountSecretsApi` are NOT rebuilt here — they EXIST (013 / 012). The
assembly constructs their deps the same way their own live itests do:

- **sources** — `SourcesApiDeps { storage, queue, registry, providers, scope?, logger?, documentWorker? }`.
  `storage` + `queue` are the daemon's live storage client + job queue; `registry` +
  `providers` come from the 013 source engine; the default header scope resolver applies.
- **secrets** — `SecretsApiDeps { store, scope?, execRunner? }`. `store` is
  `new SecretsStore({ baseDir: $HONEYCOMB_WORKSPACE, machineKey: createMachineKeyProvider() })`
  (012). The default header scope resolver applies; the value never crosses the boundary.

## Invariants

- **Daemon-only.** This group imports `daemon/storage` (allowed — lives under `src/daemon/`).
  CLI/SDK/MCP reach it over the daemon RPC; `invariant.test.ts` stays green.
- **SQL safety.** Every value routes through the 002d `val.*` constructors / `sLiteral`;
  every identifier through `sqlIdent`. The version-bumped reads (`buildHighestVersionSql`)
  are static + injection-free (the scope is a daemon-side partition filter). `audit:sql`
  scans `src/daemon`.
- **Upsert by key (c-AC-2).** Goals/kpis use `updateOrInsertByKey` — re-adding the same key
  UPDATES in place. Never introduce a second insert path that duplicates by key.
- **Tenancy fail-closed (c-AC-6).** Every route 400s on a missing `x-honeycomb-org`; a body
  cannot set `agent_id`/`visibility` (server-stamped). Zod `.strict()` rejects an
  over-shaped body at the edge before any storage call.
- **Secrets value-safety (c-AC-5).** `/api/secrets` mounts NO value-returning route by
  construction (012); this group only wires it — it adds no value path.
