/**
 * PRD-012a crypto — machine-bound XSalsa20-Poly1305 (a-AC-3, + round-trip + nonce).
 *
 * Verification posture: pure, no fs, no network. The "different host" AC is modelled by
 * deriving the key from a DIFFERENT machine id — a different id → a different key → the
 * Poly1305 tag fails → `decrypt` returns a typed failure, NEVER plaintext.
 *
 * a-AC-3 a record encrypted under one machine id fails to decrypt under another.
 */

import { describe, expect, it } from "vitest";

import { decrypt, deriveKey, encrypt, KEY_BYTES, NONCE_BYTES } from "../../../../src/daemon/runtime/secrets/crypto.js";
import type { SecretScope } from "../../../../src/daemon/runtime/secrets/contracts.js";

const SCOPE: SecretScope = { org: "acme", workspace: "backend" };

describe("crypto round-trip: encrypt → decrypt yields the original value", () => {
	it("recovers the plaintext under the same machine id + scope", () => {
		const key = deriveKey("machine-A", SCOPE);
		const enc = encrypt("sk-secret-value", key);
		const res = decrypt(enc, key);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.value).toBe("sk-secret-value");
	});

	it("derives a 32-byte key and uses a 24-byte nonce", () => {
		const key = deriveKey("machine-A", SCOPE);
		expect(key.length).toBe(KEY_BYTES);
		const enc = encrypt("v", key);
		expect(Buffer.from(enc.nonce, "base64").length).toBe(NONCE_BYTES);
	});
});

describe("a-AC-3 a DIFFERENT machine id → decrypt FAILS (machine-bound)", () => {
	it("returns ok:false (auth_failed), never plaintext, on the wrong-host key", () => {
		const keyHostA = deriveKey("machine-A", SCOPE);
		const enc = encrypt("OPENAI_API_KEY_VALUE", keyHostA);

		// Simulate the `.secrets/` copy landing on a DIFFERENT host: a different machine id.
		const keyHostB = deriveKey("machine-B", SCOPE);
		const res = decrypt(enc, keyHostB);

		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("auth_failed");
		// The plaintext must NEVER appear in a failed result (no `value` field on failure).
		expect(JSON.stringify(res)).not.toContain("OPENAI_API_KEY_VALUE");
	});

	it("a different SCOPE also derives a different key → decrypt fails (cross-scope isolation)", () => {
		const keyA = deriveKey("machine-A", { org: "acme", workspace: "backend" });
		const enc = encrypt("v", keyA);
		const keyOtherScope = deriveKey("machine-A", { org: "acme", workspace: "frontend" });
		expect(decrypt(enc, keyOtherScope).ok).toBe(false);
	});

	it("an agent-scoped key differs from the workspace-scoped key", () => {
		const wsKey = deriveKey("machine-A", { org: "acme", workspace: "backend" });
		const enc = encrypt("v", wsKey);
		const agentKey = deriveKey("machine-A", { org: "acme", workspace: "backend", agentId: "agent-7" });
		expect(decrypt(enc, agentKey).ok).toBe(false);
	});
});

describe("the nonce is random per write (no equality oracle)", () => {
	it("two encryptions of the same value under the same key differ", () => {
		const key = deriveKey("machine-A", SCOPE);
		const a = encrypt("same-value", key);
		const b = encrypt("same-value", key);
		expect(a.nonce).not.toBe(b.nonce);
		expect(a.ciphertext).not.toBe(b.ciphertext);
		// Both still decrypt back to the same plaintext.
		const ra = decrypt(a, key);
		const rb = decrypt(b, key);
		expect(ra.ok && rb.ok && ra.value === rb.value).toBe(true);
	});
});

describe("tamper + malformed inputs fail closed", () => {
	it("a flipped ciphertext byte fails authentication", () => {
		const key = deriveKey("machine-A", SCOPE);
		const enc = encrypt("v", key);
		const bytes = Buffer.from(enc.ciphertext, "base64");
		bytes[0] = bytes[0] ^ 0xff;
		const res = decrypt({ nonce: enc.nonce, ciphertext: bytes.toString("base64") }, key);
		expect(res.ok).toBe(false);
	});

	it("a malformed (wrong-length) nonce is rejected as malformed", () => {
		const key = deriveKey("machine-A", SCOPE);
		const enc = encrypt("v", key);
		const res = decrypt({ nonce: Buffer.from([1, 2, 3]).toString("base64"), ciphertext: enc.ciphertext }, key);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("malformed");
	});

	it("a wrong-length key is rejected before any cipher runs", () => {
		expect(() => encrypt("v", new Uint8Array(16))).toThrow();
		const res = decrypt({ nonce: Buffer.alloc(NONCE_BYTES).toString("base64"), ciphertext: "AAAA" }, new Uint8Array(16));
		expect(res.ok).toBe(false);
	});
});
