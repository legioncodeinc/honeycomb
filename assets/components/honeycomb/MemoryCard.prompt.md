`MemoryCard` — the signature Honeycomb surface. One recalled or stored memory: hex cell, key, snippet, provenance, score.

```jsx
<MemoryCard
  memoryKey="deploy/prd-022"
  snippet="We deploy from the prd-022 branch, never from main."
  source="~/.honeycomb/memory/deploy.md"
  score={0.94}
  scope="team"
  verified
/>
<MemoryCard memoryKey="auth/token-drift" snippet="Re-mint on org switch." dreaming />
```

`verified` shows the green source-backed state; `dreaming` shows the violet consolidation pulse. `scope`: personal | team | org.
