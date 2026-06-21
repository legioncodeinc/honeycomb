/**
 * PRD-032a vault core — the multi-class machine-bound vault (AC-1 / AC-2 / AC-3 / AC-7
 * + AC-8 safety).
 *
 * Verification posture (EXECUTION_LEDGER, the PRD-012 seams): a TEMP base dir + a FAKE
 * MachineKeyProvider + a fixed clock. No real workspace, no real home, no real wall clock,
 * no real `~/.deeplake`. Each `describe` is named after the AC it proves.
 *
 * AC-1 a stored record (secret/setting/registered class) lands as { nonce, ciphertext } at
 *      file 0600 / dir 0700, NO plaintext; a DIFFERENT machine key FAILS to decrypt.
 * AC-2 a secret value is never returned by getSetting (posture gate rejects); a setting
 *      round-trips (write→read equal); an invalid setting value is rejected on write.
 * AC-3 migration COPIES the token into the vault, plaintext creds file BYTE-UNCHANGED;
 *      resolution prefers vault, falls back env→file; "vault empty" still resolves.
 * AC-7 a newly registered class round-trips AND the pre-existing secret/setting still
 *      resolve (untouched).
 * AC-8 perms 0600/0700; the audit NDJSON + the API list carry NO secret value.
 */

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";

import { createFakeMachineKeyProvider, type SecretScope } from "../../../../src/daemon/runtime/secrets/contracts.js";
import { SECRET_DIR_MODE, SECRET_FILE_MODE, type SecretsClock, scopeSegment } from "../../../../src/daemon/runtime/secrets/store.js";
import type { DeeplakeCredsReader } from "../../../../src/daemon/runtime/vault/migrate.js";
import {
	DEEPLAKE_TOKEN_NAME,
	migrateDeeplakeToken,
	resolveDeeplakeToken,
} from "../../../../src/daemon/runtime/vault/migrate.js";
import {
	createVaultRegistry,
	type ClassDescriptor,
	type RecordClass,
} from "../../../../src/daemon/runtime/vault/index.js";
import { VAULT_AUDIT_FILE_NAME, VAULT_DIR_NAME, VaultStore } from "../../../../src/daemon/runtime/vault/store.js";

const IS_POSIX = process.platform !== "win32";
const SECRET = "sk-super-secret-ANTHROPIC-value";
const SCOPE: SecretScope = { org: "acme", workspace: "backend" };

function fixedClock(iso: string): SecretsClock {
	return { now: () => iso };
}

let base: string;

function makeStore(id = "machine-A", extra: readonly ClassDescriptor[] = []): VaultStore {
	return new VaultStore({
		baseDir: base,
		machineKey: createFakeMachineKeyProvider(id),
		registry: createVaultRegistry(extra),
		clock: fixedClock("2026-06-21T00:00:00.000Z"),
	});
}

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "hc-vault-"));
});
afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-1 — encrypted at rest, 0600/0700, machine-bound
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-1 records of secret/setting/registered class → encrypted at 0600, no plaintext", () => {
	it("stores a secret as { nonce, ciphertext } under .secrets/ with NO plaintext", async () => {
		const store = makeStore();
		const res = await store.setSecret("ANTHROPIC_API_KEY", SECRET, SCOPE);
		expect(res.ok).toBe(true);

		// Back-compat path: the secret class lives under .secrets/<scope>/<name> (PRD-012).
		const file = join(base, ".secrets", scopeSegment(SCOPE), "ANTHROPIC_API_KEY");
		expect(existsSync(file)).toBe(true);
		const raw = readFileSync(file, "utf8");
		const parsed = JSON.parse(raw);
		expect(typeof parsed.nonce).toBe("string");
		expect(typeof parsed.ciphertext).toBe("string");
		expect(raw).not.toContain(SECRET);
		expect(parsed.value).toBeUndefined();
	});

	it("stores a setting under .vault/setting/ with NO plaintext value on disk", async () => {
		const store = makeStore();
		const res = await store.setSetting("activeProvider", "anthropic", SCOPE);
		expect(res.ok).toBe(true);

		const file = join(base, VAULT_DIR_NAME, "setting", scopeSegment(SCOPE), "activeProvider");
		expect(existsSync(file)).toBe(true);
		const raw = readFileSync(file, "utf8");
		// The setting value ("anthropic") is JSON-serialized then ENCRYPTED — never at rest.
		expect(raw).not.toContain("anthropic");
		const parsed = JSON.parse(raw);
		expect(typeof parsed.ciphertext).toBe("string");
	});

	it("stores a registered throwaway class under .vault/<class>/ with NO plaintext", async () => {
		const PREF_CLASS = "pref" as RecordClass;
		const descriptor: ClassDescriptor<string> = { id: PREF_CLASS, posture: "daemon-readable", schema: z.string() };
		const store = makeStore("machine-A", [descriptor]);
		const res = await store.setRecord(PREF_CLASS, "theme", "midnight", SCOPE);
		expect(res.ok).toBe(true);

		const file = join(base, VAULT_DIR_NAME, "pref", scopeSegment(SCOPE), "theme");
		expect(existsSync(file)).toBe(true);
		expect(readFileSync(file, "utf8")).not.toContain("midnight");
	});

	it.skipIf(!IS_POSIX)("writes the file at 0600 and the class dir at 0700 (POSIX)", async () => {
		const store = makeStore();
		await store.setSetting("dreaming.enabled", true, SCOPE);
		const dir = join(base, VAULT_DIR_NAME, "setting", scopeSegment(SCOPE));
		const file = join(dir, "dreaming.enabled");
		expect(statSync(file).mode & 0o777).toBe(SECRET_FILE_MODE);
		expect(statSync(dir).mode & 0o777).toBe(SECRET_DIR_MODE);
	});

	it("a DIFFERENT machine key fails to decrypt the same bytes (machine-bound)", async () => {
		// Write under machine-A, then read the SAME base dir under machine-B → decrypt fails.
		const a = makeStore("machine-A");
		await a.setSetting("activeModel", "claude-opus-4-8", SCOPE);
		const b = makeStore("machine-B");
		const res = await b.getSetting("activeModel", SCOPE);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("decrypt_failed");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-2 — secret value never returned; setting round-trips; reject secret via setting
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-2 secret value never returned via setting accessor; setting round-trips", () => {
	it("getSecretValue (internal) returns the value; getSetting on the secret class is rejected", async () => {
		const store = makeStore();
		await store.setSecret("ANTHROPIC_API_KEY", SECRET, SCOPE);
		// The internal resolver path decrypts.
		const internal = await store.getSecretValue("ANTHROPIC_API_KEY", SCOPE);
		expect(internal.ok).toBe(true);
		if (internal.ok) expect(internal.value).toBe(SECRET);

		// But the daemon-readable getSetting CANNOT read a secret — even one stored under the
		// SAME name in the secret class. The setting accessor only ever reads the setting class,
		// and the posture gate rejects a secret read. Probe the secret name through getSetting:
		const viaSetting = await store.getSetting("ANTHROPIC_API_KEY", SCOPE);
		// There is no `setting`-class record by this name → not_found (never the secret value).
		expect(viaSetting.ok).toBe(false);
		if (!viaSetting.ok) expect(viaSetting.reason).toBe("not_found");
	});

	it("rejects reading an internal-only class through the daemon-readable accessor (posture gate)", async () => {
		// Register a throwaway internal-only class, then attempt to read it as a setting via the
		// registry posture gate (proves the gate, not just the per-class accessor).
		const registry = createVaultRegistry();
		const gate = registry.assertReadable("secret");
		expect(gate.ok).toBe(false);
		if (!gate.ok) expect(gate.reason).toBe("not_readable");
		const settingGate = registry.assertReadable("setting");
		expect(settingGate.ok).toBe(true);
	});

	it("a setting round-trips: write then read equal (string, boolean)", async () => {
		const store = makeStore();
		await store.setSetting("activeProvider", "anthropic", SCOPE);
		const s = await store.getSetting("activeProvider", SCOPE);
		expect(s.ok && s.value).toBe("anthropic");

		await store.setSetting("dreaming.enabled", true, SCOPE);
		const b = await store.getSetting("dreaming.enabled", SCOPE);
		expect(b.ok && b.value).toBe(true);
	});

	it("rejects an invalid setting value (failing the class zod schema) on write", async () => {
		const store = makeStore();
		// The setting class schema is string|number|boolean; an object is rejected at the boundary.
		const res = await store.setSetting("activeProvider", { nope: 1 } as unknown as string, SCOPE);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("invalid_value");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-3 — migration COPY-not-move, byte-unchanged, resolution chain
// ─────────────────────────────────────────────────────────────────────────────

/** A fake creds reader over a fixed token (no real `~/.deeplake`). */
function fakeReader(token: string | null): DeeplakeCredsReader {
	return {
		read() {
			if (token === null) return null;
			return { token, orgId: "org-acme", savedAt: "2026-06-21T00:00:00.000Z" };
		},
	};
}

describe("AC-3 DeepLake-creds migration is COPY-not-move + resolution vault→env→file", () => {
	it("copies the token into the vault as DEEPLAKE_TOKEN and leaves the plaintext file BYTE-UNCHANGED", async () => {
		// Seed a REAL plaintext creds file in a temp dir and snapshot its bytes.
		const credsDir = mkdtempSync(join(tmpdir(), "hc-deeplake-"));
		const credsFile = join(credsDir, "credentials.json");
		const credsJson = `${JSON.stringify({ token: "dl-live-token-xyz", orgId: "org-acme", savedAt: "2026-06-21T00:00:00.000Z" }, null, 2)}\n`;
		writeFileSync(credsFile, credsJson);
		const before = readFileSync(credsFile); // Buffer snapshot.

		const store = makeStore();
		const reader: DeeplakeCredsReader = {
			read() {
				const parsed = JSON.parse(readFileSync(credsFile, "utf8"));
				return { token: parsed.token, orgId: parsed.orgId, savedAt: parsed.savedAt };
			},
		};
		const res = await migrateDeeplakeToken(store, SCOPE, reader);
		expect(res.ok && res.migrated).toBe(true);

		// The vault now holds the token as a secret-class record.
		const inVault = await store.getSecretValue(DEEPLAKE_TOKEN_NAME, SCOPE);
		expect(inVault.ok && inVault.value).toBe("dl-live-token-xyz");

		// The plaintext file is BYTE-IDENTICAL (never moved/deleted/rewritten/chmod'd).
		const after = readFileSync(credsFile);
		expect(after.equals(before)).toBe(true);
		expect(existsSync(credsFile)).toBe(true);

		rmSync(credsDir, { recursive: true, force: true });
	});

	it("a no-creds path is a NO-OP (migrated:false), never an error, never a vault write", async () => {
		const store = makeStore();
		const res = await migrateDeeplakeToken(store, SCOPE, fakeReader(null));
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.migrated).toBe(false);
		// Nothing written: the vault has no DEEPLAKE_TOKEN.
		const inVault = await store.getSecretValue(DEEPLAKE_TOKEN_NAME, SCOPE);
		expect(inVault.ok).toBe(false);
	});

	it("resolution prefers the VAULT over env + file", async () => {
		const store = makeStore();
		await store.setSecret(DEEPLAKE_TOKEN_NAME, "from-vault", SCOPE);
		const res = await resolveDeeplakeToken(store, SCOPE, {
			env: { HONEYCOMB_TOKEN: "from-env" } as NodeJS.ProcessEnv,
			reader: fakeReader("from-file"),
		});
		expect(res.ok && res.source).toBe("vault");
		expect(res.ok && res.token).toBe("from-vault");
	});

	it("an EMPTY vault falls back to env, then to the plaintext file (no regression)", async () => {
		const store = makeStore();
		// Empty vault + env set → env.
		const envRes = await resolveDeeplakeToken(store, SCOPE, {
			env: { HONEYCOMB_TOKEN: "from-env" } as NodeJS.ProcessEnv,
			reader: fakeReader("from-file"),
		});
		expect(envRes.ok && envRes.source).toBe("env");

		// Empty vault + no env → the plaintext file (the shared login still resolves).
		const fileRes = await resolveDeeplakeToken(store, SCOPE, {
			env: {} as NodeJS.ProcessEnv,
			reader: fakeReader("from-file"),
		});
		expect(fileRes.ok && fileRes.source).toBe("file");
		expect(fileRes.ok && fileRes.token).toBe("from-file");
	});

	it("resolves to not-logged-in only when vault + env + file are ALL empty", async () => {
		const store = makeStore();
		const res = await resolveDeeplakeToken(store, SCOPE, { env: {} as NodeJS.ProcessEnv, reader: fakeReader(null) });
		expect(res.ok).toBe(false);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-7 — register a new class; pre-existing secret/setting still resolve
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-7 a registered class round-trips AND existing secret/setting stay untouched", () => {
	it("registers a new class, writes+reads it, and the secret + setting still resolve", async () => {
		const PROFILE = "profile" as RecordClass;
		const descriptor: ClassDescriptor<string> = { id: PROFILE, posture: "daemon-readable", schema: z.string() };
		const store = makeStore("machine-A", [descriptor]);

		// Pre-existing secret + setting.
		await store.setSecret("ANTHROPIC_API_KEY", SECRET, SCOPE);
		await store.setSetting("activeProvider", "openai", SCOPE);

		// The new class stores + reads (generic accessors).
		const w = await store.setRecord(PROFILE, "nickname", "ace", SCOPE);
		expect(w.ok).toBe(true);
		const names = store.listNames(PROFILE, SCOPE);
		expect(names).toContain("nickname");

		// The pre-existing records are untouched and still resolve.
		const sec = await store.getSecretValue("ANTHROPIC_API_KEY", SCOPE);
		expect(sec.ok && sec.value).toBe(SECRET);
		const set = await store.getSetting("activeProvider", SCOPE);
		expect(set.ok && set.value).toBe("openai");
	});

	it("an unregistered class is rejected on write (fail-closed)", async () => {
		const store = makeStore();
		const res = await store.setRecord("ghost" as RecordClass, "x", "y", SCOPE);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("unknown_class");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// AC-8 — safety: perms + no secret value in the audit NDJSON
// ─────────────────────────────────────────────────────────────────────────────

describe("AC-8 safety: audit NDJSON carries NO secret value", () => {
	it("the vault audit log records names/ops/counts but never a value", async () => {
		const store = makeStore();
		await store.setSecret("ANTHROPIC_API_KEY", SECRET, SCOPE);
		await store.setSetting("activeModel", "claude-opus-4-8", SCOPE);
		store.listSecretNames(SCOPE);
		await store.getSecretValue("ANTHROPIC_API_KEY", SCOPE);

		const auditFile = join(base, ".daemon", VAULT_AUDIT_FILE_NAME);
		expect(existsSync(auditFile)).toBe(true);
		const audit = readFileSync(auditFile, "utf8");
		// The secret value NEVER appears in the audit trail.
		expect(audit).not.toContain(SECRET);
		// But the trail is useful: it records the op + class + name + outcome.
		expect(audit).toContain("resolved_for_exec");
		expect(audit).toContain("ANTHROPIC_API_KEY");
		expect(audit).toContain("\"class\":\"secret\"");
	});

	it("the vault touches NO .vault dir for the secret class (back-compat path)", async () => {
		const store = makeStore();
		await store.setSecret("ANTHROPIC_API_KEY", SECRET, SCOPE);
		// A secret write creates .secrets/ but NOT .vault/ (the secret class is special-cased).
		expect(existsSync(join(base, ".secrets"))).toBe(true);
		expect(existsSync(join(base, VAULT_DIR_NAME))).toBe(false);
	});
});
