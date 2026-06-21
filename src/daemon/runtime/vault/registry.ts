/**
 * The record-class REGISTRY — PRD-032a (D-2 / D-7, the policy-as-data heart of the vault).
 *
 * ── What this is ─────────────────────────────────────────────────────────────
 * The registry is the SINGLE SOURCE OF TRUTH for each record class's read posture and
 * value schema. The store does NOT hard-code which classes are secret; it asks the
 * registry. Two classes ship built-in:
 *   - `secret`  → posture `internal-only` (PRD-012 verbatim: value-never-returned);
 *   - `setting` → posture `daemon-readable` (a typed value MAY be returned to the daemon).
 *
 * A future class slots in through {@link VaultRegistry.registerClass} — id + posture +
 * zod schema — with NO storage rewrite (D-7). The store keys everything by `(class,
 * scope, name)` and reads policy from here.
 *
 * ── Why a class-level schema (not a per-key schema) ──────────────────────────
 * The registry validates the VALUE SHAPE for a class (zod-at-boundary). A `secret` value
 * is an opaque non-empty string; a `setting` value is a small JSON scalar (string |
 * number | boolean). The per-KEY semantics of a setting (e.g. "the `activeModel` must be
 * in the provider catalog") live in the catalog/API layer, NOT here — keeping the class
 * schema generic is what lets a new class register without touching the store (D-7).
 *
 * ── The posture gate (a-AC-2) ────────────────────────────────────────────────
 * {@link VaultRegistry.assertReadable} is the choke point the store calls before
 * returning a decrypted value to a surface: it REJECTS a class whose posture is
 * `internal-only`. So an attempt to read a `secret` via the daemon-readable `getSetting`
 * accessor fails here — the security property is enforced by the registry, as data.
 */

import { z } from "zod";

import {
	asRecordClass,
	type ClassDescriptor,
	type ReadPosture,
	type RecordClass,
} from "./contracts.js";

// ─────────────────────────────────────────────────────────────────────────────
// Built-in class ids + value schemas
// ─────────────────────────────────────────────────────────────────────────────

/** The `secret` class id (PRD-012). Posture: `internal-only`. */
export const SECRET_CLASS = "secret" as RecordClass;
/** The `setting` class id (PRD-032). Posture: `daemon-readable`. */
export const SETTING_CLASS = "setting" as RecordClass;

/**
 * The `secret`-class value schema: a non-empty string. A secret value is opaque (an API
 * key, a token) — the schema validates only that SOMETHING was provided, never its shape.
 * The posture (`internal-only`) is what protects it, not the schema.
 */
export const SecretValueSchema = z.string().min(1);

/**
 * The `setting`-class value schema: a small JSON scalar — a string, a finite number, or a
 * boolean. This covers every shipped setting (active provider/model strings, the
 * `dreaming.enabled` boolean, dashboard-pref scalars). The value is serialized to JSON for
 * storage and parsed back on a daemon-readable read. Objects/arrays are intentionally
 * NOT accepted at the class level — a structured setting would register its own class
 * with its own schema (D-7), keeping each class's value shape explicit.
 */
export const SettingValueSchema = z.union([z.string(), z.number().finite(), z.boolean()]);

/** The TypeScript type of a `setting` value (string | number | boolean). */
export type SettingValue = z.infer<typeof SettingValueSchema>;

/** The built-in `secret`-class descriptor (posture `internal-only`). */
export const SECRET_DESCRIPTOR: ClassDescriptor<string> = Object.freeze({
	id: SECRET_CLASS,
	posture: "internal-only" as ReadPosture,
	schema: SecretValueSchema,
});

/** The built-in `setting`-class descriptor (posture `daemon-readable`). */
export const SETTING_DESCRIPTOR: ClassDescriptor<SettingValue> = Object.freeze({
	id: SETTING_CLASS,
	posture: "daemon-readable" as ReadPosture,
	schema: SettingValueSchema,
});

// ─────────────────────────────────────────────────────────────────────────────
// The registry
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A registry-lookup failure (fail-closed). The store maps these to a typed write/read
 * failure so an unknown class or a posture violation never silently succeeds.
 */
export type RegistryFailure =
	| { readonly ok: false; readonly reason: "unknown_class" }
	| { readonly ok: false; readonly reason: "not_readable" }
	| { readonly ok: false; readonly reason: "invalid_value" };

/** A successful descriptor lookup. */
export type DescriptorResult = { readonly ok: true; readonly descriptor: ClassDescriptor } | RegistryFailure;

/**
 * The record-class registry (D-2 / D-7). Holds the descriptor table; the store reads
 * posture + schema from it. Construct with {@link createVaultRegistry} (seeded with the
 * `secret` + `setting` built-ins) and {@link registerClass} a new class to extend it.
 *
 * The registry is intentionally a small, in-memory, deterministic object — it touches no
 * IO and no DeepLake, so it is trivially testable and its policy is auditable as data.
 */
export class VaultRegistry {
	private readonly table: Map<string, ClassDescriptor>;

	constructor(descriptors: readonly ClassDescriptor[]) {
		this.table = new Map();
		for (const d of descriptors) this.table.set(d.id, d);
	}

	/**
	 * Register a new record class (D-7). Validates the id is traversal-proof (a class is an
	 * on-disk segment) and that the posture is one the store understands, then adds the
	 * descriptor. Re-registering an existing id REPLACES it (so a test can swap a throwaway
	 * class); registering the built-in `secret`/`setting` ids is allowed but discouraged —
	 * their posture must not be loosened. Returns the registry for chaining.
	 *
	 * Throws on an invalid (traversal-unsafe) class id — that is a programming error, not a
	 * runtime input, so it fails loud rather than silently dropping the class.
	 */
	registerClass<T>(descriptor: ClassDescriptor<T>): this {
		const safe = asRecordClass(descriptor.id);
		if (safe === null) {
			throw new Error(`vault.registerClass: invalid (traversal-unsafe) class id`);
		}
		this.table.set(descriptor.id, descriptor as ClassDescriptor);
		return this;
	}

	/** Whether a class id is registered. */
	has(klass: string): boolean {
		return this.table.has(klass);
	}

	/** The registered class ids (sorted), for diagnostics — never values. */
	classIds(): string[] {
		return [...this.table.keys()].sort();
	}

	/**
	 * Resolve a class's descriptor for a WRITE, validating the value against the class
	 * schema (zod-at-boundary). Returns `unknown_class` for an unregistered class or
	 * `invalid_value` when the value fails the schema — both fail-closed (nothing is
	 * written). On success the descriptor (with the validated value available via the
	 * caller's re-parse) is returned.
	 */
	resolveForWrite(klass: string, value: unknown): DescriptorResult {
		const descriptor = this.table.get(klass);
		if (descriptor === undefined) return { ok: false, reason: "unknown_class" };
		const parsed = descriptor.schema.safeParse(value);
		if (!parsed.success) return { ok: false, reason: "invalid_value" };
		return { ok: true, descriptor };
	}

	/**
	 * The POSTURE GATE (a-AC-2). Resolve a class's descriptor for a READ that intends to
	 * RETURN the value to a surface (the `getSetting` path). REJECTS a class whose posture
	 * is `internal-only` with `not_readable` — so a `secret` can NEVER be read back through
	 * the daemon-readable accessor. An unknown class is `unknown_class`. This is the single
	 * point where the secret-vs-setting security boundary is enforced, as data.
	 */
	assertReadable(klass: string): DescriptorResult {
		const descriptor = this.table.get(klass);
		if (descriptor === undefined) return { ok: false, reason: "unknown_class" };
		if (descriptor.posture !== "daemon-readable") return { ok: false, reason: "not_readable" };
		return { ok: true, descriptor };
	}

	/** Resolve a descriptor with no value/posture check (internal callers that already gate). */
	descriptorOf(klass: string): ClassDescriptor | undefined {
		return this.table.get(klass);
	}
}

/**
 * Build the default registry, seeded with the `secret` + `setting` built-ins (D-2). The
 * daemon constructs ONE of these at assembly and threads it into the store + API; a test
 * constructs its own and {@link VaultRegistry.registerClass}es a throwaway class (a-AC /
 * AC-7). Passing `extra` descriptors seeds additional classes at construction.
 */
export function createVaultRegistry(extra: readonly ClassDescriptor[] = []): VaultRegistry {
	return new VaultRegistry([SECRET_DESCRIPTOR, SETTING_DESCRIPTOR, ...extra]);
}
