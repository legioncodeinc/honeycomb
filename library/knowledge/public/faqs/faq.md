# Frequently asked questions

> Category: FAQs | Version: 1.0 | Date: June 2026 | Status: Active

Short, plain answers to the questions people ask most about Honeycomb.

**Related:**
- [What is Honeycomb?](../overview/what-is-honeycomb.md)
- [Getting started](../guides/getting-started.md)
- [Glossary](../overview/glossary.md)

---

## The basics

**What is Honeycomb in one sentence?**
A shared, lasting memory for your AI coding assistants, so what one of them learns is remembered by all of them, across sessions, tools, devices, and (if you want) your team.

**Do I need to know about databases or SQL?**
No. You install with one command, click a button, and use plain commands like `remember` and `recall`. The technical machinery is hidden behind a friendly dashboard.

**Which AI coding assistants work with it?**
Four are supported today: Claude Code, Cursor, Codex, and Hermes. Two more, pi and OpenClaw, are in progress. Honeycomb plugs underneath whichever supported ones you have installed, and a memory written from one is recalled by the others.

**Who makes Honeycomb?**
It is a collaboration between Legion Code and Activeloop. Activeloop provides [Deep Lake](https://deeplake.ai) (the database for AI it stores memory in) and [Hivemind](https://github.com/activeloopai/hivemind) (the open-source project it builds on). Legion Code adds the multi-tier memory, skill sharing, the self-tidying loop, and the local helper that ties it together.

## Privacy and data

**Where does my data live?**
In your own Deep Lake store, which you control and can even host in your own cloud account. The small helper on your machine is the only thing that connects to it.

**Can other people or teams see my memories?**
No, unless you choose to share. Different companies, teams, and projects are kept separate at the storage layer, and within a team the default leans private. You widen sharing on purpose, never by accident.

**Are my API keys and secrets safe?**
Yes. Secrets are stored separately from memory, encrypted, tied to your machine, and they are never shown to an assistant. An assistant can *use* a secret (for example to call a service) without ever seeing its value.

**Does Honeycomb send my code or prompts anywhere?**
The only outbound traffic is the sign-in with Deep Lake and, optionally, anonymous product-usage counts to help the makers understand adoption. That usage signal never includes your code, prompts, memories, file paths, or names, and you can turn it off entirely. Your actual memories go only to the store you control.

**Can I stop it from recording?**
Yes. You can put Honeycomb in read-only mode for a session (recall still works, nothing new is written), which is handy when you are working with sensitive material.

## Cost and performance

**Does it slow my assistant down?**
No. Recording is cheap and happens out of the way, and if anything ever hiccups, your assistant keeps working normally. The start-of-session briefing it adds is deliberately small.

**Does it cost money in AI model usage?**
The everyday memory features (capturing, recalling, the briefing) do not require their own AI model or API key. Two optional extras can use a model: turning sessions into summaries and skills, and the periodic self-tidying loop. Both are opt-in, so you decide when to spend.

**What happens when I stop working for a while?**
Honeycomb notices when nothing is happening and quietly goes to sleep: after a couple of idle minutes it stops all its background chatter with your storage, which lets the hosted storage wind down so an idle setup costs next to nothing. It still captures anything new the moment you start again. The only thing you might notice is that the very first action after a long idle stretch can take a few extra seconds while storage wakes back up; after that it is full speed. This is on by default and nothing is ever lost while it sleeps.

**Do I need an internet connection?**
You need to be signed in to reach your store. The optional "search by meaning" feature uses a small language model that runs locally on your own machine (downloaded once), not a cloud service.

## How it compares

**How is this different from a regular vector database or "RAG"?**
A plain vector database can store text and hand back similar text. Honeycomb does that and more: it keeps memory at three levels of detail so an assistant can skim then zoom, it tidies itself over time so it gets sharper instead of noisier, it turns lessons into shareable skills, and it works across many tools and your whole team. The storage underneath (Deep Lake) is built for both exact lookups and meaning-based search in one place, with full version history.

**What is "search by meaning" (semantic search) and do I need it?**
It is the ability to find a memory by what it *means*, even if you used different words. It is optional. With it on, Honeycomb catches more of the "I didn't know the exact term to search for" cases. With it off, recall still works by matching words.

## Setup and switching

**I already use Hivemind. What happens?**
Honeycomb and Hivemind are siblings and share one sign-in, but running both at once is not supported. When you set up Honeycomb, the dashboard notices an existing Hivemind install and offers to move you over cleanly, usually without even needing to sign in again.

**Can I use it across multiple machines?**
Yes. Sign in on each machine with the same account, and a memory captured on one is available on the others.

**How do I see what it knows?**
Open the dashboard (`honeycomb dashboard`). It shows your memories, your connected tools, your shared skills, a map of your codebase, and overall health.

**What keeps Honeycomb running if it crashes?**
A tiny built-in watchdog called **Doctor**. The one-command installer sets it up alongside Honeycomb. It quietly checks that the background helper is healthy and, if something breaks, repairs it for you (restart, reinstall, and so on) so you usually never notice. If it cannot fix the problem on its own, it shows a local status page and, unless you opt out, sends home a scrubbed report so the makers can help proactively. That report never includes your credentials, tokens, or code, and you can turn it off (`DO_NOT_TRACK=1`, `HONEYCOMB_TELEMETRY=0`, or the dashboard). Don't want the watchdog at all? Add `--no-doctor` when you install.

**How do I remove it?**
`honeycomb uninstall` reverses only the changes Honeycomb made to your tools, leaving everything else untouched.

## Licensing

**Is it open and free to use?**
Honeycomb is licensed under the GNU Affero General Public License v3.0 or later (AGPL-3.0-or-later). You can use it commercially or privately, free of charge, as long as you keep the license notices and share your source if you run a modified version as a network service.

---

Still stuck? Start with [Getting started](../guides/getting-started.md), or check a term in the [Glossary](../overview/glossary.md).
