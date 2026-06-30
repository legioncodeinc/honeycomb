/**
 * The hand-rolled command dispatcher (PRD-064f Scope command table; AC-064f.1 .. .6).
 *
 * One `dispatch(argv, ctx)` maps the parsed command to its handler. There is NO CLI
 * framework (technical consideration: built-ins only), just a switch over the
 * single-sourced {@link CommandName} set. Every handler runs against the injected
 * {@link CliContext} so the whole surface is hermetic and testable: output is captured,
 * the confirm prompt is scripted, and every external action is an injected dep.
 *
 * The dispatcher itself is crash-safe (parent AC-8 spirit, carried into the CLI): a
 * handler that throws is caught, reported on stderr, and mapped to a non-zero exit code,
 * never a stack-trace crash. It returns an exit code rather than calling `process.exit`,
 * so a test asserts the code without the process dying.
 *
 * Binding rulings enforced here:
 *   - AC-064f.3 `diagnose` takes NO action: it only reads the classification + decides the
 *     rung; it NEVER calls `ladder.run`.
 *   - AC-064f.4 `uninstall-hivemind` confirms before acting; there is NO `clear-credentials`
 *     command anywhere in this switch (deferred, OD-4).
 *   - AC-064f.5 `self-update` is the ONLY case that calls `deps.update.selfUpdate`.
 */

import { parseArgs, hasFlag, type ParsedArgs } from "./arg-parse.js";
import { renderBannerWithMenu } from "./banner.js";
import { resolveCommand, type CommandName } from "./command-table.js";
import { HIVEDOCTOR_VERSION } from "../version.js";
import type { CliContext } from "./context.js";
import { SERVICE_NOT_AVAILABLE } from "./service-stub.js";
import type { HealthClassification } from "../health-probe.js";

/** Exit codes the dispatcher returns. 0 = ok; 1 = handler error; 2 = user declined a gate. */
export const EXIT_OK = 0;
export const EXIT_ERROR = 1;
export const EXIT_DECLINED = 2;

/** Map a classification to a short human label for `status` / `diagnose`. */
function healthLabel(c: HealthClassification): string {
	switch (c.kind) {
		case "ok":
			return "ok";
		case "degraded":
			return "degraded";
		case "unreachable-refused":
			return "unreachable (connection refused)";
		case "unreachable-timeout":
			return "unreachable (timed out / wedged)";
		default:
			return "unknown";
	}
}

/** Map a classification to the coarse health used for the recommended-rung explanation. */
function isUnhealthy(c: HealthClassification): boolean {
	return c.kind !== "ok";
}

/** `status` (AC-064f.2 / AC-064f.6): health, service state, both versions, last heal, opt-out. */
async function runStatus(ctx: CliContext): Promise<number> {
	const { io, colors, deps } = ctx;
	// Probe + version reads are injected and ALWAYS resolve a value, so this works when the
	// daemon is down (AC-064f.6) - a down daemon shows as unreachable, not a crash.
	const classification = await deps.probe();
	const daemonVersion = await deps.readDaemonVersion();
	const state = deps.readStatusState();
	// The service state prefers the bounded ASYNC probe (wired to serviceStatus in the composition
	// root, IRD-192 AC-5) so a registered task reports its real state, never a hardcoded "unknown".
	// The probe is bounded by SERVICE_COMMAND_TIMEOUT_MS in the wiring; it never blocks indefinitely.
	// The sync serviceState() seam is the test-harness fallback when the async probe is not injected.
	const serviceState = deps.serviceStateAsync !== undefined ? await deps.serviceStateAsync() : deps.serviceState();

	io.out(colors.bold("HiveDoctor status"));
	io.out(`  Daemon health:      ${colors.cyan(healthLabel(classification))}`);
	io.out(`  HiveDoctor service: ${colors.cyan(serviceState)}`);
	io.out(`  Daemon version:     ${daemonVersion ?? colors.dim("unknown (daemon unreachable)")}`);
	io.out(`  HiveDoctor version: ${deps.hivedoctorVersion}`);
	io.out(`  Last heal:          ${state.lastHealAt ?? colors.dim("never")}`);

	// Opt-out flags - honest about which layer disabled auto-update (OD-5 / AC-064e.4).
	const autoUpdate = deps.optOut.autoUpdateDisabled
		? colors.yellow(`disabled (${deps.optOut.source})`)
		: colors.green("enabled");
	io.out(`  Auto-update:        ${autoUpdate}`);
	if (deps.optOut.pinnedVersion !== undefined) {
		io.out(`  Pinned version:     ${deps.optOut.pinnedVersion}`);
	}
	return EXIT_OK;
}

/** `diagnose` (AC-064f.3): classify + recommend a rung, take NO action. */
async function runDiagnose(ctx: CliContext): Promise<number> {
	const { io, colors, deps } = ctx;
	const classification = await deps.probe();

	io.out(colors.bold("HiveDoctor diagnosis"));
	io.out(`  Health: ${colors.cyan(healthLabel(classification))}`);

	if (!isUnhealthy(classification)) {
		io.out(colors.green("  The daemon is healthy. No remediation recommended."));
		return EXIT_OK;
	}

	// Decide the rung WITHOUT running it (AC-064f.3: takes no action). This consults the
	// pure decision only - ladder.run is never called here.
	const failures = deps.readConsecutiveFailures();
	const decision = deps.decideRung(failures);
	const rungLabel = decision.advanced
		? `rung ${decision.rung} (escalated after ${failures} failed restarts)`
		: `rung ${decision.rung}`;
	io.out(`  Recommended fix: ${colors.yellow(rungLabel)}`);
	io.out(colors.dim("  (diagnose takes no action - run `hivedoctor heal` to apply the ladder.)"));
	return EXIT_OK;
}

/** `heal`: run the ladder once for the current classification, confirming gated rungs. */
async function runHeal(ctx: CliContext, parsed: ParsedArgs): Promise<number> {
	const { io, colors, deps } = ctx;
	const classification = await deps.probe();
	if (!isUnhealthy(classification)) {
		io.out(colors.green("Daemon is healthy; nothing to heal."));
		return EXIT_OK;
	}

	const failures = deps.readConsecutiveFailures();
	const decision = deps.decideRung(failures);

	// A rung >= 2 (reinstall / uninstall-hivemind) is gated: confirm unless --yes was passed.
	const autoYes = hasFlag(parsed, "yes");
	if (decision.rung >= 2 && !autoYes) {
		const ok = await ctx.confirm(
			`Heal will run rung ${decision.rung} (a reinstall/uninstall-class repair). Proceed?`,
		);
		if (!ok) {
			io.out(colors.dim("Aborted; no action taken."));
			return EXIT_DECLINED;
		}
	}

	const result = await deps.ladder.run(decision.rung, deps.rungContextFor(classification));
	const outcome = result.skipped === true ? "skipped" : result.ok ? "succeeded" : "failed";
	io.out(`Ran ${colors.cyan(result.action)} -> ${outcome}${result.detail ? ` (${result.detail})` : ""}`);
	return result.ok || result.skipped === true ? EXIT_OK : EXIT_ERROR;
}

/** Run a single named rung directly (restart=1, reinstall=2), optionally gated. */
async function runRung(ctx: CliContext, rung: number, gated: boolean, parsed: ParsedArgs): Promise<number> {
	const { io, colors, deps } = ctx;
	if (gated && !hasFlag(parsed, "yes")) {
		const ok = await ctx.confirm(`This runs rung ${rung}, a potentially disruptive repair. Proceed?`);
		if (!ok) {
			io.out(colors.dim("Aborted; no action taken."));
			return EXIT_DECLINED;
		}
	}
	const classification = await deps.probe();
	const result = await deps.ladder.run(rung, deps.rungContextFor(classification));
	const outcome = result.skipped === true ? "skipped" : result.ok ? "succeeded" : "failed";
	io.out(`Ran ${colors.cyan(result.action)} -> ${outcome}${result.detail ? ` (${result.detail})` : ""}`);
	return result.ok || result.skipped === true ? EXIT_OK : EXIT_ERROR;
}

/** `uninstall-hivemind` (AC-064f.4): rung 3, ALWAYS confirms before acting. */
async function runUninstallHivemind(ctx: CliContext, parsed: ParsedArgs): Promise<number> {
	const { io, colors } = ctx;
	io.out(
		colors.dim(
			"This removes a conflicting @deeplake/hivemind global. It NEVER touches shared ~/.deeplake/ state.",
		),
	);
	// Always gated (rung 3 is destructive); --yes still bypasses for power users.
	return runRung(ctx, 3, true, parsed);
}

/** `update [--check]`: primary-daemon update via the blessed gate (064e). */
async function runUpdate(ctx: CliContext, parsed: ParsedArgs): Promise<number> {
	const { io, deps } = ctx;
	if (hasFlag(parsed, "check")) {
		io.out(await deps.update.checkPrimaryUpdate());
		return EXIT_OK;
	}
	io.out(await deps.update.applyPrimaryUpdate());
	return EXIT_OK;
}

/** `self-update` (AC-064f.5): THE ONLY path that updates HiveDoctor's own package. */
async function runSelfUpdate(ctx: CliContext): Promise<number> {
	ctx.io.out(await ctx.deps.update.selfUpdate());
	return EXIT_OK;
}

/**
 * `install-service` / `uninstall-service`: delegate to 064b if wired, else print stub. The module
 * returns a structured {@link ServiceResult}; a manager-command failure (ok:false) maps to
 * {@link EXIT_ERROR} so callers (the installers) see an honest non-zero exit (IRD-192 AC-6).
 */
async function runService(ctx: CliContext, kind: "install" | "uninstall"): Promise<number> {
	const { io, deps } = ctx;
	if (deps.serviceModule === undefined) {
		io.out(SERVICE_NOT_AVAILABLE);
		return EXIT_OK;
	}
	const result = kind === "install" ? await deps.serviceModule.install() : await deps.serviceModule.uninstall();
	io.out(result.message);
	return result.ok ? EXIT_OK : EXIT_ERROR;
}

/** `logs`: tail the local incident log. */
async function runLogs(ctx: CliContext, parsed: ParsedArgs): Promise<number> {
	const { io, colors, deps } = ctx;
	const limitRaw = parsed.flags["lines"];
	const limit = typeof limitRaw === "string" && /^\d+$/.test(limitRaw) ? Number.parseInt(limitRaw, 10) : 20;
	const lines = await deps.tailIncidents(limit);
	if (lines.length === 0) {
		io.out(colors.dim("No incidents recorded yet."));
		return EXIT_OK;
	}
	for (const line of lines) io.out(line);
	return EXIT_OK;
}

/** Render the banner + menu (bare invocation / `help`). */
function runHelp(ctx: CliContext): number {
	ctx.io.out(renderBannerWithMenu(ctx.colors));
	return EXIT_OK;
}

/** Route a resolved command to its handler. */
async function route(command: CommandName, ctx: CliContext, parsed: ParsedArgs): Promise<number> {
	switch (command) {
		case "run":
			// `run` is the long-running OS-service entry; it is intercepted in runCli BEFORE the
			// dispatcher (it never returns an exit code mid-loop). Reaching here means it was routed
			// without that interception, so print an honest note rather than silently no-op.
			ctx.io.out("`run` is the OS-service entry and is started by the service manager, not dispatched here.");
			return EXIT_OK;
		case "status":
			return runStatus(ctx);
		case "diagnose":
			return runDiagnose(ctx);
		case "heal":
			return runHeal(ctx, parsed);
		case "restart":
			return runRung(ctx, 1, false, parsed);
		case "reinstall":
			return runRung(ctx, 2, true, parsed);
		case "uninstall-hivemind":
			return runUninstallHivemind(ctx, parsed);
		case "update":
			return runUpdate(ctx, parsed);
		case "self-update":
			return runSelfUpdate(ctx);
		case "install-service":
			return runService(ctx, "install");
		case "uninstall-service":
			return runService(ctx, "uninstall");
		case "logs":
			return runLogs(ctx, parsed);
		case "help":
			return runHelp(ctx);
		default: {
			// Exhaustiveness guard: a new CommandName must add a case above.
			const _exhaustive: never = command;
			return _exhaustive;
		}
	}
}

/**
 * Dispatch one CLI invocation. `argv` is the slice after `node <script>` (the caller
 * strips those). Returns the exit code; never throws (a handler error is caught and
 * mapped to {@link EXIT_ERROR}).
 */
export async function dispatch(argv: readonly string[], ctx: CliContext): Promise<number> {
	const parsed = parseArgs(argv);
	const command = resolveCommand(parsed.command);

	// `--version` / `-v` / `-V` -> print just the version string and exit, BEFORE the
	// bare-invocation banner fallback (otherwise `hivedoctor --version` shows the banner).
	if (hasFlag(parsed, "version") || argv.includes("-v") || argv.includes("-V")) {
		ctx.io.out(HIVEDOCTOR_VERSION);
		return EXIT_OK;
	}

	// Bare invocation (no command) -> banner + menu (AC-064f.1).
	if (command === null && parsed.command === undefined) {
		return runHelp(ctx);
	}

	// An UNKNOWN command token: print a short error + the menu, exit non-zero.
	if (command === null) {
		ctx.io.err(ctx.colors.red(`Unknown command: ${parsed.command ?? ""}`));
		ctx.io.out(renderBannerWithMenu(ctx.colors));
		return EXIT_ERROR;
	}

	try {
		return await route(command, ctx, parsed);
	} catch (error) {
		// Crash-safe: a handler error is reported, never a thrown stack trace (parent AC-8).
		ctx.io.err(ctx.colors.red(`Command failed: ${error instanceof Error ? error.message : "unknown error"}`));
		return EXIT_ERROR;
	}
}
