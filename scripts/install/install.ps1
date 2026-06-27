# Honeycomb one-command bootstrap installer (Windows PowerShell) -- PRD-050a.
#
# Usage (the single line a brand-new Windows user pastes):
#   irm https://get.theapiary.sh/install.ps1 | iex
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

# HiveDoctor (PRD-063b): a SECOND global package -- the self-healing watchdog that keeps the
# primary daemon alive and registers itself with the OS (a per-user Scheduled Task on Windows,
# no admin / no UAC) so it survives crashes + reboots. Independent lifecycle (OD-6: a second
# global), installed after the primary unless the user opts out with -NoHiveDoctor.
$HiveDoctorNpmPackage = '@legioncodeinc/hivedoctor'

# Distribution base URL: the vanity domain that serves this installer surface (PRD-050a follow-up,
# now RESOLVED). get.theapiary.sh is a Cloudflare Pages site (site/install/) that content-negotiates:
# a shell client piping `/` gets the POSIX install.sh as text/plain; a browser gets an "inspect before
# piping" page with the PUBLISHED SHA-256 checksums. `$HoneycombInstallBaseUrl/install.ps1` always
# resolves to the raw, checksummed script. To verify before running: see https://get.theapiary.sh
$HoneycombInstallBaseUrl = 'https://get.theapiary.sh'

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
      # winget does NOT refresh THIS session's PATH, so a bare `fnm` lookup right after the install can
      # still miss even though the binary is on disk. Rebuild $env:Path from the machine + user
      # registry so the just-installed shim resolves in-process before we judge the install failed.
      try {
        $machinePath = [System.Environment]::GetEnvironmentVariable('Path', 'Machine')
        $userPath = [System.Environment]::GetEnvironmentVariable('Path', 'User')
        $env:Path = (@($machinePath, $userPath) | Where-Object { $_ }) -join ';'
      } catch {
        # Fail-soft: the `Test-Have 'fnm'` re-check below is the real gate; just surface why, don't abort.
        Write-Warning "Couldn't refresh PATH from the registry ($($_.Exception.Message)); continuing."
      }
    }
    if (-not (Test-Have 'fnm')) {
      # Could not install fnm without elevation -- surface the exact manual command + clean exit (a-AC-3).
      Show-NodeElevationHelp
      return $false
    }
  }

  # Load fnm into THIS session so node/npm resolve in-process (the install does not refresh the
  # current shell's PATH). `fnm env` emits the PowerShell shims; invoke them here.
  # Fail-soft on `fnm env`: the final `Test-Have 'node'/'npm'` gate below is the real decider; a failure
  # here must not abort the bootstrap, but the reason should be visible (not silently swallowed).
  try { fnm env --use-on-cd | Out-String | Invoke-Expression } catch {
    Write-Warning "fnm env (pre-install) didn't load into this session ($($_.Exception.Message)); continuing."
  }
  fnm install $HoneycombNodeVersion 2>$null | Out-Null
  fnm use $HoneycombNodeVersion 2>$null | Out-Null
  try { fnm env --use-on-cd | Out-String | Invoke-Expression } catch {
    Write-Warning "fnm env (post-install) didn't load into this session ($($_.Exception.Message)); continuing."
  }

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
# Step 3b -- HiveDoctor bootstrap (PRD-063b). After the primary is installed, install the
#            HiveDoctor watchdog (a second global) and register its per-user Scheduled Task,
#            UNLESS the user opted out. The opt-out is `-NoHiveDoctor` / a bare `--no-hivedoctor`
#            in $args, or the env equivalent $env:HONEYCOMB_NO_HIVEDOCTOR=1 (the ONLY install-time
#            switch, OD-5). Idempotent + FAIL-SOFT: a HiveDoctor hiccup never fails the Honeycomb
#            install -- the user still lands on a working dashboard.
# -----------------------------------------------------------------------------

# True when the user opted OUT of HiveDoctor. Mirrors hivedoctor/src/service/install-guard.ts
# (shouldBootstrapHiveDoctor) -- keep in sync. Reads the passed invocation args (the bare flag)
# + the env equivalent. Args are passed in explicitly because inside `irm | iex` there is no
# script-level $args to read.
function Test-HiveDoctorOptedOut([string[]]$InvocationArgs) {
  if ($InvocationArgs -and ($InvocationArgs -contains '--no-hivedoctor' -or $InvocationArgs -contains '-NoHiveDoctor')) {
    return $true
  }
  $envVal = $env:HONEYCOMB_NO_HIVEDOCTOR
  if ($envVal) {
    $v = $envVal.Trim().ToLowerInvariant()
    if ($v -eq '1' -or $v -eq 'true') { return $true }
  }
  return $false
}

# Resolve the absolute hivedoctor bin shim (npm i -g does not refresh THIS session's PATH).
function Resolve-HiveDoctorBin {
  $cmd = Get-Command 'hivedoctor' -ErrorAction SilentlyContinue
  if ($cmd) { return $cmd.Source }
  $prefix = (npm prefix -g 2>$null)
  if ($prefix) {
    $candidate = Join-Path $prefix 'hivedoctor.cmd'
    if (Test-Path $candidate) { return $candidate }
  }
  $appdataCmd = Join-Path $env:AppData 'npm\hivedoctor.cmd'
  if (Test-Path $appdataCmd) { return $appdataCmd }
  return $null
}

# Install the HiveDoctor global (idempotent) + register its per-user Scheduled Task. Every failure
# is a soft note, never a hard return -- the primary install already succeeded.
function Install-HiveDoctor {
  if (Test-Have 'hivedoctor') {
    Write-Ok "$HiveDoctorNpmPackage already installed."
  } else {
    Write-Step "installing the HiveDoctor watchdog ($HiveDoctorNpmPackage)..."
    npm install -g $HiveDoctorNpmPackage 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Host "note: could not install $HiveDoctorNpmPackage (continuing -- Honeycomb itself is installed)."
      return
    }
    Write-Ok "installed $HiveDoctorNpmPackage."
  }

  $hd = Resolve-HiveDoctorBin
  if ($hd) {
    Write-Step 'registering the HiveDoctor service (per-user Scheduled Task, no admin)...'
    & $hd install-service 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
      Write-Ok 'HiveDoctor is watching (it will restart the daemon on crash and survive reboots).'
    } else {
      Write-Host 'note: HiveDoctor installed but its service did not register (continuing).'
    }
  }
}

# -----------------------------------------------------------------------------
# Step 3 -- hand off to the CLI verb for the daemon-ensure + health-gate + dashboard
#           open. The verb is idempotent + health-gated (a-AC-2 / a-AC-4) and opens
#           honeycomb.local -> loopback (a-AC-6), writing onboarding "installed" (a-AC-5).
# -----------------------------------------------------------------------------
# Returns a status CODE (never calls `exit`): in the documented `irm ... | iex` bootstrap, `exit`
# terminates the CALLER's PowerShell host and can close the user's terminal. The single process-exit
# handling lives at the entrypoint below, which sets `$global:LASTEXITCODE` from this return value.
function Invoke-Main([string[]]$InvocationArgs) {
  if (-not (Ensure-Node))       { return 1 }
  if (-not (Install-Honeycomb)) { return 1 }

  $bin = Resolve-HoneycombBin
  if (-not $bin) {
    Write-Fail "could not locate the installed 'honeycomb' command after the global install."
    Write-Host ''
    Write-Host 'Open a NEW terminal (so PATH refreshes) and run:'
    Write-Host ''
    Write-Host '  honeycomb install'
    Write-Host ''
    return 1
  }

  # HiveDoctor bootstrap (PRD-063b), guarded by -NoHiveDoctor / HONEYCOMB_NO_HIVEDOCTOR. Runs BEFORE
  # the verb hand-off so the watchdog is in place by the time the user sees the dashboard.
  if (Test-HiveDoctorOptedOut $InvocationArgs) {
    Write-Step 'skipping HiveDoctor (--no-hivedoctor).'
  } else {
    Install-HiveDoctor
  }

  # The verb prints its own friendly step log and returns a clean exit code; forward it verbatim. A
  # handled failure inside the verb is already a plain-language line + non-zero exit -- no raw trace.
  & $bin install
  return $LASTEXITCODE
}

# Entrypoint: run main, then set the exit code ONCE without tearing down the host (so `irm | iex`
# hands control back to the user's session instead of closing it). $args is the script-level
# invocation args (empty under the bare `irm | iex` pipe); forwarded so the opt-out switch is seen.
$global:LASTEXITCODE = Invoke-Main $args
