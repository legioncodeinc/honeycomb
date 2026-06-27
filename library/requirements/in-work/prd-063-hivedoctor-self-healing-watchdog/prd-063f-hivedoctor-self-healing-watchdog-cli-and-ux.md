# PRD-063f: HiveDoctor - CLI and UX

> **Parent:** [PRD-063](./prd-063-hivedoctor-self-healing-watchdog-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** M (3-8h)

---

## Goals

A delightful, branded operator tool for fixing Honeycomb installs by hand - and the single explicit path to update HiveDoctor's own package.

- Print a cute "hive doctor" ASCII art on bare invocation, followed by a focused command menu.
- Provide diagnostic + manual-fix commands that map onto the same remediation primitives the watch loop uses.
- Provide `hivedoctor self-update` as the ONLY way HiveDoctor's own package is ever updated (AC-6 parent).

## Scope

Command surface (names indicative):

| Command | Purpose |
|---|---|
| `hivedoctor` (no args) | ASCII art + menu/help |
| `hivedoctor status` | daemon health, HiveDoctor service state, versions, last heal, opt-out state |
| `hivedoctor diagnose` | run the health classifier + print the recommended rung, take no action |
| `hivedoctor heal` | run the remediation ladder once, interactively (gated rungs prompt) |
| `hivedoctor restart` | rung 1 only |
| `hivedoctor reinstall` | rung 2 only |
| `hivedoctor uninstall-hivemind` | rung 3 - remove a conflicting `@deeplake/hivemind` |
| `hivedoctor update [--check]` | check/apply primary-daemon update (063e), respecting the blessed gate |
| `hivedoctor self-update` | **explicit-only** update of `@legioncodeinc/hivedoctor` itself |
| `hivedoctor install-service` / `uninstall-service` | 063b service registration |
| `hivedoctor logs` | tail the local incident log |

## Out of scope

- The auto behaviors behind these commands - [063a](./prd-063a-hivedoctor-self-healing-watchdog-supervisor-core-and-lifecycle.md)/[063c](./prd-063c-hivedoctor-self-healing-watchdog-remediation-ladder.md)/[063e](./prd-063e-hivedoctor-self-healing-watchdog-auto-update-engine.md).
- Dashboard rendering - [063g](./prd-063g-hivedoctor-self-healing-watchdog-dashboard-escalation-reporting.md).

## Acceptance criteria

- AC-063f.1 Given `hivedoctor` with no args, when run, then the ASCII art renders and a command menu is shown (AC-7 parent).
- AC-063f.2 Given `hivedoctor status`, when run, then it prints daemon health, service state, both package versions, last heal, and opt-out flags.
- AC-063f.3 Given `hivedoctor diagnose`, when run, then it reports the recommended rung and takes NO action.
- AC-063f.4 Given `uninstall-hivemind`, when run interactively, then it confirms before removing the conflicting package and never deletes shared `~/.deeplake/` state. (No `clear-credentials` command in v1 - credential purge is deferred, OD-4.)
- AC-063f.5 Given `hivedoctor self-update`, when and only when run explicitly, then `@legioncodeinc/hivedoctor` is updated; no other code path updates it (AC-6 parent).
- AC-063f.6 Given the daemon is down, when `hivedoctor status`/`diagnose` run, then they still work (HiveDoctor does not depend on the daemon to report).

## Technical considerations

- **Branding:** align the ASCII art with the recently shipped branded CLI help for `@legioncodeinc/honeycomb`; reuse palette/voice.
- **No heavy CLI framework:** keep arg parsing minimal (built-ins) to honor the can't-crash principle.
- **`self-update` is sacred:** it is the deliberate exception to "HiveDoctor never updates itself"; everywhere else self-update is impossible by construction.

## Open questions

- [ ] Final ASCII art (a bee with a stethoscope / doctor's bag?).
- [ ] Should `heal` be allowed non-interactively (e.g. `--yes`) for power users, and how does that interact with gated-rung authority (OD-4)?
