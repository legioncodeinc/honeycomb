/**
 * FIX #3 — the tenancy integrity gate must accept a REAL Deeplake JWT.
 *
 * After a real Deeplake device-flow login, `~/.deeplake/credentials.json` holds a
 * STANDARD JWT (`header.payload.signature`, three dot-separated base64url segments),
 * NOT the Wave-1 `hcmt.v1.<base64url(JSON)>` stub shape. The prior `verifyTokenClaims`
 * only accepted the stub, so it returned `null` for every real token and
 * `resolveTenancy` threw `TenancyIntegrityError("token could not be verified")` — which
 * broke `honeycomb project status`, scope resolution, and reported
 * `tenancy:{org:null,workspace:null}` on every real login.
 *
 * The real JWT carries its org under the `org_id` claim (discovered by decoding the
 * actual payload of the token at `~/.deeplake/credentials.json`), with `exp` also
 * present and NO `workspace`/`agentId`/`role`/`project` claim. This suite proves:
 *   - a real JWT decodes to `TokenClaims` with `org` mapped from `org_id` (+ `exp`);
 *   - the stub path is UNCHANGED (still decodes `hcmt.v1.` tokens);
 *   - the decoder stays PURE/TOTAL (malformed JWT → null, never a throw);
 *   - `resolveTenancy` now SUCCEEDS on a real JWT whose `org_id` matches the file's
 *     orgId, and STILL fails-closed (tamper protection) when they disagree — the
 *     file-orgId-vs-token-org agreement check runs against the token-derived org.
 *
 * NOTE: no real token bytes appear here — every JWT is synthesized from public claim
 * shapes with a throwaway `signature` segment.
 */

import { describe, expect, it } from "vitest";

import {
	type Credentials,
	TenancyIntegrityError,
	encodeStubToken,
	resolveTenancy,
	verifyTokenClaims,
} from "../../../../src/daemon/runtime/auth/index.js";

/** Base64url-encode a UTF-8 string (no padding), matching the JWT segment encoding. */
function b64url(s: string): string {
	return Buffer.from(s, "utf8").toString("base64url");
}

/**
 * Synthesize a real-shaped JWT (`header.payload.signature`) from a payload object.
 * The signature segment is an inert throwaway (there is no signing key in this
 * environment; `verifyTokenClaims` decodes the payload integrity-by-shape, as it does
 * for the stub). This mirrors the REAL Deeplake token's claim keys (`org_id`, `exp`).
 */
function realJwt(payload: Record<string, unknown>): string {
	const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
	const body = b64url(JSON.stringify(payload));
	return `${header}.${body}.sig-not-verified`;
}

function credsWith(token: string, orgId: string): Credentials {
	return {
		token,
		orgId,
		orgName: `${orgId} Inc`,
		workspace: "workspace-a",
		agentId: "agent-a",
		savedAt: "2026-07-05T00:00:00.000Z",
	};
}

const REAL_ORG = "4ad849af-c8b5-437f-9271-d62a52afeda2";

describe("FIX #3: verifyTokenClaims decodes a REAL Deeplake JWT (org_id claim)", () => {
	it("maps the JWT `org_id` claim onto TokenClaims.org (+ exp)", () => {
		const token = realJwt({ org_id: REAL_ORG, exp: 1_900_000_000, iat: 1, user_id: "u1", name: "Ada", type: "access" });
		const claims = verifyTokenClaims(token);
		expect(claims).not.toBeNull();
		expect(claims?.org).toBe(REAL_ORG);
		expect(claims?.exp).toBe(1_900_000_000);
	});

	it("still decodes the Wave-1 stub token (org claim path unchanged)", () => {
		const claims = verifyTokenClaims(encodeStubToken({ org: "acme", role: "admin" }));
		expect(claims?.org).toBe("acme");
		expect(claims?.role).toBe("admin");
	});

	it("is pure/total — a malformed JWT decodes to null, never a throw", () => {
		// Wrong segment count, bad base64url payload, non-JSON payload, missing org_id.
		expect(verifyTokenClaims("only.two")).toBeNull();
		expect(verifyTokenClaims("a.b.c.d")).toBeNull();
		expect(verifyTokenClaims("hdr.!!!notbase64!!!.sig")).toBeNull();
		expect(verifyTokenClaims(`hdr.${b64url("not json")}.sig`)).toBeNull();
		expect(verifyTokenClaims(realJwt({ user_id: "u1" }))).toBeNull(); // no org-like claim
		expect(verifyTokenClaims(realJwt({ org_id: "" }))).toBeNull(); // blank org
		expect(verifyTokenClaims(realJwt({ org_id: "   " }))).toBeNull(); // whitespace org
		expect(verifyTokenClaims(realJwt({ org_id: 123 }))).toBeNull(); // wrong type
	});

	it("does NOT let a JWT prototype-pollution claim leak onto the result / prototype", () => {
		const token = realJwt({ org_id: REAL_ORG, __proto__: { role: "admin" } });
		const claims = verifyTokenClaims(token);
		expect(claims?.org).toBe(REAL_ORG);
		// Only known fields are copied; no `role` from a polluted proto key.
		expect(claims?.role).toBeUndefined();
		expect(({} as Record<string, unknown>).role).toBeUndefined();
	});
});

describe("FIX #3: resolveTenancy accepts a real JWT + keeps tamper protection", () => {
	it("resolves the tenancy when the file orgId matches the JWT org_id claim", () => {
		const token = realJwt({ org_id: REAL_ORG, exp: 1_900_000_000 });
		const resolved = resolveTenancy(credsWith(token, REAL_ORG), {});
		expect(resolved.org).toBe(REAL_ORG);
		expect(resolved.workspace).toBe("workspace-a");
	});

	it("STILL fails closed when the file orgId disagrees with the JWT org_id (tamper)", () => {
		// A tampered file claims a different org than the token vouches for → rejected.
		const token = realJwt({ org_id: REAL_ORG });
		expect(() => resolveTenancy(credsWith(token, "evilcorp"), {})).toThrow(TenancyIntegrityError);
	});

	it("STILL fails closed when the JWT carries no decodable org (unverifiable)", () => {
		const token = realJwt({ user_id: "u1" }); // no org_id → verifyTokenClaims returns null
		expect(() => resolveTenancy(credsWith(token, REAL_ORG), {})).toThrow(
			/token could not be verified/,
		);
	});

	it("the HONEYCOMB_ORG_ID override is still checked against the JWT org claim", () => {
		const token = realJwt({ org_id: REAL_ORG });
		// An env override that disagrees with the token org cannot escape the binding.
		expect(() =>
			resolveTenancy(credsWith(token, REAL_ORG), { HONEYCOMB_ORG_ID: "other-org" }),
		).toThrow(TenancyIntegrityError);
	});
});
