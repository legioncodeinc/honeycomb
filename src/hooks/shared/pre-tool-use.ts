/**
 * Pre-tool-use VFS intercept core — PRD-019b Wave 2 (FR-5 / b-AC-4).
 *
 * The pre-tool-use hook is the VFS intercept (FR-5 / b-AC-4): Bash/Read/Grep/Glob
 * calls on the memory path are resolved BY THE DAEMON —
 *   - `cat`/`Read`        → a row read
 *   - `grep`/`Glob`       → hybrid lexical-plus-semantic search
 *   - `ls`                → prefix listing
 *   - `find`              → pattern query
 * Write/Edit on a memory path is DENIED with guidance; an unmodelable command is
 * rewritten to a harmless `echo`. NOTHING reaches the real filesystem (b-AC-4).
 *
 * THIN CLIENT: this core lowers the harness's pre-tool payload into a
 * {@link VfsToolOp} and routes it through the injected {@link VfsIntercept} seam
 * (`deps.vfs`, PRD-075a a-AC-1 / a-AC-2) — it opens NO DeepLake and builds NO SQL
 * directly here (D-2). The ONLY path memory content can come from is the seam —
 * there is no `node:fs` import in this module, so a pre-tool op against the mount
 * can never touch the real filesystem. The REAL seam (constructed at `runtime.ts`'s
 * dependency-construction site) resolves against the daemon's already-mounted
 * `/memory/{cat,grep,ls,find}` browse routes (`src/daemon/runtime/vfs/api.ts`,
 * PRD-022b) over loopback — the SAME `memory`-table content the PRD-015
 * `DeepLakeFs` client's read tiers and the MCP browse trio resolve too (see
 * `runtime.ts`'s `createDaemonVfsIntercept` for the routing + the cross-boundary
 * note on why this core does not reconstruct `DeepLakeFs` + a raw-SQL
 * `DaemonDispatch` directly). `runPreToolUse`'s OWN `vfs` parameter default
 * (`createFakeVfsIntercept()`) backs ONLY an isolated unit test that supplies no
 * `deps.vfs` at all — `deps.vfs`, when present, always wins.
 *
 * The pure path classifier (`classifyPath` / `toMountRelative`) is imported from
 * `daemon-client/vfs` — it is dependency-free routing logic, NOT a storage handle.
 */

import { classifyPath } from "../../daemon-client/vfs/classify.js";
import { MEMORY_MOUNT_DISPLAY_PATH } from "../../daemon-client/vfs/index-gen.js";
import {
	createFakeVfsIntercept,
	type HookCoreDeps,
	type HookInput,
	type HookResult,
	type VfsIntercept,
	type VfsToolOp,
} from "./contracts.js";

/**
 * The decision a pre-tool intercept returns to the shim: allow the tool through
 * unchanged, replace its output with the daemon's VFS result, deny it with
 * guidance, or rewrite it to a harmless no-op. The shim renders this through its
 * harness's native pre-tool response format (019c).
 */
export type PreToolDecision =
	| { readonly kind: "allow" }
	| { readonly kind: "replace"; readonly output: string }
	| { readonly kind: "deny"; readonly guidance: string }
	| { readonly kind: "rewrite"; readonly command: string };

/**
 * The normalized pre-tool payload the shim lowers its native tool event into. `tool`
 * is the harness tool name (`Bash`/`Read`/`Grep`/`Glob`/`Write`/`Edit`); `command`
 * is the Bash command line when `tool === "Bash"` (so the core sniffs `cat`/`grep`/
 * `ls`/`find`); `path` is the file path for Read/Grep/Glob/Write/Edit; `query`
 * carries the grep/find pattern. The shim populates from its native payload; the
 * core never sees the harness's raw shape. Carried on {@link HookInput.data}.
 */
export interface PreToolPayload {
	/** The harness tool name. */
	readonly tool: string;
	/** The Bash command line (when `tool === "Bash"`). */
	readonly command?: string;
	/** The target path (Read/Grep/Glob/Write/Edit, or the path arg of a Bash command). */
	readonly path?: string;
	/** The search/pattern text (grep/find/Glob). */
	readonly query?: string;
}

/** The harmless no-op a rewrite targets when a Bash command cannot be modeled (FR-5). */
export const HARMLESS_ECHO = "echo honeycomb: command not modeled against the memory mount" as const;

/** Guidance returned when a Write/Edit targets the memory mount (FR-5). */
export const WRITE_DENY_GUIDANCE =
	"The memory mount is read-through: writes are denied. Use the goal/kpi/memory verbs (or the MCP tools) to persist; never write the mount directly." as const;

/**
 * Intercept a pre-tool-use event (FR-5 / b-AC-4). When the tool targets the memory
 * path, resolves it through the daemon's VFS and returns a `replace`/`deny`/`rewrite`
 * decision; otherwise returns `allow`. Nothing reaches the real filesystem.
 *
 * Routing:
 *   - tool NOT on the memory mount               → `allow` (pass through untouched).
 *   - Write/Edit on the mount                    → `deny` with guidance.
 *   - Read / Bash `cat` on the mount             → `replace` with the row read.
 *   - Grep / Glob / Bash `grep` on the mount     → `replace` with the hybrid search.
 *   - Bash `ls` on the mount                     → `replace` with the prefix listing.
 *   - Bash `find` on the mount                   → `replace` with the pattern query.
 *   - an unmodelable Bash command on the mount   → `rewrite` to a harmless `echo`.
 *
 * The daemon-backed VFS is read through `deps.vfs` (PRD-075a a-AC-1 / a-AC-2) — the
 * REAL runtime construction (`runtime.ts`'s `createHookRuntime`) always populates it.
 * The `vfs` PARAMETER is the fallback for an isolated unit test that constructs no
 * `deps` at all (defaults to a recording fake so such a call is inert, not a real FS
 * touch); a `deps.vfs` supplied by the caller ALWAYS wins over that fallback. The
 * result's `additionalContext`/`ok` mirror the decision so a shim that only reads
 * `HookResult` still gets the outcome.
 */
export async function runPreToolUse(
	input: HookInput,
	deps: HookCoreDeps,
	vfs: VfsIntercept = createFakeVfsIntercept(),
): Promise<{ result: HookResult; decision: PreToolDecision }> {
	// a-AC-2: resolve through the deps-carried seam (the real runtime's daemon-backed
	// intercept); the parameter default backs ONLY an isolated test that supplies no
	// `deps.vfs` at all.
	const resolvedVfs = deps.vfs ?? vfs;
	const payload = asPayload(input.data);

	// A non-memory tool (or an unparseable payload) passes through untouched.
	const targetPath = payload === undefined ? undefined : resolveTargetPath(payload);
	if (payload === undefined || targetPath === undefined || !onMemoryMount(targetPath)) {
		return { result: { ok: true }, decision: { kind: "allow" } };
	}

	const verb = lowerVerb(payload);

	// Write/Edit on the mount is denied with guidance — never buffered, never sent.
	if (verb === "write") {
		return {
			result: { ok: false, reason: "memory-write-denied" },
			decision: { kind: "deny", guidance: WRITE_DENY_GUIDANCE },
		};
	}

	// An unmodelable Bash command on the mount is rewritten to a harmless echo so it
	// runs but mutates nothing (and never reaches the real FS).
	if (verb === undefined) {
		return {
			result: { ok: true, reason: "rewritten-unmodelable" },
			decision: { kind: "rewrite", command: HARMLESS_ECHO },
		};
	}

	// read / search / list / find → resolve through the daemon VFS seam (the ONLY
	// route to memory content; nothing hits the real filesystem, b-AC-4).
	const query = resolveQuery(payload);
	const op: VfsToolOp = { verb, path: targetPath, ...(query !== undefined ? { query } : {}) };
	const output = await resolvedVfs.resolve(op);
	return { result: { ok: true, additionalContext: output }, decision: { kind: "replace", output } };
}

/** Narrow {@link HookInput.data} to a {@link PreToolPayload} (undefined when unparseable). */
function asPayload(data: unknown): PreToolPayload | undefined {
	if (data === null || typeof data !== "object") return undefined;
	const rec = data as Record<string, unknown>;
	if (typeof rec.tool !== "string") return undefined;
	return {
		tool: rec.tool,
		...(typeof rec.command === "string" ? { command: rec.command } : {}),
		...(typeof rec.path === "string" ? { path: rec.path } : {}),
		...(typeof rec.query === "string" ? { query: rec.query } : {}),
	};
}

/**
 * The path the tool targets: the explicit `path`, else (for a Bash command) the `honeycomb
 * recall`/`honeycomb search` sentinel's mount root (PRD-075c c-AC-4, so `onMemoryMount` passes
 * without the model ever naming a mount path), else the path arg sniffed from the Bash command.
 */
function resolveTargetPath(payload: PreToolPayload): string | undefined {
	if (payload.path !== undefined && payload.path !== "") return payload.path;
	if (payload.command !== undefined) {
		if (sniffHoneycombRecallSentinel(payload.command) !== undefined) return MEMORY_MOUNT_DISPLAY_PATH;
		return sniffBashPath(payload.command);
	}
	return undefined;
}

/**
 * The search/find query for a VFS op: the explicit `payload.query` field (from a harness that
 * already sniffed a pattern, e.g. `Grep`'s `pattern`) always wins; otherwise, for a Bash command,
 * fall back to the `honeycomb recall`/`honeycomb search` sentinel's quoted argument (PRD-075c
 * c-AC-4). Neither source means no query (a plain `cat`/`ls` never carries one).
 */
function resolveQuery(payload: PreToolPayload): string | undefined {
	if (payload.query !== undefined) return payload.query;
	if (payload.command !== undefined) return sniffHoneycombRecallSentinel(payload.command)?.query;
	return undefined;
}

/**
 * True when a path lands on the memory mount. `classifyPath` reduces any accepted
 * shape (mount-relative, host-absolute `~/.honeycomb/memory/...`, test mount) to its
 * class; a memory-mount path classifies to one of the mount kinds. A path that does
 * not mention the mount reduces to `memory` too (the classifier's fallback), so we
 * additionally require the path to actually reference the mount before intercepting —
 * otherwise an ordinary `cat /etc/hosts` would be wrongly captured.
 */
function onMemoryMount(path: string): boolean {
	if (!mentionsMount(path)) return false;
	// Any mount path classifies to a known mount kind; the classifier never errors.
	classifyPath(path);
	return true;
}

/**
 * True when a path references the honeycomb memory mount in any accepted shape.
 *
 * SECURITY: this predicate is the gate. A shape that slips past it reaches the REAL filesystem
 * (the read is not intercepted, and the Write/Edit deny never fires). Windows separators are
 * normalized to `/` before matching so `C:\Users\ada\.apiary\honeycomb\memory\x` cannot bypass, and
 * the two honeycomb-owned host-absolute shapes are matched case-insensitively because Windows paths
 * are case-insensitive (`.APIARY\HONEYCOMB\MEMORY` names the same real directory).
 */
function mentionsMount(path: string): boolean {
	const p = path.replace(/\\/g, "/");
	const lower = p.toLowerCase();
	return (
		p.includes("/memory/") ||
		p.startsWith("memory/") ||
		p === "memory" ||
		// PRD-072b.3 dual recognition: BOTH the new `.apiary/honeycomb/memory` and the legacy
		// `.honeycomb/memory` host-absolute shapes resolve to the mount (agents holding either keep
		// working). The `.apiary/...` shape already contains `/memory/` when it has a trailing segment;
		// these bare-prefix checks catch the no-trailing-slash mount root too.
		lower.includes(".apiary/honeycomb/memory") ||
		lower.includes(".honeycomb/memory") ||
		p.startsWith("goal/") ||
		p.startsWith("kpi/") ||
		p.startsWith("sessions/") ||
		p.startsWith("graph/") ||
		p === "index.md"
	);
}

/**
 * Lower a pre-tool payload to a {@link VfsToolOp} verb. `Write`/`Edit` → `write`
 * (denied upstream). `Read` → `read`. `Grep` → `search`. `Glob` → `search`. For
 * `Bash`, sniff the leading command word: `cat` → read, `grep`/`rg` → search,
 * `ls` → list, `find` → find. An unrecognized Bash command → `undefined` (rewrite
 * to a harmless echo).
 */
function lowerVerb(payload: PreToolPayload): VfsToolOp["verb"] | undefined {
	switch (payload.tool) {
		case "Write":
		case "Edit":
			return "write";
		case "Read":
			return "read";
		case "Grep":
		case "Glob":
			return "search";
		case "Bash":
			return lowerBashVerb(payload.command ?? "");
		default:
			// An unknown tool on the mount is treated as a non-modelable op (rewrite).
			return undefined;
	}
}

/**
 * Recognizes a `honeycomb recall "<query>"` / `honeycomb search "<query>"` Bash sentinel line
 * (PRD-075c c-AC-4/c-AC-5): the ENTIRE trimmed command must be exactly that shape (a single
 * double- or single-quoted argument), so the sentinel reads as first-class intent rather than a
 * loosely-matched substring: an unrelated `honeycomb <subcommand>` invocation is left alone
 * (falls through to the default Bash-verb switch, currently `undefined` → harmless-echo rewrite,
 * since no real `honeycomb` CLI subcommand is presently spelled `recall`/`search`).
 */
const HONEYCOMB_RECALL_SENTINEL = /^honeycomb\s+(?:recall|search)\s+(?:"([^"]*)"|'([^']*)')\s*$/;

/**
 * Extract the query from a `honeycomb recall`/`honeycomb search` Bash sentinel line, or
 * `undefined` when `command` is not that exact shape (PRD-075c c-AC-4). The intercept never
 * requires a real `honeycomb recall` CLI subcommand to exist: this is a RECOGNITION rule in the
 * pre-tool intercept, which blocks the literal shell command and returns the daemon's VFS output
 * before the real command would ever run (c-AC-5).
 */
function sniffHoneycombRecallSentinel(command: string): { readonly query: string } | undefined {
	const match = HONEYCOMB_RECALL_SENTINEL.exec(command.trim());
	if (match === null) return undefined;
	return { query: match[1] ?? match[2] ?? "" };
}

/**
 * Sniff the leading command word of a Bash line to a VFS verb (undefined when unmodelable). The
 * `honeycomb recall`/`honeycomb search` sentinel (PRD-075c c-AC-4) is checked FIRST and maps
 * straight to `search`, ahead of the raw `grep`/`rg`/`egrep` mount fallback below (which stays
 * unchanged and keeps resolving unrelated `honeycomb` invocations to the default case, c-AC-6).
 */
function lowerBashVerb(command: string): VfsToolOp["verb"] | undefined {
	if (sniffHoneycombRecallSentinel(command) !== undefined) return "search";
	const head = command.trim().split(/\s+/)[0] ?? "";
	switch (head) {
		case "cat":
		case "head":
		case "tail":
			return "read";
		case "grep":
		case "rg":
		case "egrep":
			return "search";
		case "ls":
			return "list";
		case "find":
			return "find";
		default:
			return undefined;
	}
}

/** Pull the first mount-referencing argument out of a Bash command line, if any. */
function sniffBashPath(command: string): string | undefined {
	const args = command.trim().split(/\s+/).slice(1);
	return args.find((arg) => mentionsMount(arg));
}
