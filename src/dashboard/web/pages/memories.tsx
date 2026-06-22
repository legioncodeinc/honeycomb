/** The Memories route placeholder — PRD-037 stands it up; PRD-040 fills it (recall + cards). */

import React from "react";

import type { PageProps } from "../page-frame.js";
import { ComingSoon } from "./coming-soon.js";

/** The Memories page (empty-framed). Recall bar + recalled-memory cards content: PRD-040. */
export function MemoriesPage(_props: PageProps): React.JSX.Element {
	return <ComingSoon title="Memories" ownerPrd="PRD-040" />;
}
