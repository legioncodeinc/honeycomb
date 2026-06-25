/**
 * The shared "needs a project selection" EMPTY STATE — PRD-049e (49e-AC-5).
 *
 * When no project is selected in the scope switcher (or none is accessible), every project-specific
 * page renders THIS explicit empty/needs-selection state INSTEAD of any data — never another project's
 * rows. It is one shared component (not duplicated per page) so the copy stays consistent and the jscpd
 * gate is satisfied (a single definition, three call sites). Every visual value is an existing DS token.
 */

import React from "react";

/**
 * The explicit needs-selection panel (49e-AC-5). Rendered by the graph / memories / sync pages when
 * `useScope().scope.project` is undefined: an honest "pick a project to view its <surface>" message,
 * NOT a faked/another-project's view. `surface` names the page's data ("codebase graph", "memories", …)
 * so the copy reads naturally per page.
 */
export function NeedsProjectSelection({ surface }: { surface: string }): React.JSX.Element {
	return (
		<div
			data-testid="needs-project-selection"
			style={{
				display: "flex",
				flexDirection: "column",
				alignItems: "center",
				justifyContent: "center",
				gap: 10,
				minHeight: 320,
				padding: "48px 16px",
				background: "var(--bg-surface)",
				border: "1px solid var(--border-default)",
				borderRadius: "var(--radius-lg)",
				textAlign: "center",
			}}
		>
			<div style={{ fontSize: 15, color: "var(--text-secondary)" }}>No project selected.</div>
			<span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--text-tertiary)", maxWidth: 460 }}>
				Pick a project in the scope switcher (top of the sidebar) to view its {surface}.
			</span>
		</div>
	);
}
