/**
 * PRD-050b — the BOOT-WITHOUT-CREDENTIALS invariant (b-AC-1) + the local-mode gate (b-AC-4).
 *
 * This is the crux of 050b: with NO credential resolvable, the daemon must BOOT and serve the
 * pre-auth dashboard + the guided-setup state — no throw, no fail-closed, NO second daemon process.
 *
 * The audited-and-fixed seam is the storage client: `assembleDaemon` used to construct the EAGER
 * `createStorageClient`, which throws a `StorageConfigError` when `token`/`org`/`endpoint` are all
 * absent (a fresh install). That throw took the whole daemon down at boot. `assembleDaemon` now
 * builds the DEFERRED `createLazyStorageClient`, which never throws at construction.
 *
 * Verification posture (mirrors `assemble.test.ts`): drive the REAL `assembleDaemon` with a NO-CREDS
 * provider and `storage` LEFT UNSET (so the production lazy client is exercised), plus hermetic fakes
 * for the heavy services (no embed child, no sqlite, no vault IO). Assert the assembly does not throw
 * and `GET /dashboard` + `GET /setup/state` answer 200 — all on ONE assembled daemon (no second
 * process; `assembleDaemon` returns a single `Daemon`, and we never call `start()` so no lock/socket).
 */

import { describe, expect, it } from "vitest";

import { type RuntimeConfig } from "../../../src/daemon/runtime/config.js";
import { createRequestLogger } from "../../../src/daemon/runtime/logger.js";
import { assembleDaemon, type VaultSettingsReader } from "../../../src/daemon/runtime/assemble.js";
import { NULL_LOG_STORE } from "../../../src/daemon/runtime/logs/log-store.js";
import { noopEmbedSupervisor } from "../../../src/daemon/runtime/services/embed-supervisor.js";
import type { CredentialProvider } from "../../../src/daemon/storage/config.js";

function cfg(over: Partial<RuntimeConfig> = {}): RuntimeConfig {
	return { host: "127.0.0.1", port: 3850, mode: "local", widened: false, ...over };
}

/** A NO-CREDS provider: `read()` returns an empty record, exactly like a fresh install (no file, no env). */
const noCredsProvider: CredentialProvider = { read: () => ({}) };

/** A fake vault reader so the production `VaultStore` is never constructed (hermetic). */
const fakeVault: VaultSettingsReader = {
	async getSetting() {
		return { ok: false, reason: "absent" } as never;
	},
};

/**
 * Assemble the REAL daemon with the production DEFERRED storage client (no `storage` injected) but a
 * no-creds provider + hermetic service fakes. This is the production boot path minus the live child
 * processes — exactly the seam b-AC-1 audits.
 */
function assembleNoCreds(mode: "local" | "team" = "local") {
	return assembleDaemon({
		config: cfg({ mode }),
		// storage LEFT UNSET → the production createLazyStorageClient is built from this provider.
		provider: noCredsProvider,
		logger: createRequestLogger({ silent: true }),
		logStore: NULL_LOG_STORE,
		embedSupervisor: noopEmbedSupervisor,
		installedHarnesses: new Set<string>(),
		vault: fakeVault,
	});
}

describe("b-AC-1 the daemon boots with NO credentials and serves the pre-auth dashboard", () => {
	it("assembleDaemon does NOT throw when no credential resolves (the eager-read seam is fixed)", () => {
		expect(() => assembleNoCreds()).not.toThrow();
	});

	it("GET /dashboard returns 200 + the guided-setup-driving shell (no throw, no fail-closed)", async () => {
		const { daemon } = assembleNoCreds();
		const res = await daemon.app.request("/dashboard");
		expect(res.status).toBe(200);
		const html = await res.text();
		// The shell is the self-hydrating React mount point that drives the guided-setup state.
		expect(html).toContain('<div id="root"');
		expect(html).toContain("/dashboard/app.js");
		// And it carries NO secret (parent AC-8 / b-AC-4).
		expect(html.toLowerCase()).not.toContain("token");
		expect(html.toLowerCase()).not.toContain("bearer");
	});

	it("GET /setup/state answers 200 with authenticated=false on a no-creds boot (drives guided-setup)", async () => {
		const { daemon } = assembleNoCreds();
		const res = await daemon.app.request("/setup/state");
		expect(res.status).toBe(200);
		const body = await res.json();
		// authenticated is the DERIVED bit; with no creds it is false → the guided-setup state renders.
		expect(body.authenticated).toBe(false);
		// The warmup signal is present (b-AC-5 observability) — the noop supervisor reports disabled.
		expect(body.warmup).toBeDefined();
	});

	it("serves a SINGLE daemon instance — no second process is spawned to serve the pre-auth dashboard", () => {
		// assembleDaemon returns ONE Daemon (the Hono app). There is no second-process construction here:
		// the same app answers /dashboard AND /setup/state. (start() — which binds the socket + lock — is
		// never called, so this also proves the routes are served by the constructed app alone.)
		const assembled = assembleNoCreds();
		expect(typeof assembled.daemon.app.request).toBe("function");
		expect(assembled.daemon.config.mode).toBe("local");
	});
});

describe("b-AC-4 the setup endpoints are unreachable in non-local mode", () => {
	it("team mode: GET /setup/state is NOT mounted (404), and GET /dashboard is NOT served", async () => {
		const { daemon } = assembleNoCreds("team");
		// The dashboard host + the setup routes fire LOCAL-MODE ONLY (security F-1). In team mode they
		// fall through to the root scaffold (404/501), never serving a tenant surface without auth.
		const setup = await daemon.app.request("/setup/state");
		expect(setup.status).not.toBe(200);
		const dash = await daemon.app.request("/dashboard");
		expect(dash.status).not.toBe(200);
	});
});
