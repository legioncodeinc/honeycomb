`Button` — the Honeycomb action button. Use it for any click action; honey primary is the single brand action per region (scarcity rule), the rest are secondary/ghost.

```jsx
<Button variant="primary" onClick={recall}>Recall</Button>
<Button variant="secondary" size="sm">Sessions</Button>
<Button variant="ghost">Dismiss</Button>
<Button variant="pollinate" iconLeft={moonIcon}>Pollinate now</Button>
```

Variants: `primary` (honey), `secondary` (elevated + border), `ghost`, `pollinate` (violet, for the Pollinating loop), `danger`. Sizes `sm | md | lg`. Supports `iconLeft` / `iconRight`, `disabled`.
