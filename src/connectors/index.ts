/**
 * Connector base barrel — PRD-019a (install-time connector surface).
 *
 * The public surface: the abstract {@link HarnessConnector} base, the
 * {@link ConnectorFs}/{@link FakeFs} filesystem seam, the descriptor types a
 * subclass declares, the {@link ClaudeCodeConnector} reference, and the
 * `setup`/`connect`/`uninstall` CLI verbs. The base + Claude Code reference are
 * fully filled (019a Wave 2); a new harness is a SUBCLASS overriding only the four
 * seams (a-AC-5). See CONVENTIONS.md before extending.
 */

export {
	type ConfigHookEntry,
	type ConfigMatcherBlock,
	type ConnectorFs,
	type ConnectorRunResult,
	createFakeFs,
	type DetectedPlatform,
	type FakeFs,
	HarnessConnector,
	type HarnessConfig,
	HONEYCOMB_ENTRY_KEY,
	HONEYCOMB_MARKER,
	type HookHandlerEntry,
	notImplemented,
	type SkillLinkTarget,
} from "./contracts.js";

export { ClaudeCodeConnector, type ClaudeCodeConnectorOptions } from "./claude-code.js";

export { CursorConnector, type CursorConnectorOptions } from "./cursor.js";

export {
	connectorMain,
	type ConnectorCommandDeps,
	type ConnectorCommandResult,
	type ConnectorInvocation,
	type ConnectorOutputSink,
	type ConnectorRegistry,
	parseConnectorArgs,
	runConnectorCommand,
} from "./cli.js";
