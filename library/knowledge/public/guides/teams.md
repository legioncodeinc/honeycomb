# Honeycomb for teams

> Category: Guides | Version: 1.0 | Date: June 2026 | Status: Active

How a team shares memory and skills with Honeycomb, what stays private versus shared, and how work in different projects stays in its own lane.

**Related:**
- [Getting started](getting-started.md)
- [Everyday use](everyday-use.md)
- [What is Honeycomb?](../overview/what-is-honeycomb.md)

---

## One brain for the whole team

On your own, Honeycomb remembers your work across sessions and tools. On a team, it does something more valuable: what one person learns can reach everyone. A teammate solves a tricky migration on Monday; the reusable lesson is available to the whole team's assistants by their next session, without anyone passing around a file.

## Org, workspace, project: keeping memory in the right lane

Teams need memory to be shared *and* separated at the same time. Honeycomb organizes it in three nested levels:

- **Org** is your company. It is the outer boundary; two different companies never see each other's anything.
- **Workspace** is a team within the company. Two teams keep separate memory, enforced where the data is stored, not just in the app.
- **Project** is the specific repository or folder you are working in. Within a team, memory is scoped to the project you are actually in, so a note from one repo does not surface while you work in another.

You do not have to manage the project level by hand. Honeycomb figures out which project a session belongs to from the folder you are working in, even when you have several open at once across different tools.

## What is shared and what is private

Inside a workspace, what an assistant can see depends on a simple policy:

- **Private lane**: an assistant sees only its own memories. Good for a personal or a CI assistant that should not mix into the shared pool.
- **Shared**: an assistant sees the team's shared memories plus its own. This is the "one brain" setting.
- **Group**: an assistant shares with a named group of teammates, plus its own.

The default leans private and safe: when in doubt, Honeycomb shows less, not more. You widen sharing on purpose, never by accident.

## Skills spread automatically

Shared **skills** (reusable lessons) are the most visible team benefit. When a skill is published to the team, every teammate's assistants pick it up at the start of their next session. Skills carry who wrote them, so credit and history are clear, and two people can have a skill with the same name without clobbering each other.

Promoting something from "just mine" to "the whole team's" is always a deliberate, recorded action, so nothing private gets shared by surprise.

## Switching between projects, teams, and companies

Because Honeycomb scopes to the folder you are in, **moving between repositories needs no manual switch at all**, just open the other project in your assistant and Honeycomb follows. What stays a deliberate choice is moving between the teams and companies you belong to:

```bash
honeycomb org list           # companies you belong to
honeycomb workspace list     # teams in the current company
honeycomb project list       # projects you are bound to
honeycomb org switch acme    # change company
honeycomb workspace use backend
```

The dashboard offers the same switches in a menu, showing only the orgs, workspaces, and projects you actually have access to.

## Your data, your store

A team's memory lives in your own Deep Lake store, with each team and project separated at the storage layer. You can even keep that storage in your own cloud account. Sensitive credentials (like API keys) are never stored alongside memory and are never shown to an assistant. For decision-makers: memory is versioned and inspectable, sharing is opt-in by design, and nothing leaves your store except the sign-in traffic and, only if you allow it, anonymous product-usage counts.

## What next

- New here? Start with [Getting started](getting-started.md).
- Want the day-to-day flow? See [Everyday use](everyday-use.md).
