/**
 * Ambient declaration for HiveDoctor's build-time version token (PRD-064f).
 *
 * The later-wave esbuild bundle step replaces `__HIVEDOCTOR_VERSION__` with a string
 * literal via esbuild `define`, mirroring the parent package's `__HONEYCOMB_VERSION__`
 * and HiveDoctor's own `__HONEYCOMB_POSTHOG_*` tokens. Declared `string | undefined`
 * so the `typeof` guard in `src/version.ts` is required, keeping the un-bundled
 * dev/test path explicit and `tsc --noEmit` clean without a build present.
 */

/* eslint-disable no-var */
declare var __HIVEDOCTOR_VERSION__: string | undefined;
