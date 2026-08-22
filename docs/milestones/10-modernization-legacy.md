# Milestone 10 — Modernization + legacy

One-session brief. **Read first**: `SPEC.md` §13 (era tiers), §22 (legacy flavor — tone matters),
§27 (era palettes), §28 (era-tinted HUD paper, pinned notes on the receipt, Legacy panel as photo
album). This milestone is heavy on visual identity: **read and follow the frontend-design skill
first** — the Legacy panel and the renovation moment are both signature-adjacent; give them the
skill's full two-pass treatment.

## State you inherit

Milestones 01–09: a fully capable single store, permanently dressed in Gen 1 walnut.

## Goal

The family-legacy fantasy lands: per-store era renovations visually transform the shell and every
fixture across four generations (with the HUD paper quietly modernizing along), decor becomes
placeable personality, and legacy moments accumulate in a photo-album panel with warm flavor
notes pinned to the receipt.

## Non-goals

No new mechanics beyond renovation itself — eras gate only what §13 says (robotic dispenser and
AI modules are Gen 4 *purchases for later milestones*; the dispenser can ship here if time
allows, else defer its behavior to 16's AI-adjacent pass — prefer shipping it here since it's a
station: auto-fills Tier-1/2 scripts with no tech, per §6). No era-based demand changes.

## Tasks

1. `sim/renovation.ts` (§13): `era.renovate` command with cost gates; renovation closes the
   store for the rest of the current day (customers finish, no new spawns; scaffolding props
   appear); next morning the new era stands.
2. `render/eras.ts` (§27): four era material palettes + fixture reskin variants applied to the
   shell (floor/walls/ceiling trim) and every furniture mesh (same silhouettes, era materials —
   e.g. walnut shelf → chrome-edge teal → white gondola → light oak + glass). Rebuild batched
   static geometry on era change only (§30).
3. Era-tinted HUD (§28): swap the paper custom property per active store era (Gen 1 warm
   `#FBF4E4` → Gen 4 `#FCFCFA`); verify every component reads the token, not a literal.
4. Robotic dispenser (§6, Gen 4): placeable 2×2 backroom station; auto-fills Tier-1/2 scripts
   (its own fill lane, no staff needed; Tier-3/refrigerated still go to benches). Emits the same
   workflow events so queues stay legible.
5. `data/flavor.ts` + legacy system (§22): moments — first profitable day, first hire, first
   renovation, each license, first branch/DC/Gen 4/AI module (hooks for future milestones),
   first transfer-in wave (13) — each with 2–3 warm sentences in the §22 register (write them
   well; this is the family story). Fire once, persist in `SaveFile.legacy`, pin as a paper note
   on that day's receipt, list in the **Legacy panel** (photo-album styling: polaroid-ish cards,
   Fraunces captions, dates).
6. Renovation UI: a Renovate tab (Build dock or its own) showing the four §13 tiers with looks
   described, costs, and the "closes the store today" warning in §28 copy voice.
7. Save migration (era per store, legacy list, dispenser — bump version).

## Acceptance criteria

- [ ] Each renovation purchase closes the store that day (scaffolding visible), reopens next
      morning fully reskinned — shell and every fixture — with the HUD paper tint shifted.
- [ ] All four eras render distinctly per §27 palettes at 60 fps (batched rebuild only on
      change; verify no per-frame cost).
- [ ] The robotic dispenser auto-fills Tier-1/2 while benches handle the rest; removing it
      restores bench-only flow.
- [ ] Legacy moments fire exactly once (dev-replay a save to confirm no double-fires), pin
      notes on the receipt, and populate the album with dates.
- [ ] Renovating the first store triggers its §22 moment; flavor prose reads warm, specific,
      never blocking.
- [ ] Old saves migrate (existing stores = Gen 1, empty album backfills nothing); zero console
      errors.

## Boundaries (standing)

Dev server only (`npm run dev`); never run build/compile commands. No React, no `useEffect`.
`sim/` imports nothing from render/ui/platform. TypeScript strict. Implement exactly this brief.
Leave the repo runnable and clean.

## Handoff to 11

The store looks like a life's work. 11 gives the world weather: seasons, rushes, shortages,
storms, and the ticker that narrates them.
