/**
 * PRD-021c + PRD-023 Wave 3 — the hook `CredentialReader` (the shared-creds repoint, AC-named).
 *
 * Verification posture: temp `~/.deeplake` + `~/.honeycomb` dirs + an injected env. NO real home dir.
 * The reader is a SELF-CONTAINED thin client (it imports nothing from `daemon/storage` or the daemon
 * runtime) — `tests/daemon/storage/invariant.test.ts` enforces that boundary separately; this file
 * proves the read behavior.
 *
 * PRD-023 repoint: the reader now reads the SHARED `~/.deeplake/credentials.json` first (Hivemind
 * shape — the workspace is the `workspaceId` field), falling back to the legacy
 * `~/.honeycomb/credentials.json` (old shape — the workspace is `workspace`). This is what lets a
 * `honeycomb login` OR a `hivemind login` credential flow through to the capture/hook path.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { createCredentialReader } from "../../../src/hooks/shared/credential-reader.js";

/** Write a credentials.json into `dir` (created if needed). */
function writeCreds(dir: string, body: Record<string, unknown>): void {
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "credentials.json"), `${JSON.stringify(body, null, 2)}\n`);
}

let sharedDir: string;
let legacyDir: string;
beforeEach(() => {
	const root = mkdtempSync(join(tmpdir(), "hc-credreader-"));
	sharedDir = join(root, ".deeplake");
	legacyDir = join(root, ".honeycomb");
});
afterEach(() => {
	rmSync(join(sharedDir, ".."), { recursive: true, force: true });
});

describe("PRD-023: the reader reads the SHARED ~/.deeplake file (workspaceId field)", () => {
	it("maps the Hivemind shape (workspaceId → workspace, orgId → org, agentId → actor)", async () => {
		writeCreds(sharedDir, {
			token: "dl-shared-token",
			orgId: "org-acme",
			orgName: "Acme Inc",
			userName: "Ada",
			workspaceId: "ws-backend",
			agentId: "agent-3",
			apiUrl: "https://api.deeplake.ai",
			savedAt: "2026-06-20T00:00:00.000Z",
		});
		const reader = createCredentialReader({ dir: sharedDir, legacyDir, env: {} });
		const cred = await reader.read();
		expect(cred).toBeDefined();
		expect(cred?.token).toBe("dl-shared-token");
		expect(cred?.org).toBe("org-acme");
		// The Hivemind `workspaceId` is read as the hook's workspace (not dropped to `default`).
		expect(cred?.workspace).toBe("ws-backend");
		expect(cred?.actor).toBe("agent-3");
	});

	it("the env token wins over the file token (parity with the daemon-side store)", async () => {
		writeCreds(sharedDir, { token: "dl-file-token", orgId: "org-x", workspaceId: "ws-1" });
		const reader = createCredentialReader({ dir: sharedDir, legacyDir, env: { HONEYCOMB_TOKEN: "dl-env-token" } });
		const cred = await reader.read();
		expect(cred?.token).toBe("dl-env-token");
		expect(cred?.workspace).toBe("ws-1");
	});
});

describe("PRD-023: legacy ~/.honeycomb read-fallback (workspace field)", () => {
	it("falls back to the legacy file (workspace field) when the shared file is absent", async () => {
		writeCreds(legacyDir, {
			token: "dl-legacy-token",
			orgId: "org-legacy",
			orgName: "Legacy Org",
			workspace: "legacy-ws",
			agentId: "agent-legacy",
			savedAt: "2025-01-01T00:00:00.000Z",
		});
		const reader = createCredentialReader({ dir: sharedDir, legacyDir, env: {} });
		const cred = await reader.read();
		expect(cred).toBeDefined();
		expect(cred?.token).toBe("dl-legacy-token");
		expect(cred?.org).toBe("org-legacy");
		// The legacy `workspace` field is read as the hook's workspace.
		expect(cred?.workspace).toBe("legacy-ws");
		expect(cred?.actor).toBe("agent-legacy");
	});

	it("the shared ~/.deeplake file WINS when both exist", async () => {
		writeCreds(sharedDir, { token: "dl-shared", orgId: "org-shared", workspaceId: "ws-shared" });
		writeCreds(legacyDir, { token: "dl-legacy", orgId: "org-legacy", workspace: "ws-legacy", orgName: "L", agentId: "a", savedAt: "x" });
		const reader = createCredentialReader({ dir: sharedDir, legacyDir, env: {} });
		const cred = await reader.read();
		expect(cred?.token).toBe("dl-shared");
		expect(cred?.org).toBe("org-shared");
		expect(cred?.workspace).toBe("ws-shared");
	});
});

describe("fail-soft: never a throw", () => {
	it("returns undefined when neither file exists", async () => {
		const reader = createCredentialReader({ dir: sharedDir, legacyDir, env: {} });
		expect(await reader.read()).toBeUndefined();
	});

	it("falls through a malformed shared file to the legacy file", async () => {
		mkdirSync(sharedDir, { recursive: true });
		writeFileSync(join(sharedDir, "credentials.json"), "{ not json");
		writeCreds(legacyDir, { token: "dl-legacy", orgId: "org-legacy", workspace: "ws", orgName: "L", agentId: "a", savedAt: "x" });
		const reader = createCredentialReader({ dir: sharedDir, legacyDir, env: {} });
		const cred = await reader.read();
		expect(cred?.token).toBe("dl-legacy");
	});

	it("returns undefined for a token-less file (a credential with no token is unusable)", async () => {
		writeCreds(sharedDir, { orgId: "org-x", workspaceId: "ws-1" });
		const reader = createCredentialReader({ dir: sharedDir, legacyDir, env: {} });
		expect(await reader.read()).toBeUndefined();
	});
});
