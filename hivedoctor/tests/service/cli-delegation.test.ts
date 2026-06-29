/**
 * CLI <-> 064b delegation tests (PRD-064b + PRD-064f seam).
 *
 * Proves the `install-service` / `uninstall-service` CLI commands now run the REAL 064b
 * service module (createServiceModule) end-to-end - i.e. the service-stub seam delegates
 * to the real implementation, not the "not yet available" message. The module is wired
 * over the injected runner + in-memory fs so nothing real touches the OS.
 */

import { describe, expect, it } from "vitest";

import { dispatch, EXIT_OK } from "../../src/cli/dispatch.js";
import { SERVICE_NOT_AVAILABLE } from "../../src/cli/service-stub.js";
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

	it("the result satisfies the ServiceModule interface (install + uninstall return strings)", async () => {
		const serviceModule = createServiceModule({
			execPath: "/usr/bin/hivedoctor",
			runner: createRecordingRunner(),
			fs: createMemoryFs(),
			environment: fixedEnv({ platform: "darwin" }),
		});
		expect(typeof (await serviceModule.install())).toBe("string");
		expect(typeof (await serviceModule.uninstall())).toBe("string");
	});
});
