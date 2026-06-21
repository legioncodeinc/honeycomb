/**
 * secret_exec — PRD-012b (Wave 2, IMPLEMENTED). The exec model that USES secrets
 * without ever revealing them.
 *
 * ── The thesis at the exec boundary ──────────────────────────────────────────
 * An agent can CAUSE a secret to be used but NEVER receives a decrypted value. So a
 * `secret_exec` job:
 *   - resolves the requested secret NAMES (via the store's INTERNAL `getSecretValue`)
 *     and the requested vault REFERENCES (via the `VaultProvider` seam) to their values,
 *     and injects those values ONLY into the spawned subprocess's `env` — never into the
 *     response, a log, or anything persisted (FR-2 / b-AC-1);
 *   - spawns the subprocess WITHOUT a shell (`shell: false`, command + args array) so
 *     there is NO shell-injection surface — an arg is an arg, never re-parsed by `/bin/sh`
 *     (FR-3, the no-shell rule);
 *   - captures stdout+stderr and REDACTS every occurrence of every resolved value to
 *     `[REDACTED]` BEFORE it is ever stored on the job or returned (FR-4 / b-AC-2 / b-AC-3),
 *     handling the chunk-boundary case (a value split across two read chunks) via a
 *     rolling-tail redactor (see {@link RollingRedactor});
 *   - enforces a timeout (5 min default / 30 max — clamped) and KILLS a runaway
 *     (SIGTERM then SIGKILL) → a TERMINAL status with redacted PARTIAL output and no raw
 *     credential (FR-3 / FR-9 / b-AC-1 / b-AC-5);
 *   - runs behind a BOUNDED worker pool with a BOUNDED queue — excess concurrent submits
 *     QUEUE rather than spawn unboundedly, and a full queue is REJECTED (the DoS guard,
 *     the same capped-map posture as `auth/rate-limit.ts`) (FR-3 / b-AC-6);
 *   - is SCOPED to the requesting org/workspace/agent — `getSecretExecStatus` only returns
 *     a job to the SAME scope that submitted it (FR-8 / b-AC-3);
 *   - appends a REDACTED NDJSON audit event for every op (`secret.resolved_for_exec`,
 *     `secret.exec_started`, `secret.exec_finished`) — op + jobId + scope + outcome,
 *     NEVER a value (FR-7).
 *
 * The vault REFERENCE values are NOT duplicated into `.secrets/` (b-AC-4): they are pulled
 * at use-time and live only transiently in the child env + the redaction set, exactly like
 * a store-resolved value.
 *
 * ── Boundary ─────────────────────────────────────────────────────────────────
 * This module owns the runner + the 012b API handlers' backing logic. It consumes the
 * Wave-1 frozen `getSecretValue` (the single decrypt path) + the `VaultProvider` seam; it
 * does NOT edit `contracts.ts`, `crypto.ts`, or `store.ts`. It opens NO DeepLake (filesystem
 * only — the audit NDJSON), builds NO SQL. The spawner + clock + audit sink are all
 * injectable so a test runs a real `child_process.spawn` of a portable command with a fast
 * timeout and a fixed clock, asserting redaction over real captured bytes.
 */

import { spawn } from "node:child_process";
import type { ChildProcessWithoutNullStreams } from "node:child_process";

import { type SecretScope, type VaultProvider } from "./contracts.js";
import type { SecretsStore, ValueResult } from "./store.js";

// ─────────────────────────────────────────────────────────────────────────────
// Constants — the timeout clamp + pool/queue bounds (D-6 / D-7 / b-AC-5 / b-AC-6)
// ─────────────────────────────────────────────────────────────────────────────

/** The default exec timeout (5 minutes — D-6 / b-AC-1). */
export const DEFAULT_EXEC_TIMEOUT_MS = 5 * 60 * 1_000;
/** The MAX exec timeout (30 minutes — D-6 / b-AC-1). A larger request is clamped DOWN. */
export const MAX_EXEC_TIMEOUT_MS = 30 * 60 * 1_000;
/** The floor for a timeout (1 ms). A non-positive request is clamped UP — a job always has a deadline. */
export const MIN_EXEC_TIMEOUT_MS = 1;

/** The default bounded worker-pool size (D-7 / b-AC-6). Concurrent spawns are capped at this. */
export const DEFAULT_POOL_SIZE = 4;
/**
 * The default bounded queue depth (D-7 / b-AC-6, the DoS guard). Submits beyond
 * `poolSize + maxQueue` are REJECTED rather than growing memory without limit — the same
 * capped posture as `auth/rate-limit.ts`'s capped map.
 */
export const DEFAULT_MAX_QUEUE = 64;

/**
 * The grace period between SIGTERM and SIGKILL when killing a timed-out job (b-AC-5). The
 * child gets a chance to exit cleanly on SIGTERM; if it is still alive after the grace, it
 * is force-killed with SIGKILL so a runaway can never outlive its deadline.
 */
export const KILL_GRACE_MS = 2_000;

/** The redaction token every secret value is replaced with (FR-4 / b-AC-2). */
export const REDACTED = "[REDACTED]" as const;

/** A hard cap on captured output per stream (bytes) so a chatty child cannot exhaust memory. */
export const MAX_CAPTURED_BYTES = 1_000_000;

// ─────────────────────────────────────────────────────────────────────────────
// Public shapes
// ─────────────────────────────────────────────────────────────────────────────

/** A submitted exec request. Secrets are referenced BY NAME / BY REF — never a value in the request. */
export interface SecretExecRequest {
	/** The command to spawn (an executable, NOT a shell line — spawned with `shell: false`). */
	readonly command: string;
	/** The command arguments (each is passed verbatim — never re-parsed by a shell). */
	readonly args?: readonly string[];
	/** The secret NAMES to resolve from `.secrets/` into the subprocess env (by name only). */
	readonly secretNames?: readonly string[];
	/**
	 * Vault REFERENCES to resolve via the {@link VaultProvider} seam into the env (b-AC-4).
	 * Each entry maps an ENV VAR NAME → a vault ref (e.g. `op://vault/item/field`). The
	 * resolved value is NOT duplicated into `.secrets/`.
	 */
	readonly vaultRefs?: Readonly<Record<string, string>>;
	/** The scope the secrets resolve under + the job is partitioned to (FR-8). */
	readonly scope: SecretScope;
	/** Optional timeout override (ms). Clamped to [MIN, MAX]; defaults to 5 min (b-AC-1). */
	readonly timeoutMs?: number;
}

/** The lifecycle status of an exec job. `queued`/`running` are non-terminal; the rest are terminal. */
export const EXEC_STATUSES = ["queued", "running", "succeeded", "failed", "timed_out", "rejected"] as const;
/** A single exec status. */
export type ExecStatus = (typeof EXEC_STATUSES)[number];

/**
 * A redacted, caller-safe view of an exec job (b-AC-3). EVERYTHING here has already had the
 * secret values stripped: `stdout`/`stderr` are post-redaction, and there is NO field that
 * could carry a raw credential by construction (no env, no resolved-value field).
 */
export interface ExecJobView {
	/** The job id. */
	readonly jobId: string;
	/** The current lifecycle status. */
	readonly status: ExecStatus;
	/** REDACTED stdout (every secret value → `[REDACTED]`). Empty until the child writes. */
	readonly stdout: string;
	/** REDACTED stderr (every secret value → `[REDACTED]`). */
	readonly stderr: string;
	/** The process exit code, or `null` if it did not exit normally (killed / still running). */
	readonly exitCode: number | null;
	/** The signal the process was killed with, or `null`. */
	readonly signal: string | null;
	/** Whether the job was killed for exceeding its timeout (b-AC-5). */
	readonly timedOut: boolean;
}

/** The outcome of a submit (b-AC-1 / b-AC-6). A queued/running job → `accepted`; a full queue → `rejected`. */
export type SubmitResult =
	| { readonly ok: true; readonly jobId: string }
	| { readonly ok: false; readonly reason: "queue_full" | "invalid_request" };

// ─────────────────────────────────────────────────────────────────────────────
// Seams — spawn / clock / audit (all injectable for deterministic, fast tests)
// ─────────────────────────────────────────────────────────────────────────────

/** The spawn seam (D-6). Defaults to `node:child_process.spawn` with `shell: false`. */
export interface Spawner {
	/**
	 * Spawn a subprocess WITHOUT a shell. The `env` carries the resolved secret values
	 * (the ONLY place a value lives, transiently). `shell` is hard-wired `false` by the
	 * default impl — there is no shell-injection surface.
	 */
	spawn(command: string, args: readonly string[], env: Record<string, string>): ChildProcessWithoutNullStreams;
}

/** The default spawner: `child_process.spawn` with `shell: false` (the no-shell rule). */
export const systemSpawner: Spawner = {
	spawn(command, args, env): ChildProcessWithoutNullStreams {
		// CRITICAL (no-shell): a command + args ARRAY with `shell: false`. The command is the
		// executable; each arg is passed verbatim and is NEVER re-parsed by `/bin/sh`, so a
		// hostile arg (`; rm -rf /`) is an inert argument string, not a new command.
		return spawn(command, [...args], { shell: false, env, windowsHide: true }) as ChildProcessWithoutNullStreams;
	},
};

/** A monotonic-ish clock seam so tests drive deadlines deterministically. */
export interface ExecClock {
	/** Current time in ms. */
	now(): number;
	/** ISO timestamp for audit events. */
	iso(): string;
}

/** The default wall clock. */
export const systemExecClock: ExecClock = {
	now(): number {
		return Date.now();
	},
	iso(): string {
		return new Date().toISOString();
	},
};

/** An exec audit op (FR-7). Distinct from the store ops so the audit reads cleanly. */
export const EXEC_AUDIT_OPS = ["resolved_for_exec", "exec_started", "exec_finished", "exec_rejected"] as const;
/** A single exec audit op. */
export type ExecAuditOp = (typeof EXEC_AUDIT_OPS)[number];

/**
 * A REDACTED exec audit event (FR-7). By construction it carries op + jobId + scope +
 * outcome (+ optional status) and CANNOT hold a value — there is no value/env field. The
 * audit SINK is injected so a test asserts the events without touching the real `.daemon/`
 * log, and so this module never hand-writes a file path of its own.
 */
export interface ExecAuditEvent {
	/** The op performed. */
	readonly op: ExecAuditOp;
	/** The job the op concerns. */
	readonly jobId: string;
	/** The scope the job runs under. */
	readonly scope: SecretScope;
	/** The ISO instant. */
	readonly ts: string;
	/** A short outcome classifier (never a value). */
	readonly outcome: string;
	/** The job's status at the time of the event (optional). */
	readonly status?: ExecStatus;
}

/** The audit sink seam (FR-7). The assembly injects one that appends NDJSON under `.daemon/`. */
export interface ExecAuditSink {
	/** Append a redacted exec audit event. Best-effort — a sink failure must not break a job. */
	record(event: ExecAuditEvent): void;
}

/** A no-op audit sink (the default when none is injected). */
export const noopExecAuditSink: ExecAuditSink = {
	record(): void {
		/* no-op */
	},
};

/** Construction deps for the {@link SecretExecRunner}. Everything IO-touching is injected. */
export interface SecretExecRunnerDeps {
	/** The Wave-1 store — its INTERNAL `getSecretValue` is the single decrypt path (consumed, not edited). */
	readonly store: Pick<SecretsStore, "getSecretValue">;
	/** The vault provider seam (b-AC-4). Defaults to one that rejects every ref (no vault wired). */
	readonly vault?: VaultProvider;
	/** The spawn seam (defaults to the no-shell {@link systemSpawner}). */
	readonly spawner?: Spawner;
	/** The clock (defaults to the wall clock). */
	readonly clock?: ExecClock;
	/** The audit sink (defaults to a no-op). */
	readonly audit?: ExecAuditSink;
	/** The bounded worker-pool size (default {@link DEFAULT_POOL_SIZE}). */
	readonly poolSize?: number;
	/** The bounded queue depth beyond the pool (default {@link DEFAULT_MAX_QUEUE}). */
	readonly maxQueue?: number;
	/** The SIGTERM→SIGKILL grace (default {@link KILL_GRACE_MS}). */
	readonly killGraceMs?: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// RollingRedactor — chunk-boundary-safe redaction (FR-4 / b-AC-2)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A streaming redactor that replaces every occurrence of every secret value with
 * `[REDACTED]`, ROBUST to a value split across read-chunk boundaries.
 *
 * The chunk-boundary problem: the OS hands stdout/stderr to us in arbitrary chunks, so a
 * single secret like `sk-ABCDEF` can arrive as `…sk-AB` then `CDEF…`. A naive per-chunk
 * replace would miss it.
 *
 * The robust fix used here: ACCUMULATE the raw decoded bytes into a single capped buffer and
 * REDACT on read (`current()` / `flush()`), never per-chunk. Because redaction always runs
 * over the FULL contiguous buffer, a value can never straddle an internal "chunk boundary" —
 * there are no internal boundaries by the time we match. This is correct by construction and
 * needs no carry/emit boundary arithmetic; the only bound is the {@link MAX_CAPTURED_BYTES}
 * cap on the raw buffer (a chatty child cannot exhaust memory), and the cap is applied to the
 * RAW buffer BEFORE redaction so we never drop the middle of a straddling value at the cap
 * edge in a way that would un-redact it (a value cut by the cap simply isn't fully present, so
 * it cannot be reconstructed from the output either).
 *
 * Why string-based: the values are UTF-8 text from the secret store; we decode each chunk to
 * a string and match literal substrings. (A literal-substring redactor is the b-AC-2 scope;
 * transformed/base64 forms are an explicit PRD open question, out of scope here.)
 */
export class RollingRedactor {
	private readonly values: readonly string[];
	/** The RAW accumulated decoded output (capped). Redaction runs over this on every read. */
	private raw = "";
	private truncated = false;

	constructor(values: readonly string[]) {
		// Sort longest-first so an overlapping longer value is redacted before a shorter
		// substring of it; drop empties (a replace of "" would loop / mask nothing real).
		this.values = [...values.filter((v) => v.length > 0)].sort((a, b) => b.length - a.length);
	}

	/** Feed a decoded chunk; append to the raw buffer (redaction is deferred to read time). */
	push(chunk: string): void {
		if (this.truncated) return;
		const room = MAX_CAPTURED_BYTES - this.raw.length;
		if (chunk.length <= room) {
			this.raw += chunk;
			return;
		}
		// Cap the RAW buffer so a chatty child can't exhaust memory; mark truncation honestly.
		this.raw += chunk.slice(0, Math.max(0, room));
		this.truncated = true;
	}

	/** Finalize and return the fully-redacted output. Idempotent (redaction is pure). */
	flush(): string {
		return this.current();
	}

	/** The redacted output captured so far (a safe partial view for a running / killed job). */
	current(): string {
		const redacted = redactAll(this.raw, this.values);
		return this.truncated ? `${redacted}\n[TRUNCATED]` : redacted;
	}
}

/** Replace every occurrence of every value with `[REDACTED]` (literal substring, FR-4). */
export function redactAll(text: string, values: readonly string[]): string {
	let out = text;
	for (const v of values) {
		if (v.length === 0) continue;
		out = out.split(v).join(REDACTED);
	}
	return out;
}

/** Clamp a requested timeout to [MIN, MAX], defaulting to 5 min when absent (b-AC-1). */
export function clampTimeout(requestedMs: number | undefined): number {
	const v = requestedMs ?? DEFAULT_EXEC_TIMEOUT_MS;
	if (!Number.isFinite(v)) return DEFAULT_EXEC_TIMEOUT_MS;
	return Math.min(MAX_EXEC_TIMEOUT_MS, Math.max(MIN_EXEC_TIMEOUT_MS, Math.floor(v)));
}

// ─────────────────────────────────────────────────────────────────────────────
// The job record (internal — never returned raw)
// ─────────────────────────────────────────────────────────────────────────────

/** The internal job record. The `view` it exposes is redacted; the raw values never leave. */
interface ExecJob {
	readonly jobId: string;
	readonly scope: SecretScope;
	status: ExecStatus;
	exitCode: number | null;
	signal: string | null;
	timedOut: boolean;
	/** The redactors own the captured output; their `current()` is the only output read path. */
	stdout: RollingRedactor;
	stderr: RollingRedactor;
	/** Resolves when the job reaches a terminal status (used by tests / callers to await). */
	done: Promise<void>;
}

/** Map a scope to a stable comparison key so status reads are scope-checked (FR-8 / b-AC-3). */
function scopeKey(scope: SecretScope): string {
	return `${scope.org} ${scope.workspace} ${scope.agentId ?? ""}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// The runner — bounded pool + queue + spawn + redaction + timeout (b-AC-1..6)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The `secret_exec` runner. Submit returns immediately with a jobId (the API maps it to a
 * 202); a bounded pool spawns subprocesses with resolved secrets in env; excess submits
 * queue (bounded — the DoS guard); a timeout kills a runaway; output is redacted before any
 * caller sees it. Construct once per daemon; inject the store + (optionally) a vault + spawn
 * seam + clock + audit sink.
 */
export class SecretExecRunner {
	private readonly store: Pick<SecretsStore, "getSecretValue">;
	private readonly vault: VaultProvider;
	private readonly spawner: Spawner;
	private readonly clock: ExecClock;
	private readonly audit: ExecAuditSink;
	private readonly poolSize: number;
	private readonly maxQueue: number;
	private readonly killGraceMs: number;

	private readonly jobs = new Map<string, ExecJob>();
	private readonly queue: Array<() => void> = [];
	private active = 0;
	private seq = 0;

	constructor(deps: SecretExecRunnerDeps) {
		this.store = deps.store;
		// Default vault rejects every ref — no vault wired means a vault ref fails closed.
		this.vault = deps.vault ?? { resolve: (ref) => Promise.reject(new Error(`no vault provider for ${ref}`)) };
		this.spawner = deps.spawner ?? systemSpawner;
		this.clock = deps.clock ?? systemExecClock;
		this.audit = deps.audit ?? noopExecAuditSink;
		this.poolSize = Math.max(1, deps.poolSize ?? DEFAULT_POOL_SIZE);
		this.maxQueue = Math.max(0, deps.maxQueue ?? DEFAULT_MAX_QUEUE);
		this.killGraceMs = Math.max(0, deps.killGraceMs ?? KILL_GRACE_MS);
	}

	/** How many jobs are currently spawned (running). For the pool-bound assertion (b-AC-6). */
	activeCount(): number {
		return this.active;
	}

	/** How many jobs are waiting behind a full pool. For the queue-bound assertion (b-AC-6). */
	queuedCount(): number {
		return this.queue.length;
	}

	/**
	 * Submit an exec job (b-AC-1 / b-AC-6). Validates the request, registers a `queued` job,
	 * and either runs it now (pool has room) or enqueues it (bounded). Returns the jobId
	 * SYNCHRONOUSLY for the 202 — the spawn happens asynchronously. A full queue is REJECTED
	 * (the DoS guard) rather than accepted-and-dropped.
	 */
	submit(request: SecretExecRequest): SubmitResult {
		if (typeof request.command !== "string" || request.command.length === 0) {
			return { ok: false, reason: "invalid_request" };
		}
		// The DoS bound: refuse when the pool is full AND the queue is at capacity (b-AC-6).
		if (this.active >= this.poolSize && this.queue.length >= this.maxQueue) {
			const jobId = this.nextId();
			this.audit.record({
				op: "exec_rejected",
				jobId,
				scope: request.scope,
				ts: this.clock.iso(),
				outcome: "queue_full",
				status: "rejected",
			});
			return { ok: false, reason: "queue_full" };
		}

		const jobId = this.nextId();
		let resolveDone: () => void = () => undefined;
		const done = new Promise<void>((res) => {
			resolveDone = res;
		});
		const job: ExecJob = {
			jobId,
			scope: request.scope,
			status: "queued",
			exitCode: null,
			signal: null,
			timedOut: false,
			stdout: new RollingRedactor([]),
			stderr: new RollingRedactor([]),
			done,
		};
		this.jobs.set(jobId, job);

		const run = (): void => {
			this.active += 1;
			void this.runJob(job, request)
				.catch(() => {
					// A resolve/spawn error already set a terminal status inside runJob; this catch
					// only guards the bookkeeping below from an unexpected throw (never a value leak).
					if (!isTerminal(job.status)) job.status = "failed";
				})
				.finally(() => {
					this.active -= 1;
					resolveDone();
					this.pump();
				});
		};

		if (this.active < this.poolSize) {
			run();
		} else {
			this.queue.push(run);
		}
		return { ok: true, jobId };
	}

	/**
	 * Read a job's REDACTED status (b-AC-3 / FR-8). Scope-checked: a caller only sees a job
	 * its OWN scope submitted — a different scope gets `null` (treated as not-found by the
	 * API, so a job id is not even an oracle across scopes). The returned view is redacted by
	 * construction; it can never carry a raw secret.
	 */
	getStatus(jobId: string, scope: SecretScope): ExecJobView | null {
		const job = this.jobs.get(jobId);
		if (job === undefined) return null;
		if (scopeKey(job.scope) !== scopeKey(scope)) return null; // cross-scope → not found.
		return this.viewOf(job);
	}

	/** Await a job's terminal state (test/caller helper). Resolves even if the id is unknown. */
	async waitFor(jobId: string): Promise<void> {
		const job = this.jobs.get(jobId);
		if (job === undefined) return;
		await job.done;
	}

	// ── internals ──────────────────────────────────────────────────────────────

	private nextId(): string {
		this.seq += 1;
		return `exec-${this.clock.now()}-${this.seq}-${Math.floor(Math.random() * 1_000_000)}`;
	}

	/** A redacted, caller-safe snapshot of a job (b-AC-3). */
	private viewOf(job: ExecJob): ExecJobView {
		return {
			jobId: job.jobId,
			status: job.status,
			stdout: job.stdout.current(),
			stderr: job.stderr.current(),
			exitCode: job.exitCode,
			signal: job.signal,
			timedOut: job.timedOut,
		};
	}

	/** Drain the queue when a pool slot frees. */
	private pump(): void {
		while (this.active < this.poolSize && this.queue.length > 0) {
			const next = this.queue.shift();
			if (next !== undefined) next();
		}
	}

	/**
	 * Resolve secrets + vault refs, spawn, capture+redact, enforce the timeout. Sets a terminal
	 * status on the job. The resolved values live ONLY in the local `values` set + the child
	 * env + the redactors' value list — never in the job view, the audit, or a log.
	 */
	private async runJob(job: ExecJob, request: SecretExecRequest): Promise<void> {
		// 1) Resolve every requested value (store secrets by name + vault refs by reference).
		const env: Record<string, string> = inheritableEnv();
		const values: string[] = [];

		for (const name of request.secretNames ?? []) {
			const res: ValueResult = await this.store.getSecretValue(name, request.scope);
			if (!res.ok) {
				// A missing/undecryptable secret fails the job CLOSED — never run with a gap.
				job.status = "failed";
				this.audit.record(this.ev("resolved_for_exec", job, res.reason));
				this.audit.record(this.ev("exec_finished", job, "resolve_failed"));
				return;
			}
			env[name] = res.value;
			values.push(res.value);
		}

		for (const [envVar, ref] of Object.entries(request.vaultRefs ?? {})) {
			let value: string;
			try {
				// b-AC-4: pulled BY REFERENCE at use-time via the seam — NOT written to `.secrets/`.
				value = await this.vault.resolve(ref);
			} catch {
				job.status = "failed";
				this.audit.record(this.ev("resolved_for_exec", job, "vault_unresolved"));
				this.audit.record(this.ev("exec_finished", job, "resolve_failed"));
				return;
			}
			env[envVar] = value;
			values.push(value);
		}
		this.audit.record(this.ev("resolved_for_exec", job, "ok"));

		// Re-key the redactors now that we know the values (so a partial view is redacted too).
		job.stdout = new RollingRedactor(values);
		job.stderr = new RollingRedactor(values);

		// 2) Spawn WITHOUT a shell (command + args array, shell:false).
		job.status = "running";
		this.audit.record(this.ev("exec_started", job, "ok"));
		const child = this.spawner.spawn(request.command, request.args ?? [], env);

		// 3) Capture + redact streamingly (chunk-boundary safe). The `end` events on these
		//    streams are the SYNCHRONIZATION POINT for "all output collected" — see
		//    awaitChildWithTimeout, which waits for them so a killed child's buffered PARTIAL
		//    output is fully drained into the redactor BEFORE the job settles (b-AC-5).
		child.stdout.on("data", (d: Buffer) => job.stdout.push(d.toString("utf8")));
		child.stderr.on("data", (d: Buffer) => job.stderr.push(d.toString("utf8")));

		// 4) Enforce the timeout: SIGTERM then SIGKILL after the grace (b-AC-5).
		const timeoutMs = clampTimeout(request.timeoutMs);
		await this.awaitChildWithTimeout(child, job, timeoutMs);

		// 5) Finalize: flush the redactors so the carry tail is emitted+redacted.
		job.stdout.flush();
		job.stderr.flush();
		this.audit.record(this.ev("exec_finished", job, job.status));
	}

	/**
	 * Await the child's exit, enforcing the timeout. On exit before the deadline: terminal
	 * `succeeded`/`failed` by exit code. On the deadline: mark `timed_out`, SIGTERM, then
	 * SIGKILL after the grace, and resolve with redacted PARTIAL output (b-AC-5 / FR-9).
	 *
	 * ── Why we wait for the STREAMS, not just the process `close` ────────────────
	 * The process-level `close` event and the stdout/stderr `data` events are delivered on
	 * SEPARATE emitters. When a child is KILLED with output still buffered (the b-AC-5
	 * timeout path: it wrote `partial:…` then was SIGKILLed), the process `close` can win
	 * the event-loop race against the final pending `data` callback — so `flush()`/the
	 * status read would see an EMPTY buffer. Under parallel CPU contention (Windows CI) that
	 * window widens into an intermittent failure. The robust fix: settle only once the
	 * process has closed AND both stdio streams have emitted `end` (fully drained). The
	 * stream `end` is the true "all output collected" barrier; resolving on it makes the
	 * captured partial output deterministic regardless of scheduling jitter.
	 */
	private awaitChildWithTimeout(
		child: ChildProcessWithoutNullStreams,
		job: ExecJob,
		timeoutMs: number,
	): Promise<void> {
		return new Promise<void>((resolve) => {
			let settled = false;
			// The settle barrier: the process must have closed AND both stdio streams must have
			// fully drained (`end`). Only when all three are true is the captured output final.
			let processClosed = false;
			let stdoutEnded = false;
			let stderrEnded = false;

			const settle = (): void => {
				if (settled) return;
				if (!(processClosed && stdoutEnded && stderrEnded)) return;
				settled = true;
				clearTimeout(timer);
				clearTimeout(killTimer);
				resolve();
			};

			// The spawn/exec error path (e.g. ENOENT) has NO streams to drain — resolve at once.
			const settleNow = (): void => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				clearTimeout(killTimer);
				resolve();
			};

			let killTimer: ReturnType<typeof setTimeout> = setTimeout(() => undefined, 0);
			clearTimeout(killTimer);

			const timer = setTimeout(() => {
				// Deadline hit (b-AC-5): mark terminal-timed-out, ask nicely (SIGTERM), then force.
				job.timedOut = true;
				job.status = "timed_out";
				try {
					child.kill("SIGTERM");
				} catch {
					// already dead — the `close`/stream-`end` handlers will resolve.
				}
				killTimer = setTimeout(() => {
					try {
						child.kill("SIGKILL");
					} catch {
						// already dead.
					}
				}, this.killGraceMs);
			}, timeoutMs);

			// Drain barriers: once a stream emits `end`, every `data` it will ever emit has been
			// delivered to the redactor. `error` on a stream also ends our wait for it (a torn
			// pipe on kill must not hang the settle).
			child.stdout.on("end", () => {
				stdoutEnded = true;
				settle();
			});
			child.stdout.on("error", () => {
				stdoutEnded = true;
				settle();
			});
			child.stderr.on("end", () => {
				stderrEnded = true;
				settle();
			});
			child.stderr.on("error", () => {
				stderrEnded = true;
				settle();
			});

			child.on("error", () => {
				// Spawn/exec error (e.g. ENOENT). Terminal failure; no value at risk. No streams
				// will ever flow, so do NOT wait on their `end` — resolve immediately.
				if (!isTerminal(job.status)) job.status = "failed";
				settleNow();
			});

			child.on("close", (code: number | null, signal: NodeJS.Signals | null) => {
				job.exitCode = code;
				job.signal = signal;
				if (!job.timedOut) {
					job.status = code === 0 ? "succeeded" : "failed";
				}
				// Stays `timed_out` (terminal) with whatever partial output was captured when the
				// deadline fired. Either way, settle ONLY once the streams have also drained.
				processClosed = true;
				settle();
			});
		});
	}

	/** Build a redacted audit event for a job op (FR-7 — never a value). */
	private ev(op: ExecAuditOp, job: ExecJob, outcome: string): ExecAuditEvent {
		return { op, jobId: job.jobId, scope: job.scope, ts: this.clock.iso(), outcome, status: job.status };
	}
}

/** Whether a status is terminal (no further transitions). */
function isTerminal(status: ExecStatus): boolean {
	return status === "succeeded" || status === "failed" || status === "timed_out" || status === "rejected";
}

/**
 * Env var names whose VALUES are the daemon's OWN credentials and must NEVER be
 * inherited into a `secret_exec` child. The thesis ("an agent can cause a secret to be
 * used but never receives a value") applies to the daemon's ambient credentials too: a
 * child that inherited `HONEYCOMB_DEEPLAKE_TOKEN` (the Activeloop credential, read by
 * `storage/config.ts`) or a provider API key from the parent env could simply echo it to
 * stdout — and because it was never a JOB-resolved value, it would NOT be in the
 * redaction set, so the status endpoint would return it verbatim. That is the exact
 * prompt-injection exfiltration this module exists to prevent. We therefore STRIP these
 * before the child sees them; the job's explicitly-requested secrets are still injected
 * (and redacted) on top. The match is by exact name OR a suffix/substring of the standard
 * secret-bearing tokens, so a future `…_TOKEN`/`…_KEY`/`…_SECRET`/`…_PASSWORD` var is
 * caught without re-editing this list.
 */
const SENSITIVE_ENV_EXACT = new Set(["HONEYCOMB_DEEPLAKE_TOKEN"]);
/** Substrings that mark an env var name as credential-bearing (case-insensitive). */
const SENSITIVE_ENV_MARKERS = ["TOKEN", "SECRET", "API_KEY", "APIKEY", "PASSWORD", "PASSWD", "CREDENTIAL", "PRIVATE_KEY"];

/** Whether an inherited env var name carries a credential the child must not see. */
function isSensitiveEnvName(name: string): boolean {
	if (SENSITIVE_ENV_EXACT.has(name)) return true;
	const upper = name.toUpperCase();
	return SENSITIVE_ENV_MARKERS.some((m) => upper.includes(m));
}

/**
 * Build the base env the child inherits. We start from the daemon's own `process.env`
 * (so PATH etc. resolve the executable) but STRIP the daemon's own credential-bearing
 * vars ({@link isSensitiveEnvName}) so a child can never echo the daemon's ambient
 * secrets back through the (un-redacted, because never job-resolved) status surface. The
 * job's explicitly-requested secret values are layered ON TOP by the caller (and ARE in
 * the redaction set); they are never logged here.
 */
function inheritableEnv(): Record<string, string> {
	const out: Record<string, string> = {};
	for (const [k, v] of Object.entries(process.env)) {
		if (typeof v === "string" && !isSensitiveEnvName(k)) out[k] = v;
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Thin functional facade — kept so the index barrel + assembly have a stable surface
// ─────────────────────────────────────────────────────────────────────────────

/** Build a {@link SecretExecRunner}. The assembly constructs one and shares it with the API. */
export function createSecretExecRunner(deps: SecretExecRunnerDeps): SecretExecRunner {
	return new SecretExecRunner(deps);
}
