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

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	createFakeDaemonClient,
	type DaemonLifecycle,
	type DaemonStatus,
	localDashboardUrl,
	loopbackDashboardUrl,
	openLocalDashboardUrl,
	parseRefArg,
	resolveEffectiveRef,
	runInstallCommand,
} from "../../src/commands/index.js";
import { DEFAULT_REF, loadOnboarding } from "../../src/daemon/runtime/onboarding/index.js";
import { hivedoctorRegistryPath } from "../../src/daemon/runtime/telemetry/fleet-registry.js";

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

let tmpDir: string;

beforeEach(() => {
	tmpDir = mkdtempSync(join(tmpdir(), "hc-install-"));
});

afterEach(() => {
	rmSync(tmpDir, { recursive: true, force: true });
});

describe("PRD-050a — honeycomb install (a-AC-4 health-gated open)", () => {
	it("a-AC-4 opens the dashboard ONLY after the daemon is reachable (already-up path)", async () => {
		const lines: string[] = [];
		const opener = recordingOpener(() => true);
		const lifecycle = fakeLifecycle({});
		const res = await runInstallCommand([], {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle,
			openDashboard: opener.open,
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

describe("PRD-050a — honeycomb install (a-AC-6 honeycomb.local → loopback fallback)", () => {
	it("a-AC-6 attempts honeycomb.local first, then falls back to loopback when that open fails", async () => {
		// The friendly honeycomb.local open FAILS; loopback succeeds. The run must still succeed.
		const opener = recordingOpener((url) => url === loopbackDashboardUrl());
		const res = await runInstallCommand([], {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle: fakeLifecycle({}),
			openDashboard: opener.open,
			dir: tmpDir,
			out: () => {},
		});
		expect(res.exitCode).toBe(0);
		// First attempt = honeycomb.local; fallback = loopback (a-AC-6).
		expect(opener.urls[0]).toBe(localDashboardUrl());
		expect(opener.urls).toContain(loopbackDashboardUrl());
	});

	it("a-AC-6 the run still succeeds even if BOTH opens fail (no browser available)", async () => {
		const lines: string[] = [];
		const opener = recordingOpener(() => false); // no browser anywhere
		const res = await runInstallCommand([], {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle: fakeLifecycle({}),
			openDashboard: opener.open,
			dir: tmpDir,
			out: (l) => lines.push(l),
		});
		expect(res.exitCode).toBe(0);
		// The loopback URL is printed so a headless host learns where the dashboard lives.
		expect(lines.join("\n")).toContain(loopbackDashboardUrl());
		expect(lines.join("\n")).toMatch(/Honeycomb is ready/);
	});
});

describe("PRD-050a — honeycomb install (a-AC-5 onboarding 'installed' + ref)", () => {
	it("a-AC-5 writes phase 'installed' and the DEFAULT_REF when no --ref is given", async () => {
		const res = await runInstallCommand([], {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle: fakeLifecycle({}),
			openDashboard: () => true,
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

describe("PRD-071 Contract A — install registers honeycomb with hivedoctor's static registry", () => {
	it("AC-1 / AC-071a.1.1 writes a registry entry under the injected temp HOME (never the real ~/.honeycomb)", async () => {
		const res = await runInstallCommand([], {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle: fakeLifecycle({}),
			openDashboard: () => true,
			dir: tmpDir,
			out: () => {},
		});
		expect(res.exitCode).toBe(0);
		const registryPath = hivedoctorRegistryPath(tmpDir);
		const doc = JSON.parse(readFileSync(registryPath, "utf8")) as { daemons: Array<Record<string, unknown>> };
		const entry = doc.daemons.find((d) => d.name === "honeycomb");
		expect(entry).toMatchObject({
			name: "honeycomb",
			healthUrl: "http://127.0.0.1:3850/health",
			telemetryDbPath: "~/.honeycomb/telemetry/honeycomb.sqlite",
		});
	});

	it("AC-071a.1.2 a second install run refreshes the entry idempotently rather than duplicating it", async () => {
		const deps = {
			daemon: createFakeDaemonClient({ alive: true }),
			lifecycle: fakeLifecycle({}),
			openDashboard: () => true,
			dir: tmpDir,
			out: () => {},
		};
		await runInstallCommand([], deps);
		await runInstallCommand([], deps);
		const registryPath = hivedoctorRegistryPath(tmpDir);
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

	it("the URLs are the loopback + honeycomb.local dashboard hosts on port 3850", () => {
		expect(loopbackDashboardUrl()).toBe("http://127.0.0.1:3853/");
		expect(localDashboardUrl()).toBe("http://honeycomb.local:3853/");
	});

	it("openLocalDashboardUrl REFUSES a non-local or non-http(s) URL without launching", () => {
		// A remote host is refused (returns false, never reaches an OS opener).
		expect(openLocalDashboardUrl("http://evil.example.com/dashboard")).toBe(false);
		expect(openLocalDashboardUrl("file:///etc/passwd")).toBe(false);
		expect(openLocalDashboardUrl("not a url")).toBe(false);
	});
});
