/**
 * `honeycomb ontology` CLI surface — PRD-008c FR-9 / c-AC-7.
 *
 * The control plane is driven from this command surface, scoped by org / workspace /
 * agent. The sub-commands:
 *   - `ontology pipeline explain`       — describe the three write paths into the graph.
 *   - `ontology proposals`              — list/inspect the proposal queue (daemon-backed).
 *   - `ontology assertions`             — list/inspect the epistemic layer (daemon-backed).
 *   - `ontology entity merge-plan`      — preview an entity merge (no mutation).
 *   - `ontology stream apply --dry-run` — report the plan a proposal WOULD take, scoped
 *     by org/workspace/agent, WITHOUT mutating (c-AC-7).
 *
 * ── Boundary: the CLI imports NO DeepLake path (a-AC-5) ─────────────────────
 * This module is a thin client: it imports neither `src/daemon/storage` nor the daemon
 * core (the storage-import invariant test enforces it). The dry-run PLAN is computed by
 * the daemon's pure `planApply` — the CLI receives it as an INJECTED {@link PlanBuilder}
 * (the daemon-assembly wiring step, deferred, supplies the real one; the AC-named test
 * supplies it directly). So a dry-run is structurally non-mutating: the CLI has no
 * storage handle, and `planApply` itself takes none.
 *
 * A run WITHOUT `--dry-run` is the only path that would mutate, and it is refused here
 * until the daemon assembly wires the control plane over the port-3850 RPC (CONVENTIONS
 * §"Daemon assembly is DEFERRED") — so this module never itself opens DeepLake.
 *
 * Note: the bundled `honeycomb` bin (`src/cli/index.ts`) is a stub and is NOT yet
 * extended to dispatch here; that is the pure-wiring assembly step. This module is
 * constructed-and-tested (the AC-named CLI test drives {@link runOntologyCommand}).
 */

// ── Structural shapes (defined locally so the CLI imports no daemon path) ─────

/** The org/workspace partition + agent the command is scoped to (c-AC-7). */
export interface OntologyScope {
	readonly org: string;
	readonly workspace?: string;
	readonly agentId: string;
}

/** One step a real run WOULD take, surfaced by the dry-run plan (c-AC-7). */
export interface OntologyPlanStep {
	readonly label: string;
	readonly sql?: string;
}

/** The dry-run plan a {@link PlanBuilder} returns — never executed (c-AC-7). */
export interface OntologyPlan {
	readonly route: "direct" | "pending";
	readonly reason: string;
	readonly status: "pending" | "applied" | "rejected" | "failed";
	readonly scope: { readonly org: string; readonly workspace: string; readonly agentId: string };
	readonly steps: readonly OntologyPlanStep[];
}

/**
 * Computes the dry-run plan for a proposal under a scope (the daemon's pure `planApply`,
 * injected). The signature is structurally compatible with
 * `planApply(scope, candidate, actor)` so the assembly step passes it straight through.
 */
export interface PlanBuilder {
	(
		scope: { readonly org: string; readonly workspace?: string },
		candidate: unknown,
		actor: { readonly agentId: string },
	): OntologyPlan;
}

/** A line-sink so the command's output is capturable in tests (no direct stdout). */
export interface OutputSink {
	(line: string): void;
}

/** The parsed `ontology` invocation: the sub-command path + flags + the scope. */
export interface OntologyInvocation {
	/** The sub-command words after `ontology` (e.g. `["stream", "apply"]`). */
	readonly path: readonly string[];
	/** `--dry-run` present. */
	readonly dryRun: boolean;
	/** `--org`, `--workspace`, `--agent` scope (c-AC-7). */
	readonly scope: OntologyScope;
	/** A `--proposal '<json>'` body, parsed JSON or `undefined`. */
	readonly proposal?: unknown;
}

/** Outcome of running an `ontology` command — exit code + whether it mutated. */
export interface OntologyResult {
	readonly exitCode: number;
	/** Always `false` for a dry-run or a read-only command (c-AC-7 assertion target). */
	readonly mutated: boolean;
}

/**
 * Parse a raw `ontology` argv tail (everything AFTER the `ontology` word) into a typed
 * {@link OntologyInvocation}. Scope flags default to empty org / `default` agent so a
 * missing scope is explicit in the plan rather than silently global.
 *
 * Recognized flags: `--dry-run`, `--org <v>`, `--workspace <v>`, `--agent <v>`,
 * `--proposal <json>`. Unknown leading words form the sub-command path.
 */
export function parseOntologyArgs(argv: readonly string[]): OntologyInvocation {
	const path: string[] = [];
	let dryRun = false;
	let org = "";
	let workspace: string | undefined;
	let agentId = "default";
	let proposalRaw: string | undefined;

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		switch (a) {
			case "--dry-run":
				dryRun = true;
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
			case "--proposal":
				proposalRaw = argv[++i] ?? "";
				break;
			default:
				if (!a.startsWith("--")) path.push(a);
				break;
		}
	}

	let proposal: unknown;
	if (proposalRaw !== undefined) {
		try {
			proposal = JSON.parse(proposalRaw);
		} catch {
			proposal = undefined;
		}
	}

	const scope: OntologyScope = workspace === undefined ? { org, agentId } : { org, workspace, agentId };
	return { path, dryRun, scope, proposal };
}

/** Render an {@link OntologyPlan} as human-readable lines (the dry-run report, c-AC-7). */
function printPlan(plan: OntologyPlan, out: OutputSink): void {
	out(`scope: org=${plan.scope.org} workspace=${plan.scope.workspace} agent=${plan.scope.agentId}`);
	out(`route: ${plan.route} (${plan.reason})`);
	out(`status (dry-run): ${plan.status}`);
	out("plan:");
	for (const step of plan.steps) {
		out(`  - ${step.label}`);
		if (step.sql !== undefined) out(`      sql: ${step.sql}`);
	}
	out("dry-run: NO mutation issued.");
}

/**
 * Run a parsed `ontology` command (c-AC-7 / FR-9). Drives the dry-run plan and the
 * read-only surfaces; refuses a live `stream apply` (no `--dry-run`) until the daemon
 * assembly wires the control plane over the RPC. Returns the exit code + a `mutated`
 * flag the test asserts is `false` for every dry-run / read path.
 *
 * `buildPlan` is the injected daemon `planApply` (pure); `out` is an injected sink so a
 * test captures the report without touching stdout.
 */
export function runOntologyCommand(inv: OntologyInvocation, buildPlan: PlanBuilder, out: OutputSink): OntologyResult {
	const sub = inv.path.join(" ");
	const scopeArg = { org: inv.scope.org, workspace: inv.scope.workspace };
	const actor = { agentId: inv.scope.agentId };

	// `stream apply` — the apply surface. Only the dry-run is served here.
	if (sub === "stream apply") {
		if (!inv.dryRun) {
			out("error: `ontology stream apply` requires --dry-run in this build;");
			out("       a live apply routes through the daemon (port 3850), not the CLI directly.");
			return { exitCode: 2, mutated: false };
		}
		const plan = buildPlan(scopeArg, inv.proposal, actor);
		printPlan(plan, out);
		// A dry-run NEVER mutates — `planApply` is pure (no storage handle).
		return { exitCode: 0, mutated: false };
	}

	if (sub === "pipeline explain") {
		out("ontology write paths (CONVENTIONS):");
		out("  1. inline linker       — model-free, links existing entities only (008a).");
		out("  2. background writer    — bulk entity upserts from extraction (006d).");
		out("  3. control plane        — audited proposals, risk-routed apply (008c).");
		out(`scope: org=${inv.scope.org} workspace=${inv.scope.workspace ?? ""} agent=${inv.scope.agentId}`);
		return { exitCode: 0, mutated: false };
	}

	if (sub === "proposals" || sub === "assertions" || sub === "entity merge-plan") {
		// Read-only / preview surfaces. The live listing/merge-plan reads route through
		// the daemon RPC (deferred); here we report the bound scope and that no mutation
		// occurs, so the surface is stable + provably non-mutating.
		out(`${sub}: read-only (daemon-backed); no mutation.`);
		out(`scope: org=${inv.scope.org} workspace=${inv.scope.workspace ?? ""} agent=${inv.scope.agentId}`);
		return { exitCode: 0, mutated: false };
	}

	out("usage: honeycomb ontology <pipeline explain | proposals | assertions |");
	out("       entity merge-plan | stream apply --dry-run> [--org O --workspace W --agent A]");
	out("       [--proposal '<json>']");
	return { exitCode: sub === "" ? 0 : 1, mutated: false };
}

/**
 * Convenience entry: parse + run an `ontology` argv tail in one call (FR-9). The daemon
 * assembly step (deferred) passes the real `planApply`; the AC-named CLI test passes it
 * directly.
 */
export function ontologyMain(argv: readonly string[], buildPlan: PlanBuilder, out: OutputSink): OntologyResult {
	return runOntologyCommand(parseOntologyArgs(argv), buildPlan, out);
}
