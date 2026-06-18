/**
 * `honeycomb route` CLI surface — PRD-010d FR-1..9 / d-AC-1..5.
 *
 * Sub-commands:
 *   - `route explain <workload> [--org O --workspace W --agent A]`
 *       Print the routing decision for a workload WITHOUT executing inference
 *       (d-AC-1 / FR-2). Calls the injected {@link RouteExplainer}.
 *   - `route status [--org O --workspace W --agent A]`
 *       Show recent route + fallback sequences, secrets and request bodies
 *       already redacted at the source (d-AC-2 / FR-3). Calls the injected
 *       {@link RouteHistoryClient}.
 *   - `route pin <workload> <target> [--org O --workspace W --agent A]`
 *       Pin a workload to a specific target until unpinned (d-AC-3 / FR-6).
 *       Calls the injected {@link RoutePinStore}.
 *   - `route unpin <workload> [--org O --workspace W --agent A]`
 *       Remove a pin, returning the workload to policy resolution (FR-6).
 *   - `route test <workload> [--org O --workspace W --agent A]`
 *       Report the serving target and the full attempt sequence (d-AC-4 / FR-5).
 *       Uses the explain path (no inference executed).
 *   - `route list [--org O --workspace W --agent A]`
 *       List configured targets and their bound workloads (FR-4).
 *   - `route doctor [--org O --workspace W --agent A]`
 *       Surface config and account health (FR-1).
 *
 * ── Boundary: the CLI imports NO DeepLake path (a-AC-5 / CONVENTIONS) ───────
 * This module is a thin client: it imports neither `src/daemon/storage` nor the
 * daemon core. The storage-import invariant test (`tests/daemon/storage/
 * invariant.test.ts`) enforces this for every file under `src/cli`.
 *
 * Every operation reaches routing state through INJECTED SEAMS:
 *   - {@link RouteExplainer} — calls the daemon's `POST /api/inference/explain`
 *     (or its in-process equivalent). Returns a {@link RoutingDecision}.
 *   - {@link RouteHistoryClient} — calls `GET /api/inference/history` (or its
 *     in-process equivalent). Returns {@link RedactedRoutingEvent}[].
 *   - {@link RoutePinStore} — calls `POST/DELETE /api/inference/pins` (the
 *     daemon owns pin state). Pins live in the daemon process (runtime-only,
 *     not persisted across restarts per the PRD open question). The router
 *     reads the pin map before mode selection: a pinned workload short-circuits
 *     gate + mode machinery and resolves directly to the pinned target. Pins are
 *     communicated via the HTTP API so the CLI never touches routing internals.
 *
 * The redaction guarantee for d-AC-5 originates at the WRITE boundary inside
 * `RoutingHistoryStore.record` (which accepts only a `RedactedRoutingEvent` —
 * a shape that cannot hold a secret/key/body). The stored telemetry row is
 * already redacted when the CLI reads it; the CLI does not scrub further.
 * See CONVENTIONS.md §"The central thesis" and `history-store.ts`.
 */

// ── Types shared with the daemon contracts (re-declared locally so the CLI ────
// ── imports NO daemon path — same approach as ontology.ts / dream.ts) ─────────

/** The org/workspace partition + agent the command is scoped to (FR-9). */
export interface RouteScope {
	readonly org: string;
	readonly workspace: string;
	readonly agentId: string;
}

/**
 * A single attempt record in a routing decision.
 * Mirrors `AttemptRecord` from inference contracts without importing it.
 */
export interface RouteAttempt {
	readonly targetId: string;
	readonly outcome: "selected" | "blocked" | "failed";
	readonly statusCode?: number;
	readonly reason?: string;
}

/**
 * A routing decision (the result of explain/test). Mirrors `RoutingDecision`
 * without importing the daemon contracts.
 */
export interface RouteDecision {
	/** The target id that served, or null when every candidate was blocked/failed. */
	readonly servingTarget: string | null;
	/** The full ordered attempt sequence (gate blocks + fallbacks + selection). */
	readonly attempts: readonly RouteAttempt[];
	/** The policy mode the decision ran under. */
	readonly mode: string;
	/** The workload this decision routed under. */
	readonly workload: string;
	/** Targets a gate blocked, each with a redacted gate reason. */
	readonly blockedCandidates: readonly { readonly targetId: string; readonly reason: string }[];
}

/**
 * A redacted telemetry event as returned by the history API. Mirrors
 * `RedactedRoutingEvent` without importing daemon contracts. Cannot carry a
 * secret/key/body — that is enforced at the write boundary (d-AC-5).
 */
export interface RouteHistoryEvent {
	readonly requestId: string;
	readonly workload: string;
	readonly servingTarget: string | null;
	readonly mode: string;
	readonly attempts: readonly RouteAttempt[];
	readonly blockedCandidates: readonly { readonly targetId: string; readonly reason: string }[];
}

/** A pin record: a workload pinned to a specific target. */
export interface RoutePin {
	readonly workload: string;
	readonly target: string;
}

/** A configured target as returned by the list surface. */
export interface RouteTarget {
	readonly id: string;
	readonly model: string;
	readonly privacyTier: string;
	readonly capabilities: readonly string[];
	readonly boundWorkloads: readonly string[];
}

/** Health summary from the doctor surface. */
export interface RouteDoctorReport {
	readonly accountsTotal: number;
	readonly accountsExpired: number;
	readonly targetsTotal: number;
	readonly targetsAvailable: number;
	readonly pinsActive: number;
}

// ── Seams (injected; the daemon-assembly wiring step provides the real impl) ──

/**
 * The explain seam (d-AC-1 / FR-2). Resolves the routing decision for a
 * workload WITHOUT executing inference. In production the daemon assembly wires
 * this to `POST /api/inference/explain` (PRD-010c c-AC-1). Tests inject a fake.
 */
export interface RouteExplainer {
	explain(workload: string, scope: RouteScope): Promise<RouteDecision>;
}

/**
 * The history seam (d-AC-2 / FR-3). Returns recent redacted routing events for
 * a scope, newest-first. In production the daemon assembly wires this to
 * `GET /api/inference/history` (PRD-010c c-AC-6). Tests inject a fake.
 *
 * The returned events are already redacted by construction at the write
 * boundary — the CLI never sees a secret/body field (d-AC-5).
 */
export interface RouteHistoryClient {
	recent(scope: RouteScope, limit: number): Promise<RouteHistoryEvent[]>;
}

/**
 * The pin store seam (d-AC-3 / FR-6). Manages workload→target pins in the
 * daemon. The daemon holds pins in runtime memory (not persisted across restarts
 * per the PRD open question). The router reads the pin map before mode selection;
 * a pinned workload resolves directly to the pinned target.
 *
 * In production the daemon assembly wires this to:
 *   POST   /api/inference/pins  — set a pin
 *   DELETE /api/inference/pins/:workload — remove a pin
 *   GET    /api/inference/pins  — list active pins
 *
 * Tests inject a fake in-memory implementation.
 */
export interface RoutePinStore {
	pin(workload: string, target: string, scope: RouteScope): Promise<void>;
	unpin(workload: string, scope: RouteScope): Promise<void>;
	list(scope: RouteScope): Promise<RoutePin[]>;
	/** Resolve the currently-pinned target for a workload, or null if none. */
	resolve(workload: string, scope: RouteScope): Promise<string | null>;
}

/** The list seam (FR-4). Lists configured targets and their bound workloads. */
export interface RouteListClient {
	list(scope: RouteScope): Promise<RouteTarget[]>;
}

/** The doctor seam (FR-1). Reports config + account health. */
export interface RouteDoctorClient {
	health(scope: RouteScope): Promise<RouteDoctorReport>;
}

/** A line-sink so the command's output is capturable in tests (no direct stdout). */
export interface RouteOutputSink {
	(line: string): void;
}

// ── Arg parsing ───────────────────────────────────────────────────────────────

/** The parsed `route` invocation: the sub-command + positional args + scope. */
export interface RouteInvocation {
	/** The primary verb ("explain" | "status" | "pin" | "unpin" | "test" | "list" | "doctor" | ""). */
	readonly verb: string;
	/** The workload positional for explain/pin/unpin/test. */
	readonly workload: string;
	/** The target positional for pin. */
	readonly target: string;
	/** `--limit N` for status (default 20). */
	readonly limit: number;
	/** The resolved scope (org / workspace / agentId). */
	readonly scope: RouteScope;
}

/** Outcome of running a `route` command. */
export interface RouteResult {
	readonly exitCode: number;
}

/**
 * Parse a raw `route` argv tail (everything AFTER the `route` word) into a typed
 * {@link RouteInvocation}. Scope flags default to empty org / default workspace /
 * `default` agent so a missing scope is explicit.
 *
 * Recognized flags: `--org <v>`, `--workspace <v>`, `--agent <v>`, `--limit <n>`.
 * The first non-flag word is the verb; subsequent non-flag words fill workload /
 * target positionals.
 */
export function parseRouteArgs(argv: readonly string[]): RouteInvocation {
	let verb = "";
	let workload = "";
	let target = "";
	let org = "";
	let workspace = "";
	let agentId = "default";
	let limit = 20;

	const positionals: string[] = [];

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		switch (a) {
			case "--org":
				org = argv[++i] ?? "";
				break;
			case "--workspace":
				workspace = argv[++i] ?? "";
				break;
			case "--agent":
				agentId = argv[++i] ?? "default";
				break;
			case "--limit": {
				const raw = argv[++i] ?? "";
				const n = parseInt(raw, 10);
				limit = Number.isFinite(n) && n > 0 ? n : 20;
				break;
			}
			default:
				if (!a.startsWith("--")) positionals.push(a);
				break;
		}
	}

	if (positionals.length > 0) verb = positionals[0] as string;
	if (positionals.length > 1) workload = positionals[1] as string;
	if (positionals.length > 2) target = positionals[2] as string;

	return { verb, workload, target, limit, scope: { org, workspace, agentId } };
}

// ── Rendering helpers ─────────────────────────────────────────────────────────

/** Render a {@link RouteDecision} as human-readable lines (d-AC-1 / d-AC-4). */
function printDecision(decision: RouteDecision, out: RouteOutputSink): void {
	out(`workload:       ${decision.workload}`);
	out(`mode:           ${decision.mode}`);
	out(`serving_target: ${decision.servingTarget ?? "(none — all candidates blocked/failed)"}`);
	if (decision.attempts.length > 0) {
		out("attempts:");
		for (const a of decision.attempts) {
			const parts = [`  - target=${a.targetId}`, `outcome=${a.outcome}`];
			if (a.statusCode !== undefined) parts.push(`status=${a.statusCode}`);
			if (a.reason !== undefined) parts.push(`reason=${a.reason}`);
			out(parts.join(" "));
		}
	}
	if (decision.blockedCandidates.length > 0) {
		out("blocked:");
		for (const b of decision.blockedCandidates) {
			out(`  - target=${b.targetId} reason=${b.reason}`);
		}
	}
}

/** Render a {@link RouteHistoryEvent} as human-readable lines (d-AC-2). */
function printHistoryEvent(ev: RouteHistoryEvent, index: number, out: RouteOutputSink): void {
	out(`[${index}] request=${ev.requestId} workload=${ev.workload} mode=${ev.mode}`);
	out(`    serving_target=${ev.servingTarget ?? "(none)"}`);
	for (const a of ev.attempts) {
		const parts = [`  attempt: target=${a.targetId}`, `outcome=${a.outcome}`];
		if (a.statusCode !== undefined) parts.push(`status=${a.statusCode}`);
		if (a.reason !== undefined) parts.push(`reason=${a.reason}`);
		out("  " + parts.join(" "));
	}
	for (const b of ev.blockedCandidates) {
		out(`  blocked: target=${b.targetId} reason=${b.reason}`);
	}
}

// ── Command runner ────────────────────────────────────────────────────────────

/** All seams the command runner needs — pass only the ones the verb requires. */
export interface RouteCommandDeps {
	readonly explainer: RouteExplainer;
	readonly history: RouteHistoryClient;
	readonly pins: RoutePinStore;
	readonly list?: RouteListClient;
	readonly doctor?: RouteDoctorClient;
}

/**
 * Run a parsed `route` command (d-AC-1..5 / FR-1..6). Dispatches to the
 * appropriate seam based on {@link RouteInvocation.verb}.
 *
 * All seams are injected — the CLI never touches storage or daemon internals.
 * `out` is the injected sink so a test captures the report without touching stdout.
 */
export async function runRouteCommand(
	inv: RouteInvocation,
	deps: RouteCommandDeps,
	out: RouteOutputSink,
): Promise<RouteResult> {
	const { verb, workload, target, limit, scope } = inv;

	// ── d-AC-1: explain <workload> — routing decision WITHOUT executing ──────
	if (verb === "explain") {
		if (workload === "") {
			out("error: `route explain` requires a workload argument.");
			out("       usage: honeycomb route explain <workload> [--org O --workspace W --agent A]");
			return { exitCode: 2 };
		}
		const decision = await deps.explainer.explain(workload, scope);
		out(`scope: org=${scope.org} workspace=${scope.workspace} agent=${scope.agentId}`);
		out("--- routing decision (no inference executed) ---");
		printDecision(decision, out);
		return { exitCode: 0 };
	}

	// ── d-AC-4: test <workload> — serving target + full attempt sequence ─────
	// Uses the same explain path (no inference executed); surfaces the full
	// attempt sequence so operators see exactly what the router would try.
	if (verb === "test") {
		if (workload === "") {
			out("error: `route test` requires a workload argument.");
			out("       usage: honeycomb route test <workload> [--org O --workspace W --agent A]");
			return { exitCode: 2 };
		}
		const decision = await deps.explainer.explain(workload, scope);
		out(`scope: org=${scope.org} workspace=${scope.workspace} agent=${scope.agentId}`);
		out("--- route test (no inference executed) ---");
		out(`serving_target: ${decision.servingTarget ?? "(none — all candidates blocked/failed)"}`);
		out("full attempt sequence:");
		for (const a of decision.attempts) {
			const parts = [`  target=${a.targetId}`, `outcome=${a.outcome}`];
			if (a.statusCode !== undefined) parts.push(`status=${a.statusCode}`);
			if (a.reason !== undefined) parts.push(`reason=${a.reason}`);
			out(parts.join(" "));
		}
		if (decision.blockedCandidates.length > 0) {
			out("blocked:");
			for (const b of decision.blockedCandidates) {
				out(`  target=${b.targetId} reason=${b.reason}`);
			}
		}
		return { exitCode: 0 };
	}

	// ── d-AC-2: status — recent route + fallback sequences (redacted) ────────
	if (verb === "status") {
		out(`scope: org=${scope.org} workspace=${scope.workspace} agent=${scope.agentId}`);
		const events = await deps.history.recent(scope, limit);
		if (events.length === 0) {
			out("status: no routing history for this scope.");
			return { exitCode: 0 };
		}
		out(`--- recent routing history (${events.length} event${events.length === 1 ? "" : "s"}, redacted at source) ---`);
		for (let i = 0; i < events.length; i++) {
			// The redaction guarantee (d-AC-5) originates at the write boundary inside
			// RoutingHistoryStore.record, which accepts only RedactedRoutingEvent — a
			// type that cannot carry a secret/key/body. The CLI displays what the source
			// provides; it does not scrub (there is nothing to scrub).
			printHistoryEvent(events[i] as RouteHistoryEvent, i, out);
		}
		return { exitCode: 0 };
	}

	// ── d-AC-3: pin <workload> <target> — pin until unpinned ─────────────────
	if (verb === "pin") {
		if (workload === "" || target === "") {
			out("error: `route pin` requires a workload and a target.");
			out("       usage: honeycomb route pin <workload> <target> [--org O --workspace W --agent A]");
			return { exitCode: 2 };
		}
		await deps.pins.pin(workload, target, scope);
		out(`pinned: workload=${workload} → target=${target}`);
		out(`scope: org=${scope.org} workspace=${scope.workspace} agent=${scope.agentId}`);
		out("pin is in effect until: honeycomb route unpin " + workload);
		return { exitCode: 0 };
	}

	// ── d-AC-3 (unpin): remove the pin → returns to policy resolution ─────────
	if (verb === "unpin") {
		if (workload === "") {
			out("error: `route unpin` requires a workload argument.");
			out("       usage: honeycomb route unpin <workload> [--org O --workspace W --agent A]");
			return { exitCode: 2 };
		}
		await deps.pins.unpin(workload, scope);
		out(`unpinned: workload=${workload} (policy resolution restored)`);
		out(`scope: org=${scope.org} workspace=${scope.workspace} agent=${scope.agentId}`);
		return { exitCode: 0 };
	}

	// ── list — configured targets + bound workloads (FR-4) ───────────────────
	if (verb === "list") {
		if (deps.list === undefined) {
			out("error: list surface not wired (daemon assembly deferred).");
			return { exitCode: 2 };
		}
		const targets = await deps.list.list(scope);
		out(`scope: org=${scope.org} workspace=${scope.workspace} agent=${scope.agentId}`);
		if (targets.length === 0) {
			out("list: no configured targets for this scope.");
			return { exitCode: 0 };
		}
		out("--- configured targets ---");
		for (const t of targets) {
			out(`target: ${t.id} model=${t.model} privacy=${t.privacyTier}`);
			out(`  capabilities: ${t.capabilities.join(", ")}`);
			out(`  workloads: ${t.boundWorkloads.length === 0 ? "(none)" : t.boundWorkloads.join(", ")}`);
		}
		return { exitCode: 0 };
	}

	// ── doctor — config + account health (FR-1) ───────────────────────────────
	if (verb === "doctor") {
		if (deps.doctor === undefined) {
			out("error: doctor surface not wired (daemon assembly deferred).");
			return { exitCode: 2 };
		}
		const report = await deps.doctor.health(scope);
		out(`scope: org=${scope.org} workspace=${scope.workspace} agent=${scope.agentId}`);
		out("--- router health ---");
		out(`accounts: ${report.accountsTotal} total, ${report.accountsExpired} expired`);
		out(`targets:  ${report.targetsTotal} total, ${report.targetsAvailable} available`);
		out(`pins:     ${report.pinsActive} active`);
		return { exitCode: 0 };
	}

	// ── usage ─────────────────────────────────────────────────────────────────
	out("usage: honeycomb route <verb> [args] [--org O --workspace W --agent A]");
	out("");
	out("verbs:");
	out("  explain <workload>          — routing decision without executing inference (d-AC-1)");
	out("  status                      — recent route + fallback sequences, redacted (d-AC-2)");
	out("  pin <workload> <target>     — pin workload to target until unpinned (d-AC-3)");
	out("  unpin <workload>            — remove pin, restore policy resolution (d-AC-3)");
	out("  test <workload>             — serving target + full attempt sequence (d-AC-4)");
	out("  list                        — configured targets + bound workloads");
	out("  doctor                      — config + account health");
	return { exitCode: verb === "" ? 0 : 1 };
}

/**
 * Convenience entry: parse + run a `route` argv tail in one call (FR-1 / d-AC-1..5).
 * The daemon assembly step (deferred) injects the real seams; the AC-named tests
 * inject fakes directly.
 */
export async function routeMain(
	argv: readonly string[],
	deps: RouteCommandDeps,
	out: RouteOutputSink,
): Promise<RouteResult> {
	return runRouteCommand(parseRouteArgs(argv), deps, out);
}
