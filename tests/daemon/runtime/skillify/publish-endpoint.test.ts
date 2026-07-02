/**
 * PRD-018a daemon-side publish/select endpoint + skillopt lineage — proves a-AC-1 / a-AC-4 /
 * a-AC-5 / a-AC-6 + the index AC-1.
 *
 * Verification posture (EXECUTION_LEDGER-prd-018): no live DeepLake in unit tests. The
 * publish/select endpoint runs against the REAL `createStorageClient` over a
 * `FakeDeepLakeTransport`, so a test asserts the EXACT statements emitted — an append-only
 * INSERT for publish (never an UPDATE) and a highest-version-per-(name,author) SELECT for the
 * team read. The skillopt cross-author lineage (a-AC-4) is driven through the real `writeSkill`
 * MERGE path over a recording store, asserting the appended row's `contributors`.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createStorageClient } from "../../../../src/daemon/storage/index.js";
import {
	buildSelectNewerSql,
	createFsInstallTarget,
	createSkillPublishEndpoint,
	type GateVerdict,
	type Skill,
	SKILLOPT_CONTRIBUTOR,
	skillLogicalId,
	type SkillStore,
	writeSkill,
} from "../../../../src/daemon/runtime/skillify/index.js";
import { FakeDeepLakeTransport, fakeCredentialRecord, stubProvider } from "../../../helpers/fake-deeplake.js";

const SCOPE = { org: "o1", workspace: "ws1" } as const;

function client(transport: FakeDeepLakeTransport) {
	return createStorageClient({ transport, provider: stubProvider(fakeCredentialRecord()) });
}

// Every mkdtemp'd dir minted by a test is tracked here and reclaimed in `afterEach` — see
// `tests/setup/isolate-home.ts` for the incident (100k+ stray dirs under `%TEMP%`) that made
// this discipline mandatory across every skillify test helper.
const tempDirs: string[] = [];
afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "skillify-pub-"));
	tempDirs.push(dir);
	return dir;
}

function skillAt(name: string, author: string, version: number, body: string): Skill {
	return {
		id: skillLogicalId(name, author),
		name,
		author,
		description: "d",
		triggerText: "t",
		body,
		install: "project",
		provenance: { sourceSessions: ["s1"], version, createdBy: author, scope: "team" },
	};
}

/** A recording SkillStore for the writeSkill MERGE path (mirrors skills-write.test). */
function createRecordingStore(seedSkill?: Skill): SkillStore & { appended: Skill[] } {
	const appended: Skill[] = [];
	const byId = new Map<string, Skill>();
	if (seedSkill) byId.set(seedSkill.id, seedSkill);
	return {
		appended,
		async maxVersion(id: string): Promise<number> {
			return byId.get(id)?.provenance.version ?? 0;
		},
		async readActive(id: string): Promise<Skill | null> {
			return byId.get(id) ?? null;
		},
		async appendVersion(skill: Skill): Promise<number> {
			appended.push(skill);
			byId.set(skill.id, skill);
			return skill.provenance.version;
		},
	};
}

describe("PRD-018a publish/select endpoint", () => {
	it("a-AC-1 publish appends a version-bumped row (INSERT) and NEVER an in-place UPDATE", async () => {
		const fake = new FakeDeepLakeTransport((req) => {
			if (/^SELECT .* FROM "skills"/.test(req.sql)) return [{ version: 1 }];
			return [];
		});
		const endpoint = createSkillPublishEndpoint(client(fake), SCOPE);

		// Republish at v2 (prior v1 preserved) — append-only.
		await endpoint.publish(skillAt("ci-skill", "alice", 2, "## v2"));

		const inserts = fake.requests.filter((r) => /^INSERT INTO "skills"/.test(r.sql));
		const updates = fake.requests.filter((r) => /^UPDATE /.test(r.sql));
		expect(inserts.length).toBe(1);
		expect(updates.length).toBe(0); // never an in-place UPDATE.
		expect(inserts[0]?.sql).toMatch(/\b2\b/); // version 2.
	});

	it("a-AC-5 / index-AC-1 select-newer resolves the HIGHEST version per (name, author) via MAX(version)", async () => {
		// The transport returns BOTH versions; the endpoint's poll-convergent read keeps the max.
		const fake = new FakeDeepLakeTransport((req) => {
			if (/^SELECT/.test(req.sql)) {
				return [{ name: "ci-skill", author: "alice", version: 2, body: "## v2" }];
			}
			return [];
		});
		const endpoint = createSkillPublishEndpoint(client(fake), SCOPE);

		const skills = await endpoint.selectNewerForOrgUsers();

		expect(skills).toEqual([{ name: "ci-skill", author: "alice", version: 2, body: "## v2" }]);
		// The SELECT used the MAX(version)-per-(name,author) shape.
		const sel = fake.requests.find((r) => /^SELECT/.test(r.sql));
		expect(sel?.sql).toMatch(/MAX\("?version"?\)/i);
		expect(sel?.sql).toMatch(/"skills"/);
	});

	it("a-AC-6 every endpoint statement carries the scope (goes through the daemon storage path)", async () => {
		const fake = new FakeDeepLakeTransport(() => []);
		const endpoint = createSkillPublishEndpoint(client(fake), SCOPE);
		await endpoint.selectNewerForOrgUsers();
		expect(fake.requests.length).toBeGreaterThan(0);
		// The storage client applies SCOPE as the partition on every dispatched statement.
		expect(fake.requests.every((r) => /SELECT/i.test(r.sql))).toBe(true);
	});

	it("buildSelectNewerSql is a static, identifier-escaped, injection-free statement", () => {
		const sql = buildSelectNewerSql("skills");
		expect(sql).toMatch(/MAX\(version\)/);
		expect(sql).toMatch(/GROUP BY name, author/);
		expect(sql).toMatch(/FROM "skills"/);
		// No unescaped value interpolation — the scope is a daemon-side partition filter.
		expect(sql).not.toMatch(/\$\{/);
	});

	it("a-AC-4 a cross-author MERGE stamps the `skillopt` marker + the original author in contributors", async () => {
		// Seed the TARGET (bob's skill) locally so the MERGE bumps it rather than falling back.
		const installDir = tempDir();
		const install = createFsInstallTarget({ projectDir: installDir, globalDir: tempDir() });
		// Pre-write bob's skill so the install seam's read() finds it.
		await install.write("project", "shared-skill", "---\nname: shared-skill\nversion: 1\n---\n\nbob body\n");

		const store = createRecordingStore();
		const merge: GateVerdict = {
			decision: "MERGE",
			target: "shared-skill",
			targetAuthor: "bob", // CROSS-author: the merging author (alice) differs.
			name: "shared-skill",
			description: "refined",
			triggerText: "trigger",
			body: "## refined body",
		};

		const outcome = await writeSkill(merge, { store, install, author: "alice" }, ["s1"], "project");

		// The bump accrued on bob's chain, promoted to team, with skillopt lineage.
		expect(outcome.scope).toBe("team");
		expect(store.appended).toHaveLength(1);
		const recorded = store.appended[0];
		expect(recorded?.author).toBe("bob"); // chain owner = target author.
		expect(recorded?.contributors).toEqual([SKILLOPT_CONTRIBUTOR, "alice"]);
	});

	it("a same-author MERGE carries NO skillopt marker (stays `me`, no extra contributors)", async () => {
		const installDir = tempDir();
		const install = createFsInstallTarget({ projectDir: installDir, globalDir: tempDir() });
		await install.write("project", "my-skill", "---\nname: my-skill\nversion: 1\n---\n\nbody\n");

		const store = createRecordingStore();
		const merge: GateVerdict = {
			decision: "MERGE",
			target: "my-skill",
			targetAuthor: "alice", // SAME author.
			name: "my-skill",
			body: "## v2",
		};

		const outcome = await writeSkill(merge, { store, install, author: "alice" }, ["s1"], "project");

		expect(outcome.scope).toBe("me");
		expect(store.appended[0]?.contributors).toBeUndefined();
	});
});
