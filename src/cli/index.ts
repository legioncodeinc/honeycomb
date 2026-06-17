/**
 * Unified `honeycomb` CLI entry root.
 *
 * Thin client only: imports the daemon-client surface and shared constants,
 * never the daemon core or any DeepLake path. PRD-001b bundles this to the
 * CLI artifact with a Node hash-bang. Real command surface lands in a later PRD.
 */

import { createDaemonClient } from "../daemon-client/index.js";
import { HONEYCOMB_VERSION, PRODUCT_SLUG } from "../shared/constants.js";

/** Entry point. Stub: prints version and exits; real yargs surface lands later. */
export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<number> {
	const client = createDaemonClient();
	const alive = await client.ping();
	process.stdout.write(`${PRODUCT_SLUG} v${HONEYCOMB_VERSION} (daemon ${alive ? "up" : "down"})\n`);
	void argv;
	return 0;
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
