/**
 * Unified `honeycomb` CLI entry root — PRD-020a (FR-1 / FR-2) + PRD-021b (b-AC-1..6).
 *
 * Thin client only: imports the unified dispatcher (`src/commands`) + the CLI-side composition root
 * (`./runtime`), never the daemon core or any DeepLake path. `src/commands` + `src/cli` are
 * NON_DAEMON_ROOTs (D-2), so the storage-import invariant holds by construction. PRD-001b bundles
 * this to `bundle/cli.js` with a Node hash-bang.
 *
 * `main` parses global flags, resolves the verb, and routes through {@link dispatch} with the FULLY
 * BOUND {@link RuntimeDeps} (021b):
 *   - storage verbs reach the daemon through the real loopback `DaemonClient` (b-AC-1) and
 *     auto-start a down daemon on demand (b-AC-3);
 *   - `daemon start|stop|status` drives the daemon lifecycle (b-AC-2);
 *   - `org`/`workspace`/`login`/`logout` pass through to the auth dispatcher with the REAL device
 *     flow + drift heal (b-AC-4);
 *   - `setup`/`connect`/`uninstall` run the 019a connector engine; `dashboard` launches 020b;
 *     `status` reports the real 020d D1–D5 health (b-AC-5).
 *
 * ── No deferred-assembly stub path remains (b-AC-6) ───────────────────────────
 * Every seam the 020a dispatcher consumes is bound by {@link buildRuntimeDeps}. A dispatched verb
 * always reaches a real handler; the honest-deferral stub strings the 020a scaffold printed are
 * gone from the live CLI path.
 */

import { pathToFileURL } from "node:url";
import { createDispatcher } from "../commands/index.js";
import { buildRuntimeDeps } from "./runtime.js";
import { finalizeCliExit } from "./exit.js";

/** Entry point (FR-1 / b-AC-6): parse global flags → route to the matching BOUND handler. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
	const dispatcher = createDispatcher();
	const inv = dispatcher.parse(argv);
	// The fully-bound runtime deps (021b): the real loopback daemon client, the daemon lifecycle,
	// the auth passthrough (real device flow), the 019a connector engine, the 020b dashboard
	// launcher, and the 020d D1–D5 health source. No seam is left as an honest stub.
	const deps = buildRuntimeDeps();
	const result = await dispatcher.dispatch(inv, deps);
	return result.exitCode;
}

/**
 * Whether this module is being executed directly as the `honeycomb` bin (the bundled
 * `bundle/cli.js`), as opposed to imported by a test or another module. Mirrors the
 * daemon's `isMainEntry` ({@link file://./../daemon/index.ts}): `import.meta.url` is the
 * realpath'd, always-forward-slash module URL, so `endsWith("/cli.js")` matches the
 * bundle whether it is reached directly, through the Unix npm bin SYMLINK
 * (`honeycomb` → `…/bundle/cli.js`), or the Windows npm SHIM (`node C:\…\bundle\cli.js`).
 * That symlink case is the one the original `process.argv[1].endsWith("cli.js")` guard
 * missed — it tested the symlink NAME instead of the realpath'd target — so every
 * command exited 0 in silence (the bug this fixes).
 *
 * `pathToFileURL(argv1)` (Windows-correct, unlike a `file://${path}` string concat)
 * additionally covers `--preserve-symlinks-main`, where `import.meta.url` stays the
 * symlink path rather than the realpath. Exported + pure so the regression test can
 * assert every invocation path without a real global install. PRD-001b FR-8 / b-AC-6.
 */
export function isCliEntry(importMetaUrl: string, argv1: string | undefined): boolean {
	if (typeof argv1 !== "string" || argv1.length === 0) return false;
	try {
		return importMetaUrl === pathToFileURL(argv1).href || importMetaUrl.endsWith("/cli.js");
	} catch {
		return false;
	}
}

// Run when invoked directly as the `honeycomb` binary (PRD-001b FR-8 / b-AC-6).
// The bundle is the bin target, so executing it must do work, not just export.
if (isCliEntry(import.meta.url, process.argv[1])) {
	// PRD-022d / d-AC-4: do NOT call `process.exit(code)` here. An abrupt `process.exit()`
	// races libuv handle teardown on Windows — the detached daemon-spawn child handle and the
	// undici keep-alive socket pool (from the loopback `fetch`) may still be mid-close, which
	// trips `Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)` (exit 127). Instead we close
	// those handles deterministically (`finalizeCliExit`) and set `process.exitCode`, letting the
	// (now-unref'd) event loop drain and Node exit cleanly. See `./exit.ts`.
	main().then(
		async (code) => {
			await finalizeCliExit();
			process.exitCode = code;
		},
		async (err) => {
			process.stderr.write(`${String(err)}\n`);
			await finalizeCliExit();
			process.exitCode = 1;
		},
	);
}
