# PRD-050a: One-Command Bootstrap Installer

> **Parent:** [PRD-050](./prd-050-quick-install-and-guided-setup-index.md)
> **Status:** Completed — shipped with PRD-050 (merged #100, 2026-06-25)
> **Priority:** P0
> **Effort:** L (1-3d)
> **Schema changes:** None. Writes a machine-local onboarding state file only.

---

## Overview

This is the front door. It owns the **single command** a brand-new user pastes — `curl -fsSL https://get.honeycomb…/install.sh | sh` on macOS/Linux, `irm https://get.honeycomb…/install.ps1 | iex` on Windows PowerShell — and everything between that paste and a **running daemon serving the dashboard**. It assumes the operator knows nothing: no Node, no npm, no idea what a daemon is. Its contract is "leave them on a dashboard, or tell them in one plain sentence why not."

The script is deliberately **thin and idempotent**: it detects what is already present, installs only what is missing, and re-running it is safe. The heavy lifting (auth, dashboard, migration) is the daemon's and the dashboard's job (050b–050d); this sub-PRD stops the moment the browser is told to open.

## Goals

- **Detect-then-install a current stable Node/npm** if absent. A junior user will not have npm; the script installs it via the platform's standard mechanism (open question: official installer vs `fnm`/`nvm` vs `winget`/Homebrew), and if installation needs elevation it cannot get, prints the **exact** copy-paste command and exits cleanly (non-zero, no stack trace).
- **Install the runtime dependencies** the daemon needs — notably `@huggingface/transformers` (the embedding runtime) — that are not guaranteed to come in transitively. "Size doesn't matter" per the brief: pull whatever the daemon requires; just keep the model download **backgrounded** (050b) so it never blocks the dashboard.
- **Install `@legioncodeinc/honeycomb` globally** (`npm i -g @legioncodeinc/honeycomb@latest`), pinning to the latest published stable.
- **Bring up the daemon** on its port (3850) via the existing ensure-running path ([`src/commands/daemon.ts`](../../../../src/commands/daemon.ts) `ensureDaemonRunning`), wait on `/health`, and **open the dashboard** in the default browser — at `honeycomb.local` when resolvable, else the `http://127.0.0.1:3850/dashboard` loopback fallback.
- **A readable progress log** for every step (`✓ Node 22.x found`, `→ installing @legioncodeinc/honeycomb…`, `✓ daemon up on :3850`, `→ opening dashboard…`), and a single plain-language error + next-step on any failure.
- **Idempotent + re-runnable:** a second run detects the daemon already up and just re-opens the dashboard; it never double-installs or double-binds 3850.

## Non-Goals

- The login / device flow (050c) and the guided-setup UI (050b) — this script only gets the daemon up and the browser open.
- Publishing the npm package (PRD-048) — this consumes it.
- Hivemind detection/uninstall (050d) — surfaced in the dashboard, not the shell script.
- Bundling a vendored Node runtime.

## User stories

- As a non-developer following a README, I paste one line and end up looking at a dashboard, having never opened a second terminal command.
- As a developer who already has Node and the daemon running, re-running the command just re-opens my dashboard in seconds.
- As a user on a locked-down machine where Node can't be auto-installed, I get the exact command to run myself and a clear "then re-run this" — not a 40-line traceback.

## Acceptance criteria

| ID | Criterion |
|---|---|
| a-AC-1 | On a clean machine with no Node/npm, the one command installs Node/npm, the embedding deps, and `@legioncodeinc/honeycomb` globally, then starts the daemon and opens the dashboard — exit 0, readable log. |
| a-AC-2 | The script is idempotent: a second run with everything present starts nothing new (daemon already up is a no-op, no double-bind of 3850) and just re-opens the dashboard. |
| a-AC-3 | When Node install requires elevation the script cannot obtain, it prints the exact copy-paste install command and exits non-zero with a one-line explanation — never a raw error dump (parent AC-7). |
| a-AC-4 | The dashboard is opened only **after** `/health` answers; if the daemon never binds within the wait budget, the script reports "daemon didn't start" + how to retry, and exits non-zero. |
| a-AC-5 | Both entrypoints exist and are functionally equivalent: a POSIX `install.sh` (`curl\|sh`) and a Windows `install.ps1` (`irm\|iex`); each writes the machine-local onboarding state marking "installed". |
| a-AC-6 | `honeycomb.local` is attempted but never required: if it does not resolve, the loopback URL is opened instead and the run still succeeds (a-AC-1 holds). |

## Implementation notes

- **Two scripts, one contract.** `install.sh` (POSIX `sh`, not bashisms) and `install.ps1`. Keep each free of cleverness — detect (`command -v node` / `Get-Command node`), branch, log, exit. Both end by invoking the installed `honeycomb` bin to ensure-the-daemon + open the dashboard, so the open logic lives **once** in the CLI, not duplicated in two shell dialects.
- **Daemon boot reuses existing seams.** Do not hand-roll process management in shell. Call the CLI verb that wraps [`ensureDaemonRunning`](../../../../src/commands/daemon.ts) (the 021a PID/lock guard already prevents double-bind) and the dashboard-open path.
- **Resolve the npm global-bin handoff — do NOT chain `honeycomb` by bare name.** `npm i -g` does **not** update the *current* shell's `PATH`, so a freshly-installed `honeycomb` invoked by name in the same script run can fail with "command not found." After the global install, resolve the absolute bin path (`npm prefix -g` → `<prefix>/bin/honeycomb` on POSIX, `%AppData%\npm\honeycomb.cmd` on Windows) or prepend the npm global bin dir to `PATH` in-process, and invoke the CLI through that absolute path for the ensure-daemon + open-dashboard handoff. a-AC-1 is not met if the first `honeycomb` call depends on a PATH the install didn't refresh.
- **Open-the-browser** reuses the validated OS opener pattern from [`defaultBrowserOpener`](../../../../src/daemon/runtime/auth/deeplake-issuer.ts) (fixed-argv `execFileSync`, never a shell; `open`/`rundll32`/`xdg-open`), pointed at the local dashboard URL.
- **Progress log discipline:** step lines to stdout, the single failure summary to stderr; the script's own errors are caught and reformatted, never allowed to surface as an uncaught trace (parent AC-7).
- **Onboarding state file** (`~/.deeplake/onboarding.json`, fail-soft) is stamped `installed` here so 050b can tell "fresh install" from "returning user."
- **`@huggingface/transformers`** is installed but its **model weights are not pulled synchronously** — that pull is the embeddings daemon's lazy warmup (050b open question), so the installer finishes fast.
- **Telemetry hook (050e):** the daemon's first boot after install emits the `honeycomb_installed` event via the 050e chokepoint (deduped through the onboarding flag, opt-out-respecting, fail-soft). The shell script itself emits nothing — analytics live in the daemon, not `curl`/`iwr`.
- **Build-define wiring for the PostHog key + ref default (050e).** Source the telemetry config the **same way the version is single-sourced** — a compile-time esbuild `define`, not a runtime `process.env` read. Mirror the existing `VERSION_DEFINE` ([`esbuild.config.mjs:40`](../../../../esbuild.config.mjs)):
  ```js
  // esbuild.config.mjs — beside VERSION_DEFINE.
  // NOTE: use `||`, not `??`. GitHub Actions `env: X: ${{ vars.X }}` with X unset
  // sets X to an EMPTY STRING (not undefined), so `??` would bake "" and the host
  // would lose its default / ref would lose "mario". `||` falls back on "" too.
  const TELEMETRY_DEFINE = {
    __HONEYCOMB_POSTHOG_KEY__:   JSON.stringify(process.env.HONEYCOMB_POSTHOG_KEY || ""),
    __HONEYCOMB_POSTHOG_HOST__:  JSON.stringify(process.env.HONEYCOMB_POSTHOG_HOST || "https://us.i.posthog.com"),
    __HONEYCOMB_REF_DEFAULT__:   JSON.stringify(process.env.HONEYCOMB_REF_DEFAULT || "mario"),
  };
  ```
  Spread `...TELEMETRY_DEFINE` into the **daemon** build's `define` (the daemon is the only emitter — [`esbuild.config.mjs:115`](../../../../esbuild.config.mjs)); the harness/CLI/MCP bundles don't need it. The key is read from a **CI build secret** (`HONEYCOMB_POSTHOG_KEY`), never committed — an unset key bakes in `""`, which the 050e chokepoint treats as "telemetry disabled" (fail-soft), so a local dev build silently no-ops instead of spamming the project. Rotation is one CI variable. The `__HONEYCOMB_*__` identifiers are declared in an ambient `.d.ts` (as `__HONEYCOMB_VERSION__` already is) so `tsc` sees them. **Why `define`, not `process.env`:** it is the version-parity pattern, it lets a published-package build embed the value without an env at the user's runtime, and it keeps `process.env` substrings out of any bundle that forbids them (the OpenClaw ClawHub `env-harvesting` rule, [`esbuild.config.mjs:196`](../../../../esbuild.config.mjs)) — even though telemetry ships only in the daemon bundle today.

## Open questions

- [ ] Node install path per OS (official installer vs `fnm`/`nvm` vs `winget`/Homebrew); elevation handling + no-elevation fallback copy.
- [ ] Host the scripts where (`get.honeycomb.*`?) and publish a checksum / "inspect before piping" URL for the `curl|sh` trust concern (parent open question).
- [ ] npm-only alternative (`npm create @legioncodeinc/honeycomb`) for users who refuse piped-shell installs.
- [ ] Exact daemon-up wait budget before declaring failure (reuse the ensure-running timeout).

## Related

- [`src/commands/daemon.ts`](../../../../src/commands/daemon.ts) — `ensureDaemonRunning` + the PID/lock lifecycle the script drives rather than re-implements.
- [`src/daemon/runtime/dashboard/host.ts`](../../../../src/daemon/runtime/dashboard/host.ts) — `GET /dashboard` the script opens once `/health` is green.
- [`src/daemon/runtime/auth/deeplake-issuer.ts`](../../../../src/daemon/runtime/auth/deeplake-issuer.ts) — the safe OS browser-opener pattern to reuse.
- [PRD-048: npm Publishing Pipeline](../../backlog/prd-048-npm-publishing-pipeline/prd-048-npm-publishing-pipeline-index.md) — must land before this works in the field.
- [Monorepo Build & Release](../../../knowledge/private/infrastructure/monorepo-build-release.md) — bin/bundle layout the global install lands.
</content>
