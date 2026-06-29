/**
 * Protected local queue upgrade diagnostics for PRD-066e.
 */

import type { Daemon } from "./server.js";
import type {
	BuildLocalQueueUpgradeDiagnosticsOptions,
	LocalQueueUpgradeDiagnostics,
} from "./services/local-queue-diagnostics.js";
import { buildLocalQueueUpgradeDiagnostics } from "./services/local-queue-diagnostics.js";

export const LOCAL_QUEUE_DIAGNOSTICS_GROUP = "/api/diagnostics" as const;
export const LOCAL_QUEUE_DIAGNOSTICS_PATH = "/local-queue" as const;

export type MountLocalQueueDiagnosticsOptions = BuildLocalQueueUpgradeDiagnosticsOptions & {
	readonly diagnostics?: () => Promise<LocalQueueUpgradeDiagnostics>;
};

export function mountLocalQueueDiagnosticsApi(daemon: Daemon, options: MountLocalQueueDiagnosticsOptions): void {
	const group = daemon.group(LOCAL_QUEUE_DIAGNOSTICS_GROUP);
	if (group === undefined) return;

	group.get(LOCAL_QUEUE_DIAGNOSTICS_PATH, async (c) => {
		const body =
			options.diagnostics === undefined ? await buildLocalQueueUpgradeDiagnostics(options) : await options.diagnostics();
		return c.json(body);
	});
}
