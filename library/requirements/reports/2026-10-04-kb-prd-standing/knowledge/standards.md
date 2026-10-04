# Standards knowledge standing

Shard: `library/knowledge/private/standards/` (Wave 1a). Branch `legion/kb-sotu-and-prd-lifecycle`. Read-only. The dirty `api-design-conventions.md` was not reverted. No source edits.

Defect count: 24 (FALSE, STALE, or HOLE). Holds are listed after the defects and are not part of that count.

## Coverage

| File | Lines | Page action | Defects |
|---|---|---|---|
| `library/knowledge/private/standards/api-design-conventions.md` | 64 | REVISE | S-1 through S-7 |
| `library/knowledge/private/standards/coding-standards-typescript.md` | 79 | REVISE | S-8 through S-13 |
| `library/knowledge/private/standards/documentation-framework.md` | 155 | REVISE | S-14 through S-21 |
| `library/knowledge/private/standards/readme-and-brand-assets.md` | 63 | REVISE | S-22 through S-24 |

Related links inside these four pages resolve to files that exist (`coding-standards-typescript.md`, `documentation-framework.md`, `api-design-conventions.md`, `../architecture/system-overview.md`, `../architecture/load-bearing-boundaries.md`, `../architecture/daemon-surface.md`, `../auth/auth-architecture.md`, `../data/deeplake-storage.md`, `../overview.md`, `README.md`, `assets/logos/`). None of the four pages should be removed. S-21 is the only ADD: new sections inside `documentation-framework.md`, not a new file.

`daemon-surface.md:45` still calls `/` "Dashboard static assets". This standards page is the one that matches the server: no module attaches a page handler there. Leave that sentence (H-6).

## Defects

### S-1

- Quote: "checks a required permission against the caller's role (admin, operator, agent, readonly)"
- Doc: `library/knowledge/private/standards/api-design-conventions.md:60`
- Grounding: `src/daemon/runtime/auth/contracts.ts:82` (`ROLES` is `admin`, `member`, `readonly`, `agent`). `src/daemon/runtime/auth/rbac.ts:23-27` says the frozen contract replaced the stale `operator` name with `member`. `src/daemon/runtime/assemble.ts:1045-1051` injects `createRbacPolicy()` for `team` and `hybrid`.
- Verdict: FALSE
- Action: REVISE

### S-2

- Quote: "Errors return a structured shape, by default `{ "error": "human-readable message" }`"
- Doc: `library/knowledge/private/standards/api-design-conventions.md:38`
- Grounding: `src/daemon/runtime/server.ts:408-410` returns `{ error: "not_implemented", group, detail }`. `src/daemon/runtime/middleware/permission.ts:264` returns `{ error: "unauthorized" }`. `src/daemon/runtime/middleware/permission.ts:269` returns `{ error: "forbidden", reason, group }`. `src/daemon/runtime/auth/rate-limit.ts:205` returns `{ error: "rate_limited", retryAfterSeconds }`. The `error` field is a machine code. Human text, when present, is `reason` or `detail`.
- Verdict: FALSE
- Action: REVISE

### S-3

- Quote: "503 | mutation blocked by a kill switch (frozen mutations)"
- Doc: `library/knowledge/private/standards/api-design-conventions.md:45`
- Grounding: `src/daemon/runtime/pipeline/controlled-writes.ts:415-417` skips the write and returns `{ action: "skipped", reason: "mutations_frozen" }`. No HTTP 503 is mapped from that reason. Live 503s are the degraded `/health` body (`src/daemon/runtime/server.ts:335`) and a thrown runtime-path claim (`src/daemon/runtime/middleware/runtime-path.ts:292-301`).
- Verdict: FALSE
- Action: REVISE

### S-4

- Quote: "applies a rate-limit bucket for expensive or abuse-prone operations" and "Rate-limited operations surface a dedicated rate-limit error with a `Retry-After` header"
- Doc: `library/knowledge/private/standards/api-design-conventions.md:47` and `library/knowledge/private/standards/api-design-conventions.md:60`
- Grounding: `src/daemon/runtime/auth/rate-limit.ts:182-205` implements `429` plus `Retry-After`. `src/daemon/runtime/auth/rate-limit.ts:187` says mounting onto expensive routes is deferred. Call sites of `createRateLimitMiddleware` are the module itself, the auth barrel, and `tests/daemon/runtime/auth/rate-limit.test.ts`. `src/daemon/runtime/assemble.ts` does not mount it.
- Verdict: STALE
- Action: REVISE

### S-5

- Quote: "The API documentation organizes routes into coherent groups" with rows named `health-status`, `core-configuration`, `documents-sources`, `knowledge-ontology`, `telemetry-logs`
- Doc: `library/knowledge/private/standards/api-design-conventions.md:21-34`
- Grounding: ABSENT. Those names occur only in this file. The mounted prefixes are `ROUTE_GROUPS` in `src/daemon/runtime/server.ts:68-106`. There is no `/api/features` row. The same page, line 64, says this checkout has no `docs/API.md`.
- Verdict: STALE
- Action: REVISE

### S-6

- Quote: "In `team` and `hybrid`, each protected route checks a required permission"
- Doc: `library/knowledge/private/standards/api-design-conventions.md:60`
- Grounding: `src/daemon/runtime/middleware/permission.ts:194-200`. In `hybrid`, a trusted local socket peer calls `next()` with no authenticator and no policy. `team` does check.
- Verdict: STALE
- Action: REVISE

### S-7

- Quote: "validates token scope against the resource within its org and workspace"
- Doc: `library/knowledge/private/standards/api-design-conventions.md:60`
- Grounding: `src/daemon/runtime/auth/rbac.ts:258-277` gates capability and project scope. It does not compare the request org or workspace to the token. `src/daemon/runtime/middleware/permission.ts:216-223` stamps the identity so handlers can cross-check `x-honeycomb-org`. That cross-check is per handler, not a route-layer check on every protected route.
- Verdict: HOLE
- Action: REVISE

### S-8

- Quote: "run focused suites directly rather than a bare root run, which would also pick up third-party tests under `references/`"
- Doc: `library/knowledge/private/standards/coding-standards-typescript.md:50`
- Grounding: `vitest.config.ts:43` includes only `tests/**/*.test.ts`, `tests/**/*.test.tsx`, and `tests/**/*.spec.ts`. `references/` holds schema modules (`references/README.md` and `references/**/*.ts`). None of those files are `*.test.ts`.
- Verdict: FALSE
- Action: REVISE

### S-9

- Quote: "Reserve `feat:` for user-facing features, since it drives a minor version bump"
- Doc: `library/knowledge/private/standards/coding-standards-typescript.md:65`
- Grounding: `scripts/release/ai-changeset.mjs:81-90`. A model chooses `patch`, `minor`, or `major` from the diff and commit subjects. Commit type `feat:` is not the bump switch. `library/knowledge/private/infrastructure/release-automation.md:52` gates `minor` on a human approval comment.
- Verdict: FALSE
- Action: REVISE

### S-10

- Quote: "Branch as `<username>/<feature>` off `main`"
- Doc: `library/knowledge/private/standards/coding-standards-typescript.md:65`
- Grounding: `CONTRIBUTING.md:57` says name the branch for what it does, with examples `fix/recall-empty-result` and `feat/embed-batching`.
- Verdict: FALSE
- Action: REVISE

### S-11

- Quote: "DeepLake is the canonical store: durable app state lives in DeepLake tables, not local JSON sidecars. JSON, JSONL, and sidecar files are not acceptable as the default for app state, caches, queues, indexes, or cursors."
- Doc: `library/knowledge/private/standards/coding-standards-typescript.md:46`
- Grounding: `src/daemon/runtime/services/local-job-queue.ts:1-6` is the local `node:sqlite` queue and does not call DeepLake. `library/knowledge/private/architecture/adr/0009-local-queue-as-default-deeplake-is-not-a-queue.md:29-31` makes that queue the default coordination substrate. `src/daemon/runtime/auth/credentials-store.ts:1-6` persists auth state in `~/.deeplake/credentials.json`.
- Verdict: STALE
- Action: REVISE

### S-12

- Quote: "Tier N may import only from tiers `< N` (`BUILD.md:17-19`). The full rule is in Load-Bearing Boundaries"
- Doc: `library/knowledge/private/standards/coding-standards-typescript.md:79`
- Grounding: `BUILD.md:17-19` does say tier N imports only from tiers below N. `BUILD.md:24-26` is tighter: tier 3 and tier 4 may import tier 1, not every lower tier. `library/knowledge/private/architecture/load-bearing-boundaries.md:53` says that rule is not absolute in this tree (`src/commands` and `src/cli` import daemon runtime modules; `src/daemon-client` imports `src/daemon/storage/sql.ts`).
- Verdict: STALE
- Action: REVISE

### S-13

- Quote: "the failure mode behind the Doctor real-npm smoke flake on busy Windows runners"
- Doc: `library/knowledge/private/standards/coding-standards-typescript.md:52`
- Grounding: ABSENT in this repo. No `tests/**/*doctor*` file. `library/knowledge/private/infrastructure/npm-publishing.md:130` says that smoke moved to `github.com/legioncodeinc/doctor` (PR #199). The 5 second unit-suite ceiling still matches a config that sets no `testTimeout` (`vitest.config.ts:28-45`) and the 5000 ms ceiling cited in `library/requirements/completed/prd-013-sources-and-documents/reports/2026-06-18-qa-report.md:45`.
- Verdict: STALE
- Action: REVISE

### S-14

- Quote: "Feature PRD | ... | `library/requirements/features/feature-<###>-<title>/prd-feature-<###>-<title>.md`" and "`library/requirements/features/completed/feature-<###>-<title>/`"
- Doc: `library/knowledge/private/standards/documentation-framework.md:22` and `library/knowledge/private/standards/documentation-framework.md:93-94`
- Grounding: ABSENT `library/requirements/features/`. ABSENT the example `feature-007-agent-memory-export`. Live PRDs are `library/requirements/{backlog,in-work,completed,archive}/prd-<###>-<slug>/`. Sample: `library/requirements/completed/prd-001-monorepo-foundation/prd-001-monorepo-foundation-index.md:1`. ClickUp `-ck-` filenames are also ABSENT outside this page (`documentation-framework.md:74`).
- Verdict: FALSE
- Action: REVISE

### S-15

- Quote: "Issue IRD | ... | `library/requirements/issues/issue-<###>-<title>/ird-issue-<###>-<title>.md`"
- Doc: `library/knowledge/private/standards/documentation-framework.md:21` and `library/knowledge/private/standards/documentation-framework.md:95-96`
- Grounding: ABSENT `library/requirements/issues/`. Live IRDs are a peer of requirements: `library/issues/README.md:1-8` and `library/issues/backlog/ird-192-doctor-windows-scheduled-task-invalid-restart-interval/ird-192-doctor-windows-scheduled-task-invalid-restart-interval-index.md`.
- Verdict: FALSE
- Action: REVISE

### S-16

- Quote: homes `library/knowledge/.../api/`, `how-to-guides/`, `design/`, `features/`, `specs/`, `product/`, `releases/`
- Doc: `library/knowledge/private/standards/documentation-framework.md:26-34`
- Grounding: ABSENT. No markdown under those folder names. Private knowledge domains that do exist include `ai/`, `architecture/`, `auth/`, `data/`, `frontend/`, `dashboard/`, `integrations/`, `operations/`, `security/`, `standards/`. User how-tos live at `library/knowledge/public/guides/`.
- Verdict: FALSE
- Action: REVISE

### S-17

- Quote: "Every markdown file under `library/knowledge/` starts with the same header."
- Doc: `library/knowledge/private/standards/documentation-framework.md:40`
- Grounding: `library/knowledge/README.md:1` opens with YAML frontmatter, not the Category line. `library/knowledge/private/architecture/adr/README.md:1` opens with a title and no Category line. `library/knowledge/private/architecture/adr/0009-local-queue-as-default-deeplake-is-not-a-queue.md:3` uses a Nygard status line. `library/knowledge/private/overview.md:1-3` does follow the header.
- Verdict: FALSE
- Action: REVISE

### S-18

- Quote: "Patch bumps (`1.0` to `1.1`) cover additions; minor bumps (`1.x` to `2.0`) cover reorganizations."
- Doc: `library/knowledge/private/standards/documentation-framework.md:54`
- Grounding: those ranges are swapped against semver. `1.0` to `1.1` is a minor bump. `1.x` to `2.0` is a major bump. The page's own header is `Version: 1.0` (`documentation-framework.md:3`) while sibling standards pages are already `1.1`.
- Verdict: FALSE
- Action: REVISE

### S-19

- Quote: "written as `` `src/routes/memories.ts:42-80` ``"
- Doc: `library/knowledge/private/standards/documentation-framework.md:120`
- Grounding: ABSENT `src/routes/memories.ts`. Memory HTTP handlers live in `src/daemon/runtime/memories/api.ts`.
- Verdict: HOLE
- Action: REVISE

### S-20

- Quote: "QA Report (tied) | ... | The plan's own `reports/<date>-qa-report.md` subfolder"
- Doc: `library/knowledge/private/standards/documentation-framework.md:23` and `library/knowledge/private/standards/documentation-framework.md:75`
- Grounding: some plans still use `reports/`, for example `library/requirements/completed/prd-001-monorepo-foundation/reports/2026-06-17-qa-report.md`. The reports index says per-PRD QA belongs in `prd-<###>-<slug>/qa/` (`library/requirements/reports/README.md:30-31`). IRD 192 uses `qa/`, not `reports/`: `library/issues/backlog/ird-192-doctor-windows-scheduled-task-invalid-restart-interval/qa/quality-report-ird-192.md`. Standalone `library/qa/<domain>/` does exist (`documentation-framework.md:24` holds; see H-16).
- Verdict: STALE
- Action: REVISE

### S-21

- Quote: "Honeycomb keeps a small, fixed catalog of document types. Each type has a single home"
- Doc: `library/knowledge/private/standards/documentation-framework.md:17`
- Grounding: the catalog omits ADRs. The live home is `library/knowledge/private/architecture/adr/NNNN-kebab-title.md` (`library/knowledge/private/architecture/adr/README.md:7`). It also omits the public/private split in `library/knowledge/README.md:1-16` and `library/knowledge/public/README.md:1-11`.
- Verdict: HOLE
- Action: ADD

### S-22

- Quote: "How brand, hero, and partner logos are stored under `assets/logos/` and rendered in `README.md`" and the sample `srcset="assets/logos/activeloop-full-mark-logo-on-dark.svg"`
- Doc: `library/knowledge/private/standards/readme-and-brand-assets.md:5` and `library/knowledge/private/standards/readme-and-brand-assets.md:28-29`
- Grounding: `README.md:5-6`, `README.md:39-40`, and `README.md:46-47` point at `assets/brand/`, not `assets/logos/`. Copies of the Activeloop and Legion SVGs still exist under `assets/logos/`, and the README does not reference them.
- Verdict: FALSE
- Action: REVISE

### S-23

- Quote: "used by `honeycomb-memory-cluster-wordmark-on-dark.svg` and `activeloop-full-mark-logo-on-dark.svg`"
- Doc: `library/knowledge/private/standards/readme-and-brand-assets.md:51`
- Grounding: ABSENT `honeycomb-memory-cluster-wordmark-on-dark.svg`. The README hero pair is `assets/brand/honeycomb-wordmark-on-dark.svg` and `assets/brand/honeycomb-wordmark-black.svg` (`README.md:5-6`). `activeloop-full-mark-logo-on-dark.svg` exists at both `assets/brand/activeloop-full-mark-logo-on-dark.svg:4-5` and `assets/logos/activeloop-full-mark-logo-on-dark.svg:4-5`.
- Verdict: FALSE
- Action: REVISE

### S-24

- Quote: "using `#F2F3F5` for wordmark text to match the existing logos"
- Doc: `library/knowledge/private/standards/readme-and-brand-assets.md:59`
- Grounding: Legion dark text is `#F2F3F5` (`assets/logos/legion-logo-dark.svg:15`). Activeloop `.st0` on the dark file is `fill: #F2F3F5` (`assets/brand/activeloop-full-mark-logo-on-dark.svg:4-5`). The hero dark wordmark text is `fill="#F7F3EC"` (`assets/brand/honeycomb-wordmark-on-dark.svg:1`). The light hero text is `fill="#1A1206"` (`assets/brand/honeycomb-wordmark-black.svg:1`).
- Verdict: STALE
- Action: REVISE

## Holds

Checked claims that match the tree. Action LEAVE.

### H-1

- Quote: "`/health` is the cheap liveness check and `/api/*` is the working API. `ROUTE_GROUPS` scaffolds `/mcp` and `/v1`. An unfilled scaffold returns 501."
- Doc: `library/knowledge/private/standards/api-design-conventions.md:17`
- Grounding: `src/shared/constants.ts:14` (`DAEMON_PORT = 3850`). `src/daemon/runtime/server.ts:68-104` lists `/health`, `/v1`, and `/mcp`. `src/daemon/runtime/server.ts:330-331` and `src/daemon/runtime/server.ts:399-411` return 501 for a known prefix with no handler.
- Verdict: HOLDS
- Action: LEAVE

### H-2

- Quote: "The OpenAI gateway module is `src/daemon/runtime/inference/gateway.ts`, and production `assemble.ts` does not call `group("/v1")`."
- Doc: `library/knowledge/private/standards/api-design-conventions.md:17`
- Grounding: `src/daemon/runtime/inference/gateway.ts:103-105` defines `mountInferenceGateway`. `src/daemon/runtime/assemble.ts` has no `.group(` call and no `mountInferenceGateway` call. The only `daemon.group("/v1")` call is `tests/daemon/runtime/inference/gateway.test.ts:199`.
- Verdict: HOLDS
- Action: LEAVE

### H-3

- Quote: "Production MCP is the stdio server."
- Doc: `library/knowledge/private/standards/api-design-conventions.md:17`
- Grounding: `mcp/src/index.ts:109-112` defaults `serveHttp` to false. `mcp/src/index.ts:195-199` auto-starts `startMcpServer()` with stdio only. The daemon `/mcp` prefix stays the 501 scaffold unless something calls `daemon.group("/mcp")`. No such call exists under `src/`.
- Verdict: HOLDS
- Action: LEAVE

### H-4

- Quote: "The browser dashboard is the Hive portal on port 3853."
- Doc: `library/knowledge/private/standards/api-design-conventions.md:17`
- Grounding: `src/shared/constants.ts:19-23` (`HIVE_PORT = 3853`). `src/dashboard/launch.ts:149-156` and `src/dashboard/launch.ts:168-178`.
- Verdict: HOLDS
- Action: LEAVE

### H-5

- Quote: "Connectors send `x-honeycomb-runtime-path: plugin|legacy`, and a conflicting path on the same session returns `409`."
- Doc: `library/knowledge/private/standards/api-design-conventions.md:56`
- Grounding: `src/daemon/runtime/middleware/runtime-path.ts:241-247` and `src/daemon/runtime/middleware/runtime-path.ts:262-313`.
- Verdict: HOLDS
- Action: LEAVE

### H-6

- Quote: "`ROUTE_GROUPS` also scaffolds a `/` group, and no module attaches a page handler to it."
- Doc: `library/knowledge/private/standards/api-design-conventions.md:17`
- Grounding: `src/daemon/runtime/server.ts:105`. No `group("/")` call under `src/`. ABSENT `src/daemon/runtime/dashboard/host.ts` (comments in `src/daemon/runtime/dashboard/setup-login.ts:13` still name `mountDashboardHost`).
- Verdict: HOLDS
- Action: LEAVE

### H-7

- Quote: "In `local` mode every route is open."
- Doc: `library/knowledge/private/standards/api-design-conventions.md:60`
- Grounding: `src/daemon/runtime/middleware/permission.ts:186-189`. This is the auth gate only. Session groups still require `x-honeycomb-runtime-path` in every mode (`src/daemon/runtime/middleware/runtime-path.ts:250-272`, `getMode` unused).
- Verdict: HOLDS
- Action: LEAVE

### H-8

- Quote: "401 | missing or invalid auth (team/hybrid)" and "403 | authenticated but lacks permission or scope" and "409 | state conflict, including a runtime-path conflict" and "429 | rate limit exceeded, with `Retry-After`"
- Doc: `library/knowledge/private/standards/api-design-conventions.md:41-44`
- Grounding: `src/daemon/runtime/middleware/permission.ts:262-269`. `src/daemon/runtime/middleware/runtime-path.ts:305-313`. `src/daemon/runtime/auth/rate-limit.ts:202-205` (middleware exists; production mount is S-4).
- Verdict: HOLDS
- Action: LEAVE

### H-9

- Quote: "dead-lettered jobs are not retried"
- Doc: `library/knowledge/private/standards/api-design-conventions.md:47`
- Grounding: `src/daemon/runtime/services/job-queue.ts:797-801` (`dead` is never leased again). `src/daemon/runtime/services/job-queue.ts:645-649` leases only `queued` and `failed`.
- Verdict: HOLDS
- Action: LEAVE

### H-10

- Quote: "This checkout's `docs/` directory contains `docs/ci.md` and `docs/license-header.txt`. There is no `docs/API.md` and no `docs/api/` tree here."
- Doc: `library/knowledge/private/standards/api-design-conventions.md:64`
- Grounding: `docs/ci.md` and `docs/license-header.txt` are the only files under `docs/`. ABSENT `docs/API.md`. ABSENT `docs/api/`.
- Verdict: HOLDS
- Action: LEAVE

### H-11

- Quote: "`strict` is on in `tsconfig.json`" and the Biome tab / 120 / `noExplicitAny` / `noNonNullAssertion` / `noForEach` warnings, and the `npm run ci` gate
- Doc: `library/knowledge/private/standards/coding-standards-typescript.md:22`, `library/knowledge/private/standards/coding-standards-typescript.md:61`, `library/knowledge/private/standards/coding-standards-typescript.md:76`
- Grounding: `tsconfig.json:10`. `biome.json:23-39`. `package.json:56-59` and `package.json:84` (`typecheck && dup && test && audit:sql`). Tier names in `coding-standards-typescript.md:79` match `BUILD.md:21-27` and `package.json:12`. The absolute import sentence is S-12.
- Verdict: HOLDS
- Action: LEAVE

### H-12

- Quote: "External inputs ... are validated where they enter, using `zod` or the existing schema helpers."
- Doc: `library/knowledge/private/standards/coding-standards-typescript.md:26`
- Grounding: `package.json:135` (`zod`). Example import `src/daemon/runtime/inference/config.ts:37`.
- Verdict: HOLDS
- Action: LEAVE

### H-13

- Quote: "The runner is Vitest (`tests/` mirrors `src/`)"
- Doc: `library/knowledge/private/standards/coding-standards-typescript.md:50`
- Grounding: `vitest.config.ts:5-7` and `vitest.config.ts:43-44`. The `references/` clause of the same sentence is S-8.
- Verdict: HOLDS
- Action: LEAVE

### H-14

- Quote: "Scoping: every route that touches user data threads `agent_id` (or `agentId`) and threads `visibility`"
- Doc: `library/knowledge/private/standards/api-design-conventions.md:54`
- Grounding: `src/daemon/runtime/recall/scope-clause.ts:19-26` and `src/daemon/runtime/recall/scope-clause.ts:64-65`. Fallbacks to the string `default` exist when the id is absent (`src/daemon/runtime/pipeline/controlled-writes.ts:1026`), which matches the page's "when a real agent id is known" clause.
- Verdict: HOLDS
- Action: LEAVE

### H-15

- Quote: the `<picture>` swap with `media="(prefers-color-scheme: dark)"` for the hero, Legion, and Activeloop marks
- Doc: `library/knowledge/private/standards/readme-and-brand-assets.md:22-39`
- Grounding: `README.md:4-7`, `README.md:38-48`. Paths in the sample markup are S-22. Activeloop light `.st0` has no `fill` (`assets/brand/activeloop-full-mark-logo.svg:4-6`); the dark file sets `fill: #F2F3F5` (`assets/brand/activeloop-full-mark-logo-on-dark.svg:4-5`). The same pair exists under `assets/logos/`.
- Verdict: HOLDS
- Action: LEAVE

### H-16

- Quote: "QA Report (standalone) | ... | `library/qa/<domain>/<date>-qa-report.md`"
- Doc: `library/knowledge/private/standards/documentation-framework.md:24`
- Grounding: `library/qa/` exists (for example `library/qa/repo-sweep/c7/quality.md`). The tied-plan `reports/` rule is S-20.
- Verdict: HOLDS
- Action: LEAVE
