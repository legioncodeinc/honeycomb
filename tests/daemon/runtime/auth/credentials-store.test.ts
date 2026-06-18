/**
 * PRD-011a/011b — CredentialsStore + resolveTenancy (each AC-named).
 *
 * Verification posture (EXECUTION_LEDGER-prd-011): a TEMP credentials dir + a fake
 * clock + an injected env. No real `~/.honeycomb`, no real wall clock, no auth
 * server. Each `describe` is named after the AC it proves so the ledger maps
 * one-to-one to a passing test.
 *
 * a-AC-4 HONEYCOMB_ORG_ID/HONEYCOMB_WORKSPACE_ID override the file.
 * a-AC-5 a file whose orgId disagrees with the JWT org claim is REJECTED.
 * b-AC-3 missing/malformed credentials.json → loadCredentials returns null.
 * b-AC-4 saveCredentials stamps savedAt server-side, ignoring any passed value.
 * b-AC-5 HONEYCOMB_TOKEN set → env token used, file not read for the token.
 * + 0600/0700 perms (b-AC-1), POSIX-guarded.
 */

import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type Clock,
	type Credentials,
	DIR_MODE,
	FILE_MODE,
	TenancyIntegrityError,
	credentialsPath,
	encodeStubToken,
	loadCredentials,
	resolveTenancy,
	saveCredentials,
} from "../../../../src/daemon/runtime/auth/index.js";

const IS_POSIX = process.platform !== "win32";

/** A fixed-instant clock so savedAt is deterministic (b-AC-4). */
function fixedClock(iso: string): Clock {
	return { now: () => iso };
}

/** A stub org-bound token that decodes back to the given org (via verifyTokenClaims). */
function tokenForOrg(org: string, extra: Record<string, unknown> = {}): string {
	return encodeStubToken({ org, ...extra });
}

/** A complete credentials record bound to an org. */
function credsFor(org: string, over: Partial<Credentials> = {}): Credentials {
	return {
		token: tokenForOrg(org),
		orgId: org,
		orgName: `${org} Inc`,
		workspace: "backend",
		agentId: "agent-1",
		savedAt: "2020-01-01T00:00:00.000Z",
		...over,
	};
}

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-creds-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("b-AC-3 missing/malformed credentials.json → loadCredentials returns null", () => {
	it("returns null when the file is absent", () => {
		expect(loadCredentials(dir, {})).toBeNull();
	});

	it("returns null when the file is malformed JSON", () => {
		writeFileSync(credentialsPath(dir), "{ not json");
		expect(loadCredentials(dir, {})).toBeNull();
	});

	it("returns null when the file is structurally incomplete (missing token)", () => {
		writeFileSync(credentialsPath(dir), JSON.stringify({ orgId: "acme" }));
		expect(loadCredentials(dir, {})).toBeNull();
	});

	it("loads a complete record", () => {
		saveCredentials(credsFor("acme"), dir, fixedClock("2026-06-17T00:00:00.000Z"));
		const loaded = loadCredentials(dir, {});
		expect(loaded?.orgId).toBe("acme");
		expect(loaded?.workspace).toBe("backend");
	});
});

describe("b-AC-4 saveCredentials stamps savedAt server-side, ignoring any passed value", () => {
	it("overwrites a caller-supplied savedAt with the clock's now()", () => {
		const stamped = saveCredentials(
			credsFor("acme", { savedAt: "1999-12-31T00:00:00.000Z" }),
			dir,
			fixedClock("2026-06-17T12:00:00.000Z"),
		);
		expect(stamped.savedAt).toBe("2026-06-17T12:00:00.000Z");
		// And it is what landed on disk, not the passed value.
		expect(loadCredentials(dir, {})?.savedAt).toBe("2026-06-17T12:00:00.000Z");
	});
});

describe("b-AC-5 HONEYCOMB_TOKEN set → env token used, file not read for the token", () => {
	it("returns the env token, not the file's token, when HONEYCOMB_TOKEN is set", () => {
		saveCredentials(credsFor("acme", { token: tokenForOrg("acme") }), dir, fixedClock("2026-06-17T00:00:00.000Z"));
		const envToken = tokenForOrg("acme", { agentId: "from-env" });
		const loaded = loadCredentials(dir, { HONEYCOMB_TOKEN: envToken });
		expect(loaded?.token).toBe(envToken);
		// The identity fields still come from the file.
		expect(loaded?.orgId).toBe("acme");
	});
});

describe("b-AC-1 the credentials file is 0600 and its dir is 0700 (POSIX)", () => {
	it.skipIf(!IS_POSIX)("writes the file at 0600 and the dir at 0700", () => {
		saveCredentials(credsFor("acme"), dir, fixedClock("2026-06-17T00:00:00.000Z"));
		const fileMode = statSync(credentialsPath(dir)).mode & 0o777;
		expect(fileMode).toBe(FILE_MODE);
		// The dir we created (mkdtemp) may differ; assert the store creates a fresh
		// sub-dir at 0700 when the dir does not pre-exist.
		const fresh = join(dir, "nested", "deep");
		saveCredentials(credsFor("acme"), fresh, fixedClock("2026-06-17T00:00:00.000Z"));
		const dirMode = statSync(fresh).mode & 0o777;
		expect(dirMode).toBe(DIR_MODE);
	});

	it.skipIf(IS_POSIX)("documents that perms are best-effort on win32 (no assertion)", () => {
		// chmod is a no-op on Windows; the token-at-rest protection is the per-user
		// profile ACL. We still write with the mode option (free on POSIX, ignored here).
		saveCredentials(credsFor("acme"), dir, fixedClock("2026-06-17T00:00:00.000Z"));
		expect(loadCredentials(dir, {})?.orgId).toBe("acme");
	});
});

describe("a-AC-4 HONEYCOMB_ORG_ID/HONEYCOMB_WORKSPACE_ID override the file", () => {
	it("overrides the workspace from the env", () => {
		const creds = credsFor("acme", { workspace: "backend" });
		const resolved = resolveTenancy(creds, { HONEYCOMB_WORKSPACE_ID: "frontend" });
		expect(resolved.workspace).toBe("frontend");
		expect(resolved.org).toBe("acme");
	});

	it("honors HONEYCOMB_ORG_ID only when it agrees with the token claim", () => {
		// The override org must still match the token's bound org (an env var cannot
		// escape the token binding any more than the file can).
		const creds = credsFor("acme");
		const resolved = resolveTenancy(creds, { HONEYCOMB_ORG_ID: "acme" });
		expect(resolved.org).toBe("acme");
	});

	it("rejects a HONEYCOMB_ORG_ID that disagrees with the token claim", () => {
		const creds = credsFor("acme");
		expect(() => resolveTenancy(creds, { HONEYCOMB_ORG_ID: "evilcorp" })).toThrow(TenancyIntegrityError);
	});
});

describe("a-AC-5 a file whose orgId disagrees with the JWT org claim is REJECTED", () => {
	it("throws TenancyIntegrityError when the file claims a different org than the token", () => {
		// The file says org=evilcorp, but the token is bound to org=acme.
		const tampered = credsFor("acme", { orgId: "evilcorp", token: tokenForOrg("acme") });
		expect(() => resolveTenancy(tampered)).toThrow(TenancyIntegrityError);
	});

	it("carries the conflicting org ids on the error (and never the token)", () => {
		const tampered = credsFor("acme", { orgId: "evilcorp", token: tokenForOrg("acme") });
		try {
			resolveTenancy(tampered);
			expect.unreachable("resolveTenancy must throw on org mismatch");
		} catch (err) {
			expect(err).toBeInstanceOf(TenancyIntegrityError);
			const e = err as TenancyIntegrityError;
			expect(e.fileOrg).toBe("evilcorp");
			expect(e.tokenOrg).toBe("acme");
			// The error message must not leak the token string.
			expect(e.message).not.toContain(tampered.token);
		}
	});

	it("rejects an unverifiable token (fail-closed)", () => {
		const bad = credsFor("acme", { token: "not-a-valid-token" });
		expect(() => resolveTenancy(bad)).toThrow(TenancyIntegrityError);
	});

	it("accepts a file whose orgId agrees with the token claim", () => {
		const ok = credsFor("acme", { orgId: "acme", token: tokenForOrg("acme") });
		const resolved = resolveTenancy(ok);
		expect(resolved.org).toBe("acme");
		expect(resolved.workspace).toBe("backend");
	});
});
