/**
 * PRD-050b — the pre-auth guided-setup STATE read (`GET /setup/state`).
 *
 * Verification posture (mirrors `status-api.test.ts`): mount `mountSetupStateGroup` onto a bare Hono
 * group against a temp HOME, drive it with `app.request`, and assert the body. The decisive
 * assertions map one-to-one to the ACs:
 *
 *   b-AC-2  the body accurately reports `~/.deeplake` / `~/.honeycomb` / `~/.hivemind` presence, the
 *           onboarding phase + prior-tool, and is fail-soft on a missing/malformed onboarding file.
 *   b-AC-4  the route is unreachable (404) outside local mode; the body carries no token/secret.
 *   b-AC-5  the embeddings warmup signal is reported (enabled/live/warm) from the injected supervisor.
 *   b-AC-6  `authenticated` is DERIVED from a valid credential (not the onboarding phase): false with
 *           no creds (→ the guided-setup state), true once a valid credential is written.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeStubToken } from "../../../../src/daemon/runtime/auth/contracts.js";
import { saveCredentials } from "../../../../src/daemon/runtime/auth/credentials-store.js";
import type { Credentials } from "../../../../src/daemon/runtime/auth/contracts.js";
import type { EmbedSupervisor } from "../../../../src/daemon/runtime/services/embed-supervisor.js";
import {
	SETUP_STATE_PATH,
	mountSetupStateGroup,
} from "../../../../src/daemon/runtime/dashboard/setup-state.js";

const ORG = "org-acme";
const SECRET_TOKEN_SENTINEL = "hcmt.v1.DO-NOT-LEAK";

let home: string;

/** A fake embed supervisor reporting a fixed warmup state (the assembly threads the real one). */
function fakeEmbed(over: Partial<Pick<EmbedSupervisor, "disabled" | "live" | "warm">> = {}): EmbedSupervisor {
	return {
		disabled: over.disabled ?? false,
		live: over.live ?? false,
		warm: over.warm ?? false,
		restarts: 0,
		start() {},
		stop() {},
		async restart() {},
	} as EmbedSupervisor;
}

/** Mount the setup-state read at the real path so `app.request("/setup/state")` routes it. */
function build(
	mode: "local" | "team",
	deps: { embed?: EmbedSupervisor; env?: NodeJS.ProcessEnv } = {},
): Hono {
	const root = new Hono();
	// homeDir drives the dir-presence probes; credentialsDir + onboardingDir point the loaders at the
	// shared `~/.deeplake` UNDER the temp HOME, so a creds/onboarding write lands where they read.
	const deeplakeDir = join(home, ".deeplake");
	mountSetupStateGroup(root, mode, {
		homeDir: home,
		credentialsDir: deeplakeDir,
		onboardingDir: deeplakeDir,
		...(deps.embed !== undefined ? { embed: deps.embed } : {}),
		...(deps.env !== undefined ? { env: deps.env } : {}),
	});
	return root;
}

/** Persist a valid credentials file into the temp `~/.deeplake`. */
function writeCreds(): void {
	const creds: Credentials = {
		token: encodeStubToken({ org: ORG }),
		orgId: ORG,
		orgName: "Acme Inc",
		workspace: "backend",
		agentId: "agent-7",
		savedAt: "2026-06-25T00:00:00.000Z",
	};
	saveCredentials(creds, join(home, ".deeplake"), { now: () => "2026-06-25T00:00:00.000Z" });
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "hc-setup-state-"));
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("b-AC-2 the body reports credential-dir presence + onboarding phase/prior-tool, fail-soft", () => {
	it("reports all dirs ABSENT + a fresh-install onboarding state on a clean temp HOME", async () => {
		const app = build("local", { embed: fakeEmbed() });
		const res = await app.request(SETUP_STATE_PATH);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.credentials).toEqual({ deeplake: false, honeycomb: false, hivemind: false });
		expect(body.phase).toBe("fresh");
		expect(body.priorTool).toEqual({ hivemind: "absent" });
		expect(body.firstTimeSetupComplete).toBe(false);
	});

	it("reports each dir TRUE when present", async () => {
		mkdirSync(join(home, ".deeplake"), { recursive: true });
		mkdirSync(join(home, ".honeycomb"), { recursive: true });
		mkdirSync(join(home, ".hivemind"), { recursive: true });
		const app = build("local", { embed: fakeEmbed() });
		const body = await (await app.request(SETUP_STATE_PATH)).json();
		expect(body.credentials).toEqual({ deeplake: true, honeycomb: true, hivemind: true });
	});

	it("fail-soft: a MALFORMED onboarding file degrades to a fresh-install state (never a 500)", async () => {
		mkdirSync(join(home, ".deeplake"), { recursive: true });
		// Garbage JSON in onboarding.json — loadOnboarding zod-rejects it and falls soft to fresh.
		writeFileSync(join(home, ".deeplake", "onboarding.json"), "{ this is not valid json", "utf8");
		const app = build("local", { embed: fakeEmbed() });
		const res = await app.request(SETUP_STATE_PATH);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.phase).toBe("fresh");
		expect(body.firstTimeSetupComplete).toBe(false);
	});

	it("reflects a persisted onboarding phase/prior-tool when the file is valid", async () => {
		mkdirSync(join(home, ".deeplake"), { recursive: true });
		const onboarding = {
			schemaVersion: 1,
			installId: "11111111-1111-4111-8111-111111111111",
			phase: "linking",
			firstTimeSetupComplete: false,
			ref: "mario",
			priorTool: { hivemind: "present" },
			telemetry: { optInTier2: false, reported: {}, sent: [] },
		};
		writeFileSync(join(home, ".deeplake", "onboarding.json"), JSON.stringify(onboarding), "utf8");
		const app = build("local", { embed: fakeEmbed() });
		const body = await (await app.request(SETUP_STATE_PATH)).json();
		expect(body.phase).toBe("linking");
		expect(body.priorTool).toEqual({ hivemind: "present" });
	});
});

describe("b-AC-6 `authenticated` is DERIVED from a valid credential, not the onboarding phase", () => {
	it("reports authenticated=false with NO credential on disk (→ the guided-setup state renders)", async () => {
		const app = build("local", { embed: fakeEmbed() });
		const body = await (await app.request(SETUP_STATE_PATH)).json();
		expect(body.authenticated).toBe(false);
	});

	it("reports authenticated=true once a VALID credential is written", async () => {
		writeCreds();
		const app = build("local", { embed: fakeEmbed() });
		const body = await (await app.request(SETUP_STATE_PATH)).json();
		expect(body.authenticated).toBe(true);
		// The dir-presence and the credential-validity signals are reported independently.
		expect(body.credentials.deeplake).toBe(true);
	});
});

describe("b-AC-5 the embeddings warmup signal is observable (enabled/live/warm)", () => {
	it("reports the supervisor's warmup state (still warming → warm:false, live can be true)", async () => {
		const app = build("local", { embed: fakeEmbed({ disabled: false, live: true, warm: false }) });
		const body = await (await app.request(SETUP_STATE_PATH)).json();
		expect(body.warmup).toEqual({ enabled: true, live: true, warm: false });
	});

	it("reports a disabled supervisor as enabled:false (explicit opt-out)", async () => {
		const app = build("local", { embed: fakeEmbed({ disabled: true }) });
		const body = await (await app.request(SETUP_STATE_PATH)).json();
		expect(body.warmup.enabled).toBe(false);
	});
});

describe("b-AC-4 the setup endpoint is local-mode-only + carries no secret", () => {
	it("team mode returns a 404 (the route is indistinguishable from unmounted)", async () => {
		writeCreds(); // even with a real credential, team mode must not serve setup state.
		const app = build("team", { embed: fakeEmbed() });
		const res = await app.request(SETUP_STATE_PATH);
		expect(res.status).toBe(404);
	});

	it("no token/secret sentinel appears anywhere in the local-mode body", async () => {
		writeCreds();
		const app = build("local", { embed: fakeEmbed(), env: { HONEYCOMB_TOKEN: SECRET_TOKEN_SENTINEL } });
		const raw = await (await app.request(SETUP_STATE_PATH)).text();
		expect(raw).not.toContain(SECRET_TOKEN_SENTINEL);
		expect(raw).not.toContain("hcmt.v1.");
		expect(raw.toLowerCase()).not.toContain("token");
		expect(raw.toLowerCase()).not.toContain("bearer");
	});
});
