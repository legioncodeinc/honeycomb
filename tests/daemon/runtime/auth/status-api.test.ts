/**
 * PRD-044a — the REDACTED `/api/auth/status` read-model.
 *
 * Verification posture: write a credentials file into a temp `~/.deeplake`, mount
 * `mountAuthStatusGroup` onto a bare Hono group, and drive it with `app.request`. The decisive
 * assertions: the body reports the real persisted identity for connected(file)/env/disconnected;
 * the `token` key is ASSERTED ABSENT from the body (the token is sacred); expiry is present only
 * when a real `exp` claim exists and absent otherwise; the loopback read does not trip a role
 * guard (it is a plain GET on the group); and a non-local (mode-gated) request yields a clean
 * disconnected body, never a 500 (OQ-3).
 *
 * AC-1 status renders truthfully (connected file/env + disconnected).
 * AC-3 source + expiry are honest (env vs file; present/absent expiresAt).
 * AC-4 the token is never exposed (asserted absent from every body).
 * OQ-3 mode-gated: non-local → disconnected, never a 500.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeStubToken } from "../../../../src/daemon/runtime/auth/contracts.js";
import { saveCredentials } from "../../../../src/daemon/runtime/auth/credentials-store.js";
import { AUTH_GROUP, mountAuthStatusGroup } from "../../../../src/daemon/runtime/auth/status-api.js";
import type { Credentials } from "../../../../src/daemon/runtime/auth/contracts.js";

const ORG = "org-acme";
const SECRET_TOKEN = "hcmt.v1.DO-NOT-LEAK"; // a clearly-marked sentinel we assert never appears.

let dir: string;

/** Build a stub token bound to ORG, optionally carrying a real `exp` claim. */
function stubToken(exp?: number): string {
	return encodeStubToken({ org: ORG, ...(exp !== undefined ? { exp } : {}) });
}

/** Persist a credentials file into the temp dir (the file `source`). */
function writeCreds(over: Partial<Credentials> = {}): void {
	const creds: Credentials = {
		token: over.token ?? stubToken(),
		orgId: ORG,
		orgName: "Acme Inc",
		workspace: "backend",
		agentId: "agent-7",
		savedAt: "2026-06-22T00:00:00.000Z",
		...over,
	};
	saveCredentials(creds, dir, { now: () => "2026-06-22T00:00:00.000Z" });
}

/** Mount the status read at the real group path so `app.request("/api/auth/status")` routes it. */
function build(mode: "local" | "team", env: NodeJS.ProcessEnv): Hono {
	const root = new Hono();
	const group = new Hono();
	mountAuthStatusGroup(group, mode, { credentialsDir: dir, env });
	root.route(AUTH_GROUP, group);
	return root;
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-auth-status-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("AC-1 / AC-4 connected (file source) — truthful identity, NO token", () => {
	it("reports the persisted org/workspace/agent with source=file and never the token", async () => {
		writeCreds({ token: stubToken() });
		const app = build("local", {}); // no HONEYCOMB_TOKEN → file source.
		const res = await app.request("/api/auth/status");
		expect(res.status).toBe(200);
		const raw = await res.text();
		// THE security property: the token sentinel appears nowhere in the body.
		expect(raw).not.toContain("hcmt.v1.");
		const body = JSON.parse(raw);
		expect(body.connected).toBe(true);
		expect(body.orgId).toBe(ORG);
		expect(body.orgName).toBe("Acme Inc");
		expect(body.workspace).toBe("backend");
		expect(body.agentId).toBe("agent-7");
		expect(body.source).toBe("file");
		expect(body.savedAt).toBe("2026-06-22T00:00:00.000Z");
		// No token field by construction.
		expect(Object.keys(body)).not.toContain("token");
		expect(body.token).toBeUndefined();
	});
});

describe("AC-3 source=env — the HONEYCOMB_TOKEN env source is reported honestly", () => {
	it("reports source=env when HONEYCOMB_TOKEN is set, still no token in the body", async () => {
		writeCreds(); // the file describes the identity; the env token wins for source.
		const app = build("local", { HONEYCOMB_TOKEN: SECRET_TOKEN });
		const res = await app.request("/api/auth/status");
		const raw = await res.text();
		expect(raw).not.toContain(SECRET_TOKEN);
		const body = JSON.parse(raw);
		expect(body.connected).toBe(true);
		expect(body.source).toBe("env");
		expect(body.orgId).toBe(ORG); // the file identity still describes the tenancy.
		expect(body.token).toBeUndefined();
	});
});

describe("AC-3 expiry honesty — present only when a real exp claim exists", () => {
	it("carries expiresAt when the token has an exp claim", async () => {
		const exp = 1_900_000_000;
		writeCreds({ token: stubToken(exp) });
		const app = build("local", {});
		const res = await app.request("/api/auth/status");
		const body = await res.json();
		expect(body.expiresAt).toBe(exp);
	});

	it("OMITS expiresAt when the token has no exp claim (never fabricated)", async () => {
		writeCreds({ token: stubToken() }); // no exp.
		const app = build("local", {});
		const res = await app.request("/api/auth/status");
		const body = await res.json();
		expect(body.expiresAt).toBeUndefined();
		expect(Object.keys(body)).not.toContain("expiresAt");
	});
});

describe("AC-1 disconnected — no credentials resolve", () => {
	it("reports connected=false, source=none, empty identity, no token", async () => {
		// No creds file written → disconnected.
		const app = build("local", {});
		const res = await app.request("/api/auth/status");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.connected).toBe(false);
		expect(body.source).toBe("none");
		expect(body.orgId).toBe("");
		expect(body.token).toBeUndefined();
	});
});

describe("OQ-3 mode-gated — non-local yields a clean disconnected body, never a 500", () => {
	it("team mode returns connected=false/source=none even with a credentials file present", async () => {
		writeCreds(); // a real file exists, but team mode must not surface it here.
		const app = build("team", {});
		const res = await app.request("/api/auth/status");
		expect(res.status).toBe(200); // never a 500.
		const body = await res.json();
		expect(body.connected).toBe(false);
		expect(body.source).toBe("none");
		expect(body.orgId).toBe("");
		expect(body.token).toBeUndefined();
	});
});
