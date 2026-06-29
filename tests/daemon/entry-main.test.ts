import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { describe, expect, it } from "vitest";

import { isDaemonMainEntry } from "../../src/daemon/index.js";

describe("daemon package entry main guard", () => {
	it("auto-runs only when argv[1] is the daemon entry itself", () => {
		const daemonEntry = join(process.cwd(), "daemon", "index.js");
		const scriptEntry = join(process.cwd(), "scripts", "local-queue-packaged-live-proof.mjs");

		expect(isDaemonMainEntry(pathToFileURL(daemonEntry).href, daemonEntry)).toBe(true);
		expect(isDaemonMainEntry(pathToFileURL(daemonEntry).href, scriptEntry)).toBe(false);
	});

	it("does not treat every bundled daemon/index.js import as a main execution", () => {
		expect(isDaemonMainEntry("file:///tmp/package/daemon/index.js", "/tmp/package/scripts/smoke.mjs")).toBe(false);
	});
});
