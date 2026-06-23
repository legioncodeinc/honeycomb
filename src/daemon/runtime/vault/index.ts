/**
 * Vault subsystem barrel — PRD-032. The single import surface for the multi-class
 * machine-bound vault: the record-class contracts + registry, the `(class, scope, name)`
 * store (reusing the PRD-012 crypto/machine-key/perms verbatim), the COPY-not-move
 * DeepLake-creds migration + the vault→env→file resolver, the curated provider→model
 * catalog, and the `/api/settings` mount.
 *
 * Wave 1 (032a) exports the FULL vault core + the settings API + the catalog. Wave 2
 * consumes these: 032b (CLI) + 032c (dashboard) reach `/api/settings` + the catalog; 032d
 * (wire-back) reads the vault for provider/model/pollinating + resolves the DeepLake token.
 *
 * The whole module is built on ONE invariant carried from PRD-012: an agent can CAUSE a
 * `secret` to be USED but NEVER receives a decrypted value. A `setting` IS daemon-readable.
 * The registry enforces the boundary as DATA. Read CONVENTIONS.md before extending it.
 */

// ── Contracts + the record-class type system ─────────────────────────────────
export {
	asRecordClass,
	asSecretName,
	BUILTIN_RECORD_CLASSES,
	type BuiltinRecordClass,
	type ClassDescriptor,
	type MachineKeyProvider,
	READ_POSTURES,
	type ReadPosture,
	type RecordClass,
	type SecretName,
	type SecretScope,
	VAULT_OPS,
	VAULT_OUTCOMES,
	type VaultAuditEvent,
	type VaultOp,
	type VaultOutcome,
} from "./contracts.js";

// ── The record-class registry (policy as data) ───────────────────────────────
export {
	type DescriptorResult,
	type RegistryFailure,
	SECRET_CLASS,
	SECRET_DESCRIPTOR,
	SecretValueSchema,
	SETTING_CLASS,
	SETTING_DESCRIPTOR,
	type SettingValue,
	SettingValueSchema,
	VaultRegistry,
	createVaultRegistry,
} from "./registry.js";

// ── The multi-class store ────────────────────────────────────────────────────
export {
	type SettingResult,
	VAULT_AUDIT_FILE_NAME,
	VAULT_DIR_NAME,
	type VaultFailure,
	VaultStore,
	type VaultStoreDeps,
	type VaultValueResult,
	type VaultWriteResult,
} from "./store.js";

// ── The DeepLake-creds migration + the vault→env→file resolver ───────────────
export {
	DEEPLAKE_TOKEN_NAME,
	type DeeplakeCredsReader,
	type MigrateResult,
	migrateDeeplakeToken,
	resolveDeeplakeToken,
	systemDeeplakeCredsReader,
} from "./migrate.js";

// ── The curated provider→model catalog (D-6) ─────────────────────────────────
export {
	asProvider,
	catalogView,
	defaultModelFor,
	isValidProviderModel,
	PROVIDER_CATALOG,
	PROVIDERS,
	type Provider,
	type ProviderEntry,
	providerEntry,
} from "./catalog.js";

// ── The `/api/settings` mount ────────────────────────────────────────────────
export {
	DASHBOARD_PREF_PREFIX,
	isKnownSettingKey,
	KNOWN_SETTING_KEYS,
	mountSettingsApi,
	mountSettingsGroup,
	SETTINGS_GROUP,
	type SettingsApiDeps,
} from "./api.js";
