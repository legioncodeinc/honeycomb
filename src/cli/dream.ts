/**
 * `honeycomb dream` CLI surface — PRD-009c FR-2 / c-AC-2.
 *
 * Two sub-commands:
 *   - `dream trigger --compact [--org O --workspace W --agent A]`
 *       Enqueue a full-graph compaction pass for the target scope regardless of the
 *       token counter (c-AC-2 / FR-2). Bypasses the threshold check.
 *   - `dream status [--org O --workspace W --agent A]`
 *       Report the scope's last dreaming pass and pending-job state.
 *
 * ── Boundary: the CLI imports NO DeepLake path ───────────────────────────────
 * This module is a thin client: it imports neither `src/daemon/storage` nor the
 * daemon core (the storage-import invariant test enforces it). Enqueuing is
 * performed through the injected {@link DreamJobEnqueuer} seam — the daemon
 * assembly wires the real job-queue service; the AC-named test injects a fake.
 * State is read through the injected {@link DreamStateReader} seam.
 *
 * So this module has NO storage handle. It cannot mutate the graph, cannot read
 * the graph, and cannot open DeepLake. The only side-effect it has is calling the
 * injected enqueuer — and that's the point.
 *
 * ── Why `--compact` bypasses the counter (c-AC-2 / FR-2) ────────────────────
 * An operator triggering `--compact` explicitly wants a full-graph pass NOW — they
 * may have just imported a large batch, or want to clean up before a release, or
 * want to force a first-run compaction manually. The token-counter threshold (009a)
 * is the autonomous trigger; the CLI is the manual override. The enqueuer STILL
 * sets `pending_job_id` on the dreaming_state row, so the single-pending guard
 * (FR-6 / a-AC-3) prevents a double-enqueue even from the CLI.
 */

// ── Structural shapes (defined locally so the CLI imports no daemon path) ─────

/** The org/workspace partition + agent the command is scoped to. */
export interface DreamScope {
	readonly org: string;
	readonly workspace: string;
	readonly agentId: string;
}

/**
 * The job-enqueue seam (c-AC-2). The daemon assembly wires the real
 * `DreamingJobEnqueuer` (the PRD-004b queue). The test injects a fake that records
 * calls. Kept narrow (just `enqueue`) so the CLI holds no queue lifecycle knowledge.
 */
export interface DreamJobEnqueuer {
	/** Enqueue a compaction dreaming job for the target scope; returns the job id. */
	enqueueCompaction(scope: DreamScope): Promise<string>;
}

/** A snapshot of a scope's current dreaming state (for `dream status`). */
export interface DreamStateSnapshot {
	/** ISO-8601 timestamp of the last completed pass, empty if none. */
	readonly lastPassAt: string;
	/** Running token count since the last pass. */
	readonly tokensSinceLastPass: number;
	/** The in-flight job id, empty when none is pending. */
	readonly pendingJobId: string;
}

/**
 * The state-reader seam (for `dream status`). Returns `null` when no
 * dreaming_state row exists yet for the scope.
 */
export interface DreamStateReader {
	readState(scope: DreamScope): Promise<DreamStateSnapshot | null>;
}

/** A line-sink so the command's output is capturable in tests (no direct stdout). */
export interface DreamOutputSink {
	(line: string): void;
}

/** The parsed `dream` invocation: the sub-command + flags + the scope. */
export interface DreamInvocation {
	/** The sub-command word ("trigger" | "status" | unknown). */
	readonly subCommand: string;
	/** `--compact` present (trigger only). */
	readonly compact: boolean;
	/** The resolved scope (org / workspace / agentId). */
	readonly scope: DreamScope;
}

/** Outcome of running a `dream` command. */
export interface DreamResult {
	readonly exitCode: number;
	/** The enqueued job id when a job was queued; empty otherwise. */
	readonly jobId: string;
}

/**
 * Parse a raw `dream` argv tail (everything AFTER the `dream` word) into a typed
 * {@link DreamInvocation}. Scope flags default to empty org / default workspace /
 * `default` agent so a missing scope is explicit.
 *
 * Recognized flags: `--compact`, `--org <v>`, `--workspace <v>`, `--agent <v>`.
 * The first non-flag word is the sub-command.
 */
export function parseDreamArgs(argv: readonly string[]): DreamInvocation {
	let subCommand = "";
	let compact = false;
	let org = "";
	let workspace = "";
	let agentId = "default";

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		switch (a) {
			case "--compact":
				compact = true;
				break;
			case "--org":
				org = argv[++i] ?? "";
				break;
			case "--workspace":
				workspace = argv[++i] ?? "";
				break;
			case "--agent":
				agentId = argv[++i] ?? "default";
				break;
			default:
				if (!a.startsWith("--") && subCommand === "") subCommand = a;
				break;
		}
	}

	return { subCommand, compact, scope: { org, workspace, agentId } };
}

/**
 * Run a parsed `dream` command (c-AC-2 / FR-2). Two sub-commands:
 *
 *   - `trigger --compact` — enqueue a full-graph compaction pass via the injected
 *     enqueuer, regardless of the token counter. Returns the job id.
 *   - `trigger` (no `--compact`) — refuse with a helpful error (the automatic
 *     trigger lives in the daemon maintenance loop; the CLI only exposes `--compact`
 *     until daemon-assembly wires a force-trigger).
 *   - `status` — print the scope's last pass and pending state via the injected reader.
 *
 * `enqueuer` and `reader` are injected seams; the CLI never touches storage directly.
 */
export async function runDreamCommand(
	inv: DreamInvocation,
	enqueuer: DreamJobEnqueuer,
	reader: DreamStateReader,
	out: DreamOutputSink,
): Promise<DreamResult> {
	const { subCommand, compact, scope } = inv;

	if (subCommand === "trigger") {
		if (!compact) {
			out("error: `dream trigger` requires --compact.");
			out("       The automatic threshold trigger runs inside the daemon maintenance loop.");
			out("       To force a full-graph compaction pass: honeycomb dream trigger --compact");
			return { exitCode: 2, jobId: "" };
		}
		// c-AC-2: enqueue regardless of the counter state.
		const jobId = await enqueuer.enqueueCompaction(scope);
		out(`compaction job enqueued: ${jobId}`);
		out(`scope: org=${scope.org} workspace=${scope.workspace} agent=${scope.agentId}`);
		return { exitCode: 0, jobId };
	}

	if (subCommand === "status") {
		const state = await reader.readState(scope);
		out(`scope: org=${scope.org} workspace=${scope.workspace} agent=${scope.agentId}`);
		if (state === null) {
			out("status: no dreaming pass on record for this scope.");
			return { exitCode: 0, jobId: "" };
		}
		out(`last_pass_at: ${state.lastPassAt === "" ? "(never)" : state.lastPassAt}`);
		out(`tokens_since_last_pass: ${state.tokensSinceLastPass}`);
		out(`pending_job_id: ${state.pendingJobId === "" ? "(none)" : state.pendingJobId}`);
		return { exitCode: 0, jobId: "" };
	}

	out("usage: honeycomb dream trigger --compact [--org O --workspace W --agent A]");
	out("       honeycomb dream status [--org O --workspace W --agent A]");
	return { exitCode: subCommand === "" ? 0 : 1, jobId: "" };
}

/**
 * Convenience entry: parse + run a `dream` argv tail in one call (FR-2 / c-AC-2).
 * The daemon assembly step (deferred) injects the real enqueuer + reader; the
 * AC-named test injects fakes directly.
 */
export async function dreamMain(
	argv: readonly string[],
	enqueuer: DreamJobEnqueuer,
	reader: DreamStateReader,
	out: DreamOutputSink,
): Promise<DreamResult> {
	return runDreamCommand(parseDreamArgs(argv), enqueuer, reader, out);
}
