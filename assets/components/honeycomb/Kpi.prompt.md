`Kpi` — dashboard metric tile. One big mono value with a label and optional week-over-week delta.

```jsx
<Kpi label="Memories" value="1,284" delta={12} />
<Kpi label="Sessions" value="312" accent="neutral" />
<Kpi label="Est. savings" value="2.4" unit="M tok" accent="verified" delta={8} />
```

`accent`: honey | pollinate | verified | neutral. Pass `delta` for the trend line (▲ green / ▼ red).
