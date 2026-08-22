# Milestone 08 — Licenses + expansion

One-session brief. **Read first**: `SPEC.md` §12 (licenses), §6 (expansions), §25 (Tier-2/3
SKUs), §11 (ordering gates), §8 (controlled scripts still verify like any other), §22 (license
purchases are legacy moments — flavor hooks land in 10, but emit the events now). The license
panel is a new screen: **read and follow the frontend-design skill first** (§12 suggests
certificates on an office wall — take the skill's pass on that idea).

## State you inherit

Milestones 01–07: automated store with staff, durable saves, Tier-1-only demand and ordering.

## Goal

Progression opens up: licenses become purchasable capability gates (Tier-2 formulary, controlled
substances with their cabinet, plus the L4/L5/L6 certificates visible-but-locked), and the floor
itself can grow through the four §6 expansions. The demand generator starts writing scripts the
store is licensed to fill.

## Non-goals

No vaccine *service* (L4 is purchasable; the station/flow arrive in 09 — say so in its row), no
branch buying (L5 gates UI that appears in 14), no DC (L6 likewise). No era gating (renovation
is 10).

## Tasks

1. `sim/licenses.ts` (§12): account-wide license state; `license.buy` with cash + star gates;
   L2/L3 change what the demand generator draws (§17 generation only emits SKUs covered by
   licenses — unlicensed demand implicitly goes elsewhere) and what the Orders panel lists.
2. Controlled substances (§25 Tier 3): require L3 **and** a `cabinet_controlled` placed in the
   backroom; Tier-3 bins live in the cabinet (fill interaction targets it); without the cabinet,
   Tier-3 SKUs stay unorderable with the reason shown. Controlled scripts flow through the
   normal §8 stages.
3. Licenses panel (frontend-design pass): the six §12 certificates with cost, star gate, and
   unlock text; owned ones framed proudly; locked ones show exactly what's missing (stars, cash,
   prerequisites). L4 row notes "station and service arrive with equipment" (bought here, used
   in 09); L5/L6 rows visible from the start as aspiration.
4. Floor expansions (§6/§26): E1–E4 purchasable from the Build palette; buying rebuilds the
   shell (walls/floor grow, door stays south-center), extends the grid and backroom derivation,
   and preserves placed furniture; expansion is morning-only (grid changes mid-shift would
   break paths).
5. Demand growth: wire visitor baseline to formulary breadth naturally — Tier-2/3 scripts add
   to Rx volume per §17 category generation (no artificial multiplier; more fillable categories
   = more scripts routed to you).
6. Emit `legacy`-worthy events (`license.bought`, `expansion.bought`) on the bus for 10 to
   consume; record in `stats`.
7. Save migration (licenses, cabinet, grid size — bump version).

## Acceptance criteria

- [ ] L2 purchase (dev-grant stars if needed) → Tier-2 SKUs appear in Orders, Tier-2 scripts
      start arriving; before purchase they never spawn.
- [ ] L3 without cabinet: Tier-3 unorderable with reason; place cabinet → orderable, scripts
      arrive, fills target the cabinet bins with confusables intact (tramadol/trazodone).
- [ ] Each expansion grows the interior per §26, keeps furniture, re-derives the backroom zone,
      and pathfinding keeps working (stress a full floor).
- [ ] Locked certificates state their exact missing requirements; buying updates cash and the
      panel immediately.
- [ ] Old saves migrate; zero console errors; 60 fps on the largest floor.

## Boundaries (standing)

Dev server only (`npm run dev`); never run build/compile commands. No React, no `useEffect`.
`sim/` imports nothing from render/ui/platform. TypeScript strict. Implement exactly this brief.
Leave the repo runnable and clean.

## Handoff to 09

Licenses and space exist; L4 is purchasable but dormant. 09 wakes it up: the fridge, refrigerated
stock, the vaccine station, and the generator.
