/** The Sync route placeholder — PRD-037 stands it up; PRD-042 fills it (skill-sync/propagation). */

import React from "react";

import type { PageProps } from "../page-frame.js";
import { ComingSoon } from "./coming-soon.js";

/** The Sync page (empty-framed). Skill-sync / propagation content: PRD-042. */
export function SyncPage(_props: PageProps): React.JSX.Element {
	return <ComingSoon title="Sync" ownerPrd="PRD-042" />;
}
