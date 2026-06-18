/**
 * Secrets contracts + seams — PRD-012a (Wave 1, the secrets subsystem).
 *
 * The central thesis (the security audit's first target, EXECUTION_LEDGER D-1..D-8):
 *
 *   AN AGENT CAN CAUSE A SECRET TO BE USED BUT MUST NEVER RECEIVE A DECRYPTED VALUE.
 *
 * So every contract in this module is shaped so a value CANNOT leak by construction:
 *   - A {@link SecretName} is a validated, traversal-proof token: a name can never
 *     escape `.secrets/` (no `/`, `\`, `.`, `..`, NUL, or path separators).
 *   - A {@link SecretRecord} is the ON-DISK shape: `{ nonce, ciphertext, createdAt,
 *     scope }`. There is NO plaintext field anywhere — the cleartext value exists
 *     only transiently inside {@link "./crypto.js"}'s `decrypt` return, consumed by
 *     the internal resolver, never persisted.
 *   - A {@link SecretsAuditEvent} carries name + op + scope + ts + outcome. It has NO
 *     value field — redaction by construction, exactly like PRD-010's
 *     `RedactedRoutingEvent`.
 *
 * The encryption is bound to the host machine through the {@link MachineKeyProvider}
 * SEAM: a derived key depends on a stable machine identifier, so copying `.secrets/`
 * to another host yields a DIFFERENT key and the Poly1305 tag fails to verify
 * (a-AC-3). The seam is injectable so the "different host" test swaps a different
 * provider; the fake is {@link createFakeMachineKeyProvider}.
 *
 * The {@link VaultProvider} SEAM (Bitwarden / 1Password by reference) is stubbed this
 * wave; PRD-012b fills the real provider. The fake is here so 012b's resolver-by-
 * reference can be tested without vault credentials in this environment.
 */

import { homedir, hostname, userInfo } from "node:os";

// ─────────────────────────────────────────────────────────────────────────────
// SecretName — a traversal-proof secret identifier (FR-2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The safe character class for a secret name: letters, digits, `_`, `.`, `-`. NOTE
 * the `.` is allowed for readable names like `openai.key`, but a NAME equal to `.`
 * or `..`, or one containing a path separator, is rejected by {@link isValidSecretName}
 * so a name can NEVER be used to escape the `.secrets/` directory.
 */
const SECRET_NAME_PATTERN = /^[A-Za-z0-9_.-]+$/;

/**
 * The maximum secret-name length. Bounded so a pathological name cannot create an
 * absurd path or be used as a denial vector.
 */
export const MAX_SECRET_NAME_LENGTH = 128;

/**
 * A validated secret name (a branded string). The ONLY way to obtain one is through
 * {@link asSecretName}, which rejects anything that is not a safe, non-traversing
 * token — so once you hold a `SecretName`, it is safe to use as a path segment.
 */
export type SecretName = string & { readonly __brand: "SecretName" };

/**
 * Validate a candidate secret name (fail-closed). Returns `true` ONLY for a non-empty,
 * length-bounded `[A-Za-z0-9_.-]+` token that is not `.` or `..` and contains no path
 * separator — so it can never traverse out of `.secrets/`.
 */
export function isValidSecretName(value: unknown): value is SecretName {
	if (typeof value !== "string") return false;
	if (value.length === 0 || value.length > MAX_SECRET_NAME_LENGTH) return false;
	// Reject the two filesystem-special names outright (they would resolve to a parent
	// or the dir itself even though they match the char class).
	if (value === "." || value === "..") return false;
	// Defense-in-depth: explicitly reject anything that looks like a separator or NUL
	// even though the positive pattern already excludes them.
	if (value.includes("/") || value.includes("\\") || value.includes("\0")) return false;
	return SECRET_NAME_PATTERN.test(value);
}

/**
 * Narrow a candidate to a {@link SecretName}, or return `null` if it is not a valid,
 * traversal-proof name. Callers MUST fail closed on `null` (reject the request); a
 * malformed name never reaches the filesystem.
 */
export function asSecretName(value: unknown): SecretName | null {
	return isValidSecretName(value) ? (value as SecretName) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// SecretScope — the org/workspace/agent partition (FR-8)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The scope a secret is partitioned under (FR-8 / a-AC-6). Mirrors the QueryScope /
 * Identity shape: org + workspace + an OPTIONAL agentId. Two agents in one workspace
 * are isolated by `agentId`, so one cannot list or delete another's secrets.
 *
 * The scope maps deterministically to a sub-directory under `.secrets/` AND is folded
 * into the derived key, so a secret stored under one scope cannot even be decrypted
 * under another.
 */
export interface SecretScope {
	/** The org partition. Required. */
	readonly org: string;
	/** The workspace partition. Required. */
	readonly workspace: string;
	/** The agent partition. Optional — when present, isolates per-agent (a-AC-6). */
	readonly agentId?: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// SecretRecord — the on-disk shape (NEVER a plaintext field) (FR-2 / FR-3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The on-disk encrypted secret record. This is the ENTIRE persisted shape — there is
 * deliberately NO plaintext / value field (FR-2 / FR-3). It holds:
 *   - `nonce`      — the random 24-byte XSalsa20 nonce (base64), one per write;
 *   - `ciphertext` — the XSalsa20-Poly1305 combined ciphertext+tag (base64);
 *   - `createdAt`  — the ISO write timestamp (evidence, stamped server-side);
 *   - `scope`      — the org/workspace/agent the secret belongs to (for read-back
 *                    validation that the file matches the requesting scope).
 *
 * A copy of this record off the host is undecryptable: the key derives from the host
 * machine identifier (a-AC-3). The combined-mode ciphertext carries its own Poly1305
 * tag, so a wrong key (or a tampered byte) fails authentication rather than yielding
 * garbage.
 */
export interface SecretRecord {
	/** The random 24-byte nonce for this write, base64-encoded. */
	readonly nonce: string;
	/** The XSalsa20-Poly1305 combined ciphertext (cipher bytes + 16-byte tag), base64. */
	readonly ciphertext: string;
	/** The ISO-8601 instant the secret was written (server-stamped). */
	readonly createdAt: string;
	/** The scope this secret is partitioned under (FR-8). */
	readonly scope: SecretScope;
}

/**
 * Validate a parsed object is a structurally-complete {@link SecretRecord} (fail-closed).
 * A partial / wrong-typed file is treated as malformed by the store (it surfaces a typed
 * failure, never a partial secret). NOTE there is no plaintext field to validate — by
 * construction the record cannot carry one.
 */
export function isSecretRecord(value: unknown): value is SecretRecord {
	if (typeof value !== "object" || value === null) return false;
	const r = value as Record<string, unknown>;
	if (typeof r.nonce !== "string" || typeof r.ciphertext !== "string" || typeof r.createdAt !== "string") {
		return false;
	}
	const scope = r.scope;
	if (typeof scope !== "object" || scope === null) return false;
	const s = scope as Record<string, unknown>;
	if (typeof s.org !== "string" || typeof s.workspace !== "string") return false;
	if (s.agentId !== undefined && typeof s.agentId !== "string") return false;
	return true;
}

// ─────────────────────────────────────────────────────────────────────────────
// SecretsAuditEvent — the NDJSON audit shape (redacted by construction) (FR-7)
// ─────────────────────────────────────────────────────────────────────────────

/** The audited secret operations (FR-7). `resolved_for_exec` is the internal decrypt op. */
export const SECRET_OPS = ["listed", "stored", "deleted", "resolved_for_exec"] as const;
/** A single audited secret operation. */
export type SecretOp = (typeof SECRET_OPS)[number];

/** The outcome of an audited secret op — enough to trace, never enough to leak. */
export const SECRET_OUTCOMES = ["ok", "denied", "not_found", "error"] as const;
/** A single audited outcome. */
export type SecretOutcome = (typeof SECRET_OUTCOMES)[number];

/**
 * The NDJSON audit event appended under `.daemon/` for EVERY secret op (FR-7 / a-AC-4).
 *
 * Redaction BY CONSTRUCTION (the PRD-010 `RedactedRoutingEvent` discipline): this
 * shape carries `name` + `op` + `scope` + `ts` + `outcome` and CANNOT hold a value —
 * there is no value/secret/plaintext field. A `listed` op records the COUNT, never the
 * names' values; a `stored` op records the name, never the secret. Enforced at the
 * WRITE boundary, not a read-time scrub.
 */
export interface SecretsAuditEvent {
	/** The op performed. */
	readonly op: SecretOp;
	/** The secret name the op targeted (a name is public; the VALUE never appears). For `listed`, omitted. */
	readonly name?: string;
	/** The scope the op ran under. */
	readonly scope: SecretScope;
	/** The ISO-8601 instant the op completed. */
	readonly ts: string;
	/** The outcome. */
	readonly outcome: SecretOutcome;
	/** For `listed`: how many names were returned (a count is not a value). */
	readonly count?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// MachineKeyProvider SEAM — the host-binding source (D-2 / FR-4 / a-AC-3)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The machine-binding SEAM (D-2). Yields a STABLE identifier for the host the daemon
 * runs on; the crypto module folds it into the derived key, so a `.secrets/` copy
 * moved to a different host derives a different key and fails to decrypt (a-AC-3 /
 * FR-9). Injectable so the "different host" test swaps a different provider — a
 * different id → a different key → Poly1305 auth failure.
 */
export interface MachineKeyProvider {
	/** Resolve the stable host identifier. Async because the real impl may read a file / spawn `ioreg`. */
	machineId(): Promise<string>;
}

/**
 * Build a FAKE {@link MachineKeyProvider} from a fixed id (tests). Two fakes with
 * DIFFERENT ids simulate two different hosts: the same `.secrets/` bytes decrypt under
 * one and FAIL under the other (a-AC-3). No real machine identifier is read.
 */
export function createFakeMachineKeyProvider(id: string): MachineKeyProvider {
	return {
		machineId(): Promise<string> {
			return Promise.resolve(id);
		},
	};
}

/**
 * The cross-platform fallback machine-key directory + file. A generate-once 32-byte
 * random key lives at `~/.honeycomb/.machine-key` (mode 0600) — OUTSIDE `.secrets/`,
 * so copying `.secrets/` ALONE yields nothing (the key file is not in it). This is the
 * fallback when no OS machine identifier is readable; the real provider's wiring lives
 * in {@link "./store.js"} (it needs `node:fs`), so this module only NAMES the location.
 */
export const MACHINE_KEY_DIR_NAME = ".honeycomb" as const;
/** The fallback machine-key file name within {@link MACHINE_KEY_DIR_NAME}. */
export const MACHINE_KEY_FILE_NAME = ".machine-key" as const;

/**
 * A LAST-resort, in-process machine hint composed from `hostname` + `username` + the
 * home dir. This is NOT the primary binding (the real provider prefers a stable OS
 * machine id or the generate-once key file); it exists so the seam always resolves to
 * *something* host-specific even on an exotic platform with no readable id and no
 * writable home. The real provider in the store layers the OS id / key file on top.
 *
 * It deliberately lives here (pure, no fs writes) so the contract surface can produce a
 * deterministic-per-host string without IO. Copying `.secrets/` to a host with a
 * different hostname/user changes this string → a different key (a-AC-3, best-effort
 * tier).
 */
export function hostnameUserFallbackId(): string {
	let user = "";
	try {
		user = userInfo().username;
	} catch {
		// userInfo can throw on some locked-down containers; fall through to empty.
		user = "";
	}
	return `host:${hostname()}|user:${user}|home:${homedir()}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// VaultProvider SEAM — Bitwarden / 1Password by reference (D-8) — STUB this wave
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The external-vault SEAM (D-8). Resolves a vault REFERENCE (e.g. a Bitwarden item id
 * or a 1Password `op://` ref) to its value AT USE TIME — the value is NOT duplicated
 * into `.secrets/` (012b-AC-4). PRD-012b builds the real Bitwarden / 1Password
 * providers; Wave 1 ships only the seam + a fake so 012b's resolver-by-reference is
 * testable without vault credentials.
 */
export interface VaultProvider {
	/** Resolve a vault reference to its value. Rejects on an unknown reference (fail-closed). */
	resolve(ref: string): Promise<string>;
}

/**
 * Build a FAKE {@link VaultProvider} from a ref → value table (tests). An unknown ref
 * rejects, mirroring the production fail-closed behaviour. No real vault is contacted;
 * the table lives only in the test.
 */
export function createFakeVaultProvider(table: Record<string, string>): VaultProvider {
	return {
		resolve(ref: string): Promise<string> {
			if (Object.hasOwn(table, ref)) return Promise.resolve(table[ref] as string);
			return Promise.reject(new Error(`VaultProvider: no value for reference ${ref}`));
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// notImplemented — the honest Wave-2 (012b) thrower
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The standard "PRD-012b fills this" thrower (mirrors the inference/ontology/dreaming
 * harness posture). A stubbed 012b body calls this so an accidental early call FAILS
 * LOUD with the owning sub-PRD, never silently returns a fake-passing value.
 */
export function notImplemented(what: string): never {
	throw new Error(`secrets: ${what} is not implemented in Wave 1 (PRD-012b owns it — see CONVENTIONS.md)`);
}
