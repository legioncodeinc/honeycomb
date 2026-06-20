/**
 * PRD-023 Wave 3 — `honeycomb whoami` (AC-3, each AC-named).
 *
 * Verification posture: a FAKE `getMe` (the auth-client seam) + a temp credentials dir + an injected
 * env. NO real api.deeplake.ai, NO real `~/.deeplake`. The seeded file is written in Hivemind's EXACT
 * on-disk shape via `saveDiskCredentials`, so the test ALSO proves whoami reads a file `hivemind
 * login` would have written (the cross-tool read at the heart of AC-3).
 *
 * AC-3 whoami prints user / org (name + id) / workspace from a live GET /me; the bearer token NEVER
 *      appears in any output (grep-asserted); not-logged-in → clean message + non-zero exit; a token
 *      that fails /me validation → redacted error + non-zero exit, no token leaked.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	type Clock,
	type DiskCredentials,
	type MeResponse,
	AuthHttpError,
	saveDiskCredentials,
} from "../../src/daemon/runtime/auth/index.js";
import { type WhoamiAuthClient, runWhoamiCommand } from "../../src/cli/whoami.js";

const FIXED = "2026-06-20T12:00:00.000Z";
const TOKEN = "dl-secret-token-ZZZ999-must-never-print";

function clock(): Clock {
	return { now: () => FIXED };
}

/** Seed a Hivemind-shape `~/.deeplake/credentials.json` in the temp dir (the file hivemind writes). */
function seedDisk(dir: string, over: Partial<DiskCredentials> = {}): DiskCredentials {
	const base: DiskCredentials = {
		token: TOKEN,
		orgId: "org-acme-123",
		orgName: "Acme Inc",
		userName: "Ada Lovelace",
		workspaceId: "backend",
		apiUrl: "https://api.deeplake.ai",
		savedAt: "",
		...over,
	};
	return saveDiskCredentials(base, dir, clock());
}

/** A fake auth client whose `getMe` returns a canned identity (or throws to simulate a bad token). */
function fakeClient(me: MeResponse | (() => never)): WhoamiAuthClient {
	return {
		async getMe(token: string): Promise<MeResponse> {
			// Sanity: the seam is handed the file token (never a URL) — the production path matches.
			expect(token).toBe(TOKEN);
			if (typeof me === "function") return me();
			return me;
		},
	};
}

function captured(): { out: (l: string) => void; lines: string[] } {
	const lines: string[] = [];
	return { out: (l: string) => lines.push(l), lines };
}

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-whoami-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("AC-3 whoami prints the authenticated user / org / workspace from GET /me", () => {
	it("prints user, org (name + id), and workspace; NEVER the token", async () => {
		seedDisk(dir);
		const cap = captured();
		const res = await runWhoamiCommand({
			dir,
			env: {},
			out: cap.out,
			client: fakeClient({ id: "u-1", name: "Ada Lovelace", email: "ada@example.com" }),
		});
		expect(res.exitCode).toBe(0);
		const text = cap.lines.join("\n");
		expect(text).toContain("Ada Lovelace");
		expect(text).toContain("Acme Inc");
		expect(text).toContain("org-acme-123");
		expect(text).toContain("backend");
		// D-4: the bearer token string NEVER appears in whoami output.
		expect(text).not.toContain(TOKEN);
	});

	it("reads a file written in Hivemind's EXACT shape (cross-tool read)", async () => {
		// `saveDiskCredentials` writes the same {token,orgId,orgName,userName,workspaceId,apiUrl,savedAt}
		// shape `hivemind login` writes — whoami loads it unchanged. Omit userName to exercise the
		// /me-derived display name path.
		seedDisk(dir, { userName: undefined, orgName: "Hive Org", orgId: "org-hive", workspaceId: "default" });
		const cap = captured();
		const res = await runWhoamiCommand({
			dir,
			env: {},
			out: cap.out,
			client: fakeClient({ id: "u-9", name: "Grace Hopper" }),
		});
		expect(res.exitCode).toBe(0);
		const text = cap.lines.join("\n");
		// The live /me name is used when the file omits userName.
		expect(text).toContain("Grace Hopper");
		expect(text).toContain("Hive Org");
		expect(text).toContain("org-hive");
		expect(text).toContain("default");
		expect(text).not.toContain(TOKEN);
	});
});

describe("AC-3 whoami not-logged-in + invalid-token paths", () => {
	it("prints a clean 'not logged in' message and exits non-zero when no credential exists", async () => {
		const cap = captured();
		const res = await runWhoamiCommand({ dir, env: {}, out: cap.out, client: fakeClient({ id: "x", name: "x" }) });
		expect(res.exitCode).toBe(1);
		const text = cap.lines.join("\n").toLowerCase();
		expect(text).toContain("not logged in");
		expect(text).toContain("honeycomb login");
	});

	it("surfaces a redacted error (non-zero exit) when /me rejects the token; no token leaked", async () => {
		seedDisk(dir);
		const cap = captured();
		const res = await runWhoamiCommand({
			dir,
			env: {},
			out: cap.out,
			client: fakeClient(() => {
				throw new AuthHttpError(401, "auth API 401 for /me: unauthorized");
			}),
		});
		expect(res.exitCode).toBe(1);
		const text = cap.lines.join("\n");
		expect(text.toLowerCase()).toContain("whoami failed");
		// The redacted error carries the status but NEVER the token (D-4).
		expect(text).not.toContain(TOKEN);
	});
});
