/**
 * The shared "coming soon" placeholder — PRD-037b/037c (empty-frame the six non-Dashboard routes).
 *
 * 037 stands up LIVE, testable routes for Harnesses/Memories/Graph/Sync/Logs/Settings before PRDs
 * 039-044 fill them. Each placeholder is a one-liner over this shared frame so the six pages do not
 * duplicate the same markup (jscpd discipline — one helper, six thin call sites). It renders inside
 * `<PageFrame>` (037c) with a mono "coming soon · owned by PRD-0XX" note, using only DS tokens. No
 * data, no secret — the route is reachable and the seam is proven; the content arrives in its PRD.
 */

import React from "react";

import { PageFrame } from "../page-frame.js";

/** Props for {@link ComingSoon}: the page title, its route tag, and the owning PRD id. */
export interface ComingSoonProps {
	/** The page title (the nav label, e.g. `Harnesses`). */
	readonly title: string;
	/** The owning downstream PRD id, e.g. `PRD-039`, shown in the note so the seam is self-documenting. */
	readonly ownerPrd: string;
}

/**
 * A reachable, empty-framed route placeholder. The eyebrow carries a mono "coming soon" tag and the
 * body a single line crediting the owning PRD, so a dogfooder navigating to the route sees an honest
 * "owned by PRD-0XX" note rather than a blank screen, and a test can assert the route mounted.
 */
export function ComingSoon({ title, ownerPrd }: ComingSoonProps): React.JSX.Element {
	return (
		<PageFrame title={title} eyebrow="coming soon">
			<div
				style={{
					padding: "28px 20px",
					background: "var(--bg-surface)",
					border: "1px solid var(--border-default)",
					borderRadius: "var(--radius-lg)",
					color: "var(--text-tertiary)",
					fontFamily: "var(--font-mono)",
					fontSize: 13,
				}}
			>
				coming soon · owned by {ownerPrd}
			</div>
		</PageFrame>
	);
}
