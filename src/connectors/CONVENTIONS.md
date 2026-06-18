# Connector base — CONVENTIONS (PRD-019a)

Connectors live under `src/connectors/`. A connector is an INSTALL-TIME tool: it patches a
harness's config, writes the compiled hook handlers, and links skills — once, during
`honeycomb setup` / `honeycomb connect <harness>`. The abstract base + the filesystem seam +
the `ClaudeCodeConnector` reference + the `setup`/`connect`/`uninstall` CLI verbs are now
FILLED (019a Wave 2). `install()`/`uninstall()` + the shared mechanics live on the base; a new
harness is a SUBCLASS overriding only the four seams (a-AC-5).

**Read `src/hooks/shared/CONVENTIONS.md`** — the connector WRITES the handler set that core
defines, so the two contracts meet at the hook-handler bundle.

## The central rule: install-time only — NEVER opens DeepLake, holds no daemon handle (FR-9)

- **Module home = `src/connectors/` ON PURPOSE.** `src/connectors` is in `NON_DAEMON_ROOTS`
  (`tests/daemon/storage/invariant.test.ts`, D-2). A connector cannot import the storage client.
- **All disk access goes through the `ConnectorFs` seam.** The base is constructed with a
  `ConnectorFs`; the real impl wraps `node:fs`, the `FakeFs` (`createFakeFs`) is in-memory. A
  Wave-2 test drives install/uninstall against the fake — it NEVER touches the developer's real
  `~/.claude`, `~/.cursor`, `~/.codex`. This is also the Wave-3 security boundary (path-traversal /
  symlink safety / foreign-config containment are audited against this seam).
- **No runtime path, no daemon call.** Runtime calls are the hooks' job (019b). A connector that
  stamps a runtime path or dials the daemon is the wrong layer.

## A new connector is a SUBCLASS, not a fork (FR-1 / a-AC-5)

`HarnessConnector` (abstract) owns `install()`/`uninstall()` and the shared mechanics. A
per-harness connector overrides ONLY the four seams:

1. `configPath()` — the harness's hook-config file path.
2. `hookHandlers()` — the compiled handler set from `harnesses/<h>/bundle/`.
3. `skillLinkTargets()` — where org/team skills are symlinked.
4. `eventNameMap()` — the native event names the handlers register under (mirrors the 019c shim map).

`ClaudeCodeConnector` is the reference proving a-AC-5: it adds NO install logic, only the four
overrides.

## The shared mechanics every connector inherits (FR-2..FR-7)

- **`writeJsonIfChanged` (FR-2 / FR-5 / a-AC-3):** read-compare-write — a no-change re-install
  touches NO file, preserving the harness's hook-trust fingerprint (no re-trust dialog).
- **`isHoneycombEntry` (FR-2 / a-AC-1):** the predicate that filters Honeycomb entries so install
  appends/refreshes only Honeycomb's hooks and PRESERVES foreign entries.
- **foreign-config-preserve (a-AC-1):** install parses the existing structure, filters via
  `isHoneycombEntry`, appends Honeycomb entries, never clobbers a foreign hook.
- **skill symlink rule (FR-4 / a-AC-6):** skills are linked with symlinks into per-harness skill
  dirs; an existing foreign entry is PRESERVED, only Honeycomb symlinks are added.
- **`detectPlatforms` (FR-7 / a-AC-4):** detect installed harnesses so `honeycomb setup` with no
  target wires every detected one; `honeycomb connect <harness>` wires one.
- **emptied-config unlink (FR-6 / a-AC-2):** uninstall removes only Honeycomb's hooks/links/keys;
  when the resulting config holds no further entries, the config file is cleanly unlinked.

## References gate (FR-8 / D-3)

Every connector change is gated on inspecting the sibling harness repo under
`references/<harness>/` for the exact config schema + hook protocol. No sibling repos exist under
`references/` in THIS repo, so the gate is a documented CONTRIBUTION RULE; CI enforcement is the
PRD's deferred open question (D-3). Each connector cites the schema it relies on in its header.

## The Honeycomb-entry sentinel (`HONEYCOMB_ENTRY_KEY`)

`isHoneycombEntry` keys off a dedicated `_honeycomb: true` field stamped on every Honeycomb
config hook entry (`HONEYCOMB_ENTRY_KEY`), NOT a command-substring match. A harness command
(`node "${…_PLUGIN_ROOT}/bundle/…"`) is not self-identifying — the runtime-resolved plugin root
carries no literal marker — so a substring match would both duplicate Honeycomb entries on
re-install (false negative) and risk clobbering a foreign hook (false positive). The sentinel the
harness round-trips verbatim makes the predicate EXACT, which is what keeps install idempotent
(a-AC-3) and uninstall foreign-safe (a-AC-2). A legacy `…/honeycomb/bundle/…` command path is
still reclaimed as a back-compat fallback so an upgrade-uninstall cleans pre-sentinel installs.

## CLI verbs (`src/connectors/cli.ts`)

`honeycomb setup` (wire every detected harness — a-AC-4), `honeycomb connect <harness>` (wire one),
`honeycomb uninstall [<harness>]` (reverse only Honeycomb — a-AC-2) are filled in
`src/connectors/cli.ts`: `runConnectorCommand` constructs connectors over an injected
`ConnectorFs` + a `ConnectorRegistry` seam and calls `install()`/`uninstall()`. It is storage-free
(install-time only, FR-9). HONEST DEFERRAL (matches 001–018): the bundled `honeycomb` bin is NOT
yet extended to dispatch to these verbs — that is the deferred pure-wiring assembly step (mirrors
`src/cli/org.ts` / `skillify.ts`). The verbs are constructed-and-tested behind the seams; the
`ConnectorRegistry` is supplied by the daemon-assembly wiring (real `node:fs` + the user home)
and by the AC-named test (a `createFakeFs` + fake registry).

## What Wave 2 filled (signatures STABLE)

- `HarnessConnector.install/uninstall/writeJsonIfChanged/isHoneycombEntry/detectPlatforms/
  patchConfig/linkSkills/unlinkSkills` bodies — DONE.
- `ClaudeCodeConnector` four seam overrides (cited against the in-repo Claude Code hooks protocol;
  no `references/claude-code/` sibling exists per D-3) — DONE.
- `src/connectors/cli.ts` `setup`/`connect`/`uninstall` verbs — DONE (bin dispatch deferred).
- STILL TODO (later sub-PRDs): the other concrete connectors (codex, cursor, openclaw, hermes, pi)
  — each a subclass overriding only the four seams.
