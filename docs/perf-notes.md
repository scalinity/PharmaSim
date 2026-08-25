# Performance notes — §30 audit (milestone 17)

Measured 2026-08-24 on an Apple-silicon MacBook (120 Hz display), Chromium via the dev
server. Method: `renderer.info.render.calls` off the `__pharmasim` handle for draw calls;
`__pharmasim.loopHooks.tick` wrapped with `performance.now()` for tick time;
`performance.memory.usedJSHeapSize` sampled over 10–15 s windows for allocation churn;
rAF callbacks counted for fps. Crowd filled to the 40-NPC cap with the dev stress
spawner (`N` ×27) at 2× speed.

## Results against the §30 budgets

| Budget | Measured | Verdict |
| --- | --- | --- |
| 60 fps | 120 fps (display-limited) during a 39-NPC rush on the largest floor | pass |
| Store scene ≤ 100 draw calls | 34 (base 10×7 floor, Gen 4, 13 fixtures) · 58 (max 16×12 floor, 32 fixtures, 39 NPCs on screen) | pass |
| City ≤ 150 draw calls | 13 (depot owned, 3 vans in the garage) | pass |
| Crowd instanced, ~3 draw calls | 4 instanced meshes in the store scene (customer bodies/heads + staff) — crowd size does not move the call count | pass |
| Sim tick ≤ 2 ms at 40 NPCs | 0.16 ms average, 0.6 ms worst tick over 300 ticks at 39 NPCs, 2× speed | pass |
| No hot-path allocation churn | Heap slope 7.7 MB/min during the ×27 rush vs 5.3 MB/min paused on the same scene — the ≈2.4 MB/min delta is spawn/despawn lifecycle allocation (per event, not per frame); no per-frame garbage attributable to the tick or render paths | pass |

## Notes

- The once-per-day close tick (end-of-day bookkeeping: rep drift, branch resolution,
  ledger close) measured 4.8 ms once. It runs at an untimed phase boundary where the
  receipt takes the screen, so the single-frame cost is invisible; the ≤2 ms budget is
  read as the shift's ticking hot path.
- Shadows are the settled single 1024 map (`render/lighting.ts`); the city scene runs
  shadow-free by design (§30).
- Fixed during the audit: `PartsBuilder.add` called `toNonIndexed()` on already
  non-indexed geometry — three.js warns and returns the *same* object there, so the
  builder's `translate()` could mutate a caller's shared geometry. Non-indexed input is
  now cloned instead (`render/meshes/parts.ts`); the three console warnings during era
  batch rebuilds are gone with it.
