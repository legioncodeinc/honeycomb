#!/bin/sh
# Honeycomb one-command bootstrap installer (POSIX); PRD-050a, extended by the-apiary PRD-002
# (product loading + install-time telemetry, ADR-0002).
#
# Usage (the single line a brand-new user pastes):
#   curl -fsSL https://get.theapiary.sh | sh
#
# With product selection (PRD-002a):
#   curl -fsSL https://get.theapiary.sh | sh -s -- --products=honeycomb,thehive,hivenectar
#
# Contract (PRD-050a a-AC-1..6): leave the user on a running dashboard, OR tell them in ONE plain
# sentence why not. It assumes the operator knows nothing; no Node, no npm, no idea what a daemon
# is. It is deliberately THIN and IDEMPOTENT: it detects what is already present, installs only what
# is missing, and re-running it is safe.
#
# This script owns the host-bootstrap half: detect/install Node+npm (via fnm + a pinned LTS), then
# `npm i -g @legioncodeinc/honeycomb`, plus (PRD-002b) any other SELECTED product from the fleet
# (hivedoctor / the-hive / hivenectar), each resolved to its hive-release.json-pinned version. The
# moment a `honeycomb` bin exists it HANDS OFF to the `honeycomb install` CLI verb for the
# daemon-ensure + health-gate + dashboard-open; so that logic lives ONCE in TypeScript
# (src/commands/install.ts), not duplicated across two shell dialects.
#
# POSIX sh ONLY (no bashisms): this runs under `sh`, which may be dash/ash, not bash.
#
# ═══════════════════════════════════════════════════════════════════════════════════════════════
# PRD-002a; Product loading grammar (documented once, implemented identically in install.ps1)
# ═══════════════════════════════════════════════════════════════════════════════════════════════
#
# Flags (all optional):
#   --products=<slug,slug,...>   e.g. --products=honeycomb,thehive,hivenectar
#                                 Slugs match hive-release.json's product keys exactly:
#                                 honeycomb | hivedoctor | thehive | hivenectar.
#   --profile=<name>              A named preset that expands to a --products= list when
#                                 --products= itself was not given. Built-in profiles:
#                                   default -> honeycomb,hivedoctor      (today's fixed behavior)
#                                   full    -> honeycomb,hivedoctor,thehive,hivenectar
#   --license=<key>               An opaque license key, threaded into the resolved selection.
#                                 No backing entitlement service exists yet (ADR-0002 Non-Goal);
#                                 this flag only makes the value resolvable for that future system.
#                                 NEVER sent in telemetry (kept off the phone-home payload).
#   --code=<code>                 A product code that resolves (via the table in
#                                 resolve_code_products/resolve_code_profile below) to a
#                                 products+profile PRESET, standing in for a longer flag
#                                 combination. Example: --code=HONEY-FULL. Unknown/expired code:
#                                 a warning is printed and the code is IGNORED (soft-fail; a
#                                 bad code must never brick the one-line install).
#   --dry-run                     Resolve everything (flags/env/config/code/profile, the pinned
#                                 manifest versions) and PRINT what would happen; performs NO
#                                 mutation (no npm install, no Node bootstrap, no registry write,
#                                 no state write, no real telemetry POST). Added by PRD-002 to make
#                                 this script's resolution logic verifiable without a real install.
#   --no-hivedoctor                Opt out of the HiveDoctor watchdog (PRD-064b, unchanged).
#
# Environment variable equivalents (read when the matching flag is absent):
#   HONEYCOMB_INSTALL_PRODUCTS, HONEYCOMB_INSTALL_PROFILE, HONEYCOMB_INSTALL_LICENSE,
#   HONEYCOMB_INSTALL_CODE, HONEYCOMB_NO_HIVEDOCTOR (pre-existing).
#
# Config file (read when neither the flag nor the env var is set):
#   ~/.honeycomb/install.conf; one `KEY=value` pair per line (no spaces around `=`), `#` comments
#   and blank lines allowed. Keys: PRODUCTS, PROFILE, LICENSE, CODE. Never sourced/executed; only
#   parsed as plain text; so a config file can never inject shell code. This is the seam a repo
#   administrator uses to pin a fleet-wide deploy shape without editing the pasted command.
#
# PRECEDENCE (documented once, applies per-field): explicit flag > environment variable > config
# file > (a --code=/--profile= PRESET fills the products/profile gap only if still unset) > the
# built-in default (`honeycomb,hivedoctor`, i.e. today's behavior, unchanged for anyone who pipes
# this script with no flags at all). `honeycomb` itself is ALWAYS part of the effective product set
# regardless of --products=, because this script IS honeycomb's own bootstrap entry point (it hands
# off to `honeycomb install` for the daemon/dashboard); there is no meaningful "install without
# honeycomb" outcome through this entry point.
#
# Combo/alias URLs (PRD-002a a-AC-4) are OPTIONAL SUGAR handled at the install SITE
# (honeycomb/site/install/functions/index.js), which maps a `?combo=<name>` query parameter to the
# SAME environment-variable inputs this script already reads (HONEYCOMB_INSTALL_PRODUCTS/_PROFILE) ,
# never a separate/parallel resolution mechanism. See that file for the preset table.
#
# ═══════════════════════════════════════════════════════════════════════════════════════════════
# PRD-002c; Install-time telemetry (fired from THIS script, independent of the Node build key)
# ═══════════════════════════════════════════════════════════════════════════════════════════════
# `install_started` fires first (before any flag/env/config resolution; c-AC-1), and exactly one
# of `install_completed` / `install_failed` fires at the terminal state (c-AC-2), via `finish()`.
# Both use a PUBLIC PostHog project key baked into the install SITE (not the Node build key); see
# `phone_home()` below. A stable anonymous install id correlates the two (c-AC-4).
# ═══════════════════════════════════════════════════════════════════════════════════════════════

# `set -e` would abort on the FIRST non-zero command, surfacing a raw error. We instead handle every
# failure explicitly and print a plain-language line (parent AC-7); so `set -e` is intentionally OFF.
set -u

# ─────────────────────────────────────────────────────────────────────────────
# THE ONE PLACE TO BUMP NODE. The single pinned Node LTS the installer provisions
# via fnm. To upgrade the provisioned Node for every new user, change THIS line
# only. (Existing users with a working Node are left untouched; see step 1.)
# ─────────────────────────────────────────────────────────────────────────────
HONEYCOMB_NODE_VERSION="22"

# The published npm package the global install pulls (PRD-048 publishes it; this consumes it).
# PRD-002b: this is the FALLBACK package name only; `install_honeycomb` resolves the ACTUAL
# installed version from the hive-release.json manifest (`resolve_product_target`) when it is
# reachable, falling back to `@latest` only when the manifest itself cannot be resolved.
HONEYCOMB_NPM_PACKAGE="@legioncodeinc/honeycomb"

# HiveDoctor (PRD-064b): a SECOND global package, the self-healing watchdog that keeps the
# primary daemon alive and registers itself with the OS so it survives crashes + reboots. Its
# lifecycle is deliberately INDEPENDENT of the Honeycomb tarball (OD-6: a second global), so it
# is installed here as its own `npm i -g` after the primary, then registers its OS service.
HIVEDOCTOR_NPM_PACKAGE="@legioncodeinc/hivedoctor"

# Distribution base URL: the vanity domain that serves this installer surface (PRD-050a follow-up,
# now RESOLVED). get.theapiary.sh is a Cloudflare Pages site (site/install/) that content-negotiates:
# a shell client piping `/` gets this script as text/plain; a browser gets an "inspect before piping"
# page with the PUBLISHED SHA-256 checksums. `${BASE}/install.sh` and `${BASE}/install.ps1` always
# resolve to the raw, checksummed scripts. To verify before running: see https://get.theapiary.sh
HONEYCOMB_INSTALL_BASE_URL="https://get.theapiary.sh"

# ── PRD-001/PRD-002b: the fleet release manifest (the-apiary superproject's hive-release.json). ──
# This installer never hardcodes "latest" for a product it did not itself publish (b-AC-2): it
# resolves each selected product's exact pinned version from THIS manifest. Overridable via env
# purely for local testing against a fork/branch copy of the manifest.
HONEYCOMB_MANIFEST_URL="${HONEYCOMB_MANIFEST_URL:-https://raw.githubusercontent.com/legioncodeinc/the-apiary/main/hive-release.json}"

# ── PRD-002c: telemetry destination. The key is EMPTY in source control by design; this exact
# `HONEYCOMB_INSTALL_POSTHOG_KEY=""` line is the one `site/install/build.mjs` patches (via an
# anchored regex on this literal line, never a blind find/replace over the whole file) at deploy
# time, injecting the real PostHog project key (mirrors ADR-0002: "a public PostHog project key
# baked into the install site"). An empty value (any un-built/local/dev copy of this script) makes
# `phone_home` a silent no-op; never a hard failure. See site/install/build.mjs for the build-time
# substitution and site/install/README.md for why a full-file text substitution was rejected (it
# would also corrupt this script's OWN "is telemetry configured" check).
HONEYCOMB_INSTALL_POSTHOG_KEY=""
HONEYCOMB_INSTALL_POSTHOG_HOST="https://us.i.posthog.com"
HONEYCOMB_INSTALL_POSTHOG_PATH="/i/v0/e/"
HONEYCOMB_INSTALL_ID_FILE="${HOME}/.honeycomb/install-id"

# ── PRD-002a: admin config file + PRD-002b: this installer's own bookkeeping of the last-selected
# product set (used ONLY to detect a --products= narrowing between runs, so a removed product's
# hivedoctor registry entry can be cleaned up; see reconcile_removed_products). ──
HONEYCOMB_INSTALL_CONFIG_FILE="${HOME}/.honeycomb/install.conf"
HONEYCOMB_INSTALL_STATE_FILE="${HOME}/.honeycomb/install-state.json"
HONEYCOMB_HIVEDOCTOR_REGISTRY_FILE="${HOME}/.honeycomb/hivedoctor.daemons.json"

# ── Globals populated during argv parsing / selection resolution. Declared up-front (all `set -u`
# safe) so every later `${VAR:-...}` reference is well-defined regardless of code path taken. ──
ARG_PRODUCTS=""
ARG_PROFILE=""
ARG_LICENSE=""
ARG_CODE=""
ARG_DRY_RUN=0
DRY_RUN=0
SEL_PRODUCTS=""
SEL_PROFILE=""
SEL_LICENSE=""
SEL_CODE=""
INSTALL_ID=""
IS_REPEAT_INSTALL="false"
EXTRA_PRODUCT_FAILED=0

# ── Friendly progress log: step lines to stdout, the single failure summary to stderr. ──
step()  { printf '→ %s\n' "$1"; }
ok()    { printf '✓ %s\n' "$1"; }
fail()  { printf 'Honeycomb install could not continue: %s\n' "$1" >&2; }

# `command -v` is the POSIX way to test for a binary (NOT `which`, which is not guaranteed present).
have()  { command -v "$1" >/dev/null 2>&1; }

# ═══════════════════════════════════════════════════════════════════════════════════════════════
# PRD-002c; anonymous install id + phone-home
# ═══════════════════════════════════════════════════════════════════════════════════════════════

# Best-effort UUID-shaped id, in decreasing order of "how real a UUID this actually is". This is an
# ANONYMOUS distinct_id (c-AC-4/c-AC-5-adjacent "no PII"): no hostname, username, or MAC address
# ever folds into it, at any fallback tier.
generate_uuid() {
	if have uuidgen; then uuidgen; return 0; fi
	if [ -r /proc/sys/kernel/random/uuid ]; then cat /proc/sys/kernel/random/uuid; return 0; fi
	if have od; then
		hex="$(od -An -N16 -tx1 /dev/urandom 2>/dev/null | tr -d ' \n')"
		if [ "${#hex}" -eq 32 ]; then
			printf '%s-%s-4%s-%s-%s\n' \
				"$(printf '%s' "$hex" | cut -c1-8)" \
				"$(printf '%s' "$hex" | cut -c9-12)" \
				"$(printf '%s' "$hex" | cut -c14-16)" \
				"$(printf '%s' "$hex" | cut -c17-20)" \
				"$(printf '%s' "$hex" | cut -c21-32)"
			return 0
		fi
	fi
	# Last-resort fallback (no uuidgen/od/procfs available): not a spec-compliant UUID, but still
	# unique-enough and carries no machine/user identity; better than losing correlation entirely.
	printf 'nohd-%s-%s\n' "$(date +%s 2>/dev/null || echo 0)" "$$"
}

# Resolve (or, outside --dry-run, mint + persist) the stable anonymous install id (c-AC-4). Sets
# INSTALL_ID and IS_REPEAT_INSTALL ("true" iff the id file already existed before this run). In
# --dry-run mode this NEVER writes: an ephemeral id is generated in-memory purely for the preview,
# so repeated dry-run invocations leave zero residue on disk.
resolve_install_id() {
	if [ -f "$HONEYCOMB_INSTALL_ID_FILE" ] && [ -s "$HONEYCOMB_INSTALL_ID_FILE" ]; then
		INSTALL_ID="$(cat "$HONEYCOMB_INSTALL_ID_FILE" 2>/dev/null | tr -d '\n')"
		IS_REPEAT_INSTALL="true"
		return 0
	fi
	INSTALL_ID="$(generate_uuid)"
	IS_REPEAT_INSTALL="false"
	if [ "$DRY_RUN" -ne 1 ]; then
		mkdir -p "$(dirname "$HONEYCOMB_INSTALL_ID_FILE")" 2>/dev/null
		printf '%s\n' "$INSTALL_ID" > "$HONEYCOMB_INSTALL_ID_FILE" 2>/dev/null || true
	fi
}

# Fire ONE PostHog capture event (c-AC-1/c-AC-2). FAIL-SOFT + BOUNDED (`--max-time 3`): a slow or
# unreachable ingest endpoint never hangs or breaks the install (ADR-0002 "never delays or breaks
# the install"). Uses the SAME capture endpoint + body shape as the Node-side chokepoint
# (`src/daemon/runtime/telemetry/emit.ts`: `{ api_key, event, distinct_id, properties }` posted to
# `${host}/i/v0/e/`) for consistency, but is otherwise fully INDEPENDENT of it; this only needs
# `curl`, so it fires even before Node/npm exist (the entire point of ADR-0002: the transport
# survives a keyless Node build AND an install that fails before the Node CLI ever runs).
#
# The payload is deliberately minimal and allow-list-shaped (no PII, and `--license=`/`--code=`
# values are NEVER included): products, profile, coarse OS family, repeat-vs-first, and the event
# name itself (doubling as a coarse terminal-status label).
phone_home() {
	event="$1"
	# --dry-run ALWAYS previews what would be sent, even against an un-substituted placeholder key
	# (a local/dev checkout); this is the one seam PRD-002's verification story depends on, so the
	# key-guard below only gates the REAL network send, never the dry-run preview.
	if [ "$DRY_RUN" -eq 1 ]; then
		printf '[dry-run] would phone home: %s (install_id=%s, repeat=%s, products=%s, profile=%s)\n' \
			"$event" "${INSTALL_ID:-unknown}" "$IS_REPEAT_INSTALL" "${SEL_PRODUCTS:-<unresolved>}" "${SEL_PROFILE:-<none>}"
		return 0
	fi
	[ -z "$HONEYCOMB_INSTALL_POSTHOG_KEY" ] && return 0
	have curl || return 0
	body=$(printf '{"api_key":"%s","event":"%s","distinct_id":"%s","properties":{"products":"%s","profile":"%s","os":"%s","repeat_install":"%s"}}' \
		"$HONEYCOMB_INSTALL_POSTHOG_KEY" "$event" "${INSTALL_ID:-unknown}" "${SEL_PRODUCTS:-}" "${SEL_PROFILE:-}" \
		"$(uname -s 2>/dev/null || echo unknown)" "$IS_REPEAT_INSTALL")
	curl -fsS --max-time 3 -H 'Content-Type: application/json' -d "$body" \
		"${HONEYCOMB_INSTALL_POSTHOG_HOST}${HONEYCOMB_INSTALL_POSTHOG_PATH}" >/dev/null 2>&1 || true
	return 0
}

# ═══════════════════════════════════════════════════════════════════════════════════════════════
# PRD-002a; flag / env / config-file / code / profile resolution
# ═══════════════════════════════════════════════════════════════════════════════════════════════

# `--code=<code>` → a products PRESET (a-AC-2). Unrecognized code: caller treats a non-zero return
# as "ignore the code, warn, keep going" (soft-fail; never brick the one-line install over a typo).
resolve_code_products() {
	case "$1" in
		HONEY-FULL) printf '%s' "honeycomb,hivedoctor,thehive,hivenectar" ;;
		*) return 1 ;;
	esac
}

# `--code=<code>` → the profile name it implies (paired 1:1 with resolve_code_products above).
resolve_code_profile() {
	case "$1" in
		HONEY-FULL) printf '%s' "full" ;;
		*) return 1 ;;
	esac
}

# `--profile=<name>` → a products PRESET, used only to fill the products gap when --products=
# itself was not given by any higher-precedence source (flag/env/config).
resolve_profile_products() {
	case "$1" in
		default) printf '%s' "honeycomb,hivedoctor" ;;
		full)    printf '%s' "honeycomb,hivedoctor,thehive,hivenectar" ;;
		*) return 1 ;;
	esac
}

# Read one `KEY=value` from the admin config file (a-AC-3). Plain-text parse ONLY; this file is
# NEVER sourced/executed, so it cannot inject shell code. Comments (`#`) and blank lines are
# ignored; the LAST matching `KEY=` line wins (a later line overrides an earlier one, ini-style).
read_config_value() {
	key="$1"
	[ -f "$HONEYCOMB_INSTALL_CONFIG_FILE" ] || return 0
	awk -F'=' -v k="$key" '
		/^[[:space:]]*#/ { next }
		$1 == k { val = substr($0, length($1) + 2) }
		END { if (val != "") print val }
	' "$HONEYCOMB_INSTALL_CONFIG_FILE" 2>/dev/null
}

# Scan argv for the installer-only flags this script consumes itself (a-AC-1/a-AC-5). Does NOT
# mutate or shift the caller's positional params (function-local $@); `--no-hivedoctor` is
# deliberately left alone here; `hivedoctor_opted_out` re-scans the ORIGINAL "$@" directly, as it
# already did before PRD-002.
parse_args() {
	for a in "$@"; do
		case "$a" in
			--products=*) ARG_PRODUCTS="${a#--products=}" ;;
			--profile=*)  ARG_PROFILE="${a#--profile=}" ;;
			--license=*)  ARG_LICENSE="${a#--license=}" ;;
			--code=*)     ARG_CODE="${a#--code=}" ;;
			--dry-run)    ARG_DRY_RUN=1 ;;
			--help|-h)    print_usage; exit 0 ;;
		esac
	done
}

print_usage() {
	cat <<'USAGE'
Usage: install.sh [--products=<slug,slug,...>] [--profile=<name>] [--license=<key>]
                   [--code=<code>] [--dry-run] [--no-hivedoctor]

  --products=honeycomb,thehive,hivenectar   select exactly which products to install
  --profile=full                            a named products preset (default | full)
  --license=<key>                           thread a license key through (seam only, PRD-002a)
  --code=HONEY-FULL                         resolve a product code to a products+profile preset
  --dry-run                                 resolve + print, mutate nothing
  --no-hivedoctor                           skip the HiveDoctor watchdog

Env equivalents: HONEYCOMB_INSTALL_PRODUCTS / _PROFILE / _LICENSE / _CODE, HONEYCOMB_NO_HIVEDOCTOR.
Config file: ~/.honeycomb/install.conf (KEY=value per line: PRODUCTS, PROFILE, LICENSE, CODE).
Precedence: flag > env > config file > code/profile preset (fills gaps only) > built-in default.
USAGE
}

# Resolve the effective selection (SEL_PRODUCTS/SEL_PROFILE/SEL_LICENSE/SEL_CODE) per the
# documented precedence (a-AC-3): flag > env > config file, then a --code=/--profile= preset fills
# the products gap only if still empty, then the built-in default, then honeycomb is force-included.
resolve_selection() {
	cfg_products="$(read_config_value PRODUCTS)"
	cfg_profile="$(read_config_value PROFILE)"
	cfg_license="$(read_config_value LICENSE)"
	cfg_code="$(read_config_value CODE)"

	SEL_PRODUCTS="${ARG_PRODUCTS:-${HONEYCOMB_INSTALL_PRODUCTS:-${cfg_products:-}}}"
	SEL_PROFILE="${ARG_PROFILE:-${HONEYCOMB_INSTALL_PROFILE:-${cfg_profile:-}}}"
	SEL_LICENSE="${ARG_LICENSE:-${HONEYCOMB_INSTALL_LICENSE:-${cfg_license:-}}}"
	SEL_CODE="${ARG_CODE:-${HONEYCOMB_INSTALL_CODE:-${cfg_code:-}}}"

	# A --code= resolves to a products+profile PRESET, but only FILLS GAPS: an explicit
	# products/profile from a higher-precedence source always wins over what the code implies.
	if [ -n "$SEL_CODE" ]; then
		if code_products="$(resolve_code_products "$SEL_CODE")"; then
			[ -z "$SEL_PRODUCTS" ] && SEL_PRODUCTS="$code_products"
			[ -z "$SEL_PROFILE" ] && SEL_PROFILE="$(resolve_code_profile "$SEL_CODE")"
		else
			printf 'note: unrecognized --code=%s (ignoring; falling back to products/profile/defaults).\n' "$SEL_CODE"
		fi
	fi

	# A --profile= resolves to a products PRESET, filling the gap only when still unset.
	if [ -z "$SEL_PRODUCTS" ] && [ -n "$SEL_PROFILE" ]; then
		if profile_products="$(resolve_profile_products "$SEL_PROFILE")"; then
			SEL_PRODUCTS="$profile_products"
		else
			printf 'note: unrecognized --profile=%s (ignoring; falling back to the default product set).\n' "$SEL_PROFILE"
		fi
	fi

	# Built-in default: today's fixed behavior, preserved byte-for-byte for anyone piping this
	# installer with no flags at all.
	[ -z "$SEL_PRODUCTS" ] && SEL_PRODUCTS="honeycomb,hivedoctor"

	# honeycomb is ALWAYS part of the effective set; see the header comment for why.
	case ",$SEL_PRODUCTS," in
		*,honeycomb,*) : ;;
		*) SEL_PRODUCTS="honeycomb,${SEL_PRODUCTS}" ;;
	esac
}

# ═══════════════════════════════════════════════════════════════════════════════════════════════
# PRD-002b; resolve a product's pinned version from hive-release.json
# ═══════════════════════════════════════════════════════════════════════════════════════════════

_MANIFEST_JSON=""
_MANIFEST_FETCHED=0

# Fetch the manifest ONCE per run (cached in `_MANIFEST_JSON`); a network failure is remembered
# too (so we don't retry per-field) and surfaces as "unresolved" to every caller.
fetch_manifest() {
	[ "$_MANIFEST_FETCHED" -eq 1 ] && { [ -n "$_MANIFEST_JSON" ]; return $?; }
	_MANIFEST_FETCHED=1
	have curl || return 1
	_MANIFEST_JSON="$(curl -fsSL --max-time 5 "$HONEYCOMB_MANIFEST_URL" 2>/dev/null)" || { _MANIFEST_JSON=""; return 1; }
	[ -n "$_MANIFEST_JSON" ] || return 1
	return 0
}

# manifest_field <slug> <field>; prints the field's value, or nothing (+ returns 1) if unresolved.
# Uses `node` (guaranteed available by the time any real, non-dry-run caller reaches this; Node is
# ensured before any product is installed) to parse JSON reliably rather than hand-rolling a
# sed/grep JSON parser for a document this script does not control the shape of byte-for-byte.
manifest_field() {
	slug="$1"; field="$2"
	fetch_manifest || return 1
	have node || return 1
	printf '%s' "$_MANIFEST_JSON" | node -e '
		let raw = "";
		process.stdin.on("data", (d) => { raw += d; });
		process.stdin.on("end", () => {
			try {
				const m = JSON.parse(raw);
				const p = m && m.products && m.products[process.argv[1]];
				if (!p || p[process.argv[2]] === undefined) process.exit(1);
				process.stdout.write(String(p[process.argv[2]]));
			} catch (e) { process.exit(1); }
		});
	' "$slug" "$field" 2>/dev/null
}

# SECURITY (security-review finding, medium): the manifest is an external input (a
# compromised repo, a MITM on a fetch, or a user-supplied HONEYCOMB_MANIFEST_URL override
# could all poison it). Even though this script already double-quotes every "$target"
# expansion (never vulnerable to the injection class the finding targeted on the
# PowerShell dialect, whose npm.cmd shim re-parses argument metacharacters via cmd.exe),
# validating the SHAPE of packageName/version here closes the vector at its source for
# BOTH dialects rather than relying solely on downstream quoting discipline.
#
# npm_package_name_is_safe: a conservative safe-character allowlist matching real npm
# package-name rules (lowercase, digits, `.`/`_`/`-`, optionally `@scope/name`); this
# alone makes it structurally impossible to smuggle a shell/cmd metacharacter through.
npm_package_name_is_safe() {
	case "$1" in
		@[a-z0-9]*/[a-z0-9]*)
			scope="${1%%/*}"; name="${1#*/}"
			case "$scope" in @*[!a-z0-9._-]*|@) return 1 ;; esac
			case "$name" in *[!a-z0-9._-]*|"") return 1 ;; esac
			return 0
			;;
		[a-z0-9]*)
			case "$1" in *[!a-z0-9._-]*) return 1 ;; esac
			return 0
			;;
		*) return 1 ;;
	esac
}

# semver_is_safe: digits.digits.digits with an optional -prerelease / +build suffix drawn
# from the same safe character set (never a metacharacter).
semver_is_safe() {
	case "$1" in
		[0-9]*.[0-9]*.[0-9]*)
			case "$1" in *[!0-9A-Za-z.+-]*) return 1 ;; esac
			return 0
			;;
		*) return 1 ;;
	esac
}

# Resolve the npm install target for a product slug (b-AC-2). Prints exactly one of:
#   "ok <pkg>@<version>"   -- install this manifest-pinned target
#   "unpublished <pkg>"    -- manifest declares published:false; do NOT attempt an npm install,
#                             this is the expected shape until a maintainer completes the one-time
#                             npm Trusted-Publisher bootstrap (PRD-001c); never a cryptic npm error
#   "unresolved <pkg>"     -- the manifest itself is unreachable/malformed, OR its packageName/
#                             version fields fail the safe-shape check above; fall back to
#                             <pkg>@latest with a printed warning (a manifest hiccup, or a
#                             tampered field, must never brick installing a product the user
#                             explicitly asked for, and must never reach npm/the shell unvalidated)
resolve_product_target() {
	slug="$1"; fallback_pkg="$2"
	pkg="$(manifest_field "$slug" packageName)"
	if [ -z "$pkg" ] || ! npm_package_name_is_safe "$pkg"; then pkg="$fallback_pkg"; fi
	version="$(manifest_field "$slug" version)"
	if [ -z "$version" ] || ! semver_is_safe "$version"; then
		printf 'unresolved %s\n' "$pkg"
		return 0
	fi
	published="$(manifest_field "$slug" published)"
	if [ "$published" = "false" ]; then
		printf 'unpublished %s\n' "$pkg"
		return 0
	fi
	printf 'ok %s@%s\n' "$pkg" "$version"
}

# Thin wrapper over resolve_product_target for the two ALWAYS-core products (honeycomb,
# hivedoctor), which; unlike the-hive/hivenectar; are always expected to already be published
# (b-AC-2 applies to every installed product, not only the new ones). Collapses the 3-way
# ok/unpublished/unresolved result down to a single npm install target string: the manifest-pinned
# version when resolvable, else `<pkg>@latest` (never a hard failure over a manifest hiccup).
resolve_core_product_target() {
	slug="$1"; fallback_pkg="$2"
	resolved="$(resolve_product_target "$slug" "$fallback_pkg")"
	kind="${resolved%% *}"
	payload="${resolved#* }"
	case "$kind" in
		ok) printf '%s' "$payload" ;;
		*) printf '%s@latest' "$payload" ;;
	esac
}

# ─────────────────────────────────────────────────────────────────────────────
# Step 1; Node + npm. If both are present, use them. Else install fnm (NO elevation)
#          + the pinned Node LTS. fnm installs entirely under $HOME, so it never needs
#          sudo; that is exactly why it is the primary path over the official installer.
# ─────────────────────────────────────────────────────────────────────────────
ensure_node() {
  if have node && have npm; then
    ok "Node $(node --version) and npm $(npm --version) found."
    return 0
  fi

  step "Node/npm not found; installing a private copy via fnm (no admin rights needed)…"

  # fnm install is a curl|sh that writes ONLY under ~/.local/share/fnm + ~/.fnm; no elevation.
  if ! have fnm; then
    if ! have curl; then
      # We cannot fetch fnm without curl, and installing curl itself needs the OS package manager
      # (which needs elevation). Print the EXACT copy-paste and exit cleanly (a-AC-3).
      elevation_required_node
      return 1
    fi
    if ! curl -fsSL https://fnm.vercel.app/install | sh >/dev/null 2>&1; then
      # fnm's own installer failed (e.g. a locked-down $HOME it cannot write). Fall back to the
      # documented manual command + clean non-zero exit (a-AC-3); never a raw error dump.
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

  # fnm landed but node/npm still are not resolvable; surface the manual path, clean exit (a-AC-3).
  elevation_required_node
  return 1
}

# a-AC-3; print the EXACT copy-paste install command + a one-line WHY, then signal a clean
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
# Step 2; install @legioncodeinc/honeycomb globally. The embedding runtime
#          (@huggingface/transformers) is an OPTIONAL dependency of the package and
#          is pulled by npm during this install; its MODEL WEIGHTS are NOT fetched
#          here (that is the embed daemon's lazy warmup; 050b), so this stays fast.
# ─────────────────────────────────────────────────────────────────────────────
install_honeycomb() {
  # Idempotent: a re-run on a machine that already has `honeycomb` is a NO-OP; no npm mutation, no
  # network. This keeps the documented "safe to re-run" contract and lets a rerun succeed OFFLINE. Only
  # an absent install triggers the global npm install. (`resolve_honeycomb_bin` is defined below; POSIX sh
  # resolves functions at call time, so the forward reference is fine; both exist before `main` runs.)
  if existing_bin="$(resolve_honeycomb_bin 2>/dev/null)"; then
    ok "${HONEYCOMB_NPM_PACKAGE} already installed (${existing_bin})."
    return 0
  fi
  target="$(resolve_core_product_target "honeycomb" "$HONEYCOMB_NPM_PACKAGE")"
  step "installing ${target} globally…"
  if ! npm install -g "$target" >/dev/null 2>&1; then
    fail "the global install of ${target} failed."
    printf '\nTry it directly to see the npm error, then re-run this installer:\n\n  npm install -g %s\n\n' "$target"
    return 1
  fi
  ok "installed ${target}."
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
# Step 3b: HiveDoctor bootstrap (PRD-064b). After the primary is installed, install the
#           HiveDoctor watchdog (a second global) and register its OS service, UNLESS the
#           user opted out with `--no-hivedoctor` (the ONLY install-time switch, OD-5) or the
#           env equivalent HONEYCOMB_NO_HIVEDOCTOR=1. Idempotent: an existing hivedoctor bin
#           is not reinstalled, and `hivedoctor install-service` converges (it overwrites its
#           unit). FAIL-SOFT: a HiveDoctor hiccup never fails the Honeycomb install, the user
#           still lands on a working dashboard (parent AC-10 spirit: opt-out is honest, and a
#           watchdog failure is not a primary-install failure).
# ─────────────────────────────────────────────────────────────────────────────

# True (returns 0) when the user opted OUT of HiveDoctor via the flag or the env equivalent.
# Mirrors hivedoctor/src/service/install-guard.ts (shouldBootstrapHiveDoctor), keep in sync.
hivedoctor_opted_out() {
  case " $* " in
    *" --no-hivedoctor "*) return 0 ;;
  esac
  case "${HONEYCOMB_NO_HIVEDOCTOR:-}" in
    1|true|TRUE|True) return 0 ;;
  esac
  return 1
}

# Install the HiveDoctor global (idempotent) + register its OS service. All output is friendly;
# every failure is a soft note, never a hard exit (the primary install already succeeded).
install_hivedoctor() {
  if have hivedoctor; then
    ok "${HIVEDOCTOR_NPM_PACKAGE} already installed."
  else
    hd_target="$(resolve_core_product_target "hivedoctor" "$HIVEDOCTOR_NPM_PACKAGE")"
    step "installing the HiveDoctor watchdog (${hd_target})…"
    if ! npm install -g "$hd_target" >/dev/null 2>&1; then
      printf 'note: could not install %s (continuing, Honeycomb itself is installed).\n' "$hd_target"
      return 0
    fi
    ok "installed ${hd_target}."
  fi

  # Resolve + run `hivedoctor install-service` to register the OS service (userland scope by
  # default; survives crash + reboot). `npm i -g` does not refresh THIS shell's PATH, so resolve
  # the absolute bin the same way we do for honeycomb.
  hd_bin=""
  if have hivedoctor; then
    hd_bin="$(command -v hivedoctor)"
  else
    hd_prefix="$(npm prefix -g 2>/dev/null)"
    if [ -n "$hd_prefix" ] && [ -x "${hd_prefix}/bin/hivedoctor" ]; then
      hd_bin="${hd_prefix}/bin/hivedoctor"
    fi
  fi
  if [ -n "$hd_bin" ]; then
    step "registering the HiveDoctor OS service…"
    if "$hd_bin" install-service >/dev/null 2>&1; then
      ok "HiveDoctor is watching (it will restart the daemon on crash and survive reboots)."
    else
      # IRD-192 AC-7: a non-zero exit now means the service manager rejected the unit. Do NOT claim
      # the watchdog is watching; name the actionable command so the user can see why. Non-fatal:
      # Honeycomb itself is already installed (parent AC-10 spirit).
      printf "note: HiveDoctor installed but its service did not register (continuing). Run 'hivedoctor install-service' to see why.\n"
    fi
  fi
  return 0
}

# ═══════════════════════════════════════════════════════════════════════════════════════════════
# PRD-002b; install + register the-hive / hivenectar when selected (the coverage-gap close)
# ═══════════════════════════════════════════════════════════════════════════════════════════════
#
# Generic across both products (small, deliberate duplication vs. one dense function): resolve the
# manifest-pinned target, npm-install it globally (idempotent, fail-soft), then run the product's
# OWN post-install verb. Both the-hive (`thehive install-service`) and hivenectar (`hivenectar
# install`) ALREADY implement a hivedoctor-registry writer internally (`thehive/src/install/
# registry.ts` / `hivenectar/src/hivedoctor-registry.ts`); this installer reuses THEIR verb rather
# than hand-rolling a second registry writer, so there is exactly one writer per product (b-AC-3).
install_extra_product() {
	display_name="$1"; slug="$2"; fallback_pkg="$3"; bin_name="$4"; post_install_verb="$5"

	resolved="$(resolve_product_target "$slug" "$fallback_pkg")"
	kind="${resolved%% *}"
	pkg="${resolved#* }"

	case "$kind" in
		unpublished)
			printf 'note: %s (%s) is not yet published to npm; skipping (a maintainer still needs to complete the one-time npm Trusted-Publisher bootstrap, PRD-001c). Re-run this installer after that lands.\n' "$display_name" "$pkg"
			return 0
			;;
		unresolved)
			printf 'note: could not resolve the pinned version for %s from the release manifest; falling back to %s@latest.\n' "$display_name" "$pkg"
			target="${pkg}@latest"
			;;
		*)
			target="$pkg"
			;;
	esac

	if [ "$DRY_RUN" -eq 1 ]; then
		printf '[dry-run] would run: npm install -g %s\n' "$target"
		printf '[dry-run] would run: %s %s\n' "$bin_name" "$post_install_verb"
		return 0
	fi

	if have "$bin_name"; then
		ok "${display_name} already installed ($(command -v "$bin_name"))."
	else
		step "installing ${display_name} (${target}) globally…"
		if ! npm install -g "$target" >/dev/null 2>&1; then
			printf 'note: could not install %s (continuing; the rest of the install still succeeded). Try: npm install -g %s\n' "$display_name" "$target"
			EXTRA_PRODUCT_FAILED=1
			return 0
		fi
		ok "installed ${display_name}."
	fi

	prod_bin=""
	if have "$bin_name"; then
		prod_bin="$(command -v "$bin_name")"
	else
		prod_prefix="$(npm prefix -g 2>/dev/null)"
		if [ -n "$prod_prefix" ] && [ -x "${prod_prefix}/bin/${bin_name}" ]; then
			prod_bin="${prod_prefix}/bin/${bin_name}"
		fi
	fi

	if [ -n "$prod_bin" ]; then
		step "registering ${display_name} with hivedoctor…"
		if "$prod_bin" $post_install_verb >/dev/null 2>&1; then
			ok "${display_name} registered."
		else
			printf 'note: %s installed but its %s step did not complete (continuing). Run `%s %s` to see why.\n' "$display_name" "$post_install_verb" "$bin_name" "$post_install_verb"
			EXTRA_PRODUCT_FAILED=1
		fi
	fi
	return 0
}

# ═══════════════════════════════════════════════════════════════════════════════════════════════
# PRD-002b; registration create/update/DELETE across lifecycle transitions
# ═══════════════════════════════════════════════════════════════════════════════════════════════
# CREATE/UPDATE are handled above (install_extra_product's post-install verb, plus honeycomb's own
# `writeHivedoctorRegistryEntry` inside `honeycomb install`). DELETE is the remaining transition:
# when a re-run's --products= NARROWS the set (a product previously installed is no longer
# selected), that product's hivedoctor registry entry is removed so the registry stays an honest
# picture of the fleet (parent AC-6). This is the ONLY delete path this installer implements today
#; see the header note in reconcile_removed_products for the honest scope of what is NOT covered.

# Read the previous run's selected products (comma list), or empty if none/unreadable/first-run.
read_previous_products() {
	[ -f "$HONEYCOMB_INSTALL_STATE_FILE" ] || return 0
	have node || return 0
	node -e '
		try {
			const fs = require("node:fs");
			const s = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
			if (typeof s.products === "string") process.stdout.write(s.products);
		} catch (e) { /* unreadable/malformed -> treated as "no prior state" */ }
	' "$HONEYCOMB_INSTALL_STATE_FILE" 2>/dev/null
}

# Persist this run's selection as "the last thing this installer selected" (installer-owned
# bookkeeping; NOT the hivedoctor registry contract itself, just this script's own diff baseline).
write_install_state() {
	have node || return 0
	node -e '
		const fs = require("node:fs");
		const path = require("node:path");
		const file = process.argv[1];
		const products = process.argv[2];
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ products, updatedAt: new Date().toISOString() }, null, 2) + "\n", "utf8");
	' "$HONEYCOMB_INSTALL_STATE_FILE" "$SEL_PRODUCTS" 2>/dev/null || true
}

# Deregister one product's entry from hivedoctor's static registry by name (the "delete"
# transition). Mirrors the SAME idempotent replace-by-name shape the TS writers use
# (`registerHoneycombWithHivedoctor` / `registerThehiveWithHivedoctor`), just filtering the entry
# OUT instead of upserting it. Fail-soft: any read/parse/write hiccup is swallowed; a registry
# cleanup step must never fail the run that triggered it.
deregister_from_hivedoctor() {
	name="$1"
	[ -f "$HONEYCOMB_HIVEDOCTOR_REGISTRY_FILE" ] || return 0
	have node || return 0
	node -e '
		const fs = require("node:fs");
		const file = process.argv[1];
		const name = process.argv[2];
		let doc;
		try { doc = JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { process.exit(0); }
		if (!doc || !Array.isArray(doc.daemons)) process.exit(0);
		const next = doc.daemons.filter((d) => !d || d.name !== name);
		if (next.length === doc.daemons.length) process.exit(0);
		const tmp = file + ".tmp-" + process.pid + "-" + Date.now();
		fs.writeFileSync(tmp, JSON.stringify(Object.assign({}, doc, { daemons: next }), null, 2) + "\n", "utf8");
		fs.renameSync(tmp, file);
	' "$HONEYCOMB_HIVEDOCTOR_REGISTRY_FILE" "$name" 2>/dev/null || true
}

# NOTE ON SCOPE (documented honestly, see the ledger too): this does NOT run `npm uninstall -g` ,
# removing a global package the user may still want for other reasons is a separate, more
# destructive decision this installer does not make on the user's behalf. It ONLY keeps
# hivedoctor's registry honest. Also: neither honeycomb, the-hive, nor hivenectar ships a full
# "product uninstall" verb today (checked: the-hive's `uninstall-service` / hivenectar's
# `uninstall` only remove the OS service unit, they do NOT touch the hivedoctor registry); so a
# --products= narrowing between two runs of THIS installer is the only delete trigger implemented.
# A real `honeycomb uninstall` (or per-product uninstall) command remains a documented gap.
reconcile_removed_products() {
	previous="$(read_previous_products)"
	[ -n "$previous" ] || return 0
	old_ifs="$IFS"
	IFS=','
	for p in $previous; do
		IFS="$old_ifs"
		case ",$SEL_PRODUCTS," in
			*",$p,"*) : ;; # still selected; nothing to do
			*)
				case "$p" in
					thehive|hivenectar)
						if [ "$DRY_RUN" -eq 1 ]; then
							printf '[dry-run] would deregister %s from hivedoctor (no longer in --products=).\n' "$p"
						else
							step "deregistering ${p} from hivedoctor (no longer in --products=)…"
							deregister_from_hivedoctor "$p"
						fi
						;;
					*) : ;; # honeycomb/hivedoctor: no self-deregistration through this path
				esac
				;;
		esac
		IFS=','
	done
	IFS="$old_ifs"
}

# ─────────────────────────────────────────────────────────────────────────────
# Terminal-state telemetry (c-AC-2): every exit from main() funnels through here so exactly one
# of install_completed/install_failed always fires, including a failure BEFORE the honeycomb CLI
# ever runs (the exact gap ADR-0002 exists to close).
# ─────────────────────────────────────────────────────────────────────────────
finish() {
	code="$1"
	if [ "$code" -eq 0 ]; then
		phone_home install_completed
	else
		phone_home install_failed
	fi
	exit "$code"
}

# ─────────────────────────────────────────────────────────────────────────────
# Step 3; hand off to the CLI verb for the daemon-ensure + health-gate + dashboard
#          open. The open logic lives ONCE in the CLI (src/commands/install.ts), not
#          here. The verb is idempotent + health-gated (a-AC-2 / a-AC-4) and opens
#          honeycomb.local → loopback (a-AC-6), writing onboarding "installed" (a-AC-5).
# ─────────────────────────────────────────────────────────────────────────────
main() {
  parse_args "$@"
  [ "$ARG_DRY_RUN" -eq 1 ] && DRY_RUN=1

  # c-AC-1: fires BEFORE any product resolution, using only `curl` (no Node/npm dependency).
  resolve_install_id
  phone_home install_started

  resolve_selection

  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'resolved selection (--dry-run, nothing will be installed/registered/sent):\n'
    printf '  products = %s\n' "$SEL_PRODUCTS"
    printf '  profile  = %s\n' "${SEL_PROFILE:-<none>}"
    if [ -n "$SEL_LICENSE" ]; then printf '  license  = <redacted, %s chars>\n' "${#SEL_LICENSE}"; else printf '  license  = <none>\n'; fi
    printf '  code     = %s\n' "${SEL_CODE:-<none>}"
    printf '  install id = %s (repeat=%s)\n' "$INSTALL_ID" "$IS_REPEAT_INSTALL"
  fi

  if [ "$DRY_RUN" -eq 1 ]; then
    if have node && have npm; then
      ok "Node $(node --version) and npm $(npm --version) found (dry-run: no bootstrap attempted)."
    else
      printf 'note: node/npm not found (dry-run; a real run would attempt to install them via fnm).\n'
    fi
  else
    ensure_node || finish 1
  fi

  case ",$SEL_PRODUCTS," in
    *,honeycomb,*)
      if [ "$DRY_RUN" -eq 1 ]; then
        printf '[dry-run] would run: npm install -g %s\n' "$(resolve_core_product_target "honeycomb" "$HONEYCOMB_NPM_PACKAGE")"
      else
        install_honeycomb || finish 1
      fi
      ;;
  esac

  if [ "$DRY_RUN" -eq 1 ]; then
    bin=""
  else
    bin="$(resolve_honeycomb_bin)"
    if [ -z "$bin" ]; then
      fail "could not locate the installed 'honeycomb' command after the global install."
      printf '\nOpen a NEW terminal (so PATH refreshes) and run:\n\n  honeycomb install\n\n'
      finish 1
    fi
  fi

  # HiveDoctor bootstrap (PRD-064b), now ALSO gated on hivedoctor being in the resolved selection
  # (b-AC-5: an unselected product is never installed), in addition to the pre-existing opt-out.
  case ",$SEL_PRODUCTS," in
    *,hivedoctor,*)
      if hivedoctor_opted_out "$@"; then
        step "skipping HiveDoctor (--no-hivedoctor)."
      elif [ "$DRY_RUN" -eq 1 ]; then
        printf '[dry-run] would install + register HiveDoctor (%s).\n' "$(resolve_core_product_target "hivedoctor" "$HIVEDOCTOR_NPM_PACKAGE")"
      else
        install_hivedoctor
      fi
      ;;
    *) step "skipping HiveDoctor (not in --products=)." ;;
  esac

  # PRD-002b: actually install the-hive / hivenectar when selected (the coverage-gap close).
  case ",$SEL_PRODUCTS," in
    *,thehive,*) install_extra_product "the-hive" thehive "@legioncodeinc/thehive" thehive install-service ;;
  esac
  case ",$SEL_PRODUCTS," in
    *,hivenectar,*) install_extra_product "Hivenectar" hivenectar "@legioncodeinc/hivenectar" hivenectar install ;;
  esac

  # PRD-002b DELETE transition: a --products= narrowing vs. the last run.
  reconcile_removed_products
  [ "$DRY_RUN" -eq 1 ] || write_install_state

  if [ "$DRY_RUN" -eq 1 ]; then
    printf '[dry-run] would hand off to: honeycomb install (daemon-ensure + dashboard-open)\n'
    finish 0
  fi

  # The verb prints its own friendly step log (daemon up / onboarding marked / opening dashboard) and
  # returns a clean exit code; we forward it verbatim. A handled failure inside the verb is already a
  # plain-language line + non-zero exit; no raw stack reaches the user here. Forward the caller's args
  # MINUS every installer-only flag this script itself consumed (--no-hivedoctor, and now the PRD-002a
  # flags), so a bootstrap `--ref <code>` (and any future verb flag) still reaches the CLI's install
  # verb. The positional rebuild preserves args that contain spaces (string concatenation would not):
  # append each KEPT arg, then drop the original leading args by their count.
  _orig_count=$#
  for a in "$@"; do
    case "$a" in
      --no-hivedoctor|--products=*|--profile=*|--license=*|--code=*|--dry-run) continue ;;
    esac
    set -- "$@" "$a"
  done
  # Shift off the ORIGINAL args one at a time, leaving only the filtered copies we appended.
  _i=0
  while [ "$_i" -lt "$_orig_count" ]; do
    shift
    _i=$((_i + 1))
  done
  "$bin" install "$@"
  finish $?
}

main "$@"
