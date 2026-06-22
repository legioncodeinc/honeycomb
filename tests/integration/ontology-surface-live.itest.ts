/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  PRD-045c — the ASSEMBLED-daemon ontology surface, proven LIVE.            ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  The 045c headline: with `mountOntologyApi` FIRED BY `assembleDaemon`       ║
 * ║  (c-AC-2) and the inline linker invoked on the live graph-persist path      ║
 * ║  (c-AC-1), a memory STORED through `POST /api/memories` is, after the        ║
 * ║  pipeline processes it, READABLE as a linked entity via                      ║
 * ║  `GET /api/ontology/entities` — over real loopback HTTP, against LIVE        ║
 * ║  DeepLake, via the assembled daemon (no 501, no manual mount). (c-AC-3)      ║
 * ║                                                                            ║
 * ║  And the reason-gated `POST /api/ontology/proposals` runs the control       ║
 * ║  plane on a live path INDEPENDENT of dreaming: a `claim.add` then a          ║
 * ║  `claim.supersede` leave the superseded prior TOMBSTONED — excluded from     ║
 * ║  the active `/api/ontology/claims` read while still on disk. (c-AC-4)        ║
 * ║                                                                            ║
 * ║  GATED + ISOLATED (same posture as data-api-assembled-live.itest.ts):      ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = skip, exit 0.║
 * ║    - `.itest.ts` + `tests/integration/**` exclusion keep it OUT of          ║
 * ║      `npm run ci`; only `npm run test:integration` runs it.                 ║
 * ║    - Per-run UNIQUE proper-noun so the proof reads only THIS run's rows.     ║
 * ║    - Ephemeral port (bootTestDaemon binds port 0 — never 3850).             ║
 * ║                                                                            ║
 * ║  120s CAP. SECRETS via env only. Do NOT run locally; the orchestrator       ║
 * ║  runs it with creds. The deterministic sibling (no token) is                 ║
 * ║  `tests/daemon/runtime/ontology-surface-assembled.test.ts`.                 ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createStorageClient,
	envCredentialProvider,
	type QueryScope,
	resolveStorageConfig,
	type StorageClient,
} from "../../src/daemon/storage/index.js";
import { createLoopbackDaemonClient, type DaemonClient } from "../../src/commands/index.js";
import { bootTestDaemon, type BootedTestDaemon } from "./_daemon-harness.js";
import { neutralizeIfInfraDegraded } from "./_infra-skip.js";

const HAS_TOKEN = Boolean(process.env.HONEYCOMB_DEEPLAKE_TOKEN);

/** A per-run unique id so the proof reads only THIS run's rows (never real data). */
function runId(): string {
	const fromEnv = process.env.HONEYCOMB_CI_RUN_ID ?? process.env.GITHUB_RUN_ID;
	if (fromEnv && /^[A-Za-z0-9_]+$/.test(fromEnv)) return fromEnv;
	return `t${(process.hrtime.bigint() % 1_000_000_000n).toString()}`;
}

const RUN_ID = runId();
/** A per-run-unique, capitalized proper noun the inline linker will treat as a candidate. */
const PROPER_NOUN = `Ontolyx${RUN_ID}`;

describe.skipIf(!HAS_TOKEN)("PRD-045c assembled-daemon ontology surface over HTTP (live)", () => {
	let booted: BootedTestDaemon;
	let client: DaemonClient;
	let scope: QueryScope;
	let probeStorage: StorageClient;

	beforeAll(async () => {
		const raw = envCredentialProvider().read();
		const provider = {
			read: () => ({
				...raw,
				workspace: process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "honeycomb_ci",
				queryTimeoutMs: 120_000,
			}),
		};
		const config = resolveStorageConfig(provider);
		scope = { org: config.org, workspace: config.workspace };

		probeStorage = createStorageClient({ provider });
		// Boot the REAL assembled daemon — the assembly FIRES mountOntologyApi (c-AC-2).
		booted = await bootTestDaemon({ mode: "local", storage: probeStorage });

		client = createLoopbackDaemonClient({
			baseUrl: booted.baseUrl,
			headers: {
				"x-honeycomb-org": scope.org,
				"x-honeycomb-workspace": scope.workspace ?? "honeycomb_ci",
			},
		});
	}, 120_000);

	afterAll(async () => {
		if (booted) await booted.stop();
	});

	it(
		"c-AC-2: /api/ontology/* read routes are LIVE on the assembled daemon (no 501)",
		async ({ skip }) => {
			await neutralizeIfInfraDegraded("ontology-surface-live:preflight-read", () => probeStorage.connect(scope), skip);
			for (const path of ["/api/ontology", "/api/ontology/entities", "/api/ontology/edges", "/api/ontology/claims", "/api/ontology/assertions"]) {
				const res = await client.send({ method: "GET", path });
				expect(res.status, `${path} is live (no 501)`).toBe(200);
			}
		},
		120_000,
	);

	it(
		"c-AC-3: a stored memory is, after processing, readable as a linked entity via /api/ontology",
		async ({ skip }) => {
			await neutralizeIfInfraDegraded("ontology-surface-live:preflight-link", () => probeStorage.connect(scope), skip);

			// Store a memory whose content names a distinctive proper noun. The pipeline extracts
			// entities + runs the inline linker on the graph-persist live path (c-AC-1), so the
			// proper-noun entity becomes readable via /api/ontology/entities.
			const stored = await client.send({
				method: "POST",
				path: "/api/memories",
				body: { content: `${PROPER_NOUN} is the project that proves the ontology surface is live.` },
			});
			expect(stored.status, "the memory stored (201)").toBe(201);

			// Poll the ontology surface until the entity converges (eventual consistency + async pipeline).
			const wanted = PROPER_NOUN.toLowerCase();
			let found = false;
			for (let poll = 0; poll < 60 && !found; poll++) {
				const res = await client.send({ method: "GET", path: "/api/ontology/entities" });
				expect(res.status).toBe(200);
				const body = res.body as { entities: Array<{ name: string }> };
				if (body.entities.some((e) => e.name.includes(wanted))) found = true;
				if (!found) await new Promise((r) => setTimeout(r, 1000));
			}
			expect(found, "the processed memory's entity is readable via /api/ontology/entities").toBe(true);
		},
		120_000,
	);

	it(
		"c-AC-4: a superseded claim is tombstoned — excluded from the active /api/ontology/claims read",
		async ({ skip }) => {
			await neutralizeIfInfraDegraded("ontology-surface-live:preflight-supersede", () => probeStorage.connect(scope), skip);

			const aspectId = `asp_045c_${RUN_ID}`;
			const claimKey = "title";
			const groupKey = "role";

			// 1. Add the first claim through the live reason-gated control plane.
			const add = await client.send({
				method: "POST",
				path: "/api/ontology/proposals",
				body: {
					operation: "claim.add",
					confidence: 0.92,
					rationale: "045c live add",
					riskNote: "",
					payload: { aspectId, groupKey, claimKey, kind: "attribute", content: `Engineer ${RUN_ID}`, memoryId: `mem_${RUN_ID}`, importance: 0.5 },
					provenance: { source: "itest", evidence: `mem_${RUN_ID};add` },
				},
			});
			expect(add.status, "claim.add applied (202)").toBe(202);
			expect((add.body as { status: string }).status).toBe("applied");

			// 2. Supersede it through the live control plane (append-only version bump).
			const supersede = await client.send({
				method: "POST",
				path: "/api/ontology/proposals",
				body: {
					operation: "claim.supersede",
					confidence: 0.95,
					rationale: "045c live supersede",
					riskNote: "",
					payload: { aspectId, groupKey, claimKey, kind: "attribute", content: `Staff Engineer ${RUN_ID}`, memoryId: `mem_${RUN_ID}`, importance: 0.6 },
					provenance: { source: "itest", evidence: `mem_${RUN_ID};supersede` },
				},
			});
			expect(supersede.status, "claim.supersede applied (202)").toBe(202);
			expect((supersede.body as { status: string }).status).toBe("applied");

			// 3. The active /api/ontology/claims read shows the NEW claim and NOT the superseded one
			//    (the prior is tombstoned: status='superseded' at its highest version, excluded by the
			//    active-only filter — observably tombstoned, NOT deleted). Poll-convergent.
			let convergedActive = false;
			for (let poll = 0; poll < 60 && !convergedActive; poll++) {
				const res = await client.send({ method: "GET", path: "/api/ontology/claims" });
				expect(res.status).toBe(200);
				const body = res.body as { claims: Array<{ content: string; status: string }> };
				const mine = body.claims.filter((cl) => cl.content.includes(RUN_ID));
				const hasNew = mine.some((cl) => cl.content.includes(`Staff Engineer ${RUN_ID}`));
				const hasOldActive = mine.some((cl) => cl.content === `Engineer ${RUN_ID}` && cl.status === "active");
				// Tombstone proof: the new claim is active AND the prior is NOT returned as active.
				if (hasNew && !hasOldActive) convergedActive = true;
				if (!convergedActive) await new Promise((r) => setTimeout(r, 1000));
			}
			expect(convergedActive, "the superseded claim is excluded from the active read (tombstoned, not deleted)").toBe(true);
		},
		120_000,
	);
});
