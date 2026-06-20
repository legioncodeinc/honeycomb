/**
 * PRD-002a config + redaction unit suite (FR-2, FR-4 clamp, FR-8).
 *
 * Direct tests of the zod config boundary and the redaction helper, separate
 * from the client behaviour suite so a config-shape regression is pinpointed.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	DEFAULT_QUERY_TIMEOUT_MS,
	deeplakeCredentialsFileProvider,
	defaultCredentialProvider,
	envCredentialProvider,
	redactToken,
	resolveStorageConfig,
	StorageConfigError,
} from "../../../src/daemon/storage/config.js";
import {
	CREDENTIALS_FILE_NAME,
	DEFAULT_DEEPLAKE_API_URL,
	encodeStubToken,
} from "../../../src/daemon/runtime/auth/index.js";
import { fakeCredentialRecord, stubProvider } from "../../helpers/fake-deeplake.js";

describe("a-AC-3 config: zod validation fails closed", () => {
	it("resolves a complete valid record", () => {
		const cfg = resolveStorageConfig(stubProvider(fakeCredentialRecord()));
		expect(cfg.endpoint).toBe("https://fake.deeplake.test");
		expect(cfg.org).toBe("fake-org");
		expect(cfg.queryTimeoutMs).toBe(10_000);
	});

	it("collects every issue when multiple fields are bad", () => {
		try {
			resolveStorageConfig(stubProvider(fakeCredentialRecord({ endpoint: "x", token: "", org: undefined })));
			throw new Error("expected throw");
		} catch (e) {
			expect(e).toBeInstanceOf(StorageConfigError);
			const issues = (e as StorageConfigError).issues;
			expect(issues.length).toBeGreaterThanOrEqual(3);
		}
	});

	it("applies the default timeout when the knob is unset", () => {
		const cfg = resolveStorageConfig(stubProvider(fakeCredentialRecord({ queryTimeoutMs: undefined })));
		expect(cfg.queryTimeoutMs).toBe(DEFAULT_QUERY_TIMEOUT_MS);
	});
});

describe("a-AC-4 config: timeout is clamped non-negative", () => {
	it("clamps a negative value to 0", () => {
		const cfg = resolveStorageConfig(stubProvider(fakeCredentialRecord({ queryTimeoutMs: -100 })));
		expect(cfg.queryTimeoutMs).toBe(0);
	});

	it("falls back to default on a non-numeric value", () => {
		const cfg = resolveStorageConfig(stubProvider(fakeCredentialRecord({ queryTimeoutMs: "abc" })));
		expect(cfg.queryTimeoutMs).toBe(DEFAULT_QUERY_TIMEOUT_MS);
	});

	it("caps an absurdly large value to the 10-minute ceiling", () => {
		const cfg = resolveStorageConfig(stubProvider(fakeCredentialRecord({ queryTimeoutMs: 999_999_999 })));
		expect(cfg.queryTimeoutMs).toBe(600_000);
	});

	it("coerces a numeric string", () => {
		const cfg = resolveStorageConfig(stubProvider(fakeCredentialRecord({ queryTimeoutMs: "250" })));
		expect(cfg.queryTimeoutMs).toBe(250);
	});
});

describe("FR-8 redaction: credential values are never echoed in full", () => {
	it("keeps only the last 4 chars of a token", () => {
		expect(redactToken("tok-abcd1234")).toBe("****1234");
	});

	it("fully masks a short value so length is not leaked", () => {
		expect(redactToken("ab")).toBe("****");
		expect(redactToken("")).toBe("****");
	});
});

describe("FR-2 env provider seam reads HONEYCOMB_DEEPLAKE_*", () => {
	it("maps env vars to the config record and parses the trace flag", () => {
		const provider = envCredentialProvider({
			HONEYCOMB_DEEPLAKE_ENDPOINT: "https://e.test",
			HONEYCOMB_DEEPLAKE_TOKEN: "t",
			HONEYCOMB_DEEPLAKE_ORG: "o",
			HONEYCOMB_DEEPLAKE_WORKSPACE: "w",
			HONEYCOMB_QUERY_TIMEOUT_MS: "1234",
			HONEYCOMB_TRACE_SQL: "1",
		} as NodeJS.ProcessEnv);
		const cfg = resolveStorageConfig(provider);
		expect(cfg.endpoint).toBe("https://e.test");
		expect(cfg.queryTimeoutMs).toBe(1234);
		expect(cfg.traceSql).toBe(true);
	});

	it("treats an unset HONEYCOMB_TRACE_SQL as tracing-off", () => {
		const provider = envCredentialProvider({
			HONEYCOMB_DEEPLAKE_ENDPOINT: "https://e.test",
			HONEYCOMB_DEEPLAKE_TOKEN: "t",
			HONEYCOMB_DEEPLAKE_ORG: "o",
			HONEYCOMB_DEEPLAKE_WORKSPACE: "w",
		} as NodeJS.ProcessEnv);
		expect(resolveStorageConfig(provider).traceSql).toBe(false);
	});
});

// ════════════════════════════════════════════════════════════════════════════
// PRD-023 AC-7 — deeplakeCredentialsFileProvider + env-over-file default.
// Deterministic: a temp `dir` stands in for ~/.deeplake; the real file is untouched.
// ════════════════════════════════════════════════════════════════════════════

/** A stub org-bound token that decodes back to the given org (parity with the store). */
function tokenForOrg(org: string): string {
	return encodeStubToken({ org });
}

/** Write a Hivemind-shape credentials file into a temp shared dir. */
function seedSharedFile(dir: string, over: Record<string, unknown> = {}): void {
	mkdirSync(dir, { recursive: true });
	const file = {
		token: tokenForOrg("acme"),
		orgId: "acme",
		orgName: "Acme Inc",
		userName: "alice",
		workspaceId: "research",
		apiUrl: "https://api.deeplake.ai",
		savedAt: "2026-06-20T00:00:00.000Z",
		...over,
	};
	writeFileSync(join(dir, CREDENTIALS_FILE_NAME), JSON.stringify(file, null, 2));
}

describe("AC-7 deeplakeCredentialsFileProvider maps the shared file → {endpoint,token,org,workspace}", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "hc-cfg-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("maps apiUrl→endpoint, orgId→org, workspaceId→workspace, token→token", () => {
		seedSharedFile(dir, { apiUrl: "https://custom.deeplake.example" });
		const record = deeplakeCredentialsFileProvider({ dir, env: {} }).read();
		expect(record.endpoint).toBe("https://custom.deeplake.example");
		expect(record.token).toBe(tokenForOrg("acme"));
		expect(record.org).toBe("acme");
		expect(record.workspace).toBe("research");
	});

	it("defaults endpoint to the canonical DeepLake URL when the file omits apiUrl", () => {
		// Simulate a legacy file via the fallback dir (no apiUrl on disk).
		const legacyDir = mkdtempSync(join(tmpdir(), "hc-cfg-legacy-"));
		try {
			mkdirSync(legacyDir, { recursive: true });
			writeFileSync(
				join(legacyDir, CREDENTIALS_FILE_NAME),
				JSON.stringify({
					token: tokenForOrg("acme"),
					orgId: "acme",
					orgName: "Acme Inc",
					workspace: "backend",
					agentId: "agent-1",
					savedAt: "2025-01-01T00:00:00.000Z",
				}),
			);
			const record = deeplakeCredentialsFileProvider({ dir, env: {}, legacyDir }).read();
			expect(record.endpoint).toBe(DEFAULT_DEEPLAKE_API_URL);
			expect(record.workspace).toBe("backend"); // legacy workspace → workspace
		} finally {
			rmSync(legacyDir, { recursive: true, force: true });
		}
	});

	it("yields all-undefined fields (never throws) when no file exists", () => {
		const record = deeplakeCredentialsFileProvider({ dir, env: {} }).read();
		expect(record.token).toBeUndefined();
		expect(record.org).toBeUndefined();
		// The schema then fails closed on the required fields.
		expect(() => resolveStorageConfig(deeplakeCredentialsFileProvider({ dir, env: {} }))).toThrow(StorageConfigError);
	});

	it("resolves a VALID StorageConfig from a file alone (the file-supplies-all spine)", () => {
		seedSharedFile(dir);
		const cfg = resolveStorageConfig(deeplakeCredentialsFileProvider({ dir, env: {} }));
		expect(cfg.endpoint).toBe("https://api.deeplake.ai");
		expect(cfg.org).toBe("acme");
		expect(cfg.workspace).toBe("research");
		expect(cfg.token).toBe(tokenForOrg("acme"));
	});
});

describe("AC-7 defaultCredentialProvider: env-over-file, merged per field (the AC-7 spine)", () => {
	let dir: string;
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "hc-cfg-merge-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("with NO env, the file supplies all four → resolveStorageConfig yields a valid config", () => {
		seedSharedFile(dir);
		const cfg = resolveStorageConfig(defaultCredentialProvider({ dir, env: {} as NodeJS.ProcessEnv }));
		expect(cfg.endpoint).toBe("https://api.deeplake.ai");
		expect(cfg.token).toBe(tokenForOrg("acme"));
		expect(cfg.org).toBe("acme");
		expect(cfg.workspace).toBe("research");
	});

	it("a present HONEYCOMB_DEEPLAKE_* value WINS per-field over the file", () => {
		seedSharedFile(dir); // file: endpoint=api.deeplake.ai, org=acme, workspace=research
		const env = {
			HONEYCOMB_DEEPLAKE_ORG: "env-org",
			HONEYCOMB_DEEPLAKE_WORKSPACE: "env-ws",
		} as NodeJS.ProcessEnv;
		const record = defaultCredentialProvider({ dir, env }).read();
		// Env wins for the fields it sets…
		expect(record.org).toBe("env-org");
		expect(record.workspace).toBe("env-ws");
		// …and the file fills the fields env left unset.
		expect(record.endpoint).toBe("https://api.deeplake.ai");
		expect(record.token).toBe(tokenForOrg("acme"));
	});

	it("env fully overrides every field when all four are set (file ignored per-field)", () => {
		seedSharedFile(dir);
		const env = {
			HONEYCOMB_DEEPLAKE_ENDPOINT: "https://env.endpoint.test",
			HONEYCOMB_DEEPLAKE_TOKEN: "env-token",
			HONEYCOMB_DEEPLAKE_ORG: "env-org",
			HONEYCOMB_DEEPLAKE_WORKSPACE: "env-ws",
		} as NodeJS.ProcessEnv;
		const cfg = resolveStorageConfig(defaultCredentialProvider({ dir, env }));
		expect(cfg.endpoint).toBe("https://env.endpoint.test");
		expect(cfg.token).toBe("env-token");
		expect(cfg.org).toBe("env-org");
		expect(cfg.workspace).toBe("env-ws");
	});

	it("env tuning knobs (timeout/trace) flow through even when creds come from the file", () => {
		seedSharedFile(dir);
		const env = {
			HONEYCOMB_QUERY_TIMEOUT_MS: "2500",
			HONEYCOMB_TRACE_SQL: "1",
		} as NodeJS.ProcessEnv;
		const cfg = resolveStorageConfig(defaultCredentialProvider({ dir, env }));
		expect(cfg.queryTimeoutMs).toBe(2500);
		expect(cfg.traceSql).toBe(true);
		// Creds still came from the file.
		expect(cfg.org).toBe("acme");
	});

	it("fails closed when neither env nor file supplies the required fields", () => {
		expect(() => resolveStorageConfig(defaultCredentialProvider({ dir, env: {} as NodeJS.ProcessEnv }))).toThrow(
			StorageConfigError,
		);
	});
});
