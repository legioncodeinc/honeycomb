# Honeycomb one-command bootstrap installer (Windows PowerShell) -- PRD-050a, extended by
# the-apiary PRD-002 (product loading + install-time telemetry, ADR-0002).
#
# Usage (the single line a brand-new Windows user pastes):
#   irm https://get.theapiary.sh/install.ps1 | iex
#
# With product selection (PRD-002a), pass args to the SCRIPT BLOCK explicitly (irm | iex has no
# script-level $args of its own, so a piped invocation cannot see flags -- run it as a saved file,
# or use the `& { ... } --products=...` invocation form documented on get.theapiary.sh):
#   powershell -c "& { $(irm https://get.theapiary.sh/install.ps1) } --products=honeycomb,hive"
#
# This is the FUNCTIONAL EQUIVALENT of install.sh (PRD-050a a-AC-5, PRD-002a a-AC-6): the SAME flag
# grammar, precedence, product-loading, registration, and telemetry behavior -- see install.sh's
# header comment for the full documented grammar (flags / env / config file / --code= / --profile=
# / precedence / telemetry payload shape). This file does not repeat that prose; it implements it.
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
# PRD-002b: this is the FALLBACK package name only -- Install-Honeycomb resolves the ACTUAL
# installed version from hive-release.json (Resolve-ProductTarget) when reachable, falling back
# to @latest only when the manifest itself cannot be resolved.
$HoneycombNpmPackage = '@legioncodeinc/honeycomb'

# HiveDoctor (PRD-064b): a SECOND global package -- the self-healing watchdog that keeps the
# primary daemon alive and registers itself with the OS (a per-user Scheduled Task on Windows,
# no admin / no UAC) so it survives crashes + reboots. Independent lifecycle (OD-6: a second
# global), installed after the primary unless the user opts out with -NoDoctor.
$HiveDoctorNpmPackage = '@legioncodeinc/doctor'

# Distribution base URL: the vanity domain that serves this installer surface (PRD-050a follow-up,
# now RESOLVED). get.theapiary.sh is a Cloudflare Pages site (site/install/) that content-negotiates:
# a shell client piping `/` gets the POSIX install.sh as text/plain; a browser gets an "inspect before
# piping" page with the PUBLISHED SHA-256 checksums. `$HoneycombInstallBaseUrl/install.ps1` always
# resolves to the raw, checksummed script. To verify before running: see https://get.theapiary.sh
$HoneycombInstallBaseUrl = 'https://get.theapiary.sh'

# PRD-001/PRD-002b: the fleet release manifest (the-apiary superproject's hive-release.json). This
# installer never hardcodes "latest" for a product it did not itself publish (b-AC-2): it resolves
# each selected product's exact pinned version from THIS manifest.
$HoneycombManifestUrl = 'https://raw.githubusercontent.com/legioncodeinc/the-apiary/main/hive-release.json'
if ($env:HONEYCOMB_MANIFEST_URL) { $HoneycombManifestUrl = $env:HONEYCOMB_MANIFEST_URL }

# PRD-002c: telemetry destination. The key is EMPTY in source control by design -- this exact
# `$HoneycombInstallPosthogKey = ''` line is the one site/install/build.mjs patches (via an
# anchored regex on this literal line, never a blind find/replace over the whole file) at deploy
# time, injecting the real PostHog project key (mirrors ADR-0002: "a public PostHog project key
# baked into the install site"). An empty value (any un-built/local/dev copy) makes Send-PhoneHome
# a silent no-op -- never a hard failure.
$HoneycombInstallPosthogKey = ''
$HoneycombInstallPosthogHost = 'https://us.i.posthog.com'
$HoneycombInstallPosthogPath = '/i/v0/e/'
$HoneycombInstallIdFile = Join-Path $HOME '.honeycomb\install-id'

# PRD-002a: admin config file. PRD-002b: this installer's own bookkeeping of the last-selected
# product set (used only to detect a --products= narrowing between runs).
$HoneycombInstallConfigFile = Join-Path $HOME '.honeycomb\install.conf'
$HoneycombInstallStateFile = Join-Path $HOME '.honeycomb\install-state.json'
$HoneycombHivedoctorRegistryFile = Join-Path $HOME '.honeycomb\hivedoctor.daemons.json'

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

function Show-Usage {
  Write-Host 'Usage: install.ps1 [--products=<slug,slug,...>] [--profile=<name>] [--license=<key>]'
  Write-Host '                   [--code=<code>] [--dry-run] [--no-doctor|-NoDoctor]'
  Write-Host ''
  Write-Host '  --products=honeycomb,hive,nectar          select exactly which products to install'
  Write-Host '  --profile=full                            a named products preset (default | full)'
  Write-Host '  --license=<key>                           thread a license key through (seam only)'
  Write-Host '  --code=HONEY-FULL                         resolve a product code to a preset'
  Write-Host '  --dry-run                                 resolve + print, mutate nothing'
  Write-Host '  --no-doctor / -NoDoctor                   skip the HiveDoctor watchdog'
  Write-Host '                                            (aliases: --no-hivedoctor / -NoHiveDoctor)'
  Write-Host ''
  Write-Host 'Env equivalents: HONEYCOMB_INSTALL_PRODUCTS / _PROFILE / _LICENSE / _CODE, HONEYCOMB_NO_DOCTOR.'
  Write-Host 'Config file: ~\.honeycomb\install.conf (KEY=value per line: PRODUCTS, PROFILE, LICENSE, CODE).'
  Write-Host 'Precedence: flag > env > config file > code/profile preset (fills gaps only) > default.'
}

# -----------------------------------------------------------------------------
# PRD-002c -- anonymous install id + phone-home
# -----------------------------------------------------------------------------

function New-AnonInstallId {
  return [guid]::NewGuid().ToString()
}

# Resolve (or, outside -DryRun, mint + persist) the stable anonymous install id (c-AC-4). Returns
# a hashtable @{ Id = <string>; Repeat = <bool> }. In -DryRun mode this NEVER writes: an ephemeral
# id is generated purely for the preview, so repeated dry runs leave zero residue on disk.
function Resolve-InstallId([bool]$DryRun) {
  if ((Test-Path $HoneycombInstallIdFile) -and ((Get-Item $HoneycombInstallIdFile).Length -gt 0)) {
    $existing = (Get-Content $HoneycombInstallIdFile -Raw -ErrorAction SilentlyContinue)
    if ($existing) {
      return @{ Id = $existing.Trim(); Repeat = $true }
    }
  }
  $id = New-AnonInstallId
  if (-not $DryRun) {
    try {
      New-Item -ItemType Directory -Force -Path (Split-Path $HoneycombInstallIdFile) | Out-Null
      Set-Content -Path $HoneycombInstallIdFile -Value $id -NoNewline -ErrorAction SilentlyContinue
    } catch {
      # Fail-soft: a persistence hiccup must never abort the install.
    }
  }
  return @{ Id = $id; Repeat = $false }
}

# Fire ONE PostHog capture event (c-AC-1/c-AC-2). FAIL-SOFT + BOUNDED: a slow or unreachable
# ingest endpoint never hangs or breaks the install (ADR-0002). Uses the SAME capture endpoint +
# body shape as the Node-side chokepoint (src/daemon/runtime/telemetry/emit.ts) for consistency,
# but is otherwise fully independent of it. Payload is minimal + allow-list-shaped: products,
# profile, coarse OS family, repeat-vs-first -- NEVER --license=/--code= values (no PII).
# The optional -Product arg is the per-product transition payload field (product_installed /
# product_updated / product_removed each name the ONE product they describe); when present it is
# appended to the properties as `product = <slug>` alongside the existing run-level fields.
function Send-PhoneHome {
  param(
    [string]$EventName,
    [string]$Products,
    [string]$Profile,
    [string]$InstallId,
    [bool]$Repeat,
    [bool]$DryRun,
    [string]$Product = ''
  )
  if ($DryRun) {
    if ($Product) {
      Write-Host "[dry-run] would phone home: $EventName (product=$Product, install_id=$InstallId, repeat=$Repeat, products=$Products, profile=$Profile)"
    } else {
      Write-Host "[dry-run] would phone home: $EventName (install_id=$InstallId, repeat=$Repeat, products=$Products, profile=$Profile)"
    }
    return
  }

  if ([string]::IsNullOrEmpty($HoneycombInstallPosthogKey)) { return }

  $osFamily = 'windows'
  $props = @{
    products = $Products
    profile = $Profile
    os = $osFamily
    repeat_install = "$Repeat".ToLowerInvariant()
  }
  if ($Product) { $props.product = $Product }
  $body = @{
    api_key = $HoneycombInstallPosthogKey
    event = $EventName
    distinct_id = $InstallId
    properties = $props
  } | ConvertTo-Json -Compress

  try {
    Invoke-RestMethod -Method Post -Uri "$HoneycombInstallPosthogHost$HoneycombInstallPosthogPath" `
      -ContentType 'application/json' -Body $body -TimeoutSec 3 -ErrorAction Stop | Out-Null
  } catch {
    # Fail-soft: a dropped telemetry POST is acceptable; a hung/broken install is not.
  }
}

# Comma-free running list of SELECTED products that did NOT actually land this run (unpublished
# skip, npm install failure, registration failure, or the hivedoctor opt-out). Consumed by
# Send-ProductTransitions so product_installed/product_updated never over-claims. Mirrors
# install.sh's PRODUCTS_NOT_INSTALLED (keep in parity).
$script:ProductsNotInstalled = @()

function Add-ProductNotInstalled([string]$Slug) {
  $script:ProductsNotInstalled += $Slug
}

# -----------------------------------------------------------------------------
# PRD-002a -- flag / env / config-file / code / profile resolution
# -----------------------------------------------------------------------------

# --code=<code> -> a products PRESET (a-AC-2). Returns $null when unrecognized (soft-fail: caller
# warns and ignores the code rather than failing the install over a typo).
function Resolve-CodeProducts([string]$Code) {
  switch ($Code) {
    'HONEY-FULL' { return 'honeycomb,doctor,hive,nectar' }
    default { return $null }
  }
}

function Resolve-CodeProfile([string]$Code) {
  switch ($Code) {
    'HONEY-FULL' { return 'full' }
    default { return $null }
  }
}

# --profile=<name> -> a products PRESET, used only to fill the products gap when --products=
# itself was not given by any higher-precedence source (flag/env/config).
function Resolve-ProfileProducts([string]$ProfileName) {
  switch ($ProfileName) {
    'default' { return 'honeycomb,doctor' }
    'full' { return 'honeycomb,doctor,hive,nectar' }
    default { return $null }
  }
}

# Normalize a comma list of product tokens to the canonical slugs. The July 2026 repository
# renames (hivedoctor -> doctor, the-hive -> hive, hivenectar -> nectar) renamed the slugs with
# the repos; the pre-rename tokens stay accepted as aliases so every documented invocation,
# config file, and previously-written install-state.json keeps working across the rename.
# Mirrors install.sh's normalize_products_list (keep in parity).
function ConvertTo-CanonicalProducts([string]$Products) {
  if ([string]::IsNullOrEmpty($Products)) { return $Products }
  $normalized = foreach ($tok in ($Products.Split(',') | Where-Object { $_ -ne '' })) {
    switch ($tok) {
      'hivedoctor' { 'doctor' }
      'thehive' { 'hive' }
      'the-hive' { 'hive' }
      'hivenectar' { 'nectar' }
      default { $tok }
    }
  }
  return ($normalized -join ',')
}

# Read one KEY=value from the admin config file (a-AC-3). Plain-text parse ONLY -- this file is
# NEVER dot-sourced/executed, so it cannot inject PowerShell code. `#` comments and blank lines are
# ignored; the LAST matching KEY= line wins (ini-style override).
function Get-ConfigValue([string]$Key) {
  if (-not (Test-Path $HoneycombInstallConfigFile)) { return $null }
  $value = $null
  foreach ($line in Get-Content $HoneycombInstallConfigFile -ErrorAction SilentlyContinue) {
    $trimmed = $line.Trim()
    if ($trimmed -eq '' -or $trimmed.StartsWith('#')) { continue }
    $eq = $trimmed.IndexOf('=')
    if ($eq -lt 1) { continue }
    $k = $trimmed.Substring(0, $eq)
    if ($k -eq $Key) { $value = $trimmed.Substring($eq + 1) }
  }
  return $value
}

# Extract a raw `--flag=value` style token from the invocation args this script's own installer
# flags use (kept identical to install.sh's grammar, per a-AC-6, rather than adopting a
# PowerShell-native -Flag style that would diverge between the two dialects).
function Get-FlagValue([string[]]$InvocationArgs, [string]$Prefix) {
  if (-not $InvocationArgs) { return $null }
  foreach ($a in $InvocationArgs) {
    if ($a -and $a.StartsWith($Prefix)) { return $a.Substring($Prefix.Length) }
  }
  return $null
}

function Test-HasFlag([string[]]$InvocationArgs, [string]$Flag) {
  if (-not $InvocationArgs) { return $false }
  return ($InvocationArgs -contains $Flag)
}

# Resolve the effective selection per the documented precedence (a-AC-3, same as install.sh): flag
# > env > config file, then a --code=/--profile= preset fills the products gap only if still
# empty, then the built-in default, then honeycomb is force-included. Returns a hashtable.
function Resolve-Selection([string[]]$InvocationArgs) {
  $argProducts = Get-FlagValue $InvocationArgs '--products='
  $argProfile = Get-FlagValue $InvocationArgs '--profile='
  $argLicense = Get-FlagValue $InvocationArgs '--license='
  $argCode = Get-FlagValue $InvocationArgs '--code='

  $cfgProducts = Get-ConfigValue 'PRODUCTS'
  $cfgProfile = Get-ConfigValue 'PROFILE'
  $cfgLicense = Get-ConfigValue 'LICENSE'
  $cfgCode = Get-ConfigValue 'CODE'

  $selProducts = $argProducts
  if ([string]::IsNullOrEmpty($selProducts)) { $selProducts = $env:HONEYCOMB_INSTALL_PRODUCTS }
  if ([string]::IsNullOrEmpty($selProducts)) { $selProducts = $cfgProducts }

  $selProfile = $argProfile
  if ([string]::IsNullOrEmpty($selProfile)) { $selProfile = $env:HONEYCOMB_INSTALL_PROFILE }
  if ([string]::IsNullOrEmpty($selProfile)) { $selProfile = $cfgProfile }

  $selLicense = $argLicense
  if ([string]::IsNullOrEmpty($selLicense)) { $selLicense = $env:HONEYCOMB_INSTALL_LICENSE }
  if ([string]::IsNullOrEmpty($selLicense)) { $selLicense = $cfgLicense }

  $selCode = $argCode
  if ([string]::IsNullOrEmpty($selCode)) { $selCode = $env:HONEYCOMB_INSTALL_CODE }
  if ([string]::IsNullOrEmpty($selCode)) { $selCode = $cfgCode }

  if (-not [string]::IsNullOrEmpty($selCode)) {
    $codeProducts = Resolve-CodeProducts $selCode
    if ($codeProducts) {
      if ([string]::IsNullOrEmpty($selProducts)) { $selProducts = $codeProducts }
      if ([string]::IsNullOrEmpty($selProfile)) { $selProfile = Resolve-CodeProfile $selCode }
    } else {
      Write-Host "note: unrecognized --code=$selCode (ignoring; falling back to products/profile/defaults)."
    }
  }

  if ([string]::IsNullOrEmpty($selProducts) -and -not [string]::IsNullOrEmpty($selProfile)) {
    $profileProducts = Resolve-ProfileProducts $selProfile
    if ($profileProducts) {
      $selProducts = $profileProducts
    } else {
      Write-Host "note: unrecognized --profile=$selProfile (ignoring; falling back to the default product set)."
    }
  }

  if ([string]::IsNullOrEmpty($selProducts)) { $selProducts = 'honeycomb,doctor' }

  # Pre-rename tokens (hivedoctor/thehive/the-hive/hivenectar) normalize to the canonical slugs.
  $selProducts = ConvertTo-CanonicalProducts $selProducts

  # honeycomb is ALWAYS part of the effective set (see install.sh's header comment for why).
  $productList = $selProducts.Split(',') | Where-Object { $_ -ne '' }
  if ($productList -notcontains 'honeycomb') {
    $selProducts = "honeycomb,$selProducts"
  }

  return @{
    Products = $selProducts
    Profile = $selProfile
    License = $selLicense
    Code = $selCode
  }
}

# -----------------------------------------------------------------------------
# PRD-002b -- resolve a product's pinned version from hive-release.json
# -----------------------------------------------------------------------------

$script:ManifestObject = $null
$script:ManifestFetchAttempted = $false

function Get-Manifest {
  if ($script:ManifestFetchAttempted) { return $script:ManifestObject }
  $script:ManifestFetchAttempted = $true
  try {
    $script:ManifestObject = Invoke-RestMethod -Uri $HoneycombManifestUrl -TimeoutSec 5 -ErrorAction Stop
  } catch {
    $script:ManifestObject = $null
  }
  return $script:ManifestObject
}

# Resolve the npm install target for a product slug (b-AC-2). Returns a hashtable:
#   @{ Kind = 'ok'; Target = '<pkg>@<version>' }
#   @{ Kind = 'unpublished'; Pkg = '<pkg>' }   -- manifest says published:false, do NOT npm-install
#   @{ Kind = 'unresolved'; Pkg = '<pkg>' }    -- manifest unreachable/malformed, fall back to @latest
# SECURITY (security-review finding, medium): the manifest is an external input (a compromised
# repo, a MITM on a fetch, or a user-supplied HONEYCOMB_MANIFEST_URL override could all poison
# it). npm on Windows is a `.cmd` shim; invoking it with an unvalidated argument value can let a
# metacharacter WITHIN that value (`;`, `&`, `|`, backticks, `$()`, ...) be re-parsed by cmd.exe
# and inject an additional command, even though PowerShell itself passes $target as one token.
# These two validators enforce the SAME safe-shape allowlist as install.sh's
# npm_package_name_is_safe / semver_is_safe (kept in sync; see that file for the shared rationale)
# so a tampered field is rejected at the SOURCE rather than relying on downstream quoting alone.
function Test-SafePackageName([string]$Name) {
  if ([string]::IsNullOrEmpty($Name)) { return $false }
  return $Name -cmatch '^(@[a-z0-9][a-z0-9._-]*/)?[a-z0-9][a-z0-9._-]*$'
}

function Test-SafeSemver([string]$Version) {
  if ([string]::IsNullOrEmpty($Version)) { return $false }
  return $Version -cmatch '^[0-9]+\.[0-9]+\.[0-9]+([+.-][0-9A-Za-z.+-]+)?$'
}

function Resolve-ProductTarget([string]$Slug, [string]$FallbackPkg) {
  $manifest = Get-Manifest
  $pkg = $FallbackPkg
  if ($manifest -and $manifest.products -and $manifest.products.$Slug -and $manifest.products.$Slug.packageName) {
    $candidatePkg = $manifest.products.$Slug.packageName
    if (Test-SafePackageName $candidatePkg) { $pkg = $candidatePkg }
    # An unsafe-shaped packageName silently falls back to $FallbackPkg rather than being honored,
    # mirroring the resolution posture used for every other invalid/absent manifest field below.
  }
  if (-not $manifest -or -not $manifest.products -or -not $manifest.products.$Slug -or -not $manifest.products.$Slug.version) {
    return @{ Kind = 'unresolved'; Pkg = $pkg }
  }
  $entry = $manifest.products.$Slug
  if (-not (Test-SafeSemver $entry.version)) {
    # An unsafe-shaped (or non-semver) version is treated exactly like an unresolvable manifest
    # entry: never interpolated into an npm invocation, always the safe `@latest` fallback path.
    return @{ Kind = 'unresolved'; Pkg = $pkg }
  }
  $published = $true
  if ($null -ne $entry.published) { $published = [bool]$entry.published }
  if (-not $published) {
    return @{ Kind = 'unpublished'; Pkg = $pkg }
  }
  return @{ Kind = 'ok'; Target = "$pkg@$($entry.version)" }
}

# Thin wrapper over Resolve-ProductTarget for the two ALWAYS-core products (honeycomb,
# doctor) -- collapses the 3-way ok/unpublished/unresolved result to a single npm install
# target string: the manifest-pinned version when resolvable, else <pkg>@latest.
function Resolve-CoreProductTarget([string]$Slug, [string]$FallbackPkg) {
  $resolved = Resolve-ProductTarget $Slug $FallbackPkg
  if ($resolved.Kind -eq 'ok') { return $resolved.Target }
  return "$($resolved.Pkg)@latest"
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
  # Idempotent (mirrors install.sh's install_honeycomb): a re-run on a machine that already has
  # `honeycomb` is a NO-OP -- no npm mutation, no network -- so a rerun stays safe and succeeds
  # OFFLINE. Only an absent install triggers the global npm install.
  $existing = Resolve-HoneycombBin
  if ($existing) {
    Write-Ok "$HoneycombNpmPackage already installed ($existing)."
    return $true
  }
  $target = Resolve-CoreProductTarget 'honeycomb' $HoneycombNpmPackage
  Write-Step "installing $target globally..."
  npm install -g $target 2>$null | Out-Null
  if ($LASTEXITCODE -ne 0) {
    Write-Fail "the global install of $target failed."
    Write-Host ''
    Write-Host 'Try it directly to see the npm error, then re-run this installer:'
    Write-Host ''
    Write-Host "  npm install -g $target"
    Write-Host ''
    return $false
  }
  Write-Ok "installed $target."
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
# Step 3b -- HiveDoctor bootstrap (PRD-064b). After the primary is installed, install the
#            HiveDoctor watchdog (a second global) and register its per-user Scheduled Task,
#            UNLESS the user opted out. The opt-out is `-NoDoctor` / a bare `--no-doctor` in
#            $args (pre-rename aliases still accepted), or the env equivalent
#            $env:HONEYCOMB_NO_DOCTOR=1 (the ONLY install-time switch, OD-5). Idempotent +
#            FAIL-SOFT: a HiveDoctor hiccup never fails the Honeycomb install -- the user still
#            lands on a working dashboard.
# -----------------------------------------------------------------------------

# True when the user opted OUT of HiveDoctor (canonical --no-doctor / -NoDoctor /
# HONEYCOMB_NO_DOCTOR, or the pre-rename alias spellings). Mirrors
# doctor/src/service/install-guard.ts (shouldBootstrapHiveDoctor) -- keep in sync. Reads the
# passed invocation args (the bare flag) + the env equivalent. Args are passed in explicitly
# because inside `irm | iex` there is no script-level $args to read.
function Test-HiveDoctorOptedOut([string[]]$InvocationArgs) {
  $optOutFlags = @('--no-doctor', '-NoDoctor', '--no-hivedoctor', '-NoHiveDoctor')
  if ($InvocationArgs) {
    foreach ($flag in $optOutFlags) {
      if ($InvocationArgs -contains $flag) { return $true }
    }
  }
  foreach ($envVal in @($env:HONEYCOMB_NO_DOCTOR, $env:HONEYCOMB_NO_HIVEDOCTOR)) {
    if ($envVal) {
      $v = $envVal.Trim().ToLowerInvariant()
      if ($v -eq '1' -or $v -eq 'true') { return $true }
    }
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
    $hdTarget = Resolve-CoreProductTarget 'doctor' $HiveDoctorNpmPackage
    Write-Step "installing the HiveDoctor watchdog ($hdTarget)..."
    npm install -g $hdTarget 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Host "note: could not install $hdTarget (continuing -- Honeycomb itself is installed)."
      Add-ProductNotInstalled 'doctor'
      return
    }
    Write-Ok "installed $hdTarget."
  }

  $hd = Resolve-HiveDoctorBin
  if ($hd) {
    Write-Step 'registering the HiveDoctor service (per-user Scheduled Task, no admin)...'
    & $hd install-service 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
      Write-Ok 'HiveDoctor is watching (it will restart the daemon on crash and survive reboots).'
    } else {
      # IRD-192 AC-7: a non-zero exit now means the service manager rejected the unit (e.g. the old
      # invalid PT5S restart interval). Do NOT claim the watchdog is watching; name the actionable
      # command so the user can see why. Non-fatal: Honeycomb itself is already installed.
      Write-Host 'note: HiveDoctor installed but its service did not register (continuing). Run ''hivedoctor install-service'' to see why.'
    }
  }
}

# -----------------------------------------------------------------------------
# PRD-002b -- install + register hive / nectar when selected (the coverage-gap close).
# Generic across both products, mirroring install.sh's Install-ExtraProduct 1:1. Both hive
# (`thehive install-service`) and nectar (`hivenectar install`) ALREADY implement a
# hivedoctor-registry writer internally -- this installer reuses THEIR verb (exactly one writer
# per product, b-AC-3) rather than hand-rolling a second one here.
# -----------------------------------------------------------------------------
function Install-ExtraProduct {
  param(
    [string]$DisplayName,
    [string]$Slug,
    [string]$FallbackPkg,
    [string]$BinName,
    [string]$PostInstallVerb,
    [bool]$DryRun
  )

  $resolved = Resolve-ProductTarget $Slug $FallbackPkg

  if ($resolved.Kind -eq 'unpublished') {
    Write-Host "note: $DisplayName ($($resolved.Pkg)) is not yet published to npm -- skipping (a maintainer still needs to complete the one-time npm Trusted-Publisher bootstrap, PRD-001c). Re-run this installer after that lands."
    Add-ProductNotInstalled $Slug
    return $true
  }

  $target = $null
  if ($resolved.Kind -eq 'unresolved') {
    Write-Host "note: could not resolve the pinned version for $DisplayName from the release manifest -- falling back to $($resolved.Pkg)@latest."
    $target = "$($resolved.Pkg)@latest"
  } else {
    $target = $resolved.Target
  }

  if ($DryRun) {
    Write-Host "[dry-run] would run: npm install -g $target"
    Write-Host "[dry-run] would run: $BinName $PostInstallVerb"
    return $true
  }

  $ok = $true
  if (Test-Have $BinName) {
    Write-Ok "$DisplayName already installed ($((Get-Command $BinName).Source))."
  } else {
    Write-Step "installing $DisplayName ($target) globally..."
    npm install -g $target 2>$null | Out-Null
    if ($LASTEXITCODE -ne 0) {
      Write-Host "note: could not install $DisplayName (continuing -- the rest of the install still succeeded). Try: npm install -g $target"
      Add-ProductNotInstalled $Slug
      return $false
    }
    Write-Ok "installed $DisplayName."
  }

  $prodBin = $null
  $cmd = Get-Command $BinName -ErrorAction SilentlyContinue
  if ($cmd) {
    $prodBin = $cmd.Source
  } else {
    $prefix = (npm prefix -g 2>$null)
    if ($prefix) {
      $candidate = Join-Path $prefix "$BinName.cmd"
      if (Test-Path $candidate) { $prodBin = $candidate }
    }
  }

  if ($prodBin) {
    Write-Step "registering $DisplayName with hivedoctor..."
    & $prodBin $PostInstallVerb 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) {
      Write-Ok "$DisplayName registered."
    } else {
      Write-Host "note: $DisplayName installed but its $PostInstallVerb step did not complete (continuing). Run '$BinName $PostInstallVerb' to see why."
      # A registration failure keeps the product OUT of the transition events, matching the
      # Set-InstallState gate (a failed selection is not recorded as installed).
      Add-ProductNotInstalled $Slug
      $ok = $false
    }
  }
  return $ok
}

# -----------------------------------------------------------------------------
# PRD-002b -- registration create/update/DELETE across lifecycle transitions. CREATE/UPDATE are
# handled above; DELETE is a --products= narrowing vs. the last run. See install.sh's
# Reconcile-RemovedProducts comment for the honest scope note (no npm uninstall, no full
# product-uninstall verb exists anywhere in this fleet yet).
# -----------------------------------------------------------------------------

# Normalized through the same alias map as the live selection, so a state file written before the
# July 2026 slug rename diffs cleanly against a post-rename selection (no spurious remove+install).
function Get-PreviousProducts {
  if (-not (Test-Path $HoneycombInstallStateFile)) { return $null }
  try {
    $state = Get-Content $HoneycombInstallStateFile -Raw | ConvertFrom-Json
    if ($state.products) { return (ConvertTo-CanonicalProducts ([string]$state.products)) }
  } catch {
    # Unreadable/malformed -> treated as "no prior state".
  }
  return $null
}

function Set-InstallState([string]$Products) {
  try {
    New-Item -ItemType Directory -Force -Path (Split-Path $HoneycombInstallStateFile) | Out-Null
    $state = @{ products = $Products; updatedAt = (Get-Date).ToString('o') } | ConvertTo-Json
    Set-Content -Path $HoneycombInstallStateFile -Value $state -ErrorAction SilentlyContinue
  } catch {
    # Fail-soft: bookkeeping only.
  }
}

# Deregister one product's entry from hivedoctor's static registry by name (the "delete"
# transition). Fail-soft: any read/parse/write hiccup is swallowed.
function Remove-HivedoctorRegistryEntry([string]$Name) {
  if (-not (Test-Path $HoneycombHivedoctorRegistryFile)) { return }
  try {
    $doc = Get-Content $HoneycombHivedoctorRegistryFile -Raw | ConvertFrom-Json
    if (-not $doc.daemons) { return }
    $kept = @($doc.daemons | Where-Object { $_.name -ne $Name })
    if ($kept.Count -eq $doc.daemons.Count) { return }
    $doc.daemons = $kept
    $tmp = "$HoneycombHivedoctorRegistryFile.tmp-$PID-$(Get-Date -UFormat %s)"
    ($doc | ConvertTo-Json -Depth 10) | Set-Content -Path $tmp
    Move-Item -Force -Path $tmp -Destination $HoneycombHivedoctorRegistryFile
  } catch {
    # Fail-soft: a registry cleanup step must never fail the run that triggered it.
  }
}

function Resolve-RemovedProducts([string]$CurrentProducts, [string]$SelProfile, [string]$InstallId, [bool]$Repeat, [bool]$DryRun) {
  $previous = Get-PreviousProducts
  if (-not $previous) { return }
  $previousList = $previous.Split(',') | Where-Object { $_ -ne '' }
  $currentList = $CurrentProducts.Split(',') | Where-Object { $_ -ne '' }
  foreach ($p in $previousList) {
    if ($currentList -contains $p) { continue }
    # Per-product transition telemetry: this product WAS in the last run's selection and is gone
    # now (the DELETE transition). Fire-and-forget like every Send-PhoneHome call; fires for
    # EVERY dropped product, whether or not it has a deregistration branch below.
    Send-PhoneHome 'product_removed' $CurrentProducts $SelProfile $InstallId $Repeat $DryRun $p
    if ($p -eq 'hive' -or $p -eq 'nectar') {
      # The registry entry name is the product's own daemon name (hive registers as "thehive",
      # nectar as "hivenectar"; those runtime names deliberately did not change with the slug
      # rename), so map slug -> registry name here. Mirrors install.sh (keep in parity).
      $registryName = if ($p -eq 'hive') { 'thehive' } else { 'hivenectar' }
      if ($DryRun) {
        Write-Host "[dry-run] would deregister $p from hivedoctor (no longer in --products=)."
      } else {
        Write-Step "deregistering $p from hivedoctor (no longer in --products=)..."
        Remove-HivedoctorRegistryEntry $registryName
      }
    }
  }
}

# Per-product transition telemetry: product_installed / product_updated (product_removed fires
# from Resolve-RemovedProducts above). Diffs the PREVIOUS run's selection (install-state) vs this
# run's resolved selection, skipping any product that did not actually land
# ($script:ProductsNotInstalled). Same posture as every Send-PhoneHome call: fire-and-forget,
# silent no-op without a key, dry-run previews only, never affects the exit code. `repeat_install`
# covers the RUN; these events cover the PER-PRODUCT fact. Mirrors install.sh's
# phone_home_product_transitions (keep in parity).
function Send-ProductTransitions([string]$CurrentProducts, [string]$SelProfile, [string]$InstallId, [bool]$Repeat, [bool]$DryRun) {
  $previous = Get-PreviousProducts
  $previousList = @()
  if ($previous) { $previousList = $previous.Split(',') | Where-Object { $_ -ne '' } }
  $currentList = $CurrentProducts.Split(',') | Where-Object { $_ -ne '' }
  foreach ($p in $currentList) {
    if ($script:ProductsNotInstalled -contains $p) { continue } # selected but did not land: no claim
    if ($previousList -contains $p) {
      Send-PhoneHome 'product_updated' $CurrentProducts $SelProfile $InstallId $Repeat $DryRun $p
    } else {
      Send-PhoneHome 'product_installed' $CurrentProducts $SelProfile $InstallId $Repeat $DryRun $p
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
  if ($InvocationArgs -and ($InvocationArgs -contains '--help' -or $InvocationArgs -contains '-h')) {
    Show-Usage
    return 0
  }

  $dryRun = Test-HasFlag $InvocationArgs '--dry-run'

  # c-AC-1: fires BEFORE any product resolution, using only Invoke-RestMethod (no Node/npm
  # dependency -- native to PowerShell).
  $installIdInfo = Resolve-InstallId $dryRun
  Send-PhoneHome 'install_started' '' '' $installIdInfo.Id $installIdInfo.Repeat $dryRun

  $selection = Resolve-Selection $InvocationArgs

  if ($dryRun) {
    Write-Host 'resolved selection (--dry-run, nothing will be installed/registered/sent):'
    Write-Host "  products = $($selection.Products)"
    $profileDisplay = $selection.Profile; if (-not $profileDisplay) { $profileDisplay = '<none>' }
    Write-Host "  profile  = $profileDisplay"
    if ($selection.License) { Write-Host "  license  = <redacted, $($selection.License.Length) chars>" } else { Write-Host '  license  = <none>' }
    $codeDisplay = $selection.Code; if (-not $codeDisplay) { $codeDisplay = '<none>' }
    Write-Host "  code     = $codeDisplay"
    Write-Host "  install id = $($installIdInfo.Id) (repeat=$($installIdInfo.Repeat))"
  }

  $finish = {
    param([int]$Code)
    if ($Code -eq 0) {
      Send-PhoneHome 'install_completed' $selection.Products $selection.Profile $installIdInfo.Id $installIdInfo.Repeat $dryRun
    } else {
      Send-PhoneHome 'install_failed' $selection.Products $selection.Profile $installIdInfo.Id $installIdInfo.Repeat $dryRun
    }
    return $Code
  }

  if ($dryRun) {
    if ((Test-Have 'node') -and (Test-Have 'npm')) {
      Write-Ok "Node $(node --version) and npm $(npm --version) found (dry-run: no bootstrap attempted)."
    } else {
      Write-Host 'note: node/npm not found (dry-run -- a real run would attempt to install them via fnm).'
    }
  } else {
    if (-not (Ensure-Node)) { return (& $finish 1) }
  }

  $productList = $selection.Products.Split(',') | Where-Object { $_ -ne '' }

  if ($productList -contains 'honeycomb') {
    if ($dryRun) {
      Write-Host "[dry-run] would run: npm install -g $(Resolve-CoreProductTarget 'honeycomb' $HoneycombNpmPackage)"
    } else {
      if (-not (Install-Honeycomb)) { return (& $finish 1) }
    }
  }

  $bin = $null
  if (-not $dryRun) {
    $bin = Resolve-HoneycombBin
    if (-not $bin) {
      Write-Fail "could not locate the installed 'honeycomb' command after the global install."
      Write-Host ''
      Write-Host 'Open a NEW terminal (so PATH refreshes) and run:'
      Write-Host ''
      Write-Host '  honeycomb install'
      Write-Host ''
      return (& $finish 1)
    }
  }

  # HiveDoctor bootstrap (PRD-064b), now ALSO gated on doctor being in the resolved selection.
  if ($productList -contains 'doctor') {
    if (Test-HiveDoctorOptedOut $InvocationArgs) {
      Write-Step 'skipping HiveDoctor (--no-doctor).'
      # Opted out: doctor stays selected but does not land, so it earns no transition event.
      Add-ProductNotInstalled 'doctor'
    } elseif ($dryRun) {
      Write-Host "[dry-run] would install + register HiveDoctor ($(Resolve-CoreProductTarget 'doctor' $HiveDoctorNpmPackage))."
    } else {
      Install-HiveDoctor
    }
  } else {
    Write-Step 'skipping HiveDoctor (not in --products=).'
  }

  # PRD-002b: actually install hive / nectar when selected (the coverage-gap close). The bin
  # names (`thehive` / `hivenectar`) are the products' own CLI bins and deliberately did not
  # change with the slug rename. Mirrors install.sh's EXTRA_PRODUCT_FAILED: a failed SELECTED
  # product must not be recorded as installed (Set-InstallState below) nor reported as
  # install_completed (the final exit path).
  $extraProductFailed = $false
  if ($productList -contains 'hive') {
    if (-not (Install-ExtraProduct 'The Hive' 'hive' '@legioncodeinc/hive' 'thehive' 'install-service' $dryRun)) {
      $extraProductFailed = $true
    }
  }
  if ($productList -contains 'nectar') {
    if (-not (Install-ExtraProduct 'Nectar' 'nectar' '@legioncodeinc/nectar' 'hivenectar' 'install' $dryRun)) {
      $extraProductFailed = $true
    }
  }

  # PRD-002b DELETE transition: a --products= narrowing vs. the last run (fires product_removed).
  Resolve-RemovedProducts $selection.Products $selection.Profile $installIdInfo.Id $installIdInfo.Repeat $dryRun
  # Per-product CREATE/UPDATE transitions: product_installed / product_updated. Must run BEFORE
  # Set-InstallState below (the diff baseline is the PREVIOUS run's recorded selection).
  Send-ProductTransitions $selection.Products $selection.Profile $installIdInfo.Id $installIdInfo.Repeat $dryRun
  if (-not $dryRun -and -not $extraProductFailed) { Set-InstallState $selection.Products }

  if ($dryRun) {
    Write-Host '[dry-run] would hand off to: honeycomb install (daemon-ensure + dashboard-open)'
    return (& $finish 0)
  }

  # The verb prints its own friendly step log and returns a clean exit code; forward it verbatim. A
  # handled failure inside the verb is already a plain-language line + non-zero exit -- no raw trace.
  # Forward the caller's args MINUS every installer-only flag this script itself consumed (mirrors
  # install.sh's filtering), so a bootstrap `--ref <code>` (and any future verb flag) still reaches
  # the CLI's install verb.
  $forwardArgs = @()
  if ($InvocationArgs) {
    foreach ($a in $InvocationArgs) {
      if ($a -eq '--no-doctor' -or $a -eq '-NoDoctor' -or $a -eq '--no-hivedoctor' -or $a -eq '-NoHiveDoctor' -or $a -eq '--dry-run') { continue }
      if ($a -like '--products=*' -or $a -like '--profile=*' -or $a -like '--license=*' -or $a -like '--code=*') { continue }
      $forwardArgs += $a
    }
  }
  & $bin install @forwardArgs
  $cliStatus = $LASTEXITCODE
  # Propagate a selected extra-product failure into the terminal state (mirrors install.sh): never
  # report install_completed / exit 0 when a product the user explicitly selected failed.
  if ($cliStatus -ne 0) { return (& $finish $cliStatus) }
  if ($extraProductFailed) {
    Write-Fail 'one of the selected products did not install/register (see the notes above); Honeycomb itself is installed.'
    return (& $finish 1)
  }
  return (& $finish 0)
}

# Entrypoint: run main, then set the exit code ONCE without tearing down the host (so `irm | iex`
# hands control back to the user's session instead of closing it). $args is the script-level
# invocation args (empty under the bare `irm | iex` pipe, populated under the `& { ... } --flag`
# invocation form documented above); forwarded so every PRD-002a flag + the opt-out switch is seen.
$global:LASTEXITCODE = Invoke-Main $args
