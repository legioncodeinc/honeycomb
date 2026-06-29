// HiveDoctor's OWN per-target bundler (PRD-063 INT-1).
//
// HiveDoctor ships as a SEPARATE, dependency-light npm package
// (`@legioncodeinc/hivedoctor`, PRD-063 OD-6) with its OWN build, gates, and
// release job. This config is the analogue of the repo-root esbuild.config.mjs,
// scoped to this one package: it consumes the modular ESM `tsc` emits under
// `dist/` and produces ONE self-contained executable bundle, `bundle/cli.js`,
// the `bin` target declared in this package's package.json.
//
// Mirrored conventions (kept deliberately identical to the parent so the two
// builds read the same):
//  - platform: "node", format: "esm" (the package is strict ESM, Node >=22).
//  - Node built-ins (`node:*`) are the ONLY externals. HiveDoctor's binding
//     design principle is ZERO runtime npm dependencies (Node built-ins only),
//     so there is nothing else to externalize: the whole reachable graph is
//     either first-party TypeScript or a node builtin, and esbuild bundles all
//     first-party source into the single file. A non-builtin import slipping in
//     would either be bundled (fine) or, if it were marked external, would make
//     the published package carry a runtime dep - which the package.json has
//     none of, so this list stays `node:*`-only ON PURPOSE.
//  - The version + telemetry destination are build-injected via `define`
//     (PRD-063f / PRD-063d), exactly as the parent inlines `__HONEYCOMB_VERSION__`.
//  - The CLI gets a Node hash-bang preserved from source + 0755, and an ESM
//     marker package.json is stamped beside the bundle.
//
// Single source of truth for the injected version: THIS package's package.json
// `version`. esbuild reads it here and substitutes it for `__HIVEDOCTOR_VERSION__`
// into the bundle - the same single-sourcing discipline the parent uses
// (sync-versions + define), but local to this independent package (it never
// auto-updates its own version, PRD-063 AC-6, so there is no cross-manifest
// propagation to do; the one manifest IS the source).

import { build } from "esbuild";
import { chmodSync, writeFileSync, readFileSync } from "node:fs";

const ESM_PACKAGE_JSON = '{"type":"module"}\n';

// The injected version: this package's own package.json version (NOT the root
// honeycomb version - HiveDoctor versions independently, OD-6).
const HIVEDOCTOR_VERSION = JSON.parse(readFileSync("package.json", "utf-8")).version;

// Build-time PostHog destination, mirroring the parent's PRD-050e pattern: each
// is sourced from a CI env var with a safe default and JSON.stringify'd into the
// define map. An UNSET key compiles to "" - which the telemetry chokepoint
// (src/telemetry/emit.ts, Gate 1) treats as HARD-DISABLED (fail-soft), so a
// local/fork build that never sets these emits nothing. The key is a PUBLIC
// write-only ingest key, embedded in the published tarball BY DESIGN; the CI
// secret only keeps it out of logs and fork PRs. NO real key is ever committed
// to source - it arrives ONLY via CI env at build time (release-hivedoctor.yaml).
const HONEYCOMB_POSTHOG_KEY = process.env.HONEYCOMB_POSTHOG_KEY ?? "";
const HONEYCOMB_POSTHOG_HOST = process.env.HONEYCOMB_POSTHOG_HOST ?? "https://us.i.posthog.com";

// The three build-time tokens the source declares (src/globals.d.ts +
// src/telemetry/globals.d.ts). esbuild replaces each with the string literal
// below; the `typeof` guards in src/version.ts + src/telemetry/emit.ts mean an
// un-bundled dev/test run (no define) falls through to the env/sentinel path, so
// `tsc --noEmit` and `vitest run` stay green without a bundle present.
const DEFINE = {
	__HIVEDOCTOR_VERSION__: JSON.stringify(HIVEDOCTOR_VERSION),
	__HONEYCOMB_POSTHOG_KEY__: JSON.stringify(HONEYCOMB_POSTHOG_KEY),
	__HONEYCOMB_POSTHOG_HOST__: JSON.stringify(HONEYCOMB_POSTHOG_HOST),
};

// ---------------------------------------------------------------------------
// The single bin: src/cli/bin.ts -> bundle/cli.js.
//
// The entry already carries the `#!/usr/bin/env node` shebang (src/cli/bin.ts
// line 1); esbuild preserves a leading hash-bang in the entry automatically, so
// the bundled file stays directly executable. The per-OS service-unit templates
// (launchd plist / systemd unit / Scheduled-Task XML) are NOT external files - 
// they are pure string builders in src/service/templates.ts and get bundled INTO
// cli.js, so the published package needs no separate template assets.
// ---------------------------------------------------------------------------
await build({
	// tsc emits with `rootDir: "."`, so the `src/` segment is preserved in the
	// dist layout (dist/src/cli/bin.js), mirroring the parent build's
	// `dist/src/...` entry paths. esbuild then bundles that single entry.
	entryPoints: { cli: "dist/src/cli/bin.js" },
	bundle: true,
	platform: "node",
	format: "esm",
	outdir: "bundle",
	external: ["node:*"],
	define: DEFINE,
	// ESM-bundle require shim, same rationale as the parent daemon bundle: if any
	// transitively-bundled module performs a CJS `require`, esbuild's ESM output
	// otherwise replaces it with a shim that THROWS. A real `require` via
	// createRequire keeps such a path working. HiveDoctor is built-ins-only so
	// this is belt-and-suspenders, but it is cheap and matches parent discipline.
	banner: {
		js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
	},
});

// Stamp 0755 so the bin is directly executable when the tarball is unpacked on a
// POSIX host (no-op mode bit on win32, but recorded - mirrors the parent's
// stampExecutable rationale).
chmodSync("bundle/cli.js", 0o755);

// Stamp the ESM marker package.json beside the bundle so Node treats bundle/ as
// ESM regardless of any ambient package.json resolution.
writeFileSync("bundle/package.json", ESM_PACKAGE_JSON);

// Status to stderr (not stdout) so a caller parsing `npm pack --json` (e.g.
// scripts/pack-check.mjs runs build via prepack) never gets log noise mixed into
// its JSON data pipe - same discipline as the parent build.
console.error(`Built: hivedoctor bin -> bundle/cli.js @ ${HIVEDOCTOR_VERSION}`);
