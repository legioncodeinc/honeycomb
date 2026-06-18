/**
 * The seam bindings — PRD-020c (D-4 / D-6 / 020d boundary). The factories that bind the
 * extension's abstract seams to the REUSED engines, so the shell forks nothing.
 *
 * ── D-4 — hook wiring + skill sync wrap the 019a connector ───────────────────
 *   {@link connectorHookWiring} + {@link connectorSkillSync} wrap a 019a
 *   {@link HarnessConnector} (`src/connectors`): `wire()` → `connector.install()` (copy bundle +
 *   foreign-preserve via `isHoneycombEntry` + idempotent via `writeJsonIfChanged` →
 *   fingerprint stable on a no-op, c-AC-1/c-AC-3); `unwire()` → `connector.uninstall()`
 *   (reversible); `sync()` → `connector.install()`'s skill-link side (no-clobber, c-AC-2). This
 *   is the SAME pattern 020d's `createAutoWiring` uses — no second merge engine (D-4). The Wave-2
 *   `CursorConnector` (`src/connectors/cursor.ts`, owned by the 020a stream) is the production
 *   connector injected here; any `HarnessConnector` subclass works, so this binding is connector-
 *   agnostic and a test drives it against a connector backed by the 019a `FakeFs`.
 *
 * ── D-6 — the webview embeds the canonical 020b view layer ───────────────────
 *   {@link dashboardWebviewRenderer} calls the 020b `renderDashboard(...)` (the SAME entry the
 *   daemon-served dashboard uses) and paints its `ViewBlock` tree to HTML — NO duplicate view
 *   code (c-AC-6 / b-AC-5). Pointed at the local daemon through the 020b `DashboardDataSource`.
 *
 * ── 020d boundary — the status bar surfaces the D1–D5 health ─────────────────
 *   {@link healthSourceFromCheck} adapts a 020d `HealthCheck` into the extension's
 *   {@link StatusBarHealthSource}: `evaluate()` runs the SAME D1–D5 engine the CLI `status`
 *   uses and flattens each `HealthDimension` into the status-bar line shape (c-AC-4). The
 *   status bar SURFACES the result — it does not re-probe.
 *
 * THIN CLIENT (D-2): everything reaches the daemon through the injected 020b `DashboardDataSource`
 * + the 019a connector's `ConnectorFs`; nothing here opens DeepLake. `harnesses/cursor/extension`
 * is a NON_DAEMON_ROOT (`tests/daemon/storage/invariant.test.ts`).
 */

import { type DashboardDataSource, renderDashboard } from "../../../src/dashboard/index.js";
import type { HarnessConnector } from "../../../src/connectors/index.js";
import type { HealthCheck } from "../../../src/notifications/index.js";
import type { DashboardWebviewRenderer, HookWiring, SkillSync, StatusBarHealthSource } from "./contracts.js";
import { renderDashboardHtml } from "./render.js";

/**
 * Bind the extension's {@link HookWiring} seam to a 019a {@link HarnessConnector} (D-4 /
 * FR-2 / FR-3 / c-AC-1 / c-AC-3). `wire()` runs the connector's `install()` — which copies the
 * bundle handlers, foreign-preserves (`isHoneycombEntry`), and is idempotent
 * (`writeJsonIfChanged` → an unchanged `hooks.json` is never rewritten, so the hook-trust
 * fingerprint is stable) — and reports the connector's `wroteConfig`. `unwire()` runs
 * `uninstall()` (strip ONLY Honeycomb hooks, unlink an emptied config — reversible). `selfHeal()`
 * re-runs `install()` to restore a bundle a marketplace auto-upgrade may have dropped (FR-8);
 * `install()` is idempotent, so a healthy bundle is a no-op.
 */
export function connectorHookWiring(connector: HarnessConnector): HookWiring {
	return {
		async wire(): Promise<{ wroteConfig: boolean }> {
			const result = await connector.install();
			return { wroteConfig: result.wroteConfig };
		},
		async unwire(): Promise<void> {
			await connector.uninstall();
		},
		async selfHeal(): Promise<void> {
			// FR-8: restore a broken bundle symlink/handler a marketplace upgrade dropped. The
			// connector's install() re-writes any missing handler and is idempotent, so a healthy
			// bundle is left untouched (no fingerprint churn). This is the `ensurePluginNodeModulesLink`
			// equivalent: re-run install, let writeJsonIfChanged skip the no-op.
			await connector.install();
		},
	};
}

/**
 * Bind the extension's {@link SkillSync} seam to a 019a {@link HarnessConnector} (D-4 / FR-7 /
 * c-AC-2). `sync()` runs the connector's `install()` and returns the skill links it created —
 * the connector's `linkSkills()` NEVER clobbers a foreign entry (a real dir/file or a foreign
 * symlink at the link path is left untouched), so org/team skills are symlinked into
 * `~/.cursor/skills-cursor/` + `<project>/.cursor/skills/` without clobbering (c-AC-2).
 */
export function connectorSkillSync(connector: HarnessConnector): SkillSync {
	return {
		async sync(): Promise<readonly string[]> {
			const result = await connector.install();
			return result.skillLinks;
		},
	};
}

/**
 * Bind the extension's {@link DashboardWebviewRenderer} seam to the 020b view layer (D-6 / FR-6 /
 * c-AC-6 / b-AC-5). `renderHtml()` calls the 020b `renderDashboard(source)` — the SAME entry the
 * daemon-served dashboard uses — and paints the resulting `ViewBlock` tree to webview HTML via
 * {@link renderDashboardHtml}. NO duplicate view code: the webview shows the SAME views/contract
 * as the dashboard, and a daemon-down `source` yields the connectivity banner (FR-9), never a hang.
 */
export function dashboardWebviewRenderer(source: DashboardDataSource): DashboardWebviewRenderer {
	return {
		async renderHtml(): Promise<string> {
			const rendered = await renderDashboard(source);
			return renderDashboardHtml(rendered);
		},
	};
}

/**
 * Adapt a 020d {@link HealthCheck} into the extension's {@link StatusBarHealthSource} (FR-4 /
 * c-AC-4 / the 020d boundary). `evaluate()` runs the SAME D1–D5 engine the CLI `status` uses and
 * flattens each `HealthDimension` into the status-bar line shape (`id`, `label`, `ok`, optional
 * `detail`). The status bar SURFACES the result — it does not re-probe. The `detail` is never a
 * token (the 020d contract guarantees it).
 */
export function healthSourceFromCheck(check: HealthCheck): StatusBarHealthSource {
	return {
		async evaluate(): Promise<readonly { id: string; label: string; ok: boolean; detail?: string }[]> {
			const report = await check.evaluate();
			return report.dimensions.map((d) => ({
				id: d.id,
				label: d.label,
				ok: d.ok,
				...(d.detail !== undefined ? { detail: d.detail } : {}),
			}));
		},
	};
}
