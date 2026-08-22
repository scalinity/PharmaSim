# Milestone 07 — Staff + automation

One-session brief. **Read first**: `SPEC.md` §9 (staff — whole section), §8 (verify desk becomes
real; error/catch flow), §26 (wages, error tables, task durations, pool refresh), §15 (hiring
pool quality gate). The staff panel is a major new screen: **read and follow the frontend-design
skill first** (§28 kit; candidates could read as index cards in the paper language — your call
via the skill's process).

## State you inherit

Milestones 01–06: complete solo-era game with durable saves. The player personally works every
station.

## Goal

The hands-on-to-automated arc begins: hire cashiers, techs, and pharmacists with stats and
traits; they walk the floor and run their stations; the verify desk becomes a real station with
accuracy-based catch rates; wages land on the receipt; the player shifts from doing to
diagnosing (and can still jump on any station).

## Non-goals

No manager role in play (define it in data; it matters for unvisited branches in 14 and the
panel can list it as "for future branches"), no candidate quality scaling below/above thresholds
you can't reach yet — implement the §9 rule and let it be.

## Tasks

1. `sim/staff.ts` (§9): `StaffMember` per §24; hiring pool of 3 candidates/role, refreshed every
   Monday morning (seeded RNG), quality scaling with rep; hire/fire/assign commands; daily wages
   into the ledger (§10).
2. Task AI (§9): staff path to their assigned station and work its queue (task durations ×
   speed curve §26); Stock Hawks restock OTC shelves and Rx bins from backroom between tasks;
   idle staff drift to a break spot. The player clicking a station takes it over; the assigned
   worker resumes when the player leaves.
3. Error model goes probabilistic (§26): tech fills mis-pick by accuracy (Meticulous: never);
   the verify desk (buyable since 02) becomes functional — a pharmacist stationed there checks
   filled scripts at 8 igm with catch % by accuracy; caught scripts bounce to fillQueue.
   Player-owner verification (working the desk or implicit at handoff when no pharmacist)
   stays at 90%.
4. Traits in force (§9): Meticulous, Swift, Charming (+0.01 rep on counsel/checkout), Stock
   Hawk, Penny-wise (wage asked ×0.85).
5. Staff panel (frontend-design pass): current staff (name, role, stats as blister-pack pips
   §28, trait chip, wage, assignment) with fire/assign controls; hiring tab with the 3 weekly
   candidates per role and hire buttons; empty states per §28 copy voice ("No pharmacist —
   scripts wait for you at the bench").
6. Staff NPC visuals (§27): pine aprons, distinct from customers; assignment shown by a small
   role glyph over the station; the owner keeps the white coat.
7. Counsel automation: a stationed pharmacist (or Charming cashier at pickup? no — pharmacist
   only, §9 roles) handles Chatty counseling automatically at pickup when free.
8. Save migration: extend `SaveFile`/`migrate` for staff state (bump version).

## Acceptance criteria

- [ ] Hire a cashier, tech, and pharmacist → a full day runs hands-off: drop-offs fill, verify,
      pickup, checkout all staffed; the player can watch queues and intervene at any station.
- [ ] Wages appear on the receipt; firing stops them next day; Penny-wise hires cost 15% less.
- [ ] A low-accuracy tech generates visible verification bounces; a high-accuracy pharmacist
      catches most; dispensed-error rate drops accordingly (observable over a few days).
- [ ] Stock Hawk restocks without player clicks; Swift visibly works faster; Meticulous never
      mis-fills.
- [ ] Candidate pool refreshes Mondays and improves with reputation (dev-set rep to verify).
- [ ] Old saves migrate cleanly; zero console errors; 60 fps with staff + 40 customers.

## Boundaries (standing)

Dev server only (`npm run dev`); never run build/compile commands. No React, no `useEffect`.
`sim/` imports nothing from render/ui/platform. TypeScript strict. Implement exactly this brief.
Leave the repo runnable and clean.

## Handoff to 08

Automation exists; the player's attention is freed for strategy. 08 gives that freedom targets:
licenses, deeper formularies, controlled substances, and floor expansions.
