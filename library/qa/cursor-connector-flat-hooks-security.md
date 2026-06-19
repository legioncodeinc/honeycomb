# Security review — Cursor-connector flat-hooks fix

- **Branch:** `fix-cursor-connector-flat-hooks`
- **Date:** 2026-06-19
- **Reviewer:** security-worker-bee
- **Scope (focused):** the bug-fix diff for the Cursor connector flat-hooks crash + the base
  `contracts.ts` hardening. Files under review:
  - `src/connectors/contracts.ts` (base `patchConfig` guard + new `protected` `stripHoneycomb` / `isConfigEmpty` seams)
  - `src/connectors/cursor.ts` (`toConfigEntry` / `patchConfig` / `stripHoneycomb` overrides + `flatHooks`)
  - `tests/conformance/connector-hooks-conformance.test.ts` + `references/cursor/hooks-schema.ts` (the zod oracle)
- **Out of scope:** full-PRD audit, other harness adapters beyond merge-safety regression.

This is install-time code that INGESTS an untrusted local file (`~/.cursor/hooks.json`). The threat
model is: an attacker who can write that file (or a corrupt/foreign config already on disk) tries to
(a) destroy a foreign hook, (b) crash `honeycomb setup`, (c) pollute `Object.prototype`, (d) churn the
idempotency fingerprint, or (e) reach a filesystem path. Each focus below was exercised against the
REAL compiled `CursorConnector` over the in-memory `createFakeFs` seam.

---

## VERDICT: PASS-WITH-FIXES

One Medium finding fixed in-session with a load-bearing regression test; the rest of the threat space
was probed and is clean. No Critical or High findings.

**Severity counts:** Critical 0 · High 0 · Medium 1 (fixed) · Low 2 (documented) · Informational 1.

---

## Findings

### M-1 (Medium, FIXED) — foreign-preserve violation + prototype-key handling in `flatHooks`/Cursor write-back

- **Where:** `src/connectors/cursor.ts` — `flatHooks` (the `out[event] = entries` write-back) and the
  two override write-back loops in `patchConfig` and `stripHoneycomb` (`hooks[event] = …`).
- **Threat foci:** #1 (foreign-config destruction) and #2 (hostile-input / prototype-pollution angle).
- **Exploit:** a `~/.cursor/hooks.json` on disk whose raw JSON text contains an event key named
  `__proto__` (`{"hooks":{"__proto__":[{"command":"node /foreign/x.js"}], …}}`). `JSON.parse` turns
  `"__proto__"` into an **own enumerable** key, so `Object.entries(config.hooks)` yields it — but the
  write-back `out[event] = entries` with `event === "__proto__"` assigns through the **prototype
  setter** of a plain `{}` accumulator instead of creating an own property. Result: the foreign hook
  registered under that key is **silently dropped** on install and uninstall (verified: `proto
  survives: false`, while a normal sibling key survived). That is precisely the byte-exact
  foreign-preserve guarantee the diff claims to uphold through the flat merge AND the nested→flat
  normalization path. A maliciously crafted value under the key is also the textbook prototype-pollution
  shape, so the same write deserves an unpollutable target.
- **Pre-existing vs introduced:** the same `Object.entries → obj[event] =` idiom exists in the base
  Claude-Code `patchConfig` (confirmed it drops a `__proto__` event key identically), so this is a
  latent family-wide foreign-preserve gap **surfaced** — not introduced — by this diff. The diff's
  explicit claim of byte-exact foreign-preserve through the new normalization is what makes it in-scope
  to close here. Fix applied only to the Cursor flat path (minimal blast radius); the base nested path
  is noted under L-2.
- **Why Medium (not High):** `__proto__`/`constructor` are not valid Cursor event names, the conformance
  oracle rejects them, the file is already attacker-owned, and (critically) there is **no actual
  prototype pollution** — `JSON.parse` + object spread keep `__proto__` as own data and never touch
  `Object.prototype` (verified: `({}).command === undefined` before/during/after a full round-trip). So
  the realized impact is "a foreign entry under a pathological key is not preserved," not RCE.
- **Remediation:** changed the three accumulators in `cursor.ts` from `{}` to
  `Object.create(null)`. A null-prototype object makes `obj["__proto__"] = …` an **own** data property
  (preserved, and re-emitted verbatim by `JSON.stringify`), and makes prototype pollution structurally
  impossible. No behavior change for any legitimate config (downstream uses `Object.entries`, which only
  reads own enumerable keys). Verified the dangerous-key foreign hooks now survive both install and
  uninstall, with `Object.prototype` untouched throughout.
- **Regression test:** `tests/commands/cursor-connector.test.ts` →
  `"SECURITY: a foreign hook under a dangerous event key (__proto__/constructor) is PRESERVED, never
  silently dropped, and never pollutes Object.prototype"`. Proven load-bearing: with the fix reverted to
  `{}` the test FAILS (`expected … to contain '/foreign/proto-event.js'`); with the fix it passes. The
  fixture uses a **raw JSON string** (not a JS object literal — a `{__proto__: …}` literal sets the
  prototype and `JSON.stringify` would not even emit it; the real on-disk threat is literal text).

### L-1 (Low, documented) — sentinel-spoof uninstall of a foreign entry (accepted design)

- **Where:** `isHoneycombEntry` (`contracts.ts:295`) keys off the `_honeycomb: true` sentinel.
- **Threat focus:** #1 (sentinel spoofing).
- **Behavior:** a foreign flat entry that deliberately sets `_honeycomb: true` IS reclaimed and deleted
  on uninstall/refresh (verified: T1 round-trip unlinks it). This is the **documented, accepted** design
  (`contracts.ts:42-52`): the sentinel is a trust marker the harness round-trips, and a foreign
  third-party hook "NEVER" carries it. An attacker who can write the sentinel into the user's config
  already owns that file, so there is no privilege boundary crossed. Not introduced by this diff (the
  base predicate predates it). No fix; documented so the assumption is on record.

### L-2 (Low, documented) — `__proto__` event-key drop also latent in the base nested path

- **Where:** base `patchConfig` (`contracts.ts:421`) and the `stripHoneycomb` helper (`contracts.ts:542`),
  same `obj[event] =` idiom over a plain `{}`.
- **Behavior:** a `__proto__` event key in a Claude-Code `settings.json` would be dropped identically.
  Lower urgency than M-1: it is genuinely out of this diff's scope (Claude path is untouched here), and
  Claude Code's own event-name set rejects `__proto__`. Recommend a follow-up to apply the same
  null-prototype accumulator to the base `patchConfig`/`stripHoneycomb` for parity. Flagging, not fixing,
  to keep this diff's blast radius minimal.

### I-1 (Informational) — DoS / hostile-shape resilience is solid

- **Threat focus:** #2 (crash/DoS). Adversarial shapes were fed to `patchConfig`/`flatHooks`/
  `stripHoneycomb`: `hooks` as array/string/null, event value as string/number, `null`/`42`/`"x"`
  entries mixed with a real one, a deeply nested Claude-shaped block. **None throw** — `flatHooks` skips
  non-array event values and non-object items defensively, and the base guard
  (`Array.isArray(blocks)`/`Array.isArray(b.hooks)`) closes the original `undefined.filter` crash.
  Hardened by a new regression test:
  `tests/commands/cursor-connector.test.ts` → `"DoS: install/uninstall over adversarially malformed
  hooks.json shapes never throws"`. Note: a non-object event value like `sessionStart: "x"` is silently
  dropped (it can never be a real foreign hook), which is acceptable preserve behavior.

---

## Threat-focus coverage matrix

| # | Focus | Result |
|---|-------|--------|
| 1 | Foreign-config destruction / sentinel spoof / normalization preserve | **M-1 fixed** (proto-key drop); L-1 accepted (sentinel spoof). Round-trip of a foreign-only flat config is byte-identical (conformance suite + `cursor-connector.test.ts`). Nested→flat flattens foreign handlers forward without dropping/reordering. |
| 2 | Crash / DoS / prototype pollution on hostile input | **Clean.** No unhandled throw on any malformed shape; **no `Object.prototype` pollution** (`JSON.parse`+spread keep `__proto__` as own data). M-1 hardened the accumulators as defense-in-depth. |
| 3 | `writeJsonIfChanged` integrity / idempotency churn | **Clean.** Re-install over a seeded nested OR flat config is stable (`second.wroteConfig === false`, byte-identical fingerprint). No churn vector found. |
| 4 | Path / traversal | **Clean.** No attacker-influenced field reaches a filesystem path. `handlerPath`/`sourcePath` are built only from injected `pluginRoot`/`bundleSource` + a fixed `CURSOR_HANDLERS` filename constant; `handler.event` and command strings are used only as in-memory config keys/values, never in `writeFile`/`ensureDir`. |
| 5 | Base change leaking risk to other connectors | **Clean.** `contracts.ts` base hardening is purely additive (the `protected` seams default to the existing pure helpers; the `Array.isArray` guard only makes a previously-throwing path safe). Claude Code's emitted + merge + foreign-preserve behavior is unchanged — `tests/connectors/connector-base.test.ts` (11) and the Claude block of the conformance suite stay green. The M-1 fix is confined to `cursor.ts` and does not touch the base. |

---

## What I fixed + regression test names

- **Fix:** `src/connectors/cursor.ts` — `flatHooks`, `patchConfig` override, `stripHoneycomb` override
  now use `Object.create(null)` accumulators (3 sites). Foreign hooks under prototype-shaped event keys
  are preserved through install + uninstall; prototype pollution is structurally impossible.
- **Tests added** (`tests/commands/cursor-connector.test.ts`, no existing test weakened):
  1. `SECURITY: a foreign hook under a dangerous event key (__proto__/constructor) is PRESERVED, never
     silently dropped, and never pollutes Object.prototype` — proven load-bearing (fails on revert).
  2. `DoS: install/uninstall over adversarially malformed hooks.json shapes never throws`.

## Post-fix gate exit codes

| Gate | Result |
|------|--------|
| `npm run ci` (typecheck + jscpd + vitest, includes `audit:sql`) | **0** — 143 files, 1453 passed / 4 skipped; SQL-safety "OK - every SQL interpolation routes through an escaping helper." |
| `npm run build` (`tsc && esbuild`) | **0** — 1 daemon + 5 hook-harness + 1 OpenClaw + 1 MCP + 4 SDK + 1 CLI + 1 embed-daemon bundle @ 0.1.0 |
| `npm run audit:openclaw` | **0** — "OK - no findings. Bundle is clean against ClawHub's static-analysis rules." |
| `tests/daemon/storage/invariant.test.ts` | **0** — 3 passed |
| `tests/connectors/connector-base.test.ts` | **0** — 11 passed (other-connector regression: GREEN) |
| `tests/conformance/connector-hooks-conformance.test.ts` | **0** — 18 passed |
| `tests/commands/cursor-connector.test.ts` | **0** — 5 passed (incl. 2 new security tests) |

`git status --short` after fixes: only `src/connectors/cursor.ts` + `tests/commands/cursor-connector.test.ts`
modified by me (plus the diff's pre-existing `contracts.ts` change and untracked `references/` +
`tests/conformance/`). No unrelated changes. Git operations left to the orchestrator.
