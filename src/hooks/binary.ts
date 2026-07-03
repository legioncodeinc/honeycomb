/**
 * The shared hook-binary STDIN driver — PRD-021c Wave 2 (c-AC-5 / c-AC-6 / FR-4 / FR-7).
 *
 * ── WHAT THIS IS ─────────────────────────────────────────────────────────────
 * A hook-based harness (Claude Code, Codex) invokes the bundled binary once per
 * lifecycle event, piping the native hook JSON on stdin and reading the binary's
 * stdout as the hook response. This module is the SHARED driver every such binary
 * runs: read stdin → parse the native envelope → derive the {@link HookSessionMeta}
 * provenance → drive the event through the shared {@link HookRuntime} → emit the
 * harness's response envelope on stdout. The per-harness `harnesses/<h>/src/index.ts`
 * supplies only its {@link HarnessShim}; the driver is identical (c-AC-6 — the second
 * harness reuses it, never re-derives it).
 *
 * ── THE NATIVE ENVELOPE (the Claude Code / Codex hook shape) ────────────────
 * Both harnesses pipe a JSON object carrying `hook_event_name` plus session metadata
 * (`session_id`, `cwd`, `transcript_path`, `permission_mode`) alongside the
 * event-specific fields the shim's `extractData` reads (the WHOLE object is the
 * shim's `payload`). The driver lifts the metadata onto {@link HookSessionMeta} and
 * hands the whole object to the shim as the native payload (the shim is the only
 * thing that knows the per-event field names).
 *
 * ── FAIL-SOFT, NEVER A NON-ZERO EXIT (FR-10) ────────────────────────────────
 * A hook failure NEVER breaks the user's turn: a missing/malformed stdin, an
 * unmapped event, or a daemon error all exit 0 with a benign response. The driver
 * absorbs every error — the worst case is a turn captured nowhere, never a crashed
 * editor.
 *
 * ── THIN CLIENT (D-2) ───────────────────────────────────────────────────────
 * `src/hooks` is a NON_DAEMON_ROOT; the driver opens NO DeepLake. The only outbound
 * path is the runtime's injected daemon client over loopback.
 */

import type { HarnessShim } from "./contracts.js";
import {
	createHookRuntime,
	type HookEventOutcome,
	type HookRuntime,
	type HookRuntimeOptions,
	type NativeHookEvent,
} from "./runtime.js";
import type { HookSessionMeta } from "./shared/index.js";

/** A minimal stdio surface so a test drives the driver without a real process. */
export interface BinaryIo {
	/** Read the full stdin payload as a UTF-8 string (the native hook JSON). */
	readStdin(): Promise<string>;
	/** Write the hook response envelope to stdout. */
	writeStdout(text: string): void;
}

/** Options for {@link runHookBinary}. */
export interface RunHookBinaryOptions {
	/** The harness shim driving normalization (the ONLY per-harness divergence). */
	readonly shim: HarnessShim;
	/** Inject the runtime (tests). Defaults to a real {@link createHookRuntime}. */
	readonly runtime?: HookRuntime;
	/** Runtime construction options when the runtime is built here (host/port/seams). */
	readonly runtimeOptions?: HookRuntimeOptions;
	/** Inject the stdio surface (tests). Defaults to the real `process.stdin`/`stdout`. */
	readonly io?: BinaryIo;
}

/**
 * Run one hook invocation end-to-end (c-AC-5 / c-AC-6). Reads the native hook JSON off
 * stdin, derives the session metadata, drives the event through the shared runtime,
 * and writes the harness response envelope to stdout. Returns the {@link HookEventOutcome}
 * (so a test asserts the runtime was reached) — and ALWAYS resolves, never rejects
 * (fail-soft: a hook never breaks the turn, FR-10).
 */
export async function runHookBinary(options: RunHookBinaryOptions): Promise<HookEventOutcome> {
	const io = options.io ?? nodeBinaryIo();
	const runtime = options.runtime ?? createHookRuntime(options.runtimeOptions);

	const native = await readNativeEvent(io);
	if (native === undefined) {
		// No parseable event → emit an empty response and exit cleanly (fail-soft).
		emitResponse(io, options.shim, { result: { ok: true }, dropped: true });
		return { result: { ok: true }, dropped: true };
	}

	const meta = deriveMeta(native.raw);
	const outcome = await runtime.runEvent(options.shim, native.event, meta);
	emitResponse(io, options.shim, outcome);
	return outcome;
}

/** A parsed native event: the `{ name, payload }` for the shim + the raw object for meta. */
interface ParsedNative {
	readonly event: NativeHookEvent;
	readonly raw: Record<string, unknown>;
}

/**
 * Read + parse the native hook JSON off stdin into the shim's {@link NativeHookEvent}.
 * The native envelope's `hook_event_name` is the event name; the WHOLE object is the
 * shim's payload (it knows the per-event field names). Returns `undefined` on a
 * missing/malformed stdin or an absent event name (fail-soft, never a throw).
 */
async function readNativeEvent(io: BinaryIo): Promise<ParsedNative | undefined> {
	let text: string;
	try {
		text = await io.readStdin();
	} catch {
		return undefined;
	}
	if (text.trim().length === 0) return undefined;
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return undefined;
	}
	if (parsed === null || typeof parsed !== "object") return undefined;
	const raw = parsed as Record<string, unknown>;
	const name = pickEventName(raw);
	if (name === undefined) return undefined;
	return { event: { name, payload: raw }, raw };
}

/** The native event name — `hook_event_name` (Claude Code / Codex) or a bare `event`. */
function pickEventName(raw: Record<string, unknown>): string | undefined {
	for (const key of ["hook_event_name", "hookEventName", "event"] as const) {
		const value = raw[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

/**
 * Derive the {@link HookSessionMeta} provenance from the native envelope. The
 * conversation `path` is the harness's `transcript_path` (rows sharing a path are one
 * conversation); `cwd`/`permission_mode`/`session_id` map directly. The shim's
 * `deriveMeta` (019c) can refine this further per harness; the driver supplies the
 * common fields every hook-based harness carries.
 */
function deriveMeta(raw: Record<string, unknown>): HookSessionMeta {
	const sessionId = str(raw, "session_id", "sessionId") ?? "unknown-session";
	const transcript = str(raw, "transcript_path", "transcriptPath", "path");
	const cwd = str(raw, "cwd", "workspace_root");
	const permissionMode = str(raw, "permission_mode", "permissionMode");
	return {
		sessionId,
		// Group the conversation by the transcript path; fall back to the session id.
		path: transcript ?? `conversations/${sessionId}`,
		...(cwd !== undefined ? { cwd } : {}),
		...(permissionMode !== undefined ? { permissionMode } : {}),
	};
}

/** Read the first present string field from the native envelope, by candidate key order. */
function str(raw: Record<string, unknown>, ...keys: readonly string[]): string | undefined {
	for (const key of keys) {
		const value = raw[key];
		if (typeof value === "string" && value.length > 0) return value;
	}
	return undefined;
}

/**
 * Emit the harness response envelope on stdout. On session-start with a rendered
 * context block, the shim wraps it for its channel (model-only `additionalContext`
 * vs user-visible text); otherwise an empty `{}` acknowledgement. Never throws.
 */
function emitResponse(io: BinaryIo, shim: HarnessShim, outcome: HookEventOutcome): void {
	try {
		const block = outcome.result.additionalContext;
		if (block !== undefined && block.length > 0) {
			const envelope = shim.renderContext(block);
			io.writeStdout(JSON.stringify(envelope));
			return;
		}
		io.writeStdout("{}");
	} catch {
		// Even an emit failure must not crash the hook — swallow it (fail-soft).
	}
}

/**
 * The shared main-entry guard + driver for a harness binary (c-AC-5 / c-AC-6). A
 * binary calls THIS one line — `maybeRunHookBinaryMain(createXShim(), import.meta.url)`
 * — so the `isMainEntry` guard + the fail-soft `runHookBinary` invocation live ONCE
 * here, not duplicated per harness (jscpd discipline). Drives the hook ONLY when the
 * module is executed directly as the bundled binary; importing it (a test) is inert.
 */
export function maybeRunHookBinaryMain(shim: HarnessShim, importMetaUrl: string): void {
	if (!isMainEntry(importMetaUrl)) return;
	void runHookBinary({ shim }).catch((err: unknown) => {
		const reason = err instanceof Error ? err.message : String(err);
		process.stderr.write(`honeycomb: hook binary failed (fail-soft): ${reason}\n`);
	});
}

/**
 * True when the module at `importMetaUrl` is executed DIRECTLY as the bundled binary
 * (the path the native hook config invokes), as opposed to imported by a test. Only
 * the direct-execution path drives a hook; importing never reads stdin.
 */
function isMainEntry(importMetaUrl: string): boolean {
	const entry = process.argv[1];
	if (typeof entry !== "string" || entry.length === 0) return false;
	try {
		return importMetaUrl === new URL(`file://${entry}`).href || importMetaUrl.endsWith("/index.js");
	} catch {
		return false;
	}
}

/** The real `process.stdin`/`process.stdout` stdio surface. */
function nodeBinaryIo(): BinaryIo {
	return {
		async readStdin(): Promise<string> {
			const chunks: Buffer[] = [];
			for await (const chunk of process.stdin) {
				chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
			}
			return Buffer.concat(chunks).toString("utf8");
		},
		writeStdout(text: string): void {
			process.stdout.write(text);
		},
	};
}
