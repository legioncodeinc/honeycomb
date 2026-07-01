#!/bin/sh
# Lightweight, dependency-free assertion harness for install.sh's PRD-002a/b/c flag/env/config/
# code/profile/manifest resolution logic, exercised entirely through the `--dry-run` flag added by
# this PRD (so no real npm/global mutation, no real network install, no real telemetry send ever
# happens while running this file).
#
# This is NOT wired into `npm run ci` (scripts/ is shell, outside the TypeScript graph); run it
# directly:
#   sh scripts/install/tests/install.test.sh
#
# Every test runs install.sh in an ISOLATED temp $HOME (so config-file / install-id / install-state
# reads-and-writes never touch the real ~/.honeycomb) and against a LOCAL fixture manifest served
# via a `file://` URL (so resolution is deterministic and offline; no dependency on
# raw.githubusercontent.com being reachable from the test runner).
set -u

SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
INSTALL_SH="${SCRIPT_DIR}/../install.sh"
FIXTURE_MANIFEST="${SCRIPT_DIR}/fixtures/manifest-mixed.json"

PASS=0
FAIL=0

# Build a `file://` URL for the fixture manifest that curl can actually open; POSIX absolute paths
# work as-is; on Git-Bash/MSYS (Windows) `pwd -W` yields the Windows-drive-letter form curl expects.
if command -v cygpath >/dev/null 2>&1; then
  FIXTURE_URL="file://$(cygpath -m "$FIXTURE_MANIFEST")"
elif (cd "$(dirname "$FIXTURE_MANIFEST")" && pwd -W >/dev/null 2>&1); then
  win_dir="$(cd "$(dirname "$FIXTURE_MANIFEST")" && pwd -W)"
  FIXTURE_URL="file:///${win_dir}/$(basename "$FIXTURE_MANIFEST")"
else
  FIXTURE_URL="file://${FIXTURE_MANIFEST}"
fi

new_temp_home() {
  dir="$(mktemp -d 2>/dev/null || mktemp -d -t honeycomb-install-test)"
  printf '%s' "$dir"
}

# run_dry <temp_home> [extra env assignments...] -- <args...>
# Runs install.sh --dry-run under an isolated HOME with the fixture manifest wired in, capturing
# combined stdout+stderr into $LAST_OUTPUT and the exit code into $LAST_EXIT.
run_install() {
  home_dir="$1"; shift
  LAST_OUTPUT="$(HOME="$home_dir" HONEYCOMB_MANIFEST_URL="$FIXTURE_URL" sh "$INSTALL_SH" "$@" 2>&1)"
  LAST_EXIT=$?
}

assert_contains() {
  desc="$1"; needle="$2"
  case "$LAST_OUTPUT" in
    *"$needle"*)
      PASS=$((PASS + 1))
      printf 'ok   - %s\n' "$desc"
      ;;
    *)
      FAIL=$((FAIL + 1))
      printf 'FAIL - %s\n     expected output to contain: %s\n     --- actual output ---\n%s\n     ----------------------\n' "$desc" "$needle" "$LAST_OUTPUT"
      ;;
  esac
}

assert_not_contains() {
  desc="$1"; needle="$2"
  case "$LAST_OUTPUT" in
    *"$needle"*)
      FAIL=$((FAIL + 1))
      printf 'FAIL - %s\n     expected output to NOT contain: %s\n' "$desc" "$needle"
      ;;
    *)
      PASS=$((PASS + 1))
      printf 'ok   - %s\n' "$desc"
      ;;
  esac
}

assert_exit_code() {
  desc="$1"; expected="$2"
  if [ "$LAST_EXIT" -eq "$expected" ]; then
    PASS=$((PASS + 1))
    printf 'ok   - %s\n' "$desc"
  else
    FAIL=$((FAIL + 1))
    printf 'FAIL - %s (expected exit %s, got %s)\n' "$desc" "$expected" "$LAST_EXIT"
  fi
}

assert_file_absent() {
  desc="$1"; path="$2"
  if [ -e "$path" ]; then
    FAIL=$((FAIL + 1))
    printf 'FAIL - %s (unexpectedly exists: %s)\n' "$desc" "$path"
  else
    PASS=$((PASS + 1))
    printf 'ok   - %s\n' "$desc"
  fi
}

printf '=== a-AC-1/a-AC-3: default selection (no flags) preserves today'"'"'s behavior ===\n'
h1="$(new_temp_home)"
run_install "$h1" --dry-run
assert_contains  "no-flags default is honeycomb,hivedoctor" "products = honeycomb,hivedoctor"
assert_exit_code "no-flags dry-run exits 0" 0
rm -rf "$h1"

printf '\n=== a-AC-1: --products= yields exactly the requested set (+ forced honeycomb) ===\n'
h2="$(new_temp_home)"
run_install "$h2" --dry-run --products=thehive
assert_contains "honeycomb is force-included even when omitted from --products=" "products = honeycomb,thehive"
rm -rf "$h2"

h3="$(new_temp_home)"
run_install "$h3" --dry-run --products=honeycomb,thehive,hivenectar
assert_contains "explicit --products= is honored verbatim (already includes honeycomb)" "products = honeycomb,thehive,hivenectar"
rm -rf "$h3"

printf '\n=== a-AC-2: --code= resolves to a products+profile preset ===\n'
h4="$(new_temp_home)"
run_install "$h4" --dry-run --code=HONEY-FULL
assert_contains "HONEY-FULL code resolves to the full product set" "products = honeycomb,hivedoctor,thehive,hivenectar"
assert_contains "HONEY-FULL code resolves to the full profile" "profile  = full"
rm -rf "$h4"

h5="$(new_temp_home)"
run_install "$h5" --dry-run --code=NOT-A-REAL-CODE
assert_contains "an unrecognized code warns and falls back to the default set" "unrecognized --code=NOT-A-REAL-CODE"
assert_contains "an unrecognized code still resolves to the default product set" "products = honeycomb,hivedoctor"
rm -rf "$h5"

printf '\n=== a-AC-5: --profile= resolves to a products preset ===\n'
h6="$(new_temp_home)"
run_install "$h6" --dry-run --profile=full
assert_contains "profile=full resolves to the full product set" "products = honeycomb,hivedoctor,thehive,hivenectar"
rm -rf "$h6"

printf '\n=== a-AC-3: precedence -- flag beats env beats config file ===\n'
h7="$(new_temp_home)"
mkdir -p "$h7/.honeycomb"
printf 'PRODUCTS=honeycomb,hivenectar\n' > "$h7/.honeycomb/install.conf"
run_install "$h7" --dry-run
assert_contains "config file alone supplies the product set" "products = honeycomb,hivenectar"
rm -rf "$h7"

h8="$(new_temp_home)"
mkdir -p "$h8/.honeycomb"
printf 'PRODUCTS=honeycomb,hivenectar\n' > "$h8/.honeycomb/install.conf"
LAST_OUTPUT="$(HOME="$h8" HONEYCOMB_MANIFEST_URL="$FIXTURE_URL" HONEYCOMB_INSTALL_PRODUCTS="honeycomb,thehive" sh "$INSTALL_SH" --dry-run 2>&1)"
LAST_EXIT=$?
assert_contains "env var beats config file" "products = honeycomb,thehive"
rm -rf "$h8"

h9="$(new_temp_home)"
mkdir -p "$h9/.honeycomb"
printf 'PRODUCTS=honeycomb,hivenectar\n' > "$h9/.honeycomb/install.conf"
LAST_OUTPUT="$(HOME="$h9" HONEYCOMB_MANIFEST_URL="$FIXTURE_URL" HONEYCOMB_INSTALL_PRODUCTS="honeycomb,thehive" sh "$INSTALL_SH" --dry-run --products=honeycomb,hivedoctor 2>&1)"
LAST_EXIT=$?
assert_contains "explicit flag beats both env and config file" "products = honeycomb,hivedoctor"
rm -rf "$h9"

printf '\n=== b-AC-2: manifest-pinned versions resolve for every product (fixture: mixed publish state) ===\n'
h10="$(new_temp_home)"
run_install "$h10" --dry-run --products=honeycomb,hivedoctor,thehive,hivenectar
assert_contains     "honeycomb resolves its manifest-pinned version" "npm install -g @legioncodeinc/honeycomb@9.9.1"
assert_contains     "hivedoctor resolves its manifest-pinned version" "@legioncodeinc/hivedoctor@9.9.2"
assert_contains     "hivenectar (published:true) resolves its manifest-pinned version" "npm install -g @legioncodeinc/hivenectar@9.9.4"
assert_not_contains "hivenectar is NOT installed via @latest when the manifest resolves cleanly" "hivenectar@latest"
rm -rf "$h10"

printf '\n=== b-AC-2/PRD-001c: an unpublished product (thehive) is skipped gracefully, not a raw npm error ===\n'
h11="$(new_temp_home)"
run_install "$h11" --dry-run --products=honeycomb,thehive
assert_contains "unpublished thehive prints a clear, friendly skip note" "is not yet published to npm"
assert_not_contains "unpublished thehive is never handed to npm install" "would run: npm install -g @legioncodeinc/thehive"
rm -rf "$h11"

printf '\n=== security: a tampered manifest with shell/cmd-metacharacter-shaped fields never reaches npm unvalidated ===\n'
MALICIOUS_MANIFEST="${SCRIPT_DIR}/fixtures/manifest-malicious.json"
if command -v cygpath >/dev/null 2>&1; then
  MALICIOUS_URL="file://$(cygpath -m "$MALICIOUS_MANIFEST")"
elif (cd "$(dirname "$MALICIOUS_MANIFEST")" && pwd -W >/dev/null 2>&1); then
  mal_win_dir="$(cd "$(dirname "$MALICIOUS_MANIFEST")" && pwd -W)"
  MALICIOUS_URL="file:///${mal_win_dir}/$(basename "$MALICIOUS_MANIFEST")"
else
  MALICIOUS_URL="file://${MALICIOUS_MANIFEST}"
fi
h_mal="$(new_temp_home)"
LAST_OUTPUT="$(HOME="$h_mal" HONEYCOMB_MANIFEST_URL="$MALICIOUS_URL" sh "$INSTALL_SH" --dry-run --products=honeycomb,hivedoctor,thehive,hivenectar 2>&1)"
LAST_EXIT=$?
# hivedoctor's version field carries a `;`-separated injection attempt: the unsafe shape must be
# REJECTED (never printed as the literal npm target) and the target must fall back to @latest.
assert_not_contains "an injection-shaped version is never handed to npm verbatim" "hivedoctor@9.9.9; touch"
assert_contains     "an injection-shaped version falls back to @latest instead" "@legioncodeinc/hivedoctor@latest"
# thehive's packageName field carries a `;`-separated injection attempt: must fall back to the
# safe built-in fallback package name, never the tampered one.
assert_not_contains "an injection-shaped packageName is never handed to npm verbatim" "thehive; touch"
assert_contains     "an injection-shaped packageName falls back to the safe built-in name" "npm install -g @legioncodeinc/thehive@9.9.9"
# hivenectar's version carries a `&`-separated injection attempt (the Windows/cmd.exe metacharacter
# class the finding specifically targeted): must also fall back to @latest.
assert_not_contains "a \`&\`-shaped version is never handed to npm verbatim" "hivenectar@9.9.9 &"
assert_contains     "a \`&\`-shaped version falls back to @latest instead" "npm install -g @legioncodeinc/hivenectar@latest"
assert_exit_code    "a tampered manifest is never a hard failure in dry-run" 0
rm -rf "$h_mal"

printf '\n=== manifest unreachable: falls back to @latest with a warning, never a hard failure ===\n'
h12="$(new_temp_home)"
LAST_OUTPUT="$(HOME="$h12" HONEYCOMB_MANIFEST_URL="file:///definitely/does/not/exist.json" sh "$INSTALL_SH" --dry-run --products=honeycomb,hivenectar 2>&1)"
LAST_EXIT=$?
assert_contains  "an unreachable manifest warns and falls back to @latest for hivenectar" "falling back to @legioncodeinc/hivenectar@latest"
assert_contains  "an unreachable manifest still resolves honeycomb itself via @latest fallback" "npm install -g @legioncodeinc/honeycomb@latest"
assert_exit_code "an unreachable manifest is never a hard failure in dry-run" 0
rm -rf "$h12"

printf '\n=== --dry-run is fully non-mutating ===\n'
h13="$(new_temp_home)"
run_install "$h13" --dry-run --products=honeycomb,thehive,hivenectar
assert_file_absent "dry-run never writes ~/.honeycomb/install-id"       "$h13/.honeycomb/install-id"
assert_file_absent "dry-run never writes ~/.honeycomb/install-state.json" "$h13/.honeycomb/install-state.json"
rm -rf "$h13"

printf '\n=== c-AC-1/c-AC-4: install_started fires before resolution, with a stable install id ===\n'
h14="$(new_temp_home)"
run_install "$h14" --dry-run
assert_contains "install_started is announced in dry-run output" "would phone home: install_started"
assert_contains "install_started carries the anonymous install id" "install_started (install_id="
assert_contains "install_started fires before resolution: products shows <unresolved>" "products=<unresolved>"
rm -rf "$h14"

printf '\n=== c-AC-4: a run against a HOME with a PRE-EXISTING install id reuses it and reports repeat=true ===\n'
h15="$(new_temp_home)"
mkdir -p "$h15/.honeycomb"
printf '11111111-2222-3333-4444-555555555555' > "$h15/.honeycomb/install-id"
run_install "$h15" --dry-run
assert_contains "a pre-existing install id is reused verbatim" "install_id=11111111-2222-3333-4444-555555555555"
assert_contains "a pre-existing install id is reported as a repeat install" "repeat=true"
rm -rf "$h15"

printf '\n=== c-AC-4: a fresh HOME (no prior install id) reports repeat=false, without persisting anything (dry-run) ===\n'
h15b="$(new_temp_home)"
run_install "$h15b" --dry-run
assert_contains    "a fresh HOME reports repeat=false" "repeat=false"
assert_file_absent "dry-run still never persists the freshly-generated id" "$h15b/.honeycomb/install-id"
rm -rf "$h15b"

printf '\n=== --help prints usage and exits 0 without side effects ===\n'
h16="$(new_temp_home)"
run_install "$h16" --help
assert_contains  "help text documents --products=" "--products="
assert_exit_code "help exits 0" 0
assert_file_absent "help never writes install-id" "$h16/.honeycomb/install-id"
rm -rf "$h16"

printf '\n=== %d passed, %d failed ===\n' "$PASS" "$FAIL"
if [ "$FAIL" -gt 0 ]; then
  exit 1
fi
exit 0
