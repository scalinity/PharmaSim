# Milestone 14 — Multi-branch

One-session brief. **Read first**: `SPEC.md` §19 (multi-branch — the whole section), §17
(location strategy is district data), §9 (manager role activates), §12 (L5 gate), §26 (site
costs, off-screen throughputs), §28 (branch tabs, per-branch receipt pages). Branch purchase
flow + branch report pages are significant UI: **read and follow the frontend-design skill
first**.

## State you inherit

Milestones 01–13: one player store in a contested living city. L5 is visible; empty lots exist
in every district. The manager role is defined but inert.

## Goal

Pharmacy becomes pharmacy *network*: buy lots where the demographics say to, fit out new
branches, staff them, switch the full 3D sim between branches each morning, and let unvisited
branches resolve statistically — well or badly depending on the managers and stock you gave
them. The endgame loop (read reports → reallocate → visit the problem branch) begins.

## Non-goals

No inter-branch stock transfers or DC (15 — each branch orders independently; say so in the UI
when players look for transfers), no changes to competitor logic (branches simply join §17
routing per district).

## Tasks

1. Branch purchase (§19): with L5, city-map lots show price (300× district daily rent +
   $15,000 fit-out); buying creates a `StoreState` — starting layout, Gen 1, 2.5★ local rep,
   empty stock — in that district. Purchase flow UI states the district's demand character
   (from observed data only, §12's knowledge rule).
2. Active-branch switching (§19): mornings offer branch selection (city map click or §28 branch
   tabs); the 3D sim loads the active branch (scene rebuild within §30 budgets); all per-store
   systems (stock, staff, era, pricing, licenses-shared-account-wide) follow §24's shapes,
   which have been per-store since 06 — fix any accidental global state now.
3. Manager role activates (§9/§26): hireable per branch; required for good off-screen
   resolution. Staff panel gains a branch scope switcher; hiring pool is shared, assignment is
   per-branch.
4. Off-screen day resolution (§19/§26): at close, each unvisited branch resolves —
   `capacity = min(fills, verifies, checkouts)` from its staff (×speed curves),
   `managerFactor` 0.6 / 0.9 + 0.02×statTotal, `served = min(demand, capacity×managerFactor)`;
   revenue/costs/stock consumption/incidents (accuracy-driven) post to the ledger; local rep
   drifts ±0.05/day by served ratio; **no pharmacist on staff → OTC-only** while unvisited.
   Stock-outs at unvisited branches feed their `fillRate7d` (13's transfers apply everywhere).
5. Reporting (§19/§28): the end-of-day receipt gains per-branch summary pages (tabbed paper
   sheets — visited branch keeps the full itemized receipt, unvisited get the resolved
   summary + incident lines); the reports panel adds a network rollup (revenue, share, rep by
   branch).
6. Morning orders scope per branch (deliveries arrive wherever ordered); the Orders panel gets
   the branch switcher too.
7. Legacy hook: first branch purchase fires its §22 moment.
8. Save migration (multi-store arrays were shaped since 06; migrate active-store pointer,
   managers, per-branch observed data — bump version).

## Acceptance criteria

- [ ] Buy a Sunset Glen branch (dev-grant funds): price matches §26 math; it spawns per §19
      and joins routing — chronic-heavy demand visible within days.
- [ ] Morning switching swaps the full 3D sim between branches without leaks (stock, staff,
      era, pricing all per-branch; verify by making them differ starkly).
- [ ] An unvisited branch with tech+cashier+pharmacist+manager and stock earns plausibly per
      the §26 formula (hand-check one day); without a manager it visibly underperforms
      (factor 0.6); without a pharmacist it sells OTC only.
- [ ] Understaffed/understocked unvisited branches bleed local rep and log incidents you can
      read on their receipt page — and recover when fixed.
- [ ] The network rollup and branch pages make "which branch needs me tomorrow" answerable in
      seconds.
- [ ] Old saves migrate (single store becomes branch #1); zero console errors; 60 fps after
      repeated scene swaps.

## Boundaries (standing)

Dev server only (`npm run dev`); never run build/compile commands. No React, no `useEffect`.
`sim/` imports nothing from render/ui/platform. TypeScript strict. Implement exactly this brief.
Leave the repo runnable and clean.

## Handoff to 15

A network that runs (and struggles) without you. 15 gives it a spine: the distribution center,
trucks, and transfers.
