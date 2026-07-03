/**
 * PRD-019d secrets value-safety — d-AC-2 (HARD security property).
 *
 * The secrets surface NEVER returns a raw value: `secret_list` returns names,
 * `secret_exec` returns redacted output. These tests PROVE no value leaks even when
 * the daemon (mis)behaves and attaches a value field — the handler reconstructs the
 * result from names/redacted output alone. Driven against a fake seam (no daemon).
 */

import { describe, expect, it } from "vitest";
import { type Actor, createFakeDaemonApiSeam, REDACTED } from "../../mcp/src/index.js";
import { HANDLERS } from "../../mcp/src/handlers.js";

const ACTOR: Actor = { actor: "user-1", actorType: "user" };

/** A value no value-safe result may ever contain. */
const SECRET_VALUE = "sk-live-SUPERSECRET-0xDEADBEEF";

describe("d-AC-2: secrets are value-safe (list names, exec redacted)", () => {
	it("d-AC-2 secret_list returns NAMES only — never a value, even if the daemon attaches one", async () => {
		// The daemon misbehaves: it attaches `value` fields alongside the names.
		const daemon = createFakeDaemonApiSeam({
			status: 200,
			body: {
				names: ["OPENAI_API_KEY", "GITHUB_TOKEN"],
				// A hostile/buggy daemon shape — must NOT survive into the result.
				values: { OPENAI_API_KEY: SECRET_VALUE },
				value: SECRET_VALUE,
			},
		});
		const res = (await HANDLERS.secret_list({}, ACTOR, daemon)) as { names: string[] };
		expect(res.names).toEqual(["OPENAI_API_KEY", "GITHUB_TOKEN"]);
		// HARD property: the serialized result contains no secret value anywhere.
		expect(JSON.stringify(res)).not.toContain(SECRET_VALUE);
		expect(Object.keys(res)).toEqual(["names"]);
	});

	it("d-AC-2 secret_exec returns REDACTED output — the raw value never escapes", async () => {
		// The daemon returns redacted output (its contract). The handler coerces to
		// { status, output } and never echoes a raw value.
		const daemon = createFakeDaemonApiSeam({
			status: 200,
			body: { status: 0, output: `connected with ${REDACTED}` },
		});
		const res = (await HANDLERS.secret_exec({ command: "deploy" }, ACTOR, daemon)) as {
			status?: number;
			output: string;
		};
		expect(res.output).toContain(REDACTED);
		expect(JSON.stringify(res)).not.toContain(SECRET_VALUE);
	});

	it("d-AC-2 secret_exec with an empty/absent output still returns the REDACTED token", async () => {
		const daemon = createFakeDaemonApiSeam({ status: 200, body: { status: 0 } });
		const res = (await HANDLERS.secret_exec({ command: "noop" }, ACTOR, daemon)) as { output: string };
		expect(res.output).toBe(REDACTED);
	});

	it("M-10 secret_exec preserves the jobId from a 202 submit ack instead of dropping it", async () => {
		// The REAL daemon shape (`secrets/api.ts` POST /exec): a 202 job-submission ack, not a
		// finished result — `status` is a lifecycle string, there is no `output` field yet.
		const daemon = createFakeDaemonApiSeam({ status: 202, body: { ok: true, jobId: "exec-1-1-42", status: "queued" } });
		const res = (await HANDLERS.secret_exec({ command: "deploy" }, ACTOR, daemon)) as {
			jobId?: string;
			status?: string;
			output: string;
		};
		expect(res.jobId, "the jobId must survive so the submitted job is not orphaned").toBe("exec-1-1-42");
		expect(res.status).toBe("queued");
		// Nothing has run yet — no stdout/stderr/output field — falls to the safe placeholder.
		expect(res.output).toBe(REDACTED);
	});

	it("M-10 secret_exec surfaces the already-redacted stdout/stderr from a job-status poll", async () => {
		// The REAL daemon shape (`secrets/api.ts` GET /exec/:jobId): an `ExecJobView` — already
		// redacted by the daemon's RollingRedactor before it ever left the daemon.
		const daemon = createFakeDaemonApiSeam({
			status: 200,
			body: {
				jobId: "exec-1-1-42",
				status: "succeeded",
				stdout: `connected with ${REDACTED}`,
				stderr: "",
				exitCode: 0,
				signal: null,
				timedOut: false,
			},
		});
		const res = (await HANDLERS.secret_exec({ command: "deploy" }, ACTOR, daemon)) as {
			jobId?: string;
			status?: string;
			output: string;
		};
		expect(res.jobId).toBe("exec-1-1-42");
		expect(res.status).toBe("succeeded");
		expect(res.output).toContain(REDACTED);
		expect(JSON.stringify(res)).not.toContain(SECRET_VALUE);
	});

	it("d-AC-2 both secrets handlers still route through the daemon (plugin + actor stamp)", async () => {
		const listDaemon = createFakeDaemonApiSeam({ status: 200, body: { names: [] } });
		await HANDLERS.secret_list({}, ACTOR, listDaemon);
		expect(listDaemon.calls.length).toBe(1);
		expect(listDaemon.calls[0].actor).toEqual(ACTOR);

		const execDaemon = createFakeDaemonApiSeam({ status: 200, body: { output: REDACTED } });
		await HANDLERS.secret_exec({ command: "x" }, ACTOR, execDaemon);
		expect(execDaemon.calls.length).toBe(1);
		expect(execDaemon.calls[0].actor).toEqual(ACTOR);
	});
});
