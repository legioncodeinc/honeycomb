/**
 * `honeycomb settings` thin-client verb + provider→model selector — PRD-032b (AC-4 / b-AC-1..4).
 *
 * The CLI surface for the vault's `setting` class. `settings list|get|set` and a provider→model
 * selector round-trip through the daemon's `/api/settings` group (PRD-032a `mountSettingsApi`)
 * via the {@link DaemonClient} seam — the SAME loopback path every storage verb uses, so the
 * actor/scope/loopback headers are stamped by the shared `createLoopbackDaemonClient`, never
 * re-implemented here.
 *
 * ── It is a THIN CLIENT (D-2 / the dispatcher thesis) ─────────────────────────
 * This handler imports NO `daemon/storage` path and holds NO vault/disk access: it builds a
 * {@link DaemonRequest}, dispatches it through `deps.daemon.send`, and renders the response. The
 * daemon owns the vault (the encrypt/decrypt, the registry posture gate, the on-disk perms); the
 * CLI dispatches intent. `src/commands` is a NON_DAEMON_ROOT, so a stray storage import FAILS the
 * build (`invariant.test.ts`) — the thin-client property is enforced.
 *
 * ── The secrets posture is PRESERVED (no value-returning verb) ────────────────
 * This verb touches ONLY the `setting` class through `/api/settings`. It NEVER reads the `secret`
 * class — there is no `settings get <a-secret>` path, and `/api/settings` itself rejects an
 * `internal-only` class at the registry (PRD-032a). The existing `honeycomb secret …` verb stays
 * names-only on `/api/secrets`, untouched. A `settings list` line for a secret-backed key would
 * show presence ("set ✓") only, never a value — but no such setting ships today, so `list` simply
 * never surfaces a secret.
 *
 * ── The provider→model selector (b-AC-3 / D-6) ────────────────────────────────
 * `honeycomb settings provider <id> --model <model>` validates the provider+model against the
 * SINGLE-SOURCED catalog (`vault/catalog.ts`, shared with the dashboard 032c) BEFORE writing, so a
 * bad pick fails fast client-side with a clear message rather than a generic daemon 400. On a valid
 * pick it writes `activeProvider` FIRST then `activeModel` (the order `/api/settings` semantics
 * require — the model is validated against the just-written provider). An OpenRouter model id is a
 * free-form passthrough (D-6). `settings provider` with no id prints the catalog (the providers +
 * their model lists) so a user can see the choices.
 */

import {
	catalogView,
	defaultModelFor,
	isValidProviderModel,
	type ProviderEntry,
	providerEntry,
} from "../daemon/runtime/vault/catalog.js";
import {
	type CommandDeps,
	type CommandResult,
	type DaemonRequest,
	type DaemonResponse,
	type OutputSink,
} from "./contracts.js";

/** The daemon route group the `settings` verb dispatches to (the PRD-032a `/api/settings` mount). */
export const SETTINGS_ENDPOINT = "/api/settings" as const;

/** A scalar setting value (mirrors the `setting`-class schema: string | number | boolean). */
export type SettingValue = string | number | boolean;

/** The parsed `settings` invocation: the subcommand + its positional/flag operands. */
export interface SettingsCliInvocation {
	/** The subcommand word (`list` | `get` | `set` | `provider` | `model` | unknown). */
	readonly subCommand: string;
	/** The positional operands after the subcommand (e.g. `[key]`, `[key, value]`, `[provider]`). */
	readonly args: readonly string[];
	/** The `--model <id>` selector flag value (the provider selector's model pick), or `""`. */
	readonly model: string;
}

/** The body `GET /api/settings` returns: the current settings map + the static catalog. */
interface SettingsListBody {
	/** The current `setting`-class records (key → typed value). NEVER contains a secret value. */
	readonly settings?: Readonly<Record<string, SettingValue>>;
	/** The static provider→model catalog (display-only; secret-free). */
	readonly catalog?: readonly ProviderEntry[];
}

/** The body `GET /api/settings/:key` returns: the key + its typed value. */
interface SettingGetBody {
	/** The setting key. */
	readonly key?: string;
	/** The typed value. */
	readonly value?: SettingValue;
}

/**
 * Parse a raw `settings` argv tail (everything AFTER the `settings` word) into a typed
 * {@link SettingsCliInvocation}. The first non-flag word is the subcommand; remaining non-flag
 * words are the positional operands; `--model <id>` (or `--model=<id>`) is the selector flag.
 * Pure: no IO, fully testable.
 */
export function parseSettingsCliArgs(argv: readonly string[]): SettingsCliInvocation {
	let subCommand = "";
	const args: string[] = [];
	let model = "";
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i]!;
		if (a === "--model") {
			const next = argv[i + 1];
			if (next !== undefined && !next.startsWith("--")) {
				model = next;
				i += 1;
			}
		} else if (a.startsWith("--model=")) {
			model = a.slice("--model=".length);
		} else if (a.startsWith("--")) {
			// An unrecognized flag is ignored (no other flags are defined for `settings`).
			continue;
		} else if (subCommand === "") {
			subCommand = a;
		} else {
			args.push(a);
		}
	}
	return { subCommand, args, model };
}

/** Narrow an unknown daemon body into a {@link SettingsListBody} (defensive across the IO boundary). */
function asListBody(body: unknown): SettingsListBody {
	if (typeof body !== "object" || body === null) return {};
	return body as SettingsListBody;
}

/** Narrow an unknown daemon body into a {@link SettingGetBody} (defensive across the IO boundary). */
function asGetBody(body: unknown): SettingGetBody {
	if (typeof body !== "object" || body === null) return {};
	return body as SettingGetBody;
}

/**
 * Coerce a CLI string `value` into the typed scalar the `setting` class stores. `true`/`false` →
 * boolean; a finite numeric string → number; everything else stays a string. This mirrors the
 * `setting`-class schema (string | number | boolean) so `set dreaming.enabled true` stores a real
 * boolean, not the string `"true"`. The daemon re-validates with the zod class schema regardless.
 */
export function coerceSettingValue(value: string): SettingValue {
	if (value === "true") return true;
	if (value === "false") return false;
	// A finite number (and the round-trip is lossless) → store as a number; otherwise a string.
	if (value.trim().length > 0) {
		const n = Number(value);
		if (Number.isFinite(n) && String(n) === value.trim()) return n;
	}
	return value;
}

/**
 * Render `settings list`: the current settings (provider/model/dreaming/prefs) one per line, then
 * a compact catalog footer. NEVER prints a secret value — `GET /api/settings` returns ONLY the
 * `setting` class, so no key/token can appear; a settings line is `key = value` for the daemon-
 * readable scalar. An empty settings map prints an honest "no settings stored yet".
 */
function renderList(body: SettingsListBody, out: OutputSink): void {
	const settings = body.settings ?? {};
	const keys = Object.keys(settings).sort();
	if (keys.length === 0) {
		out("settings: none stored yet (provider/model fall back to agent.yaml; dreaming to the env var).");
	} else {
		out("settings:");
		for (const key of keys) {
			out(`  ${key} = ${String(settings[key])}`);
		}
	}
	const catalog = body.catalog ?? catalogView();
	out("providers:");
	for (const p of catalog) {
		const suffix = p.openEnded ? " (free-form model id accepted)" : "";
		out(`  ${p.id} (${p.label}): ${p.models.join(", ")}${suffix}`);
	}
}

/** Print the static catalog (the selector's choices) — used by `settings provider` with no id. */
function renderCatalog(out: OutputSink): void {
	out("choose a provider, then a model (--model <id>):");
	for (const p of catalogView()) {
		const def = p.models[0] ?? "(none)";
		const suffix = p.openEnded ? " — or any free-form id" : "";
		out(`  ${p.id} (${p.label}): ${p.models.join(", ")}${suffix} [default: ${def}]`);
	}
	out("e.g. honeycomb settings provider anthropic --model claude-opus-4-8");
}

/** POST one setting key/value through the daemon; returns the response for the caller to gate on. */
async function postSetting(deps: CommandDeps, key: string, value: SettingValue): Promise<DaemonResponse> {
	const req: DaemonRequest = { method: "POST", path: `${SETTINGS_ENDPOINT}/${key}`, body: { value } };
	return deps.daemon.send(req);
}

/** Run `settings list` — GET the settings map + catalog, render it (no secret printed). */
async function runList(deps: CommandDeps, out: OutputSink): Promise<CommandResult> {
	const res = await deps.daemon.send({ method: "GET", path: SETTINGS_ENDPOINT });
	if (res.status >= 400) {
		out(`error: settings list failed (daemon ${res.status}).`);
		return { exitCode: 1 };
	}
	renderList(asListBody(res.body), out);
	return { exitCode: 0 };
}

/** Run `settings get <key>` — GET one setting's value; a missing key 404s → friendly message. */
async function runGet(deps: CommandDeps, key: string, out: OutputSink): Promise<CommandResult> {
	if (key === "") {
		out("usage: honeycomb settings get <key>");
		return { exitCode: 1 };
	}
	const res = await deps.daemon.send({ method: "GET", path: `${SETTINGS_ENDPOINT}/${key}` });
	if (res.status === 404) {
		out(`settings: '${key}' is not set.`);
		return { exitCode: 1 };
	}
	if (res.status >= 400) {
		out(`error: settings get failed (daemon ${res.status}).`);
		return { exitCode: 1 };
	}
	const parsed = asGetBody(res.body);
	out(`${key} = ${String(parsed.value ?? "")}`);
	return { exitCode: 0 };
}

/** Run `settings set <key> <value>` — coerce the scalar, POST it through the daemon. */
async function runSet(deps: CommandDeps, args: readonly string[], out: OutputSink): Promise<CommandResult> {
	const key = args[0] ?? "";
	const rawValue = args[1] ?? "";
	if (key === "" || rawValue === "") {
		out("usage: honeycomb settings set <key> <value>");
		return { exitCode: 1 };
	}
	const value = coerceSettingValue(rawValue);
	const res = await postSetting(deps, key, value);
	if (res.status >= 400) {
		const reason = readReason(res.body);
		out(`error: settings set failed${reason !== "" ? ` (${reason})` : ` (daemon ${res.status})`}.`);
		return { exitCode: 1 };
	}
	// Echo the WRITTEN key/value — this is a `setting` (daemon-readable), never a secret.
	out(`settings: ${key} = ${String(value)} (saved).`);
	return { exitCode: 0 };
}

/**
 * Run the provider→model selector (b-AC-3 / D-6). `settings provider <id> --model <model>`:
 *   - no id          → print the catalog (the choices) + a usage example;
 *   - unknown id      → reject (off-catalog provider) client-side;
 *   - id, no --model  → use the provider's default model (`models[0]`);
 *   - id + --model    → validate the model against the provider's catalog (OpenRouter accepts a
 *                       free-form id, D-6); reject an off-catalog model for a closed provider.
 * On a valid pick it writes `activeProvider` FIRST then `activeModel` (the order the
 * `/api/settings` model-validation requires), each through the daemon seam.
 */
async function runProvider(deps: CommandDeps, args: readonly string[], model: string, out: OutputSink): Promise<CommandResult> {
	const provider = args[0] ?? "";
	if (provider === "") {
		renderCatalog(out);
		return { exitCode: 0 };
	}
	const entry = providerEntry(provider);
	if (entry === undefined) {
		out(`error: unknown provider '${provider}'. Choose one of: ${catalogView().map((p) => p.id).join(", ")}.`);
		return { exitCode: 1 };
	}
	// A model id from --model, else the provider's catalog default.
	const chosenModel = model !== "" ? model : (defaultModelFor(provider) ?? "");
	if (chosenModel === "") {
		out(`error: no model chosen and provider '${provider}' has no default. Pass --model <id>.`);
		return { exitCode: 1 };
	}
	// Catalog validation (D-6): closed providers must match; OpenRouter accepts a free-form id.
	if (!isValidProviderModel(provider, chosenModel)) {
		out(`error: model '${chosenModel}' is not in the ${entry.label} catalog. Available: ${entry.models.join(", ")}.`);
		return { exitCode: 1 };
	}
	// Write the provider FIRST so the daemon validates the model against the just-written provider.
	const provRes = await postSetting(deps, "activeProvider", provider);
	if (provRes.status >= 400) {
		const reason = readReason(provRes.body);
		out(`error: could not set activeProvider${reason !== "" ? ` (${reason})` : ` (daemon ${provRes.status})`}.`);
		return { exitCode: 1 };
	}
	const modelRes = await postSetting(deps, "activeModel", chosenModel);
	if (modelRes.status >= 400) {
		const reason = readReason(modelRes.body);
		out(`error: could not set activeModel${reason !== "" ? ` (${reason})` : ` (daemon ${modelRes.status})`}.`);
		return { exitCode: 1 };
	}
	out(`settings: provider = ${provider}, model = ${chosenModel} (saved).`);
	return { exitCode: 0 };
}

/** Read a daemon error `reason` string off a defensive body (for a clearer CLI error line). */
function readReason(body: unknown): string {
	if (typeof body !== "object" || body === null) return "";
	const reason = (body as Record<string, unknown>).reason;
	return typeof reason === "string" ? reason : "";
}

/** The usage block for the `settings` verb (printed for no/unknown subcommand). */
function usage(out: OutputSink): void {
	out("usage: honeycomb settings <list|get|set|provider>");
	out("  list                              show current settings + the provider catalog");
	out("  get <key>                         read one setting's value");
	out("  set <key> <value>                 write a setting through the daemon");
	out("  provider [<id> --model <model>]   pick a provider + model from the catalog");
}

/**
 * Run the `settings` verb (AC-4). Routes the subcommand to its handler; every effect goes ONLY
 * through `deps.daemon` (no DeepLake, no direct vault/disk access). `list`/`get`/`set` round-trip
 * the `setting` class; `provider`/`model` run the catalog-validated selector. No subcommand (or an
 * unknown one) prints usage. A non-2xx daemon status renders an error and exits 1.
 */
export async function runSettingsVerb(argv: readonly string[], deps: CommandDeps): Promise<CommandResult> {
	const out: OutputSink = deps.out ?? ((line: string): void => console.log(line));
	const inv = parseSettingsCliArgs(argv);

	switch (inv.subCommand) {
		case "list":
			return runList(deps, out);
		case "get":
			return runGet(deps, inv.args[0] ?? "", out);
		case "set":
			return runSet(deps, inv.args, out);
		// `provider` and `model` both drive the same selector — `model` is an alias so
		// `settings model <provider> --model <id>` reads naturally too.
		case "provider":
		case "model":
			return runProvider(deps, inv.args, inv.model, out);
		default:
			usage(out);
			// An empty subcommand is a benign usage print (exit 0); an unknown one is an error (exit 1).
			return { exitCode: inv.subCommand === "" ? 0 : 1 };
	}
}
