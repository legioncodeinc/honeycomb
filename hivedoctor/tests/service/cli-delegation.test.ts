/**
 * CLI <-> 064b delegation tests (PRD-064b + PRD-064f seam).
 *
 * Proves the `install-service` / `uninstall-service` CLI commands now run the REAL 064b
 * service module (createServiceModule) end-to-end - i.e. the service-stub seam delegates
 * to the real implementation, not the "not yet available" message. The module is wired
 * over the injected runner + in-memory fs so nothing real touches the OS.
 */

import { describe, expect, it } from "vitest";

import { dispatch, EXIT_ERROR, EXIT_OK } from "../../src/cli/dispatch.js";
import { SERVICE_NOT_AVAILABLE, type ServiceResult } from "../../src/cli/service-stub.js";
import { createServiceModule } from "../../src/service/index.js";
import { buildCliHarness } from "../cli/helpers/fake-cli.js";
import { createMemoryFs, createRecordingRunner, fixedEnv } from "./helpers.js";

describe("install-service / uninstall-service delegate to the real 064b module", () => {
	it("install-service runs the real module and prints its result line (not the stub)", async () => {
		const runner = createRecordingRunner();
		const fs = createMemoryFs();
		const serviceModule = createServiceModule({
			execPath: "/usr/bin/hivedoctor",
			runner,
			fs,
			environment: fixedEnv({ platform: "linux", home: "/home/t" }),
		});
		const h = buildCliHarness({ serviceModule });

		const code = await dispatch(["install-service"], h.ctx);

		expect(code).toBe(EXIT_OK);
		// The REAL module ran: it wrote the systemd unit and the result line is its honest output.
		expect(fs.files.has("/home/t/.config/systemd/user/hivedoctor.service")).toBe(true);
		expect(runner.calls[0]?.command).toBe("systemctl");
		expect(h.out.text()).toContain("HiveDoctor registered as a systemd service");
		// And NOT the "not yet available" stub message.
		expect(h.out.text()).not.toContain(SERVICE_NOT_AVAILABLE);
	});

	it("uninstall-service runs the real module's uninstall path", async () => {
		const runner = createRecordingRunner();
		const fs = createMemoryFs();
		fs.files.set("/home/t/.config/systemd/user/hivedoctor.service", "unit");
		const serviceModule = createServiceModule({
			execPath: "/usr/bin/hivedoctor",
			runner,
			fs,
			environment: fixedEnv({ platform: "linux", home: "/home/t" }),
		});
		const h = buildCliHarness({ serviceModule });

		const code = await dispatch(["uninstall-service"], h.ctx);

		expect(code).toBe(EXIT_OK);
		expect(runner.calls[0]?.args).toContain("disable");
		expect(fs.removed).toContain("/home/t/.config/systemd/user/hivedoctor.service");
		expect(h.out.text()).toContain("unregistered");
	});

	it("the result satisfies the ServiceModule interface (install + uninstall return ServiceResult)", async () => {
		const serviceModule = createServiceModule({
			execPath: "/usr/bin/hivedoctor",
			runner: createRecordingRunner(),
			fs: createMemoryFs(),
			environment: fixedEnv({ platform: "darwin" }),
		});
		const installResult: ServiceResult = await serviceModule.install();
		const uninstallResult: ServiceResult = await serviceModule.uninstall();
		expect(typeof installResult.ok).toBe("boolean");
		expect(typeof installResult.message).toBe("string");
		expect(typeof uninstallResult.ok).toBe("boolean");
		expect(typeof uninstallResult.message).toBe("string");
	});
});

describe("install-service exit code is honest (IRD-192 AC-6)", () => {
	it("AC-6: a manager-command failure (ok:false) -> non-zero exit + the failure line is printed", async () => {
		// A fake service module whose install() resolves ok:false mirrors the IRD-192 root-cause
		// scenario (schtasks /Create rejected the XML). The CLI MUST map that to EXIT_ERROR so the
		// one-command installers do NOT print "HiveDoctor is watching" (AC-7 depends on this exit).
		const serviceModule = {
			async install(): Promise<ServiceResult> {
				return {
					ok: false,
					message: "Registered the HiveDoctor unit but a service-manager command failed (schtasks).",
				};
			},
			async uninstall(): Promise<ServiceResult> {
				return { ok: true, message: "unregistered" };
			},
		};
		const h = buildCliHarness({ serviceModule });

		const code = await dispatch(["install-service"], h.ctx);

		expect(code).toBe(EXIT_ERROR);
		expect(h.out.text()).toContain("service-manager command failed");
	});

	it("AC-6: uninstall maps ok:false -> non-zero exit too", async () => {
		const serviceModule = {
			async install(): Promise<ServiceResult> {
				return { ok: true, message: "installed" };
			},
			async uninstall(): Promise<ServiceResult> {
				return { ok: false, message: "a deregister command (schtasks) reported an error." };
			},
		};
		const h = buildCliHarness({ serviceModule });

		const code = await dispatch(["uninstall-service"], h.ctx);

		expect(code).toBe(EXIT_ERROR);
		expect(h.out.text()).toContain("deregister command");
	});
});
