/**
 * Asset-sync substrate barrel — PRD-033. One import surface for the substrate so
 * a consumer (the daemon worker assembly, the 033b/033c Wave-2 Bees, the tests)
 * reaches the shared contracts, the registry/identity/device/hashing/projectKey/
 * lattice foundation, and the Wave-2 stubs from one place.
 *
 * Wave 1 (033a) is FULL for: the shared CONTRACTS (publish/pull/tombstone shapes +
 * the `AssetAdapter` seam + `audienceMatches`), the registry store, identity
 * (honeycomb_id + frontmatter), device identity, hashing (merkle/content + the 3
 * recorded hashes), `projectKey`, and the tier×style state machine. The lifecycle
 * (`lifecycle.ts`, 033b) and the sync engine (`sync.ts`, 033c) are HONEST STUBS the
 * Wave-2 Bees fill — they throw `not-implemented` with the owning sub-PRD.
 */

// ── Shared contracts (the pinned Wave-2 surface) ──
export {
	type AssetAdapter,
	type AssetScope,
	type AssetSyncApi,
	type AudienceContext,
	audienceMatches,
	type AudiencePredicate,
	IDENTITY_ADAPTER,
	type LatticeCell,
	type PublishRequest,
	type PublishResponse,
	type PulledAsset,
	type PullRequest,
	type PullResponse,
	STYLES,
	type Style,
	SYNCED_ASSET_TYPES,
	type SyncedAssetType,
	TIERS,
	type Tier,
	type TombstoneRequest,
	type TombstoneResponse,
} from "./contracts.js";

// ── Registry — `.honeycomb/registry.json` SoT (FULL) ──
export {
	type AssetRegistryStore,
	createAssetRegistryStore,
	defaultRegistryBaseDir,
	type PulledManifest,
	PulledManifestSchema,
	type RegistryEntry,
	RegistryEntrySchema,
} from "./registry.js";

// ── Identity — honeycomb_id + frontmatter (FULL) ──
export {
	HONEYCOMB_ID_KEY,
	HONEYCOMB_ID_PREFIX,
	isHoneycombId,
	mintHoneycombId,
	parseHoneycombId,
	resolveHoneycombId,
	stampHoneycombId,
} from "./identity.js";

// ── Device identity (FULL) ──
export {
	addDeviceToSet,
	type DeviceClock,
	deviceFilePath,
	deviceInSet,
	type DeviceRecord,
	type DeviceStoreOptions,
	honeycombHomeDir,
	loadOrCreateDevice,
} from "./device.js";

// ── Hashing — merkle/content + 3 recorded hashes (FULL) ──
export {
	type FileEntry,
	hashAgentFile,
	hashArtifact,
	hashSkillDir,
	sha256,
	type TripleHash,
	tripleHash,
} from "./hashing.js";

// ── projectKey (FULL) ──
export {
	defaultGitRemoteReader,
	type GitRemoteReader,
	projectKey,
	sanitizeKeySegment,
} from "./project-key.js";

// ── Tier × style lattice state machine (FULL) ──
export {
	ALL_CELLS,
	cellLabel,
	isLatticeCell,
	isLegalTransition,
	isStyle,
	isTier,
	isUnmanaged,
	sameCell,
	TIER_RANK,
	type TierDirection,
	tierDirection,
} from "./lattice.js";

// ── 033b lifecycle + CLI (FULL — typescript-node-worker-bee) ──
export {
	type AssetLifecycleDeps,
	notImplemented,
	registerAsset,
	type RegisterAssetInput,
	transitionAsset,
	type TransitionAssetInput,
	TransitionError,
	type TransitionResult,
} from "./lifecycle.js";

// ── 033c sync engine + daemon API (IMPLEMENTED — deeplake-dataset-worker-bee) ──
export {
	type AssetSyncEngineDeps,
	buildPullSql,
	createAssetSyncApi,
	defaultAssetTarget,
	highestPerId,
	type TrustedTableProbe,
} from "./sync.js";
export { ASSETS_GROUP, type AssetsApiDeps, mountAssetsApi, mountAssetsGroup } from "./api.js";
