# Milestone 11 — Events + atmosphere

One-session brief. **Read first**: `SPEC.md` §16 (every event), §26 (event numbers), §14
(outage/spoilage/generator interplay), §5 (calendar), §27 (lighting arcs, outage look), §28
(Ticker component, clock strip rush shading). The news ticker is a new HUD element: follow §28;
a light frontend-design check is enough unless you redesign the top bar.

## State you inherit

Milestones 01–10: the complete single-store game across eras. The calendar exists (§5) but
seasons have no teeth; the generator idles; lighting runs a plain day arc.

## Goal

Days stop being identical: seasons reshape demand, flu season packs the store and the vaccine
queue, shortages squeeze margins and cap supply, storms threaten the cold chain, rush hours are
visible on the clock, and a news ticker narrates it all in one-line headlines.

## Non-goals

No competitor reactions to shortages (13 hooks into these events later), no multi-store stock
juggling (15). Don't add new customer types.

## Tasks

1. `sim/events-world.ts` (§16): a day-boundary scheduler (seeded RNG) owning seasons and event
   spawns; active-effect state consumed by demand generation, ordering, and lighting.
2. Seasons (§16/§26): spring allergy (OTC allergy ×2.5, respiratory Rx ×1.3), summer lull
   (visitors ×0.9), fall pediatric antibiotics ×1.4, winter flu (resp+abx Rx ×1.8, OTC coldflu
   ×3, vaccine walk-ins ×4, visitors ×1.2). Season chip in the top bar day chip; winter edge
   dimming (§27).
3. Regional shortage (1–2/season, 4–8 days): one Rx category wholesale ×1.5 and order fills
   capped at 60%; Orders panel flags affected SKUs with the squeezed (possibly negative) margin
   in rose (§10); ticker announces start/end with the category named.
4. Storm + outage (1–2/year): forecast on the *previous* day's receipt ("Storm expected
   tomorrow" pinned note — generators are buyable in response, §16); on the day: rain ambience
   hook (silent until 17), outage window 2–5 igh — key light to 20% cold (§27), visitors ×0.6;
   at outage start, stores without a working generator lose all refrigerated stock (receipt
   line "spoilage — refrigerated stock", ledger loss at wholesale value); with a generator,
   a reassuring hum note instead.
5. Rush hours get visible (§16/§28): clock strip shades 12:00–14:00 and 17:00–19:00; the ×1.6
   arrival bump has existed since 03 — now the player can see it coming.
6. **News ticker** (§28): Plex Mono strip (top bar underside or bottom — your §28-consistent
   call) cycling active headlines: season turns, shortages, storms, legacy moments, and (later)
   competitor moves; each with the in-game date.
7. Dev event console: keyboard/debug commands to force each event type for testing (documented
   in the README's dev section).
8. Save migration (active events, season effects — bump version).

## Acceptance criteria

- [ ] A full 56-day year (2× speed + dev fast-forward is fine) shows all four seasons acting on
      demand exactly per §26 multipliers (spot-check flu-season vaccine walk-ins ×4).
- [ ] Forced shortage: affected category's wholesale ×1.5, fills capped 60%, rose-flagged
      margins, ticker start/end headlines; unaffected categories untouched.
- [ ] Forced storm: forecast note the day before; outage dims the world and empties the floor
      (~×0.6); without a generator all refrigerated stock spoils with the correct ledger loss;
      with one, nothing spoils.
- [ ] Rush shading matches the actual arrival bumps; ticker cycles cleanly without layout shift.
- [ ] Old saves migrate; zero console errors; 60 fps including outage lighting swaps.

## Boundaries (standing)

Dev server only (`npm run dev`); never run build/compile commands. No React, no `useEffect`.
`sim/` imports nothing from render/ui/platform. TypeScript strict. Implement exactly this brief.
Leave the repo runnable and clean.

## Handoff to 12

The world has weather and stories. 12 gives it geography: the city map and the district demand
engine that has been waiting underneath since milestone 3.
