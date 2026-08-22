# Milestone 13 — Competitors + market share

One-session brief. **Read first**: `SPEC.md` §18 (competitors — the whole section), §17
(routing they join), §16 (shortage hook), §22 (first transfer-in wave is a legacy moment), §28
(ticker voice for rival moves). UI is mostly additions to existing surfaces (map markers,
reports); follow §28 — frontend-design pass only if you add a new panel.

## State you inherit

Milestones 01–12: the living city routing demand between the player store and a static
"elsewhere" sink.

## Goal

The market fights back: four fictional rivals with distinct identities join the routing engine,
drift smarter every four weeks, suffer shortages like everyone else, and — through the chronic
patient pools — visibly win and lose prescription transfers against the player. The "elsewhere"
sink dies.

## Non-goals

Competitors never get interiors, never go bankrupt, never open locations (§18/§32). No player
actions against rivals (no price wars UI — the player competes through §17's levers they
already own).

## Tasks

1. `data/competitors.ts` + `sim/competitors.ts` (§18): the four rivals with their §18 stat
   blocks, placed in home districts on the map (MediMart–Downtown, GreenCross–Riverside,
   QuickScripts–University Heights, Harbor Apothecary–Old Town: the hometown rival — confirm
   placement feels fair in play, it's data). Replace the routing sink: all pharmacies compete
   per §17 with `availability = stockReliability ± event effects`.
2. Chronic patient pools (§18/§24 `patientPools`): per-district pools of monthly refill scripts
   by category, each pool assigned to a pharmacy. Two bad experiences at the player store
   (walk-out, stock-out refusal, dispensed error — tracked per §18) move a pool's refills to
   the best-scoring rival; weekly evaluation also *pulls* pools in when the player outscores
   the holder on sustained availability + rep. Pools showing up as recognizable repeat
   customers (same name, same drug) is the human face of this system — reuse `data/names.ts`
   identities per pool.
3. Drift (§18/§26): every 28 days the lowest-share rival improves one notch (price cut, rep
   +0.25, or reliability    +0.05, whichever is worst) — ticker headline names the move
   ("MediMart renovates its Downtown location"). Shortages (11) cut all rivals' reliability
   −0.15 while active — shortage weeks are share-grab opportunities for a well-stocked player.
4. Map + reports surfaces: rival markers with accent colors + star ratings on the city map;
   district cards show each pharmacy's share bar; the reports panel gains **Transfers in/out
   this week** with named patients and reasons ("Marta R. — two stock-outs → QuickScripts"),
   per §18's legibility promise.
5. Legacy hook (§22): first net transfer-in week fires its flavor moment.
6. Receipt addition: a one-line market note when share moved meaningfully that day (±2%+ in
   any district).
7. Save migration (competitor states, patient pools — bump version).

## Acceptance criteria

- [ ] All routing flows through the four rivals (sink removed); shares per district sum to 1
      and respond to rep/price/availability changes within days.
- [ ] Two forced bad experiences on a chronic patient move their refills to a named rival,
      visible in Transfers with the reason; sustained good performance pulls pools back.
- [ ] 28-day drift fires, targets the weakest rival's weakest stat, and headlines correctly.
- [ ] During a forced shortage, rival reliability drops; a stocked player store measurably
      gains share that week.
- [ ] District cards and reports show shares/transfers clearly at a glance; the receipt's
      market note appears only on meaningful moves.
- [ ] Old saves migrate (pools initialize assigned by launch-day scores); zero console errors;
      60 fps.

## Boundaries (standing)

Dev server only (`npm run dev`); never run build/compile commands. No React, no `useEffect`.
`sim/` imports nothing from render/ui/platform. TypeScript strict. Implement exactly this brief.
Leave the repo runnable and clean.

## Handoff to 14

A contested market with legible wins and losses. 14 lets the player answer territorially: buying
and running branches.
