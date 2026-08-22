# Milestone 04 — Prescription vertical slice

One-session brief. **Read first**: `SPEC.md` §8 (the whole workflow), §7 (Rx patients), §10
(copay/reimbursement lines only), §15 (reputation), §25 (Tier-1 drugs + confusables), §28
(RxCard + the signature end-of-day receipt). This milestone builds two hero UI pieces — the Rx
card and the receipt: **read and follow the frontend-design skill first**; §28 defines both, and
the receipt is the game's signature element — budget real care for it.

## State you inherit

Milestones 01–03: living store with OTC customers, stations, patience, rep deltas, cash from
sales, placeholder end-of-day panel.

## Goal

The game becomes *the game*: prescription patients flow through visible stage queues, the player
personally fills scripts by picking the right bin among confusable neighbors, mistakes surface at
verification or (worse) at pickup, and the day closes with the printing receipt. After this
session PharmaSim is genuinely playable solo.

## Non-goals

No ordering (05 — Rx bins draw from seeded starter stock), no staff (07), no Tier-2/3 SKUs in
play (catalog data ships complete, but only Tier-1 spawns and stocks), no vaccine flow.

## Tasks

1. `data/drugs.ts`: the complete §25 Rx catalog (all tiers, flags, confusables) — gating comes
   from licenses later; the demand generator only draws Tier-1 for now.
2. `sim/workflow.ts` (§8): `RxScript` cards moving dropoff → fillQueue → filling → verifyQueue →
   verifying → ready → done. Customer mix per §26 (35% Rx patients); Rx patients queue at the
   service counter to drop off, then wait (sit/browse — waiting Rx patients may add OTC basket
   items per §7), and return on `ready` for pickup.
3. Fill interaction (the hands-on core): player clicks the fill bench → takes the top script;
   the RxCard (§28: Rx-pad sheet — ℞ mark, patient name, drug name + strength, quantity) slides
   in; the camera glides to frame the Rx shelf; bins render generated labels (§27 canvas atlas)
   and the correct bin's 2–3 `confusableWith` neighbors are always placed adjacent, shuffled
   each script. Correct click → 6 igm fill animation → verifyQueue. Wrong click → fills with the
   wrong drug silently (latent error), still → verifyQueue.
4. Verification (solo era): no verify desk exists yet — implicit check at handoff with 90%
   catch (§26). Caught → script returns to fillQueue with a "caught at verification" toast (time
   lost, no rep loss). Uncaught → `rx.errorDispensed` at pickup: full refund (copay +
   reimbursement reversed), rep −0.15, rose toast using §28 copy voice.
5. Pickup + counsel: at the service counter (player works it like the register), patient pays
   the $10 copay, reimbursement credits simultaneously (§10), bag handoff. Chatty patients offer
   a 10 igm counsel interaction (+0.03 rep, small extra basket chance).
6. Stage-queue visualization (§8): stacked mini-cards float over the bench and counter; the
   deepest queue ≥ 4 gets the amber bottleneck ring (§27). Rx bin stock decrements per fill;
   an out-of-stock drug at drop-off is refused (−0.08 rep, §15) and logged.
7. **End-of-day receipt v1** (§28 signature): perforated paper sheet, Plex Mono, top-down line
   printing (~1.2 s, click-to-skip, reduced-motion instant): Rx reimbursements, copays, OTC
   sales, refunds; visitors/fills/walk-outs/errors; rep delta with reasons; PROFIT/LOSS rubber
   stamp. Replaces the placeholder panel.
8. Reputation now live end to end (§15 deltas from both customer types).

## Acceptance criteria

- [ ] Rx patients drop off, wait (and sometimes shop), and pick up; stage queues are visible and
      the bottleneck ring appears where cards pile up.
- [ ] Bin picking always shows confusable neighbors adjacent (verify with metformin/metoprolol);
      wrong picks are caught ~90% at handoff (redo loop) and otherwise refund at pickup with
      −0.15 rep and correct ledger reversal.
- [ ] Copay + reimbursement credit exactly per §25 numbers; refusing an out-of-stock script
      costs −0.08 rep and appears on the receipt.
- [ ] The receipt prints with correct math (spot-check against the day's events), stamps the
      right verdict, skips on click, and is instant under reduced motion.
- [ ] A full solo day juggling OTC checkout + fills + pickups is playable and legible; zero
      console errors; 60 fps.

## Boundaries (standing)

Dev server only (`npm run dev`); never run build/compile commands. No React, no `useEffect`.
`sim/` imports nothing from render/ui/platform. TypeScript strict. Implement exactly this brief.
Leave the repo runnable and clean.

## Handoff to 05

The playable core exists on starter stock. 05 makes stock finite and strategic: ordering,
deliveries, pricing, the full P&L ledger, and loans.
