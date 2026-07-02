#!/usr/bin/env node
// site/install/build.mjs — DRY build step for the get.theapiary.sh install surface.
//
// PRD-050a follow-up (vanity domain + published checksum + inspect-before-piping page).
//
// SINGLE SOURCE OF TRUTH: the canonical installer scripts live at scripts/install/.
// This build COPIES them into the Cloudflare Pages publish dir (site/install/dist/),
// computes their SHA-256, and renders the inspect index.html from a template injecting
// the LIVE checksums + one-liners + the script source. Checksums are therefore computed
// from EXACTLY what gets deployed — self-consistent by construction.
//
// Run: `node build.mjs` (from site/install/, the Cloudflare Pages "build command").
// Emits: dist/{install.sh, install.ps1, SHA256SUMS, index.html}
//
// Standalone tooling: pure Node ESM, no dependencies, never imported by the app build.
// It is NOT part of `tsc && esbuild` and never ships in the npm tarball.

import { createHash } from 'node:crypto';
import { mkdir, copyFile, readFile, writeFile, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Repo root is two levels up from site/install/.
const REPO_ROOT = join(__dirname, '..', '..');
const SRC_DIR = join(REPO_ROOT, 'scripts', 'install');
const DIST_DIR = join(__dirname, 'dist');
const TEMPLATE = join(__dirname, 'index.template.html');

const VANITY = 'https://get.theapiary.sh';
const GITHUB_SRC = 'https://github.com/legioncodeinc/honeycomb/tree/main/scripts/install';

// The two installer scripts, in the order they appear in SHA256SUMS + the page.
const SCRIPTS = ['install.sh', 'install.ps1'];

// PRD-002c: both installer scripts declare their PostHog key as an EMPTY string in source control
// (`HONEYCOMB_INSTALL_POSTHOG_KEY=""` / `$HoneycombInstallPosthogKey = ''`). This is a PostHog
// project API key — safe to expose client-side by design (ADR-0002) — so it is injected here at
// deploy-build time, the same "bake a public key into the install site" mechanism the ADR calls
// for, rather than a runtime secret lookup on the user's machine. Sourced from an env var so
// `deploy-install-site.yaml` can supply it as a plain (non-secret) repository variable.
//
// IMPORTANT: this is an ANCHORED, per-language regex substitution of the exact declaration line —
// deliberately NOT a blind find/replace of a placeholder token over the whole file. An earlier
// version of this build step used a shared placeholder token, which also appeared (by construction)
// in the scripts' own "is telemetry configured" empty-string guard once naively substituted,
// silently disabling telemetry forever after the very first real key was baked in. Anchoring the
// substitution to the ONE declaration line closes that class of bug structurally: nothing else in
// either script can accidentally match the pattern.
//
// An UNSET/empty env var leaves each script's declaration at its committed empty-string default,
// which both scripts' `phone_home`/`Send-PhoneHome` treat as "telemetry disabled" (never a hard
// failure) — so a keyless build (e.g. a PR preview, or local `node build.mjs`) still produces a
// fully working, just silently non-reporting, installer.
const POSTHOG_KEY = process.env.HONEYCOMB_INSTALL_POSTHOG_KEY ?? '';
// Defense-in-depth: only ever inject a key shaped like a PostHog project key. Anything else
// (accidental whitespace, an unrelated secret pasted into the wrong env var, …) is treated as
// "not set" rather than silently baked into a public, world-readable script.
const POSTHOG_KEY_SAFE = /^[A-Za-z0-9_-]{0,200}$/.test(POSTHOG_KEY) ? POSTHOG_KEY : '';

const POSTHOG_KEY_PATTERNS = {
  'install.sh': {
    pattern: /^HONEYCOMB_INSTALL_POSTHOG_KEY=""$/m,
    replace: (key) => `HONEYCOMB_INSTALL_POSTHOG_KEY="${key}"`,
  },
  'install.ps1': {
    pattern: /^\$HoneycombInstallPosthogKey = ''$/m,
    replace: (key) => `$HoneycombInstallPosthogKey = '${key}'`,
  },
};

// Inject the key into one script's source text via its anchored pattern above. Throws (failing the
// build loudly) if the expected declaration line is missing — a silent no-op here would mean a
// refactor of install.sh/install.ps1 quietly broke telemetry injection without anyone noticing.
function injectPosthogKey(name, text, key) {
  const spec = POSTHOG_KEY_PATTERNS[name];
  if (spec === undefined) return text;
  if (!spec.pattern.test(text)) {
    throw new Error(
      `site/install build: expected declaration line for ${name} (pattern ${spec.pattern}) not found — ` +
        'the PostHog key injection point may have moved; update POSTHOG_KEY_PATTERNS in build.mjs.',
    );
  }
  return text.replace(spec.pattern, spec.replace(key));
}

function sha256(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

// Minimal HTML escape for injecting raw script source into a <pre><code> block.
function escapeHtml(s) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function main() {
  // Clean slate so the dist mirrors EXACTLY the current canonical scripts (no stale copies).
  await rm(DIST_DIR, { recursive: true, force: true });
  await mkdir(DIST_DIR, { recursive: true });

  // 1) Copy canonical scripts + capture their bytes for hashing/rendering. The PostHog key is
  //    injected HERE (before hashing/writing) so SHA256SUMS always reflects exactly the bytes
  //    actually served — no separate "hash then patch" step that could ever drift.
  const sources = {};
  const sums = {};
  for (const name of SCRIPTS) {
    const srcPath = join(SRC_DIR, name);
    const rawText = await readFile(srcPath, 'utf8');
    const text = injectPosthogKey(name, rawText, POSTHOG_KEY_SAFE);
    const bytes = Buffer.from(text, 'utf8');
    await writeFile(join(DIST_DIR, name), bytes);
    sources[name] = text;
    sums[name] = sha256(bytes);
  }

  // 2) Write SHA256SUMS in the standard `<sha256>  <file>` format (two spaces => binary mode),
  //    verifiable with `sha256sum -c SHA256SUMS` from the dist dir.
  const sumsBody = SCRIPTS.map((name) => `${sums[name]}  ${name}`).join('\n') + '\n';
  await writeFile(join(DIST_DIR, 'SHA256SUMS'), sumsBody, 'utf8');

  // 2b) Copy the _headers rules into the PUBLISH dir. Cloudflare Pages only reads _headers from
  //     the build OUTPUT directory (dist/), NOT the project root — without this, the text/plain +
  //     nosniff rules on /install.sh|/install.ps1|/SHA256SUMS would never publish.
  await copyFile(join(__dirname, '_headers'), join(DIST_DIR, '_headers'));

  // 2c) Copy the canonical brand favicon from the shared logo set (single source of truth — same
  //     asset the dashboard uses). The inspect page references /favicon.svg; the page MARK is the
  //     real honeycomb-mark.svg inlined in the template.
  await copyFile(join(REPO_ROOT, 'assets', 'logos', 'favicon.svg'), join(DIST_DIR, 'favicon.svg'));

  // 2d) Emit the blessed-version channel for HiveDoctor auto-update (PRD-065). HiveDoctor fetches
  //     https://get.theapiary.sh/blessed-version.json and forward-updates the daemon ONLY to the
  //     `version` named here (verify + rollback on the client, fail-closed if this is unreachable).
  //     On a `v*` release deploy this self-blesses the released version; on a manual dispatch it
  //     blesses main's current version. Schema is minimal: { version } (+ optional minVersion);
  //     extra fields are ignored by the client. Served short-cache so a new bless propagates within
  //     HiveDoctor's 30-minute poll.
  const honeycombVersion = JSON.parse(await readFile(join(REPO_ROOT, 'package.json'), 'utf8')).version;
  const blessed = { version: honeycombVersion, generatedAt: new Date().toISOString() };
  await writeFile(join(DIST_DIR, 'blessed-version.json'), JSON.stringify(blessed, null, 2) + '\n', 'utf8');

  // 3) Render index.html from the template, injecting live values.
  const template = await readFile(TEMPLATE, 'utf8');
  const html = template
    .replaceAll('{{VANITY}}', VANITY)
    .replaceAll('{{GITHUB_SRC}}', GITHUB_SRC)
    .replaceAll('{{SHA_SH}}', sums['install.sh'])
    .replaceAll('{{SHA_PS1}}', sums['install.ps1'])
    .replaceAll('{{BUILT_AT}}', new Date().toISOString())
    .replaceAll('{{SOURCE_SH}}', escapeHtml(sources['install.sh']))
    .replaceAll('{{SOURCE_PS1}}', escapeHtml(sources['install.ps1']));
  await writeFile(join(DIST_DIR, 'index.html'), html, 'utf8');

  // 4) Report (stdout is the Cloudflare Pages build log).
  console.log('site/install build complete → dist/');
  console.log('  install.sh   ', sums['install.sh']);
  console.log('  install.ps1  ', sums['install.ps1']);
  console.log('  SHA256SUMS   written');
  console.log('  blessed-version.json', honeycombVersion);
  console.log('  _headers     copied');
  console.log('  favicon.svg  copied');
  console.log('  index.html   rendered');
  console.log(
    '  posthog key  ',
    POSTHOG_KEY_SAFE.length > 0
      ? 'baked (install-time telemetry ENABLED)'
      : 'NOT set (HONEYCOMB_INSTALL_POSTHOG_KEY env var absent/invalid — install-time telemetry stays disabled, matches the no-op default)',
  );
}

main().catch((err) => {
  console.error('site/install build FAILED:', err);
  process.exit(1);
});
