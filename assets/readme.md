# Honeycomb — Design System

The brand, tokens, components, and UI kit for **Honeycomb** — shared, self-improving memory for AI coding agents. A **Legion Code × Activeloop** collaboration: Honeycomb is the agent-memory product; [Activeloop Deep Lake](https://activeloop.ai) is the vector + columnar substrate its memory lives in.

> One agent solves a problem on Monday; every agent on the team recalls and reuses it after — context inspectable, scoped, and repairable, not trapped behind a black-box API.

This design system inherits the structural foundations of the parent **Legion Code** brand (dark-native, Inter + JetBrains Mono, 4px spacing, "mono is the texture of trust") and gives Honeycomb its own identity: a **warm honey-amber** hue and the **comb-cell** motif, with a reserved **violet "Pollinate"** accent for the Pollinating consolidation loop.

---

## Sources

Everything here was derived from material the team provided. You may not have access; links are recorded so you can go deeper if you do.

- **GitHub — [`legioncodeinc/honeycomb`](https://github.com/legioncodeinc/honeycomb)** — the product. Daemon + thin clients (six harnesses), the memory pipeline, and the dashboard. Key reads: `README.md`, `library/knowledge/private/overview.md`, `library/knowledge/private/ai/pollinating-loop.md`, and the dashboard contract under `src/dashboard/` (`contracts.ts`, `views.ts`, `html.ts`) — the UI kit recreates that dashboard. Explore the repo to build higher-fidelity Honeycomb surfaces.
- **GitHub — [`legioncodeinc/brands`](https://github.com/legioncodeinc) → `legion-code-inc/`** — the parent Legion Code brand: token stylesheet (`colors_and_type.css`), the Inter + JetBrains Mono font families (imported here), and the brand guide. Honeycomb's structure is inherited from it.
- **Activeloop Deep Lake — [activeloop.ai](https://activeloop.ai)** — the storage partner; logo in `logos/`.

> ⚠️ **Honeycomb has no logo of its own yet.** The comb-cell mark in `logos/honeycomb-mark.svg` is a clean geometric placeholder built for this system. Replace it with the official mark when one exists.

---

## What it is — product context

Honeycomb is a long-lived local **daemon** (binds `127.0.0.1:3850`, loopback only) plus thin clients. The daemon is the *sole* Deep Lake client; every harness, the CLI, the MCP server, and the SDK reach it over loopback HTTP.

- **Capture** every turn from any of six harnesses (Claude Code, Cursor, Codex, Hermes, pi, OpenClaw).
- **Distill** raw events into source-backed facts, entities, and skills with provenance.
- **Recall** the right context before the next turn — hybrid lexical (BM25) + 768-dim semantic.
- **Compound** — the **Pollinating loop** periodically merges duplicates, prunes junk, and supersedes stale claims, so memory gets sharper instead of noisier. The **skillify** miner turns recurring traces into reusable team skills.

The most user-visible surface is the **dashboard** (recreated in `ui_kits/dashboard/`): KPIs, sessions, settings, the codebase graph, org rules, skill-sync, and a live log.

---

## Content fundamentals

How Honeycomb writes. Inherited from Legion Code's voice — *the direct expert next door* — sharpened for a memory product.

- **Voice:** calm, plain, technically literate. Never hedging, never hype. Short declaratives. "Memory that sticks." "Learn something once, recall it everywhere."
- **Person:** address the user as **you** ("your agents", "what one agent learns"); the product is **Honeycomb** or **the daemon**, never "we" inside the product UI. Marketing prose may use "we" sparingly.
- **Casing:** sentence case everywhere — headings, buttons, labels. The wordmark **honeycomb** is lowercase. Mono labels/eyebrows are the only UPPERCASE, and only for small section labels.
- **Claims carry evidence.** Every recalled memory shows its **source** (a file path or session id) and a **score**. "Receipts, or it doesn't count." The `verified` (green) state means source-backed.
- **Mono for anything you could click, copy, or search:** memory keys, session ids, hashes, file paths, recall queries, token counts, timestamps. When the user sees mono, they trust it's real.
- **Signature vocabulary:** *memory, recall, capture, distill, the comb, cells, Pollinating, consolidate, skillify, harness, daemon, provenance, source-backed, scope (personal/team/org).*
- **No emoji.** Status is carried by color + a small dot/glyph, never an emoji. The only "icon" glyphs are the comb hexagon, the `✓` verified check, and rule dots `● / ○`.
- **Numbers are concrete and mono:** `1,284 memories`, `0.94`, `128k tok`, `:3850`. No vague "lots" — show the count.

**Examples (from the product):**
- `recall "how do we deploy"` → `4 hits · 0.94 top`
- "Not logged in to Honeycomb. Run: `honeycomb login`"
- "No graph built for this workspace. Run `honeycomb graph build`."
- "While you sleep, the AI goes back through everything it learned, tosses the junk, ties the pieces together, and wakes up smarter."

---

## Visual foundations

**Palette.** Dark-native, warm-tinted. Canvas is a warm near-black (`#0C0A07`) — five surfaces, four text levels, three border weights. One brand hue — **honey amber `#F7A823`** — governed by a **scarcity rule**: one saturated honey region per visible view (the primary action, the active recall, the live comb). A reserved second accent — **pollinate violet `#8B7CF0`** — appears only for the Pollinating loop and night/maintenance states. **Verified-green `#3DDC97`** (inherited from Legion) marks source-backed/proven memory. Severity colors (critical/warning/info/success) are semantic only, never decorative. A light theme exists for docs and exported reports.

**Typography.** **Inter** for all UI and prose; **JetBrains Mono** for every coordinate of trust. Modular 1.25 scale on a 16px base. Headings are Inter 700 with tight tracking (`-0.02 to -0.04em`). Eyebrows are uppercase mono with `0.08em` tracking. Display is reserved for marketing hero.

**Spacing & layout.** 4px base unit; every value a multiple of 4. Generous whitespace. Dashboard content is a centered max-width column (~1180px); panels sit in a responsive 2-column grid that collapses to one. Layout is calm and gridded — no diagonal or overlapping chrome.

**Backgrounds.** Flat warm-dark surfaces. **No gradient washes**, no photographic hero imagery, no noise/grain. The one recurring texture is the **comb** — interlocking hexagonal cells (see `guidelines/cards/brand-comb.html`), each cell a memory; lit cells are recalled/verified/pollinating. Use it as a quiet motif (corner fields, empty-state art, loaders), never a loud full-bleed pattern.

**Corners & cards.** Five-step radius ladder: 4 (chips), 8 (buttons/inputs), 12 (cards), 16 (panels/hero), full (dots/avatars). **Cards use a 1px border on `bg.elevated`, 12px radius, and no drop shadow** — border, not elevation, defines a card. The single expressive light is the **honey/pollinate glow** (`--glow-honey`, `--glow-pollinate`), used on exactly one focused element (an active recall hit, a pollinating cell).

**Borders & dividers.** Three weights (`subtle / default / strong`). Panel headers separate from body with a `border-subtle` rule. Hairline (1px) everywhere — no heavy rules.

**Elevation & shadow.** Three subtle ambient shadows (`sm/md/lg`) for genuinely floating UI (menus, toasts). Cards and panels do not use them. No colored decorative shadows except the two glows.

**Motion.** Disciplined and brief. Default easing `cubic-bezier(0.2, 0.8, 0.2, 1)`; durations 120ms (fast), 200ms (base), 400ms (slow). Recall results fade-and-rise in with a ~55ms stagger. The **one exception** is the **Pollinating pulse** (`--dur-pollinate` 900ms, ease-in-out, alternating opacity) — slow and breathing, used only for consolidation states. `prefers-reduced-motion` disables all motion.

**Hover / press.** Hover lightens fills one step (honey → honey-hover) or brightens a card border to `strong`. Press nudges `translateY(1px)` — no scale bounce. Focus shows a 2px honey outline at 2px offset, or a 3px honey-subtle ring on inputs.

**Transparency & blur.** Used sparingly: the `*-subtle` token tints (12–14% honey/pollinate/severity) for soft fills behind badges and banners. No glassmorphism / backdrop-blur chrome.

**Imagery vibe.** Warm, dark, restrained. If photography is ever introduced, it should be warm-toned and low-key to sit on the canvas — but the brand leans on the comb motif and mono typography over imagery.

---

## Iconography

Honeycomb inherits Legion Code's icon discipline.

- **System:** **[Lucide](https://lucide.dev)** — 24×24 grid, **1.5px stroke, stroked (not filled), geometric**, no mascots or metaphors. Load from CDN: `https://unpkg.com/lucide-static/icons/<name>.svg` (or the `lucide-react` package in a build). Match `currentColor` so icons inherit text color.
- **The verified check** (`✓`) gets a slight weight bump (~2px) — the one icon that signals trust may be a touch heavier. Rendered in `--verified` green.
- **The brand glyph** is the **comb hexagon** (`logos/honeycomb-mark.svg`) — the only bespoke mark. Use single hex cells as bullets/status chips (see `MemoryCard`), and the interlocking comb as motif/empty-state art.
- **Status is color + dot, not emoji.** Session/agent/rule states use a small filled circle in the semantic color. Rules use `●` (active) / `○` (inactive). **No emoji anywhere.**
- **No bespoke SVG illustration.** Beyond the hex mark and the comb grid (both pure geometry), don't hand-draw icons — pull the closest Lucide glyph.

> No Honeycomb icon set ships in the repo; Lucide is the documented substitute and matches the parent brand's stated icon rules. Flagged as a substitution.

---

## Index — what's in this system

**Foundations** (`styles.css` → `tokens/`)
- `tokens/colors.css` — surfaces, text, borders, honey, honey scale, pollinate, severity, verified (+ light theme)
- `tokens/typography.css` — families, 1.25 scale, weights, tracking
- `tokens/spacing.css` — 4px spacing, radii, elevation + glows, motion
- `tokens/fonts.css` — Inter + JetBrains Mono `@font-face` (binaries in `logos/fonts/`)
- `tokens/base.css` — element + semantic base styles

**Components** (`components/`) — React primitives, `window.HoneycombDesignSystem_d60529`
- `core/` — `Button`, `Badge`, `Card`, `Input`
- `honeycomb/` — `MemoryCard` (the signature recalled-memory cell), `Kpi` (dashboard metric tile)

**UI kit** (`ui_kits/`)
- `dashboard/` — interactive recreation of the daemon-served dashboard (KPIs, sessions, rules, codebase graph, skill-sync, live log, recall, Pollinating, connectivity-down banner)

**Specimen cards** (`guidelines/cards/`) — the Design System tab: Colors (5), Type (4), Spacing (3), Brand (2), Components (2).

**Logos** (`logos/`) — `honeycomb-mark.svg`, `honeycomb-wordmark.svg`, `activeloop.png`, `legion-code.png`, `fonts/`.

**Skill** — `SKILL.md` makes this directory usable as an Agent Skill in Claude Code.
