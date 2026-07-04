/**
 * The `.secrets/` machine-bound secret store + the REAL SecretResolver — PRD-012a
 * (a-AC-1 / a-AC-3 / a-AC-4 / a-AC-6, and the FR-2..FR-9 storage discipline).
 *
 * ── The thesis, restated at the storage boundary ─────────────────────────────
 * An agent can CAUSE a secret to be used but NEVER receives a decrypted value. So:
 *   - {@link SecretsStore.setSecret} encrypts then writes `{ nonce, ciphertext }` (NO
 *     plaintext) under `$HONEYCOMB_WORKSPACE/.secrets/<scoped>/<name>` at file 0600,
 *     dir 0700 (a-AC-1).
 *   - {@link SecretsStore.listSecretNames} returns NAMES only, scoped (a-AC-2 / a-AC-6).
 *   - {@link SecretsStore.deleteSecret} removes a file, scoped.
 *   - {@link SecretsStore.getSecretValue} decrypts — but it is INTERNAL ONLY (the
 *     resolver / exec path). It is NOT exposed by any API handler (api.ts mounts no
 *     value-returning route — a-AC-2 / a-AC-5). This is the SINGLE decrypt-returning
 *     path in the whole product and it is router-internal, never an agent surface.
 *   - Every op appends a REDACTED NDJSON {@link SecretsAuditEvent} under `.daemon/`
 *     (a-AC-4) — name + op + scope + ts + outcome, never a value.
 *
 * ── Machine binding (D-2 / a-AC-3) ───────────────────────────────────────────
 * The encryption key derives from a stable machine identifier via the
 * {@link MachineKeyProvider} seam. The REAL provider ({@link createMachineKeyProvider})
 * reads an OS machine id (Linux `/etc/machine-id` || `/var/lib/dbus/machine-id`; macOS
 * `IOPlatformUUID` via `ioreg`; win `MachineGuid` from the registry), and FALLS BACK to
 * a generate-once 32-byte random key file at `~/.apiary/honeycomb/.machine-key` (mode 0600,
 * read new-first with a legacy `~/.honeycomb/.machine-key` fallback, ADR-0003 / PRD-072b,
 * OUTSIDE `.secrets/` — so copying `.secrets/` alone yields nothing). The "different
 * host" AC is a DIFFERENT provider → a different derived key → decrypt fails (a-AC-3).
 *
 * ── Boundary ─────────────────────────────────────────────────────────────────
 * Secrets are the ONE data class that does NOT live in DeepLake — filesystem only, no
 * catalog table, no SQL (so `audit:sql` stays clean). The base dir + clock + machine-key
 * provider are all injected so a test runs against a temp dir with a fake provider and a
 * fixed clock, never touching the real workspace, home dir, or wall clock.
 */

import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { honeycombStateDir, legacyHoneycombDir, preferExistingPath } from "../../../shared/fleet-root.js";
import type { SecretResolver } from "../inference/contracts.js";
import {
	asSecretName,
	hostnameUserFallbackId,
	isSecretRecord,
	MACHINE_KEY_FILE_NAME,
	type MachineKeyProvider,
	type SecretName,
	type SecretOp,
	type SecretOutcome,
	type SecretRecord,
	type SecretScope,
	type SecretsAuditEvent,
} from "./contracts.js";
import { decrypt, deriveKey, encrypt } from "./crypto.js";

/** POSIX mode for a secret file: owner read/write only (a-AC-1). */
export const SECRET_FILE_MODE = 0o600;
/** POSIX mode for a secret directory: owner read/write/execute only (a-AC-1). */
export const SECRET_DIR_MODE = 0o700;

/** The secrets directory name under `$HONEYCOMB_WORKSPACE` (FR-2). */
export const SECRETS_DIR_NAME = ".secrets" as const;
/** The daemon audit directory name under `$HONEYCOMB_WORKSPACE` (FR-7). */
export const DAEMON_DIR_NAME = ".daemon" as const;
/** The NDJSON audit log file name within {@link DAEMON_DIR_NAME}. */
export const AUDIT_FILE_NAME = "secrets-audit.ndjson" as const;

/** An injectable clock so audit timestamps + `createdAt` are deterministic in tests. */
export interface SecretsClock {
	/** The current instant as an ISO-8601 string. */
	now(): string;
}

/** The default wall-clock implementation. */
export const systemSecretsClock: SecretsClock = {
	now(): string {
		return new Date().toISOString();
	},
};

/** Construction deps for the {@link SecretsStore}. Everything IO-touching is injected. */
export interface SecretsStoreDeps {
	/**
	 * The base directory — `$HONEYCOMB_WORKSPACE`. `.secrets/` and `.daemon/` are created
	 * UNDER it. A test passes a temp dir so the real workspace is never touched.
	 */
	readonly baseDir: string;
	/** The machine-key provider (D-2). A test injects a fake; production uses {@link createMachineKeyProvider}. */
	readonly machineKey: MachineKeyProvider;
	/** The clock for `createdAt` + audit `ts`. Defaults to the wall clock. */
	readonly clock?: SecretsClock;
}

// ─────────────────────────────────────────────────────────────────────────────
// The real MachineKeyProvider (OS id readers + generate-once fallback key file)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where the generate-once fallback key lives — `~/.apiary/honeycomb/.machine-key` (ADR-0003 /
 * PRD-072b, OUTSIDE `.secrets/`). Home is injectable for tests.
 */
export function machineKeyFilePath(homeDir: string = homedir()): string {
	return join(honeycombStateDir({ home: homeDir }), MACHINE_KEY_FILE_NAME);
}

/** The legacy machine-key path (`~/.honeycomb/.machine-key`) read as a fallback during the window. */
export function legacyMachineKeyFilePath(homeDir: string = homedir()): string {
	return join(legacyHoneycombDir(homeDir), MACHINE_KEY_FILE_NAME);
}

/**
 * Read the OS machine identifier for the current platform, or `null` if none is readable.
 *   - Linux: `/etc/machine-id` then `/var/lib/dbus/machine-id`;
 *   - macOS: `IOPlatformUUID` via `ioreg`;
 *   - win32: `MachineGuid` from `HKLM\SOFTWARE\Microsoft\Cryptography` via `reg query`.
 * Every read is best-effort and fail-soft (a throw → `null` → the caller falls back to the
 * generate-once key file). No machine id is ever logged.
 */
function readOsMachineId(): string | null {
	try {
		if (process.platform === "linux") {
			for (const p of ["/etc/machine-id", "/var/lib/dbus/machine-id"]) {
				if (existsSync(p)) {
					const id = readFileSync(p, "utf8").trim();
					if (id.length > 0) return id;
				}
			}
			return null;
		}
		if (process.platform === "darwin") {
			const out = execFileSync("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"], {
				encoding: "utf8",
				timeout: 4000,
				windowsHide: true,
			});
			const m = out.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/);
			return m && m[1] ? m[1] : null;
		}
		if (process.platform === "win32") {
			const out = execFileSync(
				"reg",
				["query", "HKLM\\SOFTWARE\\Microsoft\\Cryptography", "/v", "MachineGuid"],
				// Hide the transient console window on Windows (background machine-id probe).
				{ encoding: "utf8", timeout: 4000, windowsHide: true },
			);
			const m = out.match(/MachineGuid\s+REG_SZ\s+([A-Za-z0-9-]+)/);
			return m && m[1] ? m[1] : null;
		}
	} catch {
		// Any failure (missing file, command not found, timeout) → fall back.
		return null;
	}
	return null;
}

/**
 * Read-or-create the generate-once 32-byte random fallback key at
 * `~/.honeycomb/.machine-key` (mode 0600, dir 0700), returning it as a hex string. This
 * file lives OUTSIDE `.secrets/`, so copying `.secrets/` alone yields nothing usable
 * (a-AC-3 / D-2). The bytes are random, not derived — they ARE the host-specific secret
 * the key binds to when no OS machine id is available.
 */
function readOrCreateFallbackKey(homeDir: string): string {
	const file = machineKeyFilePath(homeDir);
	// PRD-072b window: read new-first, then the legacy `~/.honeycomb/.machine-key`. A legacy key MUST
	// be honored, never re-minted — a fresh key would silently orphan every existing `.secrets/` blob
	// (AC-7). The migration mover byte-relocates it; this fallback covers the not-yet-migrated case.
	const source = preferExistingPath(file, legacyMachineKeyFilePath(homeDir));
	if (existsSync(source)) {
		const hex = readFileSync(source, "utf8").trim();
		if (hex.length > 0) return hex;
	}
	const dir = dirname(file);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE });
	const hex = randomBytes(32).toString("hex");
	writeFileSync(file, hex, { mode: SECRET_FILE_MODE });
	return hex;
}

/**
 * Build the REAL {@link MachineKeyProvider} (D-2). Prefers a stable OS machine id; on a
 * platform with none readable, falls back to the generate-once `~/.honeycomb/.machine-key`
 * file; and if even the home dir is unwritable, to the {@link hostnameUserFallbackId}
 * hint. The chosen string is host-specific, so the same `.secrets/` on a different host
 * derives a different key and fails to decrypt (a-AC-3 / FR-9).
 *
 * `homeDir` is injectable for tests; production uses the real home.
 */
export function createMachineKeyProvider(homeDir: string = homedir()): MachineKeyProvider {
	return {
		machineId(): Promise<string> {
			const osId = readOsMachineId();
			if (osId !== null) return Promise.resolve(`os:${osId}`);
			try {
				return Promise.resolve(`file:${readOrCreateFallbackKey(homeDir)}`);
			} catch {
				// No OS id, no writable home → last-resort host hint (best-effort binding).
				return Promise.resolve(`hint:${hostnameUserFallbackId()}`);
			}
		},
	};
}

// ─────────────────────────────────────────────────────────────────────────────
// The store
// ─────────────────────────────────────────────────────────────────────────────

/** A typed store error outcome the API maps to a status code (never a value-leaking message). */
export type StoreFailure =
	| { readonly ok: false; readonly reason: "invalid_name" }
	| { readonly ok: false; readonly reason: "not_found" }
	| { readonly ok: false; readonly reason: "decrypt_failed" }
	| { readonly ok: false; readonly reason: "io_error" };

/** A successful value resolution (INTERNAL only — never returned by an API handler). */
export type ValueResult = { readonly ok: true; readonly value: string } | StoreFailure;
/** A successful store/delete op. */
export type WriteResult = { readonly ok: true } | StoreFailure;

/**
 * The machine-bound `.secrets/` store. Construct with an injected base dir + machine-key
 * provider + clock; every method is scope-bound. The store is the ONLY component that
 * decrypts, and only via {@link getSecretValue} (internal).
 */
export class SecretsStore {
	private readonly baseDir: string;
	private readonly machineKey: MachineKeyProvider;
	private readonly clock: SecretsClock;

	constructor(deps: SecretsStoreDeps) {
		this.baseDir = deps.baseDir;
		this.machineKey = deps.machineKey;
		this.clock = deps.clock ?? systemSecretsClock;
	}

	/**
	 * Store a secret (a-AC-1). Validates the name (traversal-proof), derives the
	 * scope-bound machine key, encrypts with a fresh random nonce, and writes the
	 * `{ nonce, ciphertext, createdAt, scope }` record at file 0600 (dir 0700). Appends a
	 * redacted `stored` audit event. The plaintext `value` is used only to encrypt — it is
	 * never written, never logged, and not echoed back.
	 */
	async setSecret(name: string, value: string, scope: SecretScope): Promise<WriteResult> {
		const safe = asSecretName(name);
		if (safe === null) {
			this.audit("stored", scope, "denied", name);
			return { ok: false, reason: "invalid_name" };
		}
		try {
			const machineId = await this.machineKey.machineId();
			const key = deriveKey(machineId, scope);
			const enc = encrypt(value, key);
			const record: SecretRecord = {
				nonce: enc.nonce,
				ciphertext: enc.ciphertext,
				createdAt: this.clock.now(),
				scope: normalizeScope(scope),
			};
			this.writeRecord(safe, scope, record);
			this.audit("stored", scope, "ok", safe);
			return { ok: true };
		} catch {
			this.audit("stored", scope, "error", safe);
			return { ok: false, reason: "io_error" };
		}
	}

	/**
	 * List the secret NAMES in a scope (a-AC-2 / a-AC-6) — names ONLY, never a value. Two
	 * agents in one workspace each see only their own scope's names because the scope maps
	 * to a per-scope directory. Appends a `listed` audit event carrying the COUNT (not the
	 * names' values). A missing scope dir yields an empty list (not an error).
	 */
	listSecretNames(scope: SecretScope): SecretName[] {
		const dir = this.scopeDir(scope);
		let names: SecretName[] = [];
		if (existsSync(dir)) {
			for (const entry of readdirSync(dir)) {
				const safe = asSecretName(entry);
				// Only surface entries that are themselves valid secret names (defensive).
				if (safe !== null) names.push(safe);
			}
		}
		names = names.sort();
		this.audit("listed", scope, "ok", undefined, names.length);
		return names;
	}

	/**
	 * Delete a secret (scoped). Validates the name, removes the file, and audits. Deleting a
	 * missing secret is a `not_found` (audited), not an IO error.
	 */
	deleteSecret(name: string, scope: SecretScope): WriteResult {
		const safe = asSecretName(name);
		if (safe === null) {
			this.audit("deleted", scope, "denied", name);
			return { ok: false, reason: "invalid_name" };
		}
		const file = this.secretPath(safe, scope);
		if (!existsSync(file)) {
			this.audit("deleted", scope, "not_found", safe);
			return { ok: false, reason: "not_found" };
		}
		try {
			rmSync(file);
			this.audit("deleted", scope, "ok", safe);
			return { ok: true };
		} catch {
			this.audit("deleted", scope, "error", safe);
			return { ok: false, reason: "io_error" };
		}
	}

	/**
	 * Resolve a secret's DECRYPTED value — INTERNAL ONLY (a-AC-5 / D-5).
	 *
	 * THIS IS THE SINGLE decrypt-returning path in the product. It exists for the
	 * in-process resolver / exec path (the router resolves `account.apiKeyRef` to a key for
	 * one provider call). It is NOT exposed by any API handler — api.ts mounts no
	 * value-returning route. A decrypt failure (e.g. the machine-bound key differs because
	 * `.secrets/` was copied to another host — a-AC-3) returns a typed `decrypt_failed`,
	 * never plaintext. Audited as `resolved_for_exec` (name only, never the value).
	 */
	async getSecretValue(name: string, scope: SecretScope): Promise<ValueResult> {
		const safe = asSecretName(name);
		if (safe === null) {
			this.audit("resolved_for_exec", scope, "denied", name);
			return { ok: false, reason: "invalid_name" };
		}
		const file = this.secretPath(safe, scope);
		if (!existsSync(file)) {
			this.audit("resolved_for_exec", scope, "not_found", safe);
			return { ok: false, reason: "not_found" };
		}
		let record: SecretRecord;
		try {
			const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (!isSecretRecord(parsed)) {
				this.audit("resolved_for_exec", scope, "error", safe);
				return { ok: false, reason: "io_error" };
			}
			record = parsed;
		} catch {
			this.audit("resolved_for_exec", scope, "error", safe);
			return { ok: false, reason: "io_error" };
		}
		const machineId = await this.machineKey.machineId();
		const key = deriveKey(machineId, scope);
		const res = decrypt(record, key);
		if (!res.ok) {
			// Wrong (different-host) key or tamper — never plaintext garbage (a-AC-3).
			this.audit("resolved_for_exec", scope, "error", safe);
			return { ok: false, reason: "decrypt_failed" };
		}
		this.audit("resolved_for_exec", scope, "ok", safe);
		return { ok: true, value: res.value };
	}

	// ── internals ──────────────────────────────────────────────────────────────

	/** The `.secrets/<scoped>` directory for a scope. */
	private scopeDir(scope: SecretScope): string {
		return join(this.baseDir, SECRETS_DIR_NAME, scopeSegment(scope));
	}

	/** The full path to a named secret within its scope dir. */
	private secretPath(name: SecretName, scope: SecretScope): string {
		return join(this.scopeDir(scope), name);
	}

	/** Write a record at file 0600, creating the scope dir at 0700 if absent. */
	private writeRecord(name: SecretName, scope: SecretScope, record: SecretRecord): void {
		const dir = this.scopeDir(scope);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE });
		const file = this.secretPath(name, scope);
		writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: SECRET_FILE_MODE });
	}

	/**
	 * Append a REDACTED NDJSON audit event under `.daemon/` (a-AC-4 / FR-7). The event is
	 * the {@link SecretsAuditEvent} shape — name + op + scope + ts + outcome (+ count for a
	 * `listed`) — which CANNOT hold a value. Auditing is best-effort: a failed audit write
	 * never throws into the op (but it also never silently swallows a value — there is no
	 * value here to swallow).
	 */
	private audit(op: SecretOp, scope: SecretScope, outcome: SecretOutcome, name?: string, count?: number): void {
		const event: SecretsAuditEvent = {
			op,
			scope: normalizeScope(scope),
			ts: this.clock.now(),
			outcome,
			...(name !== undefined ? { name } : {}),
			...(count !== undefined ? { count } : {}),
		};
		try {
			const dir = join(this.baseDir, DAEMON_DIR_NAME);
			if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE });
			appendFileSync(join(dir, AUDIT_FILE_NAME), `${JSON.stringify(event)}\n`, { mode: SECRET_FILE_MODE });
		} catch {
			// An audit-write failure must not break the op; there is no value at risk here.
		}
	}
}

/** Normalize a scope to its canonical record form (drop an empty agentId). */
function normalizeScope(scope: SecretScope): SecretScope {
	return scope.agentId !== undefined && scope.agentId.length > 0
		? { org: scope.org, workspace: scope.workspace, agentId: scope.agentId }
		: { org: scope.org, workspace: scope.workspace };
}

/**
 * Map a scope to a SINGLE safe directory segment (a-AC-6). The org/workspace/agent are
 * sanitized to the safe char class so a hostile tenancy value cannot traverse out of
 * `.secrets/`. Different scopes → different segments → isolation. An absent agentId
 * collapses to a workspace-level segment.
 */
export function scopeSegment(scope: SecretScope): string {
	const part = (s: string): string => s.replace(/[^A-Za-z0-9_.-]/g, "_") || "_";
	const base = `${part(scope.org)}__${part(scope.workspace)}`;
	return scope.agentId !== undefined && scope.agentId.length > 0 ? `${base}__${part(scope.agentId)}` : base;
}

// ─────────────────────────────────────────────────────────────────────────────
// The REAL SecretResolver — wires PRD-010's seam (D-5)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Build the REAL {@link SecretResolver} (PRD-010's seam — D-5). Closes over the store +
 * the active scope; `resolve(ref)` decrypts the named secret IN-PROCESS for the router's
 * one provider call. The resolved value lives only in the router's local scope for the
 * duration of that call — it is never logged, stored on a Target, written to telemetry,
 * or returned to an agent surface.
 *
 * THIS (via {@link SecretsStore.getSecretValue}) IS THE ONLY decrypt-returning path, and
 * it is INTERNAL (router-only). A `${SECRET_REF}` ref is treated as the secret NAME after
 * stripping an optional `${...}` wrapper; an unknown / undecryptable ref REJECTS
 * (fail-closed), exactly like the fake resolver the router was built against.
 */
export function createSecretResolver(store: SecretsStore, scope: SecretScope): SecretResolver {
	return {
		async resolve(ref: string): Promise<string> {
			const name = stripRefWrapper(ref);
			const res = await store.getSecretValue(name, scope);
			if (!res.ok) {
				// Fail closed on a missing/undecryptable secret — never a partial or a default.
				throw new Error(`SecretResolver: could not resolve reference ${ref} (${res.reason})`);
			}
			return res.value;
		},
	};
}

/** Strip an optional `${...}` wrapper from a secret reference, yielding the bare name. */
function stripRefWrapper(ref: string): string {
	const m = ref.match(/^\$\{(.+)\}$/);
	return m && m[1] ? m[1] : ref;
}

/** Re-export the perm bits + key path so the store's tests and the assembly can assert them. */
export { isSecretRecord } from "./contracts.js";

/** Read a file's mode (POSIX perm bits) — exported so the store test can assert 0600/0700. */
export function modeOf(path: string): number {
	return statSync(path).mode & 0o777;
}
