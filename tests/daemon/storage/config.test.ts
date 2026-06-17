/**
 * PRD-002a config + redaction unit suite (FR-2, FR-4 clamp, FR-8).
 *
 * Direct tests of the zod config boundary and the redaction helper, separate
 * from the client behaviour suite so a config-shape regression is pinpointed.
 */

import { describe, expect, it } from "vitest";
import {
	DEFAULT_QUERY_TIMEOUT_MS,
	envCredentialProvider,
	redactToken,
	resolveStorageConfig,
	StorageConfigError,
} from "../../../src/daemon/storage/config.js";
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
