/**
 * PROPERTY / FUZZ tests — the untrusted-JSON parsers that coerce on-disk files into safe
 * in-memory shapes:
 *
 *   - `normalizeEntry`  (private) via `createPullManifestStore(dir).read()` — the pull manifest
 *     (`pull-manifest.json`), an attacker-rewritable on-disk file that drives `unpull`'s `rmSync`
 *     and `backfill`'s symlink fan-out (`src/daemon-client/skillify/manifest.ts`).
 *   - `normalizeConfig` / `coerceScope` / `parseUsersList` — the skillify scope config
 *     (`config.json`) read path (`src/daemon-client/skillify/config.ts`).
 *   - `parseStateData` (private) via `createNotificationsState({ fs })` — the notifications state
 *     file (`notifications-state.json`) (`src/notifications/state.ts`).
 *
 * The invariant proved over ANY JSON value (`fc.jsonValue()`) + hostile shapes (arrays where
 * objects are expected, `__proto__` / prototype-pollution keys, deep nesting, wrong types,
 * traversal strings in path-ish fields): each parser NEVER throws, ALWAYS coerces to a typed safe
 * default, and NEVER lets a hostile value silently widen privilege or pollute the global
 * prototype. (Filesystem CONTAINMENT for a hostile manifest `dirName` is enforced downstream by
 * `resolveContainedCanonicalDir` at USE time — see `path-sanitization.property.test.ts` for the
 * segment floor; here we prove the PARSE stage is itself total + non-pollluting.)
 *
 * Seeded + anchored with the hostile JSON shapes.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { createPullManifestStore } from "../../src/daemon-client/skillify/manifest.js";
import { coerceScope, normalizeConfig, parseUsersList } from "../../src/daemon-client/skillify/config.js";
import { STATE_FILE_NAME, createInMemoryStateFs, createNotificationsState } from "../../src/notifications/index.js";

const NUM_RUNS = 1000;
const SEED = 0x504a_b33f;
const DISK_PROPERTY_TIMEOUT_MS = 15_000;

/** Any JSON value, plus targeted hostile shapes. `fc.jsonValue()` covers arrays/objects/scalars/null. */
const anyJsonValue = fc.jsonValue();

/** Hostile object shapes: prototype-pollution keys, wrong-typed fields, traversal path strings. */
const hostileObject = fc.oneof(
	fc.constant({ __proto__: { role: "admin", polluted: true } }),
	fc.constant({ constructor: { prototype: { polluted: true } } }),
	fc.constant({ dirName: "../../../etc/passwd", installRoot: "/", symlinks: ["/etc/cron.d/x"] }),
	fc.constant({ dirName: "..", install: "global", installRoot: "/", symlinks: "not-an-array" }),
	fc.constant({ scope: "org", team: ["a", "a", "", 42, null], install: "global" }),
	fc.constant({ scope: { evil: true }, team: "not-an-array", install: 999 }),
	fc.constant({ seen: "not-an-object" }),
	fc.constant({ seen: [1, 2, 3] }),
	fc.constant({ seen: null }),
	fc.dictionary(fc.string(), fc.jsonValue()),
);

/** A JSON string of any value or hostile object — what an attacker could leave on disk. */
const hostileJsonText = fc.oneof(anyJsonValue, hostileObject).map((v) => JSON.stringify(v) ?? "null");

/** Plus genuinely broken (non-JSON) file text — the parser must treat it as "absent". */
const anyFileText = fc.oneof(hostileJsonText, fc.string(), fc.string({ unit: "binary" }), fc.constant("\0\0"));

function assertProtoClean(): void {
	expect((Object.prototype as Record<string, unknown>).role).toBeUndefined();
	expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined();
	expect(({} as Record<string, unknown>).role).toBeUndefined();
	expect(({} as Record<string, unknown>).polluted).toBeUndefined();
}

// ─────────────────────────────────────────────────────────────────────────────
// manifest.ts — normalizeEntry via createPullManifestStore(dir).read()
// ─────────────────────────────────────────────────────────────────────────────

describe("property: pull manifest read() — NEVER throws, always returns a safe entry array", () => {
	it("any on-disk manifest text yields a well-typed PullManifestEntry[] (or [] on garbage)", () => {
		const baseDir = mkdtempSync(join(tmpdir(), "hc-prop-manifest-"));
		const filePath = join(baseDir, "pull-manifest.json");
		const store = createPullManifestStore(baseDir);
		try {
			fc.assert(
				fc.property(anyFileText, (text) => {
					writeFileSync(filePath, text, "utf-8");
					const entries = store.read(); // MUST NOT throw, for ANY file content.
					expect(Array.isArray(entries)).toBe(true);
					for (const e of entries) {
						// Every surviving entry is fully coerced to the safe typed shape — no undefined,
						// no wrong types, no NaN version, install constrained to the closed set.
						expect(typeof e.dirName).toBe("string");
						expect(e.dirName.length).toBeGreaterThan(0); // dirName==="" entries are dropped.
						expect(typeof e.name).toBe("string");
						expect(typeof e.author).toBe("string");
						expect(typeof e.projectKey).toBe("string");
						expect(typeof e.remoteVersion).toBe("number");
						expect(Number.isFinite(e.remoteVersion)).toBe(true);
						expect(e.install === "global" || e.install === "project").toBe(true);
						expect(typeof e.installRoot).toBe("string");
						expect(typeof e.pulledAt).toBe("string");
						expect(Array.isArray(e.symlinks)).toBe(true);
						expect(e.symlinks.every((s) => typeof s === "string")).toBe(true);
					}
					assertProtoClean();
				}),
				{ numRuns: NUM_RUNS, seed: SEED },
			);
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	}, DISK_PROPERTY_TIMEOUT_MS);

	it("a manifest entry with a traversal dirName survives only as a STRING, never executed here", () => {
		// The PARSE stage keeps `dirName` verbatim (containment is enforced at USE time by
		// resolveContainedCanonicalDir). Prove the parse never throws on a traversal dirName and
		// never coerces it into an array index / number / prototype write.
		const baseDir = mkdtempSync(join(tmpdir(), "hc-prop-manifest2-"));
		const filePath = join(baseDir, "pull-manifest.json");
		const store = createPullManifestStore(baseDir);
		const traversalDir = fc.constantFrom("../../../etc", "..", ".", "a/../b", "..\\..\\win", "/abs/path");
		try {
			fc.assert(
				fc.property(traversalDir, (dirName) => {
					writeFileSync(
						filePath,
						JSON.stringify([{ dirName, install: "global", installRoot: "/", symlinks: [] }]),
						"utf-8",
					);
					const entries = store.read();
					expect(Array.isArray(entries)).toBe(true);
					// It is kept as an inert string (or dropped if empty) — never crashes the read.
					for (const e of entries) expect(typeof e.dirName).toBe("string");
					assertProtoClean();
				}),
				{ numRuns: NUM_RUNS, seed: SEED },
			);
		} finally {
			rmSync(baseDir, { recursive: true, force: true });
		}
	}, DISK_PROPERTY_TIMEOUT_MS);
});

// ─────────────────────────────────────────────────────────────────────────────
// config.ts — normalizeConfig / coerceScope / parseUsersList
// ─────────────────────────────────────────────────────────────────────────────

describe("property: skillify config — normalizeConfig coerces ANY raw shape to a valid config", () => {
	it("scope ∈ {me,team}, team is a deduped string[], install ∈ {project,global}; never throws", () => {
		fc.assert(
			fc.property(anyJsonValue, (raw) => {
				// normalizeConfig takes a Pick<scope|team|install>; pass arbitrary JSON as that shape.
				const r = (typeof raw === "object" && raw !== null ? raw : {}) as {
					scope?: unknown;
					team?: unknown;
					install?: unknown;
				};
				const cfg = normalizeConfig(r);
				expect(cfg.scope === "me" || cfg.scope === "team").toBe(true);
				expect(cfg.install === "project" || cfg.install === "global").toBe(true);
				expect(Array.isArray(cfg.team)).toBe(true);
				expect(cfg.team.every((t) => typeof t === "string" && t.length > 0)).toBe(true);
				// Deduped: no value appears twice.
				expect(new Set(cfg.team).size).toBe(cfg.team.length);
				assertProtoClean();
			}),
			{ numRuns: NUM_RUNS, seed: SEED, examples: [[{ scope: "org", team: ["a", "a", 1, ""], install: "x" }]] },
		);
	});

	it("coerceScope maps the retired `org` to `team`, everything else to `me`, never throws", () => {
		fc.assert(
			fc.property(anyJsonValue, (raw) => {
				const scope = coerceScope(raw);
				expect(scope === "me" || scope === "team").toBe(true);
				// The only inputs that may yield "team" are the literals "team" / "org".
				if (scope === "team") expect(raw === "team" || raw === "org").toBe(true);
			}),
			{ numRuns: NUM_RUNS, seed: SEED, examples: [["org"], ["team"], ["admin"], [{}], [null], [42]] },
		);
	});

	it("parseUsersList always returns a deduped non-empty-string list, for any string", () => {
		fc.assert(
			fc.property(fc.oneof(fc.string(), fc.string({ unit: "binary" })), (value) => {
				const users = parseUsersList(value);
				expect(Array.isArray(users)).toBe(true);
				expect(users.every((u) => typeof u === "string" && u.length > 0 && u.trim() === u)).toBe(true);
				expect(new Set(users).size).toBe(users.length);
			}),
			{ numRuns: NUM_RUNS, seed: SEED, examples: [["alice, bob,,alice"], [",,,"], ["  a  ,  a  "]] },
		);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// state.ts — parseStateData via createNotificationsState({ fs })
// ─────────────────────────────────────────────────────────────────────────────

describe("property: notifications state load() — NEVER throws, always {seen: object}", () => {
	const DIR = "/hc-prop-state";
	const FILE = join(DIR, STATE_FILE_NAME);

	it("any on-disk state text yields { seen: <object> } (empty on garbage); never throws", () => {
		fc.assert(
			fc.property(anyFileText, (text) => {
				const fs = createInMemoryStateFs({ [FILE]: text });
				const state = createNotificationsState({ dir: DIR, fs });
				const data = state.load(); // MUST NOT throw for ANY file content.
				expect(typeof data.seen).toBe("object");
				expect(data.seen).not.toBeNull();
				// wasShown also never throws on a hostile dedup key.
				expect(typeof state.wasShown("any-key")).toBe("boolean");
				assertProtoClean();
			}),
			{ numRuns: NUM_RUNS, seed: SEED },
		);
	});

	it("a `seen` of any wrong type stays a usable, non-null, non-throwing, non-polluting map", () => {
		// SECURITY FLOOR (the property that actually matters): whatever `seen` is on disk, the
		// state seam must (a) never throw, (b) hand back a non-null object, (c) let `wasShown` /
		// `markShown` run without throwing, and (d) never pollute the prototype. We drive the REAL
		// consumers, not just `load()`, so the floor is proven end-to-end.
		//
		// KNOWN BENIGN NUANCE (reported, NOT asserted as collapse): `parseStateData` uses
		// `typeof seen !== "object"` to reject, and `typeof [] === "object"`, so a JSON ARRAY `seen`
		// (e.g. `{"seen":[1,2]}`) is accepted verbatim rather than collapsing to `{}`. Impact is
		// benign — `wasShown` via `hasOwnProperty` and `markShown` via object-spread both handle an
		// array without throwing or polluting (spread re-materializes it as a plain object on write).
		// So this is a robustness footnote, not a security escape; the floor below still holds.
		const badSeen = fc.constantFrom(
			'{"seen":[1,2]}',
			'{"seen":null}',
			'{"seen":"x"}',
			'{"seen":42}',
			'{"seen":{"__proto__":{"polluted":true}}}',
			"[]",
			"null",
			"42",
		);
		fc.assert(
			fc.property(badSeen, (text) => {
				const fs = createInMemoryStateFs({ [FILE]: text });
				const state = createNotificationsState({ dir: DIR, fs });
				const data = state.load();
				expect(typeof data.seen).toBe("object");
				expect(data.seen).not.toBeNull();
				// The real read consumer never throws on a hostile dedup key.
				expect(typeof state.wasShown("dk")).toBe("boolean");
				expect(typeof state.wasShown("0")).toBe("boolean");
				// The real write consumer never throws and re-materializes a plain-object map.
				state.markShown({ id: "i", dedupKey: "dk", shownAt: "t" });
				const after = state.load();
				expect(after.seen).not.toBeNull();
				expect(Array.isArray(after.seen)).toBe(false); // markShown always writes a plain object.
				expect(Object.prototype.hasOwnProperty.call(after.seen, "dk")).toBe(true);
				assertProtoClean();
			}),
			{ numRuns: NUM_RUNS, seed: SEED },
		);
	});
});
