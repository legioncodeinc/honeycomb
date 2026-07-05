/*
 * Honeycomb - a cross-harness AI memory system.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

/**
 * PRD-073d — `honeycomb login` explicit tenancy (AC-named).
 *
 * The CLI honors the no-silent-guess contract: a non-TTY multi-tenancy account with no flags REFUSES
 * with an org-listing error (nothing written); `--org`/`--workspace` resolve by name or id; a TTY
 * prompts a numbered picker; a single-org+single-workspace account auto-selects and prints the choice;
 * env pins select. Driven with a fake fetch + injected `isTTY`/`prompt` — no real network, browser, or
 * stdin. The token NEVER appears in output (D-4).
 */

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { runAuthCommand } from "../../src/cli/auth.js";
import {
	type AuthFetch,
	type AuthFetchResponse,
	type Clock,
	credentialsPath,
	type DiskCredentials,
	type Sleeper,
} from "../../src/daemon/runtime/auth/index.js";

const FIXED = "2026-07-04T12:00:00.000Z";
const clock: Clock = { now: () => FIXED };
const noWait: Sleeper = (): Promise<void> => Promise.resolve();
const LONG_LIVED = "dl-longlived-CLI";

function json(status: number, body: unknown): AuthFetchResponse {
	return {
		ok: status >= 200 && status < 300,
		status,
		json: () => Promise.resolve(body),
		text: () => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
	};
}

function fakeFetch(opts: {
	orgs: { id: string; name: string }[];
	workspaces: Record<string, { id: string; name: string }[]>;
}): AuthFetch {
	return (url: string, init): Promise<AuthFetchResponse> => {
		const path = url.replace(/^https?:\/\/[^/]+/, "");
		if (path === "/auth/device/code") {
			return Promise.resolve(
				json(200, {
					device_code: "dev",
					user_code: "WXYZ-1234",
					verification_uri: "https://app.deeplake.ai/device",
					verification_uri_complete: "https://app.deeplake.ai/device?code=WXYZ-1234",
					expires_in: 900,
					interval: 5,
				}),
			);
		}
		if (path === "/auth/device/token") return Promise.resolve(json(200, { access_token: "auth0-short" }));
		if (path === "/me")
			return Promise.resolve(json(200, { id: "u-1", name: "Ada Lovelace", email: "ada@deeplake.ai" }));
		if (path === "/organizations") return Promise.resolve(json(200, opts.orgs));
		if (path === "/users/me/tokens") return Promise.resolve(json(200, { token: { token: LONG_LIVED } }));
		if (path === "/workspaces") {
			const org = init?.headers?.["X-Activeloop-Org-Id"] ?? "";
			return Promise.resolve(json(200, { data: opts.workspaces[org] ?? [] }));
		}
		return Promise.resolve(json(404, "x"));
	};
}

const TWO_ORGS = {
	orgs: [
		{ id: "org-a", name: "Acme" },
		{ id: "org-b", name: "Beta" },
	],
	workspaces: {
		"org-a": [{ id: "ws-a1", name: "A-One" }],
		"org-b": [
			{ id: "ws-b1", name: "B-One" },
			{ id: "ws-b2", name: "B-Two" },
		],
	},
};

let dir: string;
beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "hc-auth-tenancy-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

function captured(): { out: (l: string) => void; lines: string[] } {
	const lines: string[] = [];
	return { out: (l) => lines.push(l), lines };
}

describe("073d-AC-2.1: non-TTY, no flags, multi-org → refuse with an org-listing error, nothing written", () => {
	it("exits non-zero and writes NO credential", async () => {
		const cap = captured();
		const res = await runAuthCommand(
			{ command: "login" },
			{
				dir,
				clock,
				env: {},
				out: cap.out,
				fetch: fakeFetch(TWO_ORGS),
				sleep: noWait,
				openBrowser: () => true,
				isTTY: false,
			},
		);
		expect(res.exitCode).toBe(1);
		expect(res.wrote).toBe(false);
		expect(existsSync(credentialsPath(dir))).toBe(false);
		const text = cap.lines.join("\n");
		expect(text).toContain("Acme (org-a)");
		expect(text).toContain("--org");
		expect(text).not.toContain(LONG_LIVED);
	});
});

describe("073d-AC-2.2: --org/--workspace resolve by name or id; unknown values refuse", () => {
	it("resolves --org (name) + --workspace (id), persists + marker, prints the choice", async () => {
		const cap = captured();
		const res = await runAuthCommand(
			{ command: "login", org: "Beta", workspace: "ws-b2" },
			{
				dir,
				clock,
				env: {},
				out: cap.out,
				fetch: fakeFetch(TWO_ORGS),
				sleep: noWait,
				openBrowser: () => true,
				isTTY: false,
			},
		);
		expect(res.exitCode).toBe(0);
		const onDisk = JSON.parse(readFileSync(credentialsPath(dir), "utf8")) as DiskCredentials;
		expect(onDisk.orgId).toBe("org-b");
		expect(onDisk.workspaceId).toBe("ws-b2");
		expect(onDisk.tenancyConfirmedAt).toBe(FIXED);
		expect(cap.lines.join("\n")).not.toContain(LONG_LIVED);
	});

	it("an unknown --org exits non-zero with nothing written", async () => {
		const cap = captured();
		const res = await runAuthCommand(
			{ command: "login", org: "Nope", workspace: "ws-b2" },
			{
				dir,
				clock,
				env: {},
				out: cap.out,
				fetch: fakeFetch(TWO_ORGS),
				sleep: noWait,
				openBrowser: () => true,
				isTTY: false,
			},
		);
		expect(res.exitCode).toBe(1);
		expect(existsSync(credentialsPath(dir))).toBe(false);
	});
});

describe("073d-AC-1: interactive logins choose via a numbered prompt", () => {
	it("prompts org then workspace on a TTY and persists the chosen pair", async () => {
		const cap = captured();
		const answers = ["2", "1"]; // org-b (Beta), then its first workspace ws-b1
		let i = 0;
		const res = await runAuthCommand(
			{ command: "login" },
			{
				dir,
				clock,
				env: {},
				out: cap.out,
				fetch: fakeFetch(TWO_ORGS),
				sleep: noWait,
				openBrowser: () => true,
				isTTY: true,
				prompt: async () => answers[i++] ?? "",
			},
		);
		expect(res.exitCode).toBe(0);
		const onDisk = JSON.parse(readFileSync(credentialsPath(dir), "utf8")) as DiskCredentials;
		expect(onDisk.orgId).toBe("org-b");
		expect(onDisk.workspaceId).toBe("ws-b1");
	});

	it("073d-AC-1.2: --org supplied on a TTY with multiple workspaces → ONLY the workspace prompt renders", async () => {
		// The org half is fixed by the flag, so the org picker must be SKIPPED: exactly one prompt
		// fires, and it is the workspace picker for the flagged org's workspaces.
		const cap = captured();
		const questions: string[] = [];
		const res = await runAuthCommand(
			{ command: "login", org: "org-b" },
			{
				dir,
				clock,
				env: {},
				out: cap.out,
				fetch: fakeFetch(TWO_ORGS),
				sleep: noWait,
				openBrowser: () => true,
				isTTY: true,
				prompt: async (q: string) => {
					questions.push(q);
					return "2"; // pick ws-b2 from org-b's two workspaces
				},
			},
		);
		expect(res.exitCode).toBe(0);
		// Exactly ONE prompt, and it is the workspace picker (the org prompt never rendered).
		expect(questions.length).toBe(1);
		expect(questions[0]).toContain("Select a workspace");
		expect(questions[0]).not.toContain("Select an organization");
		expect(questions[0]).toContain("B-Two (ws-b2)");
		const onDisk = JSON.parse(readFileSync(credentialsPath(dir), "utf8")) as DiskCredentials;
		expect(onDisk.orgId).toBe("org-b");
		expect(onDisk.workspaceId).toBe("ws-b2");
		expect(onDisk.tenancyConfirmedAt).toBe(FIXED);
	});
});

describe("073d-AC-3: single-tenancy + pins stay scriptable", () => {
	it("073d-AC-3.1: single org + single workspace auto-selects and prints 'Using org...'", async () => {
		const cap = captured();
		const single = {
			orgs: [{ id: "org-solo", name: "Solo" }],
			workspaces: { "org-solo": [{ id: "ws-1", name: "Primary" }] },
		};
		const res = await runAuthCommand(
			{ command: "login" },
			{
				dir,
				clock,
				env: {},
				out: cap.out,
				fetch: fakeFetch(single),
				sleep: noWait,
				openBrowser: () => true,
				isTTY: false,
			},
		);
		expect(res.exitCode).toBe(0);
		const onDisk = JSON.parse(readFileSync(credentialsPath(dir), "utf8")) as DiskCredentials;
		expect(onDisk.orgId).toBe("org-solo");
		expect(onDisk.workspaceId).toBe("ws-1");
		expect(cap.lines.join("\n")).toContain("Using org Solo (org-solo), workspace Primary.");
	});

	it("073d-AC-3.2: env pins select non-TTY on a multi-org account", async () => {
		const cap = captured();
		const res = await runAuthCommand(
			{ command: "login" },
			{
				dir,
				clock,
				env: { HONEYCOMB_ORG_ID: "org-a", HONEYCOMB_WORKSPACE_ID: "ws-a1" },
				out: cap.out,
				fetch: fakeFetch(TWO_ORGS),
				sleep: noWait,
				openBrowser: () => true,
				isTTY: false,
			},
		);
		expect(res.exitCode).toBe(0);
		const onDisk = JSON.parse(readFileSync(credentialsPath(dir), "utf8")) as DiskCredentials;
		expect(onDisk.orgId).toBe("org-a");
		expect(onDisk.workspaceId).toBe("ws-a1");
	});

	it("headless --token obeys the same matrix: multi-org non-TTY no flags refuses", async () => {
		const cap = captured();
		const res = await runAuthCommand(
			{ command: "login", token: "byo-long-lived" },
			{ dir, clock, env: {}, out: cap.out, fetch: fakeFetch(TWO_ORGS), sleep: noWait, isTTY: false },
		);
		expect(res.exitCode).toBe(1);
		expect(existsSync(credentialsPath(dir))).toBe(false);
	});
});
