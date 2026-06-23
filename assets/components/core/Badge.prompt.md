`Badge` — compact status pill for memory and session states.

```jsx
<Badge tone="verified" dot>source-backed</Badge>
<Badge tone="honey" mono>recalled</Badge>
<Badge tone="pollinate" dot>pollinating</Badge>
<Badge tone="neutral" mono>12 events</Badge>
```

Tones map to the semantic palette: `verified` (green, source-backed), `honey` (brand), `pollinate` (consolidation), `info | warning | critical`, `neutral`. `mono` for ids/counts; `dot` adds a leading status dot.
