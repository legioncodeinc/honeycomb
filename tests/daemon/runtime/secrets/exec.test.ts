/**
 * PRD-012b secret_exec — the controlled-USE path (b-AC-1..6).
 *
 * The thesis under test: an agent can CAUSE a secret to be USED but NEVER receives a
 * decrypted value. So every test below proves BOTH halves at once where it can:
 *   - the secret value really reaches the subprocess ENV (the use is real), AND
 *   - the value the caller reads back is `[REDACTED]`, never the raw secret.
 *
 * Verification posture: a REAL `child_process.spawn` of a portable command —
 * `process.execPath` (the running Node) with `-e "<script>"` — so the test exercises the
 * actual spawn/redaction/timeout machinery, not a mock. Timeouts use a SMALL injectable
 * value so the timeout-kill test is fast (not 5 minutes). The store is the REAL Wave-1
 * `SecretsStore` over a temp dir + fake machine key; the vault uses the Wave-1
 * `createFakeVaultProvider`. NO raw secret value is ever asserted to appear in a
 * response/status/audit.
 *
 * b-AC-1 submit → 202-shaped accept + jobId + spawn with resolved secrets in env + timeout.
 * b-AC-2 every occurrence of a secret in stdout/stderr → `[REDACTED]` before the caller sees it.
 * b-AC-3 status → redacted output, scope-checked, never a raw secret.
 * b-AC-4 vault ref resolved BY REFERENCE, value injected into env, `.secrets/` untouched.
 * b-AC-5 timeout → killed → terminal status + redacted partial output, no raw credential.
 * b-AC-6 concurrent submits beyond the pool QUEUE (and a full queue is rejected).
 */

import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createFakeMachineKeyProvider,
	createFakeVaultProvider,
	type SecretScope,
} from "../../../../src/daemon/runtime/secrets/contracts.js";
import {
	type ExecAuditEvent,
	type ExecAuditSink,
	RollingRedactor,
	SecretExecRunner,
	clampTimeout,
	DEFAULT_EXEC_TIMEOUT_MS,
	MAX_EXEC_TIMEOUT_MS,
	REDACTED,
	redactAll,
	type Spawner,
} from "../../../../src/daemon/runtime/secrets/exec.js";
import { SecretsStore, SECRETS_DIR_NAME } from "../../../../src/daemon/runtime/secrets/store.js";

const NODE = process.execPath;
const SECRET = "sk-OPENAI-do-not-leak-7f3a9c";
const SCOPE: SecretScope = { org: "acme", workspace: "backend", agentId: "agent-1" };

let base: string;
let store: SecretsStore;
/** A capturing audit sink so we can assert NO event ever carries the value. */
let audit: { events: ExecAuditEvent[]; sink: ExecAuditSink };

function makeAudit(): { events: ExecAuditEvent[]; sink: ExecAuditSink } {
	const events: ExecAuditEvent[] = [];
	return { events, sink: { record: (e) => events.push(e) } };
}

beforeEach(() => {
	base = mkdtempSync(join(tmpdir(), "hc-exec-"));
	store = new SecretsStore({
		baseDir: base,
		machineKey: createFakeMachineKeyProvider("machine-A"),
		clock: { now: () => "2026-06-18T00:00:00.000Z" },
	});
	audit = makeAudit();
});
afterEach(() => {
	rmSync(base, { recursive: true, force: true });
});

/** Assert that NOTHING in a captured audit log carries the raw secret value. */
function auditHasNoSecret(events: ExecAuditEvent[]): void {
	expect(JSON.stringify(events)).not.toContain(SECRET);
}

describe("b-AC-1 submit queues (202), spawns with resolved secrets in env, enforces timeout", () => {
	it("submit returns a jobId synchronously, then spawns the child with the secret in env", async () => {
		expect((await store.setSecret("MY_SECRET", SECRET, SCOPE)).ok).toBe(true);
		const runner = new SecretExecRunner({ store, audit: audit.sink });

		// The child reads the secret FROM ENV and writes it — proving the value reached env.
		const res = runner.submit({
			command: NODE,
			args: ["-e", "process.stdout.write('value-is:' + process.env.MY_SECRET)"],
			secretNames: ["MY_SECRET"],
			scope: SCOPE,
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		expect(typeof res.jobId).toBe("string");

		await runner.waitFor(res.jobId);
		const view = runner.getStatus(res.jobId, SCOPE);
		expect(view).not.toBeNull();
		expect(view?.status).toBe("succeeded");
		// The child DID run and DID read env (the prefix proves the write happened)…
		expect(view?.stdout).toContain("value-is:");
		// …but the value itself is redacted on the way out (b-AC-2 cross-check).
		expect(view?.stdout).not.toContain(SECRET);
		expect(view?.stdout).toContain(REDACTED);
		auditHasNoSecret(audit.events);
	});

	it("clamps the timeout: default 5 min when absent, 30 min ceiling, 1 ms floor", () => {
		expect(clampTimeout(undefined)).toBe(DEFAULT_EXEC_TIMEOUT_MS);
		expect(clampTimeout(60 * 60 * 1_000)).toBe(MAX_EXEC_TIMEOUT_MS); // an hour clamps to 30 min.
		expect(clampTimeout(0)).toBe(1); // non-positive clamps up to the floor.
		expect(clampTimeout(-5)).toBe(1);
		expect(clampTimeout(1_234)).toBe(1_234); // an in-range value passes through.
	});
});

describe("b-AC-2 every occurrence of a secret in stdout/stderr is redacted", () => {
	it("redacts the value on stdout AND stderr, every occurrence", async () => {
		await store.setSecret("MY_SECRET", SECRET, SCOPE);
		const runner = new SecretExecRunner({ store, audit: audit.sink });

		const res = runner.submit({
			command: NODE,
			args: [
				"-e",
				// Emit the secret multiple times across both streams.
				"const s=process.env.MY_SECRET;process.stdout.write(s+'|'+s);process.stderr.write('err:'+s)",
			],
			secretNames: ["MY_SECRET"],
			scope: SCOPE,
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		await runner.waitFor(res.jobId);
		const view = runner.getStatus(res.jobId, SCOPE);

		expect(view?.stdout).not.toContain(SECRET);
		expect(view?.stderr).not.toContain(SECRET);
		// Both occurrences on stdout are masked → two REDACTED tokens.
		expect(view?.stdout.split(REDACTED).length - 1).toBe(2);
		expect(view?.stderr).toContain(`err:${REDACTED}`);
		auditHasNoSecret(audit.events);
	});

	it("RollingRedactor catches a value split across chunk boundaries", () => {
		const r = new RollingRedactor([SECRET]);
		// Feed the secret one CHARACTER at a time — the worst-case chunk boundary.
		for (const ch of `before-${SECRET}-after`) r.push(ch);
		const out = r.flush();
		expect(out).toBe(`before-${REDACTED}-after`);
		expect(out).not.toContain(SECRET);
	});

	it("RollingRedactor catches a value split into two arbitrary halves", () => {
		const r = new RollingRedactor([SECRET]);
		const mid = Math.floor(SECRET.length / 2);
		r.push(`xx${SECRET.slice(0, mid)}`); // first half straddles into the carry…
		r.push(`${SECRET.slice(mid)}yy`); // …second half completes it.
		expect(r.flush()).toBe(`xx${REDACTED}yy`);
	});

	it("redactAll masks overlapping/multiple values (longest-first)", () => {
		expect(redactAll("a=AAAA b=BB", ["AAAA", "BB"])).toBe(`a=${REDACTED} b=${REDACTED}`);
		// An empty value is ignored (never an infinite-loop or whole-string mask).
		expect(redactAll("hello", [""])).toBe("hello");
	});
});

describe("b-AC-3 status returns redacted output, scope-checked, never a raw secret", () => {
	it("a different scope cannot read another scope's job (404-shaped null)", async () => {
		await store.setSecret("MY_SECRET", SECRET, SCOPE);
		const runner = new SecretExecRunner({ store, audit: audit.sink });
		const res = runner.submit({
			command: NODE,
			args: ["-e", "process.stdout.write(process.env.MY_SECRET)"],
			secretNames: ["MY_SECRET"],
			scope: SCOPE,
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		await runner.waitFor(res.jobId);

		// Same scope → a (redacted) view.
		const own = runner.getStatus(res.jobId, SCOPE);
		expect(own).not.toBeNull();
		expect(own?.stdout).not.toContain(SECRET);

		// A DIFFERENT agent in the same workspace → null (cannot even confirm the job exists).
		const otherAgent = runner.getStatus(res.jobId, { ...SCOPE, agentId: "agent-2" });
		expect(otherAgent).toBeNull();
		// A different org → null.
		const otherOrg = runner.getStatus(res.jobId, { ...SCOPE, org: "evil" });
		expect(otherOrg).toBeNull();
	});

	it("an unknown jobId is null (not an oracle)", () => {
		const runner = new SecretExecRunner({ store, audit: audit.sink });
		expect(runner.getStatus("exec-nope", SCOPE)).toBeNull();
	});
});

describe("b-AC-4 vault ref resolves BY REFERENCE; .secrets/ is NOT touched", () => {
	it("injects a vault value into env, redacts it, and writes nothing to .secrets/", async () => {
		const vault = createFakeVaultProvider({ "op://vault/item/field": SECRET });
		const runner = new SecretExecRunner({ store, vault, audit: audit.sink });

		const secretsDir = join(base, SECRETS_DIR_NAME);
		const before = existsSync(secretsDir) ? readdirSync(secretsDir) : [];

		const res = runner.submit({
			command: NODE,
			args: ["-e", "process.stdout.write('vault:' + process.env.VAULT_TOKEN)"],
			vaultRefs: { VAULT_TOKEN: "op://vault/item/field" },
			scope: SCOPE,
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		await runner.waitFor(res.jobId);
		const view = runner.getStatus(res.jobId, SCOPE);

		// The vault value reached the child env (the prefix proves the write)…
		expect(view?.stdout).toContain("vault:");
		// …and is redacted on the way out, never the raw value.
		expect(view?.stdout).not.toContain(SECRET);
		expect(view?.stdout).toContain(REDACTED);

		// CRITICAL (b-AC-4): the vault value was NOT duplicated into `.secrets/`.
		const after = existsSync(secretsDir) ? readdirSync(secretsDir) : [];
		expect(after).toEqual(before);
		auditHasNoSecret(audit.events);
	});

	it("an unresolved vault ref fails the job closed (never runs with a gap)", async () => {
		const vault = createFakeVaultProvider({}); // empty table → every ref rejects.
		const runner = new SecretExecRunner({ store, vault, audit: audit.sink });
		const res = runner.submit({
			command: NODE,
			args: ["-e", "process.stdout.write('should-not-run')"],
			vaultRefs: { VAULT_TOKEN: "op://missing" },
			scope: SCOPE,
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		await runner.waitFor(res.jobId);
		expect(runner.getStatus(res.jobId, SCOPE)?.status).toBe("failed");
	});
});

describe("b-AC-5 a job exceeding its timeout is killed → terminal + redacted partial output", () => {
	it("kills a runaway, marks timed_out, and the partial output has no raw secret", async () => {
		await store.setSecret("MY_SECRET", SECRET, SCOPE);
		const runner = new SecretExecRunner({ store, audit: audit.sink, killGraceMs: 50 });

		// Print the secret, then sleep far longer than the (tiny) timeout so it MUST be killed.
		const res = runner.submit({
			command: NODE,
			args: [
				"-e",
				"process.stdout.write('partial:'+process.env.MY_SECRET);setInterval(()=>{},1000)",
			],
			secretNames: ["MY_SECRET"],
			scope: SCOPE,
			timeoutMs: 150, // a FAST timeout — the test does not wait 5 minutes.
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		await runner.waitFor(res.jobId);

		expect(runner.getStatus(res.jobId, SCOPE)?.status).toBe("timed_out");
		expect(runner.getStatus(res.jobId, SCOPE)?.timedOut).toBe(true);
		// The partial output it DID emit before the kill is present but REDACTED. Under parallel
		// load the killed child's buffered stdout is drained slightly after the job settles, so
		// POLL the redacted status (a bounded waitFor) rather than reading it at a fixed instant —
		// the assertion intent is unchanged (the partial IS captured + carries the marker).
		await vi.waitFor(() => {
			expect(runner.getStatus(res.jobId, SCOPE)?.stdout).toContain("partial:");
		});
		const view = runner.getStatus(res.jobId, SCOPE);
		expect(view?.stdout).toContain("partial:");
		expect(view?.stdout).not.toContain(SECRET);
		auditHasNoSecret(audit.events);
	});
});

describe("b-AC-6 concurrent submits beyond the pool QUEUE (and a full queue is rejected)", () => {
	it("with poolSize 1, two concurrent submits → at most one active, the other queued", async () => {
		await store.setSecret("MY_SECRET", SECRET, SCOPE);
		const runner = new SecretExecRunner({ store, audit: audit.sink, poolSize: 1, maxQueue: 8 });

		const mkReq = () => ({
			command: NODE,
			// A short sleep so both jobs are in flight while we inspect the pool.
			args: ["-e", "setTimeout(()=>{},120)"],
			secretNames: ["MY_SECRET"] as string[],
			scope: SCOPE,
		});
		const a = runner.submit(mkReq());
		const b = runner.submit(mkReq());
		expect(a.ok && b.ok).toBe(true);

		// The pool is bounded at 1: exactly one runs, the other waits in the queue.
		expect(runner.activeCount()).toBeLessThanOrEqual(1);
		expect(runner.queuedCount()).toBeGreaterThanOrEqual(1);

		if (a.ok) await runner.waitFor(a.jobId);
		if (b.ok) await runner.waitFor(b.jobId);
		// Both eventually complete (the queue drained, never dropped).
		if (a.ok) expect(runner.getStatus(a.jobId, SCOPE)?.status).toBe("succeeded");
		if (b.ok) expect(runner.getStatus(b.jobId, SCOPE)?.status).toBe("succeeded");
		expect(runner.queuedCount()).toBe(0);
	});

	it("a full pool + full queue REJECTS further submits (the DoS bound)", () => {
		// A spawner that NEVER exits, so jobs stay active and the queue fills and stays full.
		const hangingSpawner: Spawner = {
			spawn() {
				// A minimal child-like object whose streams never emit and which never closes.
				const noop = { on: () => undefined };
				return {
					stdout: noop,
					stderr: noop,
					on: () => undefined,
					kill: () => true,
				} as never;
			},
		};
		const runner = new SecretExecRunner({
			store,
			audit: audit.sink,
			spawner: hangingSpawner,
			poolSize: 1,
			maxQueue: 1,
		});
		const req = { command: NODE, args: ["-e", ""], scope: SCOPE };
		const first = runner.submit(req); // → active (pool slot 1).
		const second = runner.submit(req); // → queued (queue slot 1).
		const third = runner.submit(req); // → pool full AND queue full → REJECTED.
		expect(first.ok).toBe(true);
		expect(second.ok).toBe(true);
		expect(third.ok).toBe(false);
		if (!third.ok) expect(third.reason).toBe("queue_full");
		// A rejection is audited (without a value).
		expect(audit.events.some((e) => e.op === "exec_rejected")).toBe(true);
		auditHasNoSecret(audit.events);
	});
});

describe("env hygiene: the daemon's OWN ambient credentials never reach the child (no inherited-secret leak)", () => {
	it("a daemon credential in process.env is NOT inherited, so a child cannot echo it back", async () => {
		// Simulate the daemon running with its Activeloop credential + a provider key in env.
		const DAEMON_TOKEN = "AL-DAEMON-TOKEN-must-not-leak-9d2f";
		const PROVIDER_KEY = "sk-PROVIDER-ambient-key-do-not-leak";
		process.env.HONEYCOMB_DEEPLAKE_TOKEN = DAEMON_TOKEN;
		process.env.SOME_PROVIDER_API_KEY = PROVIDER_KEY;
		try {
			const runner = new SecretExecRunner({ store, audit: audit.sink });
			// A hostile child dumps the WHOLE env — the prompt-injection exfiltration attempt.
			const res = runner.submit({
				command: NODE,
				args: ["-e", "process.stdout.write(JSON.stringify(process.env))"],
				scope: SCOPE,
			});
			expect(res.ok).toBe(true);
			if (!res.ok) return;
			await runner.waitFor(res.jobId);
			const view = runner.getStatus(res.jobId, SCOPE);
			expect(view?.status).toBe("succeeded");
			// The daemon's ambient credentials were stripped before the child saw them, so they
			// are absent from the dumped env entirely (NOT merely redacted — they never arrived).
			expect(view?.stdout).not.toContain(DAEMON_TOKEN);
			expect(view?.stdout).not.toContain(PROVIDER_KEY);
			// Sanity: a non-sensitive var DOES still pass through (the child can resolve its exe).
			expect(view?.stdout).toContain("PATH");
		} finally {
			delete process.env.HONEYCOMB_DEEPLAKE_TOKEN;
			delete process.env.SOME_PROVIDER_API_KEY;
		}
	});

	it("an explicitly-requested secret still reaches the child even if its name looks sensitive", async () => {
		// A job-requested secret named like a credential must STILL be injected (and redacted) —
		// the strip only removes INHERITED parent-env vars, not the job's resolved secrets.
		await store.setSecret("JOB_API_KEY", SECRET, SCOPE);
		const runner = new SecretExecRunner({ store, audit: audit.sink });
		const res = runner.submit({
			command: NODE,
			args: ["-e", "process.stdout.write('used:'+(process.env.JOB_API_KEY?'yes':'no'))"],
			secretNames: ["JOB_API_KEY"],
			scope: SCOPE,
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		await runner.waitFor(res.jobId);
		const view = runner.getStatus(res.jobId, SCOPE);
		// The secret reached the child (use is real)…
		expect(view?.stdout).toContain("used:yes");
		// …and is still redacted on the way out.
		expect(view?.stdout).not.toContain(SECRET);
	});
});

describe("NO-SHELL confirmation: a shell metacharacter in an arg is inert", () => {
	it("a hostile arg is passed verbatim, never re-parsed by a shell", async () => {
		const runner = new SecretExecRunner({ store, audit: audit.sink });
		// If this were run through a shell, `; echo PWNED` would execute a second command.
		// With shell:false it is a literal argv entry that the script just echoes back.
		const res = runner.submit({
			command: NODE,
			args: ["-e", "process.stdout.write(process.argv[1])", "; echo PWNED"],
			scope: SCOPE,
		});
		expect(res.ok).toBe(true);
		if (!res.ok) return;
		await runner.waitFor(res.jobId);
		const view = runner.getStatus(res.jobId, SCOPE);
		expect(view?.status).toBe("succeeded");
		// The arg is echoed as data; PWNED never ran as a command (no separate output line).
		expect(view?.stdout).toContain("; echo PWNED");
	});
});
