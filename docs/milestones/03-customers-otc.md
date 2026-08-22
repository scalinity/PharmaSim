# Milestone 03 — Customers + OTC flow

One-session brief. **Read first**: `SPEC.md` §7 (customers/archetypes), §17 intro + Old Town row
(demand comes from the district model from day one), §26 (visitors, patience, task durations,
rep deltas), §27 (people, feedback), §11 first bullet (shelved stock), §30 (instancing budget).
Minor UI (patience rings, station interaction hints): follow §28 tokens; no full frontend-design
pass needed unless you add a new panel.

## State you inherit

Milestones 01–02: day loop with phases and speeds, editable store with grid/pathfinding/stations,
build mode, HUD frame.

## Goal

The store comes alive: pooled, instanced low-poly customers arrive on a district-driven schedule,
browse stocked OTC shelves, queue at the register, pay, and leave — or walk out when patience
dies. The player works the register personally. Money starts moving.

## Non-goals

No prescriptions (04), no ordering/pricing UI (05), no staff (07), no seasons/rush *visuals*
(11 — but the ×1.6 lunch/evening arrival bumps from §7/§16 are part of the spawn curve now).
Reputation applies its §15 deltas but gates nothing yet.

## Tasks

1. `data/otc.ts` (full §25 OTC catalog), `data/districts.ts` (all six districts per §17 — only
   Old Town consumed for now), `data/names.ts` (fictional first/last name pools).
2. `sim/customers.ts`: per-shift visitor scheduling
   `N = baseVisitors × repMult × dayNoise` with lunch/evening bumps (§7); archetype assignment
   (§7 table); OTC-only mix for now (treat the §26 Rx/vaccine share as OTC until 04).
   Customer state machine: enter → browse (pick 1–4 target shelves by stock/archetype) →
   queue → pay → exit. Patience per §26, half drain while seated on a free waiting chair;
   walk-out at zero applies §15 rep deltas (Hurried −0.09) and emits events.
3. Shelf stock (thin slice of §11): OTC shelves hold 4 SKUs × 24 units; the state factory seeds
   the §26 starter stock across starting shelves; each purchase decrements; empty slots can't be
   browsed into a basket. (Backroom/ordering arrives in 05.)
4. Basket + checkout: baskets accumulate at MSRP ×1.0 (pricing UI is 05); Bargain skip rules
   held until pricing exists. Register is a station: the player clicks it to work it
   (`station.workHere`), auto-serving the queue at 4 igm per customer while stationed; clicking
   elsewhere leaves the post. Sales credit cash and emit `sale.completed`.
5. `render/npcView.ts` (§27): InstancedMesh capsule body + sphere head + archetype accent
   (≤3 draw calls for the crowd), position interpolation between sim ticks, walk bob, carried
   bag box after checkout. Patience ring: overhead shrinking arc, green→amber→rose.
6. Queue rendering: queue slots line up from the register; customers shuffle forward; a small
   count chip floats over the register when queue ≥ 4 (amber, §27).
7. End-of-day placeholder panel now reports: visitors, sales, walk-outs, revenue, rep delta.
8. Dev stress toggle (`N` key ×3 spawn) to verify the 40-NPC budget at 60 fps.

## Acceptance criteria

- [ ] ~20 customers/day arrive on a bumpy curve (denser 12:00–14:00 and 17:00–19:00); archetype
      shares roughly match §7 over a few days.
- [ ] Customers path around furniture, browse only stocked shelves, sit on free chairs while
      queues are long, and walk out at zero patience with rep loss and an exit animation.
- [ ] Working the register serves the queue at 4 igm each; leaving it stops service; cash rises
      per basket; empty shelves visibly stop contributing items.
- [ ] Patience rings and queue chips read clearly at default zoom.
- [ ] Stress toggle: 40 concurrent NPCs at 60 fps, ≤3 crowd draw calls.
- [ ] Full day loop with the new report; zero console errors.

## Boundaries (standing)

Dev server only (`npm run dev`); never run build/compile commands. No React, no `useEffect`.
`sim/` imports nothing from render/ui/platform. TypeScript strict. Implement exactly this brief.
Leave the repo runnable and clean.

## Handoff to 04

Living customers, stations, stock, money, reputation deltas. 04 adds the prescription stage
queues, the pick-the-right-bin fill interaction, and the real end-of-day receipt.
