# Glossary

> Category: Overview | Version: 1.0 | Date: June 2026 | Status: Active

Plain-language definitions of the words you will see around Honeycomb. Each entry says what the thing is and why it matters to you.

**Related:**
- [What is Honeycomb?](what-is-honeycomb.md)
- [How Honeycomb works](how-it-works.md)
- [Getting started](../guides/getting-started.md)

---

**Honeycomb**: A shared, lasting memory for your AI coding assistants. It remembers what you and your assistants do so the knowledge is there next time, in any tool, on any device.

**Agent / assistant / harness**: All three words point at the same thing: the AI coding tool you actually use (for example Claude Code, Cursor, or Codex). "Harness" is just the technical word for "the tool Honeycomb plugs underneath." Honeycomb supports six of them at once.

**Daemon**: The small helper program that runs quietly in the background on your machine. It is the only part of Honeycomb that touches your memory store, which keeps everything in one safe, consistent place. You rarely interact with it directly; it starts itself when needed.

**Capture**: The act of quietly recording what happened as you work (your prompts, the tool's actions, the results). Capture is the raw material Honeycomb later distills into clean notes.

**Recall**: Asking Honeycomb for the right notes at the right moment. It happens automatically at the start of a session, and your assistant can also ask for more whenever it needs to.

**Memory**: A clean, distilled note Honeycomb keeps about your work: a decision, a fix, a convention, a gotcha. Memories are what get recalled.

**The three tiers (key, summary, raw)**: The same memory kept at three levels of detail so you can zoom in only as far as you need. The **key** is a one-line headline, the **summary** is a short recap, and the **raw** is the full original. Skim the headlines, open a summary if it looks useful, read the full detail only when you must.

**Priming / the prime**: The short "here is what I already know about this project" briefing Honeycomb hands your assistant at the start of a session, so it begins informed instead of blank. It is small on purpose, just the headlines, so it never clutters the conversation.

**Skill**: A reusable lesson, written once and shared. When you solve something worth keeping (a migration trick, a debugging routine), Honeycomb can turn it into a skill that automatically appears for you and your teammates.

**Skillify**: The automatic process that watches your sessions and turns the genuinely reusable patterns into skills. It is picky on purpose: it would rather miss a so-so skill than create a noisy one.

**The pollinating loop**: Honeycomb's self-tidying pass. Every so often it merges duplicate notes, removes junk, and replaces stale facts with their current version, so the memory gets sharper as it grows instead of messier. (It is off by default and you turn it on when you want it.)

**Knowledge graph**: Honeycomb's map of the things in your work (people, projects, tools, decisions) and how they connect. It is what lets memory answer "what is true about this right now, and what does it depend on," not just "what did I say about it."

**Codebase graph**: A map of your actual code: its files, functions, and how they call and import each other. It lets an assistant answer questions like "what would changing this break?" grounded in your real project.

**Deep Lake**: The database for AI, made by Activeloop, where Honeycomb's memories are stored. It is good at both exact lookups and meaning-based search, it keeps a full version history, and it can live in your own cloud. See [deeplake.ai](https://deeplake.ai).

**Hivemind**: Activeloop's open-source agent-memory project that Honeycomb is built on. See [the Hivemind repository](https://github.com/activeloopai/hivemind).

**Embeddings / semantic search**: The optional ability to find memories by *meaning* rather than exact words. Turn it on and Honeycomb can surface the right note even when you would not have guessed the exact term. Turn it off and recall still works by matching words; it simply finds fewer of the "I didn't know to search for that" cases.

**Org, workspace, and project**: How Honeycomb keeps memory in the right lane for a team. An **org** is your company, a **workspace** is a team within it, and a **project** is the specific repository or folder you are working in. Notes are kept separate across these so the right people see the right memory and nothing bleeds across.

**Dashboard**: The simple local web page Honeycomb serves on your own machine. It shows your memories, how your tools are wired, your team's shared skills, and the health of everything. It is also where first-time setup happens. No database skills required.

**ROI**: The dashboard page that answers "is this saving me money?" It nets what Honeycomb saves you (from reused context and fewer back-and-forths) against what it costs to run, in plain dollars. It carefully labels which numbers are **measured** (real, billed facts) and which are **estimates** (projections), and shows a dash rather than a made-up number when something cannot be measured yet. See [Your ROI dashboard](../guides/roi-dashboard.md).

**Measured vs estimated savings**: Honeycomb's honesty rule on the ROI page. A *measured* number is arithmetic over your real billed usage, trust it like a receipt. An *estimated* number is a model of what would otherwise have happened, useful but a projection, and it is always flagged with an "est." marker so the two are never confused.

**MCP**: A standard way for AI tools to call external helpers. Honeycomb offers an MCP "server" so assistants that speak it can ask Honeycomb for memory directly, as a built-in tool.
