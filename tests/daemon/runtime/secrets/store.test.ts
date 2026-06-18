/**
 * PRD-012a store — the `.secrets/` machine-bound store (a-AC-1 / a-AC-2 / a-AC-4 / a-AC-6).
 *
 * Verification posture (EXECUTION_LEDGER): a TEMP base dir + a FAKE MachineKeyProvider +
 * a fixed clock. No real workspace, no real home, no real wall clock. Each `describe` is
 * named after the AC it proves.
 *
 * a-AC-1 a stored secret lands as { nonce, ciphertext } at file 0600, NO plaintext.
 * a-AC-2 listSecretNames returns names ONLY (no value path through the store list).
 * a-AC-4 every op appends a REDACTED NDJSON audit event under .daemon/, no value.
 * a-AC-6 two agents in one workspace are isolated — one lists only its own scope.
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	createFakeMachineKeyProvider,
	type SecretScope,
} from "../../../../src/daemon/runtime/secrets/contracts.js";
import {
	AUDIT_FILE_NAME,
	DAEMON_DIR_NAME,
	SECRET_DIR_MODE,
	SECRET_FILE_MODE,
	SECRETS_DIR_NAME,
	SecretsStore,
	type SecretsClock,
	modeOf,
	scopeSegment,
} from "../../../../src/daemon/runtime/secrets/store.js";

const IS_POSIX = process.platform !== "win32";
const SECRET = "sk-super-secret-OPENAI-value";

function fixedClock(iso: string): SecretsClock {
	return { now: () => iso };
}

let base: string;
function makeStore(id = "machine-A", clock = fixedClock("2026-06-18T00:00:00.000Z")): SecretsStore {
	return new SecretsStore({ baseDir: base, machineKey: createFakeMachineKeyProvider(id), clock });
}

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "hc-secrets-"));
});
afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

const SCOPE: SecretScope = { org: "acme", workspace: "backend" };

describe("a-AC-1 stored secret → { nonce, ciphertext } at 0600, NO plaintext on disk", () => {
	it("writes an encrypted record file with no plaintext value", async () => {
		const store = makeStore();
		const res = await store.setSecret("openai.key", SECRET, SCOPE);
		expect(res.ok).toBe(true);

		const file = join(base, SECRETS_DIR_NAME, scopeSegment(SCOPE), "openai.key");
		expect(existsSync(file)).toBe(true);

		const raw = readFileSync(file, "utf8");
		const parsed = JSON.parse(raw);
		expect(typeof parsed.nonce).toBe("string");
		expect(typeof parsed.ciphertext).toBe("string");
		expect(parsed.createdAt).toBe("2026-06-18T00:00:00.000Z");
		// The plaintext NEVER appears on disk — not as a field, not anywhere in the bytes.
		expect(raw).not.toContain(SECRET);
		expect(parsed.value).toBeUndefined();
		expect(parsed.plaintext).toBeUndefined();
	});

	it.skipIf(!IS_POSIX)("writes the file at 0600 and the scope dir at 0700 (POSIX)", async () => {
		const store = makeStore();
		await store.setSecret("openai.key", SECRET, SCOPE);
		const file = join(base, SECRETS_DIR_NAME, scopeSegment(SCOPE), "openai.key");
		const dir = join(base, SECRETS_DIR_NAME, scopeSegment(SCOPE));
		expect(modeOf(file)).toBe(SECRET_FILE_MODE);
		expect(modeOf(dir)).toBe(SECRET_DIR_MODE);
	});

	it("rejects a path-traversing name (fail-closed, nothing written)", async () => {
		const store = makeStore();
		const res = await store.setSecret("../escape", SECRET, SCOPE);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("invalid_name");
	});
});

describe("a-AC-2 listSecretNames returns NAMES only (never a value)", () => {
	it("lists the stored names, scoped, sorted", async () => {
		const store = makeStore();
		await store.setSecret("alpha", "v1", SCOPE);
		await store.setSecret("beta", "v2", SCOPE);
		const names = store.listSecretNames(SCOPE);
		expect(names).toEqual(["alpha", "beta"]);
		// The list is a string[] of names; no value is reachable through it.
		expect(JSON.stringify(names)).not.toContain("v1");
		expect(JSON.stringify(names)).not.toContain("v2");
	});

	it("returns an empty list for a scope with no secrets", () => {
		const store = makeStore();
		expect(store.listSecretNames({ org: "empty", workspace: "ws" })).toEqual([]);
	});
});

describe("a-AC-6 scope isolation: agent B cannot list agent A's secrets", () => {
	it("each agent in one workspace sees only its own scope", async () => {
		const store = makeStore();
		const agentA: SecretScope = { org: "acme", workspace: "backend", agentId: "agent-A" };
		const agentB: SecretScope = { org: "acme", workspace: "backend", agentId: "agent-B" };

		await store.setSecret("a-only", "va", agentA);
		await store.setSecret("b-only", "vb", agentB);

		expect(store.listSecretNames(agentA)).toEqual(["a-only"]);
		expect(store.listSecretNames(agentB)).toEqual(["b-only"]);
		// A cross-scope delete of B's secret from A's scope is a not_found, not a leak.
		expect(store.deleteSecret("b-only", agentA).ok).toBe(false);
	});

	it("a different org partitions completely", async () => {
		const store = makeStore();
		await store.setSecret("shared-name", "acme-value", { org: "acme", workspace: "w" });
		await store.setSecret("shared-name", "globex-value", { org: "globex", workspace: "w" });
		expect(store.listSecretNames({ org: "acme", workspace: "w" })).toEqual(["shared-name"]);
		expect(store.listSecretNames({ org: "globex", workspace: "w" })).toEqual(["shared-name"]);
	});
});

describe("a-AC-4 every op appends a REDACTED NDJSON audit event (no value)", () => {
	it("appends stored/listed/deleted/resolved events with name+op+scope+ts+outcome, never a value", async () => {
		const store = makeStore();
		await store.setSecret("openai.key", SECRET, SCOPE);
		store.listSecretNames(SCOPE);
		await store.getSecretValue("openai.key", SCOPE);
		store.deleteSecret("openai.key", SCOPE);

		const auditFile = join(base, DAEMON_DIR_NAME, AUDIT_FILE_NAME);
		expect(existsSync(auditFile)).toBe(true);
		const lines = readFileSync(auditFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));

		const ops = lines.map((e) => e.op);
		expect(ops).toContain("stored");
		expect(ops).toContain("listed");
		expect(ops).toContain("resolved_for_exec");
		expect(ops).toContain("deleted");

		for (const e of lines) {
			expect(typeof e.ts).toBe("string");
			expect(e.scope.org).toBe("acme");
			expect(e.outcome).toBeDefined();
			// REDACTION BY CONSTRUCTION: no event carries the value.
			expect(e.value).toBeUndefined();
			expect(e.plaintext).toBeUndefined();
		}
		// The secret value must NOT appear ANYWHERE in the audit log.
		expect(readFileSync(auditFile, "utf8")).not.toContain(SECRET);
	});

	it("a listed event records a COUNT, not the names' values", async () => {
		const store = makeStore();
		await store.setSecret("alpha", "v1", SCOPE);
		store.listSecretNames(SCOPE);
		const auditFile = join(base, DAEMON_DIR_NAME, AUDIT_FILE_NAME);
		const listed = readFileSync(auditFile, "utf8")
			.trim()
			.split("\n")
			.map((l) => JSON.parse(l))
			.filter((e) => e.op === "listed");
		expect(listed.at(-1).count).toBe(1);
	});
});

describe("getSecretValue is the internal decrypt path (round-trips for the resolver)", () => {
	it("decrypts a stored secret under the same machine id", async () => {
		const store = makeStore();
		await store.setSecret("openai.key", SECRET, SCOPE);
		const res = await store.getSecretValue("openai.key", SCOPE);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.value).toBe(SECRET);
	});

	it("a-AC-3 fails to decrypt when the machine id differs (copied to another host)", async () => {
		// Write on host A.
		await makeStore("machine-A").setSecret("openai.key", SECRET, SCOPE);
		// Read on host B (same base dir = the `.secrets/` copy, different machine id).
		const res = await makeStore("machine-B").getSecretValue("openai.key", SCOPE);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("decrypt_failed");
	});

	it("returns not_found for an absent secret, never throws", async () => {
		const res = await makeStore().getSecretValue("nope", SCOPE);
		expect(res.ok).toBe(false);
		if (!res.ok) expect(res.reason).toBe("not_found");
	});
});
