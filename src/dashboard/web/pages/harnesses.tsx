/** The Harnesses route placeholder — PRD-037 stands it up; PRD-039 fills it (per-harness items). */

import React from "react";

import type { PageProps } from "../page-frame.js";
import { ComingSoon } from "./coming-soon.js";

/** The Harnesses page (empty-framed). Content + the dynamic per-installed-harness group: PRD-039. */
export function HarnessesPage(_props: PageProps): React.JSX.Element {
	return <ComingSoon title="Harnesses" ownerPrd="PRD-039" />;
}
