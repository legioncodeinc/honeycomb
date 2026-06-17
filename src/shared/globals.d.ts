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
