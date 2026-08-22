# Milestone 12 — City map + living demand

One-session brief. **Read first**: `SPEC.md` §17 (the whole city/demand model — this milestone
*is* §17), §26 (rep multiplier interplay), §27 (city map art), §28 (city overlay screen), §30
(city draw-call budget). The city overlay + reports panel are major UI: **read and follow the
frontend-design skill first**.

## State you inherit

Milestones 01–11: the complete single-store game with events. Demand has been generated from a
hard-wired Old Town profile since 03; `data/districts.ts` has carried all six districts since
then.

## Goal

The world becomes a place: a low-poly city map scene with six characterful districts and their
facilities, a demand engine that generates per-district, per-category scripts and routes them by
attractiveness (proximity, reputation, price, availability), and a reports panel where the
player learns their neighborhood. The store's traffic now *earns* itself.

## Non-goals

No competitors (13 — route against a single static "elsewhere" sink this session), no branch
buying (14 — lots render but aren't purchasable), no trucks (15). District data may be tuned but
the schema is fixed (§24).

## Tasks

1. `render/cityScene.ts` (§27): districts as tinted blocks of instanced extruded buildings,
   sage park discs, flat road ribbons connecting districts (roads matter for 15's trucks —
   store polylines in `data/districts.ts`), facility landmarks (hospital, nursing home, campus…
   simple iconic massing), the player store marked with a pine cross. Scene toggle: **City**
   dock pill (key `C` per §28) swaps scenes with a soft transition; same camera rig behavior,
   wider zoom clamps.
2. `sim/city.ts` (§17): daily per-district demand — `pop × prevalence[cat] × seasonMult ×
   noise` scripts per category plus OTC intent; facility bonuses (§17 table; nursing home emits
   weekly chronic batches). Events (11) plug in: flu/allergy multipliers apply per category.
3. Routing (§17): attractiveness `A = 0.35·proximity + 0.30·(rep/5) + 0.15·priceScore +
   0.20·availability` with share = A²/ΣA²; competitors are one static "elsewhere" pharmacy
   (constant A) until 13. The store's §7 visitor schedule now comes from routed district demand
   (remove the hard-wired baseline; §26's 20/day emerges from Old Town at 2.5★ — verify and
   tune the constant A so it does).
4. `fillRate7d` (recorded since 05) now feeds availability; low stock genuinely bleeds traffic
   with a few days' lag. Price index (05) feeds priceScore.
5. City overlay UI (frontend-design pass): hovering a district shows its card — name,
   population, skew, facility list, *observed* demand mix (only categories the player has seen
   demand for — knowledge builds by playing, §17 "learn your neighborhood"); the store shows
   its share trend arrow.
6. Reports panel (dock): per-category demand vs fills for the store's reachable districts
   (7/28-day windows, Plex Mono tables, trend arrows) — the "we keep running out of
   amoxicillin" discovery surface.
7. Save migration (city/district state, observed-demand memory — bump version).

## Acceptance criteria

- [ ] The city renders all six districts + facilities + roads at 60 fps within §30 budgets;
      scene switching is smooth and the store marker is findable at a glance.
- [ ] With defaults, Old Town at 2.5★ routes ≈20 visitors/day as before (no difficulty cliff
      from the engine swap); dev-lowering rep or fill rate visibly bleeds traffic within days;
      cutting OTC prices measurably shifts share.
- [ ] District demand profiles act: Sunset Glen skews chronic/anticoagulant, University Heights
      skews acute — visible in the reports panel after a few played days.
- [ ] Flu season (11) amplifies the right categories per district through the new engine.
- [ ] District cards reveal demand knowledge progressively, not omnisciently.
- [ ] Old saves migrate (observed-demand starts empty); zero console errors.

## Boundaries (standing)

Dev server only (`npm run dev`); never run build/compile commands. No React, no `useEffect`.
`sim/` imports nothing from render/ui/platform. TypeScript strict. Implement exactly this brief.
Leave the repo runnable and clean.

## Handoff to 13

A living city routes demand to one pharmacy. 13 makes it contested: four rivals with stats,
drift, and prescription transfers.
