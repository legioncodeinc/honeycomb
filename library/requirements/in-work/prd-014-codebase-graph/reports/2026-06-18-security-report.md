# Security Audit — PRD-014 Codebase Graph

- **Branch:** `prd-014-codebase-graph`
- **Auditor:** security-worker-bee (security-stinger)
- **Date:** 2026-06-18
- **Scope:** all of `src/daemon/runtime/codebase/` (014a extraction/discovery/cache, 014b resolution/snapshot/hash, 014c push-pull, 014d query surface), the `codebase` catalog columns, the two new runtime deps (`web-tree-sitter`, `tree-sitter-wasms`), and the build/postinstall reconcile (`esbuild.config.mjs`, `scripts/ensure-tree-sitter.mjs`).
- **Ordering:** Ran BEFORE `quality-worker-bee`. No `*-qa-report.md` exists for this branch — ordering clean.

## Executive Summary

**VERDICT: PASS — quality-worker-bee is CLEARED.**

No Critical or High findings. The new surface is unusually well-defended for its risk class: extraction is AST-structure-only (no source bodies, no string-literal values, no secrets reach the snapshot), discovery cannot escape the repo root or follow symlinks out, the on-disk cache key is path-separator-sanitized, every SQL interpolation routes through the `sqlIdent`/`sLiteral`/`val.*` guards, push refuses to clobber a drifting row, pull hash-revalidates before trusting a payload, the JSON deserialization path is prototype-pollution-safe, and `query.ts` is import-provably zero-network. Coverage is FULL (no reduced-fidelity flag). Two Low items are documented for hygiene only.

Counts: **Critical 0 · High 0 · Medium 0 · Low 2.**

Gate exit codes (all from repo root): `npm run ci` = **0** (86 files, 998 passed, 4 skipped) · `npm run build` = **0** · `npm run audit:openclaw` = **0** · `npm run audit:sql` = **0** (112 files scanned, all interpolation guarded) · `npm run pack:check` = **0** (27 files, no forbidden patterns) · `npm audit --omit=dev` = **0 vulnerabilities**.

No code was changed by this audit (no Critical/High to remediate); the working-tree diff is the pre-existing PRD-014 implementation only — no `.ts` source file was touched by the auditor.

---

## The four load-bearing theses — proven affirmatively and adversarially

### 1. No traversal — extraction/discovery cannot read outside the repo root or follow a symlink out  ✅

**Affirmative (cite):**
- Git mode (`discovery.ts:129-142`) runs `git ls-files --cached --others --exclude-standard -z` with `cwd: repoRoot`. `git ls-files` only ever lists paths *inside* the working tree; it cannot name `/etc/passwd`. `--exclude-standard` applies `.gitignore` with git's exact semantics (no re-implementation to trick). `maxBuffer: 256 MiB` bounds the output.
- Manual walk (`discovery.ts:154-184`): `if (entry.isSymbolicLink()) continue;` (line 171) — **symlinks are never followed**, so a symlink pointing at `/etc` is skipped, not descended. Dotfiles/dot-dirs (`.startsWith(".")`) and `ALWAYS_IGNORED_DIRS` (incl. `.git`, `node_modules`) are skipped. Paths are returned via `relative(repoRoot, full)` over entries that are descendants of `repoRoot` only.
- The cache base dir is `~/.honeycomb/graphs/<repo-key>/` where the repo-key is sanitized: `identity.repo.replace(/[^A-Za-z0-9._-]/g, "_")` (`snapshot.ts:198`).

**Adversarial:** Probed the repo-key sanitizer with `"../../../etc/passwd"`, `"..\\..\\windows"`, `"a/b/c"`, `"$(whoami)"`, `"a;rm -rf"` → every output has **no path separator and no shell metacharacter** (`/` and `\` are both replaced by `_`). A crafted repo slug cannot escape the cache directory. A crafted `.gitignore`/filename cannot redirect the walk outside the root because the walk only ever recurses into real, non-symlink subdirectories of `repoRoot`, and git mode delegates path enumeration entirely to `git`. **No traversal path exists.**

> Low-1 (hygiene, documented only): the manual walk never canonicalizes `repoRoot` itself, so if a *caller* passed a `repoRoot` that is itself a symlink into another tree the walk would follow it — but `repoRoot` is daemon-supplied (the checked-out worktree), never attacker-controlled, so this is not an exploitable boundary. Noted for defense-in-depth.

### 2. No secret in the snapshot — the graph carries AST structure, never source content/literals  ✅

**Affirmative (cite):** Every node/edge field is a *name* or a *module specifier*, never a body or a literal value:
- `walk.ts makeSymbolNode`/`makeFileNode` store `id`, `kind`, `name` (the symbol name via `fieldText(node, "name")`), `sourceFile`, `language`, `exported`, and a VOLATILE `observation` of *line numbers* only — no `body`/`text`/`snippet` field. The contracts (`contracts.ts`) define no source-text field anywhere (grep confirmed).
- All `.text` reads across `ts-js.ts` / `structural.ts` / `walk.ts` pull only an **identifier** (`name`, callee, base-type, namespace binding) or an **import specifier** (`stringSpecifier`/`includeSpecifier`/`stripQuotes` → a *module path* like `./x` or `lodash`). String literals are read **only** when they are an import path — an arbitrary string constant in code (e.g. `const apiKey = "sk-live-..."`) is never read, because the extractors only descend import statements for string values.
- `stableNode` (`hash.ts:81-92`) whitelists `id/kind/name/sourceFile/language/symbolKind/exported` into the hash — even if a future field were added it would not be hashed-or-stored unless explicitly listed.
- The pushed `snapshot_jsonb` is `JSON.stringify(snapshot)` (`push-pull.ts:373`) over exactly those AST-structure nodes/links — no file content is in the snapshot to serialize.

**Adversarial:** A source file containing `const TOKEN = "ghp_realSecret"` produces a `variable` symbol node named `TOKEN` (the *name*), an `external:`-targeted import/call set, and a line span — the literal `"ghp_realSecret"` is never captured into any node, edge, observation, or the jsonb body. **No secret from source can reach the snapshot.**

### 3. Push respects auth + scope + drift-refuse (no clobber)  ✅

**Affirmative (cite):**
- Skip gate (`push-pull.ts:186-188`): `!ctx.authenticated → skipped/no-auth`; `!hasCommitContext → skipped/no-commit`; `HONEYCOMB_GRAPH_PUSH=0 → skipped/disabled-env`. All three return silently with nothing written — c-AC-3 is real.
- SELECT-before-INSERT on the **full six-column identity tuple** `(org_id, workspace_id, repo_slug, user_id, worktree_id, commit_sha)` via `identityWhere` (`:323-333`), each column through `sqlIdent`, each value through `sLiteral`, under the tenant `ctx.scope`.
- Drift (`:202-218`): a present row whose `snapshot_sha256` ≠ incoming → `logger.warn("push-drift")` + `return {kind:"drift"}` with **no INSERT and no UPDATE** — the stored row is left intact. A matching hash → `already-current` no-op.

**Adversarial:** Can a push overwrite another org/workspace's row? No — the INSERT carries this caller's identity columns (`snapshotRowValues:362-378`) and the SELECT/INSERT execute under `ctx.scope` (the tenant partition the storage client enforces on every query, `client.ts`). A differing-hash collision on the *same* identity is refused (no clobber); a different identity is simply a different key. There is no code path that issues an `UPDATE`/`DELETE` against the `codebase` table from this module. **No clobber, no cross-tenant write.**

### 4. Pull hash-revalidation cannot be bypassed (no poisoned cache)  ✅

**Affirmative (cite):** `pullSnapshot` (`:425-468`): scoped relaxed-identity SELECT (`pullWhere` drops only `worktree_id`; still pins org/workspace/repo/user/commit) → `parseSnapshotJsonb` (shape guard) → `computeSnapshotSha256(parsed)` recomputed locally → **`if (recomputed !== row.claimedSha256) return refused/hash-mismatch`**. A malformed/unparseable body → `refused/malformed-payload`. Nothing is returned to the caller (and thus nothing enters the local cache) unless the recomputed stable-field hash equals the claimed one.

**Adversarial:**
- *Tampered jsonb, same claimed sha:* recompute ≠ claimed → refused. ✅
- *JSON-shaped-but-malicious payload:* `isSnapshotShape` (`:538-551`) rejects anything missing `directed===true`/`multigraph===true`/`graph`/`nodes[]`/`links[]`/`observation`. ✅
- *Code execution on deserialize:* the path is `JSON.parse` + structural guards + pure hashing — **no `eval`, no `Function`, no `require` of payload data.** ✅
- *Prototype pollution via `__proto__` in the node-link JSON:* I replicated `hash.ts`'s `sortValue`/`canonicalJSON` against a `{"__proto__":{...}}` payload — the global `Object.prototype` is **not** polluted (`({}).polluted === undefined`), and `__proto__` is dropped from the canonical output, so it can neither pollute nor alter the recomputed hash. ✅

> Note on the guard's *security role*: hash-revalidation defends against a **corrupted/truncated/drifted** row poisoning the cache. It is NOT the authorization boundary (an attacker who can write a row for an identity can always make `claimedSha == recompute` for their own payload) — authorization is the scoped, identity-tuple-pinned SELECT plus the tenant `QueryScope`, which this module applies. Both layers are present.

---

## Per-dimension findings (the eight audit dimensions)

| # | Dimension | Result |
|---|-----------|--------|
| 1 | Traversal / symlink / cache-key escape | **None detected.** Symlinks never followed; git mode delegates enumeration to git; repo-key separator-sanitized. |
| 2 | Secret/source-content in snapshot | **None detected.** AST structure only; `.text` reads are identifiers + import specifiers; no body/literal field. |
| 3 | Push auth + scope + drift-refuse | **None detected.** Triple skip gate; six-column identity SELECT; drift logs + refuses; no UPDATE/clobber; tenant-scoped. |
| 4 | Pull hash-revalidation / poisoned cache / proto-pollution | **None detected.** Recompute-must-equal-claimed; shape guard; pure JSON.parse path; pollution-safe. |
| 5 | SQL injection | **None detected.** `audit:sql` = 0 over 112 files. Identity-tuple values via `sLiteral`, columns via `sqlIdent`, jsonb body via `val.text`→`E'...'`, table via `sqlIdent`. A malicious repo slug/commit only ever lands as an escaped literal. |
| 6 | `query.ts` zero-network + ReDoS/unbounded compute | **None detected.** Imports ONLY `./contracts.js` (lines 42-48) — no fs/http/storage in scope, so a network call is structurally impossible (d-AC-5 proven by import boundary). Levenshtein is bounded (`maxDistance` default 2, length-gap short-circuit + per-row early-out, `query.ts:677-695`); results capped (`DEFAULT_MAX_RESULTS=25`); no user-supplied regex is compiled (patterns are used as `.includes`/`.startsWith` substrings, only the fixed `/\s/` test runs). No ReDoS surface. |
| 7 | Supply chain | **None detected.** `web-tree-sitter@0.22.6` and `tree-sitter-wasms@0.1.13` are the genuine, well-known packages (not typosquats), both resolved from `registry.npmjs.org` with `sha512` integrity in the lockfile, pinned `^`. Grammars load from `require.resolve("tree-sitter-wasms/package.json")` + a fixed in-package basename (`extract.ts:143-145`, `:189`) — never a user-controlled path. `ensure-tree-sitter.mjs` postinstall compiles nothing, spawns nothing, has a recursion guard, and exits 0 unless `HONEYCOMB_STRICT_POSTINSTALL=1` (fail-safe). `pack:check` = 0. |
| 8 | DoS / boundedness | **None detected.** Discovery hard-capped at `MAX_DISCOVERED_FILES=50_000` (+ soft walk bound 4×); git output `maxBuffer` 256 MiB; per-file extraction is skip-on-error (a malformed/pathological file is reported + skipped, never aborts). Cache growth is content-addressed (one entry per unique content sha) — see Low-2. |

---

## Low findings (documented only — no remediation required)

- **Low-1 — `repoRoot` not canonicalized before the manual walk.** `discovery.ts manualWalk` trusts the caller-supplied `repoRoot`. Not exploitable today (the daemon supplies the checked-out worktree path; it is never attacker-controlled), but a `realpathSync(repoRoot)` at entry would be belt-and-suspenders if `repoRoot` ever becomes user-influenced. Defense-in-depth only.
- **Low-2 — content-addressed cache has no eviction / size ceiling.** `cache.ts` writes one `<sha>.json` per unique file content under `~/.honeycomb/graphs/<repo-key>/.cache/` and never prunes. On a long-lived, frequently-edited repo this grows unbounded on local disk (a *local* resource only — no remote/tenant impact, no security boundary crossed). A future LRU/age sweep or a `CACHE_SCHEMA_VERSION`-bump cleanup would bound it. Hygiene, not a vulnerability.

---

## Catalog coverage (each category checked)

- **SQL injection into Deep Lake** — None detected (guards verified; `audit:sql` green).
- **Broken access control / cross-tenant read or write** — None detected (identity-tuple SELECT + tenant `QueryScope` on push and pull).
- **Credential / token exposure** — None detected. The push/pull logger emits only event names + small non-secret detail (`repo`, `commit`, sha values, `rowCount`, already-redacted storage `message`); never the jsonb body, never a token. Storage `message` is documented redacted (`result.ts:35`); client traces redact org/token (`client.ts:106`).
- **Captured-trace PII** — Not applicable to this surface and none introduced: the codebase graph stores AST symbol/edge structure for a checkout, not prompts/responses/tool-calls. No `sessions`/`memory` PII is read or written here.
- **Prompt-injection surface** — Not applicable: `query.ts` renders deterministic text from a local snapshot; it does not feed untrusted content into a model gate in this module.
- **Supply chain** — None detected (genuine pinned deps with integrity; postinstall fail-safe; `audit:openclaw` + `pack:check` green; `npm audit` 0).
- **Prototype pollution** — None detected (pull JSON path proven pollution-safe).
- **Logging failures** — None detected (no secret/body in any log line).

---

## Recommendation

`quality-worker-bee` is **cleared to run**. No security fixes landed, so no QA re-run is needed on account of this audit. The two Low items are optional hygiene follow-ups and need not block merge.
