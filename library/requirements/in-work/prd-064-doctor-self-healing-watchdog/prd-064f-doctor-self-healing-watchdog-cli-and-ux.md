# PRD-064f: Doctor - CLI and UX

> **Parent:** [PRD-064](./prd-064-doctor-self-healing-watchdog-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** M (3-8h)

---

## Goals

A delightful, branded operator tool for fixing Honeycomb installs by hand - and the single explicit path to update Doctor's own package.

- Print a cute "hive doctor" ASCII art on bare invocation, followed by a focused command menu.
- Provide diagnostic + manual-fix commands that map onto the same remediation primitives the watch loop uses.
- Provide `doctor self-update` as the ONLY way Doctor's own package is ever updated (AC-6 parent).

## Scope

Command surface (names indicative):

| Command | Purpose |
|---|---|
| `doctor` (no args) | ASCII art + menu/help |
| `doctor status` | daemon health, Doctor service state, versions, last heal, opt-out state |
| `doctor diagnose` | run the health classifier + print the recommended rung, take no action |
| `doctor heal` | run the remediation ladder once, interactively (gated rungs prompt) |
| `doctor restart` | rung 1 only |
| `doctor reinstall` | rung 2 only |
| `doctor uninstall-hivemind` | rung 3 - remove a conflicting `@deeplake/hivemind` |
| `doctor update [--check]` | check/apply primary-daemon update (064e), respecting the blessed gate |
| `doctor self-update` | **explicit-only** update of `@legioncodeinc/doctor` itself |
| `doctor install-service` / `uninstall-service` | 064b service registration |
| `doctor logs` | tail the local incident log |

## Out of scope

- The auto behaviors behind these commands - [064a](./prd-064a-doctor-self-healing-watchdog-supervisor-core-and-lifecycle.md)/[064c](./prd-064c-doctor-self-healing-watchdog-remediation-ladder.md)/[064e](./prd-064e-doctor-self-healing-watchdog-auto-update-engine.md).
- Dashboard rendering - [064g](./prd-064g-doctor-self-healing-watchdog-dashboard-escalation-reporting.md).

## Acceptance criteria

- AC-064f.1 Given `doctor` with no args, when run, then the ASCII art renders and a command menu is shown (AC-7 parent).
- AC-064f.2 Given `doctor status`, when run, then it prints daemon health, service state, both package versions, last heal, and opt-out flags.
- AC-064f.3 Given `doctor diagnose`, when run, then it reports the recommended rung and takes NO action.
- AC-064f.4 Given `uninstall-hivemind`, when run interactively, then it confirms before removing the conflicting package and never deletes shared `~/.deeplake/` state. (No `clear-credentials` command in v1 - credential purge is deferred, OD-4.)
- AC-064f.5 Given `doctor self-update`, when and only when run explicitly, then `@legioncodeinc/doctor` is updated; no other code path updates it (AC-6 parent).
- AC-064f.6 Given the daemon is down, when `doctor status`/`diagnose` run, then they still work (Doctor does not depend on the daemon to report).

## Technical considerations

- **Branding:** align the ASCII art with the recently shipped branded CLI help for `@legioncodeinc/honeycomb`; reuse palette/voice.
- **No heavy CLI framework:** keep arg parsing minimal (built-ins) to honor the can't-crash principle.
- **`self-update` is sacred:** it is the deliberate exception to "Doctor never updates itself"; everywhere else self-update is impossible by construction.

## Open questions

- [ ] Final ASCII art (a bee with a stethoscope / doctor's bag?).
- [ ] Should `heal` be allowed non-interactively (e.g. `--yes`) for power users, and how does that interact with gated-rung authority (OD-4)?
