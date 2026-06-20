/**
 * The real {@link ConnectorRunner} the CLI binds for `setup` / `connect` / `uninstall` — PRD-021b
 * (FR-2 / b-AC-6, reusing the 019a connector base, D-4).
 *
 * 020a's `runConnectorVerb` routes the CLI verb onto the 019a `connectorMain` through the
 * {@link ConnectorRunner} seam but left the seam UNBOUND (the deferred-assembly stub). 021b binds it:
 * this module builds the real {@link ConnectorRegistry} over a `node:fs`-backed {@link ConnectorFs}
 * and the claude-code + cursor connectors, then adapts `connectorMain`'s result into the
 * `{ exitCode, harnesses }` shape `runConnectorVerb` reports. No install logic is re-implemented —
 * every merge / foreign-preserve / idempotency / reversibility rule is the 019a engine's (D-4).
 *
 * ── Boundary: install-time filesystem only, NO DeepLake (D-2) ────────────────
 * The connectors touch `node:fs` + the user's home + the bundled harness sources only. `src/cli` is
 * a NON_DAEMON_ROOT; this opens no DeepLake connection and holds no daemon handle.
 */

import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { ConnectorRunner, ConnectorVerbArgs, ConnectorVerbResult } from "../commands/index.js";
import {
	ClaudeCodeConnector,
	type ConnectorFs,
	connectorMain,
	type ConnectorRegistry,
	CursorConnector,
	createNodeConnectorFs,
	type HarnessConnector,
} from "../connectors/index.js";

/** Resolve the package root so the connector finds the bundled `harnesses/<h>/bundle/` sources. */
function packageRoot(): string {
	// The CLI runs from `bundle/cli.js` (published) or `dist/src/cli/` (dev tsc). Walk up to the
	// dir that holds `harnesses/`. The published layout is `<root>/bundle/cli.js`; from this
	// module that is one dir up. The env override covers a relocated install.
	if (process.env.HONEYCOMB_PACKAGE_ROOT !== undefined && process.env.HONEYCOMB_PACKAGE_ROOT.length > 0) {
		return process.env.HONEYCOMB_PACKAGE_ROOT;
	}
	const here = dirname(fileURLToPath(import.meta.url));
	return resolve(here, "..");
}

/** The bundled hook-handler source dir for a harness slug (`harnesses/<slug>/bundle`). */
function bundleSourceFor(slug: string): string {
	return join(packageRoot(), "harnesses", slug, "bundle");
}

/**
 * The real connector registry (D-4): the two supported hook-protocol connectors (claude-code as the
 * reference, cursor as the sibling), each built over the supplied `node:fs` {@link ConnectorFs} and
 * pointed at the bundled handler sources + the user's home. A new harness is a SUBCLASS added here —
 * never a fork of install logic (019a a-AC-5).
 */
export function createConnectorRegistry(home: string = homedir()): ConnectorRegistry {
	const builders: Readonly<Record<string, (fs: ConnectorFs) => HarnessConnector>> = {
		"claude-code": (fs) =>
			new ClaudeCodeConnector(fs, { home, bundleSource: bundleSourceFor("claude-code") }),
		cursor: (fs) => new CursorConnector(fs, { home, bundleSource: bundleSourceFor("cursor") }),
	};
	return {
		build(harness: string, fs: ConnectorFs): HarnessConnector | undefined {
			const make = builders[harness];
			return make !== undefined ? make(fs) : undefined;
		},
		known(): readonly string[] {
			return Object.keys(builders);
		},
	};
}

/**
 * Build the real {@link ConnectorRunner} (FR-2 / D-4). Routes `setup` / `connect <harness>` /
 * `uninstall [<harness>]` through the 019a `connectorMain` over a `node:fs` {@link ConnectorFs} +
 * the real registry, then maps the run results into the `{ exitCode, harnesses }` shape the CLI
 * reports. The `out` is swallowed here (the verb handler renders its own summary line).
 */
export function buildConnectorRunner(): ConnectorRunner {
	const fs = createNodeConnectorFs();
	const registry = createConnectorRegistry();
	return {
		async run(args: ConnectorVerbArgs): Promise<ConnectorVerbResult> {
			const argv = args.harness !== undefined ? [args.verb, args.harness] : [args.verb];
			const result = await connectorMain(argv, { fs, registry, out: (): void => {} });
			return { exitCode: result.exitCode, harnesses: result.results.map((r) => r.harness) };
		},
	};
}
