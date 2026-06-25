/**
 * PRD-050d — the Hivemind→Honeycomb migration route (`POST /setup/migrate-from-hivemind` + `/rollback`).
 *
 * Drives `mountSetupMigrate` against a daemon with a temp HOME, the Hivemind-uninstall seam injected (a
 * temp `~/.hivemind` + a fake npm remover), and an injected `/me` fetch. The decisive assertions:
 *
 *   d-AC-3  "Proceed" backs up `~/.hivemind`, uninstalls idempotently, then advances `migration.phase`
 *           through backup → uninstall → link → done.
 *   d-AC-4  a VALID existing credential is verify-and-adopted via `GET /me` (NO device flow); with NO
 *           valid credential the response signals `needsLogin` (the page runs the 050c flow).
 *   d-AC-5  an injected uninstall FAILURE surfaces a plain-language message + the backup path, leaves the
 *           shared credential intact, leaves the daemon serving, and does not reach a terminal state.
 *   d-AC-6  after an adopt-success the marker is terminal (`done`), `priorTool.hivemind:"migrated"`, and
 *           the `honeycomb_hivemind_upgrade` telemetry event fires (success only).
 *   d-AC-7  the rollback restores the backup and stamps `migration.phase:"rolled_back"`.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type AuthFetch, type AuthFetchResponse } from "../../../../src/daemon/runtime/auth/index.js";
import { encodeStubToken } from "../../../../src/daemon/runtime/auth/contracts.js";
import { type RuntimeConfig } from "../../../../src/daemon/runtime/config.js";
import { createDaemon } from "../../../../src/daemon/runtime/server.js";
import { loadOnboarding } from "../../../../src/daemon/runtime/onboarding/index.js";
import {
	SETUP_MIGRATE_PATH,
	SETUP_MIGRATE_ROLLBACK_PATH,
	type MountSetupMigrateOptions,
	mountSetupMigrate,
} from "../../../../src/daemon/runtime/dashboard/setup-migrate.js";

const ORG = "org-acme";

function cfg(): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false };
}

let home: string;

/** Seed a `~/.hivemind` dir (the prior-tool footprint the uninstall backs up + removes). */
function seedHivemind(contents = "hivemind-config"): void {
	const dir = join(home, ".hivemind");
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "config.json"), contents, "utf8");
}

/** Write a VALID shared `~/.deeplake/credentials.json` (Hivemind disk shape) the adopt-check reads. */
function seedValidCredential(): string {
	const dir = join(home, ".deeplake");
	mkdirSync(dir, { recursive: true });
	const path = join(dir, "credentials.json");
	const disk = {
		token: encodeStubToken({ org: ORG }),
		orgId: ORG,
		orgName: "Acme",
		userName: "Ada",
		workspaceId: "default",
		apiUrl: "https://api.deeplake.ai",
		savedAt: "2026-06-25T00:00:00.000Z",
	};
	writeFileSync(path, JSON.stringify(disk), "utf8");
	return path;
}

/** A `/me` fetch that ACCEPTS the token (valid → adopt) or REJECTS it (invalid → needsLogin). */
function meFetch(ok: boolean): AuthFetch {
	return (url: string): Promise<AuthFetchResponse> => {
		// Path-sensitive: only the `/me` adopt-check succeeds/401s. Any OTHER endpoint 404s, so the suite
		// would FAIL if the migration flow ever stopped calling `/me` or hit the wrong endpoint (keeps the
		// d-AC-4 adoption contract honest rather than passing for any URL).
		const path = url.replace(/^https?:\/\/[^/]+/, "");
		if (path !== "/me") {
			return Promise.resolve({
				ok: false,
				status: 404,
				json: () => Promise.resolve({ error: "not_found" }),
				text: () => Promise.resolve(JSON.stringify({ error: "not_found" })),
			});
		}
		const body = ok ? { id: "u-1", name: "Ada", email: "ada@deeplake.ai" } : { error: "unauthorized" };
		return Promise.resolve({
			ok,
			status: ok ? 200 : 401,
			json: () => Promise.resolve(body),
			text: () => Promise.resolve(JSON.stringify(body)),
		});
	};
}

/** Mount the migration route with the temp HOME threaded into onboarding + uninstall + creds + me. */
function mount(opts: { meOk?: boolean; telemetry?: MountSetupMigrateOptions["telemetry"] } = {}) {
	const daemon = createDaemon({ config: cfg() });
	const deeplakeDir = join(home, ".deeplake");
	const options: MountSetupMigrateOptions = {
		dir: deeplakeDir,
		env: {}, // resolveApiUrl reads no override → the default endpoint (the fetch is faked anyway).
		fetch: meFetch(opts.meOk ?? true),
		uninstall: { homeDir: home, now: () => "2026-06-25T12:00:00.000Z", npmRemove: () => true },
		...(opts.telemetry !== undefined ? { telemetry: opts.telemetry } : {}),
	};
	mountSetupMigrate(daemon, options);
	return { daemon, deeplakeDir };
}

beforeEach(() => {
	home = mkdtempSync(join(tmpdir(), "hc-setup-migrate-"));
});
afterEach(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("d-AC-3 / d-AC-4 / d-AC-6 — Proceed backs up + uninstalls + verify-and-adopts to a terminal state", () => {
	it("with a VALID credential: backs up + removes `~/.hivemind`, adopts via /me (no device flow), reaches `done`", async () => {
		seedHivemind("payload-A");
		seedValidCredential();
		const recorder: { events: string[] } = { events: [] };
		const telemetry = {
			posthogKey: "test-key",
			posthogHost: "https://t.example",
			fetch: (_url: string, init: { body: string }) => {
				recorder.events.push(JSON.parse(init.body).event);
				return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("") });
			},
		};
		const { daemon, deeplakeDir } = mount({ meOk: true, telemetry });

		const res = await daemon.app.request(SETUP_MIGRATE_PATH, { method: "POST" });
		expect(res.status).toBe(200);
		const body = await res.json();

		// d-AC-3: the dir was backed up then removed.
		expect(existsSync(join(home, ".hivemind"))).toBe(false);
		expect(body.backupPath).toBeDefined();
		expect(readFileSync(join(body.backupPath as string, "config.json"), "utf8")).toBe("payload-A");

		// d-AC-4: adopted (no device flow) — terminal done, migrated true, no needsLogin.
		expect(body.ok).toBe(true);
		expect(body.phase).toBe("done");
		expect(body.migrated).toBe(true);
		expect(body.needsLogin).toBeUndefined();

		// d-AC-6: the onboarding marker is terminal + prior-tool migrated.
		const onboarding = loadOnboarding(deeplakeDir);
		expect(onboarding.priorTool.hivemind).toBe("migrated");
		expect(onboarding.phase).toBe("migrated");
		expect(onboarding.migration?.phase).toBe("done");

		// d-AC-6: the upgrade telemetry fired (success only).
		expect(recorder.events).toContain("honeycomb_hivemind_upgrade");
	});

	it("with NO valid credential: signals `needsLogin` and STOPS at the non-terminal `link` phase (runs 050c)", async () => {
		seedHivemind();
		// No credential file written → loadDiskCredentials returns null → cannot adopt.
		const recorder: { events: string[] } = { events: [] };
		const telemetry = {
			posthogKey: "test-key",
			posthogHost: "https://t.example",
			fetch: (_url: string, init: { body: string }) => {
				recorder.events.push(JSON.parse(init.body).event);
				return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve("") });
			},
		};
		const { daemon, deeplakeDir } = mount({ meOk: false, telemetry });

		const body = await (await daemon.app.request(SETUP_MIGRATE_PATH, { method: "POST" })).json();
		expect(body.ok).toBe(true);
		expect(body.needsLogin).toBe(true);
		expect(body.phase).toBe("link");
		expect(body.migrated).toBeUndefined();

		// The marker is NON-terminal (link), NOT migrated — the device flow must still run.
		const onboarding = loadOnboarding(deeplakeDir);
		expect(onboarding.migration?.phase).toBe("link");
		expect(onboarding.priorTool.hivemind).not.toBe("migrated");

		// The upgrade telemetry did NOT fire (it counts a COMPLETED migration only — d-AC-6).
		expect(recorder.events).not.toContain("honeycomb_hivemind_upgrade");
	});

	it("an invalid/expired credential (/me 401) falls to the device flow rather than adopting", async () => {
		seedHivemind();
		seedValidCredential(); // a credential exists on disk...
		const { daemon } = mount({ meOk: false }); // ...but /me REJECTS it → not adoptable.
		const body = await (await daemon.app.request(SETUP_MIGRATE_PATH, { method: "POST" })).json();
		expect(body.needsLogin).toBe(true);
		expect(body.phase).toBe("link");
	});
});

describe("d-AC-5 — a failed/partial uninstall is safe (message + backup, credential intact, daemon serving)", () => {
	it("surfaces a plain-language message and never deletes the shared credential nor bricks the daemon", async () => {
		seedHivemind();
		const credPath = seedValidCredential();
		const daemon = createDaemon({ config: cfg() });
		const deeplakeDir = join(home, ".deeplake");
		// Force the destructive step to FAIL deterministically: `~/.hivemind` exists, but we pre-create a
		// FILE at the exact timestamped backup destination so `cpSync(dir, backupPath, {recursive})` throws
		// (it cannot create a directory where a file already lives). The `now` seam pins the backup path so
		// we know exactly where to plant the collision. This exercises the route's partial-failure branch
		// (d-AC-5) without touching the shared credential.
		const FIXED_ISO = "2026-06-25T12:00:00.000Z";
		const collisionPath = join(home, `.hivemind-backup-${FIXED_ISO.replace(/[:.]/g, "-")}`);
		writeFileSync(collisionPath, "pre-existing file blocks the backup dir", "utf8");
		mountSetupMigrate(daemon, {
			dir: deeplakeDir,
			env: {},
			fetch: meFetch(true),
			uninstall: { homeDir: home, now: () => FIXED_ISO, npmRemove: () => true },
		});

		const res = await daemon.app.request(SETUP_MIGRATE_PATH, { method: "POST" });
		expect(res.status).toBe(200);
		const body = await res.json();

		// A recoverable failure: ok:false + a plain-language message (no raw stack), not a terminal state.
		expect(body.ok).toBe(false);
		expect(typeof body.message).toBe("string");
		expect(body.message.length).toBeGreaterThan(0);
		expect(body.phase).not.toBe("done");

		// The shared credential is intact (NEVER deleted on a failure — d-AC-5): the file still exists and
		// still parses to a credential carrying its token.
		expect(existsSync(credPath)).toBe(true);
		const parsed = JSON.parse(readFileSync(credPath, "utf8")) as { token: string; orgId: string };
		expect(parsed.orgId).toBe(ORG);
		expect(parsed.token.length).toBeGreaterThan(0);

		// The daemon is still serving (a fresh request to the route still answers — not bricked).
		const second = await daemon.app.request(SETUP_MIGRATE_PATH, { method: "POST" });
		expect(second.status).toBe(200);
	});
});

describe("d-AC-7 — rollback restores the backup and stamps `rolled_back`", () => {
	it("restores `~/.hivemind` from the recorded backup and sets migration.phase=rolled_back", async () => {
		seedHivemind("payload-R");
		seedValidCredential();
		const { daemon, deeplakeDir } = mount({ meOk: true });

		// Run a migration first so a backup path is recorded on the marker.
		await daemon.app.request(SETUP_MIGRATE_PATH, { method: "POST" });
		expect(existsSync(join(home, ".hivemind"))).toBe(false);

		// Roll back.
		const res = await daemon.app.request(SETUP_MIGRATE_ROLLBACK_PATH, { method: "POST" });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.phase).toBe("rolled_back");

		// The backup was restored byte-for-byte and the marker is terminal-reverted.
		expect(existsSync(join(home, ".hivemind"))).toBe(true);
		expect(readFileSync(join(home, ".hivemind", "config.json"), "utf8")).toBe("payload-R");
		const onboarding = loadOnboarding(deeplakeDir);
		expect(onboarding.migration?.phase).toBe("rolled_back");
		expect(onboarding.priorTool.hivemind).toBe("present"); // restored Hivemind is detectable again
	});
});
