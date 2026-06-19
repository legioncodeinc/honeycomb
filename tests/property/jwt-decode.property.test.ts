/**
 * PROPERTY / FUZZ tests — the token decode behind `healDriftedOrgToken`
 * (`verifyTokenClaims` in `src/daemon/runtime/auth/contracts.ts`).
 *
 * Session start runs `healDriftedOrgToken` → `healOrgDrift`, which decodes the stored token via
 * `verifyTokenClaims` and, ONLY on a verified org-claim mismatch, re-mints + realigns the org.
 * The security floor that protects that path is the decoder's totality + fail-closed contract:
 *
 *   1. For ANY token string — garbage, truncated, wrong segment count, oversized, valid-shape /
 *      wrong-claims — the decode NEVER throws (a throw would fork every call site into
 *      swallow-or-crash; `healOrgDrift` relies on a typed null, not a try/catch).
 *   2. A malformed / unverifiable token yields `null` ("cannot decode → no drift"), NEVER a
 *      partially-trusted claim set an attacker could use to drive an org switch.
 *   3. When it DOES return claims, `org` is a non-empty trimmed string — `healOrgDrift` compares
 *      `claims.org` to the active org, so a blank/whitespace org could never silently "align" or
 *      mis-drive a re-mint.
 *
 * `verifyTokenClaims` is pure + total by contract; we fuzz it with arbitrary strings, structured
 * "almost valid" tokens, and the documented `STUB_TOKEN_PREFIX + base64url(JSON)` shape with
 * hostile claim payloads (prototype-pollution keys, wrong types, oversized).
 *
 * Seeded + anchored with the hostile token shapes.
 */

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { STUB_TOKEN_PREFIX, encodeStubToken, verifyTokenClaims } from "../../src/daemon/runtime/auth/contracts.js";

const NUM_RUNS = 1000;
const SEED = 0x10_8e_d_e;

/** Build a token in the documented stub shape from an arbitrary JSON-stringifiable body. */
function stubToken(bodyJson: string): string {
	return STUB_TOKEN_PREFIX + Buffer.from(bodyJson, "utf8").toString("base64url");
}

/** A generator of "looks like a token but is hostile" strings. */
const malformedToken = fc.oneof(
	// Pure garbage / arbitrary unicode.
	fc.string(),
	fc.string({ unit: "binary" }),
	// Wrong / missing prefix.
	fc.string().map((s) => `hcmt.v0.${s}`),
	fc.string().map((s) => `Bearer ${s}`),
	// Right prefix, broken base64url / non-JSON body.
	fc.string().map((s) => STUB_TOKEN_PREFIX + s),
	// Right prefix, base64url of NON-object JSON (array / number / string / null).
	fc.constantFrom("[]", "123", '"org"', "null", "true").map(stubToken),
	// Right prefix, base64url of an object MISSING / blank org.
	fc.constantFrom('{}', '{"org":""}', '{"org":"   "}', '{"org":123}', '{"org":null}').map(stubToken),
	// Truncated / segment-count abuse.
	fc.constantFrom("", ".", "..", "hcmt", "hcmt.v1", "hcmt.v1."),
	// Oversized body (a megabyte of 'A') — must still not throw or hang.
	fc.constant(STUB_TOKEN_PREFIX + "A".repeat(100_000)),
);

/** Hostile claim objects to round-trip through the documented encoder. */
const hostileClaimsBody = fc.oneof(
	fc.constant('{"org":"acme","__proto__":{"role":"admin"}}'),
	fc.constant('{"org":"acme","constructor":{"prototype":{"polluted":true}}}'),
	fc.constant('{"org":"victim-org","role":"admin","project":"../../etc"}'),
	fc.record({ org: fc.string(), role: fc.string(), exp: fc.integer() }).map((o) => JSON.stringify(o)),
);

const HOSTILE_TOKEN_EXAMPLES: [string][] = [
	[""],
	["."],
	["hcmt.v1."],
	["hcmt.v1.!!!notbase64!!!"],
	[stubToken("{}")],
	[stubToken('{"org":""}')],
	[stubToken('{"org":"   "}')],
	[stubToken('{"org":123}')],
	[stubToken("[]")],
	[stubToken("null")],
	[`hcmt.v1.${"A".repeat(50_000)}`],
	["\0\0\0"],
];

describe("property: verifyTokenClaims — NEVER throws, for ANY token string", () => {
	it("any arbitrary string decodes to TokenClaims | null without throwing", () => {
		fc.assert(
			fc.property(fc.oneof(fc.string(), fc.string({ unit: "binary" }), malformedToken), (token) => {
				// The ONLY contract: it returns, it never throws. A throw fails the property.
				const result = verifyTokenClaims(token);
				expect(result === null || typeof result === "object").toBe(true);
			}),
			{ numRuns: NUM_RUNS, seed: SEED, examples: HOSTILE_TOKEN_EXAMPLES },
		);
	});
});

describe("property: a malformed / unverifiable token yields null (no partial trust)", () => {
	it("garbage and almost-valid-but-broken tokens decode to null", () => {
		fc.assert(
			fc.property(malformedToken, (token) => {
				expect(verifyTokenClaims(token)).toBeNull();
			}),
			{ numRuns: NUM_RUNS, seed: SEED, examples: HOSTILE_TOKEN_EXAMPLES },
		);
	});

	it("a token whose body is not an object with a non-empty string org is rejected", () => {
		// Drive the boundary directly: any JSON body that is NOT `{org: <non-empty-trimmed-string>}`
		// must decode to null — never a half-populated claim set the drift heal could act on.
		const nonOrgBody = fc.oneof(
			fc.constant("{}"),
			fc.constant('{"org":""}'),
			fc.constant('{"org":"  \t \n "}'),
			fc.constant('{"org":42}'),
			fc.constant('{"org":false}'),
			fc.constant('{"org":[]}'),
			fc.constant('{"org":{}}'),
			fc.constant('{"notorg":"acme"}'),
			fc.constant("[1,2,3]"),
			fc.constant('"a string"'),
			fc.constant("3.14"),
		);
		fc.assert(
			fc.property(nonOrgBody, (body) => {
				expect(verifyTokenClaims(stubToken(body))).toBeNull();
			}),
			{ numRuns: NUM_RUNS, seed: SEED },
		);
	});
});

describe("property: a decoded non-null claim ALWAYS has a non-empty trimmed org (privilege floor)", () => {
	it("whenever claims come back, org is a non-empty, non-whitespace string", () => {
		// Generate VALID-shaped tokens (incl. prototype-pollution + extra-claim payloads) and assert:
		// the decode either rejects (null) or returns claims whose `org` is safe to compare against
		// the active org. There is no path to a non-null claim with a blank/typed-wrong org.
		const validIshToken = fc.oneof(
			hostileClaimsBody.map(stubToken),
			fc.record({ org: fc.string({ minLength: 1 }) }).map((o) => stubToken(JSON.stringify(o))),
		);
		fc.assert(
			fc.property(validIshToken, (token) => {
				const claims = verifyTokenClaims(token);
				if (claims === null) return; // a fail-closed reject is always acceptable.
				expect(typeof claims.org).toBe("string");
				expect(claims.org.length).toBeGreaterThan(0);
				expect(claims.org.trim()).not.toBe("");
			}),
			{ numRuns: NUM_RUNS, seed: SEED },
		);
	});

	it("a prototype-pollution claim key never pollutes Object.prototype", () => {
		// Decoding `{"org":"x","__proto__":{...}}` must not mutate the global prototype: a decoder
		// that blindly assigned claim keys could escalate. JSON.parse does not pollute, and the
		// decoder copies only known fields — assert the global stays clean across many hostile bodies.
		fc.assert(
			fc.property(hostileClaimsBody, (body) => {
				verifyTokenClaims(stubToken(body));
				// No claim payload may have leaked onto the prototype chain.
				expect(({} as Record<string, unknown>).role).toBeUndefined();
				expect(({} as Record<string, unknown>).polluted).toBeUndefined();
				expect((Object.prototype as Record<string, unknown>).role).toBeUndefined();
				expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
			}),
			{ numRuns: NUM_RUNS, seed: SEED },
		);
	});
});

describe("property: round-trip — a legitimately encoded org claim decodes back to that org", () => {
	it("encodeStubToken(claims) → verifyTokenClaims preserves a non-empty org (no false reject)", () => {
		// The decoder must not be SO strict it rejects a legitimate token: a well-formed org claim
		// round-trips. This guards the heal path from silently treating every token as undecodable
		// (which would be its own failure mode — every session would warn + skip).
		fc.assert(
			fc.property(
				fc.string({ minLength: 1 }).filter((s) => s.trim() !== ""),
				(org) => {
					const decoded = verifyTokenClaims(encodeStubToken({ org }));
					expect(decoded).not.toBeNull();
					expect(decoded?.org).toBe(org);
				},
			),
			{ numRuns: NUM_RUNS, seed: SEED },
		);
	});
});
