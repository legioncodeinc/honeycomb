# Security Audit — Dashboard graph-edges + harness-turns (Item 1 & Item 2)

- **Branch:** `fix/dashboard-graph-edges-and-harness-turns`
- **Auditor:** security-worker-bee (security-stinger)
- **Date:** 2026-06-23
- **Scope:** the two dashboard-truthfulness fixes (uncommitted working tree) — Item 1 (graph edges + `/api/graph` route-collision resolution), Item 2 (harness identity through capture). Full-fidelity Hivemind stack; no out-of-catalog surface.
- **Verdict:** **PASS** (no Critical or High findings; nothing required in-session remediation).

---

## Executive summary

Both fixes are clean against the Hivemind catalogs. The new `GET /api/graph` owner (`codebase/api.ts`) reads a **local** snapshot file from a dir keyed solely on the daemon-local `identity.repo` (git origin slug / cwd basename) — **request-controlled input (org / workspace / headers) never reaches the filesystem path**, so there is no request-reachable path traversal. The handler preserves the same fail-closed `resolveScope` 400, the `/api/graph` group's `protect:true` RBAC, and the cross-tenant org-vs-token guard the retired dashboard handler had. The `snapshotToGraphView` mapper emits only inert `id`/`label`/`kind`/`from`/`to` strings, rendered by the dashboard as escaped React text (no `dangerouslySetInnerHTML` sink) — a malicious local snapshot can inject only inert strings, and no secret / native blob / author-email leaks into the view.

Item 2's stamped `agent` is a **hardcoded canonical token** (`spec.harness` / `OPENCLAW_HARNESS = "openclaw"`), never attacker-set; it flows to `sessions.agent` through `val.str` (escape-safe `sLiteral`), and the harness GROUP BY routes the `agent`/`sessions`/`creation_date` identifiers through `sqlIdent` with no interpolated value. The `agent` (harness provenance) vs `agent_id`/`author` (per-user `alice` engine scope) split is correct: `openclawDeriveMeta` now sets **only** `agentId`, so the per-user identity that any scope/RBAC decision depends on still carries `alice`, while harness attribution is the canonical token. No captured-turn PII/secret handling regressed — the change adds a provenance token, not new captured content.

**Ordering:** correct. `security-worker-bee` ran before `quality-worker-bee`; the only `*-qa-report.md` present is `library/qa/cursor-extension/2026-06-12-qa-report.md` (a prior, unrelated cycle), so no QA report for this branch predates this audit.

---

## Verification (DoD gates)

| Gate | Command | Result |
|---|---|---|
| SQL safety | `npm run audit:sql` | **PASS** — 213 files; every interpolation routes through an escaping helper |
| OpenClaw bundle | `npm run audit:openclaw` | **PASS** — 1 file scanned, no findings vs ClawHub rules |
| Full CI gate | `npm run ci` (typecheck + dup + test + audit:sql) | **PASS** — 253 files / 2855 tests passed, 6 skipped; `sources/api.test.ts` flake did not surface |
| Build | `npm run build` (`tsc && esbuild`) | **PASS** — tsc clean (no `any` at new boundaries), all bundles built |
| Hidden-Unicode scan | regex sweep of changed files | **PASS** — no zero-width/bidi codepoints |
| No deletions | `git diff --diff-filter=D --name-only` | **PASS** — empty |
| Assets untouched | `git status --short -- assets/` | **PASS** — empty |
| No scratch staged | `git status` for `.scan-output/` | **PASS** — absent |

---

## Findings by category

### Item 1 — local snapshot read path (`src/daemon/runtime/codebase/api.ts`)

**Path traversal via request-controlled input — NOT PRESENT (checked).**
`GET /api/graph` builds `baseDir = options.graphBaseDir ?? defaultGraphBaseDir(resolveIdentity(scope))` (`api.ts:280`). `defaultGraphBaseDir` (`api.ts:106-110`) keys the path **only** on `identity.repo`, never on `identity.org`/`workspace`. The repo half of the identity is resolved in `resolveSnapshotIdentity` (`identity.ts:136-162`) from **daemon-local** git probes (`git config --get remote.origin.url` → `repoSlugFromOrigin`, else `basename(workspaceDir)`), not from request headers. The tenant half (`org`/`workspace`) — the only request-header-controlled fields — is carried for the SQL/push layer but is **not** interpolated into the read path. So a crafted `x-honeycomb-org` / `x-honeycomb-workspace` / repo slug **cannot** steer `baseDir` outside `~/.honeycomb/graphs/<repo-key>/`. Confirmed no request-reachable traversal.

**Scope + RBAC + local-gate — preserved (checked).** The handler returns `NO_ORG_BODY` 400 when `resolveScope` is `null` (`api.ts:278-279`), identical fail-closed posture to the retired `fetchGraphView`. `/api/graph` is `protect:true` in `ROUTE_GROUPS` (`server.ts:87`); `mountGraphApi` attaches via `daemon.group("/api/graph")` and inherits that permission middleware. `resolveScopeFromHeaders` still enforces the cross-tenant guard (`scope.ts:54-62`: a forged org header that disagrees with the validated token identity → `null` → deny). No new unauthenticated or cross-tenant read introduced.

**HTML/script injection into the view — NOT PRESENT (checked).** `snapshotToGraphView` (`api.ts:159-171`) maps node → `{ id, label, kind }` and link → `{ from, to, kind }`, all strings. The dashboard renders every one as React text / SVG `<text>` children (`pages/graph.tsx:236,239,242,190` and the canvas `<text>` label) — React auto-escapes; there is **no** `dangerouslySetInnerHTML`/`innerHTML` sink (the only occurrences of that token in `src/dashboard` are comments stating it is deliberately not used). A malicious snapshot file (which must already be on local disk under `~/.honeycomb/graphs/`) can inject only inert strings.

**Secret / native-blob / author-email leak into GraphView — NOT PRESENT (checked).** The mapper projects only `id`/`label`/`kind`/`from`/`to`. The snapshot's `observation` block (`worktreePath`, `generatedAt`, branch), the `graph` dict, and per-node `observation` are all dropped — no token, org GUID, path, commit, or author-email rides the response.

### Item 2 — capture attribution (`src/hooks/normalize.ts`, `src/hooks/openclaw/shim.ts`, `capture-handler.ts`, `harness-api.ts`)

**`agent` forge / SQL injection — NOT PRESENT (checked).** The stamped `agent` is the hardcoded canonical token: `spec.harness` in `createShim.normalize` (`normalize.ts:120`) and `OPENCLAW_HARNESS = "openclaw"` on the batch path (`shim.ts:124`, used at `shim.ts:128`). It is never sourced from request/event payload. It is written to `sessions.agent` via `["agent", val.str(meta.agent)]` (`capture-handler.ts:254`); `val.str` → `{kind:"literal"}` → `sLiteral` (`writes.ts:54,71`), the escape-safe SQL-literal path. No injection surface even hypothetically.

**Provenance vs per-user split — CORRECT (checked).** `openclawDeriveMeta` now sets **only** `agentId` from the `agent:<name>:` session key (`shim.ts:90`: `{ ...base, agentId: match[1] }`), no longer clobbering `agent`. The write maps `author`/`agent_id` ← `meta.agentId` (the per-user `alice`) and `agent` ← `meta.agent` (the harness token) into two distinct columns (`capture-handler.ts:253-257`). Any scope/RBAC/tenancy decision that reads the per-user engine scope still gets `alice` via `agent_id`/`author`; the Harnesses page GROUPs BY the provenance `agent`. Tenancy is unaffected — capture-row scope is partitioned by org/workspace, not by `agent`.

**Harness GROUP BY guarding — CORRECT (checked).** `buildHarnessActivitySql` (`harness-api.ts:129-134`) routes `sessions`, `agent`, `creation_date` through `sqlIdent` and interpolates **no value**; `audit:sql` is green by construction.

**Captured-trace PII/secret regression — NOT PRESENT (checked).** The change adds a provenance token only; no new captured content, no token/Authorization/credential material enters a captured trace. `HIVEMIND_CAPTURE` opt-out path untouched.

### Cross-cutting catalog categories

| Category | Result |
|---|---|
| Deep Lake SQL injection (missing `sqlIdent`/`sqlStr`) | None detected — `audit:sql` clean; new GROUP BY uses `sqlIdent`, capture write uses `val.str` |
| Token / JWT / org-id exposure (logs, responses, traces) | None detected — GraphView and harness response carry no secret field; capture adds only a token-free provenance string |
| Cross-org / cross-scope read (`me\|team`, org coercion) | None detected — `resolveScopeFromHeaders` cross-tenant guard preserved; path keyed on local repo only |
| Pre-tool-use gate / VFS bypass | Not in scope of this diff; unchanged |
| Prompt-injection (recall / skillify) | Not in scope of this diff; unchanged |
| Credential file modes / device flow | Not in scope of this diff; unchanged |
| Hidden-Unicode rules backdoor | None detected |
| Supply chain (OpenClaw bundle, gate-runner bypasses) | None detected — `audit:openclaw` clean; `gate-runner.ts` untouched |

---

## Low-severity note (documented, not fixed — per operating rules)

**L-1 — `defaultGraphBaseDir` sanitizer permits `.`/`..` in the allowlist.** `identity.repo.replace(/[^A-Za-z0-9._-]/g, "_")` (`api.ts:108`, mirrored at `snapshot.ts:198`) keeps `.`, so a `repo` value of `..` would survive and `join(home, ".honeycomb", "graphs", "..")` would resolve to `~/.honeycomb`. **Not exploitable today:** `repo` is daemon-local (git origin slug / cwd basename), never request-controlled, so this value cannot be attacker-set over HTTP. Classified Low (defense-in-depth hardening), so documented rather than fixed — and deliberately not patched in-session because closing it cleanly requires editing **both** `defaultGraphBaseDir` (read) and `defaultCacheDir` (write) in lockstep so the read/write dirs stay in agreement, which exceeds minimal blast radius for a non-reachable issue.
*Suggested follow-up (separate change):* strip leading dots / reject `.`/`..` segments in both helpers, e.g. collapse a sanitized key of `.`/`..` to `"default"` (the same fallback the empty-repo case already uses).

---

## Files reviewed (changed)

| File | Item | Security-relevant verdict |
|---|---|---|
| `src/daemon/runtime/codebase/api.ts` | 1 | New `/api/graph` owner — scope/RBAC preserved, no traversal, inert mapper. PASS |
| `src/daemon/runtime/dashboard/api.ts` | 1 | Retired duplicate handler + dead `fetchGraphView`/`parseSnapshot`. PASS |
| `src/daemon/runtime/assemble.ts` | 1 | Double-registration resolved (single owner). PASS |
| `src/hooks/normalize.ts` | 2 | Stamps hardcoded `agent = spec.harness`. PASS |
| `src/hooks/openclaw/shim.ts` | 2 | `OPENCLAW_HARNESS` token; `deriveMeta` sets only `agentId`. PASS |
| `src/hooks/index.ts` | 2 | Export only. PASS |

(Test files and `dashboard/CONVENTIONS.md` reviewed for parity; no security impact.)

---

## Residual risk

Low. No request-reachable injection, traversal, cross-tenant read, or secret exposure was found in either fix. The single residual item (L-1) is a non-exploitable defense-in-depth hardening on a daemon-local value, suitable for a follow-up change. Re-run `quality-worker-bee` after this audit (correct ordering — no QA report for this branch predates these fixes).
