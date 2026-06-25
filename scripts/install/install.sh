#!/bin/sh
# Honeycomb one-command bootstrap installer (POSIX) — PRD-050a.
#
# Usage (the single line a brand-new user pastes):
#   curl -fsSL https://raw.githubusercontent.com/legioncodeinc/honeycomb/main/scripts/install/install.sh | sh
#
# Contract (PRD-050a a-AC-1..6): leave the user on a running dashboard, OR tell them in ONE plain
# sentence why not. It assumes the operator knows nothing — no Node, no npm, no idea what a daemon
# is. It is deliberately THIN and IDEMPOTENT: it detects what is already present, installs only what
# is missing, and re-running it is safe.
#
# This script owns ONLY the host-bootstrap half: detect/install Node+npm (via fnm + a pinned LTS),
# then `npm i -g @legioncodeinc/honeycomb`. The moment a `honeycomb` bin exists it HANDS OFF to the
# `honeycomb install` CLI verb for the daemon-ensure + health-gate + dashboard-open — so that logic
# lives ONCE in TypeScript (src/commands/install.ts), not duplicated across two shell dialects.
#
# POSIX sh ONLY (no bashisms): this runs under `sh`, which may be dash/ash, not bash.

# `set -e` would abort on the FIRST non-zero command, surfacing a raw error. We instead handle every
# failure explicitly and print a plain-language line (parent AC-7) — so `set -e` is intentionally OFF.
set -u

# ─────────────────────────────────────────────────────────────────────────────
# THE ONE PLACE TO BUMP NODE. The single pinned Node LTS the installer provisions
# via fnm. To upgrade the provisioned Node for every new user, change THIS line
# only. (Existing users with a working Node are left untouched — see step 1.)
# ─────────────────────────────────────────────────────────────────────────────
HONEYCOMB_NODE_VERSION="22"

# The published npm package the global install pulls (PRD-048 publishes it; this consumes it).
HONEYCOMB_NPM_PACKAGE="@legioncodeinc/honeycomb@latest"

# INTERIM distribution constant (PRD-050a operator decision): the raw repo URL the curl|sh line
# above points at. BLOCKED follow-up (non-gating): a vanity `get.honeycomb.*` domain + a published
# checksum / "inspect before piping" page for the curl|sh trust concern. Tracked in the report, not
# blocking this script.
HONEYCOMB_INSTALL_BASE_URL="https://raw.githubusercontent.com/legioncodeinc/honeycomb/main/scripts/install"

# ── Friendly progress log: step lines to stdout, the single failure summary to stderr. ──
step()  { printf '→ %s\n' "$1"; }
ok()    { printf '✓ %s\n' "$1"; }
fail()  { printf 'Honeycomb install could not continue: %s\n' "$1" >&2; }

# `command -v` is the POSIX way to test for a binary (NOT `which`, which is not guaranteed present).
have()  { command -v "$1" >/dev/null 2>&1; }

# ─────────────────────────────────────────────────────────────────────────────
# Step 1 — Node + npm. If both are present, use them. Else install fnm (NO elevation)
#          + the pinned Node LTS. fnm installs entirely under $HOME, so it never needs
#          sudo; that is exactly why it is the primary path over the official installer.
# ─────────────────────────────────────────────────────────────────────────────
ensure_node() {
  if have node && have npm; then
    ok "Node $(node --version) and npm $(npm --version) found."
    return 0
  fi

  step "Node/npm not found — installing a private copy via fnm (no admin rights needed)…"

  # fnm install is a curl|sh that writes ONLY under ~/.local/share/fnm + ~/.fnm — no elevation.
  if ! have fnm; then
    if ! have curl; then
      # We cannot fetch fnm without curl, and installing curl itself needs the OS package manager
      # (which needs elevation). Print the EXACT copy-paste and exit cleanly (a-AC-3).
      elevation_required_node
      return 1
    fi
    if ! curl -fsSL https://fnm.vercel.app/install | sh >/dev/null 2>&1; then
      # fnm's own installer failed (e.g. a locked-down $HOME it cannot write). Fall back to the
      # documented manual command + clean non-zero exit (a-AC-3) — never a raw error dump.
      elevation_required_node
      return 1
    fi
  fi

  # Load fnm into THIS shell so `fnm`/`node`/`npm` resolve in-process (the install does not refresh
  # the current shell's env). fnm lives at ~/.local/share/fnm or ~/.fnm depending on the platform.
  FNM_DIR="${HOME}/.local/share/fnm"
  [ -d "$FNM_DIR" ] || FNM_DIR="${HOME}/.fnm"
  if [ -d "$FNM_DIR" ]; then
    PATH="${FNM_DIR}:${PATH}"
    export PATH
  fi
  if have fnm; then
    # `fnm env` exports the shims; evaluate them so node/npm are on PATH for the rest of this run.
    eval "$(fnm env 2>/dev/null)" || true
    if ! fnm install "$HONEYCOMB_NODE_VERSION" >/dev/null 2>&1; then
      elevation_required_node
      return 1
    fi
    fnm use "$HONEYCOMB_NODE_VERSION" >/dev/null 2>&1 || true
    eval "$(fnm env --use-on-cd 2>/dev/null)" || true
  fi

  if have node && have npm; then
    ok "Installed Node $(node --version) via fnm."
    return 0
  fi

  # fnm landed but node/npm still are not resolvable — surface the manual path, clean exit (a-AC-3).
  elevation_required_node
  return 1
}

# a-AC-3 — print the EXACT copy-paste install command + a one-line WHY, then signal a clean
# non-zero exit. NEVER a raw error dump. The caller exits with this function's surfaced intent.
elevation_required_node() {
  fail "Honeycomb needs Node ${HONEYCOMB_NODE_VERSION} and could not install it automatically (your machine blocked the no-admin install)."
  printf '\nInstall Node %s yourself with ONE of these, then re-run this installer:\n\n' "$HONEYCOMB_NODE_VERSION"
  printf '  # macOS (Homebrew):\n'
  printf '  brew install node@%s\n\n' "$HONEYCOMB_NODE_VERSION"
  printf '  # Debian/Ubuntu:\n'
  printf '  curl -fsSL https://deb.nodesource.com/setup_%s.x | sudo -E bash - && sudo apt-get install -y nodejs\n\n' "$HONEYCOMB_NODE_VERSION"
  printf '  # Then re-run:\n'
  printf '  curl -fsSL %s/install.sh | sh\n\n' "$HONEYCOMB_INSTALL_BASE_URL"
}

# ─────────────────────────────────────────────────────────────────────────────
# Step 2 — install @legioncodeinc/honeycomb globally. The embedding runtime
#          (@huggingface/transformers) is an OPTIONAL dependency of the package and
#          is pulled by npm during this install; its MODEL WEIGHTS are NOT fetched
#          here (that is the embed daemon's lazy warmup — 050b), so this stays fast.
# ─────────────────────────────────────────────────────────────────────────────
install_honeycomb() {
  step "installing ${HONEYCOMB_NPM_PACKAGE} globally…"
  if ! npm install -g "$HONEYCOMB_NPM_PACKAGE" >/dev/null 2>&1; then
    fail "the global install of ${HONEYCOMB_NPM_PACKAGE} failed."
    printf '\nTry it directly to see the npm error, then re-run this installer:\n\n  npm install -g %s\n\n' "$HONEYCOMB_NPM_PACKAGE"
    return 1
  fi
  ok "installed ${HONEYCOMB_NPM_PACKAGE}."
  return 0
}

# Resolve the ABSOLUTE path to the freshly-installed `honeycomb` bin. `npm i -g` does NOT refresh the
# CURRENT shell's PATH, so calling `honeycomb` by bare name in the same run can fail "command not
# found" (PRD-050a impl-note). Resolve `<npm prefix -g>/bin/honeycomb` and invoke THAT.
resolve_honeycomb_bin() {
  if have honeycomb; then
    command -v honeycomb
    return 0
  fi
  prefix="$(npm prefix -g 2>/dev/null)"
  if [ -n "$prefix" ] && [ -x "${prefix}/bin/honeycomb" ]; then
    printf '%s\n' "${prefix}/bin/honeycomb"
    return 0
  fi
  return 1
}

# ─────────────────────────────────────────────────────────────────────────────
# Step 3 — hand off to the CLI verb for the daemon-ensure + health-gate + dashboard
#          open. The open logic lives ONCE in the CLI (src/commands/install.ts), not
#          here. The verb is idempotent + health-gated (a-AC-2 / a-AC-4) and opens
#          honeycomb.local → loopback (a-AC-6), writing onboarding "installed" (a-AC-5).
# ─────────────────────────────────────────────────────────────────────────────
main() {
  ensure_node      || exit 1
  install_honeycomb || exit 1

  bin="$(resolve_honeycomb_bin)"
  if [ -z "$bin" ]; then
    fail "could not locate the installed 'honeycomb' command after the global install."
    printf '\nOpen a NEW terminal (so PATH refreshes) and run:\n\n  honeycomb install\n\n'
    exit 1
  fi

  # The verb prints its own friendly step log (daemon up / onboarding marked / opening dashboard) and
  # returns a clean exit code; we forward it verbatim. A handled failure inside the verb is already a
  # plain-language line + non-zero exit — no raw stack reaches the user here.
  "$bin" install
  exit $?
}

main "$@"
