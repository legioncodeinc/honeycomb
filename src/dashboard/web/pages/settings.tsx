/** The Settings route placeholder — PRD-037 stands it up; PRD-044 fills it (provider/model/vault). */

import React from "react";

import type { PageProps } from "../page-frame.js";
import { ComingSoon } from "./coming-soon.js";

/** The Settings page (empty-framed). Provider · model · dreaming · vault key-presence: PRD-044. */
export function SettingsPage(_props: PageProps): React.JSX.Element {
	return <ComingSoon title="Settings" ownerPrd="PRD-044" />;
}
