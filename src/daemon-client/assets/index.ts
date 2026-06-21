/**
 * Asset-sync thin-client barrel — PRD-033c (the consume/install half).
 *
 * One import surface for the storage-client-free install subsystem. Everything here
 * lives under `src/daemon-client/` and reaches the `synced_assets` table ONLY through
 * the daemon's `/api/assets` endpoints over loopback HTTP (D-6) — the thin-client
 * invariant test proves no DeepLake path is imported. 033b's CLI consumes
 * `createLoopbackAssetSyncApi` + `pullAndInstall` from here.
 */

export {
	type AssetAdapter,
	type AssetScope,
	type AssetSyncApi,
	type DecideInstallInput,
	type HarnessRootResolver,
	IDENTITY_ADAPTER,
	type InstallAction,
	type LatticeCell,
	type PublishRequest,
	type PublishResponse,
	type PulledAsset,
	type PullAndInstallDeps,
	type PullRequest,
	type PullResponse,
	type Style,
	type SyncedAssetType,
	type TombstoneRequest,
	type TombstoneResponse,
} from "./contracts.js";

export {
	ASSET_AUTOPULL_DISABLED_ENV,
	ASSET_AUTOPULL_TIMEOUT_MS,
	ASSETS_API_BASE,
	type AssetAutoPullDeps,
	autoPull,
	createDefaultHarnessRoots,
	createLoopbackAssetSyncApi,
	decideInstall,
	type InstallOutcome,
	pullAndInstall,
	resolveContainedDir,
} from "./install.js";
