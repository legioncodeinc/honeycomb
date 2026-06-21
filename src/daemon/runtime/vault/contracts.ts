/**
 * Vault contracts + the record-class type system — PRD-032a (the multi-class
 * generalization of the PRD-012 secret store).
 *
 * ── What this module is ──────────────────────────────────────────────────────
 * PRD-012 shipped a machine-bound `.secrets/<scope>/<name>` store for ONE data class
 * (the `secret`). PRD-032 generalizes it into ONE vault addressed by `(class, scope,
 * name)`, where each CLASS declares its own READ POSTURE and value SCHEMA as DATA (D-2
 * / D-7). This file owns the type system for that generalization; it adds NO crypto —
 * the cipher, the machine-key seam, the perms, and the scope segmentation are REUSED
 * verbatim from `../secrets/` (`crypto.ts`, `contracts.ts`, `store.ts`).
 *
 * ── The class dimension (D-2 / D-7) ──────────────────────────────────────────
 * A {@link RecordClass} is the new top-level address segment. A {@link ClassDescriptor}
 * declares, per class:
 *   - `id`         — the class id (and its on-disk segment, traversal-proof);
 *   - `posture`    — the READ POSTURE (policy as DATA, the whole point of D-2):
 *                      · `internal-only`   — the decrypted value is NEVER returned to
 *                                            any surface; only the in-process resolver/
 *                                            exec path may decrypt (the `secret` posture,
 *                                            PRD-012 verbatim);
 *                      · `daemon-readable` — the decrypted, schema-typed value MAY be
 *                                            returned to the daemon's own callers (the
 *                                            `setting` posture);
 *   - `schema`     — a zod schema validated on WRITE, so a malformed value is rejected at
 *                    the boundary (zod-at-boundary; the `setting` value is small typed
 *                    JSON, the `secret` value is an opaque string).
 *
 * Adding a class is REGISTRATION (drop a descriptor into the registry), not a storage
 * rewrite (D-7) — the store keys everything by `(class, scope, name)` and reads the
 * posture/schema from the registry.
 *
 * ── The security invariant carries forward UNCHANGED ─────────────────────────
 * The `secret` class keeps its PRD-012 posture EXACTLY: value-never-returned, names-only
 * listing, the single decrypt path internal. The registry ENFORCES this — an attempt to
 * read a `secret`-class value through the daemon-readable `getSetting` accessor is
 * rejected because the `secret` descriptor's posture is `internal-only` (a-AC-2).
 *
 * ── Boundary ─────────────────────────────────────────────────────────────────
 * Vault records are the ONE data class that does NOT live in DeepLake — filesystem only,
 * no catalog table, no SQL (so `audit:sql` stays clean, the PRD-012 invariant). This
 * module re-exports the PRD-012 name/scope/machine-key primitives so a vault consumer
 * imports from one place, but it defines no new cipher.
 */

import type { z } from "zod";

import {
	asSecretName,
	isValidSecretName,
	type MachineKeyProvider,
	type SecretName,
	type SecretScope,
} from "../secrets/contracts.js";

// ─────────────────────────────────────────────────────────────────────────────
// RecordClass — the new top-level address segment (D-2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The built-in record classes (D-2). `secret` is the PRD-012 class (value-never-
 * returned); `setting` is the new daemon-readable typed class. A future class is added
 * by registration (D-7), so this union is the SHIPPED set, not the closed set — the
 * registry accepts a {@link ClassDescriptor} with any traversal-proof id.
 */
export const BUILTIN_RECORD_CLASSES = ["secret", "setting"] as const;

/** A built-in record-class id. The registry also accepts registered (non-built-in) ids. */
export type BuiltinRecordClass = (typeof BUILTIN_RECORD_CLASSES)[number];

/**
 * A record-class id — a traversal-proof token (the SAME char class + rules as a
 * {@link SecretName}, since the class is an on-disk path segment). The `secret` /
 * `setting` ids are built-ins; a registered class supplies its own valid id.
 */
export type RecordClass = string & { readonly __brand: "RecordClass" };

/**
 * Validate + narrow a candidate to a {@link RecordClass} (fail-closed). A class id is a
 * path segment, so it must satisfy the SAME traversal-proof rule as a secret name (no
 * `/`, `\`, `.`, `..`, NUL, length-bounded). Returns `null` for anything unsafe; callers
 * MUST fail closed on `null`.
 */
export function asRecordClass(value: unknown): RecordClass | null {
	return isValidSecretName(value) ? (value as unknown as RecordClass) : null;
}

// ─────────────────────────────────────────────────────────────────────────────
// ReadPosture — the per-class read policy, expressed as DATA (D-2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The READ POSTURE of a record class — the policy that decides whether a decrypted value
 * may cross back to a surface (D-2). This is the heart of the "policy as data" decision:
 * the store does not hard-code which classes are secret; it reads the posture from the
 * class descriptor.
 *
 *   - `internal-only`   — the decrypted value is returned ONLY through the in-process
 *                         resolver/exec path; NO accessor returns it to a surface, and
 *                         listing is names-only. This is the `secret` posture (PRD-012).
 *   - `daemon-readable` — the decrypted, schema-typed value MAY be returned to the
 *                         daemon's own callers (e.g. `getSetting`). This is the `setting`
 *                         posture.
 */
export const READ_POSTURES = ["internal-only", "daemon-readable"] as const;
/** A single read posture. */
export type ReadPosture = (typeof READ_POSTURES)[number];

// ─────────────────────────────────────────────────────────────────────────────
// ClassDescriptor — the registered policy + schema for ONE class (D-2 / D-7)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The descriptor a class is registered with (D-7). It is the SINGLE SOURCE OF TRUTH for
 * a class's read policy and value validation:
 *   - `id`      — the {@link RecordClass} (and its on-disk segment);
 *   - `posture` — the {@link ReadPosture} (whether a value may be returned to a surface);
 *   - `schema`  — a zod schema validated on WRITE. The value is serialized to JSON for
 *                 storage; the schema parses the value back on a daemon-readable read.
 *                 For `internal-only` classes the value is an opaque string, but the
 *                 schema still validates the write shape.
 *
 * The schema type is intentionally `z.ZodType<unknown>`-ish (a `ZodTypeAny`) so the
 * registry can hold heterogeneous descriptors in one table; the typed accessor narrows
 * via the schema's own inference at the call site.
 */
export interface ClassDescriptor<T = unknown> {
	/** The class id (traversal-proof) + its on-disk segment. */
	readonly id: RecordClass;
	/** The read posture (policy as data). */
	readonly posture: ReadPosture;
	/** The zod schema validated on write (and parsed on a daemon-readable read). */
	readonly schema: z.ZodType<T>;
}

// ─────────────────────────────────────────────────────────────────────────────
// VaultAuditEvent — the NDJSON audit shape (redacted by construction) (D-4)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The audited vault operations. Mirrors the PRD-012 op set, with `class` now part of
 * every event so the audit trail distinguishes a `secret` op from a `setting` op.
 * `resolved_for_exec` is the internal decrypt op (secret class); `read_setting` is the
 * daemon-readable read op (setting class).
 */
export const VAULT_OPS = ["listed", "stored", "deleted", "resolved_for_exec", "read_setting"] as const;
/** A single audited vault operation. */
export type VaultOp = (typeof VAULT_OPS)[number];

/** The outcome of an audited vault op — enough to trace, never enough to leak. */
export const VAULT_OUTCOMES = ["ok", "denied", "not_found", "error", "rejected"] as const;
/** A single audited outcome. `rejected` covers a posture violation / schema failure. */
export type VaultOutcome = (typeof VAULT_OUTCOMES)[number];

/**
 * The NDJSON audit event appended under `.daemon/` for EVERY vault op (D-4).
 *
 * Redaction BY CONSTRUCTION (the PRD-012 `SecretsAuditEvent` discipline): this shape
 * carries `class` + `op` + `name` + `scope` + `ts` + `outcome` and CANNOT hold a value —
 * there is no value/plaintext field, for ANY class including `setting`. A settings list
 * records the COUNT, never the values. A `setting`'s VALUE is never written to the audit
 * line even though it is daemon-readable: the audit is a security trail, not a data dump.
 * Enforced at the WRITE boundary, not a read-time scrub.
 */
export interface VaultAuditEvent {
	/** The record class the op targeted. */
	readonly class: string;
	/** The op performed. */
	readonly op: VaultOp;
	/** The record name the op targeted (a name is public; the VALUE never appears). For `listed`, omitted. */
	readonly name?: string;
	/** The scope the op ran under. */
	readonly scope: SecretScope;
	/** The ISO-8601 instant the op completed. */
	readonly ts: string;
	/** The outcome. */
	readonly outcome: VaultOutcome;
	/** For `listed`: how many names were returned (a count is not a value). */
	readonly count?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Re-exports — the PRD-012 primitives a vault consumer needs from one place
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Re-export the PRD-012 name/scope/machine-key primitives so a vault consumer imports
 * the whole surface from `vault/`. These are REUSED VERBATIM — the vault adds no new
 * crypto, no new name validation, no new scope model. A {@link RecordClass} reuses the
 * exact {@link SecretName} validation; a vault scope IS a {@link SecretScope}.
 */
export {
	asSecretName,
	isValidSecretName,
	type MachineKeyProvider,
	type SecretName,
	type SecretScope,
};
