# What is Honeycomb?

> Category: Overview | Version: 1.1 | Date: July 2026 | Status: Active

The plain-language introduction to Honeycomb: what it is, the problem it solves, and who it is for. Start here if you are new.

**Related:**
- [How Honeycomb works](how-it-works.md)
- [Glossary](glossary.md)
- [Getting started](../guides/getting-started.md)

---

## The problem: your AI agents forget

AI coding assistants are brilliant in the moment and forgetful the next. Close the window and the context is gone. Open a different tool tomorrow and it has never heard of your project. The decision you reached with one assistant at midnight is invisible to a different assistant the next morning. So you re-explain your conventions, re-discover the fix that already worked, and repeat yourself to a machine that should have remembered.

## The idea: one shared memory for all of them

Honeycomb gives your AI coding agents a single, shared, lasting memory. A small program runs quietly on your machine, notices what happens as you work, distills it into clean notes, and hands those notes back to any assistant that asks. Learn something once, and it is there everywhere: the next session, a different tool, another laptop, and (if you want) the rest of your team.

Think of it as a shared brain your assistants read from and write to on every turn, instead of starting cold each time.

## What you actually get

- **Memory that survives.** What you figured out yesterday is waiting for you today, already summarized.
- **Memory that travels across tools.** A note written while using one assistant is recalled by another. Honeycomb plugs underneath the coding assistants you already use (Claude Code, Cursor, and Codex today, with three more in progress).
- **Skills that spread.** When you (or a teammate) solve something reusable, Honeycomb can turn it into a shareable "skill" that shows up automatically for everyone, no copy-paste.
- **A memory that gets sharper, not noisier.** Honeycomb periodically tidies its own notes: merging duplicates, dropping junk, and keeping the current version of a fact instead of letting stale ones pile up.
- **A friendly dashboard.** A simple local web page shows what has been remembered, how your tools are wired, and the health of everything. No database knowledge required.

## Who it is for

**Vibe coders.** If you live inside an AI coding assistant and just want it to *remember your project*, Honeycomb is the missing memory. One command to install, a dashboard that opens itself, and no SQL, servers, or configuration rituals. Stop re-explaining yourself every morning.

**Teams and enterprises.** If many developers, devices, and tools need to share what they learn, Honeycomb is one brain across all of them. A discovery by one engineer reaches the whole team on their next session. Your data stays in your own store, separated cleanly by team and project, and everything is versioned and inspectable.

## Where it comes from

Honeycomb is a collaboration. **Activeloop** provides [Deep Lake](https://deeplake.ai), the database for AI that Honeycomb's memory lives in, and [Hivemind](https://github.com/activeloopai/hivemind), the open-source agent-memory project Honeycomb is built on. **Legion Code** adds the multi-tier memory system, the skill sharing, the self-tidying loop, and the local daemon that ties it all together. Neither half stands alone: Deep Lake gives the memories somewhere durable to live, and Legion Code gives every assistant one consistent way to use them.

## Next steps

- See the shape of it in [How Honeycomb works](how-it-works.md).
- Learn the words in the [Glossary](glossary.md).
- Get it running in [Getting started](../guides/getting-started.md).
