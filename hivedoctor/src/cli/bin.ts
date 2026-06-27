#!/usr/bin/env node
/**
 * The `hivedoctor` bin shebang entry (PRD-063f).
 *
 * The thinnest possible wrapper: parse argv (stripping `node` + the script path), run the
 * CLI, and exit with the returned code. ALL logic lives in {@link runCli} so it is unit
 * testable without spawning a process; this file is just the executable boundary the
 * later-wave esbuild bundle compiles to `bundle/cli.js` (the `bin` target in package.json).
 *
 * Crash-safe: runCli never throws (it catches and maps to exit 1), so this entry cannot
 * die with an unhandled stack trace. Built-ins only.
 */

import { runCli } from "./index.js";

const code = await runCli(process.argv.slice(2));
process.exit(code);
