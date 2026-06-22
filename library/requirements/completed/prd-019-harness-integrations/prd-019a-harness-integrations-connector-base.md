# PRD-019a: Shared Connector Base

> **Parent:** [PRD-019](./prd-019-harness-integrations-index.md)
> **Status:** Draft
> **Priority:** P0
> **Effort:** M

## Scope

The install-time connector base that every per-harness connector extends: patch harness config, write lifecycle hook handlers, link skills, and reverse all of it on uninstall, idempotently and without clobbering foreign config. Connectors run once during `honeycomb setup` or `honeycomb connect <harness>`. They are distinct from runtime plugins and extensions, which run inside the harness process during a session. This sub-PRD owns the shared base class, the install/uninstall contract, and the idempotency and foreign-config rules every connector inherits. It does not own per-harness divergences (019c) or the runtime hook contract (019b).

## Goals

- A single connector base class that every per-harness connector extends, so adding a harness means filling in config locations and event names, not rewriting install logic.
- Install that patches harness config, writes compiled hook handlers, and links skills idempotently, preserving foreign entries and the harness hook-trust fingerprint.
- Uninstall that strips only Honeycomb's changes and cleanly unlinks an emptied config file.
- A references-gate workflow that requires inspecting the sibling harness repo under `references/<harness>/` before any connector change ships.

## Non-Goals

- The runtime lifecycle hook contract and what each event does (019b).
- Per-harness event-name and payload divergences (019c).
- The MCP server (019d) and SDK (019e).
- Daemon storage, tenancy, or DeepLake access; connectors are thin install-time tools.

## User stories

- As a user, I want `honeycomb setup` to wire my harness once so that I get memory without hand-editing config files.
- As a user with existing third-party hooks, I want install to leave my own hooks untouched so that Honeycomb never breaks my other tooling.
- As a user uninstalling, I want only Honeycomb's footprint removed so that my harness returns to its prior state.
- As an integration engineer, I want a base class so that a new harness connector is a small subclass rather than a copy-paste fork.

## Functional requirements

- FR-1: The base exposes `install()` and `uninstall()` plus subclass hooks for config path, hook-handler set, skill link targets, and event-name map. Each per-harness connector subclasses the base and overrides only those.
- FR-2: `install()` patches the harness config by parsing the existing structure, filtering Honeycomb entries via an `isHoneycombEntry` predicate, appending Honeycomb hook entries, and writing back only when the serialized result differs (`writeJsonIfChanged`).
- FR-3: `install()` writes the compiled hook handlers to the harness's on-disk location (for example `~/.cursor/honeycomb/bundle/`, `~/.codex/`) and registers them in the config so the harness invokes them at each lifecycle event.
- FR-4: `install()` links org and team skills into the harness's skill locations using symlinks, never clobbering existing entries (for example `~/.cursor/skills-cursor/` and `<project>/.cursor/skills/`).
- FR-5: Install is idempotent: re-running with no change touches no file, preserving the harness hook-trust fingerprint and avoiding re-trust warning dialogs.
- FR-6: `uninstall()` removes only Honeycomb hook entries, skill links, and config keys; when the resulting config holds no further entries, the config file is cleanly unlinked.
- FR-7: Connectors detect installed harnesses (`detectPlatforms`) so `honeycomb setup` with no target wires every detected harness, and `honeycomb connect <harness>` wires one.
- FR-8: Every connector change is gated on inspecting the sibling harness repo under `references/<harness>/` for the exact config schema and hook protocol; CI flags connector diffs that lack a referenced sibling check.
- FR-9: Connectors are install-time only and never open DeepLake, hold a daemon handle, or stamp a runtime path; runtime calls are the hooks' job (019b).

## Acceptance criteria

| ID | Criterion |
|---|---|
| AC-1 | Given a harness config already containing third-party hooks, when the connector installs, then it appends Honeycomb hooks and preserves the foreign entries. |
| AC-2 | Given an installed connector, when uninstall runs, then only Honeycomb's hooks, links, and config keys are removed and an emptied config file is cleanly unlinked. |
| AC-3 | Given an already-installed connector, when install re-runs with no change, then no config file is written and the hook-trust fingerprint is unchanged. |
| AC-4 | Given `honeycomb setup` with no target on a box with two detected harnesses, when it runs, then both harnesses are wired. |
| AC-5 | Given a new per-harness connector, when it is implemented, then it subclasses the base and overrides only config path, hook set, skill targets, and event map. |
| AC-6 | Given skill linking runs, when a skill location already holds a foreign entry, then existing entries are preserved and only Honeycomb symlinks are added. |

## Implementation notes

- Connectors are install-time and distinct from runtime plugins; the two surfaces must not be conflated. Idempotency is implemented with `writeJsonIfChanged` so re-running touches nothing and preserves the harness's hook-trust fingerprint.
- The base mirrors the Cursor auto-wiring rules (preserve foreign hooks, idempotent, reverse cleanly), generalized so every harness inherits the same correctness and safety guarantees.
- Skill links use symlinks into per-harness skill directories; the `harnesses/<harness>/bundle/` compiled output is the install source for hook handlers.
- The references gate is a hard contribution rule: no direct sibling-harness check means no verdict on that integration.

## Dependencies

- PRD-019b (lifecycle hook contract) for the handlers the connector writes.
- PRD-019c (per-harness shims) for the divergences each connector parameterizes.
- PRD-020a (`honeycomb setup` / `connect` / `uninstall` verbs) as the CLI entry points.
- Daemon credential file (`~/.honeycomb/credentials.json`) shared with hooks at runtime.

## Open questions

- [ ] Where does the line sit between a hooks-only connector and one that also installs a runtime extension for new harness entrants?
- [ ] How is the references gate enforced in CI rather than by convention?

## Related

- [parent index](./prd-019-harness-integrations-index.md)
- [Harness Integration](../../../knowledge/private/integrations/harness-integration.md)
- [Hook Lifecycle](../../../knowledge/private/integrations/hook-lifecycle.md)
