/**
 * self-update tests (PRD-064f AC-064f.5): the SOLE path that installs HiveDoctor's
 * own package, and only when explicitly invoked.
 */

import { describe, expect, it } from "vitest";

import { createSelfUpdate } from "../../src/cli/self-update.js";
import { silentLogger } from "../../src/logger.js";
import { HIVEDOCTOR_PACKAGE } from "../../src/version.js";
import type { CommandResult, CommandRunner } from "../../src/rungs/command-runner.js";

/** A fake runner recording the exact argv it was asked to run. */
function recordingRunner(result: CommandResult): { runner: CommandRunner; calls: Array<{ cmd: string; args: string[] }> } {
	const calls: Array<{ cmd: string; args: string[] }> = [];
	return {
		calls,
		runner: {
			async run(cmd, args): Promise<CommandResult> {
				calls.push({ cmd, args: [...args] });
				return result;
			},
		},
	};
}

describe("createSelfUpdate", () => {
	it("runs `npm install -g @legioncodeinc/hivedoctor@latest`", async () => {
		const r = recordingRunner({ ok: true, code: 0, stdout: "", stderr: "" });
		const selfUpdate = createSelfUpdate({ runner: r.runner, logger: silentLogger });
		const msg = await selfUpdate();

		expect(r.calls).toHaveLength(1);
		expect(r.calls[0]?.cmd).toBe("npm");
		expect(r.calls[0]?.args).toEqual(["install", "-g", `${HIVEDOCTOR_PACKAGE}@latest`]);
		expect(msg).toContain("HiveDoctor updated");
	});

	it("targets the HiveDoctor package, never the primary daemon package", async () => {
		const r = recordingRunner({ ok: true, code: 0, stdout: "", stderr: "" });
		await createSelfUpdate({ runner: r.runner, logger: silentLogger })();
		const spec = r.calls[0]?.args[2] ?? "";
		expect(spec.startsWith(HIVEDOCTOR_PACKAGE)).toBe(true);
		expect(spec).not.toContain("@legioncodeinc/honeycomb");
	});

	it("returns a failure message (never throws) on a failed install", async () => {
		const r = recordingRunner({ ok: false, code: 1, stdout: "", stderr: "", detail: "ENETDOWN" });
		const msg = await createSelfUpdate({ runner: r.runner, logger: silentLogger })();
		expect(msg).toContain("self-update failed");
		expect(msg).toContain("ENETDOWN");
	});

	it("honors a custom tag", async () => {
		const r = recordingRunner({ ok: true, code: 0, stdout: "", stderr: "" });
		await createSelfUpdate({ runner: r.runner, logger: silentLogger, tag: "1.0.0" })();
		expect(r.calls[0]?.args[2]).toBe(`${HIVEDOCTOR_PACKAGE}@1.0.0`);
	});
});
