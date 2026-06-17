# Security Audit — PRD-001 Monorepo Foundation

- **Audited by:** security-worker-bee (security-stinger)
- **Date:** 2026-06-17
- **Branch:** `prd-001-monorepo-foundation`
- **Repo root:** `C:\Users\mario\GitHub\honeycomb`
- **Standalone catalog copy:** none written. The stinger directs feature-tied audits to the PRD's `reports/` folder (this file). No standalone copy under `library/qa/security/` is required for a feature-tied audit.

---

## Executive Summary

PRD-001 is a **build-foundation scaffold** — a daemon/CLI/MCP/embed/harness skeleton plus the
esbuild bundler, version-sync, and publish-gate tooling. It has **no DeepLake query layer, no
auth, no hooks, no capture path, and no captured traces** (those land in later PRDs). The realistic
attack surface is therefore **supply-chain and build-integrity**, exactly as scoped. I audited that
surface in full fidelity and the Hivemind data-plane catalogs (SQL injection, scope coercion, gate
bypass, capture opt-out, token-in-logs) as **Not Applicable — surface not yet present**, confirmed by
reading every in-scope source file.

**Result: the foundation is clean.** No Critical or High findings. The publish gate, the OpenClaw
bundle-integrity controls, and the build scripts are genuine, functioning controls — not theater.
One **Low** defense-in-depth hardening was applied in place (prototype-pollution-shaped key guard on
the OpenClaw tuning overlay). `npm audit` is clean (0 advisories), the OpenClaw bundle passes the
ClawHub-parity scan, the `files` allowlist + `pack-check.mjs` genuinely prevent shipping secrets/refs,
and no committed secrets exist.

**Ordering check:** No QA report exists for this branch. `security-worker-bee` ran first, as required.
`quality-worker-bee` may now run cleanly.

**Coverage note:** Full-fidelity coverage of the in-scope build/supply-chain surface. No
out-of-catalog surfaces were introduced; no REDUCED COVERAGE flag needed.

**Intelligence freshness:** `research/cve-watchlist.md` / `guides/06-cve-tracker.md` last refreshed
2026-04-24 (54 days ago) — within the 120-day staleness threshold. No refresh recommended.

---

## Findings Table

| ID | Severity | File:Line | Issue | Status |
|----|----------|-----------|-------|--------|
| F-1 | Low | `harnesses/openclaw/src/index.ts:44` (pre-fix) | `applyOpenclawTuning` copied untrusted `openclaw.json` tuning keys onto `globalThis.__honeycomb_tuning__` without filtering `__proto__`/`constructor`/`prototype`. A `__proto__` key re-points the dispatch object's prototype, so a rewritten `globalThis.__honeycomb_tuning__.HONEYCOMB_*` read could resolve through the injected prototype. | **FIXED** |
| F-2 | Info | `scripts/audit-openclaw-bundle.mjs` (whole file) | OpenClaw bundle scanner robustness — verified it cannot be trivially fooled and the controls it checks (`dangerous-exec`, `env-harvesting`) genuinely eliminate the patterns rather than hide them. | **ACCEPTED (no change)** — control is sound |
| F-3 | Info | `scripts/pack-check.mjs` + `package.json` `files` | Publish gate genuinely blocks secrets/refs/CI/git from the tarball. Verified by `npm pack --dry-run`. | **ACCEPTED (no change)** — control is sound |
| F-4 | Info | `scripts/sync-versions.mjs` | Fail-closed JSON manifest sync — no path traversal, no partial-write-on-error, names the offending file. | **ACCEPTED (no change)** — control is sound |
| F-5 | Info | `scripts/ensure-tree-sitter.mjs` | `execSync` in postinstall uses only static package-name literals from a hardcoded allowlist + declared version specs; no untrusted interpolation. | **ACCEPTED (no change)** — no injection |

No Critical, High, or Medium findings.

---

## Critical / High Findings

**None detected.**

---

## Remediation Detail (F-1)

### Before
```ts
export function applyOpenclawTuning(config?: OpenclawPluginConfig): void {
	const tuning = config?.tuning;
	if (!tuning) return;
	const target = (globalThis.__honeycomb_tuning__ ??= {});
	for (const [key, value] of Object.entries(tuning)) {
		target[key] = value;
	}
}
```

### After
```ts
const FORBIDDEN_TUNING_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function applyOpenclawTuning(config?: OpenclawPluginConfig): void {
	const tuning = config?.tuning;
	if (!tuning) return;
	const target = (globalThis.__honeycomb_tuning__ ??= {});
	for (const [key, value] of Object.entries(tuning)) {
		if (FORBIDDEN_TUNING_KEYS.has(key)) continue;
		target[key] = value;
	}
}
```

### Severity rationale (why Low, not High)
The prototype-pollution playbook tags untrusted-merge findings **High** when a polluted value flows
into a downstream privilege object (`if (user.isAdmin)`). Here three facts cap it at **Low**:

1. **No global `Object.prototype` pollution.** `target["__proto__"] = obj` uses the bracket
   **assignment** form, which invokes the `__proto__` *setter* and only re-points `target`'s own
   prototype — it does **not** write onto `Object.prototype`. Verified by PoC: `({}).polluted` stayed
   `undefined`. The blast radius is the single `__honeycomb_tuning__` object, not the whole heap.
2. **The input source is the config owner, not a remote attacker.** `tuning` comes from the
   workspace's own `openclaw.json`. The knobs (`HONEYCOMB_DEBUG`, `HONEYCOMB_QUERY_TIMEOUT_MS`) are
   already user-supplied; a user spoofing their own debug flag via an odd key crosses no trust
   boundary. There is no cross-tenant/cross-org surface in PRD-001.
3. **No downstream privilege object exists yet.** PRD-001 has no role/auth object that reads tuning.

### Why fix it anyway
The playbook gives a clean, zero-risk 3-line guard, and later PRDs will wire tuning into config/role
objects that *do* read these values — fixing the pattern now (defense-in-depth) is cheaper than
auditing it back in later. The fix is the canonical OWASP guard (skip the three dangerous keys).

### Proof the fix resolves it (PoC against the patched logic)
```
spoofed QUERY_TIMEOUT (must be undefined): undefined
legit DEBUG knob still works (must be 1): 1
prototype intact (must be true): true
```
Rebuilt bundle still carries the guard and remains clean:
```
harnesses/openclaw/dist/index.js:29: var FORBIDDEN_TUNING_KEYS = new Set(["__proto__","constructor","prototype"]);
harnesses/openclaw/dist/index.js:35:   if (FORBIDDEN_TUNING_KEYS.has(key)) continue;
process.env count in bundle: 0    child_process/exec count in bundle: 0
```

---

## Category-by-Category Scan Results

| # | Category (scan-procedure step) | Result |
|---|--------------------------------|--------|
| 0 | Deterministic sweeps (`npm audit`, openclaw scan, unicode) | Clean — see below |
| 1 | Dependency + bundle gate | `npm audit` 0 advisories; openclaw scan clean |
| 2 | Rules-file backdoor (hidden Unicode in `.cursor/rules`, manifests, src) | None detected |
| 3 | Env config & secrets (committed `.env`/keys, hardcoded tokens) | None detected; no tracked secrets |
| 4 | API client hardening (`deeplake-api.ts`) | **N/A** — no DeepLake client in PRD-001 |
| 5 | Pre-tool-use gate integrity | **N/A** — no hooks/gate in PRD-001 |
| 6 | DeepLake query construction (`sqlIdent`/`sqlStr`) | **N/A** — no query layer in PRD-001 |
| 7 | MCP tool handlers | **N/A** — MCP server is a DeepLake-free stub, no tools registered |
| 8 | Captured-trace capture path | **N/A** — no capture path in PRD-001 |
| 9 | Prompt-injection surface (skillify) | **N/A** — no skillify pipeline in PRD-001 |
| 10 | Credential file handling | **N/A** — no auth/credential store in PRD-001 |
| 11 | Logging & error paths (token/PII in logs) | None detected — stubs only, no token reads, no secret-shaped content in any bundle |
| 12 | Org RBAC enforcement | **N/A** — no RBAC in PRD-001 |
| 13 | Dependency review | Clean (0 advisories); deps are esbuild/biome/jscpd/typescript/@types/node — all reputable, high-download |

### Deterministic sweep output
- **`npm audit --json --audit-level=high`** → `{"vulnerabilities":{}}`, total 0 (1 prod, 157 dev, 35 optional). **Clean.**
- **`npm run audit:openclaw`** → `OK - no findings. Bundle is clean against ClawHub's static-analysis rules.` Exit 0.
- **Hidden-Unicode/bidi sweep** (`U+200B–200F, U+202A–202E, U+2060–2069, U+FEFF`) over `.cursor/rules`, `.claude-plugin`, `harnesses`, `src`, `mcp`, `embeddings`, `scripts` → no hits.
- **Secret-shape sweep** (`Bearer `, `eyJ`, `sk_`, `-----BEGIN`, `X-Activeloop`, `process.env`) over all six built bundles → no hits.

---

## Focus-Item Verdicts (per mission brief)

### 1. Publish/pack safety — SOUND
- `package.json` uses an **allowlist** `files` array (not a permissive `.npmignore`), so the reference
  dirs `hivemind-v1/`/`otherhive-v1/`, `.git`, `.cursor`, `library/`, `node_modules`, and any `.env`
  can never enter the tarball. `npm pack --dry-run` → 27 files, **zero** suspicious paths.
- `pack-check.mjs` regexes cover `.npmrc`, `.env(.*)`, `secrets/`, `.github/`, `.git/`, SSH keys,
  `.pem/.key/.p12/.pfx`, and `credentials.json`. Patterns are anchored on path separators and are not
  trivially bypassable for the names they target.
- The gate genuinely runs in the publish path: `prepack` → `npm run build`; `pack:check` runs
  `npm pack --dry-run --json` and exits non-zero on any forbidden hit. Verified: exit 0, "pack-check OK".

### 2. OpenClaw / ClawHub bundle integrity — SOUND, no hole
- The `stub-unused-child-process` esbuild plugin replaces `node:child_process` with no-op exports, so
  **no real exec ships** (not hidden — eliminated). Built bundle: 0 `child_process`/`exec` matches.
- The `process.env.HONEYCOMB_* → globalThis.__honeycomb_tuning__.HONEYCOMB_*` define genuinely removes
  every `process.env` substring. Built bundle: **0** `process.env` matches. The only real source read
  (`process.env.HONEYCOMB_DEBUG`, index.ts:66) is in the define list; an un-listed future read would
  ship `process.env` and **fail the scanner closed** — correct behavior, not a bypass.
- **Prototype pollution via `globalThis.__honeycomb_tuning__`:** the one genuine (Low) gap — closed by
  F-1. Confirmed it was **object-local** (no `Object.prototype` write), config-owner-sourced, with no
  downstream privilege object — hence Low, fixed for defense-in-depth.

### 3. Build scripts — no injection, fail-closed
- `sync-versions.mjs`: reads+validates the source and **parses every target up front** before any
  write, so a malformed manifest aborts with the offending filename named and produces **no partial
  output** (FR-6 honored). Paths come from a hardcoded `SCALAR_TARGETS` list resolved against
  `process.cwd()` — no traversal from untrusted input.
- `ensure-tree-sitter.mjs`: `execSync` arguments are built only from a hardcoded `PKGS` allowlist and
  declared dependency version specs — no untrusted interpolation. Recursion-guarded
  (`ENSURE_TS_RUNNING`), greenfield-safe (exits 0 when no grammars present).
- `pack-check.mjs`: the Windows `execSync` branch runs a **fixed literal** command line (no user
  input) — safe; documented inline.

### 4. Dependency hygiene — CLEAN
`npm audit` → 0 Critical/High/Moderate/Low. Added deps (esbuild ^0.28.1, @biomejs/biome ^2.5.0,
jscpd ^4.0.5, typescript ^5.7.0, @types/node ^22) are all reputable, high-download, devDependencies.

### 5. Secrets — NONE
No tracked `.env`/credential/key files (`git ls-files` clean). No hardcoded tokens/JWTs/keys in
`src/**`, `harnesses/**`, `mcp/**`, `embeddings/**`, or `scripts/**`. Reference dirs are gitignored.

---

## Regression Verification (post-fix, all green)

| Command | Exit code |
|---------|-----------|
| `npm run ci` (typecheck + jscpd dup) | **0** — tsc clean, 0 clones |
| `npm run build` (tsc + esbuild) | **0** — 1 daemon + 5 hook-harness + 1 OpenClaw + 1 MCP + 1 CLI + 1 embed-daemon @ 0.1.0 |
| `npm run audit:openclaw` | **0** — bundle clean against ClawHub rules |

No verified acceptance criterion was broken: the change is additive (a key filter), the example
config knobs are unaffected, and the bundle still self-reports its version and contains zero
`process.env`/exec substrings.

---

## Files Changed

| File | Change | In scope? |
|------|--------|-----------|
| `harnesses/openclaw/src/index.ts` | Added `FORBIDDEN_TUNING_KEYS` guard in `applyOpenclawTuning` (prototype-pollution defense-in-depth) | Yes |

Single-file, minimal-blast-radius diff. (`.gitignore` shows as modified in `git status` but that
change predates this audit session and was not touched here.)

---

## Unresolved Critical/High Findings

**None.** There are zero unresolved Critical or High findings. **This audit does not block the run.**
