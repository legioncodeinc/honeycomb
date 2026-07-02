/**
 * The OnboardingStore — the SHARED machine-local install/onboarding state at
 * `~/.deeplake/onboarding.json` (PRD-050 substrate). This is the contract
 * PRD-050a/050c/050e/050b/050d all code against, so the exported
 * {@link OnboardingState} shape and the helper signatures are STABLE — a field
 * rename here is a cross-PRD break, not a local edit.
 *
 * ── Why this lives beside credentials (and mirrors credentials-store.ts) ─────
 * The onboarding file shares the SAME home dir as the shared credentials file
 * (`~/.deeplake`, {@link CREDENTIALS_DIR_NAME}). It deliberately mirrors
 * `credentials-store.ts`'s established idioms:
 *   - `~` is resolved via {@link homedir}; the dir is overridable (`dir?`) so
 *     tests run against a temp HOME and NEVER touch the real `~/.deeplake`;
 *   - the file is written ATOMICALLY (temp file + `renameSync`, so a reader
 *     never sees a partial write) at mode `0600`, with the dir created at `0700`
 *     if absent (matching {@link FILE_MODE} / {@link DIR_MODE});
 *   - a MISSING or MALFORMED file is FAIL-SOFT — but unlike `loadCredentials`
 *     (which returns `null`), {@link loadOnboarding} returns a fully-defaulted
 *     fresh-install {@link OnboardingState}, because onboarding always has a
 *     well-defined "fresh" starting point.
 *
 * ── This file carries NO secret ─────────────────────────────────────────────
 * Onboarding state is install/telemetry bookkeeping — the `installId`, the
 * referral code, the tiered-consent flag, and the dedupe/sent telemetry ledger.
 * It holds NO bearer token, NO API key, NO PII. The `0600` perms are belt-and-
 * suspenders (the `installId` is an anonymized telemetry id we'd rather not leak
 * to other local users), not because the file is a secret at rest.
 *
 * ── The boundary is zod-validated ───────────────────────────────────────────
 * The on-disk JSON is untrusted external input, so the parsed object is validated
 * with a zod (^4) schema ({@link OnboardingStateSchema}) before it is trusted. Any
 * validation failure (or a parse failure) fails soft to {@link freshOnboardingState}
 * — a partially-valid file is never honored.
 *
 * ── Windows note (perms are best-effort off POSIX) ──────────────────────────
 * `fs.chmod` / the `mode` option are a no-op on win32 (NTFS ACLs, not POSIX bits),
 * exactly as `credentials-store.ts` documents. We still PASS the mode on write
 * (correct + free on POSIX); the perm-assert test guards on `process.platform`.
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { CREDENTIALS_DIR_NAME, DIR_MODE, FILE_MODE } from "../auth/credentials-store.js";

/** The onboarding state file name within the shared `~/.deeplake` dir. */
export const ONBOARDING_FILE_NAME = "onboarding.json";

/**
 * The current on-disk schema version. A bump here is the migration seam: a file
 * with a different (or missing) `schemaVersion` fails zod validation and falls
 * soft to a fresh-install default, so an old/foreign file is never half-read.
 */
export const ONBOARDING_SCHEMA_VERSION = 1 as const;

/**
 * The build-time referral default. PRD-001b-style esbuild `define` replaces
 * `__HONEYCOMB_REF_DEFAULT__` with a string literal at bundle time; this fallback
 * is what the un-bundled `dist/` reports before that replacement runs (mirroring
 * the {@link HONEYCOMB_VERSION} seam in `src/shared/constants.ts`).
 */
export const DEFAULT_REF: string =
	typeof __HONEYCOMB_REF_DEFAULT__ === "string" ? __HONEYCOMB_REF_DEFAULT__ : "mario";

// ────────────────────────────────────────────────────────────────────────────
// The exported contract — DO NOT rename fields (downstream PRDs code against it).
// ────────────────────────────────────────────────────────────────────────────

/**
 * The closed set of named lifecycle telemetry events. Each is reported AT MOST ONCE per
 * machine (the {@link OnboardingState.telemetry} `reported` ledger dedupes them) - except
 * `honeycomb_updated`, whose dedupe is per event+version: the emitter records the qualified
 * key `honeycomb_updated@<version>` in the ledger while sending the plain event name, so a
 * NEW version re-fires but the SAME version never double-sends.
 */
export type TelemetryEventName =
	| "honeycomb_installed"
	| "honeycomb_first_link"
	| "honeycomb_hivemind_upgrade"
	| "honeycomb_updated"
	| "honeycomb_uninstalled";

/**
 * One glass-box record of a telemetry event that was ACTUALLY sent — the
 * append-only audit log a user can inspect to see exactly what left the machine.
 */
export interface TelemetrySentRecord {
	/** The event that was sent. */
	event: TelemetryEventName;
	/** ISO-8601 timestamp the event was sent. */
	at: string;
	/** The exact property bag that was sent (glass-box; never a secret). */
	properties: Record<string, unknown>;
}

/**
 * The machine-local onboarding/install state persisted at `~/.deeplake/onboarding.json`.
 * This is the SUBSTRATE contract for PRD-050a/050c/050e/050b/050d — the field names
 * are load-bearing across those PRDs and must not be renamed.
 */
export interface OnboardingState {
	/** On-disk schema version (always {@link ONBOARDING_SCHEMA_VERSION}). */
	schemaVersion: 1;
	/** Random UUID v4, generated once, stable per machine — the anonymized telemetry distinct_id. */
	installId: string;
	/** The install/onboarding lifecycle phase. */
	phase: "fresh" | "installed" | "linking" | "linked" | "migrating" | "migrated";
	/** True once the first-time guided setup has completed. */
	firstTimeSetupComplete: boolean;
	/** The effective referral code (defaults to the build-time {@link DEFAULT_REF}). */
	ref: string;
	/**
	 * The last Honeycomb build version this machine observed at a lifecycle checkpoint
	 * (the `honeycomb_updated` detection baseline). ABSENT on a fresh install and on any
	 * state file written before this field existed - the first observation records the
	 * baseline WITHOUT emitting (a first sighting is not an update).
	 */
	lastVersion?: string;
	/** Detection of a prior Hivemind install (drives the migration path). */
	priorTool: { hivemind: "absent" | "present" | "migrated" };
	/** Telemetry consent + the dedupe ledger + the glass-box sent log. */
	telemetry: {
		/** Tiered consent: Tier-2 usage events are sent ONLY when this is true. */
		optInTier2: boolean;
		/**
		 * Dedupe ledger: ledger key → ISO timestamp it was reported (sent at most once per key).
		 * The key is USUALLY the plain event name; a version-qualified event records a qualified
		 * key instead (e.g. `honeycomb_updated@1.2.3`), so dedupe is per event+version there.
		 */
		reported: Partial<Record<string, string>>;
		/** Append-only glass-box log of what was actually sent. */
		sent: TelemetrySentRecord[];
	};
	/** Present only while a Hivemind→Honeycomb migration is in flight. */
	migration?: {
		/** The migration sub-phase. */
		phase: "backup" | "uninstall" | "link" | "done" | "rolled_back";
		/** ISO-8601 timestamp the migration started. */
		startedAt: string;
		/** Where the pre-migration backup was written (when taken). */
		backupPath?: string;
	};
}

// ────────────────────────────────────────────────────────────────────────────
// The zod boundary schema — validates the untrusted on-disk JSON.
// ────────────────────────────────────────────────────────────────────────────

/** The closed telemetry-event enum, mirrored as a zod enum for boundary validation. */
const TelemetryEventNameSchema = z.enum([
	"honeycomb_installed",
	"honeycomb_first_link",
	"honeycomb_hivemind_upgrade",
	"honeycomb_updated",
	"honeycomb_uninstalled",
]);

/** One {@link TelemetrySentRecord}, validated. */
const TelemetrySentRecordSchema = z.object({
	event: TelemetryEventNameSchema,
	at: z.string(),
	properties: z.record(z.string(), z.unknown()),
});

/**
 * The full {@link OnboardingState} validator. `schemaVersion` is pinned to the
 * literal {@link ONBOARDING_SCHEMA_VERSION}, so a foreign/old file fails validation
 * and falls soft to a fresh default rather than being partially trusted.
 */
export const OnboardingStateSchema = z.object({
	schemaVersion: z.literal(ONBOARDING_SCHEMA_VERSION),
	// The installId is minted by `randomUUID()` and is the anonymized telemetry `distinct_id`. Validate
	// the on-disk value as a UUID (not merely non-empty) so a tampered `onboarding.json` cannot inject an
	// arbitrary distinct_id — a non-UUID value fails validation and falls soft to a fresh installId.
	installId: z.uuid(),
	phase: z.enum(["fresh", "installed", "linking", "linked", "migrating", "migrated"]),
	firstTimeSetupComplete: z.boolean(),
	ref: z.string(),
	// Optional: absent on a fresh install and on pre-existing files (fail-soft compatibility).
	lastVersion: z.string().optional(),
	priorTool: z.object({
		hivemind: z.enum(["absent", "present", "migrated"]),
	}),
	telemetry: z.object({
		optInTier2: z.boolean(),
		// `reported` is a PARTIAL ledger keyed by LEDGER KEY (usually the event name, but a
		// version-qualified key like `honeycomb_updated@1.2.3` is valid too), so the schema is a
		// plain string→string record rather than an enum-keyed one. Only keys that have fired
		// are present; an empty ledger is the common fresh-install shape.
		reported: z.record(z.string(), z.string()),
		sent: z.array(TelemetrySentRecordSchema),
	}),
	migration: z
		.object({
			phase: z.enum(["backup", "uninstall", "link", "done", "rolled_back"]),
			startedAt: z.string(),
			backupPath: z.string().optional(),
		})
		.optional(),
});

// ────────────────────────────────────────────────────────────────────────────
// Path resolution (mirrors credentials-store's `dir?` injection for testability).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Resolve the shared onboarding directory (`~/.deeplake`), honoring an explicit
 * override for tests. When `dir` is given it is treated as the onboarding dir
 * directly (the test's temp HOME-equivalent), so a test points the lookup at a
 * temp dir and never touches the real `~/.deeplake` — exactly as
 * {@link credentialsDir} does.
 */
export function onboardingDir(dir?: string): string {
	return dir ?? join(homedir(), CREDENTIALS_DIR_NAME);
}

/** Resolve the full onboarding file path within the (possibly overridden) dir. */
export function onboardingPath(dir?: string): string {
	return join(onboardingDir(dir), ONBOARDING_FILE_NAME);
}

// ────────────────────────────────────────────────────────────────────────────
// Defaults — a fresh install.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Build a fully-defaulted fresh-install {@link OnboardingState}: phase `"fresh"`,
 * setup incomplete, a NEW random {@link randomUUID} `installId`, `ref` defaulted to
 * {@link DEFAULT_REF}, no prior Hivemind, Tier-2 telemetry OFF, and empty
 * dedupe/sent ledgers. This is what {@link loadOnboarding} returns on a missing or
 * malformed file. Each call mints a FRESH `installId` — callers persist it (via
 * {@link getOrCreateInstallId} + {@link saveOnboarding}) to make it stable.
 */
export function freshOnboardingState(): OnboardingState {
	return {
		schemaVersion: ONBOARDING_SCHEMA_VERSION,
		installId: randomUUID(),
		phase: "fresh",
		firstTimeSetupComplete: false,
		ref: DEFAULT_REF,
		priorTool: { hivemind: "absent" },
		telemetry: {
			optInTier2: false,
			reported: {},
			sent: [],
		},
	};
}

// ────────────────────────────────────────────────────────────────────────────
// Load / save (fail-soft read, atomic 0600 write).
// ────────────────────────────────────────────────────────────────────────────

/**
 * Load the persisted {@link OnboardingState} from `~/.deeplake/onboarding.json`,
 * FAILING SOFT to a fresh-install default ({@link freshOnboardingState}) on a
 * missing OR malformed file — it NEVER throws.
 *
 * "Malformed" covers an unreadable file, invalid JSON, and a parsed object that
 * fails the {@link OnboardingStateSchema} zod check at the boundary (e.g. a foreign
 * `schemaVersion`, a missing field, a wrong type). A partially-valid file is never
 * honored — the whole object falls soft to defaults.
 *
 * `dir` overrides the directory (tests pass a temp dir); it defaults to the real
 * `~/.deeplake`.
 */
export function loadOnboarding(dir?: string): OnboardingState {
	const path = onboardingPath(dir);
	if (!existsSync(path)) return freshOnboardingState();
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		// An unreadable file is treated as a fresh install, never a hard error.
		return freshOnboardingState();
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		// Malformed JSON → fresh-install defaults (fail soft, no throw).
		return freshOnboardingState();
	}
	const result = OnboardingStateSchema.safeParse(parsed);
	if (!result.success) {
		// The boundary rejected the shape → fall soft rather than trust a partial file.
		return freshOnboardingState();
	}
	return result.data;
}

/**
 * Persist the {@link OnboardingState} to `~/.deeplake/onboarding.json` ATOMICALLY
 * (temp file + `renameSync`, so a concurrent reader never sees a partial write) at
 * mode `0600`, creating the dir at `0700` if absent. Mirrors the perm + atomic-write
 * discipline of `credentials-store.ts` / `assets/registry.ts`.
 *
 * This file carries NO secret — never store a token or key here. On POSIX the
 * `0600` is authoritative for a freshly-created file; on win32 the mode bit is a
 * documented best-effort no-op (NTFS ACLs).
 *
 * Returns the state it persisted (unchanged) so a caller can chain without re-reading.
 */
export function saveOnboarding(state: OnboardingState, dir?: string): OnboardingState {
	const targetDir = onboardingDir(dir);
	if (!existsSync(targetDir)) {
		mkdirSync(targetDir, { recursive: true, mode: DIR_MODE });
	}
	const path = onboardingPath(dir);
	// Atomic write: serialize to a sibling temp file at 0600, then rename over the
	// target. rename(2) is atomic on the same filesystem, so a reader never sees a
	// partial file. The mode option sets perms only when the temp file is CREATED.
	const tmp = `${path}.tmp-${process.pid}`;
	writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: FILE_MODE });
	renameSync(tmp, path);
	return state;
}

// ────────────────────────────────────────────────────────────────────────────
// Pure helpers — downstream PRDs compose these. Each returns an UPDATED COPY of
// the state (no in-place mutation) so a caller can decide when to persist.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Return `[installId, state]` for the state's install id, minting + folding in a
 * fresh {@link randomUUID} when the state has none. PURE: it never mutates `state`
 * — on a miss it returns a NEW state object carrying the new id, which the caller
 * persists via {@link saveOnboarding} to make the id stable across loads. On a hit
 * the returned state is the same object (no copy needed).
 */
export function getOrCreateInstallId(state: OnboardingState): [string, OnboardingState] {
	if (state.installId.length > 0) return [state.installId, state];
	const installId = randomUUID();
	return [installId, { ...state, installId }];
}

/**
 * Return a COPY of `state` with the ledger key recorded in the telemetry dedupe ledger at
 * `isoTimestamp`. PURE: `state` is not mutated. The key is usually the plain
 * {@link TelemetryEventName}; a version-qualified key (e.g. `honeycomb_updated@1.2.3`)
 * dedupes per event+version instead. Downstream uses this to mark an event reported so
 * {@link isReported} suppresses a re-send.
 */
export function markReported(state: OnboardingState, ledgerKey: string, isoTimestamp: string): OnboardingState {
	return {
		...state,
		telemetry: {
			...state.telemetry,
			reported: { ...state.telemetry.reported, [ledgerKey]: isoTimestamp },
		},
	};
}

/**
 * True when the ledger key has already been recorded in the telemetry dedupe ledger: the
 * guard a sender checks to send each event AT MOST ONCE per key (per machine for a plain
 * event-name key; per machine+version for a qualified key). PURE.
 */
export function isReported(state: OnboardingState, ledgerKey: string): boolean {
	return state.telemetry.reported[ledgerKey] !== undefined;
}

/**
 * Return a COPY of `state` with `record` APPENDED to the glass-box `sent` log
 * (preserving order — appended last). PURE — `state` is not mutated. This is the
 * audit trail of what actually left the machine.
 */
export function appendSent(state: OnboardingState, record: TelemetrySentRecord): OnboardingState {
	return {
		...state,
		telemetry: {
			...state.telemetry,
			sent: [...state.telemetry.sent, record],
		},
	};
}
