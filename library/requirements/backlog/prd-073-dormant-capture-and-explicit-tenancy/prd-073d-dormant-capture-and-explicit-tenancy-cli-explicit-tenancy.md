# PRD-073d: CLI Explicit Tenancy on `honeycomb auth login`

> **Parent:** [PRD-073](./prd-073-dormant-capture-and-explicit-tenancy-index.md)
> **Status:** Draft
> **Priority:** P1 (the dashboard path 073c covers the common case; the CLI must not remain a silent-guess back door)
> **Effort:** M (4-8h)
> **Schema changes:** None. CLI behavior only; persists through 073c's phase-2 internals.

---

## Goals

The CLI login honors the same no-silent-guess contract as the dashboard: an interactive terminal prompts for the org and workspace; a non-interactive invocation requires explicit `--org` / `--workspace` flags; only a single-org, single-workspace account may auto-select, and the choice is always printed.

## Scope

- **Flag plumbing exists; semantics change.** `parseAuthArgs` already parses `--org` / `--workspace` (`src/cli/auth.ts:122`, `AUTH_VALUE_FLAGS`), but today they apply ONLY to the self-hosted `--endpoint` path (`src/cli/auth.ts:276-277`, defaults `local`/`default`). This sub-PRD makes them first-class on the HOSTED device-flow and headless-token logins: when given, they select the tenancy (validated against `listOrgs` / `listWorkspaces`, accepting a name or an id exactly as `org switch` resolves, `src/cli/org.ts:9-19`).
- **TTY prompt path.** On an interactive terminal (`process.stdout.isTTY` and stdin TTY), after authentication enumerates the lists (073c phase 1), the CLI renders a numbered org picker then a numbered workspace picker (the pattern every CLI knows; single-keypress niceties are out of scope). The prompt is skipped for whichever half a flag or env pin already fixed.
- **Non-TTY path.** With no TTY and no flags (and no env pins) on a multi-org or multi-workspace account, the login FAILS with a hard, actionable error naming the available orgs and the required flags, and writes NO credential. This is the parent's non-TTY rule: scripts must state their tenancy.
- **Auto-select with announcement.** Exactly one org and one workspace: auto-select and print "Using org X (id), workspace Y." (parent AC-8). The existing success line already prints the resolved identity (`reportLoggedIn`, `src/cli/auth.ts:188-192`); the announcement requirement is that the SELECTION is printed even when it was not chosen interactively, before capture can start.
- **Headless token login (`--token` / `HONEYCOMB_TOKEN`)** (`loginWithToken`, `src/daemon/runtime/auth/deeplake-issuer.ts:633-639`; CLI branch `src/cli/auth.ts:216-229`): same rules. The token authenticates; the tenancy still requires flags/pins/prompt/single-tenancy auto-select. Today it persists through the same guessing `persistFromToken` (`deeplake-issuer.ts:524-527,534`); it moves to the chosen-pair persist.
- **Env pins** `HONEYCOMB_ORG_ID` / `HONEYCOMB_WORKSPACE_ID` (`src/daemon/runtime/auth/credentials-store.ts:112-114`) satisfy explicitness for their half (parent AC-10), printed like a flag selection.
- **Marker stamp.** Every successful CLI login stamps the 073c confirmed-tenancy marker through the shared persist internals; no marker logic is duplicated in the CLI.
- **Self-hosted `--endpoint` path:** already explicit-or-defaulted by design; unchanged except the marker stamp (see 073c out-of-scope note).

## Out of scope

- The pending-link daemon routes (073c); the CLI performs the whole flow in-process using the same issuer internals, not the HTTP routes.
- `org switch` / `workspace switch` (unchanged post-link mechanics).
- Any change to logout (`src/cli/auth.ts:309-332`).

---

## User stories and acceptance criteria

### US-073d.1 - Interactive logins choose

- AC-073d.1.1 Given a TTY and a multi-org account, when `honeycomb auth login` authenticates, then the CLI prompts with the org list, then the chosen org's workspace list, persists the chosen pair + marker, and prints the choice. No credential exists before the choice.
- AC-073d.1.2 Given `--org` provided but multiple workspaces, when the login runs on a TTY, then only the workspace prompt renders.

### US-073d.2 - Scripts state their tenancy

- AC-073d.2.1 Given no TTY, no flags, no pins, and a multi-org account, when the login runs, then it exits non-zero with an error listing the org ids/names and the `--org` / `--workspace` requirement, and no credential file is written.
- AC-073d.2.2 Given `--org <name-or-id> --workspace <name-or-id>` on any terminal, when the login runs, then the values resolve against `listOrgs` / `listWorkspaces` (name or id), persist + marker, choice printed; an unknown value exits non-zero with nothing written.

### US-073d.3 - Single-tenancy accounts and pins stay scriptable

- AC-073d.3.1 Given one org and one workspace, when the login runs anywhere (TTY or not), then it auto-selects, prints "Using org X, workspace Y", persists + marker (parent AC-8).
- AC-073d.3.2 Given env pins covering both halves, when the login runs non-TTY, then it succeeds with the pinned pair, printed (parent AC-10).

---

## Technical considerations

- Prompting is a new, small seam (injectable reader/writer over the existing `OutputSink` pattern, `src/cli/auth.ts:53`) so the suite drives prompts deterministically; no readline dependency beyond `node:readline`.
- TTY detection is injectable (`isTTY` seam) for tests; the real check is `process.stdin.isTTY && process.stdout.isTTY`.
- The token is never printed (existing D-4 discipline throughout `src/cli/auth.ts:28-30`); prompts render ids + names only.
- Exit-code contract matches the existing auth CLI (`AuthResult`, `src/cli/auth.ts:94-100`): non-zero on refusal, nothing written.
- DEFAULT - confirm before implementation: a `--yes`-style flag to accept auto-select in future multi-tenancy edge cases is NOT added; explicitness is the point.

## Test plan

- Prompt suite (fake TTY + scripted answers): full pick, half-pinned pick, invalid answer re-prompts, Ctrl-C-equivalent abort writes nothing.
- Non-TTY suite: refusal matrix (no flags, partial flags on multi-workspace org), flag resolution by name and by id, unknown values.
- Auto-select and pin suites: single-tenancy announce; pins announce; headless `--token` obeys the same matrix.
- Regression: self-hosted `--endpoint` path byte-identical except the marker stamp.
