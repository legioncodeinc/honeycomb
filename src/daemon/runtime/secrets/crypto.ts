/**
 * Machine-bound secret encryption — PRD-012a (the cipher core, D-1 / D-2 / FR-3 / FR-4).
 *
 * The cipher is XSalsa20-Poly1305 (libsodium `crypto_secretbox_easy`) via the audited,
 * zero-dependency `@noble/ciphers`:
 *   - a 32-byte key, derived from the host machine identifier (machine-bound — D-2);
 *   - a RANDOM 24-byte nonce per write (D-1) — never reused;
 *   - COMBINED mode: the ciphertext carries the Poly1305 tag, so decryption AUTHENTICATES.
 *     A wrong key (e.g. `.secrets/` copied to another host — a-AC-3) or a tampered byte
 *     fails the tag and {@link decrypt} returns a typed FAILURE, never plaintext garbage.
 *
 * ── The no-leak discipline (the whole PRD's thesis) ──────────────────────────
 * This module NEVER logs a key, a nonce-with-key, or a plaintext. The derived key is a
 * transient `Uint8Array` held only by the caller (the store, for one op). There is no
 * `console.*` anywhere in this file by design.
 *
 * ── Key derivation (D-2, documented choice) ──────────────────────────────────
 * `deriveKey(machineId, scope)` = HKDF-SHA256(ikm = machineId bytes, salt = APP_SALT,
 * info = "honeycomb.secrets.v1|org|workspace|agentId", length = 32). HKDF (RFC 5869)
 * is the right primitive for turning a non-uniform identifier into a uniform 32-byte
 * key. Folding the SCOPE into the `info` means a different org/workspace/agent derives a
 * DIFFERENT key — so a secret encrypted under one scope cannot be decrypted under
 * another even on the same host (defense-in-depth on top of the per-scope directory).
 * The fixed `APP_SALT` domain-separates Honeycomb's secrets from any other HKDF use of
 * the same machine id.
 */

import { hkdfSync } from "node:crypto";
import { xsalsa20poly1305 } from "@noble/ciphers/salsa.js";
import { randomBytes } from "node:crypto";

import type { SecretRecord, SecretScope } from "./contracts.js";

/** The XSalsa20-Poly1305 key length (libsodium `crypto_secretbox_KEYBYTES`). */
export const KEY_BYTES = 32;
/** The XSalsa20-Poly1305 nonce length (libsodium `crypto_secretbox_NONCEBYTES`). */
export const NONCE_BYTES = 24;

/**
 * The fixed application salt for HKDF (D-2). Domain-separates Honeycomb's machine-bound
 * secret key from any other derivation over the same machine id. NOT a secret (HKDF's
 * salt is public by design); it only needs to be stable and app-specific.
 */
const APP_SALT = Buffer.from("honeycomb.secrets.hkdf.salt.v1", "utf8");

/** The HKDF `info` version prefix. Bumping it would intentionally invalidate all keys (re-key). */
const KEY_INFO_VERSION = "honeycomb.secrets.v1";

/**
 * Derive the 32-byte XSalsa20-Poly1305 key for a `(machineId, scope)` pair (D-2 / FR-4).
 *
 * HKDF-SHA256 with the machine id as IKM, the fixed app salt, and a scope-folded `info`
 * string. A different machine id → a different key (machine binding, a-AC-3); a different
 * scope → a different key (cross-scope isolation). The result is a fresh `Uint8Array`
 * the caller uses transiently and lets go of — it is never stored or logged.
 */
export function deriveKey(machineId: string, scope: SecretScope): Uint8Array {
	const ikm = Buffer.from(machineId, "utf8");
	const info = Buffer.from(
		`${KEY_INFO_VERSION}|org:${scope.org}|ws:${scope.workspace}|agent:${scope.agentId ?? ""}`,
		"utf8",
	);
	// hkdfSync returns an ArrayBuffer; wrap it in a Uint8Array view (no copy of bytes).
	const out = hkdfSync("sha256", ikm, APP_SALT, info, KEY_BYTES);
	return new Uint8Array(out);
}

/** The encrypted output of {@link encrypt} — the two cipher fields of a {@link SecretRecord}. */
export interface Encrypted {
	/** The random 24-byte nonce, base64. */
	readonly nonce: string;
	/** The combined XSalsa20-Poly1305 ciphertext+tag, base64. */
	readonly ciphertext: string;
}

/**
 * Encrypt a plaintext value under a derived key (D-1 / FR-3). Generates a FRESH random
 * 24-byte nonce for this write, runs XSalsa20-Poly1305 in combined mode, and returns the
 * base64 nonce + ciphertext. The nonce is random per call, so two encryptions of the same
 * value under the same key produce different ciphertexts (no equality oracle).
 *
 * The `key` MUST be 32 bytes (a {@link deriveKey} result); a wrong-length key throws
 * before any cipher runs (fail-closed).
 */
export function encrypt(plaintext: string, key: Uint8Array): Encrypted {
	if (key.length !== KEY_BYTES) {
		throw new Error(`secrets.encrypt: key must be ${KEY_BYTES} bytes`);
	}
	const nonce = randomBytes(NONCE_BYTES);
	const box = xsalsa20poly1305(key, new Uint8Array(nonce));
	const ct = box.encrypt(new TextEncoder().encode(plaintext));
	return {
		nonce: Buffer.from(nonce).toString("base64"),
		ciphertext: Buffer.from(ct).toString("base64"),
	};
}

/** The typed result of {@link decrypt}: a value on success, or a fail-closed `ok: false`. */
export type DecryptResult = { readonly ok: true; readonly value: string } | { readonly ok: false; readonly reason: string };

/**
 * Decrypt a {@link SecretRecord}'s ciphertext under a derived key (FR-3 / a-AC-3).
 *
 * Returns `{ ok: true, value }` ONLY when the Poly1305 tag verifies. A WRONG key (the
 * machine-bound key differs because `.secrets/` was copied to another host — a-AC-3), a
 * tampered ciphertext, or a malformed base64 field returns `{ ok: false, reason }` —
 * NEVER plaintext garbage and never a throw the caller might forget to catch. The reason
 * is a short classifier (`auth_failed` / `malformed`), never the key or any plaintext.
 *
 * The key MUST be 32 bytes; a wrong-length key returns a fail-closed result rather than
 * attempting a decrypt.
 */
export function decrypt(record: Pick<SecretRecord, "nonce" | "ciphertext">, key: Uint8Array): DecryptResult {
	if (key.length !== KEY_BYTES) {
		return { ok: false, reason: "malformed" };
	}
	let nonce: Buffer;
	let ct: Buffer;
	try {
		nonce = Buffer.from(record.nonce, "base64");
		ct = Buffer.from(record.ciphertext, "base64");
	} catch {
		return { ok: false, reason: "malformed" };
	}
	if (nonce.length !== NONCE_BYTES || ct.length === 0) {
		return { ok: false, reason: "malformed" };
	}
	try {
		const box = xsalsa20poly1305(key, new Uint8Array(nonce));
		// `decrypt` throws on a Poly1305 tag mismatch — i.e. a wrong (different-host) key
		// or a tampered ciphertext. We translate the throw into a typed failure so the
		// caller can NEVER mistake a forgery for a value.
		const pt = box.decrypt(new Uint8Array(ct));
		return { ok: true, value: new TextDecoder().decode(pt) };
	} catch {
		// Authentication failed: wrong key (machine-bound key differs — a-AC-3) or tamper.
		return { ok: false, reason: "auth_failed" };
	}
}
