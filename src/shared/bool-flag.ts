/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

/**
 * The SINGLE source of truth for parsing boolean lifecycle/config flags from env strings.
 *
 * This helper was previously copy-pasted verbatim across ~8 daemon config modules. That drift is
 * exactly what caused the bug it now guards against: env values routinely arrive with surrounding
 * whitespace — a Windows scheduled-task `set "VAR=true" && …` chain, a shell heredoc, a copy-paste —
 * and an un-trimmed exact `=== "true"` silently read `"true "` as FALSE, which disabled the ENTIRE
 * memory pipeline on a real install while `/health` looked fine (the same trailing-space class as the
 * APIARY_HOME bug). Fixing it in seven places risked fixing it inconsistently; this is the one place.
 *
 * Lives in `src/shared` per the "single source of truth for lifecycle flags" guideline. It is NOT
 * re-exported from the `@honeycomb/shared` barrel (`index.ts`), so its `zod` dependency never crosses
 * into the browser dashboard bundle — daemon config modules import it directly by path.
 */

import { z } from "zod";

/**
 * An OFF-by-default boolean env flag. Unset/blank → `false`. TRIM before comparing so surrounding
 * whitespace can never flip the result. Only the explicit on-tokens `true` / `1` enable it.
 */
export const BoolFlag = z.preprocess((raw) => {
	if (typeof raw === "boolean") return raw;
	const s = typeof raw === "string" ? raw.trim() : raw;
	return s === "true" || s === "1";
}, z.boolean());

/**
 * An ON-by-default boolean env flag (the inverse posture). Unset/blank → `true`. TRIM before comparing
 * so `"false "` cannot slip past the off-token check and stay ON. Only the explicit off-tokens
 * `false` / `0` disable it.
 */
export const OnByDefaultFlag = z.preprocess((raw) => {
	if (typeof raw === "boolean") return raw;
	if (raw === undefined || raw === null || raw === "") return true; // unset → the live ON default.
	const s = typeof raw === "string" ? raw.trim() : raw;
	return !(s === "false" || s === "0"); // only explicit off tokens disable it.
}, z.boolean());
