/**
 * Tail the local incident log for the `logs` command (PRD-064f Scope).
 *
 * Reads the last N lines of `incidents.ndjson` from HiveDoctor's workspace dir. The
 * file is append-only NDJSON written by src/incidents.ts; this reader is read-only and
 * defensive: a missing file (no incidents yet) resolves to an empty list, never a throw.
 *
 * It does NOT parse/validate each line - `logs` shows the raw NDJSON so an operator sees
 * exactly what was recorded. Built-ins only: node:fs + node:path. Fail-soft.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { TailIncidentsFn } from "./context.js";

/** Build a {@link TailIncidentsFn} bound to a workspace dir. */
export function createIncidentsTail(workspaceDir: string): TailIncidentsFn {
	const filePath = join(workspaceDir, "incidents.ndjson");
	return async (limit: number): Promise<readonly string[]> => {
		const n = Number.isInteger(limit) && limit > 0 ? limit : 20;
		try {
			const raw = readFileSync(filePath, "utf8");
			const lines = raw.split("\n").filter((l) => l.trim() !== "");
			return lines.slice(-n);
		} catch {
			// Missing file (no incidents) or unreadable dir: nothing to show.
			return [];
		}
	};
}
