/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

/**
 * PRD-006d F-2 — the daemon's in-memory plugin-enabled status holder (Tier 2).
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 * `GET /api/diagnostics/harnesses` reports a `pluginEnabled` flag per harness (d-AC-1). The ONLY
 * legal producer of that value is `isPluginEnabled` (Tier 4, which shells `claude plugin list`),
 * and the 006b reconcile that computes it runs in the CLI process, NOT the daemon (Tier 2, which
 * MUST NOT import Tier 4 nor spawn `claude`). So the daemon cannot derive plugin-enabled itself.
 *
 * This holder is the tier-legal cross-process handoff target: the Tier-4 reconcile POSTs the
 * computed per-harness set over loopback (see `harness-status-ingest.ts`), the ingest route writes
 * it HERE, and `mountHarnessApi`'s injected `resolvePluginEnabled` seam reads it back. The daemon
 * only ever CALLS the getter; it never computes the value.
 *
 * ── FR-8: in-memory ONLY ─────────────────────────────────────────────────────
 * The set lives purely in process memory — no Deeplake, no JSON/JSONL sidecar. Before the first
 * push the set is empty, so every harness reads `pluginEnabled: false` (the honest last-known
 * picture). It holds canonical harness ids ONLY — never a token, header, or path.
 */

/** A tiny process-local holder for the current per-harness plugin-enabled set (ids only, FR-8). */
export interface HarnessPluginStatusHolder {
	/**
	 * Replace the current enabled set with `enabled` (canonical harness ids only). Non-string /
	 * empty entries are dropped so a malformed push can never poison the set.
	 */
	set(enabled: Iterable<string>): void;
	/** The current per-harness plugin-enabled set (ids only). Empty until the first push. */
	get(): ReadonlySet<string>;
}

/**
 * Build an in-memory {@link HarnessPluginStatusHolder}. The set starts EMPTY (fail-soft honest
 * default → `pluginEnabled: false` for every harness until the first reconcile push lands). Never
 * touches disk or Deeplake (FR-8); holds ids only (no secret/path).
 */
export function createHarnessPluginStatusHolder(): HarnessPluginStatusHolder {
	let enabled: ReadonlySet<string> = new Set<string>();
	return {
		set(next: Iterable<string>): void {
			const cleaned = new Set<string>();
			for (const id of next) {
				if (typeof id === "string" && id.length > 0) cleaned.add(id);
			}
			enabled = cleaned;
		},
		get(): ReadonlySet<string> {
			return enabled;
		},
	};
}
