/**
 * PRD-021b b-AC-1 / b-AC-4 / b-AC-6 — the CLI-side composition root binds the real seams.
 *
 * Proves with real modules (the loopback client over an injected fetch, the real local TokenIssuer,
 * a temp credentials dir):
 *   - b-AC-1: the real loopback DaemonClient POSTs/GETs `127.0.0.1:3850` and returns real data,
 *     stamping the org/workspace/actor headers from the shared credential.
 *   - b-AC-4: `login` actually writes `~/.honeycomb/credentials.json` at 0600 through the unchanged
 *     011b device flow + the bound real issuer; `healDriftedOrgToken` (011b `healOrgDrift`) corrects
 *     a drifted org token.
 *   - b-AC-6: every seam `buildRuntimeDeps` assembles is bound (no undefined handler seam).
 */

import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	CLI_RUNTIME_PATH,
	createLoopbackDaemonClient,
	isSessionGroupPath,
} from "../../src/commands/index.js";
import {
	buildAuthPassthrough,
	buildDaemonLifecycle,
	buildOrgDriftHealer,
	buildRuntimeDeps,
	canWriteDir,
	resolveDaemonWorkspace,
} from "../../src/cli/runtime.js";
import { buildRealTokenIssuer } from "../../src/cli/token-issuer.js";
import { authMain } from "../../src/cli/auth.js";
import {
	type Credentials,
	type DiskCredentials,
	STUB_TOKEN_PREFIX,
	credentialsPath,
	deviceFlowLogin,
	encodeStubToken,
	loadCredentials,
	loadDiskCredentials,
	saveCredentials,
	saveDiskCredentials,
	systemClock,
} from "../../src/daemon/runtime/auth/index.js";

let dir: string;

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "honeycomb-cli-runtime-"));
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("PRD-021b b-AC-1 — real loopback DaemonClient", () => {
	it("b-AC-1 POSTs to 127.0.0.1:3850 with the credential tenancy headers and returns real data", async () => {
		const seen: { url?: string; method?: string; headers?: Record<string, string>; body?: string } = {};
		const fakeFetch = (async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
			seen.url = url;
			seen.method = init.method;
			seen.headers = init.headers;
			seen.body = init.body;
			return {
				ok: true,
				status: 200,
				async json() {
					return { memories: [{ id: "m1", content: "hi" }] };
				},
			};
		}) as unknown as typeof fetch;

		const client = createLoopbackDaemonClient({
			baseUrl: "http://127.0.0.1:3850",
			headers: { "x-honeycomb-org": "acme", "x-honeycomb-workspace": "default", "x-honeycomb-actor": "agent-1" },
			fetchImpl: fakeFetch,
		});
		const res = await client.send({ method: "POST", path: "/api/memories/recall", body: { query: "x" } });

		expect(seen.url).toBe("http://127.0.0.1:3850/api/memories/recall");
		expect(seen.method).toBe("POST");
		expect(seen.headers?.["x-honeycomb-org"]).toBe("acme");
		expect(seen.headers?.["x-honeycomb-actor"]).toBe("agent-1");
		expect(res.status).toBe(200);
		expect(res.body).toEqual({ memories: [{ id: "m1", content: "hi" }] });
	});

	it("b-AC-1 the loopback client never carries a bearer token in a header value", async () => {
		// The runtime stamps org/workspace/actor only — never the token (the redaction thesis).
		const headerKeys: string[] = [];
		const fakeFetch = (async (_url: string, init: { headers: Record<string, string> }) => {
			headerKeys.push(...Object.keys(init.headers));
			return { ok: true, status: 200, async json() { return {}; } };
		}) as unknown as typeof fetch;
		const client = createLoopbackDaemonClient({
			headers: { "x-honeycomb-org": "acme", "x-honeycomb-workspace": "default", "x-honeycomb-actor": "a" },
			fetchImpl: fakeFetch,
		});
		await client.send({ method: "GET", path: "/api/memories" });
		expect(headerKeys).not.toContain("authorization");
		expect(headerKeys.some((k) => /token/i.test(k))).toBe(false);
	});
});

describe("PRD-022d d-AC-2 / d-AC-3 — the loopback client stamps the session-group headers", () => {
	/** Capture the headers a single send emits over an injected fetch. */
	async function headersFor(path: string, method: "GET" | "POST" = "POST"): Promise<Record<string, string>> {
		let seen: Record<string, string> = {};
		const fakeFetch = (async (_url: string, init: { headers: Record<string, string> }) => {
			seen = init.headers;
			return { ok: true, status: 200, async json() { return {}; } };
		}) as unknown as typeof fetch;
		const client = createLoopbackDaemonClient({
			baseUrl: "http://127.0.0.1:3850",
			headers: { "x-honeycomb-org": "acme", "x-honeycomb-workspace": "default", "x-honeycomb-actor": "agent-1" },
			fetchImpl: fakeFetch,
		});
		await client.send(method === "POST" ? { method, path, body: { query: "x" } } : { method, path });
		return seen;
	}

	it("d-AC-2 a recall (POST /api/memories/recall) stamps BOTH x-honeycomb-runtime-path AND x-honeycomb-session", async () => {
		const headers = await headersFor("/api/memories/recall");
		// The dogfood 400 root cause: these two headers were absent. Both are present now.
		expect(headers["x-honeycomb-runtime-path"]).toBe(CLI_RUNTIME_PATH);
		expect(headers["x-honeycomb-session"]).toBeDefined();
		expect(headers["x-honeycomb-session"].length).toBeGreaterThan(0);
		// The tenancy headers still ride alongside.
		expect(headers["x-honeycomb-org"]).toBe("acme");
	});

	it("d-AC-3 the synthetic session id is a stable-per-process `cli-<pid>-<n>` shape (no Date.now/Math.random)", async () => {
		const headers = await headersFor("/api/memories", "POST");
		expect(headers["x-honeycomb-session"]).toMatch(/^cli-\d+-\d+$/);
	});

	it("d-AC-2 a remember (POST /api/memories) and a /memory browse both get the session headers", async () => {
		const remember = await headersFor("/api/memories", "POST");
		const browse = await headersFor("/memory/cat", "GET");
		for (const h of [remember, browse]) {
			expect(h["x-honeycomb-runtime-path"]).toBe(CLI_RUNTIME_PATH);
			expect(h["x-honeycomb-session"]).toBeDefined();
		}
	});

	it("d-AC-3 a NON-session storage path (/api/goals) carries the tenancy headers but NOT the session headers", async () => {
		const headers = await headersFor("/api/goals", "POST");
		expect(headers["x-honeycomb-org"]).toBe("acme");
		expect(headers["x-honeycomb-runtime-path"]).toBeUndefined();
		expect(headers["x-honeycomb-session"]).toBeUndefined();
	});

	it("d-AC-3 isSessionGroupPath classifies the session groups and excludes the rest", () => {
		expect(isSessionGroupPath("/api/memories")).toBe(true);
		expect(isSessionGroupPath("/api/memories/recall")).toBe(true);
		expect(isSessionGroupPath("/memory")).toBe(true);
		expect(isSessionGroupPath("/memory/cat")).toBe(true);
		// Not a session group: a path that merely shares a prefix word must not match.
		expect(isSessionGroupPath("/api/goals")).toBe(false);
		expect(isSessionGroupPath("/api/memories-archive")).toBe(false);
		expect(isSessionGroupPath("/health")).toBe(false);
	});

	it("d-AC-3 a caller-supplied runtime-path/session override wins over the synthetic stamp", async () => {
		let seen: Record<string, string> = {};
		const fakeFetch = (async (_url: string, init: { headers: Record<string, string> }) => {
			seen = init.headers;
			return { ok: true, status: 200, async json() { return {}; } };
		}) as unknown as typeof fetch;
		const client = createLoopbackDaemonClient({
			headers: { "x-honeycomb-org": "acme", "x-honeycomb-runtime-path": "plugin", "x-honeycomb-session": "fixed-1" },
			fetchImpl: fakeFetch,
		});
		await client.send({ method: "POST", path: "/api/memories/recall", body: { query: "x" } });
		expect(seen["x-honeycomb-runtime-path"]).toBe("plugin");
		expect(seen["x-honeycomb-session"]).toBe("fixed-1");
	});
});

describe("PRD-021b b-AC-4 — login writes 0600 + drift heal", () => {
	it("b-AC-4 the real device flow writes credentials.json at 0600 via the bound local issuer", async () => {
		// The bound real issuer (local single-user mode) mints a REAL verifiable token; the unchanged
		// 011b deviceFlowLogin persists it at 0600. We drive deviceFlowLogin into the temp dir.
		const issuer = buildRealTokenIssuer({ HONEYCOMB_ORG_ID: "acme" } as NodeJS.ProcessEnv);
		const creds = await deviceFlowLogin({ issuer, dir, clock: systemClock });
		expect(creds.orgId).toBe("acme");

		const path = credentialsPath(dir);
		// The file exists and (on POSIX) carries mode 0600.
		const st = statSync(path);
		if (process.platform !== "win32") {
			expect(st.mode & 0o777).toBe(0o600);
		}
		// The token round-trips: it is a real, verifiable credential, not a placeholder.
		const onDisk = loadCredentials(dir);
		expect(onDisk).not.toBeNull();
		expect(onDisk?.orgId).toBe("acme");
	});

	it("b-AC-4 the auth passthrough routes `login` to the PRD-023 device flow (injected)", async () => {
		// PRD-023: authMain `login` now runs the real api.deeplake.ai device flow. We inject a fake
		// `flows.deviceFlow` that writes a real disk credential to the temp dir — proving the CLI seam
		// routes to the device flow and persists, without a network call.
		const lines: string[] = [];
		const result = await authMain(["login"], {
			dir,
			out: (l) => lines.push(l),
			flows: {
				deviceFlow: async (d) =>
					saveDiskCredentials(
						{
							token: "deeplake-real-token-xyz",
							orgId: "acme",
							orgName: "Acme Inc",
							userName: "ada",
							workspaceId: "default",
							apiUrl: "https://api.deeplake.ai",
							savedAt: "",
						},
						d.dir,
						d.clock,
					),
				tokenLogin: async () => {
					throw new Error("token login not exercised here");
				},
			},
		});
		expect(result.exitCode).toBe(0);
		expect(result.wrote).toBe(true);
		expect(loadCredentials(dir)?.orgId).toBe("acme");
		// The bearer token is never printed.
		expect(lines.join("\n")).not.toContain("deeplake-real-token-xyz");
	});

	it("C-1 the drift healer NEVER stub-clobbers a REAL shared credential — it surfaces the drift instead", async () => {
		// THE FOOTGUN (C-1): a REAL `~/.deeplake/credentials.json` (real `apiUrl`, an opaque real
		// `api.deeplake.ai` bearer token — NOT the `hcmt.v1.` stub shape) bound to org `old`, with a
		// drifted desired org `new` from the env override. The OLD behavior re-minted via the local
		// STUB issuer and OVERWROTE the shared file with a stub token, silently breaking real DeepLake
		// auth for BOTH Honeycomb and Hivemind. The fix: on a real-backend credential the healer must
		// re-mint a real token via the real client (fix #1) OR leave the file intact and surface the
		// drift (fix #2). We took fix #2, so the on-disk token MUST be byte-identical to the seeded real
		// token and MUST NOT be the stub-encoded form.
		const realToken = "deeplake-real-opaque-token-do-not-clobber";
		const realDisk: DiskCredentials = {
			token: realToken,
			orgId: "old",
			orgName: "Old Org",
			userName: "ada",
			workspaceId: "default",
			apiUrl: "https://api.deeplake.ai", // the REAL backend — the shared credential.
			savedAt: "",
		};
		saveDiskCredentials(realDisk, dir, systemClock);

		process.env.HONEYCOMB_ORG_ID = "new";
		try {
			// The internal `Credentials` passed in mirrors the seeded disk record (its `apiUrl` is dropped
			// by the in-memory shape; the healer re-reads the raw disk record to see the real `apiUrl`).
			const seededInternal: Credentials = {
				token: realToken,
				orgId: "old",
				orgName: "Old Org",
				workspace: "default",
				agentId: "default",
				savedAt: "",
			};
			const drift = buildOrgDriftHealer(seededInternal, dir);
			const outcome = await drift.heal();

			// The heal NEVER re-mints/persists over a real-backend credential. An OPAQUE real token cannot
			// be decoded offline (only `hcmt.v1.` stub tokens verify), so the drift is not even detectable
			// here — but the guard still REFUSES to mint a stub: the outcome is a non-clobbering no-op
			// (`aligned`), never `healed`. The hard guarantee is the on-disk invariant asserted below.
			expect(outcome.kind).not.toBe("healed");

			// THE INVARIANT: the shared file's token is UNCHANGED and is NOT a stub-minted token.
			const afterDisk = loadDiskCredentials(dir);
			expect(afterDisk).not.toBeNull();
			expect(afterDisk?.token).toBe(realToken);
			expect(afterDisk?.token.startsWith(STUB_TOKEN_PREFIX)).toBe(false);
			// The org binding on disk is likewise untouched (no silent realignment over a stub).
			expect(afterDisk?.orgId).toBe("old");
			expect(afterDisk?.apiUrl).toBe("https://api.deeplake.ai");
		} finally {
			delete process.env.HONEYCOMB_ORG_ID;
		}
	});

	it("C-1 a real-backend, VERIFIABLE token that drifts is surfaced — the shared file is not stub-clobbered", async () => {
		// A verifiable (stub-shaped) token bound to org `old` persisted via `saveCredentials`, which
		// writes the REAL `apiUrl` (`https://api.deeplake.ai`) into the shared file. Even though the
		// token IS verifiable (so the drift is unambiguously detectable), the healer must NOT re-mint a
		// fresh stub for `new` over the shared real-backend credential — it surfaces the drift and leaves
		// the seeded token byte-for-byte intact.
		const driftedToken = encodeStubToken({ org: "old", workspace: "default", agentId: "default" });
		const drifted: Credentials = {
			token: driftedToken,
			orgId: "old",
			orgName: "old",
			workspace: "default",
			agentId: "default",
			savedAt: "",
		};
		saveCredentials(drifted, dir, systemClock); // writes apiUrl = https://api.deeplake.ai

		process.env.HONEYCOMB_ORG_ID = "new";
		try {
			const drift = buildOrgDriftHealer(drifted, dir);
			const outcome = await drift.heal();
			expect(outcome.kind).toBe("drift-surfaced");

			// The on-disk token is the SEEDED `old`-bound token — NOT a re-minted `new`-bound stub.
			const afterDisk = loadDiskCredentials(dir);
			expect(afterDisk?.token).toBe(driftedToken);
			// And explicitly NOT the stub form a re-mint for `new` would have produced.
			const reMintedForNew = encodeStubToken({ org: "new", workspace: "default", agentId: "default" });
			expect(afterDisk?.token).not.toBe(reMintedForNew);
			expect(afterDisk?.orgId).toBe("old");
		} finally {
			delete process.env.HONEYCOMB_ORG_ID;
		}
	});

	it("C-1 the LOCAL/stub heal path is preserved — a NON-real-backend credential still heals on drift", async () => {
		// The guard is SCOPED to real-backend credentials. A genuinely local credential (a non-real
		// `apiUrl`, e.g. a local single-user box) must still get the best-effort 011b heal: minting a
		// stub over a stub is safe because there is no real shared credential at risk. This proves the
		// fix did not kill the legitimate local-mode heal — only the clobber over real shared creds.
		const localToken = encodeStubToken({ org: "old", workspace: "default", agentId: "default" });
		const localDisk: DiskCredentials = {
			token: localToken,
			orgId: "old",
			orgName: "old",
			workspaceId: "default",
			apiUrl: "http://127.0.0.1:9999", // a LOCAL/stub endpoint, NOT the real backend.
			agentId: "default",
			savedAt: "",
		};
		saveDiskCredentials(localDisk, dir, systemClock);

		process.env.HONEYCOMB_ORG_ID = "new";
		try {
			const seededInternal: Credentials = {
				token: localToken,
				orgId: "old",
				orgName: "old",
				workspace: "default",
				agentId: "default",
				savedAt: "",
			};
			const drift = buildOrgDriftHealer(seededInternal, dir);
			const outcome = await drift.heal();
			// The local path still heals (the env override drives the active org to `new`).
			expect(outcome.kind).toBe("healed");
			expect(outcome.to).toBe("new");
		} finally {
			delete process.env.HONEYCOMB_ORG_ID;
		}
	});

	it("b-AC-4 drift heal reports `aligned` when the token org already matches the active org", async () => {
		const token = encodeStubToken({ org: "acme", workspace: "default", agentId: "default" });
		const aligned: Credentials = {
			token,
			orgId: "acme",
			orgName: "acme",
			workspace: "default",
			agentId: "default",
			savedAt: "",
		};
		saveCredentials(aligned, dir, systemClock);
		const drift = buildOrgDriftHealer(aligned, dir);
		const outcome = await drift.heal();
		// Active org defaults to the credential's own org (no env override) → aligned, no re-mint.
		expect(outcome.kind).toBe("aligned");
	});
});

describe("PRD-021b b-AC-6 — every seam is bound", () => {
	it("b-AC-6 buildRuntimeDeps assembles a fully-bound dep set (no undefined handler seam)", () => {
		const deps = buildRuntimeDeps();
		expect(deps.daemon).toBeDefined();
		expect(deps.lifecycle).toBeDefined();
		expect(deps.auth).toBeDefined();
		expect(deps.connector).toBeDefined();
		expect(deps.dashboard).toBeDefined();
		expect(deps.health).toBeDefined();
		expect(deps.drift).toBeDefined();
		expect(typeof deps.loggedIn).toBe("boolean");
	});

	it("b-AC-6 the bound auth passthrough is callable for login/logout/org", async () => {
		const auth = buildAuthPassthrough();
		// The seam is bound and callable — that is the b-AC-6 invariant being proven.
		expect(typeof auth.dispatch).toBe("function");

		// SELF-ISOLATION (data-loss guard): the passthrough's `dispatch` does not accept a dir
		// injection — a real `logout` resolves `credentialsPath()` from `os.homedir()` and
		// `unlinkSync`s it. PRD-023 made that the SHARED `~/.deeplake/credentials.json` (the
		// file `hivemind login` writes), so dispatching `["logout"]` against the real home would
		// WIPE the developer's real login on every `npm run ci`. The global `setupFiles` HOME
		// redirect (tests/setup/isolate-home.ts) already points home at temp space, but we ALSO
		// pin home to a fresh, EMPTY per-test temp dir here so this seam-callable assertion can
		// never touch any shared/real path even if the global guard regresses. With no file under
		// the temp home, `logout` is a clean no-op (exit 0) and nothing is deleted — proof the
		// seam runs end-to-end without performing a destructive logout.
		const isoHome = mkdtempSync(join(tmpdir(), "hc-runtime-logout-iso-"));
		const prevUserProfile = process.env.USERPROFILE;
		const prevHome = process.env.HOME;
		process.env.USERPROFILE = isoHome;
		process.env.HOME = isoHome;
		try {
			// The credentials path now resolves UNDER the throwaway temp home — never `~/.deeplake`.
			expect(credentialsPath().startsWith(isoHome)).toBe(true);
			const code = await auth.dispatch(["logout"]);
			expect(typeof code).toBe("number");
		} finally {
			if (prevUserProfile === undefined) delete process.env.USERPROFILE;
			else process.env.USERPROFILE = prevUserProfile;
			if (prevHome === undefined) delete process.env.HOME;
			else process.env.HOME = prevHome;
			rmSync(isoHome, { recursive: true, force: true });
		}
	});

	it("b-AC-6 the bound daemon lifecycle exposes start/stop/status", () => {
		const client = createLoopbackDaemonClient({ baseUrl: "http://127.0.0.1:3850" });
		const lifecycle = buildDaemonLifecycle(client);
		expect(typeof lifecycle.start).toBe("function");
		expect(typeof lifecycle.stop).toBe("function");
		expect(typeof lifecycle.status).toBe("function");
	});
});

/**
 * The `C:\WINDOWS\system32` footgun guard: `start()` must pin the spawned daemon to a WRITABLE
 * workspace, because the daemon resolves its `.secrets/`/`.daemon/` root from `HONEYCOMB_WORKSPACE
 * ?? process.cwd()` and a detached process can inherit an unwritable cwd (then every secret save
 * 502s `store_failed` with no audit trail). These lock the resolver that feeds the spawn.
 */
describe("daemon workspace resolution (system32 footgun guard)", () => {
	let tmp: string;
	const prevWorkspace = process.env.HONEYCOMB_WORKSPACE;

	beforeEach(() => {
		tmp = mkdtempSync(join(tmpdir(), "hc-ws-"));
	});
	afterEach(() => {
		if (prevWorkspace === undefined) delete process.env.HONEYCOMB_WORKSPACE;
		else process.env.HONEYCOMB_WORKSPACE = prevWorkspace;
		rmSync(tmp, { recursive: true, force: true });
	});

	it("canWriteDir is true for a writable dir and false for an unwritable path", () => {
		expect(canWriteDir(tmp)).toBe(true);
		// A path UNDER a regular file can never be a directory — mkdirSync throws (ENOTDIR), which
		// is a reliable cross-platform stand-in for an unwritable target (Windows ACLs are not).
		const asFile = join(tmp, "not-a-dir");
		writeFileSync(asFile, "");
		expect(canWriteDir(join(asFile, "child"))).toBe(false);
	});

	it("resolveDaemonWorkspace honors a writable HONEYCOMB_WORKSPACE", () => {
		process.env.HONEYCOMB_WORKSPACE = tmp;
		expect(resolveDaemonWorkspace()).toBe(tmp);
	});

	it("resolveDaemonWorkspace skips an UNWRITABLE HONEYCOMB_WORKSPACE and falls back to a writable dir", () => {
		const asFile = join(tmp, "bad-workspace-file");
		writeFileSync(asFile, "");
		// An env path that cannot be a directory must be rejected, not blindly trusted; the resolver
		// then lands on the (writable) cwd or `~/.honeycomb` — never the unwritable candidate.
		process.env.HONEYCOMB_WORKSPACE = join(asFile, "sub");
		const resolved = resolveDaemonWorkspace();
		expect(resolved).not.toBe(join(asFile, "sub"));
		expect([process.cwd(), join(homedir(), ".honeycomb")]).toContain(resolved);
		expect(canWriteDir(resolved)).toBe(true);
	});
});
