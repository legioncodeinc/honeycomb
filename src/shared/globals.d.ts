/**
 * Ambient declaration for the build-time version token.
 *
 * PRD-001b's esbuild config replaces `__HONEYCOMB_VERSION__` with a string
 * literal via `define`. Declaring it here lets the un-bundled source type-check
 * under `strict` without esbuild present. `typeof __HONEYCOMB_VERSION__` guards
 * the runtime read so the un-defined case is handled.
 */
declare const __HONEYCOMB_VERSION__: string | undefined;

/**
 * Build-time onboarding/telemetry tokens (PRD-050 substrate).
 *
 * The esbuild config replaces each of these with a string literal via `define`
 * (mirroring `__HONEYCOMB_VERSION__`), each sourced from a CI env var with a safe
 * default so a local un-bundled build still type-checks and runs:
 *   - `__HONEYCOMB_REF_DEFAULT__`  — the default referral code (env
 *     `HONEYCOMB_REF_DEFAULT`, default `"mario"`). Consumed by the onboarding store.
 *   - `__HONEYCOMB_POSTHOG_KEY__`  — the PostHog project key (env
 *     `HONEYCOMB_POSTHOG_KEY`, default `""`). An EMPTY key means telemetry is a
 *     no-op (PRD-050e); no real key is ever baked into source — it arrives only via
 *     CI env at build time.
 *   - `__HONEYCOMB_POSTHOG_HOST__` — the PostHog ingest host (env
 *     `HONEYCOMB_POSTHOG_HOST`, default `"https://us.i.posthog.com"`).
 *
 * Declared `string` (not `string | undefined`): the esbuild `define` always
 * substitutes a literal, and each has a safe default, so the bundled value is never
 * undefined. A `typeof` guard in source is therefore unnecessary for these.
 */
declare const __HONEYCOMB_REF_DEFAULT__: string;
declare const __HONEYCOMB_POSTHOG_KEY__: string;
declare const __HONEYCOMB_POSTHOG_HOST__: string;

/**
 * OpenClaw runtime tuning dispatch (PRD-001b FR-7 / b-AC-7).
 *
 * The OpenClaw esbuild build rewrites every `process.env.HONEYCOMB_*` read to
 * `globalThis.__honeycomb_tuning__.HONEYCOMB_*` via `define`, so the OpenClaw
 * bundle contains zero `process.env` substrings while runtime tuning supplied
 * through `openclaw.json` still works. The OpenClaw `register()` populates this
 * object from `pluginApi.pluginConfig.tuning`; the esbuild `banner` guarantees
 * it exists before any rewritten read fires. Declared at top level so this
 * file stays a script (keeping `__HONEYCOMB_VERSION__` global) while still
 * augmenting `globalThis` so a tuning read type-checks under `strict`.
 */
declare var __honeycomb_tuning__: Record<string, string | undefined> | undefined;
