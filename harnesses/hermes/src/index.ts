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
 * Hermes shell-hook binary entrypoint.
 *
 * Every configured Hermes lifecycle hook invokes one of the aliases built from
 * this module. The adapter reads Hermes' JSON envelope from stdin, normalizes it
 * through the shared hook runtime, and emits only Hermes-native JSON on stdout.
 */

import { maybeRunHookBinaryMain, runHookBinary } from "../../../src/hooks/binary.js";
import { createHermesShim } from "../../../src/hooks/hermes/shim.js";
import type { HookEventOutcome } from "../../../src/hooks/runtime.js";

export function runHermesHook(): Promise<HookEventOutcome> {
	return runHookBinary({ shim: createHermesShim() });
}

maybeRunHookBinaryMain(createHermesShim(), import.meta.url);
