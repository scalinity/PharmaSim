# Milestone 09 — Cold chain + vaccinations

One-session brief. **Read first**: `SPEC.md` §14 (cold chain + vaccination service — the whole
section), §25 (refrigerated SKUs incl. `fluVaxDose`), §26 (fridge capacity, vaccine numbers),
§9 (pharmacist runs the station), §7 (the 5% vaccine walk-in share activates). UI here is small
(station queue, fridge capacity meter) — follow §28 tokens; do a frontend-design pass only if
you introduce a new panel.

## State you inherit

Milestones 01–08: automated, licensed, expandable store. L4 may already be owned but does
nothing yet; `fridge_medical`, `vaccine_station`, and `generator_backup` exist as furniture defs
(placeable, inert).

## Goal

The refrigerated dimension of pharmacy: fridges gate an entire drug category including the
modern blockbusters, the vaccine station turns the pharmacist into a clinician with a real
scripts-vs-shots tension, and the generator waits quietly for 11's storms.

## Non-goals

No outage events (11 — the generator is purchasable insurance that does nothing yet; its
palette row may say "peace of mind"), no flu-season ×4 multiplier (11), no spoilage of any kind
this session.

## Tasks

1. Fridge capability (§14): placed `fridge_medical` (backroom) unlocks ordering/stocking
   refrigerated SKUs (§25 group — insulins, semaglutide, `fluVaxDose`); capacity 40 units per
   fridge, enforced at order time (Orders panel shows fridge space); refrigerated bins render
   inside the fridge; fills target it like any bin. Without a fridge, refrigerated rows show
   "requires medical refrigeration".
2. Refrigerated demand: diabetes-category generation now includes insulin/semaglutide scripts
   once stockable (§17 generation respects capability, mirroring 08's license rule).
3. Vaccination service (§14): requires L4 + fridge + placed `vaccine_station` + a pharmacist on
   duty. Walk-in vaccine customers (3–6/day base; §7 mix share activates) path to the station's
   own short queue; service = 15 igm by the pharmacist (auto when stationed/free; the player
   can work the station too), consumes one `fluVaxDose` (ordered like stock), credits $30
   reimbursement (net +$22), +0.01 rep. No dose in stock → walk-in leaves (−0.06 walk-out).
4. The staffing tension (§14): pharmacists prioritize the verify queue over the vaccine queue;
   the vaccine queue shows the amber bottleneck ring like any station (§8) so the player sees
   when a second pharmacist earns their wage.
5. Fridge capacity meter: small blister-pip meter (§28) on fridge hover and in Orders.
6. Generator (§14): placeable, powered ($2/day idle utilities per §10), zero behavior — wired
   in 11.
7. Save migration (fridge stock, station state — bump version).

## Acceptance criteria

- [ ] Refrigerated SKUs are unorderable without a fridge, capacity-capped with one (40), and
      doubled with two; the meter reads correctly.
- [ ] Insulin/semaglutide scripts appear only once stockable and fill from the fridge with
      correct §25 money (semaglutide margin $35).
- [ ] With L4 + fridge + station + pharmacist: walk-ins queue, get vaccinated in 15 igm, consume
      doses, net +$22 each on the ledger; out-of-dose walk-ins leave with the walk-out penalty.
- [ ] A busy verify queue visibly starves the vaccine queue (bottleneck ring), and a second
      pharmacist assigned to the station resolves it.
- [ ] Missing any prerequisite shows the exact reason in the palette/panel rows.
- [ ] Old saves migrate; zero console errors; 60 fps.

## Boundaries (standing)

Dev server only (`npm run dev`); never run build/compile commands. No React, no `useEffect`.
`sim/` imports nothing from render/ui/platform. TypeScript strict. Implement exactly this brief.
Leave the repo runnable and clean.

## Handoff to 10

The store's capabilities are complete for a single location. 10 makes it *feel* owned across
time: era renovations, decor, and the legacy album.
