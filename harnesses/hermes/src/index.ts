/**
 * Hermes harness adapter entry root. Thin client only (no DeepLake).
 * Independently addressable by the bundler (PRD-001b).
 */

import { bootHarness, type HarnessContext } from "../../../src/daemon-client/harness.js";

export function activate(): HarnessContext {
	return bootHarness("hermes");
}
