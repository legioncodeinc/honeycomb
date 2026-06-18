/**
 * The auto-wiring engine — PRD-020d (FR-9 / d-AC-2 / d-AC-6 / D-4).
 *
 * The engine DELEGATES to a 019a {@link HarnessConnector} (`src/connectors`) — it forks NO
 * second hook-merge engine (D-4). `wire()` runs the connector's `install()` (write handlers +
 * patch `hooks.json` foreign-preserving via `isHoneycombEntry` + idempotent via
 * `writeJsonIfChanged` → an UNCHANGED config is never rewritten, so the hook-trust fingerprint is
 * stable, d-AC-6) and reports whether the config actually changed (the connector's `wroteConfig`,
 * false on the idempotent no-op). `unwire()` runs `uninstall()` (strip ONLY Honeycomb's hooks,
 * unlink an emptied config — reversible). This module just routes the health-driven auto-wire
 * onto the existing connector rules.
 *
 * `src/notifications` imports `src/connectors` (both NON_DAEMON_ROOTS); neither opens DeepLake,
 * so the thin-client invariant holds.
 */

import type { HarnessConnector } from "../connectors/index.js";
import { type AutoWiring } from "./contracts.js";

/** The deps the auto-wiring engine is built with (D-4). */
export interface AutoWiringDeps {
	/**
	 * The 019a connector to delegate to (D-4). The auto-wire targets the Cursor harness in 020c's
	 * context, but the engine is connector-agnostic: it calls `install()`/`uninstall()` and reports
	 * whether the config changed. Injected so a test drives it against a connector backed by a
	 * `FakeFs` (the 019a `createFakeFs`).
	 */
	readonly connector: HarnessConnector;
}

/**
 * Build the {@link AutoWiring} engine (FR-9 / D-4). `wire()` → `connector.install()` and returns
 * its `wroteConfig` (FALSE on the idempotent no-op → an unchanged config is never rewritten and
 * the fingerprint is stable, d-AC-6); `unwire()` → `connector.uninstall()` (reversible). No
 * forked merge logic — every foreign-preserve / idempotency / reversibility rule is the 019a
 * engine's (D-4).
 */
export function createAutoWiring(deps: AutoWiringDeps): AutoWiring {
	return {
		async wire(): Promise<boolean> {
			const result = await deps.connector.install();
			return result.wroteConfig;
		},
		async unwire(): Promise<void> {
			await deps.connector.uninstall();
		},
	};
}
