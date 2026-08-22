# Milestone 15 — Distribution + logistics

One-session brief. **Read first**: `SPEC.md` §20 (DC/trucks/transfers — the whole section), §12
(L6 gate), §26 (DC/truck numbers), §27 (trucks on roads, depot), §11 (how DC ordering wraps the
existing pipeline), §16 (shortages are what transfers answer). Route drafting is a new
interaction surface: **read and follow the frontend-design skill first**.

## State you inherit

Milestones 01–14: a multi-branch network where every branch orders independently; roads exist as
polylines in `data/districts.ts` (12); L6 sits locked behind L5 + 2 branches.

## Goal

The empire gets a supply chain: a distribution center building with central purchasing at −12%,
a small truck fleet running drafted morning routes that visibly drive the city, and
branch-to-branch transfer orders — the tool that turns shortages from misery into logistics
puzzles.

## Non-goals

No route optimization/autopilot (drafting is manual and simple), no truck upgrades or additional
vehicle types (§32), no DC expansion tiers. Direct store ordering must remain fully functional
(§20 — the DC is a capability, not a chore gate).

## Tasks

1. DC purchase (§20): with L6, a depot lot on the city map sells for $60,000; buying places the
   §27 gray depot with garage. DC state per §24: its own stock pool, truck list.
2. Central purchasing (§20/§11): the Orders panel gains a **DC order** scope — the wholesale
   catalog at −12% (stacking replaced, not compounded: DC price replaces supplier-tier price),
   delivered to DC stock next morning. Store-scope ordering stays untouched.
3. Trucks (§26): buy at $8,000 each (garage UI at the depot); capacity 400 units; each runs one
   morning route of ≤3 stops.
4. Route drafting (frontend-design pass): per truck, an ordered stop list built from branches;
   per stop, allocate SKU quantities from DC stock (a picking list — Plex Mono table with
   remaining-capacity meter as blister pips §28). Routes persist day to day; morning executes
   them: goods leave DC stock, arrive as each truck reaches its stop (guaranteed same-day, §20).
5. Transfer orders (§20): from any branch's Orders view or the reports panel, draft
   branch→branch moves; they compile into truck stops (pickup at source, drop at target) within
   capacity; UI shows the shortage context ("Riverside is out of amoxicillin — Downtown holds
   300").
6. Truck visuals (§27): two-box vans sliding along road polylines during the shift (flavor —
   arrivals are morning-guaranteed regardless of animation); depot/truck markers on the map;
   `truck.arrived` events feed the ticker quietly (first arrival per truck per day only).
7. Legacy hook: DC opening fires its §22 moment.
8. Save migration (DC, trucks, routes — bump version).

## Acceptance criteria

- [ ] L6 + $60k buys the depot; DC ordering lands stock in DC inventory at −12% (verify one SKU
      against §25 math; supplier-tier discount does not stack).
- [ ] A drafted 3-stop route delivers allocated quantities to the right branches next morning;
      capacity 400 is enforced at draft time with clear feedback.
- [ ] A transfer order moves stock branch→branch via a truck and resolves a forced local
      stock-out; the receiving branch's fill rate recovers.
- [ ] During a forced shortage (11), the DC + transfer loop demonstrably outperforms
      independent ordering (capped fills hit the DC order once, not per store).
- [ ] Trucks animate along roads without affecting sim correctness; direct store ordering still
      works everywhere.
- [ ] Old saves migrate (no DC); zero console errors; city stays 60 fps with 4 trucks moving.

## Boundaries (standing)

Dev server only (`npm run dev`); never run build/compile commands. No React, no `useEffect`.
`sim/` imports nothing from render/ui/platform. TypeScript strict. Implement exactly this brief.
Leave the repo runnable and clean.

## Handoff to 16

The full machine exists: store → network → market → supply chain. 16 crowns it with the AI
modules and balances the entire arc.
