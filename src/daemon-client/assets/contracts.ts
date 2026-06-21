/**
 * Asset-sync thin-client contracts + seams — PRD-033c (the consume/install half).
 *
 * ── THE THESIS (D-6 / the thin-client invariant) ────────────────────────────
 *   THE THIN CLIENT NEVER OPENS DEEPLAKE. It reaches the `synced_assets` table ONLY
 *   through the daemon's `/api/assets` endpoints over loopback HTTP (the
 *   {@link AssetSyncApi} the daemon implements), and it touches the local filesystem to
 *   install/retract the native artifact. So — exactly like `src/daemon-client/skillify/`
 *   and `src/daemon-client/vfs/` — this subsystem lives under `src/daemon-client/`, a
 *   NON-daemon root the invariant test scans: a stray `daemon/storage/client` import
 *   would fail the build. The ONLY way out to storage is the loopback
 *   {@link AssetSyncApi} (`createLoopbackAssetSyncApi`), which POSTs to the daemon.
 *
 * What is OK to import (pure, storage-free): the SHARED Wave-1 contracts
 * (`daemon/runtime/assets/contracts.js` — the publish/pull/tombstone shapes, the
 * `AssetAdapter` seam + `IDENTITY_ADAPTER`) and nothing under `daemon/storage`.
 *
 * ── What this module declares ────────────────────────────────────────────────
 *   - {@link HarnessRootResolver} — maps a `(harness, style)` to the install root
 *     (Repository = project-local `.claude/skills`; User = global `~/.claude/skills`),
 *     reporting `null` for a non-matching/uninstalled harness (so a row installs ONLY
 *     onto a matching harness, c-AC-3). Injectable so a test points the roots at a temp dir.
 *   - {@link PullAndInstallDeps} — the seams `pullAndInstall` runs against.
 *   - {@link InstallAction} + {@link DecideInstallInput} — the last-writer-wins policy
 *     verdict (mirrors skillify `decideAction`, c-AC-2 / FR-5).
 */

import {
	type AssetAdapter,
	type AssetScope,
	type AssetSyncApi,
	type Style,
	type SyncedAssetType,
} from "../../daemon/runtime/assets/contracts.js";

// Re-export the shared shapes a thin-client consumer needs from ONE place (the seam),
// so 033b's CLI and the tests import the contract + the loopback API from here.
export {
	type AssetAdapter,
	type AssetScope,
	type AssetSyncApi,
	IDENTITY_ADAPTER,
	type LatticeCell,
	type PublishRequest,
	type PublishResponse,
	type PulledAsset,
	type PullRequest,
	type PullResponse,
	type Style,
	type SyncedAssetType,
	type TombstoneRequest,
	type TombstoneResponse,
} from "../../daemon/runtime/assets/contracts.js";

// ─────────────────────────────────────────────────────────────────────────────
// HarnessRootResolver SEAM — the `(harness, style)` → install root map (c-AC-3 / FR-3).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Resolve where a native artifact installs, per harness + style (c-AC-3 / FR-3). A row
 * keyed `(skill, claude_code)` installs ONLY under the Claude Code skills root, and so
 * on — an artifact NEVER lands on a non-matching harness. The `Repository` style maps
 * onto the project-local root (cwd `.claude/skills`), `User` onto the global root
 * (`~/.claude/skills`); the same split skillify uses for project-vs-global installs.
 *
 * Detection is INJECTABLE so a test points the roots at temp dirs (no real `~`/cwd
 * writes). In production {@link createDefaultHarnessRoots} discovers the per-harness
 * roots under the user's home + the project dir.
 */
export interface HarnessRootResolver {
	/**
	 * The install root for a `(harness, assetType, style)` triple, or `null` when this
	 * harness is NOT installed / not matching (so the artifact is skipped, c-AC-3). The
	 * returned path is the DIRECTORY the artifact's contained path is resolved under (the
	 * path-safety containment floor in `install.ts` validates the contained path stays
	 * inside it).
	 */
	rootFor(harness: string, assetType: SyncedAssetType, style: Style): string | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// InstallAction — the last-writer-wins policy verdict (c-AC-2 / FR-5).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a pull should DO with one remote artifact, resolved by `decideInstall`
 * (c-AC-2 / FR-5) — mirrors skillify's `decideAction`:
 *
 *   - `write`         the local artifact is ABSENT → write it (no backup needed).
 *   - `backup-write`  the remote VERSION is newer than the local copy (or `--force`),
 *                     AND the local copy is hash-divergent → back up to `.bak`, then write.
 *   - `skip`          the remote is at-or-older than local and not forced → touch nothing
 *                     (the idempotent no-op, c-AC-6).
 */
export type InstallAction = "write" | "backup-write" | "skip";

/** The inputs `decideInstall` resolves an {@link InstallAction} from (c-AC-2 / FR-5). */
export interface DecideInstallInput {
	/** True when a local artifact already exists at the resolved install path. */
	readonly localExists: boolean;
	/** The local artifact's recorded version, or `null` when absent/unknown. */
	readonly localVersion: number | null;
	/** The local artifact's content hash, or `null` when absent/unreadable. */
	readonly localHash: string | null;
	/** The remote artifact's version. */
	readonly remoteVersion: number;
	/** The remote artifact's content hash. */
	readonly remoteHash: string;
	/** The `--force` flag: re-write even when remote is not newer (backs up first). */
	readonly force: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// PullAndInstallDeps — the seams `pullAndInstall` runs against.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The injectable seams a {@link pullAndInstall} runs against (storage-free defaults).
 * The whole point of the seam set is that a test drives the full install/retract path
 * against a FAKE loopback API + temp dirs, with no daemon and no real `~`/cwd.
 */
export interface PullAndInstallDeps {
	/** The loopback {@link AssetSyncApi} — the ONLY path to the daemon (D-6). */
	readonly api: AssetSyncApi;
	/** Where each `(harness, style)` artifact installs (c-AC-3 / FR-3). */
	readonly roots: HarnessRootResolver;
	/** The render/parse adapter (v1: the IDENTITY adapter, c-AC-4). */
	readonly adapter?: AssetAdapter;
	/** The pull scope (org/workspace/author/deviceId) the daemon selects the audience for. */
	readonly scope: AssetScope;
	/** Restrict to a single style (project-local vs global), or undefined for both. */
	readonly style?: Style;
	/** Re-write even when remote is not newer (backs up first) — `--force` (FR-5). */
	readonly force?: boolean;
	/** Report-only mode — touch NOTHING on disk (mirrors skillify `--dry-run`). */
	readonly dryRun?: boolean;
}
