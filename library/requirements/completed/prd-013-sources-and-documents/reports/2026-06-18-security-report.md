# Security Audit — PRD-013 Sources & Documents

- **Branch:** `prd-013-sources-and-documents`
- **Auditor:** security-worker-bee (Hivemind security stinger)
- **Date:** 2026-06-18
- **Scope audited:** all new PRD-013 code — `src/daemon/runtime/sources/` (`contracts.ts`, `lifecycle.ts`, `api.ts`, `document-worker.ts`, `providers/{obsidian,discord,github}.ts`, `index.ts`), `src/daemon/storage/catalog/sources.ts`, and the provenance columns on `knowledge-graph.ts`. Cross-referenced the SQL floor (`src/daemon/storage/sql.ts`, `writes.ts`) and the API boundary.
- **Ordering check:** No `*-qa-report.md` / `*-quality-report.md` exists for this branch. `security-worker-bee` runs BEFORE `quality-worker-bee` — ordering correct. quality-worker-bee is cleared to run after this report.

---

## Executive Summary

PRD-013 is a security-conscious implementation. Every one of the eight audit dimensions was tested affirmatively (cite the code that enforces the guarantee) and adversarially (attacks attempted). **Zero Critical and zero High findings.** The core theses hold:

- **Source files are NEVER modified** — providers use read-only fs / read-only seams only; no write-back anywhere.
- **GITHUB_TOKEN is host-pinned** — the `githubTokenForRemote` / `isGithubHost` guard survived every look-alike attack I threw at it; the token never lands in an artifact, metadata, provenance, log, or health detail.
- **Provenance cannot be forged to cross scope** — org/workspace come from authenticated headers and the registered config, not from a spoofable artifact body.
- **Purge leaves no orphans** — the just-fixed `copyForwardWithStatus` skip-array/object behavior is correct; all three tables status-advance.
- **SQL injection: none** — `audit:sql` clean across 98 files; every interpolation routes through `val.*` / `sLiteral` / `eLiteral` / `sqlIdent`.

The two latent items (SSRF egress controls; document-size DoS cap) are **Medium/Low with NO live exploit path on this branch** — the URL fetcher and the Discord/GitHub network transports are all unwired seams (default `echoDocumentContentFetcher` performs zero network I/O). They are documented as blocking requirements for the daemon-assembly wiring that lands the real fetcher, not fixed here, because the only sound fix lives in code that does not yet exist. Fixing a seam with no network behavior would be speculative and contaminate the diff.

**No code was changed. `git diff` is empty by construction.**

---

## Findings by Severity

### Critical — None detected.

### High — None detected.

### Medium

#### M-1 — SSRF egress controls absent on the document/provider fetch seams (LATENT — no live path)

- **Where:** `src/daemon/runtime/sources/document-worker.ts:340-354` (`DocumentContentFetcher` seam + default `echoDocumentContentFetcher`), `:504` (`this.fetcher.fetch(submission)`). The `POST /api/documents` body URL (`api.ts:214`) flows unvalidated to whatever fetcher is injected.
- **What:** `POST /api/documents` accepts an arbitrary `url` string with no scheme/host validation. The worker hands it to `DocumentContentFetcher.fetch`. The Discord (`discord.ts:192`) and GitHub (`github.ts:204`) transports likewise fetch external URLs behind seams.
- **Why it is NOT live today:** the default fetcher (`echoDocumentContentFetcher`) echoes the URL as content and performs **no network I/O**; `api.ts` defaults `documentWorker: undefined` → the route returns a 501. The Discord/GitHub network transports are `networkTransportNotWired()` / required-injection seams — no `fetch`/`ws` exists in any provider. The only live `fetch` in the daemon is the trusted Deep Lake storage transport (`storage/transport.ts:83`) and the local embed daemon (`services/embed-client.ts:246`) — neither attacker-routable.
- **Impact when wired:** without egress controls, an attacker who can `POST /api/documents` could point the worker at `http://169.254.169.254/latest/meta-data/` (cloud metadata), `file:///etc/passwd`, `http://localhost:3850/...` (the daemon's own API), or an internal host — classic SSRF, and the fetched content would be persisted as a recallable, provenance-bearing artifact.
- **Recommendation (blocking requirement for the 013b real fetcher + daemon assembly):** before the real `DocumentContentFetcher` (and the Discord/GitHub network transports) ship, enforce an egress allowlist at the seam: (1) scheme MUST be `http`/`https` only — reject `file:`, `ftp:`, `gopher:`, `data:`; (2) resolve the host and BLOCK RFC-1918 (`10/8`, `172.16/12`, `192.168/16`), loopback (`127/8`, `::1`), link-local (`169.254/16`, `fe80::/10`), and `0.0.0.0`; (3) re-validate after DNS resolution to defeat DNS-rebinding (resolve once, connect to the resolved IP, or pin); (4) disable redirects to a non-allowlisted host. This is the same class of guard `githubTokenForRemote` already models for the token — mirror it for the fetch destination.

#### M-2 — Unbounded document size → chunk-count DoS (LATENT — gated by the same unwired fetcher)

- **Where:** `document-worker.ts:202-212` (`chunkText`), `:647-693` (`writeChunks` iterates every chunk with a per-chunk append + per-chunk link append + per-distinct-hash embed probe), `:519`.
- **What:** there is no cap on fetched document size before chunking. `chunkText` produces `⌈len / stride⌉` chunks; each chunk drives ≥2 storage appends (chunk + link) and a `findStoredEmbedding` round-trip per distinct hash. A multi-hundred-MB document (default `chunkSize` 2000, stride ~1800) yields ~100k+ chunks → ~200k+ storage writes for a single submission — resource exhaustion / write amplification.
- **Why it is NOT live today:** same as M-1 — the default fetcher returns only the URL string (a few bytes), so no large document can enter. GitHub ingest IS bounded (`maxItemsPerRepo`, default 1000, enforced `github.ts:502/515`); Discord backfill IS bounded (`backfillLimit`, default 500, `discord.ts:559`); the Obsidian walk skips `node_modules`/`.git`/`.obsidian`/`.trash` (`obsidian.ts:249`) but is otherwise unbounded over `.md` count (a malicious 1M-file vault would index all of them — but a vault is operator-supplied local trust, lower risk).
- **Recommendation:** when the real fetcher lands, cap fetched content length (e.g. reject > N MB, configurable under `pipeline.*`) and/or cap total chunks per document. Consider a per-source file-count ceiling for Obsidian.

### Low

#### L-1 — `extractHost` accepts a trailing-tab host (cosmetic; not a bypass)

- **Where:** `github.ts:101-118` (`extractHost`), `:70-76` (`isGithubHost`).
- **What:** `git@github.com\t:o/r` parses to host `"github.com\t"`. `isGithubHost` then `.trim()`s it to `github.com` and correctly recognizes the **legitimate** GitHub host — so the token is (correctly) granted to a real github.com remote. This is not a look-alike bypass (verified: `github.com.evil.com`, `notgithub.com`, `git@evil.com:...`, `https://github.com@evil.com/...` all correctly DENY the token). The whitespace is merely tolerated by the downstream normalize.
- **Recommendation:** none required. Optionally tighten `extractHost`'s SCP regex to reject internal whitespace for hygiene. Document only.

#### L-2 — `githubTokenForRemote` is exported and tested but never called on the live path (defense-in-depth, not dead-risk)

- **Where:** `github.ts:86-94`. The live path host-pins via `isGithubHost(deps.api.host, settings.host)` at `connect` (`:547`) and passes the token straight to the seam methods (`:500/513/518`). `githubTokenForRemote` exists as a chokepoint for a future git-sync/mirror/webhook caller and is exercised by `github.test.ts`.
- **Why it is fine:** the guard is correct (adversarially verified) and serves as the documented chokepoint should any non-GitHub-destination code path ever be added. It is intentional defense-in-depth, not a false assurance — the live token-to-host binding is independently enforced at connect.
- **Recommendation:** none. Keep it. Document only.

---

## The Three Theses — Proven

### 1. Source files are NEVER modified (read-only evidence)

**Affirmative:**
- Obsidian (`obsidian.ts`) uses ONLY `readFile`, `readdir`, `stat` (`:39`, `:271-305`). Every artifact-construction helper is pure. No `writeFile`/`rename`/`rm`/`mkdir`/`createWriteStream` anywhere.
- Discord (`discord.ts`) and GitHub (`github.ts`) hold **zero** network clients — every byte crosses a read-only seam (`DiscordTransport`, `GitHubApi`). No `POST`/`PUT`/`PATCH`/`DELETE` method exists on either seam; GitHub's seam is `fetchItems`/`listFiles`/`fetchDoc` (all reads).
- The lifecycle/purge (`lifecycle.ts:562-572`) writes ONLY the Deep Lake store (soft-delete status-advance); it never touches a vault/repo/channel.

**Adversarial:** `grep` for any filesystem/remote WRITE across `providers/` returned a single hit — a code comment, not a call. Confirmed read-only.

### 2. GITHUB_TOKEN host-pinning (e-AC-4 token-exfiltration guard)

**Affirmative:** `isGithubHost`/`githubTokenForRemote` (`github.ts:70-94`) return the token ONLY for the configured GitHub host (bare, `api.<host>`, `*.<host>`), `undefined` otherwise; `extractHost` is fail-closed (null → no token). The resolved token lives in the provider closure ONLY (`github.ts:484`), is dropped on `close()` (`:578`), and never enters an artifact (`itemArtifact`/`docArtifact`/`failureArtifact` carry only title/body/url/author — no token), metadata, provenance, or any log (connect failure reports the **ref name**, not the resolved value, `:558`). Defense-in-depth: `connect` refuses if `deps.api.host` is not the configured host before the token is even resolved (`:547-551`).

**Adversarial (executed):** ran the guard against 24 crafted remotes. Correctly DENIED: `github.com.evil.com`, `https://github.com.evil.com/o/r`, `notgithub.com`, `fakegithub.com`, `git@evil.com:o/r.git`, `https://evil.com/github.com`, `evil.com/github.com`, `git@github.com.evil.com:o/r`, `https://github.com@evil.com/o/r` (URL host = evil.com), `http://169.254.169.254/`, `https://[::1]/x`, empty string. Correctly GRANTED only to genuine github.com forms (bare, URL, SCP, `api.`, `:443`, `ssh://`, case-insensitive, and legit subdomains like `evil.github.com`). **No bypass found.**

### 3. Provenance can't cross scope / purge leaves no orphans

**Affirmative — scope cannot be forged:** the API injects org/workspace from authenticated `x-honeycomb-*` headers OVER the request body (`api.ts:156` spreads `{...body, org: scope.org, workspace: scope.workspace}`), so a client-supplied `org`/`workspace` in the JSON is overwritten. The scope resolver is fail-closed (no org → 400, `api.ts:67-75`). Provenance org/workspace come from `config.org`/`config.workspace` (the registered config), never from a spoofable artifact field. Reads/writes are scoped via `storage.query(sql, this.scope)` — tenancy is the storage partition, not a row predicate an attacker controls.

**Affirmative — purge completeness:** `purge` (`lifecycle.ts:562`) soft-deletes ALL three tables — `document_memories`, `document_chunk`, `memory_artifacts` — by `source_id` via `softDeleteAllForSource` → `scanIdsForSource` (poll-and-union, spaced polls to beat the propagation window, `:300-331`) → per-id `softDelete`. The just-fixed `copyForwardWithStatus` (`:371-398`) correctly SKIPS array/object columns (JSONB `metadata`, `FLOAT4[] chunk_embedding`) so the tombstone re-insert no longer corrupts a typed column and fails — the live-proven fix. Deterministic ids include `source_id` (`artifactId`/`chunkId`/`linkId`, `:139-155`), so the scan is cleanly scoped: another source's rows are untouched. The live `sources-purge-live.itest` and the `api.test.ts` a-AC-2 case (passing) prove a disconnected source's rows fall out of recall.

**Adversarial:** a forged `source_id`/`source_path` in an artifact only ever maps to a deterministic id derived from that same `source_id` — it cannot address another source's rows (the hash domain is disjoint) and the scope partition is independently enforced. No cross-source read/escape path found.

---

## Other Dimensions

- **SSRF (dimension 4):** see M-1. No live path on this branch (seams unwired). Recommend egress allowlist before wiring.
- **SQL injection (dimension 5):** `npm run audit:sql` → **OK, 98 files, 0 bypasses.** Every value in `lifecycle.ts`/`document-worker.ts`/`sources.ts` routes through `val.str`/`val.text`/`val.num`/`val.raw` → `sLiteral`/`eLiteral`/`sqlIdent`. `embeddingFragment` (`document-worker.ts:382`) uses `val.raw` but renders a PURE numeric literal (every element `Number.isFinite`-guarded → `String(n)` or `"0"`) — injection-free. Tried a planted bypass via malicious `source_path` containing `'; DROP TABLE memory_artifacts; --` → it would collapse to one inert `sLiteral` (quotes doubled, no statement break). Identifiers are config-schema names only; the dynamic `resolveTable` value flows through `sqlIdent` (`lifecycle.ts:269/300`).
- **Secret/credential in logs or artifacts (dimension 6):** no `console.*`/`logger.*` token sink in the sources module. `logger.event` calls carry only `sourceId`/`path`/`reason`/counts. The `--token-ref` is a reference string; the resolved value stays in-process and is dropped on close.
- **Path traversal (dimension 7):** Obsidian `relPath` always originates from `path.relative(vaultRoot, …)` over a walk rooted at the vault (`obsidian.ts:286`); `index`'s `scope.paths` can only NARROW to already-walked paths (Set membership, `:531-532`) — it cannot inject `../`. `readdir({withFileTypes})` reports a symlink as `isSymbolicLink()`, not `isDirectory()`, so the walk does NOT follow symlinks out of the vault. Deterministic ids include `source_id`, so a forged `source_path` cannot collide across sources. No escape found.
- **DoS (dimension 8):** GitHub `maxItemsPerRepo` (default 1000) and Discord `backfillLimit` (default 500) are enforced; the forward-refresh leg has a hard `forwardGuard > 10000` bound. Document size is uncapped (M-2, latent). Obsidian `.md` count is uncapped (lower risk, operator-local).

---

## Gate Results (final)

| Gate | Command | Exit |
|---|---|---|
| Typecheck | `npm run typecheck` (`tsc --noEmit`) | **0** |
| SQL safety | `npm run audit:sql` | **0** (98 files, 0 bypasses) |
| OpenClaw bundle | `npm run audit:openclaw` | **0** (clean) |
| Sources + catalog tests | `vitest run tests/daemon/runtime/sources tests/daemon/storage/catalog` | **0** (116/116) |

(Per the orchestrator's instruction, the live itests were NOT run here — the orchestrator owns those. `npm run build` was not separately invoked; `tsc --noEmit` covers the type-correctness half and no source changed.)

---

## Files Changed

**None.** No Critical/High finding required remediation; the Medium/Low items have no live exploit path and the only sound fix belongs in not-yet-written code (the real URL fetcher), so they are documented as blocking requirements rather than patched. `git diff` is empty.

---

## Verdict

**PASS — quality-worker-bee is CLEARED to run.**

Counts: **Critical 0 · High 0 · Medium 2 (both latent, no live path) · Low 2.**

No live vulnerability ships on this branch. The read-only, token-host-pinning, and purge-completeness theses are proven affirmatively and adversarially. The two Medium items (SSRF egress controls, document-size DoS cap) are **mandatory pre-conditions for the daemon-assembly step that wires the real `DocumentContentFetcher` and the Discord/GitHub network transports** — they must be implemented at that seam before any real fetch goes live, and should be re-audited then. Recommend carrying M-1/M-2 forward as explicit acceptance criteria on the 013-wiring follow-up.
