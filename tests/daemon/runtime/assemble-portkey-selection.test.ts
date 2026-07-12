/**
 * ISS-005 "fail closed, report honestly" — the vault-driven Portkey SELECTION reader.
 *
 * The fresh-install incident: `portkey.enabled = true` + a config id but NO `activeModel`
 * produced a routable selection carrying `model: ""`, and the daemon POSTed it to the gateway
 * 373 times. `readPortkeySelection` must now return the typed `"no_model"` sentinel for that
 * combination — the caller builds NO Portkey target and `/health` reports `portkey: "no_model"`.
 *
 * Verification posture: drive the exported reader with a three-line {@link VaultSettingsReader}
 * stub (no daemon assembly, no I/O) across every branch of the closed contract.
 */

import { describe, expect, it } from "vitest";

import type { SecretScope } from "../../../src/daemon/runtime/secrets/contracts.js";
import { readPortkeySelection, type VaultSettingsReader } from "../../../src/daemon/runtime/assemble.js";
import type { SettingValue } from "../../../src/daemon/runtime/vault/registry.js";

const SCOPE: SecretScope = { org: "acme", workspace: "backend" };

/** A stub vault serving the given key→value map; any other key reads as not_found. */
function vaultOf(settings: Record<string, SettingValue>): VaultSettingsReader {
	return {
		getSetting: (key: string) =>
			Promise.resolve(
				key in settings
					? ({ ok: true, value: settings[key] as SettingValue } as const)
					: ({ ok: false, reason: "not_found" } as const),
			),
	};
}

describe("ISS-005 readPortkeySelection fails closed on a missing/empty activeModel", () => {
	it("gateway ON + config + non-empty model → a routable selection carrying that model", async () => {
		const sel = await readPortkeySelection(
			vaultOf({ "portkey.enabled": true, "portkey.config": "pc-cfg-1", activeModel: "claude-sonnet-4-6" }),
			SCOPE,
		);
		expect(sel).toEqual({ enabled: true, config: "pc-cfg-1", model: "claude-sonnet-4-6", fallbackToProvider: false });
	});

	it("gateway ON + config + MISSING activeModel → the typed 'no_model' sentinel (never model:'')", async () => {
		const sel = await readPortkeySelection(vaultOf({ "portkey.enabled": true, "portkey.config": "pc-cfg-1" }), SCOPE);
		expect(sel).toBe("no_model");
	});

	it("gateway ON + config + EMPTY/whitespace activeModel → 'no_model' too", async () => {
		for (const model of ["", "   "]) {
			const sel = await readPortkeySelection(
				vaultOf({ "portkey.enabled": true, "portkey.config": "pc-cfg-1", activeModel: model }),
				SCOPE,
			);
			expect(sel, `model ${JSON.stringify(model)} must fail closed`).toBe("no_model");
		}
	});

	it("gateway OFF → undefined (the per-provider path stands; NOT the no_model state)", async () => {
		expect(await readPortkeySelection(vaultOf({}), SCOPE)).toBeUndefined();
		expect(
			await readPortkeySelection(vaultOf({ "portkey.enabled": false, activeModel: "" }), SCOPE),
		).toBeUndefined();
	});

	it("gateway ON but empty config → undefined (the pre-existing 063b fail-soft), model state irrelevant", async () => {
		expect(await readPortkeySelection(vaultOf({ "portkey.enabled": true }), SCOPE)).toBeUndefined();
		expect(
			await readPortkeySelection(vaultOf({ "portkey.enabled": true, "portkey.config": "" }), SCOPE),
		).toBeUndefined();
	});

	it("a throwing vault degrades to undefined (never blocks boot, never fabricates a selection)", async () => {
		const throwing: VaultSettingsReader = {
			getSetting: () => Promise.reject(new Error("decrypt failed")),
		};
		expect(await readPortkeySelection(throwing, SCOPE)).toBeUndefined();
		expect(await readPortkeySelection(undefined, SCOPE)).toBeUndefined();
	});
});
