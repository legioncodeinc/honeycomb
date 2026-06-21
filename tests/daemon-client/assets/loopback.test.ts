/**
 * PRD-033c — the loopback {@link AssetSyncApi} (`createLoopbackAssetSyncApi`).
 *
 * Proves the thin-client API POSTs to the daemon's `/api/assets/*` routes through the
 * injected {@link DaemonClient} seam (the SAME loopback the rest of the CLI uses) and
 * maps the responses back to the contract shapes — it opens no DeepLake (D-6). The seam
 * is the verbatim contract 033b's CLI consumes.
 */

import { describe, expect, it } from "vitest";

import { createFakeDaemonClient } from "../../../src/commands/contracts.js";
import { createLoopbackAssetSyncApi } from "../../../src/daemon-client/assets/install.js";
import type { LatticeCell } from "../../../src/daemon-client/assets/contracts.js";

const CELL: LatticeCell = { tier: "Team", style: "Repository" };
const SCOPE = { org: "acme", workspace: "backend", author: "alice", deviceId: "dev-1" };

describe("PRD-033c createLoopbackAssetSyncApi", () => {
	it("publish POSTs /api/assets/publish and maps the response", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/assets/publish": { status: 200, body: { honeycombId: "hc_x", version: 3, published: true } } },
		});
		const api = createLoopbackAssetSyncApi(daemon);
		const res = await api.publish({
			honeycombId: "hc_x",
			assetType: "skill",
			harness: "claude_code",
			native: "b",
			canonical: "b",
			contentHash: "h",
			cell: CELL,
			scope: SCOPE,
			deviceSet: [],
		});
		expect(res).toEqual({ honeycombId: "hc_x", version: 3, published: true });
		expect(daemon.calls[0].req.method).toBe("POST");
		expect(daemon.calls[0].req.path).toBe("/api/assets/publish");
	});

	it("pull POSTs /api/assets/pull and maps assets + tableAbsent", async () => {
		const daemon = createFakeDaemonClient({
			responses: {
				"POST /api/assets/pull": {
					status: 200,
					body: {
						assets: [
							{
								honeycombId: "hc_y",
								assetType: "skill",
								harness: "claude_code",
								native: "body",
								canonical: "",
								contentHash: "h",
								version: 2,
								tombstone: false,
								cell: { tier: "Team", style: "Repository" },
								deviceSet: [],
								author: "alice",
								org: "acme",
								workspace: "backend",
							},
						],
						tableAbsent: false,
					},
				},
			},
		});
		const api = createLoopbackAssetSyncApi(daemon);
		const res = await api.pull({ scope: SCOPE });
		expect(res.tableAbsent).toBe(false);
		expect(res.assets).toHaveLength(1);
		expect(res.assets[0].honeycombId).toBe("hc_y");
		expect(daemon.calls[0].req.path).toBe("/api/assets/pull");
	});

	it("tombstone POSTs /api/assets/tombstone and maps the response", async () => {
		const daemon = createFakeDaemonClient({
			responses: { "POST /api/assets/tombstone": { status: 200, body: { honeycombId: "hc_z", version: 4, tombstoned: true } } },
		});
		const api = createLoopbackAssetSyncApi(daemon);
		const res = await api.tombstone({ honeycombId: "hc_z", assetType: "skill", harness: "claude_code", cell: CELL, scope: SCOPE, deviceSet: [] });
		expect(res).toEqual({ honeycombId: "hc_z", version: 4, tombstoned: true });
		expect(daemon.calls[0].req.path).toBe("/api/assets/tombstone");
	});

	it("a non-2xx pull is fail-soft (empty result, not a throw)", async () => {
		const daemon = createFakeDaemonClient({ responses: { "POST /api/assets/pull": { status: 500, body: {} } } });
		const api = createLoopbackAssetSyncApi(daemon);
		const res = await api.pull({ scope: SCOPE });
		expect(res.assets).toHaveLength(0);
		expect(res.tableAbsent).toBe(false);
	});

	it("a non-2xx publish maps to published:false (never a throw)", async () => {
		const daemon = createFakeDaemonClient({ responses: { "POST /api/assets/publish": { status: 400, body: { error: "bad" } } } });
		const api = createLoopbackAssetSyncApi(daemon);
		const res = await api.publish({
			honeycombId: "hc_x",
			assetType: "skill",
			harness: "claude_code",
			native: "b",
			canonical: "b",
			contentHash: "h",
			cell: CELL,
			scope: SCOPE,
			deviceSet: [],
		});
		expect(res.published).toBe(false);
	});
});
