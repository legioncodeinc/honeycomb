/**
 * Single source of truth for shared constants across every Honeycomb target.
 *
 * No target (daemon, harness, CLI, MCP, embed daemon) may re-declare these
 * values. Duplicating any constant below into another package is a drift bug
 * and will be flagged by `npm run dup` (jscpd). Import from here instead.
 *
 * FR-7: shared values are extracted to one source of truth to prevent drift.
 * FR-8: no durable app state is modeled as JSON/JSONL sidecar files at this
 *       layer; durable state is reserved for DeepLake (PRD-002).
 */

/** Loopback port the long-lived daemon listens on; every thin client dials it. */
export const DAEMON_PORT = 3850;

/** Loopback host the daemon binds to. Never bind to a public interface. */
export const DAEMON_HOST = "127.0.0.1";

/**
 * Build-time version seam. PRD-001c's sync-versions step and PRD-001b's esbuild
 * `define` replace the `__HONEYCOMB_VERSION__` token with the root
 * package.json version at bundle time. This fallback is what the un-bundled
 * `dist/` output reports before that replacement runs.
 */
export const HONEYCOMB_VERSION: string =
	typeof __HONEYCOMB_VERSION__ === "string" ? __HONEYCOMB_VERSION__ : "0.0.0-dev";

/** Lowercase product slug used for the CLI bin name, config dir, and paths. */
export const PRODUCT_SLUG = "honeycomb";
