# README and Brand Assets

> Category: Standards | Version: 1.1 | Date: July 2026 | Status: Active

How brand, hero, and partner logos are stored under `assets/logos/` and rendered in `README.md` so they stay legible on both GitHub's light and dark themes. Read this before adding or editing any logo in the README.

**Related:**
- [Documentation Framework](documentation-framework.md)
- [Source: `README.md`](../../../../README.md)
- [Source: `assets/logos/`](../../../../assets/logos/)

---

## Why This Exists

GitHub renders `README.md` against two backgrounds: the light theme (white) and the dark theme (`#0d1117`). A single logo file cannot satisfy both. A wordmark that is legible on white can vanish on dark, and the failure is silent: the markup is valid, the image loads, and the asset only disappears for readers on the theme the author was not using.

This bit the Activeloop partner logo in the README PARTNERS strip. The Activeloop SVG was a bare `<img>` pointing at a single file whose wordmark class (`.st0`) declared no `fill`. SVG defaults an unstyled fill to black, so the orange ring (which uses gradients) stayed visible while the "activeloop" text rendered black on the dark background and disappeared. The fix mirrored the pattern already used by the Honeycomb hero logo and the Legion logo: ship a dark-specific variant and swap it in with a `<picture>` media query.

---

## The `<picture>` Swap Pattern

Every logo in the README that carries text or dark linework must be wrapped in a `<picture>` element that offers a dark-theme source and falls back to the light file as the default `<img>`:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="assets/logos/activeloop-full-mark-logo-on-dark.svg">
  <img src="assets/logos/activeloop-full-mark-logo.svg" alt="Activeloop" height="26">
</picture>
```

The rules:

1. The `<source>` carries `media="(prefers-color-scheme: dark)"` and points at the dark variant via `srcset`.
2. The `<img>` is the light/default file and must always carry `alt` text and an explicit `height`. The `<img>` is also the fallback for clients that ignore `<picture>`.
3. Light mode is the default; the dark variant only overrides when the reader prefers dark.

The three logos in the README all follow this pattern today: the Honeycomb hero wordmark, the Legion logo, and the Activeloop partner mark.

## The Dark Variant Is a Minimal Diff

A dark variant is the light SVG with only the text/linework fills changed to a light color. Do not restyle the whole asset. For the Activeloop mark, the dark file is identical to the light file except `.st0` gets `fill: #F2F3F5`, the same muted white the Legion logo uses on dark. The gradient-filled ring is untouched because gradients already render on both themes.

The lesson generalizes: an SVG element with no explicit `fill` inherits SVG's black default and will disappear on dark. When authoring or accepting a new logo, check every text and line element for an explicit `fill` rather than trusting the rendered preview, which only shows one theme at a time.

## Asset Naming and Storage

All logos live in `assets/logos/`. The repo uses two naming conventions for the dark/light pair:

- `<name>-on-dark.svg` paired with `<name>.svg` (the light file is the unsuffixed default). This is the preferred convention for new assets, used by `honeycomb-memory-cluster-wordmark-on-dark.svg` and `activeloop-full-mark-logo-on-dark.svg`.
- `<name>-light.svg` paired with `<name>-dark.svg` (both variants suffixed), used by the older `legion-logo-light.svg` / `legion-logo-dark.svg`.

Prefer the `-on-dark` suffix on new work so the unsuffixed file remains the canonical light default. Keep the light and dark files byte-for-byte identical apart from the fill changes, so a future edit to one is trivial to mirror to the other.

## Checklist for a New or Edited README Logo

1. Does the logo carry text or dark linework? If yes, it needs a dark variant. A logo that is already light-on-transparent and legible on both themes can stay a bare `<img>`.
2. Author the dark variant as a minimal fill-only diff of the light file, using `#F2F3F5` for wordmark text to match the existing logos.
3. Store both files in `assets/logos/` using the `-on-dark` naming convention.
4. Wrap the README markup in a `<picture>` with a `prefers-color-scheme: dark` source and a light-default `<img>` that has `alt` and `height`.
5. Verify both themes by toggling GitHub's appearance setting, not just the one you author in.
6. Check that the SVG `viewBox` is trimmed to the artwork's real content bounds. GitHub centers a logo by centering its whole canvas, so transparent padding baked asymmetrically into the `viewBox` (a wide right-side margin, for example) makes the visible mark sit off-center even though the markup looks centered. Trim each `viewBox` to the measured content bounds plus symmetric padding, with only a small right-side allowance on text for font-fallback variance (PR #221 fixed exactly this on the wordmark and Legion lockup SVGs).
