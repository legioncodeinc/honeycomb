/**
 * Ambient declarations for the build-time PostHog ingest tokens (064d).
 *
 * HiveDoctor's esbuild bundle step (later wave, 064f) will replace these with
 * string literals via esbuild `define`, mirroring the pattern in
 * `src/shared/globals.d.ts` of the parent package. Until then (Wave 0) the
 * `typeof` guard in `emit.ts` reads the env fallback path and these declarations
 * keep `tsc --noEmit` clean without requiring a bundled build.
 *
 * Both values are declared `string | undefined` so the `typeof` guard is
 * required in code -- matching the `__HONEYCOMB_VERSION__` discipline in the
 * parent globals.d.ts and making the un-bundled/un-injected dev case explicit.
 */

/* eslint-disable no-var */
declare var __HONEYCOMB_POSTHOG_KEY__: string | undefined;
declare var __HONEYCOMB_POSTHOG_HOST__: string | undefined;
