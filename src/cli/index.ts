/**
 * Unified `honeycomb` CLI entry root — PRD-020a (FR-1 / FR-2 / a-AC-1).
 *
 * Thin client only: imports the unified dispatcher (`src/commands`) + the real loopback
 * `DaemonClient`, never the daemon core or any DeepLake path. `src/commands` is a
 * NON_DAEMON_ROOT (D-2), so the storage-import invariant holds by construction. PRD-001b bundles
 * this to the CLI artifact with a Node hash-bang.
 *
 * `main` parses global flags, resolves the verb, and routes through {@link dispatch}: storage
 * verbs reach the daemon through the `DaemonClient` seam; `org`/`workspace`/`login`/`logout`
 * pass through to the auth dispatcher; local verbs run the connector/dashboard/status handlers.
 *
 * ── Honest deferral (D-7) ─────────────────────────────────────────────────────
 * The handler-specific seams (the auth passthrough, the 020d health source + 011b drift heal for
 * `status`, the 019a connector engine for setup/connect/uninstall, the 020b dashboard launcher)
 * are wired by the daemon-assembly step that owns the credential + the concrete sources. THIS
 * entry constructs the dispatcher + the real loopback `DaemonClient` (so storage verbs dispatch
 * for real) and leaves the handler seams unbound, so a verb whose seam is not yet wired prints an
 * honest "not wired in this build" line rather than pretending. The bin is NOT claimed
 * live-wired end to end.
 */

import { createDispatcher, createLoopbackDaemonClient, type CommandDeps } from "../commands/index.js";

/** Entry point (FR-1): parse global flags → route to the matching handler → return the exit code. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
	const dispatcher = createDispatcher();
	const inv = dispatcher.parse(argv);
	// The real loopback daemon seam — a thin fetch to 127.0.0.1:3850 (no DeepLake path). The
	// per-handler seams (auth/health/drift/connector/dashboard) are bound by the deferred bin
	// assembly that owns the credential; here a verb needing an unbound seam reports it honestly.
	const deps: CommandDeps = { daemon: createLoopbackDaemonClient() };
	const result = await dispatcher.dispatch(inv, deps);
	return result.exitCode;
}

// Run when invoked directly as the `honeycomb` binary (PRD-001b FR-8 / b-AC-6).
// The bundle is the bin target, so executing it must do work, not just export.
if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("cli.js")) {
	main().then(
		(code) => process.exit(code),
		(err) => {
			process.stderr.write(`${String(err)}\n`);
			process.exit(1);
		},
	);
}
