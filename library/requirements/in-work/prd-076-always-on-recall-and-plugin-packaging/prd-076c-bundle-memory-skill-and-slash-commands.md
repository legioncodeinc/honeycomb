# PRD-076c: Bundle a Memory Skill + Slash Commands

> **Parent:** [`prd-076-always-on-recall-and-plugin-packaging-index`](./prd-076-always-on-recall-and-plugin-packaging-index.md)
> **Status:** Draft
> **Priority:** P2
> **Effort:** S (~2-4h)
> **Schema changes:** None.
> **Depends on:** [`prd-076b`](./prd-076b-register-mcp-server-in-plugin.md) (the skill and commands POINT at the MCP tools that 076b registers; they are inert without callable tools).

---

## Goal

Make recall a capability the model reaches for and the user can trigger explicitly. 076b registers the MCP tools; this sub-PRD teaches the model WHEN and HOW to use them (via a bundled skill) and gives the user discoverable, explicit control (via slash commands). This is the model-driven ceiling of PRD-076: a skill is model-invoked from its description, so it is a smarter, token-cheap form of reminder that auto-triggers on memory-relevant work, and the commands are the manual escape hatch.

## Non-Goals

- **No MCP registration.** That is 076b; this sub-PRD assumes the tools are callable.
- **No always-on recall wiring.** That is 076a.
- **No new MCP tools.** The skill and commands orchestrate the EXISTING `mcp/src/tools.ts` surface.
- **No `memory-recall` subagent.** Noted as a clearly-flagged stretch item below, not built.

---

## Code-grounded starting point

| # | Fact | Code |
|---|---|---|
| 1 | The MCP tools the skill/commands orchestrate already exist: `memory_search`, `hivemind_search` (hybrid recall), `hivemind_read` (zoom a ref to summary/raw turns), `memory_store` (with a closed memory-type taxonomy), `memory_forget`. | `mcp/src/tools.ts:77-138` (`memory_search` `:79`, `memory_store` `:80` with `memoryTypeArg`, `hivemind_read` `:107-111`, `hivemind_search` `:115-119`, `memory_forget` `:94`) |
| 2 | `memory_store` publishes a CLOSED memory-type enum with LLM-facing guidance, so the model can classify what it stores; the enum is single-sourced from `MEMORY_TYPES`. | `mcp/src/tools.ts:50-53` (`memoryTypeArg` with `.describe(memoryTypeGuidance())`) |
| 3 | The plugin is published through the marketplace manifest, plugin source `./harnesses/claude-code`; the plugin currently bundles only hooks. | `.claude-plugin/marketplace.json:10-17`, `harnesses/claude-code/hooks/hooks.json` |
| 4 | 076b registers the MCP server so the tools are callable in a Claude Code session (the precondition for this sub-PRD). | `prd-076b-register-mcp-server-in-plugin.md` |

---

## Design

### Part 1 - The `honeycomb-memory` skill

Bundle a skill with the Claude Code plugin whose DESCRIPTION auto-triggers it on memory-relevant work (Claude Code invokes a skill from its description, so the description is load-bearing). The skill body teaches three behaviors, each pointing at a specific existing tool:

- **Search before non-trivial tasks.** Before starting a task that likely has prior context (a decision, a convention, where something lives), call `hivemind_search` / `memory_search` first rather than asking the user to re-explain. This is the token-cheap, model-driven complement to 076a's always-on floor.
- **Cite recalled decisions.** When recall surfaces a prior decision or convention, cite it in the work rather than silently re-deciding, and use `hivemind_read` to zoom a promising ref down to its summary or raw turns when more detail is needed.
- **Store with the right type.** After a decision, a stated preference, or a durable fact emerges, call `memory_store` with the correct memory type (the tool publishes the closed taxonomy + guidance, `tools.ts:50-53`), so the memory is classified and later recallable.

The skill is inert-safe: if the MCP server is not registered (076b not shipped), the skill simply has no tools to call. Its description should be tuned from data (does it actually fire on the right work?), noted as an open question.

### Part 2 - Slash commands

Bundle three commands for explicit user control and discoverability:

- **`/recall <query>`** - run a hybrid recall for the user's query and surface the hits. Maps to `hivemind_search` / `memory_search`.
- **`/remember <fact>`** - store a fact the user dictates. Maps to `memory_store` (the model picks the type from the taxonomy, or the command defaults it).
- **`/forget`** - forget a memory (reason-gated). Maps to `memory_forget` (which requires a `reason`, `tools.ts:94`); the command collects the reason.

Commands are the manual escape hatch that make the capability discoverable in the slash-command menu, complementing the model-invoked skill and the always-on floor.

### Placement + discovery

Bundle the skill and commands in the plugin's conventional directories (a `skills/` dir and a `commands/` dir under the plugin source `./harnesses/claude-code`), with valid frontmatter, per the Claude Code plugin contract. Confirm the exact directory conventions against the references gate (open question) so the loader actually discovers them.

---

## Acceptance criteria

| ID | Criterion |
|---|---|
| c-AC-1 | A `honeycomb-memory` skill is bundled with the plugin, with valid frontmatter and a description that targets memory-relevant work. A test asserts the skill file is present, parses, and its frontmatter has the required fields. |
| c-AC-2 | The skill body instructs: search-before-non-trivial-task (via `hivemind_search`/`memory_search`), cite-recalled-decisions (with `hivemind_read` to zoom), and store-with-the-right-type (via `memory_store` + the closed taxonomy). A test asserts the body references those tool names. |
| c-AC-3 | `/recall <query>`, `/remember <fact>`, and `/forget` commands are bundled with the plugin, each with valid frontmatter. A test asserts the three command files are present and parse. |
| c-AC-4 | `/forget` collects a `reason` (the `memory_forget` tool requires one, `tools.ts:94`). A test asserts the command definition supplies/collects a reason. |
| c-AC-5 | The skill and commands live in the plugin-contract-correct directories so the loader discovers them; the mechanism is confirmed against the references gate. A test asserts the placement matches the pinned convention. |
| c-AC-6 | The bundling is additive: `plugin.json`, the hooks, and (if shipped) the 076b MCP registration are unchanged by this sub-PRD. A test asserts the hooks config still parses and the MCP registration (if present) is untouched. |

---

## Files touched

**New**
- `harnesses/claude-code/skills/honeycomb-memory/SKILL.md` (or the plugin's skill convention) - the model-invoked memory skill.
- `harnesses/claude-code/commands/recall.md` - the `/recall <query>` command.
- `harnesses/claude-code/commands/remember.md` - the `/remember <fact>` command.
- `harnesses/claude-code/commands/forget.md` - the `/forget` command.
- tests under `tests/` asserting the artifacts are present, parse, and reference the right tools (c-AC-1..c-AC-6).

**Modified**
- possibly the version-sync/packaging config, if the plugin package must enumerate the new directories.

---

## Test plan

- **Skill presence + shape:** assert the `honeycomb-memory` skill file parses with valid frontmatter (c-AC-1) and its body references `hivemind_search`/`memory_search`/`hivemind_read`/`memory_store` (c-AC-2).
- **Commands:** assert the three command files are present and parse (c-AC-3); `/forget` collects a reason (c-AC-4).
- **Placement:** assert the skill/command directories match the pinned plugin convention (c-AC-5).
- **Additive:** hooks config + MCP registration unchanged (c-AC-6).

---

## Open questions

- **Skill and command directory conventions.** Confirm the Claude Code plugin's `skills/` and `commands/` directory layout and frontmatter schema against the references gate so the loader discovers them. Encode the expectation the way `hooks-schema.ts` pins the hooks contract.
- **Skill description wording.** The description is what auto-triggers the skill, so it is load-bearing and easy to over- or under-trigger. Ship one version and tune from data (does it fire on the right work without spamming?).
- **`/remember` type selection.** Whether `/remember` asks the model to classify the memory type (from the closed taxonomy) or defaults it. Prefer model-classified with a sane default, mirroring `memory_store`'s optional type.
- **Stretch: a `memory-recall` subagent.** A dedicated subagent could do deep recall without polluting the main context (search, zoom, synthesize, return only the answer). This is a clearly-flagged FUTURE/STRETCH item, explicitly out of scope here; flag if wanted as its own PRD.
