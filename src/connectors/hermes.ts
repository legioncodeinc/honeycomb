/*
 * Honeycomb - a cross-harness AI memory system.
 * Copyright (C) 2026 Legion Code Inc.
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version. See the LICENSE file for details.
 */

/**
 * Hermes Agent connector — wires Honeycomb through Hermes' native shell hooks
 * and stdio MCP client configuration in `$HERMES_HOME/config.yaml`.
 *
 * Hermes uses YAML and a flat `hooks.<event>[]` shape, so this connector
 * overrides the base class's config-text seams while inheriting all handler,
 * idempotency, detection, and skill-link filesystem mechanics.
 */

import { isMap, isSeq, parseDocument, YAMLMap, YAMLSeq } from "yaml";

import {
	type ConfigHookEntry,
	type ConnectorFs,
	type ConnectorRunResult,
	HarnessConnector,
	HONEYCOMB_ENTRY_KEY,
	HONEYCOMB_MARKER,
	type HookHandlerEntry,
	type InstallFileEntry,
	type SkillLinkTarget,
} from "./contracts.js";

export interface HermesConnectorOptions {
	readonly home: string;
	/** Active profile root (`$HERMES_HOME`); defaults to `<home>/.hermes`. */
	readonly hermesHome?: string;
	readonly pluginRoot?: string;
	readonly bundleSource: string;
	readonly mcpServerPath: string;
	readonly nodeExecutable?: string;
	readonly skillSources?: readonly string[];
	readonly notify?: (line: string) => void;
}

/** Canonical Honeycomb-owned MCP server key in Hermes config. */
export const HERMES_MCP_SERVER_NAME = "honeycomb" as const;

/** Hermes shell-hook event names, grounded in Hermes' hooks reference. */
const HERMES_EVENT_MAP: Readonly<Record<string, string>> = {
	"session-start": "on_session_start",
	user_message: "pre_llm_call",
	user_prompt_recall: "pre_llm_call",
	post_tool: "post_tool_call",
	assistant_message: "post_llm_call",
	"session-end": "on_session_finalize",
};

const HERMES_HANDLERS: ReadonlyArray<{
	logical: string;
	file: string;
	timeout: number;
	recall?: boolean;
}> = [
	{ logical: "session-start", file: "session-start.js", timeout: 30 },
	{ logical: "user_message", file: "capture.js", timeout: 10 },
	{ logical: "user_prompt_recall", file: "capture.js", timeout: 10, recall: true },
	{ logical: "post_tool", file: "capture.js", timeout: 15 },
	{ logical: "assistant_message", file: "capture.js", timeout: 30 },
	{ logical: "session-end", file: "session-end.js", timeout: 60 },
];

type UnknownRecord = Record<string, unknown>;

function asRecord(value: unknown): UnknownRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as UnknownRecord) : {};
}

function parseHermesDocument(text: string | undefined) {
	const document = parseDocument(text ?? "{}\n");
	if (document.errors.length > 0) {
		throw new Error(`HermesConnector: invalid YAML in config.yaml: ${document.errors[0]?.message ?? "parse error"}`);
	}
	const root = document.toJS();
	if (root !== null && (typeof root !== "object" || Array.isArray(root))) {
		throw new Error("HermesConnector: config.yaml root must be a mapping");
	}
	return document;
}

function yamlText(document: ReturnType<typeof parseHermesDocument>): string {
	const text = document.toString();
	return text.endsWith("\n") ? text : `${text}\n`;
}

function yamlMapAt(
	document: ReturnType<typeof parseHermesDocument>,
	key: string,
	create: boolean,
): YAMLMap<unknown, unknown> | undefined {
	const current = document.get(key, true);
	if (current === undefined) {
		if (!create) return undefined;
		const map = new YAMLMap(document.schema);
		document.set(key, map);
		return map;
	}
	if (!isMap(current)) throw new Error(`HermesConnector: ${key} must be a mapping`);
	return current;
}

function yamlSeqAt(map: YAMLMap<unknown, unknown>, key: string, create: boolean): YAMLSeq<unknown> | undefined {
	const current = map.get(key, true);
	if (current === undefined) {
		if (!create) return undefined;
		const seq = new YAMLSeq(map.schema);
		map.set(key, seq);
		return seq;
	}
	if (!isSeq(current)) throw new Error(`HermesConnector: hooks.${key} must be a sequence`);
	return current;
}

function isOwnedYamlEntry(value: unknown): boolean {
	return isMap(value) && value.get(HONEYCOMB_ENTRY_KEY) === true;
}

/** Hermes Agent's native YAML connector. */
export class HermesConnector extends HarnessConnector {
	readonly harness = "hermes";

	private readonly opts: {
		readonly hermesHome: string;
		readonly pluginRoot: string;
		readonly bundleSource: string;
		readonly mcpServerPath: string;
		readonly nodeExecutable: string;
		readonly skillSources: readonly string[];
		readonly notify: ((line: string) => void) | undefined;
	};

	constructor(fs: ConnectorFs, opts: HermesConnectorOptions) {
		super(fs);
		const hermesHome = opts.hermesHome ?? `${opts.home}/.hermes`;
		this.opts = {
			hermesHome,
			pluginRoot: opts.pluginRoot ?? `${hermesHome}/${HONEYCOMB_MARKER}`,
			bundleSource: opts.bundleSource,
			mcpServerPath: opts.mcpServerPath,
			nodeExecutable: opts.nodeExecutable ?? process.execPath,
			skillSources: opts.skillSources ?? [],
			notify: opts.notify,
		};
	}

	async install(): Promise<ConnectorRunResult> {
		const sources = [
			...this.hookHandlers().map((handler) => handler.sourcePath),
			...this.additionalFiles().map((file) => file.sourcePath),
		];
		for (const source of new Set(sources)) {
			if ((await this.fs.readFile(source)) === undefined) {
				throw new Error(`HermesConnector: required bundle is missing: ${source}`);
			}
		}
		// Parse and structurally patch in memory before the base writes any bundle. A malformed
		// user config must fail closed without leaving partially-installed artifacts behind.
		this.patchConfigText(await this.fs.readFile(this.configPath()), this.hookHandlers());
		const result = await super.install();
		if (result.wroteConfig) {
			this.opts.notify?.(
				"Hermes hooks installed. Hermes requires first-use consent; approve the Honeycomb hook commands at the next interactive Hermes start. Non-interactive runs skip unapproved hooks.",
			);
		}
		return result;
	}

	async uninstall(): Promise<ConnectorRunResult> {
		const result = await super.uninstall();
		// The connector created these directories solely for Honeycomb bundles. Remove them only
		// when empty, bottom-up, so a foreign file can never be deleted by uninstall.
		for (const dir of [`${this.opts.pluginRoot}/bundle`, `${this.opts.pluginRoot}/mcp`, this.opts.pluginRoot]) {
			await this.fs.removeEmptyDir(dir);
		}
		return result;
	}

	protected configPath(): string {
		return `${this.opts.hermesHome}/config.yaml`;
	}

	protected configRoot(): string {
		return this.opts.hermesHome;
	}

	protected eventNameMap(): Readonly<Record<string, string>> {
		return HERMES_EVENT_MAP;
	}

	protected hookHandlers(): readonly HookHandlerEntry[] {
		const events = this.eventNameMap();
		return HERMES_HANDLERS.map((handler) => {
			const handlerPath = `${this.opts.pluginRoot}/bundle/${handler.file}`;
			return {
				event: events[handler.logical] as string,
				handlerPath,
				sourcePath: `${this.opts.bundleSource}/${handler.file}`,
				command: `${JSON.stringify(this.opts.nodeExecutable)} ${JSON.stringify(handlerPath)}${handler.recall === true ? " --honeycomb-recall" : ""}`,
				timeout: handler.timeout,
			};
		});
	}

	protected additionalFiles(): readonly InstallFileEntry[] {
		return [
			{
				sourcePath: this.opts.mcpServerPath,
				targetPath: `${this.opts.pluginRoot}/mcp/server.js`,
			},
		];
	}

	protected skillLinkTargets(): readonly SkillLinkTarget[] {
		return this.opts.skillSources.map((source) => ({ dir: `${this.opts.hermesHome}/skills`, source }));
	}

	protected toConfigEntry(handler: HookHandlerEntry): ConfigHookEntry {
		return {
			type: "command",
			command: handler.command,
			...(handler.timeout === undefined ? {} : { timeout: handler.timeout }),
			[HONEYCOMB_ENTRY_KEY]: true,
		};
	}

	protected patchConfigText(text: string | undefined, handlers: readonly HookHandlerEntry[]): string {
		const document = parseHermesDocument(text);
		const hooks = yamlMapAt(document, "hooks", true) as YAMLMap<unknown, unknown>;

		for (const event of Object.keys(asRecord(asRecord(document.toJS()).hooks))) {
			const seq = yamlSeqAt(hooks, event, false);
			if (seq !== undefined) seq.items = seq.items.filter((entry) => !isOwnedYamlEntry(entry));
		}
		for (const handler of handlers) {
			const seq = yamlSeqAt(hooks, handler.event, true) as YAMLSeq<unknown>;
			seq.add(document.createNode(this.toConfigEntry(handler)));
		}

		const servers = yamlMapAt(document, "mcp_servers", true) as YAMLMap<unknown, unknown>;
		const current = servers.get(HERMES_MCP_SERVER_NAME, true);
		if (current !== undefined && !isOwnedYamlEntry(current)) {
			throw new Error(
				`HermesConnector: foreign MCP server "${HERMES_MCP_SERVER_NAME}" already exists; refusing to overwrite it`,
			);
		}
		servers.set(
			HERMES_MCP_SERVER_NAME,
			document.createNode({
				command: this.opts.nodeExecutable,
				args: [`${this.opts.pluginRoot}/mcp/server.js`],
				enabled: true,
				[HONEYCOMB_ENTRY_KEY]: true,
			}),
		);

		return yamlText(document);
	}

	protected stripConfigText(text: string | undefined): { readonly empty: boolean; readonly text: string } {
		const document = parseHermesDocument(text);
		const hooks = yamlMapAt(document, "hooks", false);
		if (hooks !== undefined) {
			for (const event of Object.keys(asRecord(asRecord(document.toJS()).hooks))) {
				const seq = yamlSeqAt(hooks, event, false);
				if (seq === undefined) continue;
				seq.items = seq.items.filter((entry) => !isOwnedYamlEntry(entry));
				if (seq.items.length === 0) hooks.delete(event);
			}
			if (hooks.items.length === 0) document.delete("hooks");
		}

		const servers = yamlMapAt(document, "mcp_servers", false);
		if (servers !== undefined) {
			if (isOwnedYamlEntry(servers.get(HERMES_MCP_SERVER_NAME, true))) servers.delete(HERMES_MCP_SERVER_NAME);
			if (servers.items.length === 0) document.delete("mcp_servers");
		}

		const remaining = asRecord(document.toJS());
		return { empty: Object.keys(remaining).length === 0, text: yamlText(document) };
	}
}
