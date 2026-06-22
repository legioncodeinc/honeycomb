/** The Logs route placeholder — PRD-037 stands it up; PRD-043 fills it (full-page live log). */

import React from "react";

import type { PageProps } from "../page-frame.js";
import { ComingSoon } from "./coming-soon.js";

/** The Logs page (empty-framed). The full-page live-log stream: PRD-043. */
export function LogsPage(_props: PageProps): React.JSX.Element {
	return <ComingSoon title="Logs" ownerPrd="PRD-043" />;
}
