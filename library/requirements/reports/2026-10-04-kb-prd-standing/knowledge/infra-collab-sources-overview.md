# Wave 1a standing: infrastructure, collaboration, sources, overview

Shard: `library/knowledge/private/infrastructure/`, `collaboration/`, `sources/`, and `overview.md`.
Branch context: `legion/kb-sotu-and-prd-lifecycle`. Read-only. No doc or source edits in this pass.
Date: 2026-10-04.

Defect count: 28. Holds are listed after the defects so a later pass does not reopen them.

ASCII hyphens only. Verdicts: FALSE, STALE, HOLE, HOLDS. Actions: REVISE, ADD, LEAVE, REMOVE.

## Coverage

| File | Page action |
|---|---|
| `library/knowledge/private/infrastructure/monorepo-build-release.md` | REVISE |
| `library/knowledge/private/infrastructure/npm-publishing.md` | REVISE |
| `library/knowledge/private/infrastructure/release-automation.md` | REVISE |
| `library/knowledge/private/overview.md` | REVISE |
| `library/knowledge/private/sources/source-lifecycle.md` | REVISE |
| `library/knowledge/private/collaboration/asset-sync-substrate.md` | REVISE |
| `library/knowledge/private/collaboration/team-skills-sharing.md` | REVISE |
| `library/knowledge/private/collaboration/fleet-observation-and-on-demand-skills.md` | LEAVE the design body (D-28). REVISE only the status line (D-27). |

Related links inside these eight pages resolve to sibling markdown files that exist under `library/knowledge/private/`. No missing sibling page was found. `fleet-observation-and-on-demand-skills.md` points at a Queen path that is absent from this checkout (D-28).

## Defects

### D-01

- Quote: "Because esbuild cannot bundle native binaries into a pure JavaScript module, these dependencies are declared as `external`" and the fenced block starting `await build({ entryPoints: Object.fromEntries(ccAll.map(h => [h.out, h.entry])),` with `outdir: "harnesses/claude-code/bundle"` and native `tree-sitter` / `tree-sitter-typescript` externals, cited as `esbuild.config.mjs` lines 52-82. Later: postinstall "ensures the correct binary prebuilds for `tree-sitter` and the language grammars are download-resolved, and handles potential compilation fallback steps."
- Doc: `library/knowledge/private/infrastructure/monorepo-build-release.md:107-143` and `:228`
- Grounding: `esbuild.config.mjs:52-57` is `VERSION_DEFINE` (version, referral, PostHog). `esbuild.config.mjs:59-71` sets `TREE_SITTER_EXTERNAL = ["web-tree-sitter", "tree-sitter-wasms"]`. Claude Code builds at `esbuild.config.mjs:197-206` with `THIN_CLIENT_EXTERNAL` (`["node:*"]` at `:97`). The `ccAll` / native `tree-sitter-<lang>` block is ABSENT. `scripts/ensure-tree-sitter.mjs:4-9` and `:73` check WASM grammars and compile nothing.
- Verdict: FALSE
- Action: REVISE

### D-02

- Quote: the fenced `process.env.HONEYCOMB_*` define list (`HONEYCOMB_TRACE_SQL`, `HONEYCOMB_INDEX_MARKER_*`, `HONEYCOMB_SEMANTIC_*`, `HONEYCOMB_GREP_LIKE`, and the rest), cited as `esbuild.config.mjs` lines 371-403.
- Doc: `library/knowledge/private/infrastructure/monorepo-build-release.md:187-220`
- Grounding: `esbuild.config.mjs:241-246` knobs are only `HONEYCOMB_DEBUG`, `HONEYCOMB_TRACE`, `HONEYCOMB_QUERY_TIMEOUT_MS`, `HONEYCOMB_STATE_DIR`. Line 371 is the `cli-core` bundle, not that define map. The long semantic/index list is ABSENT.
- Verdict: FALSE
- Action: REVISE

### D-03

- Quote: the fenced `stub-unused-child-process` plugin, cited as `esbuild.config.mjs` lines 404-426, including the wiki-worker / ClawHub comment.
- Doc: `library/knowledge/private/infrastructure/monorepo-build-release.md:157-181`
- Grounding: `esbuild.config.mjs:271-291` still stubs `node:child_process` with the same no-op exports. The file ends at line 402, so lines 404-426 are ABSENT. The current comment does not mention the wiki-worker.
- Verdict: STALE
- Action: REVISE

### D-04

- Quote: fenced `SCALAR_TARGETS` cited as `scripts/sync-versions.mjs` lines 13-25, and the marketplace loop cited as lines 63-88.
- Doc: `library/knowledge/private/infrastructure/monorepo-build-release.md:40-82`
- Grounding: `scripts/sync-versions.mjs:19` is `SOURCE`. `SCALAR_TARGETS` is `:23-29` and the five paths match the quote. The marketplace loop is `:87-111` and the logic matches. The cited ranges are the wrong lines.
- Verdict: STALE
- Action: REVISE

### D-05

- Quote: Cursor bundle "packages the `session-start`, `capture`, `pre-tool-use`, `session-end`, and `graph-on-stop` hooks." pi "bundles background workers like the `wiki-worker` and `skillify-worker`. (The main pi extension runs raw TypeScript compiled by pi's runtime.)" OpenClaw "outputs the compiled HTTP/WebSocket plugin gateway, along with its async `skillify-worker`."
- Doc: `library/knowledge/private/infrastructure/monorepo-build-release.md:97-100`
- Grounding: `esbuild.config.mjs:167-185` aliases are `session-start.js`, `capture.js`, `pre-tool-use.js`, and for Claude/Cursor `session-end.js`. `graph-on-stop` is ABSENT. pi and hermes have no extra worker entries (`:186-187`). OpenClaw entry is `harnesses/openclaw/src/index.ts` into `harnesses/openclaw/dist` (`:252-259`), not a `skillify-worker` file. No `wiki-worker` or `skillify-worker` source file exists under `src/`. `spawnGraphPull` in `src/hooks/shared/session-start-seams.ts:127` is an empty function.
- Verdict: FALSE
- Action: REVISE

### D-06

- Quote: "`workflow_dispatch` -> rehearse the whole pipeline (`dry_run` defaults to `true`, so the manual button is safe by default; a maintainer must opt *in* to a real publish)."
- Doc: `library/knowledge/private/infrastructure/npm-publishing.md:70`
- Grounding: `.github/workflows/release.yaml:211-222` and `:230-235`: a real publish requires `event == push`, `ref_type == tag`, and dry-run input not `true`. A dispatch is never a push, so it always dry-runs even if dry-run is unchecked. The same page at `npm-publishing.md:111` already says a dispatch always rehearses. `monorepo-build-release.md:240` matches the workflow.
- Verdict: FALSE
- Action: REVISE

### D-07

- Quote: "GitHub Release, only on a real tag push *and* a real publish, using `generate_release_notes`."
- Doc: `library/knowledge/private/infrastructure/npm-publishing.md:83`
- Grounding: `.github/workflows/release.yaml:291-311` runs `scripts/release/ai-release-notes.mjs` and passes `body_path: RELEASE_NOTES.md` to `softprops/action-gh-release`. `generate_release_notes` is ABSENT in that step. `release-automation.md:64-65` matches the workflow.
- Verdict: FALSE
- Action: REVISE

### D-08

- Quote: "With Trusted Publishing the only release secret is `HONEYCOMB_POSTHOG_KEY` ... There is no token to set alongside it."
- Doc: `library/knowledge/private/infrastructure/npm-publishing.md:100`
- Grounding: `.github/workflows/release.yaml:151` uses `HONEYCOMB_POSTHOG_KEY`. `:294` uses `secrets.AWS_BEDROCK_API_KEY`. `:319` uses `secrets.DISCORD_WEBHOOK_URL`. `.github/workflows/tag-on-merge.yaml:42` uses `secrets.RELEASE_PAT`. `NPM_TOKEN` is absent from `release.yaml`, which the page gets right. The "only secret" inventory does not.
- Verdict: FALSE
- Action: REVISE

### D-09

- Quote: "It refuses to publish if the tarball is *missing* the `honeycomb` bin (`bundle/cli.js`), the daemon entry, the bundled dashboard app, the dashboard CSS..."
- Doc: `library/knowledge/private/infrastructure/npm-publishing.md:59`
- Grounding: `scripts/pack-check.mjs:72-87`. Required paths are `bundle/cli.js`, `daemon/index.js`, `harnesses/claude-code/mcp/bundle/server.js`, `assets/styles.css`, `assets/tokens/base.css`, the logo SVG, and `JetBrainsMono-Regular.woff2`. The comment at `:73-75` says the dashboard SPA moved to hive and there is no `daemon/dashboard-app.js` requirement. A repo search of `src/` finds no reader of `styles.css`.
- Verdict: FALSE
- Action: REVISE

### D-10

- Quote: "`.github/workflows/release.yaml` runs the **same full gate as `ci.yaml`** and then publishes."
- Doc: `library/knowledge/private/infrastructure/npm-publishing.md:67`
- Grounding: `release.yaml:135-158` runs `npm run ci`, `npm run build`, `audit:openclaw`, and `pack:check`. `.github/workflows/ci.yaml:137-143` also runs `pack:prepare` and `test:packed-cli`, and the workflow has Windows and macOS jobs that `release.yaml` does not run before publish.
- Verdict: FALSE
- Action: REVISE

### D-11

- Quote: "The pipeline is three workflows that hand off through the branch, the merge, and the tag." The minor row says the check stays pending until `@thenotoriousllama` comments `Approved Release`, then the branch is bumped.
- Doc: `library/knowledge/private/infrastructure/release-automation.md:23` and `:52`
- Grounding: `.github/workflows/release-approve.yaml` exists and is the comment-to-label bridge (`APPROVER: thenotoriousllama`). `release-gate.yaml:8-11` names that file. The three-workflow section does not. The other three files, the Bedrock scripts under `scripts/release/`, the ruleset context `release-gate` (`.github/rulesets/main-protection.json:33`), and commit `5bb1bb9` ("tag-on-merge consumes orphaned changesets") are present.
- Verdict: HOLE
- Action: ADD

### D-12

- Quote: "GPU-backed DeepLake storage." Mermaid node `DeepLake GPU-backed SQL + Vector`. Table cell "GPU-backed SQL + vector tables".
- Doc: `library/knowledge/private/overview.md:21`, `:45`, `:66`
- Grounding: `embeddings/src/index.ts:4-7` is a separate process. `:23-25` and `:46` load `nomic-ai/nomic-embed-text-v1.5`. `:59-60` is q8 ONNX, "Footprint/latency floor for CPU inference." `src/daemon/runtime/services/embed-client.ts:145` is `http://127.0.0.1:3851`. The same overview paragraph at `:59` already says hosted GPU use was not re-probed and names that embedder. `src/daemon/storage/vector.ts:1-12` still labels the DeepLake `<#>` operator as GPU-backed search, which is a comment, not a re-probe of hosted GPUs.
- Verdict: STALE
- Action: REVISE

### D-13

- Quote: "three harnesses (Claude Code, Cursor, Codex) ship in production today, with Hermes, pi, and OpenClaw in progress."
- Doc: `library/knowledge/private/overview.md:25`
- Grounding: `package.json:31-45` `files` includes `harnesses/hermes/bundle`, `harnesses/pi/bundle`, and `harnesses/openclaw/dist`. `esbuild.config.mjs:186-187` and `:252-259` build all three.
- Verdict: STALE
- Action: REVISE

### D-14

- Quote: "the shared registry at `~/.apiary/registry.json` when that root exists, with a legacy `~/.honeycomb` read fallback (`src/shared/fleet-root.ts`)."
- Doc: `library/knowledge/private/overview.md:59`
- Grounding: `src/shared/fleet-root.ts:134-136` joins a fleet-shared file at the fleet root. The existence switch and the legacy file name are `src/daemon/runtime/telemetry/fleet-registry.ts:64-79`: fleet `registry.json` when the fleet root directory exists, else `~/.honeycomb/doctor.daemons.json`. A legacy `registry.json` under `~/.honeycomb` is not that fallback.
- Verdict: STALE
- Action: REVISE

### D-15

- Quote: "The daemon watches connected sources and re-reads on change. Re-scans are single-flight, so overlapping requests coalesce, and content fingerprints skip files that have not changed."
- Doc: `library/knowledge/private/sources/source-lifecycle.md:54`
- Grounding: `src/daemon/runtime/sources/providers/obsidian.ts:680-695` implements `changes()` fingerprint diff. A search of `src/` for `.changes(` finds no caller. `src/daemon/runtime/assemble.ts` has no source watch loop. Single-flight coalescing of overlapping index requests is ABSENT.
- Verdict: FALSE
- Action: REVISE

### D-16

- Quote: "`GET /api/sources/:sourceId/health` reports artifact and chunk counts, the latest artifact and checkpoint timestamps, failure counts, stale or partial checkpoints, purge residue, and source-provenance graph row counts."
- Doc: `library/knowledge/private/sources/source-lifecycle.md:58`
- Grounding: route `src/daemon/runtime/sources/api.ts:208-219`. Payload built at `src/daemon/runtime/sources/lifecycle.ts:540-547`: `sourceId`, `provider`, `activeArtifacts`, `activeChunks`, `failures`, `status` (`ok` or `degraded`). `ProviderHealth` is `state` plus optional `detail` (`src/daemon/runtime/sources/contracts.ts:263-267`). Timestamps, checkpoints, purge residue, and graph row counts are ABSENT from that object.
- Verdict: FALSE
- Action: REVISE

### D-17

- Quote: "If the daemon is unavailable, the CLI falls back to config-only removal with a warning."
- Doc: `library/knowledge/private/sources/source-lifecycle.md:70`
- Grounding: `src/commands/storage-handlers.ts:209-229` posts a non-read `sources` subcommand to the daemon. `src/commands/daemon.ts:177-186` starts the daemon or returns unreachable. No CLI config-only source remover exists under `src/commands/`. `SourceRegistry.remove` at `src/daemon/runtime/sources/lifecycle.ts:411` is a daemon-side method.
- Verdict: FALSE
- Action: REVISE

### D-18

- Quote: "Native graph: the source topology is mounted into the ontology, so an Obsidian vault root becomes an entity, folders become groups, files become documents, wiki links become dependencies, headings become aspects, and paragraphs become claims." Disconnect step 3: "purge the source-owned graph rows (entities, dependencies, attributes) where `source_id` matches."
- Doc: `library/knowledge/private/sources/source-lifecycle.md:48` and `:66`
- Grounding: `src/daemon/runtime/sources/providers/obsidian.ts:416-444` builds in-memory triples (`is_a`, `contains`, `has_heading`, `depends_on`). `src/daemon/runtime/sources/lifecycle.ts:476-478` says graph triples are "carried, not persisted here". `graphTriples` has no other writer under `src/`. Paragraphs and claims are ABSENT. `purge` at `:562-567` soft-deletes `document_memories`, `document_chunk`, and `memory_artifacts`, then removes config. It does not sweep graph tables. Config is removed after the row purge, not first (`source-lifecycle.md:64`).
- Verdict: FALSE
- Action: REVISE

### D-19

- Quote: "`snapshot`/`index` must return a dedicated validation-error artifact or fail the operation. They must not return an empty successful snapshot for an invalid root"
- Doc: `library/knowledge/private/sources/source-lifecycle.md:80`
- Grounding: `index` yields a failure artifact at `src/daemon/runtime/sources/providers/obsidian.ts:622-629`. `snapshot` at `:664-665` returns `{}` with the comment "return an empty snapshot."
- Verdict: FALSE
- Action: REVISE

### D-20

- Quote: "The chunking and worker knobs live under `pipeline.*` in `agent.yaml`."
- Doc: `library/knowledge/private/sources/source-lifecycle.md:110`
- Grounding: `agent.yaml` has an `inference:` block only. No `pipeline:` key. `src/daemon/runtime/sources/document-worker.ts:142-145` defaults are 2000 and 200. `:418` calls `resolveDocumentChunkConfig()` with no `agent.yaml` read. Nothing under `src/daemon/` passes `chunkConfig` from `agent.yaml`.
- Verdict: FALSE
- Action: REVISE

### D-21

- Quote: "Chunk vectors are 768-dim `nomic-embed-text-v1.5` embeddings stored as DeepLake tensors." And: "Source chunks act as a fallback when normal candidates are empty"
- Doc: `library/knowledge/private/sources/source-lifecycle.md:48` and `:114`
- Grounding: `src/daemon/runtime/sources/lifecycle.ts:638-639` omits `chunk_embedding` on source index ("intentionally omitted (NULL)"). `document-worker.ts` does embed document chunks. A search of `src/daemon/runtime/recall` finds no `memory_artifacts` or `document_chunk` read. Source-chunk recall fallback is ABSENT.
- Verdict: FALSE
- Action: REVISE

### D-22

- Quote: "the daemon runs the real audience match + install/retract daemon-side."
- Doc: `library/knowledge/private/collaboration/asset-sync-substrate.md:178`
- Grounding: `src/hooks/shared/session-start-seams.ts:37-39`: asset pull runs the thin-client install in process. The daemon returns rows from `POST /api/assets/pull`. Disk write is `src/daemon-client/assets/install.ts:165` `pullAndInstall`. The same knowledge page at `:185` already names that client module. Skills pull is the daemon-side path (`session-start-seams.ts:129-131`, `src/daemon/runtime/skillify/propagation-api.ts:188-206`).
- Verdict: FALSE
- Action: REVISE

### D-23

- Quote: "The union view is what the dashboard Sync page and the `honeycomb asset list` surface read"
- Doc: `library/knowledge/private/collaboration/asset-sync-substrate.md:206`
- Grounding: union is `GET /api/diagnostics/assets` in `src/daemon/runtime/dashboard/sync-mount.ts:9` and `fetchSkillSyncView` in `src/daemon/runtime/dashboard/api.ts:690-707`. `src/commands/asset.ts:440-451` `runList` prints `registry.read()` and the comment says "no DeepLake read".
- Verdict: FALSE
- Action: REVISE

### D-24

- Quote: "The skillify worker respects a scope setting persisted in `~/.honeycomb/state/skillify/config.json`"
- Doc: `library/knowledge/private/collaboration/team-skills-sharing.md:33`
- Grounding: `src/daemon-client/skillify/config.ts:33-40`: default is `join(honeycombStateDir(), "state", "skillify")`, which is `~/.apiary/honeycomb/state/skillify/config.json`. Legacy read fallback is `~/.honeycomb/state/skillify`. Writes go to the new path (`:94-96`). `org` coerced to `team` at `:129-140` still matches the page.
- Verdict: STALE
- Action: REVISE

### D-25

- Quote: "Detected agent roots are discovered by `detectAgentSkillsRoots`" and the diagram `~/.pi/skills/deploy--alice -> ~/.claude/skills/deploy--alice/`.
- Doc: `library/knowledge/private/collaboration/team-skills-sharing.md:102` and `:96-100`
- Grounding: `detectAgentSkillsRoots` is ABSENT. The function is `createDefaultAgentRoots` in `src/daemon-client/skillify/install.ts:662-669`. pi root is `join(home, ".pi", "agent", "skills")`, not `~/.pi/skills`. `~/.codex/skills` and `~/.hermes/skills` in the diagram match. The function also fans out to `~/.agents/skills` and `~/.cursor/skills`, which the diagram omits.
- Verdict: FALSE
- Action: REVISE

### D-26

- Quote: "On a fresh workspace, the `skills` table does not exist yet ... The auto-pull uses a "trusted table list" path ... if `skills` is absent, skips the `SELECT` entirely."
- Doc: `library/knowledge/private/collaboration/team-skills-sharing.md:64-66`
- Grounding: `skillsTableAbsent` in `src/daemon-client/skillify/install.ts:409-410` returns false when `trustedTables` is omitted. Session-start `runDaemonPull` (`src/daemon/runtime/skillify/propagation-api.ts:201-206`) calls `pull` without `trustedTables`. Asset pull does wire the probe (`src/daemon/runtime/assemble.ts:3905`, `src/daemon/runtime/assets/sync.ts:375-379`). The skills session-start path does not.
- Verdict: STALE
- Action: REVISE

### D-27

- Quote: "Status: Proposed (Design)" under a banner "SUPERSEDED (2026-07-03): Relocated to Queen ... do not update."
- Doc: `library/knowledge/private/collaboration/fleet-observation-and-on-demand-skills.md:3` and `:5`
- Grounding: the banner and the status line are in the same file and disagree. Queen copy is ABSENT from this checkout.
- Verdict: STALE
- Action: REVISE

### D-28

- Quote: "Every harness reads and writes the same Deep Lake dataset over HTTPS" and "selectNewerForOrgUsers powering `GET /api/skills`". Canonical copy path `queen/library/knowledge/private/collaboration/fleet-observation-and-on-demand-skills.md`.
- Doc: `library/knowledge/private/collaboration/fleet-observation-and-on-demand-skills.md:25`, `:184`, `:3`
- Grounding: harness bundles are thin clients (`esbuild.config.mjs:95-97`, `harnesses/pi/src/index.ts:5`). DeepLake stays in the daemon. `selectNewerForOrgUsers` is `src/daemon/runtime/skillify/publish-endpoint.ts:85` and is called from the pull path (`propagation-api.ts:180`). `GET /api/skills` is `src/daemon/runtime/product/api.ts:12` and `:277`, a different read. The Queen path is ABSENT here. The page banner says the body is history and must not be updated.
- Verdict: FALSE
- Action: LEAVE

## Holds (mandatory checks that match the tree)

### H-01

- Quote: "a wired `"version"` script runs `node scripts/sync-versions.mjs` and then `git add` on the six manifests named in `package.json` ... It does not run `git add -A`."
- Doc: `library/knowledge/private/infrastructure/npm-publishing.md:136`
- Grounding: `package.json:55` is `node scripts/sync-versions.mjs && git add` of `.claude-plugin/plugin.json`, `harnesses/claude-code/.claude-plugin/plugin.json`, `harnesses/openclaw/openclaw.plugin.json`, `harnesses/openclaw/package.json`, `harnesses/codex/package.json`, and `.claude-plugin/marketplace.json`. Six paths. No `git add -A`.
- Verdict: HOLDS
- Action: LEAVE

### H-02

- Quote: "The live CLI verb is `sources` (`src/commands/contracts.ts`). `buildStorageRequest` sends a bare `sources` invocation to `GET /api/sources` and a non-read subcommand to `POST /api/sources/<subcommand>` (`src/commands/storage-handlers.ts`). The daemon connect handler is `POST /api/sources` (`src/daemon/runtime/sources/api.ts`). ... The generic CLI maps `sources add` to `POST /api/sources/add`, which is not the daemon connect route `POST /api/sources`."
- Doc: `library/knowledge/private/sources/source-lifecycle.md:36-42`
- Grounding: `src/commands/contracts.ts:159` verb `sources`. `src/commands/storage-handlers.ts:44` and `:220-229` (`isRead` empty/list/get/show/status is GET, anything else is `POST ${base}/${sub}`). `src/daemon/runtime/sources/api.ts:187-188` `group.post("/")` is connect. `sources add` therefore posts `/api/sources/add`.
- Verdict: HOLDS
- Action: LEAVE

### H-03

- Quote: "`~/.apiary/honeycomb/registry.json` is the registry path (`defaultRegistryBaseDir` in `src/daemon/runtime/assets/registry.ts`), with a legacy `~/.honeycomb` read fallback."
- Doc: `library/knowledge/private/collaboration/asset-sync-substrate.md:64`
- Grounding: `defaultRegistryBaseDir` returns `honeycombStateDir()` (`src/daemon/runtime/assets/registry.ts:151-154`). `honeycombStateDir` is `join(resolveFleetRoot(), PRODUCT_SLUG)` (`src/shared/fleet-root.ts:103-104`, `PRODUCT_SLUG` `honeycomb` at `src/shared/constants.ts:35`). The file name is `registry.json` (`registry.ts:162`, `:175`). Legacy base is `legacyHoneycombDir` (`:156-158`, `:176-179`). `defaultRegistryBaseDir` is the directory. The file path in the sentence matches.
- Verdict: HOLDS
- Action: LEAVE

### H-04

- Quote: "The embedder is a separate process at `http://127.0.0.1:3851` (`src/daemon/runtime/services/embed-client.ts`) running `nomic-ai/nomic-embed-text-v1.5` (`embeddings/src/index.ts`). Embeddings default on: only `HONEYCOMB_EMBEDDINGS=false` or `0` turns them off."
- Doc: `library/knowledge/private/overview.md:25` and `:59`
- Grounding: `embeddings/src/index.ts:4`, `:46`, `:68` (`EMBED_PORT = 3851`). `embed-client.ts:145` and `:169-172` (unset or anything other than `false`/`0` stays enabled). Local queue sentence matches `src/daemon/runtime/services/local-queue-diagnostics.ts:93-122` (single-machine and undeclared topology `eligibleForDefaultOn: true`).
- Verdict: HOLDS
- Action: LEAVE

### H-05

- Quote: "`package.json:53-91` ... `prebuild` is `node scripts/sync-versions.mjs` (`package.json:54`). `build` is `tsc && node esbuild.config.mjs` (`package.json:56`). `ci` is `npm run typecheck && npm run dup && npm run test && npm run audit:sql` (`package.json:84`). `postinstall` runs `scripts/ensure-tree-sitter.mjs` and `scripts/ensure-embed-deps.mjs` (`package.json:85`). `dup` scans `src harnesses mcp embeddings` (`package.json:61`)."
- Doc: `library/knowledge/private/infrastructure/monorepo-build-release.md:32`
- Grounding: those `package.json` lines match, including the scripts object ending at line 91. What `postinstall` does to tree-sitter is D-01, not this script string.
- Verdict: HOLDS
- Action: LEAVE
