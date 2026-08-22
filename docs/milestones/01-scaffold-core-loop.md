# Milestone 01 — Scaffold + core loop

One-session brief. **Read first**: `SPEC.md` §1–§5 (vision, pillars, constraints, architecture,
time), §26 (tuning), §27 (camera, lighting), §28 (UI tokens/type), §30 (performance budgets).
This milestone builds UI (tokens + HUD skeleton): **read and follow the frontend-design skill
before writing any UI code** — §28 is the settled design brief; apply the skill's
plan-then-critique process to the HUD bar and morning panel within those tokens.

## State you inherit

An empty repository (fresh git, no commits). Sibling projects `~/Documents/Games/Base` and
`~/Documents/Games/TowerDefense` show the house Vite + TS + Tauri arrangement if you need a
reference for config shapes.

## Goal

A running skeleton with the three-layer architecture in place: a fixed-timestep sim owning an
in-game clock and day phases, a Three.js eagle-eye scene, and a token-driven DOM HUD with working
time controls. No gameplay yet — this session is the chassis everything else bolts onto.

## Non-goals

No furniture, customers, money logic (cash is just a displayed number), pathfinding, saves, or
audio. Do not stub future systems "while you're here".

## Tasks

1. Project setup: `npm create vite@latest` (vanilla-ts) or equivalent manual setup; add `three`,
   `@types/three`; dev-only `@tauri-apps/cli` + runtime `@tauri-apps/api`; fonts
   `@fontsource/fraunces`, `@fontsource/public-sans`, `@fontsource/ibm-plex-mono`. TypeScript
   `strict: true`. Scripts: `dev`, `preview`, `tauri` (mirror the sibling projects).
2. Tauri scaffold: `src-tauri/` config for a desktop window titled "PharmaSim" (min 1280×800).
   Config only — do **not** run `tauri dev` or any build in this session (it compiles Rust);
   the browser via `npm run dev` is the verification target.
3. Write `README.md`: what the game is (one paragraph from §1), stack, how to run
   (`npm install`, `npm run dev`), doc map (SPEC.md, docs/milestones/), and a milestone
   progress checklist (check off 01). Add a standard `.gitignore` (node, vite, tauri targets).
4. Folder skeleton per §4 — create only what this milestone uses: `core/loop.ts`,
   `core/clock.ts`, `core/bus.ts`, `sim/sim.ts`, `sim/state.ts`, `sim/commands.ts`,
   `sim/events.ts`, `render/renderer.ts`, `render/storeScene.ts`, `render/cameraRig.ts`,
   `render/lighting.ts`, `ui/dom.ts`, `ui/tokens.css`, `ui/components/{Panel,PillButton}.ts`,
   `ui/hud.ts`, `main.ts`.
5. Core loop (§4/§5): rAF render loop + accumulator ticking the sim every 100 ms of scaled time;
   speeds pause/1×/2×; 1 real s = 2.4 igm at 1×. `EventBus` with typed `SimEvent` union
   (start with `day.phaseChanged`, `clock.minute`, `speed.changed`).
6. Sim skeleton: `GameState` with `day`, `clockIgm` (480 = 08:00 at morning), `phase`
   (`morning`|`shift`|`close`), `cash` (12000), `repStars` (2.5). Commands: `store.open`
   (morning→shift), `day.advance` (close→next morning), `speed.set`. Shift auto-ends at 20:00.
7. Scene (§27): renderer with resize handling; ground plane (sage), a placeholder store slab +
   flat-shaded walls (Gen 1 cream/walnut hint) sized 10×7 m at origin; hemisphere + directional
   key light with the 08:00–20:00 warm→cool→warm arc driven by sim clock events.
8. Camera rig (§27): OrthographicCamera; left-drag orbit (pitch clamp 35°–65°, yaw free),
   right-drag/WASD pan, wheel zoom (8–30 m viewport height), smooth damping.
9. HUD (§28, frontend-design skill): load fonts; define all §28 tokens in `tokens.css`;
   `dom.ts` element helper; Panel + PillButton components. Top bar: day chip ("Day 1 · Spring"),
   clock strip 08:00→20:00 with a sweeping marker, cash in Plex Mono, star rating, speed
   controls (pause/1×/2× as pill buttons; keys `Space`, `1`, `2`). Morning state shows a small
   paper panel with an **Open store** button; close state shows a placeholder "Day complete"
   panel with **Next day**. Respect `prefers-reduced-motion`.

## Acceptance criteria

- [ ] `npm run dev` serves the game; zero console errors/warnings.
- [ ] Camera orbits within pitch clamps, pans, zooms within limits; damping feels smooth.
- [ ] Open store → clock sweeps 08:00→20:00 in ~5 min at 1×, ~2.5 min at 2×; pause freezes the
      clock while the HUD stays interactive; keys and buttons both work.
- [ ] Day cycles morning → shift → close → next morning; day counter increments; lighting hue
      visibly shifts across the shift.
- [ ] HUD uses the §28 tokens/typefaces (Fraunces display, Public Sans UI, Plex Mono cash); no
      default-browser styling visible.
- [ ] `sim/` contains no imports from three.js or the DOM (grep it).
- [ ] Steady 60 fps.

## Boundaries (standing — echoed in every brief)

Dev server only (`npm run dev`); never run build/compile commands. No React, no `useEffect`.
`sim/` imports nothing from render/ui/platform. TypeScript strict. Implement exactly this brief;
resist speculative scaffolding. Leave the repo runnable and clean.

## Handoff to 02

Working loop, bus, camera, HUD frame, day phases. 02 adds the grid, furniture placement, and
pathfinding on top of `storeScene`.
