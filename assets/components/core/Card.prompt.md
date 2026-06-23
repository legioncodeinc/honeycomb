`Card` — surface container. bg.elevated, 1px border, 12px radius, no shadow. Use `glow` to lift one focused card.

```jsx
<Card>…</Card>
<Card glow="honey" padding={24}>Active recall hit</Card>
<Card interactive>Hover to brighten</Card>
```

`glow`: `none | honey | pollinate`. `interactive` brightens the border on hover. Cards never use drop shadows except the honey/pollinate glow.
