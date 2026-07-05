/**
 * PRD-050a — `honeycomb install [--ref <code>]` verb (a-AC-2 / a-AC-4 / a-AC-5 / a-AC-6).
 *
 * Drives the verb against injected seams (a fake DaemonClient, a recording fake DaemonLifecycle, a
 * recording browser opener, and a temp onboarding dir) so NO real daemon, browser, or `~/.deeplake`
 * is touched. Proves:
 *   - a-AC-4: the dashboard is opened ONLY after `/health` answers; a daemon that never binds →
 *     "daemon didn't start" + retry hint + non-zero exit + NO open.
 *   - a-AC-2: idempotent — an already-healthy daemon triggers NO second start/bind, just re-opens.
 *   - a-AC-6: the `honeycomb.local` URL is attempted first but never required — when its open
 *     fails, the loopback URL is opened and the run still succeeds.
 *   - a-AC-5: the onboarding state is written with `phase: "installed"` + the effective ref.
 *   - `--ref` override vs the build-time DEFAULT_REF default.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createFakeDaemonClient,
	DASHBOARD_PORTAL_NOT_RUNNING_MESSAGE,
	type DaemonLifecycle,
	type DaemonStatus,
	dashboardPortalNotRunningMessage,
	loopbackDashboardUrl,
	openLocalDashboardUrl,
	parseRefArg,
	probeLoopbackDashboard,
	resolveEffectiveRef,
	runInstallCommand,
} from "../../src/commands/index.js";
import type { Credentials } from "../../src/daemon/runtime/auth/contracts.js";
import { DEFAULT_REF, loadOnboarding } from "../../src/daemon/runtime/onboarding/index.js";
import { doctorRegistryPath } from "../../src/daemon/runtime/telemetry/fleet-registry.js";
import type { FleetClassification } from "../../src/shared/fleet-detection.js";

/**
 * PRD-003a: a fixed fleet-defer classification so these install tests never touch the network / npm
 * tree (the real classifier) or attempt a real device-flow login. In fleet mode the install login
 * step just prints the defer line and returns — reading no credentials and running no login. BUG 1:
 * fleet mode ALSO opens NO dashboard (Hive's onboarding owns the portal).
 */
const fleetDefer = async (): Promise<FleetClassification> => ({
	mode: "fleet",
	signals: { registryHiveEntry: true, hivePortAnswering: false, hiveNpmGlobal: false },
	firedSignals: ["test-injected registry Hive entry"],
});

/**
 * PRD-003a: a fixed SOLO classification so a test can drive the solo dashboard-open path (the only
 * path that opens a browser after BUG 1). Paired with {@link credsPresent} so the solo login step
 * short-circuits on "already signed in" and never attempts a real device flow.
 */
const soloDetect = async (): Promise<FleetClassification> => ({
	mode: "solo",
	signals: { registryHiveEntry: false, hivePortAnswering: false, hiveNpmGlobal: false },
	firedSignals: [],
});

/** A stub credentials loader so the SOLO login step reports "already signed in" (no device flow). */
const credsPresent = (): Credentials => ({
	token: "tok",
	orgId: "org-1",
	orgName: "Org One",
	workspace: "default",
	agentId: "default",
	savedAt: "2026-01-01T00:00:00.000Z",
});

/** A recording fake DaemonLifecycle: scripts start/status results + records every call. */
function fakeLifecycle(script: {
	start?: { started: boolean; alreadyRunning: boolean };
	stop?: { stopped: boolean };
	status?: DaemonStatus;
}): DaemonLifecycle & { calls: string[] } {
	const calls: string[] = [];
	return {
		calls,
		async start() {
			calls.push("start");
			return script.start ?? { started: true, alreadyRunning: false };
		},
		async stop() {
			calls.push("stop");
			return script.stop ?? { stopped: true };
		},
		async status() {
			calls.push("status");
			return script.status ?? { running: true, pid: 4242, port: 3850 };
		},
	};
}

/** A recording browser opener: captures every URL it is handed; `result` controls open success. */
function recordingOpener(result: (url: string) => boolean): { open: (url: string) => boolean; urls: string[] } {
	const urls: string[] = [];
	return {
		urls,
		open(url: string): boolean {
			urls.push(url);
			return result(url);
		},
	};
}

async function reachablePortalProbe(): Promise<boolean> {
	return true;
}

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "hc-install-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("PRD-050a — honeycomb install (a-AC-4 health-gated open)", () => {
	it("a-AC-4 opens the dashboard ONLY after the daemon is reachable (solo already-up path)", async () => {
		const lines: string[] = [];
		const opener = recordingOpener(() => true);
		const lifecycle = fakeLifecycle({});
		const res = await runInstallCommand([], {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle,
			openDashboard: opener.open,
			probeDashboard: reachablePortalProbe,
			// SOLO with creds present → the only path that opens a browser after BUG 1.
			detectFleet: soloDetect,
			loadInstallCredentials: credsPresent,
			dir: tmpDir,
			out: (l) => lines.push(l),
		});
		expect(res.exitCode).toBe(0);
		// The dashboard was opened (a URL was handed to the opener) — and only after the health gate.
		expect(opener.urls.length).toBeGreaterThan(0);
		expect(lines.join("\n")).toMatch(/daemon up on 127\.0\.0\.1:3850/);
		expect(lines.join("\n")).toMatch(/Honeycomb is ready/);
	});

	it("a-AC-4 reports 'daemon didn't start' + retry hint and exits non-zero, opening NOTHING", async () => {
		const lines: string[] = [];
		const opener = recordingOpener(() => true);
		// Daemon stays down: ping false + a start that never binds.
		const lifecycle = fakeLifecycle({ start: { started: false, alreadyRunning: false } });
		const res = await runInstallCommand([], {
			daemon: createFakeDaemonClient({ alive: false }),
			lifecycle,
			openDashboard: opener.open,
			probeDashboard: reachablePortalProbe,
			detectFleet: fleetDefer,
			dir: tmpDir,
			out: (l) => lines.push(l),
		});
		expect(res.exitCode).toBe(1);
		// NO dashboard open on the failure path (a-AC-4).
		expect(opener.urls).toHaveLength(0);
		const text = lines.join("\n");
		expect(text).toMatch(/daemon didn't start/);
		expect(text).toMatch(/retry/i);
		// Plain-language only — no raw stack / "Error:" dump leaks (parent AC-7).
		expect(text).not.toMatch(/at .*\(.*:\d+:\d+\)/);
	});
});

describe("PRD-064h: install reports daemon supervision (fail-soft, additive)", () => {
	it("AC-064h.6 reports the supervising OS service manager when status surfaces one", async () => {
		const lines: string[] = [];
		// A lifecycle whose status() reports a service manager (the service-mode outcome).
		const lifecycle: DaemonLifecycle = {
			async start() {
				return { started: false, alreadyRunning: true };
			},
			async stop() {
				return { stopped: false };
			},
			async status(): Promise<DaemonStatus> {
				return { running: true, pid: 7, port: 3850, serviceManager: "launchd" };
			},
		};
		const res = await runInstallCommand([], {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle,
			openDashboard: () => true,
			probeDashboard: reachablePortalProbe,
			detectFleet: fleetDefer,
			dir: tmpDir,
			out: (l) => lines.push(l),
		});
		expect(res.exitCode).toBe(0);
		const text = lines.join("\n");
		expect(text).toMatch(/registered as an OS service \(launchd\)/);
		// Still ready: the supervision line never changes the install outcome.
		expect(text).toMatch(/Honeycomb is ready/);
	});

	it("notes the detached-spawn fallback when status surfaces no manager (HC-1)", async () => {
		const lines: string[] = [];
		const res = await runInstallCommand([], {
			daemon: createFakeDaemonClient({ alive: true }),
			// The default fakeLifecycle().status() returns no serviceManager → fallback note.
			lifecycle: fakeLifecycle({}),
			openDashboard: () => true,
			probeDashboard: reachablePortalProbe,
			detectFleet: fleetDefer,
			dir: tmpDir,
			out: (l) => lines.push(l),
		});
		expect(res.exitCode).toBe(0);
		expect(lines.join("\n")).toMatch(/detached process/);
	});

	it("a status() that throws never affects the install (the line is simply skipped)", async () => {
		const lines: string[] = [];
		const lifecycle: DaemonLifecycle = {
			async start() {
				return { started: false, alreadyRunning: true };
			},
			async stop() {
				return { stopped: false };
			},
			async status(): Promise<DaemonStatus> {
				throw new Error("status probe blew up");
			},
		};
		const res = await runInstallCommand([], {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle,
			openDashboard: () => true,
			probeDashboard: reachablePortalProbe,
			detectFleet: fleetDefer,
			dir: tmpDir,
			out: (l) => lines.push(l),
		});
		expect(res.exitCode).toBe(0);
		expect(lines.join("\n")).toMatch(/Honeycomb is ready/);
	});
});

describe("PRD-050a — honeycomb install (a-AC-2 idempotency)", () => {
	it("a-AC-2 an already-healthy daemon triggers NO second start/bind, just re-opens", async () => {
		const opener = recordingOpener(() => true);
		const lifecycle = fakeLifecycle({});
		const res = await runInstallCommand([], {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle,
			openDashboard: opener.open,
			probeDashboard: reachablePortalProbe,
			detectFleet: soloDetect,
			loadInstallCredentials: credsPresent,
			dir: tmpDir,
			out: () => {},
		});
		expect(res.exitCode).toBe(0);
		// ensureDaemonRunning short-circuits on a live /health probe → NO start call (no double-bind).
		expect(lifecycle.calls).not.toContain("start");
		expect(opener.urls.length).toBeGreaterThan(0);
	});

	it("a-AC-2 a second run is a clean no-op re-open (state already 'installed')", async () => {
		const opener = recordingOpener(() => true);
		const lifecycle = fakeLifecycle({});
		const deps = {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle,
			openDashboard: opener.open,
			probeDashboard: reachablePortalProbe,
			detectFleet: soloDetect,
			loadInstallCredentials: credsPresent,
			dir: tmpDir,
			out: () => {},
		};
		await runInstallCommand([], deps);
		const second = await runInstallCommand([], deps);
		expect(second.exitCode).toBe(0);
		// Still marked installed; no start ever fired across either run.
		expect(loadOnboarding(tmpDir).phase).toBe("installed");
		expect(lifecycle.calls).not.toContain("start");
	});
});

describe("PRD-050a / BUG 1 — honeycomb install (solo opens the loopback dashboard only)", () => {
	it("solo opens the loopback URL (honeycomb.local dropped) when the portal is reachable", async () => {
		// After BUG 1 there is no honeycomb.local attempt: the SOLO open targets the loopback URL only.
		const opener = recordingOpener((url) => url === loopbackDashboardUrl());
		const res = await runInstallCommand([], {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle: fakeLifecycle({}),
			openDashboard: opener.open,
			probeDashboard: reachablePortalProbe,
			detectFleet: soloDetect,
			loadInstallCredentials: credsPresent,
			dir: tmpDir,
			out: () => {},
		});
		expect(res.exitCode).toBe(0);
		// The ONLY URL handed to the opener is the loopback URL — never a `honeycomb.local` address.
		expect(opener.urls).toEqual([loopbackDashboardUrl()]);
		expect(opener.urls.join("\n")).not.toContain("honeycomb.local");
	});

	it("solo run still succeeds even if the open fails (no browser available)", async () => {
		const lines: string[] = [];
		const opener = recordingOpener(() => false); // no browser anywhere
		const res = await runInstallCommand([], {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle: fakeLifecycle({}),
			openDashboard: opener.open,
			probeDashboard: reachablePortalProbe,
			detectFleet: soloDetect,
			loadInstallCredentials: credsPresent,
			dir: tmpDir,
			out: (l) => lines.push(l),
		});
		expect(res.exitCode).toBe(0);
		// The loopback URL is printed so a headless host learns where the dashboard lives.
		expect(lines.join("\n")).toContain(loopbackDashboardUrl());
		expect(lines.join("\n")).toMatch(/Honeycomb is ready/);
	});

	it("C-6 solo: does not open a browser tab when the portal is unreachable; prints one honest sentence", async () => {
		const lines: string[] = [];
		const opener = recordingOpener(() => true);
		const res = await runInstallCommand([], {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle: fakeLifecycle({}),
			openDashboard: opener.open,
			probeDashboard: async () => false,
			detectFleet: soloDetect,
			loadInstallCredentials: credsPresent,
			dir: tmpDir,
			out: (l) => lines.push(l),
		});
		expect(res.exitCode).toBe(0);
		expect(opener.urls).toHaveLength(0);
		expect(lines).toContain(DASHBOARD_PORTAL_NOT_RUNNING_MESSAGE);
	});

	it("C-6 solo: a THROWING probe degrades to the not-running branch (fail-soft): no tab, sentence, exit 0", async () => {
		const lines: string[] = [];
		const opener = recordingOpener(() => true);
		const res = await runInstallCommand([], {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle: fakeLifecycle({}),
			openDashboard: opener.open,
			probeDashboard: async () => {
				throw new Error("probe blew up");
			},
			detectFleet: soloDetect,
			loadInstallCredentials: credsPresent,
			dir: tmpDir,
			out: (l) => lines.push(l),
		});
		expect(res.exitCode).toBe(0);
		expect(opener.urls).toHaveLength(0);
		expect(lines).toContain(DASHBOARD_PORTAL_NOT_RUNNING_MESSAGE);
		expect(lines.join("\n")).toMatch(/Honeycomb is ready/);
	});
});

describe("BUG 1 — honeycomb install in FLEET mode opens NO dashboard (Hive owns the portal)", () => {
	it("opens NOTHING and never probes the portal when Hive is detected", async () => {
		const lines: string[] = [];
		const opener = recordingOpener(() => true);
		let probed = false;
		const res = await runInstallCommand([], {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle: fakeLifecycle({}),
			openDashboard: opener.open,
			probeDashboard: async () => {
				probed = true;
				return true;
			},
			detectFleet: fleetDefer,
			dir: tmpDir,
			out: (l) => lines.push(l),
		});
		expect(res.exitCode).toBe(0);
		// The competing-window field bug: fleet mode must open NO browser at all.
		expect(opener.urls).toHaveLength(0);
		// And it must not even probe the portal (the open decision is short-circuited on fleet).
		expect(probed).toBe(false);
		const text = lines.join("\n");
		// One plain line that the Hive portal owns the dashboard, and no honeycomb.local anywhere.
		expect(text).toMatch(/Hive portal owns it/i);
		expect(text).not.toContain("honeycomb.local");
		expect(text).toMatch(/Honeycomb is ready/);
	});

	it("a detection failure defers to fleet: still opens NO dashboard", async () => {
		const lines: string[] = [];
		const opener = recordingOpener(() => true);
		const res = await runInstallCommand([], {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle: fakeLifecycle({}),
			openDashboard: opener.open,
			probeDashboard: reachablePortalProbe,
			detectFleet: async () => {
				throw new Error("classifier blew up");
			},
			dir: tmpDir,
			out: (l) => lines.push(l),
		});
		expect(res.exitCode).toBe(0);
		expect(opener.urls).toHaveLength(0);
		expect(lines.join("\n")).toMatch(/Honeycomb is ready/);
	});
});

describe("C-6 — the portal-not-running sentence is platform-appropriate", () => {
	it("names the POSIX curl pipe on non-win32 platforms and the PowerShell form on win32", () => {
		expect(dashboardPortalNotRunningMessage("linux")).toContain(
			"curl -fsSL https://get.theapiary.sh | sh -s -- --products=honeycomb,doctor,hive",
		);
		expect(dashboardPortalNotRunningMessage("darwin")).toContain(
			"curl -fsSL https://get.theapiary.sh | sh -s -- --products=honeycomb,doctor,hive",
		);
		// The ps1 header documents that a bare `irm | iex` pipe cannot see flags, so the
		// `& { ... } --products=` invocation form is the canonical Windows one-liner.
		expect(dashboardPortalNotRunningMessage("win32")).toContain(
			'powershell -c "& { $(irm https://get.theapiary.sh/install.ps1) } --products=honeycomb,doctor,hive"',
		);
	});

	it("the exported constant IS this platform's message (what runInstallCommand prints)", () => {
		expect(DASHBOARD_PORTAL_NOT_RUNNING_MESSAGE).toBe(dashboardPortalNotRunningMessage(process.platform));
	});
});

describe("C-6 — probeLoopbackDashboard (the production probe, fetch mocked)", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("returns true when the portal answers (any HTTP response proves it is running)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => new Response("ok", { status: 503 })),
		);
		await expect(probeLoopbackDashboard()).resolves.toBe(true);
	});

	it("returns false when the fetch rejects (connection refused)", async () => {
		vi.stubGlobal(
			"fetch",
			vi.fn(async () => {
				throw new Error("ECONNREFUSED");
			}),
		);
		await expect(probeLoopbackDashboard()).resolves.toBe(false);
	});

	it("returns false when the portal hangs past the timeout (the abort path)", async () => {
		// A fetch that never resolves on its own — it only rejects when the probe's timeout aborts it.
		vi.stubGlobal(
			"fetch",
			vi.fn(
				(_url: string, init?: { signal?: AbortSignal }) =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
					}),
			),
		);
		await expect(probeLoopbackDashboard(20)).resolves.toBe(false);
	});
});

describe("PRD-050a — honeycomb install (a-AC-5 onboarding 'installed' + ref)", () => {
	it("a-AC-5 writes phase 'installed' and the DEFAULT_REF when no --ref is given", async () => {
		const res = await runInstallCommand([], {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle: fakeLifecycle({}),
			openDashboard: () => true,
			probeDashboard: reachablePortalProbe,
			detectFleet: fleetDefer,
			dir: tmpDir,
			out: () => {},
		});
		expect(res.exitCode).toBe(0);
		const state = loadOnboarding(tmpDir);
		expect(state.phase).toBe("installed");
		expect(state.ref).toBe(DEFAULT_REF);
	});

	it("a-AC-5 --ref <code> overrides the default ref in the persisted state", async () => {
		const res = await runInstallCommand(["--ref", "alice"], {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle: fakeLifecycle({}),
			openDashboard: () => true,
			probeDashboard: reachablePortalProbe,
			detectFleet: fleetDefer,
			dir: tmpDir,
			out: () => {},
		});
		expect(res.exitCode).toBe(0);
		const state = loadOnboarding(tmpDir);
		expect(state.phase).toBe("installed");
		expect(state.ref).toBe("alice");
	});

	it("a-AC-5 preserves a pre-existing installId across the marker write (stable per machine)", async () => {
		// First run mints + persists an installId; the second must keep it (idempotent upsert).
		const deps = {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle: fakeLifecycle({}),
			openDashboard: () => true,
			probeDashboard: reachablePortalProbe,
			detectFleet: fleetDefer,
			dir: tmpDir,
			out: () => {},
		};
		await runInstallCommand([], deps);
		const first = loadOnboarding(tmpDir).installId;
		await runInstallCommand(["--ref", "bob"], deps);
		const after = loadOnboarding(tmpDir);
		expect(after.installId).toBe(first);
		expect(after.ref).toBe("bob");
	});
});

describe("PRD-071 Contract A — install registers honeycomb with doctor's static registry", () => {
	it("AC-1 / AC-071a.1.1 writes a registry entry under the injected temp HOME (never the real ~/.honeycomb)", async () => {
		const res = await runInstallCommand([], {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle: fakeLifecycle({}),
			openDashboard: () => true,
			probeDashboard: reachablePortalProbe,
			detectFleet: fleetDefer,
			dir: tmpDir,
			out: () => {},
		});
		expect(res.exitCode).toBe(0);
		const registryPath = doctorRegistryPath(tmpDir);
		const doc = JSON.parse(readFileSync(registryPath, "utf8")) as { daemons: Array<Record<string, unknown>> };
		const entry = doc.daemons.find((d) => d.name === "honeycomb");
		expect(entry).toMatchObject({
			name: "honeycomb",
			healthUrl: "http://127.0.0.1:3850/health",
			// PRD-072c / ADR Resolved decision 4: the advertised telemetry path is resolved absolute
			// under the new `~/.apiary/honeycomb/` root, not a `~`-literal.
			telemetryDbPath: join(tmpDir, ".apiary", "honeycomb", "telemetry", "honeycomb.sqlite"),
		});
	});

	it("AC-071a.1.2 a second install run refreshes the entry idempotently rather than duplicating it", async () => {
		const deps = {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle: fakeLifecycle({}),
			openDashboard: () => true,
			probeDashboard: reachablePortalProbe,
			detectFleet: fleetDefer,
			dir: tmpDir,
			out: () => {},
		};
		await runInstallCommand([], deps);
		await runInstallCommand([], deps);
		const registryPath = doctorRegistryPath(tmpDir);
		const doc = JSON.parse(readFileSync(registryPath, "utf8")) as { daemons: Array<Record<string, unknown>> };
		expect(doc.daemons.filter((d) => d.name === "honeycomb")).toHaveLength(1);
	});

	it("a registry write failure is fail-soft: the install still succeeds", async () => {
		// An invalid `dir` (a file, not a directory) makes `mkdirp` fail inside the registry writer.
		const notADir = join(tmpDir, "not-a-directory-marker");
		const { writeFileSync } = await import("node:fs");
		writeFileSync(notADir, "x");
		const lines: string[] = [];
		const res = await runInstallCommand([], {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle: fakeLifecycle({}),
			openDashboard: () => true,
			probeDashboard: reachablePortalProbe,
			detectFleet: fleetDefer,
			dir: notADir,
			out: (l) => lines.push(l),
		});
		expect(res.exitCode).toBe(0);
		expect(lines.join("\n")).toMatch(/Honeycomb is ready/);
	});
});

describe("PRD-050a — ref parsing + URL helpers (units)", () => {
	it("parseRefArg reads `--ref <code>` and `--ref=<code>`, else undefined", () => {
		expect(parseRefArg(["--ref", "alice"])).toBe("alice");
		expect(parseRefArg(["--ref=alice"])).toBe("alice");
		expect(parseRefArg([])).toBeUndefined();
		// A dangling `--ref` with no value is not a ref.
		expect(parseRefArg(["--ref", "--other"])).toBeUndefined();
	});

	it("resolveEffectiveRef falls back to DEFAULT_REF when no --ref", () => {
		expect(resolveEffectiveRef([])).toBe(DEFAULT_REF);
		expect(resolveEffectiveRef(["--ref", "carol"])).toBe("carol");
	});

	it("the dashboard URL is the loopback portal host on port 3853 (honeycomb.local dropped)", () => {
		expect(loopbackDashboardUrl()).toBe("http://127.0.0.1:3853/");
	});

	it("openLocalDashboardUrl REFUSES a non-local (incl. honeycomb.local) or non-http(s) URL without launching", () => {
		// A remote host is refused (returns false, never reaches an OS opener).
		expect(openLocalDashboardUrl("http://evil.example.com/dashboard")).toBe(false);
		// honeycomb.local is no longer a permitted host (BUG 1 dropped the friendly name).
		expect(openLocalDashboardUrl("http://honeycomb.local:3853/")).toBe(false);
		expect(openLocalDashboardUrl("file:///etc/passwd")).toBe(false);
		expect(openLocalDashboardUrl("not a url")).toBe(false);
	});
});
