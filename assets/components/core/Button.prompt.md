`Button` — the Honeycomb action button. Use it for any click action; honey primary is the single brand action per region (scarcity rule), the rest are secondary/ghost.

```jsx
<Button variant="primary" onClick={recall}>Recall</Button>
<Button variant="secondary" size="sm">Sessions</Button>
<Button variant="ghost">Dismiss</Button>
<Button variant="dream" iconLeft={moonIcon}>Dream now</Button>
```

Variants: `primary` (honey), `secondary` (elevated + border), `ghost`, `dream` (violet, for the Dreaming loop), `danger`. Sizes `sm | md | lg`. Supports `iconLeft` / `iconRight`, `disabled`.
