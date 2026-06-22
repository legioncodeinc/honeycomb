/** The Graph route placeholder — PRD-037 stands it up; PRD-041 fills it (codebase-graph canvas). */

import React from "react";

import type { PageProps } from "../page-frame.js";
import { ComingSoon } from "./coming-soon.js";

/** The Graph page (empty-framed). The full-page codebase-graph canvas: PRD-041. */
export function GraphPage(_props: PageProps): React.JSX.Element {
	return <ComingSoon title="Graph" ownerPrd="PRD-041" />;
}
