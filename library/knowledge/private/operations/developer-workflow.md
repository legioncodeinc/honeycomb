# Developer Workflow

> Category: Operations | Version: 1.0 | Date: October 2026 | Status: Active

How a contributor builds, tests, and starts Honeycomb from this checkout. End-user install is a different path.

**Related:**
- [Install and Onboarding](install-and-onboarding.md)
- [Monorepo Build and Release Pipeline](../infrastructure/monorepo-build-release.md)
- [CLI Command Architecture](cli-command-architecture.md)
- [Daemon Surface](../architecture/daemon-surface.md)
- [Load-Bearing Boundaries](../architecture/load-bearing-boundaries.md)
- [npm Publishing](../infrastructure/npm-publishing.md)

---

## Why this path exists

An end user pastes one command and lands on a dashboard. That installer is [Install and Onboarding](install-and-onboarding.md) (`install-and-onboarding.md:32-36`): `curl -fsSL https://get.theapiary.sh | sh` on macOS and Linux, then the `honeycomb install` verb. The URL that verb opens is `http://127.0.0.1:3853/` (`src/commands/install.ts:64-74`).

A contributor working in this checkout uses the package scripts. The package is `@legioncodeinc/honeycomb` (`package.json:2-11`) and it requires Node `>=22.5.0` (`package.json:110-112`). The scripts below are the ones in `package.json:53-91`.

## Install dependencies and build

`npm install` runs `postinstall`, which executes `scripts/ensure-tree-sitter.mjs` and `scripts/ensure-embed-deps.mjs` (`package.json:85`).

`npm run build` runs `prebuild` (`node scripts/sync-versions.mjs`, `package.json:54`) and then `tsc && node esbuild.config.mjs` (`package.json:56`). `tsc` emits modular ESM under `dist/`. esbuild then writes the CLI to `bundle/cli.js` with a Node hash-bang (`esbuild.config.mjs:355-367`). The published bin name `honeycomb` points at that file (`package.json:13-15`).

From this checkout, after a build, the CLI is `node bundle/cli.js` (or `./bundle/cli.js`). There is no `start` or `dev` script in `package.json:53-91`.

## The quality gate

`npm run ci` is `npm run typecheck && npm run dup && npm run test && npm run audit:sql` (`package.json:84`).

| Script | What it runs | Line |
|---|---|---|
| `npm run typecheck` | `tsc --noEmit` | `package.json:58` |
| `npm run dup` | `jscpd src harnesses mcp embeddings` | `package.json:61` |
| `npm test` | `vitest run` | `package.json:62` |
| `npm run audit:sql` | `node scripts/audit-sql-safety.mjs` | `package.json:73` |
| `npm run lint` | `biome check .` | `package.json:59` |
| `npm run format` | `biome format --write .` | `package.json:60` |

`npm run test:integration` is `vitest run --config vitest.integration.config.ts` (`package.json:64`). It is a separate script from `npm run ci`. Live smokes (`smoke:golden-path`, `smoke:login`, `smoke:data-api`, and the local-queue smokes) are also separate scripts in `package.json:65-90`.

## Start the daemon from the built CLI

`honeycomb daemon start`, `stop`, and `status` are the lifecycle verbs (`src/commands/daemon.ts:1-2`, `src/commands/daemon.ts:90`, `src/commands/contracts.ts:220`). A successful start prints `daemon: started on 127.0.0.1:3850.` An already-running daemon prints `daemon: already running on 127.0.0.1:3850.` (`src/commands/daemon.ts:96-102`). That address is `DAEMON_HOST` and `DAEMON_PORT` (`src/shared/constants.ts:13-17`).

The daemon process is the only Deeplake client. The CLI reaches it with `createLoopbackDaemonClient` (`src/cli/runtime.ts:751`, `src/cli/index.ts:1-13`). Liveness is `GET /health` on that same host and port. The route table and the readiness contract are in [Daemon Surface](../architecture/daemon-surface.md).

The browser dashboard the install verb opens is the Hive portal on port `3853` (`src/shared/constants.ts:19-23`, `src/dashboard/launch.ts:167-178`). If that portal is not answering, `dashboardPortalNotRunningMessage` prints an installer command whose product list is `honeycomb,doctor,hive` (`src/commands/install.ts:88-93`). Starting `node bundle/cli.js daemon start` binds `3850`. It does not bind `3853`.

## What a contributor should not import

Tier 4 code (`src/cli`, `harnesses/*/src`, `mcp/src`) imports `src/shared` and the daemon client surface. It does not import `src/daemon`. Tier N may import only from tiers `< N` (`BUILD.md:17-19`). The tier table, the SQL helpers, and the `createDaemon({ services })` injection seam are in [Load-Bearing Boundaries](../architecture/load-bearing-boundaries.md) and `BUILD.md:15-32`.
