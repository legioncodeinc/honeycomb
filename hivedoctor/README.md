<!-- ───────────────────────────────  HERO  ─────────────────────────────── -->

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/legioncodeinc/honeycomb/main/assets/logos/honeycomb-mark.svg">
    <img src="https://raw.githubusercontent.com/legioncodeinc/honeycomb/main/assets/logos/honeycomb-mark.svg" alt="Honeycomb" height="72">
  </picture>
</p>

<h1 align="center">HiveDoctor</h1>

<p align="center">
  <strong>The self-healing watchdog for Honeycomb.</strong><br>
  Keeps your Honeycomb daemon alive, repairs it when it breaks, and reports home when it cannot.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@legioncodeinc/hivedoctor"><img src="https://img.shields.io/npm/v/@legioncodeinc/hivedoctor?style=flat-square&color=F7A823&label=version" alt="npm version"></a>
  <img src="https://img.shields.io/badge/node-%E2%89%A522-339933?style=flat-square&logo=node.js&logoColor=white" alt="Node ≥ 22">
  <img src="https://img.shields.io/badge/runtime%20deps-0-339933?style=flat-square" alt="Zero runtime dependencies">
  <a href="https://deeplake.ai"><img src="https://img.shields.io/badge/powered%20by-Deep%20Lake-ff5a1f?style=flat-square" alt="Powered by Deep Lake"></a>
  <a href="#license"><img src="https://img.shields.io/badge/license-AGPL--3.0-blue?style=flat-square" alt="AGPL-3.0"></a>
</p>

<!-- ──────────────────────────────  PARTNERS  ────────────────────────────── -->

<p align="center">
  <a href="https://github.com/legioncodeinc">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/legioncodeinc/honeycomb/main/assets/logos/legion-logo-dark.svg">
      <img src="https://raw.githubusercontent.com/legioncodeinc/honeycomb/main/assets/logos/legion-logo-light.svg" alt="Legion Code" height="34">
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://activeloop.ai"><img src="https://raw.githubusercontent.com/legioncodeinc/honeycomb/main/assets/logos/activeloop-full-mark-logo.svg" alt="Activeloop" height="26"></a>
</p>

<p align="center"><sub>A <a href="https://github.com/legioncodeinc"><strong>Legion Code</strong></a> &times; <a href="https://activeloop.ai"><strong>Activeloop</strong></a> collaboration · powered by <a href="https://deeplake.ai">Deep Lake</a></sub></p>

---

[Honeycomb](https://github.com/legioncodeinc/honeycomb) runs a local daemon that gives your AI coding agents shared, persistent memory. HiveDoctor is the little bee that keeps that daemon healthy. It watches the daemon, fixes it the way a careful operator would, and when it genuinely cannot, it leaves a clear report and (unless you opt out) tells the maintainers, so problems get solved before they cost you a morning.

It is deliberately small. Zero runtime dependencies, Node built-ins only, every action wrapped so a failure is logged rather than fatal. The thing that watches your daemon is built to be even harder to kill than the daemon itself.

> Installed automatically by the [Honeycomb one-command installer](https://github.com/legioncodeinc/honeycomb#-install-one-command). You usually never run it by hand. This page is for when you want to.

---

## Why it exists

A daemon can fail in quiet, annoying ways: it wedges but still holds its port, it gets launched from a directory it cannot write to, a stale global install serves old routes, credentials go bad. When that happens on your machine, you see a broken product and the maintainers see nothing. HiveDoctor closes that gap on both ends: it repairs the common failures on the spot, and it gives the team real visibility into the ones it cannot, so support stops being guesswork.

## What it does

- **🩺 Watches the daemon.** Probes `http://127.0.0.1:3850/health` on a fixed interval and reads the per-subsystem health detail, so it knows *what* is wrong, not just *that* something is.
- **🔧 Heals automatically.** Runs an escalating repair ladder with exponential backoff, the same moves a human operator would make, and goes quiet again the moment the daemon is healthy.
- **📣 Escalates loudly when it can't.** If the ladder is exhausted, it writes a structured "needs attention" report, serves a tiny local status page, and (unless opted out) sends the diagnosis home.
- **⬆️ Keeps Honeycomb current.** Checks for a blessed new release and updates the daemon safely (verify, then roll back on failure). On by default, easy to opt out.
- **🛡️ Survives anything.** Supervised by your OS (launchd / systemd / Windows Scheduled Task), so it restarts on crash and comes back after a reboot, independently of the daemon it watches.

## How it heals

When the daemon stops looking healthy, HiveDoctor climbs a ladder, backing off between rungs and stopping the instant health returns:

| Rung | Action | When |
|---|---|---|
| 1 | **Restart** the daemon | first response to an unhealthy daemon |
| 2 | **Reinstall** the daemon | after 3 failed restarts (fixes a corrupted or stale global) |
| 3 | **Remove a conflicting Hivemind** | whenever a clashing `@deeplake/hivemind` global is detected (the package only, never your shared `~/.deeplake/` data) |
| 4 | **Escalate** | when nothing above worked: persist a report, surface it locally, and notify home |

It will **never** delete your credentials. If it suspects a credential fault, it escalates instead of touching them.

## Install

HiveDoctor ships with Honeycomb. The [one-command installer](https://github.com/legioncodeinc/honeycomb#-install-one-command) sets it up and registers its OS service automatically. To skip it, pass `--no-hivedoctor` (or set `HONEYCOMB_NO_HIVEDOCTOR=1`) at install time.

To install or update it on its own:

```bash
npm install -g @legioncodeinc/hivedoctor
hivedoctor install-service   # register the OS service (restart-on-crash, start-on-boot)
```

## Commands

Run `hivedoctor` with no arguments for the banner and menu. The ones you will actually use:

| Command | What it does |
|---|---|
| `hivedoctor status` | daemon health, service state, versions, last heal, opt-out flags |
| `hivedoctor diagnose` | classify health and print the recommended fix, taking **no** action |
| `hivedoctor heal` | run the repair ladder once (disruptive rungs confirm first) |
| `hivedoctor restart` | restart the daemon (rung 1) |
| `hivedoctor update [--check]` | update the daemon via the safe blessed gate |
| `hivedoctor logs` | tail the local incident log |
| `hivedoctor install-service` / `uninstall-service` | register or remove the OS service |
| `hivedoctor self-update` | update HiveDoctor's own package (the **only** thing that does) |

HiveDoctor never updates itself in the background. It is built not to need it; `self-update` is the single, explicit way to bump it.

## Telemetry and privacy

By default HiveDoctor sends a small amount of operational telemetry to the maintainers so they can fix problems proactively: error events, a periodic installation-health snapshot, and the steps it attempted during a repair. It is sent as OpenTelemetry logs to [PostHog](https://posthog.com).

It is built to be honest about this:

- **What is sent:** health state, daemon and HiveDoctor versions, OS, and the *fact and outcome* of a repair (an allow-list, deny-by-default).
- **What is never sent:** your credentials, tokens, file contents, or personal data.
- **Opting out:** set `DO_NOT_TRACK=1` or `HONEYCOMB_TELEMETRY=0`, or toggle it in the Honeycomb dashboard. When opted out, nothing leaves your machine. Telemetry is always fire-and-forget and never blocks a repair.

## Design principles

1. **Incapable of crashing.** Node built-ins only, zero runtime dependencies. Every probe and repair runs inside a try/catch that logs and continues, with a global last-resort net on top.
2. **More reliable than what it watches.** Supervised by the OS, never by the daemon. The two never depend on each other to stay alive.
3. **Loopback and registry only.** It reaches the daemon over `127.0.0.1` and the outside world only over npm and the telemetry sink. No new inbound ports.
4. **Least blast radius.** Destructive actions are scoped and reversible-by-design; a bad release cannot auto-propagate without passing the blessed-version gate.
5. **Silent on the happy path, loud on the hard path.** A healthy probe is a debug line; an unhealable install is a high-signal escalation.

## Development

Self-contained: its own `tsconfig.json` and `vitest.config.ts`, independent of the repo-root gates.

```bash
cd hivedoctor
npm install        # dev deps only
npm run typecheck
npm run test
npm run build      # produces the single-file bin at bundle/cli.js
```

## License

[AGPL-3.0-or-later](LICENSE). A [Legion Code](https://github.com/legioncodeinc) &times; [Activeloop](https://activeloop.ai) collaboration, powered by [Deep Lake](https://deeplake.ai).
