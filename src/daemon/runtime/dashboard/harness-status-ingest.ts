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
 * PRD-006d F-2 — the daemon plugin-enabled INGEST route (Tier 2).
 *
 * ── What this is ─────────────────────────────────────────────────────────────
 * A single loopback, LOCAL-MODE-ONLY POST route the Tier-4 harness reconcile calls after each
 * cycle so the daemon serves REAL plugin-enabled state at `GET /api/diagnostics/harnesses` (F-2 /
 * d-AC-1). It attaches onto the ALREADY-MOUNTED, protected `/api/diagnostics` group — mirroring
 * {@link import("../projects/scope-switch-api.js").mountScopeSwitchApi} and
 * {@link import("../projects/sync-api.js").mountProjectsSyncApi} EXACTLY: ZERO `server.ts` edits,
 * inheriting the group's auth/RBAC.
 *
 *   POST /api/diagnostics/harness-status  { harnesses: [{ harness, pluginEnabled }] }
 *     → write the enabled ids into the in-memory {@link HarnessPluginStatusHolder} + ack.
 *
 * ── Tier-legal cross-process handoff (LOAD-BEARING) ──────────────────────────
 * The daemon (Tier 2) cannot import `isPluginEnabled` (Tier 4) nor spawn `claude`, and the 006b
 * reconcile that computes plugin-enabled runs in the CLI process. This route is the ingest side of
 * the tier-legal handoff: Tier 4 → daemon over HTTP (legal, like every thin client). It writes an
 * in-memory holder (FR-8: no Deeplake, no sidecar); `mountHarnessApi`'s `resolvePluginEnabled` seam
 * reads it back.
 *
 * ── Local-mode only + fail-soft + no secret (D-4 / security F-1) ─────────────
 * Plugin-enabled is local-machine state, so a non-local request 404s (self-gated, like
 * `scope-switch-api`). The body carries ids + booleans ONLY — never a token, header, or path — and
 * the ack echoes only a count. A malformed body is a clean 400 (the holder is left untouched); the
 * handler NEVER 500s.
 */

import type { Context } from "hono";

import { z } from "zod";

import type { DeploymentMode } from "../config.js";
import type { Daemon } from "../server.js";
import type { HarnessPluginStatusHolder } from "./harness-plugin-status.js";

/** The already-mounted, protected route group the ingest attaches to (no `server.ts` edit). */
export const HARNESS_STATUS_INGEST_GROUP = "/api/diagnostics" as const;

/** `POST /api/diagnostics/harness-status` — the reconcile → daemon plugin-enabled ingest. */
export const HARNESS_STATUS_INGEST_PATH = "/harness-status" as const;

/** The ack the ingest returns: whether the push was accepted + how many harnesses read enabled. NO secret. */
export interface HarnessStatusIngestAck {
	/** True when the push was accepted and the holder was written. */
	readonly accepted: boolean;
	/** The number of harnesses now marked plugin-enabled (ids only never leave the daemon). */
	readonly enabledCount: number;
	/** A short machine reason on a rejected push (a malformed body); carries no token/secret. */
	readonly reason?: string;
}

/** Options for {@link mountHarnessStatusIngestApi}. */
export interface MountHarnessStatusIngestOptions {
	/** The in-memory holder the ingest writes (the SAME instance `mountHarnessApi` reads). */
	readonly holder: HarnessPluginStatusHolder;
}

/**
 * zod boundary for the ingest body: a per-harness plugin-enabled list. Ids + booleans only, so no
 * secret/path can ever ride the body (by construction — there is no field that could carry one).
 */
const HarnessStatusIngestBodySchema = z.object({
	harnesses: z.array(
		z.object({
			harness: z.string().min(1),
			pluginEnabled: z.boolean(),
		}),
	),
});

/** Read a JSON body defensively; a non-JSON body → `undefined` (the handler 400s). */
async function readJsonBody(c: Context): Promise<unknown> {
	try {
		return await c.req.json();
	} catch {
		return undefined;
	}
}

/**
 * Attach the plugin-enabled ingest route onto the daemon's already-mounted, protected
 * `/api/diagnostics` group (F-2). Registers `POST /harness-status`, self-gated to LOCAL mode (a
 * non-local request 404s), zod-validated at the boundary, writing the injected in-memory holder.
 * Call ONCE after `createDaemon(...)`. If the group is not mounted (unknown daemon shape) the attach
 * is a no-op. Always a clean 200/400/404 ack — never a 500 (fail-soft).
 */
export function mountHarnessStatusIngestApi(daemon: Daemon, options: MountHarnessStatusIngestOptions): void {
	const group = daemon.group(HARNESS_STATUS_INGEST_GROUP);
	if (group === undefined) return;
	const mode: DeploymentMode = daemon.config.mode;
	const notLocal = (): boolean => mode !== "local";

	group.post(HARNESS_STATUS_INGEST_PATH, async (c) => {
		// Plugin-enabled is local-machine state — a non-local request never reaches the holder.
		if (notLocal()) return c.json({ error: "not_found" }, 404);
		const parsed = HarnessStatusIngestBodySchema.safeParse(await readJsonBody(c));
		if (!parsed.success) {
			// Fail-soft: a malformed body is a clean 400; the holder is left untouched (never a 500).
			const ack: HarnessStatusIngestAck = { accepted: false, enabledCount: 0, reason: "invalid request body" };
			return c.json(ack, 400);
		}
		const enabled = parsed.data.harnesses.filter((h) => h.pluginEnabled).map((h) => h.harness);
		options.holder.set(enabled);
		const ack: HarnessStatusIngestAck = { accepted: true, enabledCount: enabled.length };
		return c.json(ack, 200);
	});
}
