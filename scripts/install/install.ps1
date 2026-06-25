# Honeycomb one-command bootstrap installer (Windows PowerShell) -- PRD-050a.
#
# Usage (the single line a brand-new Windows user pastes):
#   irm https://raw.githubusercontent.com/legioncodeinc/honeycomb/main/scripts/install/install.ps1 | iex
#
# This is the FUNCTIONAL EQUIVALENT of install.sh (PRD-050a a-AC-5): same contract -- leave the user
# on a running dashboard, or tell them in ONE plain sentence why not. It owns ONLY the host-bootstrap
# half (detect/install Node+npm via fnm + a pinned LTS, then `npm i -g @legioncodeinc/honeycomb`),
# then HANDS OFF to the `honeycomb install` CLI verb for the daemon-ensure + health-gate +
# dashboard-open -- so that logic lives ONCE in TypeScript (src/commands/install.ts).
#
# Thin + idempotent: detect what is present, install only what is missing, re-run safely.
#
# ASCII-only by design: this file is sourced via `irm | iex` and parsed by Windows PowerShell 5.1,
# which reads a non-BOM file as the system ANSI codepage -- so non-ASCII glyphs would corrupt the
# parse. The friendly progress GLYPHS the user sees come from the CLI verb's UTF-8 output; this
# script's own prefixes stay ASCII.

# Handle every failure explicitly + print a plain-language line (parent AC-7). We do NOT set
# $ErrorActionPreference='Stop' globally -- that would surface a raw PowerShell exception/trace.
$ErrorActionPreference = 'Continue'

# -----------------------------------------------------------------------------
# THE ONE PLACE TO BUMP NODE. The single pinned Node LTS the installer provisions
# via fnm. To upgrade the provisioned Node for every new user, change THIS line
# only. (Existing users with a working Node are left untouched -- see Ensure-Node.)
# -----------------------------------------------------------------------------
$HoneycombNodeVersion = '22'

# The published npm package the global install pulls (PRD-048 publishes it; this consumes it).
$HoneycombNpmPackage = '@legioncodeinc/honeycomb@latest'

# INTERIM distribution constant (PRD-050a operator decision): the raw repo URL the irm|iex line
# points at. BLOCKED follow-up (non-gating): a vanity `get.honeycomb.*` domain + a published
# checksum / "inspect before piping" page. Tracked in the report, not blocking this script.
$HoneycombInstallBaseUrl = 'https://raw.githubusercontent.com/legioncodeinc/honeycomb/main/scripts/install'

# Friendly progress log: step lines to the host, the single failure summary to the error stream.
function Write-Step([string]$m) { Write-Host "-> $m" }
function Write-Ok([string]$m)   { Write-Host "[ok] $m" }
function Write-Fail([string]$m) { [Console]::Error.WriteLine("Honeycomb install could not continue: $m") }

function Test-Have([string]$name) { return [bool](Get-Command $name -ErrorAction SilentlyContinue) }

# a-AC-3 -- print the EXACT copy-paste install command + a one-line WHY. NEVER a raw error dump.
function Show-NodeElevationHelp {
  Write-Fail "Honeycomb needs Node $HoneycombNodeVersion and could not install it automatically (your machine blocked the no-admin install)."
  Write-Host ''
  Write-Host "Install Node $HoneycombNodeVersion yourself with ONE of these, then re-run this installer:"
  Write-Host ''
  Write-Host '  # winget (recommended on Windows 10/11):'
  Write-Host '  winget install OpenJS.NodeJS.LTS'
  Write-Host ''
  Write-Host '  # or via the official MSI:'
  Write-Host '  https://nodejs.org/en/download'
  Write-Host ''
  Write-Host '  # Then re-run:'
  Write-Host "  irm $HoneycombInstallBaseUrl/install.ps1 | iex"
  Write-Host ''
}

# -----------------------------------------------------------------------------
# Step 1 -- Node + npm. If both present, use them. Else install fnm (NO elevation)
#           + the pinned Node LTS. fnm installs under the user profile, so it never
#           needs admin; that is why it is the primary path over the official MSI.
# -----------------------------------------------------------------------------
function Ensure-Node {
  if ((Test-Have 'node') -and (Test-Have 'npm')) {
    Write-Ok "Node $(node --version) and npm $(npm --version) found."
    return $true
  }

  Write-Step 'Node/npm not found -- installing a private copy via fnm (no admin rights needed)...'

  if (-not (Test-Have 'fnm')) {
    # Prefer winget (per-user, no elevation) to install fnm; fall back to the documented manual path.
    if (Test-Have 'winget') {
      winget install Schniz.fnm --accept-source-agreements --accept-package-agreements 2>$null | Out-Null
    }
    if (-not (Test-Have 'fnm')) {
      # Could not install fnm without elevation -- surface the exact manual command + clean exit (a-AC-3).
      Show-NodeElevationHelp
      return $false
    }
  }

  # Load fnm into THIS session so node/npm resolve in-process (the install does not refresh the
  # current shell's PATH). `fnm env` emits the PowerShell shims; invoke them here.
  try { fnm env --use-on-cd | Out-String | Invoke-Expression } catch { }
  fnm install $HoneycombNodeVersion 2>$null | Out-Null
  fnm use $HoneycombNodeVersion 2>$null | Out-Null
  try { fnm env --use-on-cd | Out-String | Invoke-Expression } catch { }

  if ((Test-Have 'node') -and (Test-Have 'npm')) {
    Write-Ok "Installed Node $(node --version) via fnm."
    return $true
  }

  Show-NodeElevationHelp
  return $false
}

# -----------------------------------------------------------------------------
# Step 2 -- install @legioncodeinc/honeycomb globally. The embedding runtime is an
#           OPTIONAL dep pulled by npm here; its MODEL WEIGHTS are NOT fetched now
#           (lazy warmup -- 050b), so this stays fast.
# -----------------------------------------------------------------------------
function Install-Honeycomb {
  Write-Step "installing $HoneycombNpmPackage globally..."
  npm install -g $HoneycombNpmPackage 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Fail "the global install of $HoneycombNpmPackage failed."
    Write-Host ''
    Write-Host 'Try it directly to see the npm error, then re-run this installer:'
    Write-Host ''
    Write-Host "  npm install -g $HoneycombNpmPackage"
    Write-Host ''
    return $false
  }
  Write-Ok "installed $HoneycombNpmPackage."
  return $true
}

# Resolve the ABSOLUTE path to the freshly-installed honeycomb bin. `npm i -g` does NOT refresh the
# CURRENT session's PATH, so calling `honeycomb` by bare name in the same run can fail (PRD-050a
# impl-note). Resolve `%AppData%\npm\honeycomb.cmd` (the npm global bin shim on Windows).
function Resolve-HoneycombBin {
  $cmd = Get-Command 'honeycomb' -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $prefix = (npm prefix -g 2>$null)
  if ($prefix) {
    $candidate = Join-Path $prefix 'honeycomb.cmd'
    if (Test-Path $candidate) { return $candidate }
  }
  $appdataCmd = Join-Path $env:AppData 'npm\honeycomb.cmd'
  if (Test-Path $appdataCmd) { return $appdataCmd }
  return $null
}

# -----------------------------------------------------------------------------
# Step 3 -- hand off to the CLI verb for the daemon-ensure + health-gate + dashboard
#           open. The verb is idempotent + health-gated (a-AC-2 / a-AC-4) and opens
#           honeycomb.local -> loopback (a-AC-6), writing onboarding "installed" (a-AC-5).
# -----------------------------------------------------------------------------
function Invoke-Main {
  if (-not (Ensure-Node))       { exit 1 }
  if (-not (Install-Honeycomb)) { exit 1 }

  $bin = Resolve-HoneycombBin
  if (-not $bin) {
    Write-Fail "could not locate the installed 'honeycomb' command after the global install."
    Write-Host ''
    Write-Host 'Open a NEW terminal (so PATH refreshes) and run:'
    Write-Host ''
    Write-Host '  honeycomb install'
    Write-Host ''
    exit 1
  }

  # The verb prints its own friendly step log and returns a clean exit code; forward it verbatim. A
  # handled failure inside the verb is already a plain-language line + non-zero exit -- no raw trace.
  & $bin install
  exit $LASTEXITCODE
}

Invoke-Main
