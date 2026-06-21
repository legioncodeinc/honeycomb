/**
 * The multi-class machine-bound VAULT store — PRD-032a (AC-1 / AC-2 / AC-7).
 *
 * ── The thesis, restated at the multi-class boundary ─────────────────────────
 * PRD-012's `.secrets/<scope>/<name>` store held ONE class. This store generalizes it to
 * `(class, scope, name)` while REUSING the PRD-012 crypto/machine-key/perms VERBATIM (D-1
 * — no new crypto). Each class's read posture + value schema come from the injected
 * {@link VaultRegistry} (policy as data), so the store contains no per-class `if`:
 *   - {@link VaultStore.setRecord} validates the value against the class schema, encrypts
 *     `{ nonce, ciphertext }` (NO plaintext), and writes at file 0600 / dir 0700 (AC-1).
 *   - {@link VaultStore.listNames} returns NAMES only, scoped (AC-2).
 *   - {@link VaultStore.getSecretValue} decrypts — INTERNAL ONLY, the `secret`-class
 *     resolver/exec path, EXACTLY as PRD-012. No API handler calls it.
 *   - {@link VaultStore.getSetting} decrypts AND returns the typed value — but ONLY for a
 *     `daemon-readable` class. The registry's posture gate REJECTS a `secret` read here
 *     (a-AC-2): a secret can never be read through the setting accessor.
 *   - Every op appends a REDACTED NDJSON {@link VaultAuditEvent} under `.daemon/` (D-4) —
 *     class + name + op + scope + ts + outcome, never a value (for ANY class).
 *
 * ── Back-compat: existing `.secrets/` records keep resolving (AC-7) ───────────
 * The `secret` class's on-disk path is `.secrets/<scope>/<name>` — the SAME path PRD-012
 * wrote. A pre-existing `ANTHROPIC_API_KEY` record written by the old `SecretsStore`
 * decrypts here UNCHANGED, because the key derivation (`deriveKey(machineId, scope)`), the
 * cipher, and the path are all reused bit-for-bit. Other classes live under
 * `.vault/<class>/<scope>/<name>` so adding a class never disturbs the secret tree. The
 * `secret` segment is special-cased to `.secrets/` ON PURPOSE — that is the back-compat
 * contract, not an accident.
 *
 * ── Machine binding (AC-1) — REUSED from PRD-012 ─────────────────────────────
 * The encryption key derives from a stable machine identifier via the same
 * {@link MachineKeyProvider} seam and {@link createMachineKeyProvider} as the secret
 * store. Copying the vault dir to a host with a different machine key derives a different
 * key → the Poly1305 tag fails → decrypt returns a typed failure, never plaintext (AC-1).
 *
 * ── Boundary ─────────────────────────────────────────────────────────────────
 * The vault is filesystem-only — no DeepLake, no catalog table, no SQL (so `audit:sql`
 * stays clean, the PRD-012 invariant). The base dir + clock + machine-key provider +
 * registry are all injected so a test runs against a temp dir with a fake provider and a
 * fixed clock, never touching the real workspace, home dir, or `~/.deeplake`.
 */

import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { isSecretRecord, type SecretRecord } from "../secrets/contracts.js";
import { decrypt, deriveKey, encrypt } from "../secrets/crypto.js";
import {
	DAEMON_DIR_NAME,
	SECRET_DIR_MODE,
	SECRET_FILE_MODE,
	SECRETS_DIR_NAME,
	type SecretsClock,
	scopeSegment,
	systemSecretsClock,
} from "../secrets/store.js";
import {
	asRecordClass,
	asSecretName,
	type MachineKeyProvider,
	type RecordClass,
	type SecretName,
	type SecretScope,
	type VaultAuditEvent,
	type VaultOp,
	type VaultOutcome,
} from "./contracts.js";
import { SECRET_CLASS, SETTING_CLASS, type SettingValue, VaultRegistry } from "./registry.js";

/** The vault directory name under `$HONEYCOMB_WORKSPACE` for NON-secret classes (AC-1 / FR-1). */
export const VAULT_DIR_NAME = ".vault" as const;
/** The NDJSON audit log file name within `.daemon/`. */
export const VAULT_AUDIT_FILE_NAME = "vault-audit.ndjson" as const;

/** Construction deps for the {@link VaultStore}. Everything IO-touching is injected. */
export interface VaultStoreDeps {
	/**
	 * The base directory — `$HONEYCOMB_WORKSPACE`. `.secrets/` (secret class), `.vault/`
	 * (other classes), and `.daemon/` (audit) are created UNDER it. A test passes a temp dir.
	 */
	readonly baseDir: string;
	/** The machine-key provider. A test injects a fake; production uses {@link createMachineKeyProvider}. */
	readonly machineKey: MachineKeyProvider;
	/** The record-class registry (read posture + value schema per class). */
	readonly registry: VaultRegistry;
	/** The clock for `createdAt` + audit `ts`. Defaults to the wall clock. */
	readonly clock?: SecretsClock;
}

/** A typed store failure the API maps to a status code (never a value-leaking message). */
export type VaultFailure =
	| { readonly ok: false; readonly reason: "invalid_name" }
	| { readonly ok: false; readonly reason: "invalid_class" }
	| { readonly ok: false; readonly reason: "unknown_class" }
	| { readonly ok: false; readonly reason: "invalid_value" }
	| { readonly ok: false; readonly reason: "not_readable" }
	| { readonly ok: false; readonly reason: "not_found" }
	| { readonly ok: false; readonly reason: "decrypt_failed" }
	| { readonly ok: false; readonly reason: "io_error" };

/** A successful string-value resolution (INTERNAL for secret; never returned by an API handler). */
export type VaultValueResult = { readonly ok: true; readonly value: string } | VaultFailure;
/** A successful typed setting read (daemon-readable). */
export type SettingResult = { readonly ok: true; readonly value: SettingValue } | VaultFailure;
/** A successful store/delete op. */
export type VaultWriteResult = { readonly ok: true } | VaultFailure;

/**
 * The machine-bound multi-class vault store. Construct with an injected base dir +
 * machine-key provider + registry + clock; every method is scope-bound and class-aware.
 * The store is the ONLY component that decrypts.
 */
export class VaultStore {
	private readonly baseDir: string;
	private readonly machineKey: MachineKeyProvider;
	private readonly registry: VaultRegistry;
	private readonly clock: SecretsClock;

	constructor(deps: VaultStoreDeps) {
		this.baseDir = deps.baseDir;
		this.machineKey = deps.machineKey;
		this.registry = deps.registry;
		this.clock = deps.clock ?? systemSecretsClock;
	}

	// ── secret class (PRD-012 posture preserved verbatim) ────────────────────────

	/**
	 * Store a `secret`-class record (AC-1). The thin back-compat wrapper over
	 * {@link setRecord} with `class = secret` — the path is `.secrets/<scope>/<name>`, the
	 * SAME location PRD-012 wrote, so the surface is bit-for-bit compatible. The plaintext
	 * `value` is used only to encrypt — never written, logged, or echoed.
	 */
	async setSecret(name: string, value: string, scope: SecretScope): Promise<VaultWriteResult> {
		return this.setRecord(SECRET_CLASS, name, value, scope);
	}

	/**
	 * Resolve a `secret`'s DECRYPTED value — INTERNAL ONLY (AC-2). THIS IS THE SINGLE
	 * decrypt-returning path for the `secret` class, used by the in-process resolver / exec
	 * path. It is NOT exposed by any API handler. A decrypt failure (e.g. the vault was
	 * copied to another host — AC-1) returns a typed `decrypt_failed`, never plaintext.
	 * Audited as `resolved_for_exec` (name only).
	 */
	async getSecretValue(name: string, scope: SecretScope): Promise<VaultValueResult> {
		return this.readDecryptedString(SECRET_CLASS, name, scope, "resolved_for_exec");
	}

	/** List the `secret` NAMES in a scope (AC-2) — names ONLY, never a value. */
	listSecretNames(scope: SecretScope): SecretName[] {
		return this.listNames(SECRET_CLASS, scope);
	}

	/** Delete a `secret` (scoped). */
	deleteSecret(name: string, scope: SecretScope): VaultWriteResult {
		return this.deleteRecord(SECRET_CLASS, name, scope);
	}

	// ── setting class (daemon-readable typed accessor) ───────────────────────────

	/**
	 * Store a `setting`-class record (AC-2 / FR-4). The value is zod-validated against the
	 * `setting` class schema on write (a malformed value is rejected); it is serialized to
	 * JSON, encrypted, and written like any record. A written setting round-trips through
	 * {@link getSetting} (reads back equal).
	 */
	async setSetting(key: string, value: SettingValue, scope: SecretScope): Promise<VaultWriteResult> {
		return this.setRecord(SETTING_CLASS, key, value, scope);
	}

	/**
	 * Read a `setting`'s DECRYPTED, typed value (AC-2 / FR-4). Goes through the registry's
	 * POSTURE GATE: the `setting` class is `daemon-readable`, so its value MAY be returned.
	 * A `secret` (or any `internal-only` class) read through this accessor is REJECTED with
	 * `not_readable` — the security boundary, enforced by the registry as data (a-AC-2). The
	 * stored JSON is parsed back through the class schema so the returned value is typed.
	 * Audited as `read_setting`.
	 */
	async getSetting(key: string, scope: SecretScope): Promise<SettingResult> {
		// The posture gate FIRST: a non-readable class never even attempts a decrypt here.
		const gate = this.registry.assertReadable(SETTING_CLASS);
		if (!gate.ok) {
			this.audit(SETTING_CLASS, "read_setting", scope, "rejected", undefined);
			return { ok: false, reason: gate.reason === "unknown_class" ? "unknown_class" : "not_readable" };
		}
		const res = await this.readDecryptedString(SETTING_CLASS, key, scope, "read_setting");
		if (!res.ok) return res;
		// Parse the stored JSON back through the class schema so the value is typed, not a raw string.
		let raw: unknown;
		try {
			raw = JSON.parse(res.value);
		} catch {
			return { ok: false, reason: "io_error" };
		}
		const parsed = gate.descriptor.schema.safeParse(raw);
		if (!parsed.success) return { ok: false, reason: "invalid_value" };
		return { ok: true, value: parsed.data as SettingValue };
	}

	/** List the `setting` KEYS in a scope (names only — a key is public, the value is not). */
	listSettingKeys(scope: SecretScope): SecretName[] {
		return this.listNames(SETTING_CLASS, scope);
	}

	/** Delete a `setting` (scoped). */
	deleteSetting(key: string, scope: SecretScope): VaultWriteResult {
		return this.deleteRecord(SETTING_CLASS, key, scope);
	}

	// ── generic, class-aware primitives (the D-7 surface) ────────────────────────

	/**
	 * Store a record of ANY registered class (the generic write — D-7). Validates the class
	 * is registered AND the value passes the class schema (zod-at-boundary), derives the
	 * scope-bound machine key, encrypts a fresh-nonce ciphertext, and writes
	 * `{ nonce, ciphertext, createdAt, scope }` at file 0600 (dir 0700). For the `secret`
	 * class the value is the raw string; for other classes the value is JSON-serialized
	 * before encryption. Appends a redacted `stored` audit event. The plaintext value never
	 * lands on disk, in a log, or in the response.
	 */
	async setRecord(klass: string, name: string, value: unknown, scope: SecretScope): Promise<VaultWriteResult> {
		const safeClass = asRecordClass(klass);
		if (safeClass === null) {
			this.audit(klass, "stored", scope, "denied", name);
			return { ok: false, reason: "invalid_class" };
		}
		const safe = asSecretName(name);
		if (safe === null) {
			this.audit(klass, "stored", scope, "denied", name);
			return { ok: false, reason: "invalid_name" };
		}
		// Registry gate: unknown class OR a value failing the class schema → fail closed.
		const resolved = this.registry.resolveForWrite(safeClass, value);
		if (!resolved.ok) {
			this.audit(safeClass, "stored", scope, "rejected", safe);
			return { ok: false, reason: resolved.reason === "unknown_class" ? "unknown_class" : "invalid_value" };
		}
		try {
			// The `secret` class stores the raw string; other classes JSON-serialize the value
			// (so a setting's number/boolean round-trips through the string cipher).
			const plaintext = safeClass === SECRET_CLASS ? (value as string) : JSON.stringify(value);
			const machineId = await this.machineKey.machineId();
			const key = deriveKey(machineId, scope);
			const enc = encrypt(plaintext, key);
			const record: SecretRecord = {
				nonce: enc.nonce,
				ciphertext: enc.ciphertext,
				createdAt: this.clock.now(),
				scope: normalizeScope(scope),
			};
			this.writeRecord(safeClass, safe, scope, record);
			this.audit(safeClass, "stored", scope, "ok", safe);
			return { ok: true };
		} catch {
			this.audit(safeClass, "stored", scope, "error", safe);
			return { ok: false, reason: "io_error" };
		}
	}

	/**
	 * List the record NAMES of a class in a scope (AC-2) — names ONLY, never a value. A
	 * missing class/scope dir yields an empty list (not an error). Appends a `listed` audit
	 * event carrying the COUNT. An invalid class id yields an empty list (defensive).
	 */
	listNames(klass: string, scope: SecretScope): SecretName[] {
		const safeClass = asRecordClass(klass);
		if (safeClass === null) return [];
		const dir = this.classScopeDir(safeClass, scope);
		let names: SecretName[] = [];
		if (existsSync(dir)) {
			for (const entry of readdirSync(dir)) {
				const safe = asSecretName(entry);
				if (safe !== null) names.push(safe);
			}
		}
		names = names.sort();
		this.audit(safeClass, "listed", scope, "ok", undefined, names.length);
		return names;
	}

	/** Delete a record of a class (scoped). Deleting a missing record is `not_found`, not an IO error. */
	deleteRecord(klass: string, name: string, scope: SecretScope): VaultWriteResult {
		const safeClass = asRecordClass(klass);
		if (safeClass === null) {
			this.audit(klass, "deleted", scope, "denied", name);
			return { ok: false, reason: "invalid_class" };
		}
		const safe = asSecretName(name);
		if (safe === null) {
			this.audit(safeClass, "deleted", scope, "denied", name);
			return { ok: false, reason: "invalid_name" };
		}
		const file = this.recordPath(safeClass, safe, scope);
		if (!existsSync(file)) {
			this.audit(safeClass, "deleted", scope, "not_found", safe);
			return { ok: false, reason: "not_found" };
		}
		try {
			rmSync(file);
			this.audit(safeClass, "deleted", scope, "ok", safe);
			return { ok: true };
		} catch {
			this.audit(safeClass, "deleted", scope, "error", safe);
			return { ok: false, reason: "io_error" };
		}
	}

	// ── internals ────────────────────────────────────────────────────────────────

	/**
	 * Read + decrypt a record to its raw stored STRING (the secret value, or a setting's
	 * serialized JSON). Shared by {@link getSecretValue} (internal) and {@link getSetting}
	 * (daemon-readable, after the posture gate). A decrypt failure (wrong-host key — AC-1)
	 * returns `decrypt_failed`, never plaintext. Audited with the given op.
	 */
	private async readDecryptedString(
		klass: RecordClass,
		name: string,
		scope: SecretScope,
		op: VaultOp,
	): Promise<VaultValueResult> {
		const safe = asSecretName(name);
		if (safe === null) {
			this.audit(klass, op, scope, "denied", name);
			return { ok: false, reason: "invalid_name" };
		}
		const file = this.recordPath(klass, safe, scope);
		if (!existsSync(file)) {
			this.audit(klass, op, scope, "not_found", safe);
			return { ok: false, reason: "not_found" };
		}
		let record: SecretRecord;
		try {
			const parsed: unknown = JSON.parse(readFileSync(file, "utf8"));
			if (!isSecretRecord(parsed)) {
				this.audit(klass, op, scope, "error", safe);
				return { ok: false, reason: "io_error" };
			}
			record = parsed;
		} catch {
			this.audit(klass, op, scope, "error", safe);
			return { ok: false, reason: "io_error" };
		}
		const machineId = await this.machineKey.machineId();
		const key = deriveKey(machineId, scope);
		const res = decrypt(record, key);
		if (!res.ok) {
			this.audit(klass, op, scope, "error", safe);
			return { ok: false, reason: "decrypt_failed" };
		}
		this.audit(klass, op, scope, "ok", safe);
		return { ok: true, value: res.value };
	}

	/**
	 * The on-disk directory for a `(class, scope)` pair. The `secret` class maps to
	 * `.secrets/<scope>` (PRD-012 back-compat — bit-for-bit); every other class maps to
	 * `.vault/<class>/<scope>`. This special-case IS the back-compat contract (AC-7).
	 */
	private classScopeDir(klass: RecordClass, scope: SecretScope): string {
		if (klass === SECRET_CLASS) {
			return join(this.baseDir, SECRETS_DIR_NAME, scopeSegment(scope));
		}
		return join(this.baseDir, VAULT_DIR_NAME, klass, scopeSegment(scope));
	}

	/** The full path to a named record within its `(class, scope)` dir. */
	private recordPath(klass: RecordClass, name: SecretName, scope: SecretScope): string {
		return join(this.classScopeDir(klass, scope), name);
	}

	/** Write a record at file 0600, creating the `(class, scope)` dir at 0700 if absent. */
	private writeRecord(klass: RecordClass, name: SecretName, scope: SecretScope, record: SecretRecord): void {
		const dir = this.classScopeDir(klass, scope);
		if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: SECRET_DIR_MODE });
		const file = this.recordPath(klass, name, scope);
		writeFileSync(file, `${JSON.stringify(record)}\n`, { mode: SECRET_FILE_MODE });
	}

	/**
	 * Append a REDACTED NDJSON {@link VaultAuditEvent} under `.daemon/` (D-4). The event
	 * carries class + name + op + scope + ts + outcome (+ count for a `listed`) and CANNOT
	 * hold a value — for ANY class, including `setting` (a daemon-readable value is still
	 * never written to the audit line). Auditing is best-effort: a failed audit write never
	 * throws into the op.
	 */
	private audit(
		klass: string,
		op: VaultOp,
		scope: SecretScope,
		outcome: VaultOutcome,
		name?: string,
		count?: number,
	): void {
		const event: VaultAuditEvent = {
			class: klass,
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
			appendFileSync(join(dir, VAULT_AUDIT_FILE_NAME), `${JSON.stringify(event)}\n`, { mode: SECRET_FILE_MODE });
		} catch {
			// An audit-write failure must not break the op; there is no value at risk here.
		}
	}
}

/** Normalize a scope to its canonical record form (drop an empty agentId). REUSED from PRD-012. */
function normalizeScope(scope: SecretScope): SecretScope {
	return scope.agentId !== undefined && scope.agentId.length > 0
		? { org: scope.org, workspace: scope.workspace, agentId: scope.agentId }
		: { org: scope.org, workspace: scope.workspace };
}
