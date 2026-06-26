# Getting started

> Category: Guides | Version: 1.0 | Date: June 2026 | Status: Active

Install Honeycomb, connect it, and save your first memory. Written for anyone, no prior setup or database knowledge required.

**Related:**
- [What is Honeycomb?](../overview/what-is-honeycomb.md)
- [Everyday use](everyday-use.md)
- [Honeycomb for teams](teams.md)

---

## 1. Install with one command

Open a terminal and paste the line for your system. You do not need to have Node, npm, or anything else set up first; the installer takes care of it.

**macOS or Linux**

```bash
curl -fsSL https://get.theapiary.sh | sh
```

**Windows (PowerShell)**

```powershell
irm https://get.theapiary.sh/install.ps1 | iex
```

The terminal shows a short progress log, and when it finishes it **opens a dashboard in your browser**. That dashboard is the real starting point; the terminal was just the doorway.

> Prefer to read the script before running it? Visit [get.theapiary.sh](https://get.theapiary.sh) in a browser, where you can inspect it and check the published checksums first.

## 2. Click "First time setup"

On the dashboard you will see a **First time setup** button. Click it. Honeycomb runs the sign-in for you: it shows a short code right on the page and opens a tab where you approve it (and create a free Deep Lake account if you do not have one). No copying codes out of a terminal.

When you approve, the same dashboard lights up its connected views. You are ready. Nothing to restart.

> Already using Hivemind? The dashboard will notice and offer to move you over cleanly. Running both at once is not supported, so let Honeycomb handle the switch.

## 3. Save your first memory

Now teach it something and ask for it back. In your terminal:

```bash
honeycomb remember "we deploy from the release branch, never from main"
honeycomb recall "how do we deploy"
```

That note is now saved. Write it while using one assistant, and a different assistant will recall it tomorrow, even on another laptop. That is the whole point.

## 4. Wire up your coding assistants

Let Honeycomb plug underneath the AI coding tools you already use, so it remembers automatically as you work:

```bash
honeycomb setup
```

This finds the assistants you have installed and connects each one. It is safe to run again any time, for example after you install a new tool. To check that everything is healthy:

```bash
honeycomb status
```

## 5. Explore the dashboard

Browse back to the dashboard any time to see what Honeycomb knows:

```bash
honeycomb dashboard
```

You will find your memories, the state of each connected assistant, your team's shared skills, a map of your codebase, and the overall health of the system, all in one local page.

## What next

- Learn the day-to-day flow in [Everyday use](everyday-use.md).
- Sharing across a team? See [Honeycomb for teams](teams.md).
- Curious about a word? Check the [Glossary](../overview/glossary.md).
