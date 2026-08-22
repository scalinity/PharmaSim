# Milestone 16 — AI endgame tech + balancing

One-session brief. **Read first**: `SPEC.md` §21 (both AI modules), §26 (forecast rules + the
**balance arc targets** row — this session's yardstick), §13 (Gen 4 gates), §8/§9 (what the
verify assistant removes), §11 (what the forecast feeds). The forecast panel is a flagship data
UI: **read and follow the frontend-design skill first** (Plex Mono tables, trend arrows,
confidence bands — §28).

## State you inherit

Milestones 01–15: the complete game. Every system exists; the whole arc has never been tuned as
one piece.

## Goal

Two capstone capabilities that change how the endgame plays — the AI verification assistant
frees pharmacists from routine checking, and AI demand forecasting turns ordering into informed
strategy — followed by a structured balancing pass across the entire 56-day arc against §26's
targets.

## Non-goals

No new systems beyond the two modules. Balancing adjusts *values* (±20% latitude per §25/§26),
never rules; if a rule seems broken, document it in the session summary rather than redesigning
mid-pass.

## Tasks

1. **AI Verification Assistant** (§21): per-store purchase ($30,000, requires that store at
   Gen 4 + a verify desk); auto-verifies Tier-1/2 scripts instantly with 100% catch;
   pharmacists only verify Tier-3/refrigerated. Queue visuals show the assistant's lane
   distinctly (§8 legibility); the pharmacist's freed time visibly flows to counseling and
   vaccines. Legacy moment fires (§22).
2. **AI Demand Forecasting** (§21): account-wide purchase ($45,000, requires any Gen 4 store +
   28 days of sales history); Orders panel gains the forecast view — 7-day per-SKU predicted
   units (true generator ±10% noise), trend arrows, confidence band, shortage flags ("demand
   ↑31%, supply capped"); **Order to forecast** drafts a cart (store or DC scope) sized to
   predicted demand minus on-hand. Forecast accuracy honestly reflects §26 noise.
3. Dev fast-forward harness (dev-mode only, documented in README): auto-resolve N days using
   the §19 off-screen formula for *all* stores with a simple scripted policy (keep stocked,
   hire on §26 arc days) to sanity-check pacing without hand-playing 56 days. This is a dev
   tool, not a game feature — keep it behind the debug flag.
4. **Balancing sweep** against §26 arc targets (first hire day 6–9 · L2 ~10–14 · Gen 2 ~15 ·
   L5 ~35–45 · DC ~50+), using hand-play for feel (days 1–5 especially: the solo scrape must
   be tense but survivable) + the harness for the long arc. Tune §25/§26 values in the data
   files (±20%); keep a `docs/balance-notes.md` log of every change with reasoning.
5. Verify soft-fail integrity end to end: it must be possible to play badly (over-hire, over-
   order) and dig out via the family loan without a death spiral (rep drift + loan terms per
   §10/§15).
6. Save migration (AI ownership flags — bump version).

## Acceptance criteria

- [ ] Assistant store: Tier-1/2 scripts skip the pharmacist (still visible as a distinct lane);
      error escapes drop to zero for those tiers; Tier-3/refrigerated still require the
      pharmacist; removing the desk disables it with a clear reason.
- [ ] Forecast unlocks only past 28 days of history; predictions track reality within the noise
      band (log 7 days of predicted vs actual); Order-to-forecast carts are sane (no negative
      or absurd quantities; respects fridge capacity and DC scope).
- [ ] Harness runs 56 days in seconds and reports arc-event days; after tuning, targets land in
      their §26 windows across 3 different seeds.
- [ ] Hand-played days 1–5 feel tense but fair (subjective — note observations in
      `docs/balance-notes.md`); the dig-out-of-debt path works.
- [ ] `docs/balance-notes.md` documents every changed value with before/after and why.
- [ ] Old saves migrate; zero console errors; 60 fps.

## Boundaries (standing)

Dev server only (`npm run dev`); never run build/compile commands. No React, no `useEffect`.
`sim/` imports nothing from render/ui/platform. TypeScript strict. Implement exactly this brief.
Leave the repo runnable and clean.

## Handoff to 17

A complete, tuned game. 17 gives it a voice (audio), a final polish pass, and an app bundle to
hand to colleagues.
