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
 * Independent Hermes Agent shell-hook/MCP config oracle.
 *
 * Grounded in Hermes Agent 0.19's current hook registry and shell-hook parser:
 * `hermes_cli/plugins.py`, `agent/shell_hooks.py`, and the official Hooks docs.
 * This module deliberately does not import Honeycomb connector constants.
 */

import { z } from "zod";

export const HERMES_HOOK_EVENT_NAMES = [
	"pre_tool_call",
	"post_tool_call",
	"transform_terminal_output",
	"transform_tool_result",
	"transform_llm_output",
	"pre_llm_call",
	"post_llm_call",
	"pre_verify",
	"pre_api_request",
	"post_api_request",
	"api_request_error",
	"on_session_start",
	"on_session_end",
	"on_session_finalize",
	"on_session_reset",
	"subagent_start",
	"subagent_stop",
	"pre_gateway_dispatch",
	"pre_approval_request",
	"post_approval_response",
	"kanban_task_claimed",
	"kanban_task_completed",
	"kanban_task_blocked",
] as const;

const HERMES_EVENTS = new Set<string>(HERMES_HOOK_EVENT_NAMES);

export function isHermesHookEvent(value: string): value is (typeof HERMES_HOOK_EVENT_NAMES)[number] {
	return HERMES_EVENTS.has(value);
}

export const hermesHookEntry = z
	.object({
		command: z.string().min(1),
		matcher: z.string().min(1).optional(),
		timeout: z.number().int().min(1).max(300).optional(),
		_honeycomb: z.boolean().optional(),
	})
	.passthrough();

export const hermesMcpServer = z
	.object({
		command: z.string().min(1).optional(),
		args: z.array(z.string()).optional(),
		url: z.string().min(1).optional(),
		enabled: z.boolean().optional(),
		_honeycomb: z.boolean().optional(),
	})
	.passthrough()
	.refine((server) => server.command !== undefined || server.url !== undefined, {
		message: "Hermes MCP server requires command or url",
	});

export const hermesConfig = z
	.object({
		hooks: z.record(z.string(), z.array(hermesHookEntry)).optional(),
		mcp_servers: z.record(z.string(), hermesMcpServer).optional(),
	})
	.passthrough()
	.superRefine((config, ctx) => {
		for (const event of Object.keys(config.hooks ?? {})) {
			if (!isHermesHookEvent(event)) {
				ctx.addIssue({
					code: z.ZodIssueCode.custom,
					path: ["hooks", event],
					message: `"${event}" is not a Hermes hook event name`,
				});
			}
		}
	});

export function assertHermesConfigConforms(value: unknown): void {
	hermesConfig.parse(value);
}
