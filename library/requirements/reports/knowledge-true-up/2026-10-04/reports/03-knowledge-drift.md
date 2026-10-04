# Knowledge drift

`library/knowledge/private` has 87 markdown files. The true-up edited the pages whose load-bearing sentences contradicted the working tree. Historical ADRs that describe the old `~/.honeycomb` layout as the problem they solved were left in place.

Corrections applied, each checked against source by the orchestrator:

| Doc | Correction | Evidence |
|---|---|---|
| overview.md | Embeddings default on. Local queue defaults on for undeclared topology. SDK is `@legioncodeinc/honeycomb`. Local state is under `~/.apiary`. | embed-client.ts, local-queue-diagnostics.ts, package.json, fleet-root.ts |
| architecture/system-overview.md | Same SDK and state-root facts. Not every catalog table has org_id. | catalog grep for org_id |
| architecture/daemon-surface.md | `/mcp` is a 501 scaffold. Service label is `com.legioncode.honeycomb`. | server.ts, daemon-service.ts |
| architecture/load-bearing-boundaries.md | CLI and daemon-client do import daemon modules. Transport client stays in the daemon. | commands/install.ts, daemon-client/vfs/read.ts |
| architecture/cli-dispatcher.md | A non-sql `daemon/storage` import from `src/commands` fails `tests/daemon/storage/invariant.test.ts`. `sql.ts` stays allowed. | invariant.test.ts, package.json `ci` |
| integrations/mcp-and-sdk.md | `createHoneycombClient` from `@legioncodeinc/honeycomb`. MCP stdio. | sdk/client.ts, sdk/contracts.ts |
| operations/install-and-onboarding.md | No host.ts. Browser target is Hive on 3853. | host.ts glob empty, install.ts |
| operations/local-queue-idle-cost-control.md | Undeclared topology defaults the local queue on. | local-queue-diagnostics.ts |
| operations/fleet-and-usage-telemetry.md | Registry and telemetry paths. | fleet-registry.ts, fleet-store.ts |
| operations/notifications-and-health.md | notifications-state under the apiary state dir. | notifications/state.ts |
| operations/doctor-watchdog.md | No doctor/ directory in this repo. | repo root listing |
| operations/roi-tracker.md | mountDashboardHost is absent. | host.ts glob |
| infrastructure/npm-publishing.md | version script does not `git add -A`. | package.json scripts.version |
| ai/retrieval.md | Caller line, nectar path, recency stage, 6000 ms timeout, PreToolUse seam. | api.ts, nectar-recall-config.ts, recall.ts, recall-renderer.ts, hooks/runtime.ts |
| ai/skillify-pipeline.md | Stop counter is in-memory (default 10). Watermark file is apiary-first, keyed by session path. | turn-counters.ts, watermark.ts, worker.ts |
| data/schema.md | memory semantic arm, documents/connectors names, inbox capture. | recall.ts, catalog/sources.ts, session-capture.md |
| frontend/dashboard-architecture.md | No src/dashboard/web/main.tsx. | glob |
| frontend/cursor-extension-architecture.md | Hook file is shim.ts. No extension package.json. | globs |
| collaboration/asset-sync-substrate.md | Registry path. | assets/registry.ts |
| standards/api-design-conventions.md | `/v1` is not mounted in assemble. docs/ has ci.md only. | gateway.ts grep, docs glob |
| sources/source-lifecycle.md | Verb is `sources`. CLI posts a subcommand to `/api/sources/<subcommand>`. Daemon connect is `POST /api/sources`. | storage-handlers.ts, sources/api.ts, contracts.ts |
| security/secrets.md | Implementation is src/daemon/runtime/secrets. | directory listing |
| security/trust-boundaries.md | SQL helpers are imported by daemon-client. | daemon-client/vfs/read.ts |

Pages not rewritten: ADRs, most AI narrative that the lenses graded HOLDS, and claims this audit did not re-derive. Those remain investigator observations in the lens files.
