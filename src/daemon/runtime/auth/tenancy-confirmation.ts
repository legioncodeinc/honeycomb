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
 * The confirmed-tenancy read model — PRD-073c (the capture-gate tie + the dashboard/CLI marker).
 *
 * ── What "confirmed" means (parent AC-5 / AC-9) ──────────────────────────────
 * honeycomb must not write capture data until the user has EXPLICITLY said which org and
 * workspace it goes to. The confirmation state is derived from the SHARED
 * `~/.deeplake/credentials.json` (via {@link loadDiskCredentials}, which never throws):
 *
 *   - CONFIRMED when a usable credential exists (a non-empty `orgId`). This covers BOTH the
 *     explicit link-time selection (which stamps {@link DiskCredentials.tenancyConfirmedAt}) AND
 *     a pre-073 credential minted by the old silent `orgs[0]` pick (grandfathered on upgrade —
 *     AC-5, the "existing installs unchanged" requirement).
 *   - UNCONFIRMED when NO credential file exists. A two-phase link (073c) persists NOTHING until
 *     the explicit selection, so during the pending window the credential is absent and capture is
 *     gated with `tenancy_unconfirmed` regardless of folder bindings (AC-9).
 *
 * The `tenancyConfirmedAt` marker is the EXPLICIT-selection evidence surfaced on `/api/auth/status`
 * (so the dashboard header can show "org X / workspace Y (confirmed)") and distinguishes an
 * explicitly-selected credential from a grandfathered one — but for the GATE both read as confirmed.
 *
 * ── No secret (D-4) ──────────────────────────────────────────────────────────
 * This module reads the credential's IDENTITY fields only (org id + the marker timestamp). It never
 * returns, logs, or echoes the bearer token — the raw disk read stays inside {@link loadDiskCredentials}.
 */

import { loadDiskCredentials } from "./credentials-store.js";

/** Inputs to {@link resolveTenancyConfirmation} — all injectable so tests never touch the real home. */
export interface TenancyConfirmationDeps {
	/** Override the SHARED `~/.deeplake` credentials dir (tests point this at a temp HOME). */
	readonly credentialsDir?: string;
	/** Override the legacy `~/.honeycomb` read-fallback dir (tests). */
	readonly legacyCredentialsDir?: string;
	/** The env the `HONEYCOMB_TOKEN` rule reads (defaults to `process.env`). */
	readonly env?: NodeJS.ProcessEnv;
}

/** The resolved confirmation state (metadata only — never a token). */
export interface TenancyConfirmation {
	/** True when a usable credential exists (explicit marker OR grandfathered non-empty orgId). */
	readonly confirmed: boolean;
	/** The explicit-selection marker timestamp, present ONLY when a link-time selection stamped it. */
	readonly confirmedAt?: string;
	/** True when confirmation is by grandfathering (a credential with an orgId but no marker). */
	readonly grandfathered: boolean;
}

/**
 * Resolve the confirmed-tenancy state from the persisted credential (PRD-073c). NEVER throws — a
 * missing/malformed credential resolves to `{ confirmed: false }` ({@link loadDiskCredentials}
 * returns `null` fail-soft). A credential with a non-empty `orgId` is confirmed; the marker (when
 * present) is surfaced as `confirmedAt` and marks the confirmation as explicit rather than
 * grandfathered.
 */
export function resolveTenancyConfirmation(deps: TenancyConfirmationDeps = {}): TenancyConfirmation {
	const disk = loadDiskCredentials(deps.credentialsDir, deps.env ?? process.env, deps.legacyCredentialsDir);
	if (disk === null || disk.orgId.length === 0) {
		return { confirmed: false, grandfathered: false };
	}
	const marker =
		typeof disk.tenancyConfirmedAt === "string" && disk.tenancyConfirmedAt.length > 0
			? disk.tenancyConfirmedAt
			: undefined;
	return marker !== undefined
		? { confirmed: true, confirmedAt: marker, grandfathered: false }
		: { confirmed: true, grandfathered: true };
}

/**
 * The boolean seam 073a's capture gate consumes (parent AC-9). `true` when tenancy is confirmed
 * (explicit marker or grandfathered orgId), `false` for the pending/absent-credential state. A thin
 * wrapper over {@link resolveTenancyConfirmation} so the capture handler takes a `() => boolean` dep.
 */
export function isTenancyConfirmed(deps: TenancyConfirmationDeps = {}): boolean {
	return resolveTenancyConfirmation(deps).confirmed;
}
