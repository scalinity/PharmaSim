# Milestone 02 — Store grid + placement

One-session brief. **Read first**: `SPEC.md` §6 (store/grid/furniture), §4 (layer rules), §26
(costs), §27 (feedback colors), §28 (component kit). Build-palette UI is real UI work: **read and
follow the frontend-design skill before building it** (§28 is the settled brief).

## State you inherit

Milestone 01: running chassis — fixed-timestep sim with day phases, event bus, orthographic
camera rig, Gen 1 store shell placeholder, HUD top bar with time controls, Panel/PillButton
components, design tokens.

## Goal

The store becomes a real editable space: a 10×7 grid inside a procedural Gen 1 shell, a build
mode with ghost preview to buy/place/rotate/move/sell furniture, placement validation, and A*
pathfinding with a debug overlay. This is the systemic foundation for every NPC milestone.

## Non-goals

No customers or staff, no stock on shelves (furniture is geometry + occupancy only), no floor
expansions (define costs in data; purchasing arrives with licenses in 08), no era reskins.

## Tasks

1. `core/grid.ts`: cell math, footprint rotation, occupancy map, world↔cell transforms
   (1 cell = 1 m, store interior 10×7, door centered on the south wall).
2. `core/pathfind.ts`: A* over walkable cells, 4-directional, with a cheap re-path API.
3. `data/furniture.ts`: every `FurnitureDef` from the §6 table including future-gated items
   (`requires` fields present; gating enforced in the palette). Zones per §6.
4. `render/storeScene.ts` + `render/meshes/`: procedural Gen 1 shell (checkerboard floor,
   walnut wainscot walls, door gap, dollhouse camera-facing wall fade per §27) and procedural
   flat-shaded furniture factories for every def (composed boxes/cylinders, era-neutral for now;
   distinct silhouettes per item — counter, shelf, bench, chair, fridge, etc.).
5. Sim: `furniture.place/move/sell` commands with validation — footprint fits, zone rules
   (backroom zone derived from the service counter's line, tinted in build mode), flood-fill
   reachability (door ↔ every station stays connected), cash check; sell refunds 50%. Emits
   events for render/HUD. Starting layout (§6) placed by the state factory.
6. Build mode: entered from a bottom-dock **Build** pill (key `B`); pauses the sim (§5).
   Palette panel (frontend-design pass: §28 paper card, item rows with name/cost/footprint,
   unaffordable and gated items visibly disabled with the reason). Selecting an item spawns a
   grid-snapped ghost following the cursor; `R` rotates; valid = pine tint, invalid = rose tint
   (§27); click places and deducts cost. Clicking placed furniture offers move/sell.
7. Debug path overlay: `P` toggles a drawn A* path from the door to the cell under the cursor,
   rendered as a flat ribbon; proves pathing routes around furniture.

## Acceptance criteria

- [ ] Buy, place, rotate, move, and sell each furniture type; cash updates correctly (50% sell
      refund); unaffordable/gated items are disabled with a reason shown.
- [ ] Backroom-only items refuse public cells and vice versa; the backroom zone is visibly
      tinted in build mode and re-derives when the service counter moves.
- [ ] Placement that would seal off the door or any station is rejected (flood fill), shown as
      rose-tint invalid, with a toast explaining why.
- [ ] Build mode pauses the clock; exiting resumes at the prior speed.
- [ ] `P` overlay draws correct 4-directional paths around obstacles from the door.
- [ ] Starting layout matches §6; day loop from 01 still works end to end; zero console errors;
      60 fps with a fully furnished floor.

## Boundaries (standing)

Dev server only (`npm run dev`); never run build/compile commands. No React, no `useEffect`.
`sim/` imports nothing from render/ui/platform (grid/pathfind live in `core/`, usable by sim).
TypeScript strict. Implement exactly this brief. Leave the repo runnable and clean.

## Handoff to 03

Grid, pathfinding, placement, and stations exist. 03 spawns customers who walk the public cells,
browse OTC shelves, and queue at the register.
