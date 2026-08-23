# PharmaSim

A 3D pharmacy business simulator. You inherit the instincts of a pharmacy family: starting as
the lone pharmacist-owner of a humble corner drugstore, you personally take prescriptions, fill
them from the shelf, and ring up customers. Profits buy shelves, staff, licenses, and
renovations — from walnut-and-brass 1950s charm to a glass-and-mint modern clinic — until you
operate a network of branches across a living low-poly city, all experienced through a cozy
eagle-eye view of little people moving through a store you built.

## Stack

- **Vite + TypeScript (strict)** — dev loop is the browser
- **three.js** — procedural low-poly 3D, orthographic eagle-eye camera
- **Hand-rolled DOM HUD** — no framework; typed event bus between sim / render / ui layers
- **Tauri 2** — desktop shell (macOS-first); config lives in `src-tauri/`
- **Fonts** — Fraunces, Public Sans, IBM Plex Mono, bundled locally via `@fontsource`

## Run

```sh
npm install
npm run dev     # opens on http://localhost:1420
```

The browser via `npm run dev` is the daily driver. `npm run tauri dev` builds the Rust shell
and is only used when a milestone brief calls for it.

## Docs

- [`SPEC.md`](SPEC.md) — the game bible: vision, architecture, systems, tuning constants
- [`docs/milestones/`](docs/milestones/) — 17 one-session implementation briefs, run in order

## Milestone progress

- [x] 01 Scaffold + core loop
- [x] 02 Store grid + placement
- [x] 03 Customers + OTC flow
- [x] 04 Prescription vertical slice
- [x] 05 Inventory + economy
- [x] 06 Saves + app shell
- [x] 07 Staff + automation
- [x] 08 Licenses + expansion
- [x] 09 Cold chain + vaccinations
- [ ] 10 Modernization + legacy
- [ ] 11 Events + atmosphere
- [ ] 12 City map + living demand
- [ ] 13 Competitors + market share
- [ ] 14 Multi-branch
- [ ] 15 Distribution + logistics
- [ ] 16 AI endgame tech + balancing
- [ ] 17 Audio + polish + packaging
