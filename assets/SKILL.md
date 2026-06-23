---
name: honeycomb-design
description: Use this skill to generate well-branded interfaces and assets for Honeycomb (shared AI agent memory, a Legion Code × Activeloop product), either for production or throwaway prototypes/mocks/etc. Contains essential design guidelines, colors, type, fonts, assets, and UI kit components for prototyping.
user-invocable: true
---

Read the `readme.md` file within this skill, and explore the other available files.

If creating visual artifacts (slides, mocks, throwaway prototypes, etc), copy assets out and create static HTML files for the user to view. If working on production code, you can copy assets and read the rules here to become an expert in designing with this brand.

If the user invokes this skill without any other guidance, ask them what they want to build or design, ask some questions, and act as an expert designer who outputs HTML artifacts _or_ production code, depending on the need.

## Where things are
- `styles.css` — the one stylesheet to link; `@import`s everything in `tokens/`.
- `tokens/` — colors (honey/pollinate/verified + surfaces), typography (Inter + JetBrains Mono), spacing/radii/motion, `@font-face`.
- `components/` — React primitives: `core/` (Button, Badge, Card, Input) and `honeycomb/` (MemoryCard, Kpi). Each has a `.prompt.md` with usage.
- `ui_kits/dashboard/` — interactive recreation of Honeycomb's daemon-served dashboard; the reference for any full Honeycomb surface.
- `guidelines/cards/` — small specimen cards for every foundation.
- `logos/` — logomark, wordmark, partner logos, fonts.

## Non-negotiables
- Dark-native, warm near-black canvas. Honey amber `#F7A823` is the one brand hue — **one saturated honey region per view** (scarcity rule). Pollinate violet is only for the Pollinating loop; verified-green only for source-backed states.
- **Mono (JetBrains Mono) is the texture of trust** — every memory key, id, hash, path, count, timestamp, recall query.
- Sentence case; lowercase `honeycomb` wordmark. No emoji. Icons = Lucide (1.5px stroke, geometric).
- Cards = 1px border on `bg.elevated`, 12px radius, no shadow. The only expressive light is the honey/pollinate glow on one focused element.
- Every recalled memory shows its **source** and **score**. Claims carry evidence.
