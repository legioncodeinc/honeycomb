# QA Report: Repo Sweep, Core Functionality Gap Review (Pre-Release)

- **Date:** 2026-07-03
- **Branch:** `main` (ae464ac, 2026-07-02)
- **Auditor:** pre-release QA sweep (README + knowledge corpus + PRD acceptance criteria traced into source)
- **Scope:** the full core surface before public launch: capture intake, three-tier memory, hybrid recall, session priming, skillify + propagation, pollinating loop, knowledge graph, codebase graph, all six harness integrations, MCP server, SDK, unified CLI, one-command install, daemon lifecycle, dashboard API.
- **Method:** read README.md, all of library/knowledge (public + private), all completed and in-work PRDs (backlog and archive skimmed), then traced every claim and acceptance criterion into src/, daemon/, harnesses/, mcp/, sdk/, scripts/, and tests/. Real code read, not filenames. No source modified.

## Summary Verdict

**PARTIAL. The engine is real, the last mile is not.**

The spine of the product, capture to summarize to prime to recall, is genuinely well-built for Claude Code, Codex, and Cursor: append-only storage discipline, honest degraded flags, real RRF fusion, real device flow, real skill mining with secret redaction, real tree-sitter extraction for all nine claimed languages. The PRD corpus is unusually honest and most acceptance criteria trace to real, tested code.

But the README sells a product the default install does not deliver, and several flagship features are engines with the driveshaft never connected:

1. **Three of the six harnesses are stubs.** Hermes, pi, and OpenClaw have shims and unit tests but nothing installs them, nothing invokes them, and their published bundles are inert. The honest count is 3 of 6.
2. **The MCP surface is half dead.** 8 of 21 registered tools dial daemon routes that do not exist, including the three flagship browse tools the README advertises by name. modify/forget use the wrong method and path. MCP registration into harnesses is 0 of 6.
3. **The one-command install ends on a dead browser tab.** The dashboard is the Hive portal (:3853), a sibling product that is not in the installer's default product set. The terminal prints success while the browser shows connection refused.
4. **The pollinating loop can never fire.** The token counter that triggers it has zero production writers and there is no maintenance tick. It only runs when a test hand-cranks it.
5. **Capture is fail-silent, not just fail-soft.** The production assembly wires no logger into the capture handler, the hook reports success when the daemon is down, and the default-on write buffer can drop turns with zero trace.
6. **The three-tier pointer walk dead-ends at Tier 3.** The summary-to-raw resolve joins on a path that never matches in production; a fabricated test fixture hides it.

Ship-blocking work is concentrated: fix the resolve join, fix the MCP routes, wire the pollinating counter, make the install path honest about the portal, and either wire or stop claiming the three stub harnesses. The docs then need a truth pass (embeddings default, recall number, six-harness claim, four fully stale knowledge docs).

## Scorecard

| Area | Verdict | Worst finding severity |
|---|---|---|
| Capture intake (turn persistence) | Works, but fail-silent | CRITICAL (C-4) |
| Three-tier memory (key/summary/raw) | Tiers real; Tier-3 resolve broken | CRITICAL (C-5) |
| Hybrid recall + RRF | Solid; README numbers and defaults wrong | HIGH (H-1, H-2) |
| Session priming | Solid | MEDIUM (M-6) |
| Skillify + propagation | Runs, Claude-only gate, scope config dead | HIGH (H-5, H-6) |
| Pollinating loop | Built, never fires | CRITICAL (C-3) |
| Knowledge graph | Built, inert by default | HIGH (H-4) |
| Codebase graph | Extraction real, query surface dead-wired | HIGH (H-7) |
| Harnesses: Claude Code / Codex / Cursor | Genuinely wired | MEDIUM (M-9) |
| Harnesses: Hermes / pi / OpenClaw | Stubs, claimed as supported | CRITICAL (C-1) |
| MCP server | Plumbing good, routes wrong, transports half-shipped | CRITICAL (C-2) |
| TypeScript SDK | Real, fetch-only, matches exports; no .d.ts | MEDIUM (M-4) |
| Unified CLI | Strong; `dashboard` and `update` verbs misdescribed/stubbed | HIGH (H-8) |
| One-command install | Scripts good; dead-tab default path | CRITICAL (C-6) |
| Daemon lifecycle | Solid (loopback, lock, readiness, restart helper) | LOW |
| Dashboard API for portal | Real endpoints; retired-UI docs fully stale | HIGH (H-9) |
| Knowledge docs accuracy | Multiple stale/contradicting docs | HIGH (H-9) |
| PRD ledger hygiene | Reopened/in-work PRDs sitting in completed/ | HIGH (H-10) |

## Critical Findings

### C-1. Hermes, pi, and OpenClaw are claimed as supported harnesses but are stubs end-to-end
- **Claim:** README.md:238 ("thin clients for six coding harnesses, all wired simultaneously"), the harnesses-6 badge (README.md:19), harness-integration.md:20.
- **Reality:** The connector registry knows exactly three slugs: `src/cli/connector-runner.ts:62-73` (claude-code, codex, cursor). `honeycomb connect hermes` returns "Unknown harness" (`src/connectors/cli.ts:120-123`). The hermes and pi bundle entries (`harnesses/hermes/src/index.ts:1-10`, `harnesses/pi/src/index.ts:1-10`) export an `activate()` that boots a client and nothing else: no stdin, no hook binary, no shim. The shims in `src/hooks/{hermes,pi,openclaw}/` are referenced only by tests and the dashboard registry. The dashboard registry then advertises capabilities that are false in production (`src/daemon/runtime/dashboard/harness-registry.ts:137-139`).
- **Why it matters:** A user working in Hermes, pi, or OpenClaw gets zero capture, zero priming, zero recall, while the README, the badge, and the Harnesses page all say otherwise. This is the single most embarrassing launch gap.
- **Fix:** Either wire the three (registry entries, real bundle entries that invoke `runHookBinary`, install paths) or ship as "3 supported, 3 in progress" everywhere: README, badge, dashboard registry, harness-integration.md.

### C-2. 8 of 21 registered MCP tools dial daemon routes that do not exist; modify/forget 404 too
- **Claim:** mcp-and-sdk.md:26-37 (all tool clusters live), README.md:254 ("read/resolve and search/mine tools").
- **Reality:** The daemon route table (`src/daemon/runtime/server.ts:68-106`) mounts no `/api/sessions`, no `/api/agents`, no `/api/code`, and the VFS group serves `/memory/cat|grep|ls|find|classify` only (`src/daemon/runtime/vfs/api.ts:454-500`). Yet the handlers dial `POST /memory/search`, `GET /memory/read`, `GET /memory/index` (`mcp/src/handlers.ts:211-215`), `/api/sessions/*` (`mcp/src/sessions.ts:85,223`), `/api/agents/*` (`handlers.ts:233-237`), and `POST /api/memories/feedback` (`handlers.ts:207`). All 404. Separately, `memory_modify`/`memory_forget` send `PATCH/DELETE /api/memories` while the daemon wired `POST /api/memories/:id/modify|forget` (`handlers.ts` vs `src/daemon/runtime/memories/api.ts:706,725`), so the audited mutation surface fails after passing its reason gate. Every seam test passes because `tests/mcp/*` drive a fake seam that 200s any path; the live itest proves `tools/list` only. Verified-live tools: 10 of 25.
- **Why it matters:** The flagship browse trio (`honeycomb_search/read/index`) is exactly what the README and the Hermes shim message advertise. An agent-facing tool that always errors poisons trust in the whole toolset.
- **Fix:** Point the browse trio at the real VFS routes, fix modify/forget to the `POST /:id/...` shape, unregister or build sessions/agents/feedback, and add one live `tools/call` conformance test per registered tool against an assembled daemon. That missing test class is precisely how this shipped.

### C-3. The pollinating loop can never fire in production
- **Claim:** README.md:94 and 266 ("the pollinating loop... Working today"), pollinating-loop.md ("every session-summary write increments that counter"), PRD-009 AC-1, PRD-026 AC-2.
- **Reality:** `incrementPollinatingCounter` (`src/daemon/runtime/pollinating/trigger.ts:310`) has no production caller; only its unit test and a live itest that self-increments call it. The summary worker never touches it. There is no periodic maintenance tick; `checkAndEnqueuePollinating` (`trigger.ts:366`) is reachable only via the manual `POST /api/diagnostics/pollinate`, which returns `below_threshold` forever because nothing accumulates tokens (`trigger.ts:394-397`). The worker, strategies, and control-plane apply path are all real and tested. The ignition wire was never run.
- **Why it matters:** "Memory gets sharper over time" is a headline differentiator. It is currently a display-case item.
- **Fix:** One increment call in the summary worker write path plus a periodic tick. Then make PRD-026's live proof drive the real wiring instead of hand-cranking the counter.

### C-4. Capture failures are silent end-to-end: fail-soft is also fail-invisible
- **Claim:** README.md:203 ("soft-failing so a capture error never breaks your agent's turn"), session-capture.md:46.
- **Reality:** Four stacked layers. (1) Batching is default-on (`src/daemon/runtime/capture/capture-config.ts:63`) and `handleCapture` returns 201 before the write is durable (`capture-handler.ts:292-317`); a flush failure after the ack is only visible through an optional logger. (2) The production assembly passes no logger into the capture seams (`src/daemon/runtime/assemble.ts:879-891`), so `capture.flush.failed`, `capture.batch_insert.failed`, and friends are `undefined?.event(...)` no-ops. (3) The hook client maps transport failure to `{status: 0}` with no log (`src/hooks/shared/daemon-client.ts:120-124`) and `runCapture` returns `{ok: true}` even then (`src/hooks/shared/capture.ts:89-105`). (4) The hook binary exits 0 silently on any crash (`src/hooks/binary.ts:185-190`). A stopped daemon or flaky Deeplake write means turns vanish permanently with no counter, no log, no notification. PRD-029 built degradation observability for recall; capture has no equivalent.
- **Why it matters:** Capture is the root of the whole value chain. Silent loss here surfaces weeks later as "recall is empty" with nothing to debug.
- **Fix:** Wire the logger in `assemble.ts` (one-line class of fix), add a dropped-events counter surfaced on `/health` and the dashboard KPIs, and keep the fail-soft posture.

### C-5. The Tier-2 to Tier-3 "deterministic join" is broken in production
- **Claim:** README.md:219 ("key to summary to raw is a pointer walk down three Deeplake tables"), three-tier-memory-strategy.md:107-109.
- **Reality:** Capture stamps `sessions.path` with the harness transcript path (`src/hooks/binary.ts:138-144`). The summary worker writes the memory row at `path = /summaries/<user>/<sessionId>.md` (`src/daemon/runtime/summaries/worker.ts:619, 671-679`). Depth-2 resolve then queries `sessions WHERE path = '<the /summaries/... ref>'` (`src/daemon/runtime/memories/resolve.ts:141-162`), which matches nothing, returning `{found: true, turns: []}`. The module docstring contradicts itself (`resolve.ts:134-139`), and the unit test fabricates sessions rows whose path IS `/summaries/alice/s1` (`tests/daemon/runtime/memories/resolve.test.ts:211-234`), hiding the bug.
- **Why it matters:** Tier-3 zoom is the "ground truth" leg of the core pitch. In a real install the last hop silently returns an empty transcript.
- **Fix:** Extract the sessionId from the summary path and map back to the capture path, or persist the capture path on the summary row. Replace the fixture with one that mirrors real writer behavior.

### C-6. The one-command install ends on a dead browser tab by default
- **Claim:** README.md:115 (installer "opens the dashboard (Hive portal at 127.0.0.1:3853)"), install.sh:11-12 ("leave the user on a running dashboard, OR tell them in ONE plain sentence why not").
- **Reality:** The installer's default product set is `honeycomb,doctor`; hive is not in it (`scripts/install/install.sh:411`, `install.ps1:341`) and is not an npm dependency. Yet `honeycomb install` unconditionally opens `http://honeycomb.local:3853/` falling back to `http://127.0.0.1:3853/` (`src/commands/install.ts:61-74, 236-253`). The health gate probes only :3850 (`install.ts:291-304`); nothing probes :3853. Default-path result: terminal says "Honeycomb is ready," browser says connection refused, and the promised one-sentence explanation never prints. This also strands the (real, well-built) setup APIs: device-flow login (`src/daemon/runtime/dashboard/setup-login.ts:107-169`) and Hivemind migration (`setup-migrate.ts`) have no UI on the default path.
- **Why it matters:** This is the first thing every new user touches, and it is the README's headline promise.
- **Fix:** Add hive to the default product set, or probe :3853 before opening and print honest fallback copy. Pick one before launch.

## High Findings

### H-1. README says embeddings are opt-in; code and PRD-025 say default-on
- **Claim:** README.md:269 ("Embeddings are opt-in. Recall runs the lexical BM25 path by default").
- **Reality:** `HONEYCOMB_EMBEDDINGS` is opt-OUT: unset means enabled (`src/daemon/runtime/services/embed-client.ts:169-176`, comment at 44-46). The real embed attachment is wired as both capture and store seams (`assemble.ts:867, 980`). PRD-025 (semantic-recall-default, completed, QA-passed 2026-06-21) exists precisely to make semantic the default. The README describes the pre-PRD-025 world.
- **Why it matters:** The public front door contradicts a completed PRD and undersells the headline feature.
- **Fix:** Rewrite the README bullet: embeddings on by default, `HONEYCOMB_EMBEDDINGS=false` to opt out, lexical fallback silent.

### H-2. The README's recall@5 0.72-0.78 is the retired high-water mark, not the committed number
- **Claim:** README.md:96. Repeated in hybrid-sql-vector-rationale.md:95 and PRD-046's index.
- **Reality:** The range comes from one hot 2026-06-22 live A/B run before the eval was stabilized (`library/knowledge/private/ai/deeplake-hybrid-record-operator-report.md:125-127`). The committed, enforced baseline is recall@5 = 0.583 (4 zero-variance runs, `eval/recall-baseline.json`), graded 06-24 run 0.639, ADR-0001 re-run 0.611, floor 0.55. PRD-047's own index says "committed baseline (recall@5 ~ 0.583)".
- **Why it matters:** Quoting the best run ever recorded in launch marketing invites a public benchmark embarrassment. The defensible number is 0.58-0.64.
- **Fix:** Publish the committed baseline or re-measure and update the fixture first.

### H-3. "Distillation off by default" and "three-tier working today" cannot both be true as written
- **Claim:** README.md:266 vs README.md:270; memory-pipeline.md:62 ("no model spend without explicit opt-in").
- **Reality:** The Tier-2 summary worker starts unconditionally (`src/daemon/runtime/summaries/job.ts:431-439`, `assemble.ts:2471, 2604-2607`) and shells out to the host agent's CLI (`claude -p`, `codex exec`) every 20 messages and at session end. That is real model spend on the operator's harness account, on by default. Meanwhile the fact-distillation pipeline genuinely defaults off (`src/daemon/runtime/pipeline/config.ts:146-148`), so the durable memories table gets no pipeline rows, no durable Tier-1 keys, no graph on a default install. If the host CLI is missing, the gate fails and nothing is written, visible only as a daemon log line (`worker.ts:649-660`, `job.ts:403-409`).
- **Why it matters:** The README's two bullets resolve in a way it does not disclose: always-on host-CLI spend, durable tier empty. Users will be surprised in both directions.
- **Fix:** Say it straight: session summarization runs by default using your harness CLI; the deeper fact/graph pipeline is opt-in. Fix memory-pipeline.md:74 too (doc says `graph.extractionWritesEnabled` defaults on; code says false at `pipeline/config.ts:113-118`).

### H-4. Knowledge graph is inert on a default install while listed under "Working today"
- **Claim:** README.md:95, 266.
- **Reality:** All automatic write paths are off by default: `HONEYCOMB_PIPELINE_ENABLED` false, `graph.enabled` false, `graph.extractionWritesEnabled` false (`src/daemon/runtime/pipeline/config.ts:109-111, 146`). The inline linker only links to entities that already exist (`src/daemon/runtime/ontology/entity-model.ts:504`) and runs from the gated pipeline. With extraction off, no entities are ever created. The substrate itself (supersession as append-only version bump, provenance columns, conflict detection) is real and matches the docs (`src/daemon/runtime/ontology/supersede.ts:9-58`, `src/daemon/storage/catalog/knowledge-graph.ts:136-155`).
- **Why it matters:** "Working today" implies working out of the box. Combined with C-3, both self-maintaining-memory headliners are display-case items by default.
- **Fix:** Move knowledge graph and pollinating loop to the "opt-in / by design" README section, or flip defensible defaults on.

### H-5. Skillify: session-end trigger dropped, gate is Claude-CLI-only, and the scope config is dead code with a privacy edge
- **Claims:** skillify-pipeline.md (session-end fires unconditionally; per-agent gate matrix; scope me/team). PRD-016 AC-1, PRD-018 AC-1.
- **Reality:** (a) The hook posts `intents: ["...", "skillify"]` (`src/hooks/shared/session-end.ts:112`) but the production session-end handler enqueues only a summary job and drops the skillify intent (`src/daemon/runtime/capture/attach.ts:219-263`). Only the mid-session stop counter path enqueues skillify. (b) The gate is one hardcoded `{command: "claude", args: ["--print"]}` (`src/daemon/runtime/skillify/worker.ts:244-249`); the documented codex/cursor/hermes gate matrix and env knobs do not exist anywhere in src/. On non-Claude machines the spawn ENOENTs and skillify silently never produces skills. (c) The scope config store (`src/daemon-client/skillify/config.ts`) has zero production importers; `POST /api/skills/scope` is a no-op ack (`propagation-api.ts:280-285`); `MineScope.teamAuthors` is never populated and there is no `author = me` filter at all (`worker.ts:355-358`, `miner.ts:186-192`), so mining sweeps every author in the workspace partition regardless of the documented default `scope=me`. Install target is hardcoded global (`worker.ts:383`), not the documented project default.
- **Why it matters:** (c) is a privacy-posture mismatch in team workspaces, not just doc drift. (b) silently zeroes a headline feature for Codex/Cursor-only users.
- **Fix:** Handle the skillify intent in `attach.ts`, wire or delete the scope config (and add the me-filter), and either implement the gate matrix or document Claude-CLI as a requirement for skill mining.

### H-6. Skill propagation cannot deliver the README's own example back into Cursor, and never fires for the stub harnesses
- **Claim:** README.md:245 ("A skill mined while you were in Cursor is auto-pulled and ready in Claude Code on your next session"), and the reverse implied by "all wired simultaneously."
- **Reality:** Auto-pull at session start is genuinely wired and fail-soft (`src/hooks/runtime.ts:200`, `session-start-seams.ts:138-142`). But the daemon fan-out roots are `~/.claude/skills`, `~/.codex/skills`, `~/.agents/skills`, `~/.hermes/skills`, `~/.pi/agent/skills`; there is no `~/.cursor/skills` target (`src/daemon-client/skillify/install.ts:665-668`). Cursor-to-Claude works; Claude-to-Cursor has no landing zone. Hermes/pi/OpenClaw never fire session start at all (C-1). Install-time skill symlinking is vacuous: all connectors receive `skillSources: []` (`connector-runner.ts:62-73`).
- **Fix:** Add the Cursor fan-out root, populate skillSources, and scope the README example to what works.

### H-7. Codebase graph query surface: agents get empty strings, MCP gets 404s, documented CLI verbs do not exist
- **Claim:** codebase-graph.md query surface (graph/index.md, find, impact, neighborhood, tour via the memory mount; `graph diff|history|init|pull`); README.md:97 ("queryable for impact and neighborhood").
- **Reality:** The renderer is complete (`src/daemon/runtime/codebase/query.ts:137-180`), but the hook runtime calls `runPreToolUse` with no VFS, defaulting to `createFakeVfsIntercept()` which intercepts the read and returns `""` (`src/hooks/runtime.ts:258`, `src/hooks/shared/pre-tool-use.ts:94`, `contracts.ts:645-657`). Worse than inert: a `cat graph/impact/foo` is replaced with empty output, a false no-dependents signal. The MCP code tools are double-dead: gated behind a `graphBuilt` flag nothing ever sets (`mcp/src/index.ts:88, 204-210`) and dialing `/api/code/*` routes that are not mounted (`mcp/src/handlers.ts:241-247` vs `server.ts:68+`). The daemon mounts exactly `POST /api/graph/build` and `GET /api/graph` (`src/daemon/runtime/codebase/api.ts:304-347`); `graph diff|history|init|pull` and the post-commit hook are documented fiction, `pullSnapshot` has zero callers, and auto-build is opt-in via `HONEYCOMB_CODEBASE_GRAPH_AUTO_BUILD`. Extraction itself is the bright spot: all nine languages real (`src/daemon/runtime/codebase/extract.ts:64-99`).
- **Fix:** Inject the real `DeepLakeFs` intercept (or stop intercepting), fix or drop the MCP code tools, and cut codebase-graph.md down to the two routes that exist.

### H-8. `honeycomb dashboard` opens nothing; `honeycomb update` is a stub
- **Claim:** README.md:167 (`honeycomb dashboard # open the dashboard (Hive portal, :3853)`); cli-command-architecture.md:56 (update self-updates).
- **Reality:** The dashboard verb runs a headless data-source render against :3850, discards it, and prints "dashboard: launched (daemon reachable)"; no browser, no URL, :3853 never touched (`src/commands/local-handlers.ts:129-138`, `src/dashboard/launch.ts:135-140`). The portal-aware `openDashboard()` (`launch.ts:166-172`) is wired to nothing. This is also a silent regression against completed PRD-021d AC-3 with no reconciliation note. `runUpdateCommand` prints "self-update is performed by the bundled bin (deferred assembly)" and exits 0 doing nothing (`local-handlers.ts:161-170`).
- **Fix:** Wire the verb to `openDashboard()` plus the existing opener from `install.ts`, or fix README:167. Implement or hide `update`.

### H-9. Four knowledge docs describe a product that no longer exists
- **dashboard-architecture.md** documents the retired in-daemon React dashboard at `:3850/dashboard`, `host.ts`, `renderShell`, eight surfaces. All deleted; the daemon registers no dashboard route (`server.ts:68-106`; `assemble.ts:933-936` says the SPA is served by hive). Doc is stamped "Active."
- **install-and-onboarding.md:69, 79-82** documents the old `:3850/dashboard` open and `mountDashboardHost`. The verb opens :3853 now.
- **cli-command-architecture.md** quotes a 445-line if-chain `main()`; the real `src/cli/index.ts` is 88 lines routing through `createDispatcher()`. It cites `src/commands/auth.ts` and `session-prune.ts`, neither of which exists, and shows raw SQL in the CLI, contradicting the repo's own thin-client invariant. Its verb table is missing 14 real verbs. (`cli-dispatcher.md` is the accurate one.)
- **hook-lifecycle.md:81-92** documents a nine-step session start; five steps are explicit no-ops in the production seam (`src/hooks/shared/session-start-seams.ts:108-132`): org-token heal, auto-update, ensure-tables, placeholder summary, graph pull.
- Also stale: retrieval.md:79 (recency default superseded by live per-class decay, `src/daemon/runtime/recall/config.ts:178-190`), session-priming-architecture.md:115-118 (claims 047c/047d composition the prime does not have) and :170 (cites nonexistent `src/cli/install-cursor.ts`), mcp-and-sdk.md (package name `@honeycomb/sdk` is wrong; claims an `/mcp` streamable-HTTP endpoint that is never served, `mcp/src/index.ts:113-123` opt-in with no caller, `server.ts:104` classification only).
- **Fix:** One doc-truth pass over the frontend/, operations/, integrations/ folders before launch. These docs are the onboarding surface for contributors; right now they actively misdirect.

### H-10. PRD ledger hygiene: reopened and in-work PRDs filed under completed/
- PRD-019's own index says "In Work (reopened 2026-06-22)" and "moved back to in-work/" but the folder sits in `completed/` and only Codex landed since the reopen; the re-closure has no closing evidence (`library/requirements/completed/prd-019-harness-integrations/prd-019-harness-integrations-index.md:3-15`).
- PRD-065's index says `Status: In Work` with an open AC-3 residual, filed under `completed/` (`prd-065-doctor-go-live-index.md:3, 37, 55`).
- PRD-046 is completed with AC-6 ("regression below the bar fails") advisory-only: `eval/prime-baseline.json` has `placeholder: true` and `src/eval/prime.ts:436` forces the gate green.
- **Why it matters:** The requirements ledger is the thing this audit traces against. When completed/ lies, everything downstream inherits the lie.
- **Fix:** Move 019 and 065 to in-work/ (or close them with evidence), and either enforce the prime-eval gate or annotate PRD-046 AC-6 as partially met with the 046f follow-up linked.

### H-11. OpenClaw plugin manifest promises tools and commands the binary does not contain
- **Claim:** `harnesses/openclaw/openclaw.plugin.json` declares tools `honeycomb_search/read/index`, commands `honeycomb_login/capture/whoami/version`, `memoryCorpusSupplements: true`.
- **Reality:** The built `harnesses/openclaw/dist/index.js` exports only register/activate/tuning helpers; `register()` (`harnesses/openclaw/src/index.ts:64-67`) registers no hooks, tools, or commands. `honeycomb_login` appears nowhere in the codebase. The documented `agent_end` batch-capture slice (`src/hooks/openclaw/shim.ts:47-128`) is never imported by the OpenClaw entry, so it is not in the dist bundle.
- **Why it matters:** This is a manifest making promises to the OpenClaw host and ClawHub reviewers that the binary cannot keep. Public-directory rejection or worse.
- **Fix:** Strip the manifest down to reality or finish the wiring before submitting anywhere.

## Medium Findings

### M-1. "BM25" is marketing; the live lexical arms are plain ILIKE substring matches
README.md:96, 229 and retrieval.md:52 say BM25 (with an index-conditional branch). All four lexical arm builders emit `ILIKE '%term%'` with no rank expression (`src/daemon/runtime/memories/recall.ts:320-433`); `src/daemon/runtime/recall/collection.ts:162` admits it. RRF itself is real and hand-rolled (`recall.ts:142, 462-523`), matching ADR-0001; the native hybrid operator is correctly unwired. Fix: say "lexical + semantic fused by RRF" and drop the BM25 label, or actually build the FTS branch.

### M-2. Recall's degraded flag has a blind spot: storage-side arm failures masquerade as "no matches"
Every arm error is swallowed into `[]` with no log (`recall.ts:910-918, 1044-1048`). `degraded` only covers the embed path; if Deeplake itself fails while embeds are healthy, the response is `{hits: [], degraded: false}` (design is fail-soft per PRD-047 D-7, deliberately). Suggest a per-arm error counter or `armErrors` field. Observability only, keep the fail-soft.

### M-3. Capture guards partially unwired
The plugin-enabled check and the `HONEYCOMB_WORKER` recursion marker are implemented in the gate (`src/shared/capture-gate.ts:129-141`) but production builds the gate env from `HONEYCOMB_CAPTURE` only (`src/hooks/runtime.ts:193`). The recursion defense currently holds via a single env var; the designed second layer is set-and-never-read. PRD-005 AC-3/AC-4 are partial.

### M-4. SDK ships no TypeScript declarations
The published `sdk/` contains four .js entries and no `.d.ts`; the exports map has no types condition. README calls it a "TypeScript SDK." Core claims otherwise verified: fetch-only, browser-safe, react/ai as untouched optional peers, exports map matches (`src/sdk/client.ts:82-249`). No tests for vercel.js/openai.js. Fix: emit and ship declarations.

### M-5. Installer nits: PowerShell duplicate-token bug, dead alias tables, stale bundle shippable
`ConvertTo-CanonicalProducts` has two identical `'hive'` switch labels; PowerShell runs both, so `--products=honeycomb,hive` normalizes to `honeycomb,hive,hive` (duplicate telemetry and persisted state) (`scripts/install/install.ps1:245-257, 778-791, 908`). Both dialects promise pre-rename alias acceptance that a rename script clobbered into identity mappings (install.sh:297-308, 675; install.ps1:240-244, 555). The retired 673 KB `daemon/dashboard-app.js` can still ship in a workstation-published tarball: `files` packs all of `daemon/`, esbuild neither builds nor cleans it, `pack-check.mjs:43-48` no longer forbids it. Fix all three; the pack-check forbid is one line.

### M-6. Session priming verified solid, one caveat
Budget cap enforced at 800 tokens with whole-entry drops (`src/daemon/runtime/summaries/prime-digest.ts:45, 196-210`), prime injected only on session-start (`src/hooks/runtime.ts:244-251`), fail-soft on cold repo/dead daemon. Caveat: once-per-session is enforced by the harness firing the event once; no daemon-side dedup if a harness re-fires. Low risk, worth a note.

### M-7. Codex gaps inside the wired three
No session-end event mapping (`src/connectors/codex.ts:30-45`), no periodic summarizer found, so Codex summary spawn is undemonstrated (PRD-019c AC-1 partial). The "detached setup process" (019c AC-4) is a descriptor naming a file that does not exist (`src/hooks/codex/shim.ts:60-67`). Cursor's "first-party extension" is an explicitly-deferred shell with no manifest (`harnesses/cursor/extension/extension.ts:25-27`).

### M-8. AGENTS.md identity sync is a no-op fan-out
The renderer is real (`src/daemon/runtime/services/harness-sync.ts`) but production wiring passes `harnessTargets: []` (`assemble.ts:2075`) and no caller supplies targets. harness-integration.md:103 claims live sync into `~/.claude/CLAUDE.md` and the pi AGENTS.md block.

### M-9. Test-coverage shape enabled the worst bugs
MCP tools tested only against a fake seam that 200s everything; no live tools/call per tool (C-2). Resolve tested against a fabricated fixture that mirrors the bug, not the writer (C-5). Pollinating live itest hand-cranks the counter the product never increments (C-3). Integration tests exercise only the Claude Code shim end-to-end. The pattern: unit tests prove components, nothing proves assembly. One assembled-daemon conformance suite would have caught C-2, C-3, C-5, H-7.

### M-10. Misc doc/code drift worth one pass
`secret_exec` via MCP coerces 202 job responses to `[REDACTED]`, losing the jobId so results are unretrievable (`mcp/src/handlers.ts:101-110`). `memory_list` advertises a `prefix` arg it deliberately ignores (`handlers.ts:151-161`). `connect` is routable but absent from VERB_TABLE and `--help`. Tool-count comments disagree (`mcp/src/tools.ts:5` says ~27, `contracts.ts:22` says ~25, actual 25/21). Skillify doc constants drift (stop counter 10 in code vs 20 in doc, `turn-counters.ts:61`; fan-out root lists disagree between two docs). The deploy-install-site guard test documented in install-and-onboarding.md:53-61 exists nowhere anymore after the workflow moved to the-apiary (workflow itself verified intact there); the regression lock evaporated in the move.

## Low Findings

- **L-1.** README embeds `assets/screenshots/dashboard.png`; the directory is empty (the HTML comment above it even says "screenshot pending"). Broken image at the top of the public README (README.md:146-147).
- **L-2.** Hivemind "detection" is `existsSync(~/.hivemind)` directory presence, not process detection (`setup-state.ts:66-69`). A leftover dir triggers the migration wizard. Migration machinery itself is solid (durable marker, backup, rollback).
- **L-3.** Capture row IDs use `Math.random()` (`capture-handler.ts:572-575`); `crypto.randomUUID()` is free.
- **L-4.** Per-turn summary/skillify counters are in-memory; daemon restart slips a threshold (`turn-counters.ts:15`). Documented, acceptable, worth a doc line.
- **L-5.** References gate violated for the stub harnesses: shims cite `references/hermes/` and `references/pi/` which do not exist (`src/hooks/hermes/shim.ts:14`, `src/hooks/pi/shim.ts:21`); only claude-code/codex/cursor reference dirs exist.
- **L-6.** Dead PRD hyperlinks: PRD-050 ACs link the deleted `host.ts`; PRD-050 AC-2's "no second daemon" premise is now inverted by the portal cutover with no reconciliation note. PRD-007 and retrieval.md cite line numbers that have drifted hundreds of lines.
- **L-7.** npm files allowlist ships dead hermes/pi bundles and the inert openclaw dist, inflating the package with non-functional artifacts (all paths exist, so no broken-publish risk).

## What checks out (verified, so nobody re-litigates it)

- Daemon lifecycle: loopback-only fail-closed bind, lock-before-bind single instance, service-preferred start with spawn fallback, restart helper, ADR-0007 readiness (embed warm never blocks). Auto-start on storage verbs works.
- Device-flow login end to end, token never in a response body, credentials at `~/.deeplake/credentials.json` 0600.
- Installer bootstrap: Node/npm detection and install in both dialects, manifest pinning with safe-shape validation, idempotent re-run, `--no-doctor` and Doctor service registration real, SHA256SUMS generated and served (`site/install/build.mjs:106-127`).
- Recall pipeline internals: RRF, rerank seam, semantic dedup, class-aware recency decay, token-budget MMR, honest degraded flag on the embed path, enforced recall eval with committed baseline.
- Three-tier storage artifacts all real; depth-1 resolve is a genuine guarded SELECT; Tier-1 key distillation has a real grounding guard.
- Skillify mining core: durable queue, per-project lock, KEEP floor enforced code-side, deterministic secret redaction before anything leaves the session (better than the docs promise). Append-only skill versioning with provenance, watermark-to-oldest.
- Knowledge-graph substrate: supersession as two-append version bump, required-reason edges, control-plane risk routing.
- Codebase graph extraction: all nine claimed languages genuinely wired via tree-sitter WASM grammars.
- CLI: 32 real verbs, structural help-coverage test, storage verbs all through the daemon, clean Windows exit. 12 of the README's 13 verbs are real and functional (dashboard is the exception).
- SDK core: fetch-only, browser-safe, retry semantics, typed errors, session-group header stamping.

## Traceability: completed-PRD acceptance criteria

Condensed to core-functionality PRDs. MET means traced to real code with tests; PARTIAL and MISSING carry the finding reference.

| PRD | Criterion (short) | Status | Evidence / finding |
|---|---|---|---|
| 004 daemon-runtime | /health + /api/status; queue lease/reap; runtime-path 409 | MET | server.ts:331-383, 410-424; middleware order |
| 005 capture-intake | One row per event, JSONB, append-only | MET (caveat) | capture-handler.ts:283-302; buffered loss window, C-4 |
| 005 | 768-dim embed non-blocking, null on fail | MET | capture-handler.ts:639-653 |
| 005 | Bypass flag / plugin-disabled skip | PARTIAL | plugin check never wired, M-3 |
| 005 | Recursion guard | PARTIAL | holds via env var only, marker unread, M-3 |
| 005 | Capture error exits cleanly | MET (fail-silent) | C-4 |
| 006 memory-pipeline | Extraction, decision, controlled writes, shadow mode, graph non-fatal | MET | pipeline/extraction.ts, decision.ts, controlled-writes.ts, graph-persist.ts |
| 007 retrieval | Hybrid arms + RRF + dedup; tenancy; currentness; response contract | MET | recall.ts:462-523, 2204-2238; scope-clause.ts |
| 008 knowledge-graph | Inline linker sync/no-create; supersession; reasoned edges; risk routing | MET (gated off by default) | supersede.ts:16-38; H-4 |
| 009 pollinating | Counter crosses threshold, job queued | MISSING | no production increment, C-3 |
| 009 | Destructive ops to control plane | MET | runner.ts, control-plane.ts |
| 009 | `--compact` full-graph pass | MISSING | endpoint ignores mode, pollinating/api.ts:246-249 |
| 014 codebase-graph | Deterministic hash; call resolution; drift refusal | MET | hash.ts:61-75, push-pull.ts:69-85 |
| 014 | Agent reads graph/impact via mount | PARTIAL | renderer real, hook wiring is the empty-string fake, H-7 |
| 016 skillify | Stop-counter + session-end trigger | PARTIAL | stop-counter live, session-end intent dropped, H-5 |
| 016 | KEEP gate quality bar | PARTIAL | floor enforced; no existing-skills context in prompt, H-5 |
| 016 | Append-only skill rows + watermark | MET | skills-write.ts, watermark.ts |
| 018 team-skill-sharing | Publish with configured me/team scope | PARTIAL | scope config dead code, H-5 |
| 018 | Auto-pull at session start; fan-out symlinks | MET | session-start-seams.ts:138-142; install.ts:665-668 (no Cursor root, H-6) |
| 019 harness-integrations | Setup wires; events normalized; parity rows | PARTIAL 3/6 | C-1; index itself says reopened, H-10 |
| 019 | MCP tools appear in native tool lists | MISSING 0/6 | no connector writes MCP registration, C-2 context |
| 019d/e | MCP server surface; SDK subpath exports | MET (as components) | tools.ts, esbuild.config.mjs:293-311; liveness gaps are C-2 |
| 020a CLI | Parse/route, prune paired delete, storage via daemon, skill scope, device flow | MET | dispatch.ts, sessions.ts, cli/auth.ts |
| 020a | Self-update (FR-10) | MISSING | stub, H-8 |
| 020b/021d dashboard verb | Opens viewable dashboard | REGRESSED | verb opens nothing, H-8 |
| 021 go-live | Storage verbs loopback; daemon start/status; ensure-on-demand; logs ring | MET | dispatch.ts:164-176, daemon.ts:90-165 |
| 022 data-access | Recall over HTTP; store recallable; session headers; SDK wired | MET | memories/api.ts:519, sdk/client.ts |
| 022 | Modify/forget reasoned + audited on every surface | PARTIAL | MCP path 404s, C-2 |
| 023 deeplake-connect | Shared credentials, headless token login, whoami/workspaces | MET | cli/runtime.ts:444-472 |
| 025 semantic-default | Embeddings default-on; vectors on rows; honest degraded | MET (README contradicts, H-1) | embed-client.ts:169-176; assemble.ts:867, 980 |
| 026 pollinating-enablement | Enable flag flips ack; counter accumulates in prod; live pass proven | PARTIAL | flag yes; counter test-only, C-3 |
| 027 recall eval | Enforced recall@5/MRR/nDCG baseline | MET | eval/recall-baseline.json, scripts/eval-recall.mjs |
| 029 degradation-observability | degraded flag, structured event, /health reasons, dashboard badge | MET | memories/api.ts:367-403, assemble.ts:352, 543 (badge source only in retired bundle, M-5) |
| 045 daemon-wiring-closeout | Routes live; reconciliation discipline | MET / VIOLATED-since | AC-7 discipline broken again by portal cutover, H-9/L-6 |
| 046 session-priming | Worker wired; keys; prime assembly; CC+Cursor hooks | MET | assemble.ts:2599-2610, prime-digest.ts |
| 046 | Priming eval regression gate fails on drop | PARTIAL | placeholder baseline forces pass, H-10 |
| 047 retrieval-quality | A/B recorded; rerank; dedup; recency; budget/MMR; graded eval; fallback | MET | recall.ts:2249-2362, ADR-0001 |
| 050 quick-install | One command lands on dashboard | MISSING on default path | C-6 |
| 050 | Setup APIs, device flow on page, migration, telemetry-once | MET (API) / no UI by default | setup-login.ts, setup-migrate.ts, C-6 |
| 065 doctor-go-live | Blessed version; Doctor bootstrap; OTLP confirmed | PARTIAL | AC-3 open residual; status/folder mismatch, H-10 |

## Fix order (my call)

1. C-6 install dead tab (one decision: bundle hive or probe-and-explain)
2. C-2 MCP routes (small diffs in mcp/src/handlers.ts) plus one live tools/call conformance test
3. C-5 resolve join (path mapping) plus honest fixture
4. C-4 wire the capture logger + dropped-events counter
5. C-3 pollinating increment + tick
6. C-1 decision: wire the three harnesses or reduce the claim everywhere (README, badge, dashboard registry, ClawHub manifest H-11)
7. H-1/H-2/H-3/H-4 README truth pass (embeddings default, recall number, working-today list, distillation wording)
8. H-5/H-6/H-7 skillify intent + scope config + VFS intercept + Cursor fan-out root
9. H-9 knowledge-doc truth pass; H-10 PRD ledger moves
10. Mediums as a fast-follow batch; M-9 (assembled-daemon conformance suite) is the structural fix that keeps this class of bug from shipping again
