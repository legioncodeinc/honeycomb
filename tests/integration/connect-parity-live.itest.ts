/**
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  PRD-023 Wave 4 — the DEEPLAKE CONNECT-PARITY proof (AC-8, live).          ║
 * ╠══════════════════════════════════════════════════════════════════════════╣
 * ║  The AC-8 headline: after a credential file exists at                     ║
 * ║  `~/.deeplake/credentials.json` (the SHARED file `honeycomb login` /       ║
 * ║  `hivemind login` writes) and with NO `HONEYCOMB_DEEPLAKE_*` env reaching   ║
 * ║  the daemon's provider, the assembled daemon connects FROM THE FILE and a  ║
 * ║  real store→recall through `/api/memories/recall` works LIVE — and the file ║
 * ║  is byte-shape-compatible with what Hivemind reads.                        ║
 * ║                                                                          ║
 * ║  WHY THIS IS THE AC-8 PROOF (and not 022d's): 022d resolves the daemon's   ║
 * ║  storage config FROM ENV (`envCredentialProvider`). This itest does the    ║
 * ║  OPPOSITE — it STRIPS every `HONEYCOMB_DEEPLAKE_*` key from the provider's  ║
 * ║  env and seeds the shared FILE, then drives the REAL env-over-file logic    ║
 * ║  (`defaultCredentialProvider({ env: <stripped>, dir: <tempDir> })`). With   ║
 * ║  the env absent, the FILE must supply all four of                         ║
 * ║  `{ endpoint←apiUrl, token, org←orgId, workspace←workspaceId }` or the     ║
 * ║  daemon never connects — so a green store→recall PROVES the file-only       ║
 * ║  connect path (AC-8 core), and re-proves AC-7 LIVE.                        ║
 * ║                                                                          ║
 * ║    AC-8 (core)    env-stripped → file supplies all four → assembled daemon ║
 * ║                   connects → store→recall over HTTP recalls THIS run's row. ║
 * ║    AC-8 (shape)   the seeded file is the EXACT Hivemind key set            ║
 * ║                   `{token,orgId,orgName,userName,workspaceId,apiUrl,        ║
 * ║                   savedAt}`; the four load-bearing keys                    ║
 * ║                   (`token/orgId/workspaceId/apiUrl`) are present + typed;   ║
 * ║                   Honeycomb's own `loadDiskCredentials` round-trips it.     ║
 * ║                                                                          ║
 * ║  GATED + ISOLATED (same posture as data-api-assembled-live.itest.ts):      ║
 * ║    - `describe.skipIf(!HONEYCOMB_DEEPLAKE_TOKEN)` → no token = skip,exit 0.║
 * ║    - `.itest.ts` + `tests/integration/**` exclusion keep it OUT of         ║
 * ║      `npm run ci`; only `npm run test:integration` runs it.              ║
 * ║    - The creds file is seeded into a `mkdtempSync` TEMP dir — NEVER the    ║
 * ║      real `~/.deeplake` — so a real login is never read or clobbered.       ║
 * ║    - Per-run UNIQUE term so the proof reads only THIS run's row.           ║
 * ║    - Ephemeral port (bootTestDaemon binds port 0 — never 3850).            ║
 * ║                                                                          ║
 * ║  120s CAP. SECRETS (D-4): the token is read from env, written to the temp  ║
 * ║  file, and NEVER console.log'd. Do NOT run locally; the orchestrator runs  ║
 * ║  it with creds.                                                          ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	createStorageClient,
	type CredentialProvider,
	defaultCredentialProvider,
	type QueryScope,
	resolveStorageConfig,
	type StorageClient,
} from "../../src/daemon/storage/index.js";
import {
	credentialsPath,
	DEFAULT_DEEPLAKE_API_URL,
	type DiskCredentials,
	loadDiskCredentials,
	saveDiskCredentials,
} from "../../src/daemon/runtime/auth/index.js";
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
/** The deterministic, per-run-unique recall term seeded into the stored memory. */
const RECALL_TERM = `connectparity${RUN_ID}`;

/**
 * Clone `process.env` and DELETE every `HONEYCOMB_DEEPLAKE_*` key (the AC-8 core:
 * with no env reaching the provider, the shared FILE must supply endpoint/token/org/
 * workspace). Returns a plain object the provider treats as `process.env`. The real
 * `process.env` is NEVER mutated — only the clone the provider reads is stripped.
 */
function envWithoutDeeplakeKeys(): NodeJS.ProcessEnv {
	const clone: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(clone)) {
		if (key.startsWith("HONEYCOMB_DEEPLAKE_")) delete clone[key];
	}
	return clone;
}

describe.skipIf(!HAS_TOKEN)("PRD-023 AC-8 connect-parity: env-stripped, file-only assembled-daemon store→recall (live)", () => {
	let booted: BootedTestDaemon;
	let client: DaemonClient;
	let scope: QueryScope;
	/**
	 * The file-only storage client the daemon connected with — RETAINED only so the
	 * AC-8 preflight can issue a scoped `connect()` liveness probe through the SAME
	 * file-resolved connection. Classifying that probe is how a sustained backend
	 * outage NEUTRAL-skips instead of red-ing the file-only connect proof (PRD-034a FR-4).
	 */
	let probeStorage: StorageClient;
	/** The TEMP creds dir — the seeded shared file lives here, never the real `~/.deeplake`. */
	let credDir: string;
	/** The org/workspace the seeded file carries (read back for the scope + assertions). */
	let org: string;
	let workspace: string;

	beforeAll(async () => {
		// 1. ── SEED THE SHARED FILE IN A TEMP DIR (never the real ~/.deeplake) ──────────
		// Read the token/org/workspace/endpoint from the env the orchestrator supplies, and
		// write a credentials.json via the Wave-1/2 `saveDiskCredentials(...)` into a
		// mkdtempSync temp dir, in the Hivemind disk shape. The token is read from env and
		// written to the temp file — NEVER console.log'd (D-4).
		credDir = mkdtempSync(join(tmpdir(), "honeycomb-023-creds-"));
		const token = process.env.HONEYCOMB_DEEPLAKE_TOKEN ?? "";
		org = process.env.HONEYCOMB_DEEPLAKE_ORG ?? "";
		workspace = process.env.HONEYCOMB_DEEPLAKE_WORKSPACE ?? "honeycomb_ci";
		const apiUrl = process.env.HONEYCOMB_DEEPLAKE_ENDPOINT ?? DEFAULT_DEEPLAKE_API_URL;
		const seeded: DiskCredentials = {
			token,
			orgId: org,
			orgName: org,
			userName: "ci-023-connect-parity",
			workspaceId: workspace,
			apiUrl,
			savedAt: new Date().toISOString(),
		};
		// Through the SAME write path `honeycomb login` uses (0600, Hivemind shape) — never a
		// hand-rolled write. The org is read back from the seeded record so we never echo env.
		saveDiskCredentials(seeded, credDir);

		// 2. ── BOOT THE ASSEMBLED DAEMON CONNECTING FROM THE FILE WITH ENV ABSENT ────────
		// Build the storage client whose provider is the REAL `defaultCredentialProvider`
		// (env-over-file) — but with EVERY `HONEYCOMB_DEEPLAKE_*` key DELETED from the env it
		// reads, and pointed at the temp creds dir. With the env stripped, the env arm
		// contributes nothing for the four credential fields, so the FILE supplies all of
		// `{ endpoint←apiUrl, token, org←orgId, workspace←workspaceId }`. THIS is the AC-8 core:
		// the daemon auto-connects from the shared file, not env.
		const strippedEnv = envWithoutDeeplakeKeys();
		const fileOnlyProvider = defaultCredentialProvider({ env: strippedEnv, dir: credDir });
		// Wrap to add the live-test tuning knob ONLY (a longer per-query timeout for the live
		// backend). The four credential fields are passed through UNCHANGED from the file-only
		// provider — env supplies nothing here, so the file is still the sole credential source.
		const provider: CredentialProvider = {
			read: () => ({ ...fileOnlyProvider.read(), queryTimeoutMs: 120_000 }),
		};

		// Resolve the scope the daemon will run under FROM THE FILE-ONLY config (same provider),
		// so the read-side scope matches what the daemon connected with — proving the file drove it.
		const config = resolveStorageConfig(provider);
		scope = { org: config.org, workspace: config.workspace };

		// Inject that file-only storage client into the assembled daemon (mirror how
		// data-api-assembled-live.itest.ts injects `createStorageClient({ provider })`). The
		// assembly fires the data seams; this client carries the file-resolved connection.
		// We retain the SAME file-only client for the AC-8 infra-skip preflight probe.
		probeStorage = createStorageClient({ provider });
		booted = await bootTestDaemon({ mode: "local", storage: probeStorage });

		// Drive the requests through the REAL CLI loopback client: it stamps the session-group
		// headers (runtime-path + synthetic session) for /api/memories automatically.
		const tenancyHeaders: Record<string, string> = {
			"x-honeycomb-org": scope.org,
			"x-honeycomb-workspace": scope.workspace ?? workspace,
		};
		client = createLoopbackDaemonClient({ baseUrl: booted.baseUrl, headers: tenancyHeaders });
	}, 120_000);

	afterAll(async () => {
		if (booted) await booted.stop();
		if (credDir) rmSync(credDir, { recursive: true, force: true });
	});

	it(
		"AC-8: the file-only assembled daemon (NO env) stores then recalls a memory live over HTTP",
		async ({ skip }) => {
			// INFRA-DEGRADED preflight (PRD-034a FR-4 / a-AC-3): a scoped liveness probe through
			// the SAME file-resolved storage client the daemon connected with. If the backend is
			// sustained-down (the probe flaps transient AFTER the client's retry), resolve NEUTRAL
			// via a SKIP + the run-level sentinel rather than red-ing the file-only connect proof on
			// DeepLake weather. A non-transient failure (a genuine bad/absent file-resolved
			// credential) or an ok probe continues to the strict store→recall assertions with full
			// teeth — so an AC-8 connect REGRESSION still REDs.
			await neutralizeIfInfraDegraded("connect-parity-live:preflight", () => probeStorage.connect(scope), skip);

			// ── AC-8 core: STORE through the CLI client (it stamps the session headers). ──
			// The daemon connected FROM THE SEEDED FILE (env stripped). A 201 here is the
			// file-only connect proof: with no env, the file supplied endpoint/token/org/workspace.
			const stored = await client.send({
				method: "POST",
				path: "/api/memories",
				body: { content: `the ${RECALL_TERM} subsystem proves file-only connect parity over HTTP` },
			});
			expect(stored.status, "AC-8: store landed a row via the file-connected daemon (201, not 501/400)").toBe(201);
			const storedBody = stored.body as { id: string | null; action: string };
			expect(storedBody.action, "the controlled-writes engine inserted (or deduped) a row").toMatch(
				/inserted|deduped/,
			);

			// ── AC-8 core: RECALL through the CLI client (poll-convergent — eventual consistency). ──
			// The established discipline: never a single immediate read; poll until convergence.
			let recalled = false;
			let lastStatus = 0;
			for (let poll = 0; poll < 40 && !recalled; poll++) {
				const recall = await client.send({
					method: "POST",
					path: "/api/memories/recall",
					body: { query: RECALL_TERM },
				});
				lastStatus = recall.status;
				expect(recall.status, "AC-8: recall reaches the handler over the file-connected daemon (no 400/501)").toBe(200);
				const body = recall.body as { hits: { source: string; id: string; text: string }[]; degraded: boolean };
				if (body.hits.some((h) => h.text.includes(RECALL_TERM))) recalled = true;
				if (!recalled) await new Promise((r) => setTimeout(r, 350));
			}
			expect(
				recalled,
				"AC-8: the stored memory recalls over HTTP through the daemon that connected FROM THE FILE (env stripped)",
			).toBe(true);

			// Receipt (no secret): the term + recall result + status. The token is NEVER printed.
			// eslint-disable-next-line no-console
			console.log(
				`[023 AC-8 receipt] file-only (env-stripped) store→recall: term=${RECALL_TERM} recalled=${recalled} lastStatus=${lastStatus}`,
			);
		},
		120_000,
	);

	it(
		"AC-8 shape compat: the seeded shared file is the EXACT Hivemind key set and Honeycomb round-trips it",
		() => {
			// ── AC-8 second half: cross-tool file-shape compatibility. ──
			// The file Honeycomb wrote (via saveDiskCredentials, the `honeycomb login` write path)
			// must be byte-shape-compatible with what Hivemind reads. Assert the EXACT Hivemind key
			// set is present (a superset is fine — Honeycomb may add the additive `agentId` — but the
			// load-bearing keys MUST be present + typed). We do NOT import the Hivemind repo; we assert
			// the shape contract Hivemind's loader reads.
			const onDisk = JSON.parse(readFileSync(credentialsPath(credDir), "utf8")) as Record<string, unknown>;

			// The four LOAD-BEARING keys Hivemind reads to connect — present + correctly typed.
			expect(typeof onDisk.token, "AC-8: `token` is a string (load-bearing)").toBe("string");
			expect((onDisk.token as string).length, "AC-8: `token` is non-empty").toBeGreaterThan(0);
			expect(typeof onDisk.orgId, "AC-8: `orgId` is a string (load-bearing)").toBe("string");
			expect(typeof onDisk.workspaceId, "AC-8: `workspaceId` is a string (load-bearing)").toBe("string");
			expect(typeof onDisk.apiUrl, "AC-8: `apiUrl` is a string (load-bearing)").toBe("string");

			// The full Hivemind key set `{token,orgId,orgName,userName,workspaceId,apiUrl,savedAt}` is
			// present (superset OK). Assert each Hivemind-read key exists.
			for (const key of ["token", "orgId", "orgName", "userName", "workspaceId", "apiUrl", "savedAt"]) {
				expect(Object.keys(onDisk), `AC-8: the shared file carries Hivemind's \`${key}\` key`).toContain(key);
			}
			// `savedAt` is a server-stamped ISO string (evidence, not caller input).
			expect(typeof onDisk.savedAt, "AC-8: `savedAt` is an ISO timestamp string").toBe("string");

			// ── Round-trip: Honeycomb's own loadDiskCredentials reads it back to the same values. ──
			// (Same file the daemon connected from — the read side that the storage provider uses.)
			const roundTripped = loadDiskCredentials(credDir, {});
			expect(roundTripped, "AC-8: Honeycomb reads its own shared file back (round-trip)").not.toBeNull();
			expect(roundTripped?.token, "AC-8: round-trip token matches").toBe(onDisk.token);
			expect(roundTripped?.orgId, "AC-8: round-trip orgId matches").toBe(onDisk.orgId);
			expect(roundTripped?.workspaceId, "AC-8: round-trip workspaceId matches").toBe(onDisk.workspaceId);
			expect(roundTripped?.apiUrl, "AC-8: round-trip apiUrl matches").toBe(onDisk.apiUrl);

			// Receipt (no secret): the KEY SET only — never a value (the token must not be printed).
			// eslint-disable-next-line no-console
			console.log(
				`[023 AC-8 receipt] shared-file shape OK: keys=[${Object.keys(onDisk).sort().join(",")}] (load-bearing token/orgId/workspaceId/apiUrl present, round-trip OK)`,
			);
		},
	);
});
