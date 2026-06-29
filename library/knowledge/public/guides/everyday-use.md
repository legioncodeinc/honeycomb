# Everyday use

> Category: Guides | Version: 1.0 | Date: June 2026 | Status: Active

How Honeycomb fits into a normal day of coding: remembering and recalling, letting it work on its own, reading the dashboard, and the skills that travel with you.

**Related:**
- [Getting started](getting-started.md)
- [Honeycomb for teams](teams.md)
- [How Honeycomb works](../overview/how-it-works.md)

---

## It mostly works on its own

The best thing about Honeycomb day to day is how little you have to think about it. Once your assistants are wired (`honeycomb setup`), it captures the useful moments as you work and hands the right notes back at the start of your next session. You do not have to remember to save anything for the basics to work.

What you *will* notice is that a fresh session starts informed: your assistant already knows your project's recent decisions and durable conventions, instead of asking you to re-explain them.

## Remembering on purpose

Sometimes you want to pin something down yourself. Two simple commands do it:

```bash
honeycomb remember "the staging database resets every night at 2am UTC"
honeycomb recall "staging database schedule"
```

`remember` saves a note. `recall` pulls back whatever is relevant to your question. Recall matches both the words you used and, when enabled, the *meaning*, so you can find a note even if you would not have guessed its exact wording.

## Reading the dashboard

Run `honeycomb dashboard` (or just keep the tab open) to see everything in one place:

- **Home** gives you the at-a-glance picture: how much has been remembered, how things are trending, overall health.
- **Harnesses** shows each AI assistant Honeycomb is connected to and whether its wiring is healthy.
- **Memories** is your captured knowledge, browsable.
- **Graph** is the map of your codebase you can explore.
- **Sync** shows the skills and assets being shared, mined, and pulled.
- **Logs** is a live view of what the helper is doing.
- **Settings** holds your preferences and sign-in status, and lets you do the housekeeping actions right from the page: sign out, turn memory-meaning matching (embeddings) on or off, restart the helper, or remove Honeycomb, without dropping back to the terminal.

If something ever looks off, the dashboard tells you plainly what is degraded and what to do, rather than showing a green light that is not telling the truth.

## Skills that travel

When you solve something genuinely reusable, Honeycomb can capture it as a **skill**, a short, reusable lesson. Skills you (or teammates) create show up automatically in your assistants at the start of a session. You do not copy files around; Honeycomb places them where each tool looks for them.

You can also manage skills directly:

```bash
honeycomb skill pull        # fetch the latest shared skills now
honeycomb skill scope team --users alice,bob   # also learn from these teammates
```

## Working across tools and devices

Because every assistant talks to the same local helper and the same store, a memory written from one tool is recalled by another, and a memory captured on one machine is available on another (as long as you are signed in to the same account). Switch from one assistant to a different one mid-project and the context comes with you.

## Turning things up (optional)

Two capabilities are off by default so nothing surprising happens on day one. Turn them on when you want them:

- **Semantic search** (finding memories by meaning) becomes available once the small language model that powers it has downloaded and warmed up. Until then, recall still works by matching words.
- **The self-tidying loop** (which merges duplicates and prunes stale notes over time) is opt-in, because it uses an AI model and you should decide when to spend that.

## Pausing capture

If you are working on something sensitive and do not want it recorded for a session, you can put Honeycomb in read-only mode (recall still works, but nothing new is written). Your assistant keeps working normally either way.

## What next

- Sharing with others? See [Honeycomb for teams](teams.md).
- Want the mental model? Read [How Honeycomb works](../overview/how-it-works.md).
