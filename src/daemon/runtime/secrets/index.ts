/**
 * Secrets subsystem barrel — PRD-012. The single import surface for the secrets
 * contracts + seams, the machine-bound crypto, the `.secrets/` store + the real
 * SecretResolver, the names-only API, and the 012b exec stub.
 *
 * Wave 1 (012a) exports the FULL store + crypto + names-only API + audit + the real
 * resolver + the seams (MachineKeyProvider / VaultProvider). Wave 2 (012b) fills exec.ts.
 *
 * The whole module is built around ONE invariant: an agent can cause a secret to be USED
 * but NEVER receives a decrypted value. Read CONVENTIONS.md before extending it.
 */

// ── Contracts + seams ────────────────────────────────────────────────────────
export {
	type MachineKeyProvider,
	type SecretName,
	type SecretOp,
	type SecretOutcome,
	type SecretRecord,
	type SecretScope,
	type SecretsAuditEvent,
	type VaultProvider,
	MACHINE_KEY_DIR_NAME,
	MACHINE_KEY_FILE_NAME,
	MAX_SECRET_NAME_LENGTH,
	SECRET_OPS,
	SECRET_OUTCOMES,
	asSecretName,
	createFakeMachineKeyProvider,
	createFakeVaultProvider,
	hostnameUserFallbackId,
	isSecretRecord,
	isValidSecretName,
	notImplemented,
} from "./contracts.js";

// ── Machine-bound crypto ─────────────────────────────────────────────────────
export {
	type DecryptResult,
	type Encrypted,
	KEY_BYTES,
	NONCE_BYTES,
	decrypt,
	deriveKey,
	encrypt,
} from "./crypto.js";

// ── The `.secrets/` store + the real SecretResolver ──────────────────────────
export {
	type SecretsClock,
	type SecretsStoreDeps,
	type StoreFailure,
	type ValueResult,
	type WriteResult,
	AUDIT_FILE_NAME,
	DAEMON_DIR_NAME,
	SECRET_DIR_MODE,
	SECRET_FILE_MODE,
	SECRETS_DIR_NAME,
	SecretsStore,
	createMachineKeyProvider,
	createSecretResolver,
	machineKeyFilePath,
	modeOf,
	scopeSegment,
	systemSecretsClock,
} from "./store.js";

// ── The names-only API ───────────────────────────────────────────────────────
export {
	type ScopeResolver,
	type SecretsApiDeps,
	SECRETS_GROUP,
	headerScopeResolver,
	mountSecretsApi,
} from "./api.js";

// ── 012b secret_exec (bounded pool + spawn + redaction + timeout + vault refs) ─
export {
	type ExecAuditEvent,
	type ExecAuditOp,
	type ExecAuditSink,
	type ExecClock,
	type ExecJobView,
	type ExecStatus,
	type SecretExecRequest,
	type SecretExecRunnerDeps,
	type Spawner,
	type SubmitResult,
	DEFAULT_EXEC_TIMEOUT_MS,
	DEFAULT_MAX_QUEUE,
	DEFAULT_POOL_SIZE,
	EXEC_AUDIT_OPS,
	EXEC_STATUSES,
	KILL_GRACE_MS,
	MAX_EXEC_TIMEOUT_MS,
	MIN_EXEC_TIMEOUT_MS,
	REDACTED,
	RollingRedactor,
	SecretExecRunner,
	clampTimeout,
	createSecretExecRunner,
	noopExecAuditSink,
	redactAll,
	systemExecClock,
	systemSpawner,
} from "./exec.js";
