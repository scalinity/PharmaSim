# PharmaSim

A 3D pharmacy business simulator. You inherit the instincts of a pharmacy family: starting as
the lone pharmacist-owner of a humble corner drugstore, you personally take prescriptions, fill
them from the shelf, and ring up customers. Profits buy shelves, staff, licenses, and
renovations — from walnut-and-brass 1950s charm to a glass-and-mint modern clinic — until you
operate a network of branches across a living low-poly city, all experienced through a cozy
eagle-eye view of little people moving through a store you built.

## Features

- **The core day**: open the store, work the registers, fill bench, and verify desk yourself —
  or hire cashiers, techs, pharmacists, and managers who do it while you plan.
- **Prescriptions as a real workflow**: drop-off → fill (pick the right bin) → pharmacist
  verification → pickup, with dispensing errors, catches, and counseling chats.
- **Inventory and economy**: wholesale orders, shelf labels, OTC pricing against MSRP, per-SKU
  reorder rules, a ledger-true end-of-day receipt that always adds up to the till.
- **Licenses and expansion**: six licenses gate tiers, controlled substances, vaccinations,
  branches, and distribution; the floor itself expands from 10×7 to 16×12.
- **Cold chain**: a medical fridge, refrigerated stock, flu-shot walk-ins, storm outages, and
  the backup generator that saves the vaccines.
- **Era modernization**: renovate through four generations — the store's 3D look, the HUD's
  paper tint, and the family's legacy album all move with it.
- **A living city**: eight districts with their own demand, four rival pharmacies that drift
  and poach, chronic patient pools that change hands on bad experiences.
- **Multi-branch + logistics**: buy lots, run branches through managers' resolved days, then a
  central depot with vans running picking-list routes and inter-branch transfers.
- **AI endgame tech**: a Gen 4 verification assistant and account-wide demand forecasting.
- **A synthesized soundscape**: door chime, register ding, pill rattle, paper rustle, the
  receipt's stamp thunk, crowd murmur that swells with the floor, rain on storm days — every
  cue synthesized in WebAudio, no audio files anywhere.
- **Saves**: one autosave profile, versioned migrations back to the first playtest save,
  JSON export/import.

## Stack

- **Vite + TypeScript (strict)** — dev loop is the browser
- **three.js** — procedural low-poly 3D, orthographic eagle-eye camera
- **Hand-rolled DOM HUD** — no framework; typed event bus between sim / render / ui layers
- **WebAudio** — fully synthesized sound (`src/platform/audio.ts`), zero asset files
- **Tauri 2** — desktop shell (macOS-first); config lives in `src-tauri/`
- **Fonts** — Fraunces, Public Sans, IBM Plex Mono, bundled locally via `@fontsource`

## Run

```sh
npm install
npm run dev     # opens on http://localhost:1420
```

The browser via `npm run dev` is the daily driver. `npm run tauri dev` builds the Rust shell
and is only used when packaging work calls for it.

## Controls

**Camera** — left-drag orbits, right-drag or `WASD` pans, wheel zooms.

**Time** — `Space` pause/resume · `1` normal · `2` double speed.

**Surfaces** — `B` build · `O` orders · `T` team · `R` reports · `L` licenses · `C` city map ·
`D` depot dispatch (once the depot is bought) · `V` renovate · `G` legacy album ·
`Esc` closes the open sheet, then pauses.

**On the floor** — click a station to work it yourself; click away to step back. In build
mode: pick from the palette, `R` rotates the ghost, click places, click placed furniture to
move or sell it. Click shelves to restock; hover them for labels and prices.

**Sound** — master / effects / room-tone sliders live in Settings (Esc → Settings); sound
mutes while the window is in the background.

## Dev tools

Playtest helpers. `N` works in any run; the event console (`J`/`M`/`K`) only exists in dev
builds (`npm run dev`) — `K` in particular rewrites the save, so packaged builds leave it out.

- `N` — cycle the stress spawner: ×1 → ×3 → ×9 → ×27 → off
- `J` — force a regional drug shortage starting today (random open category, 4–8 days)
- `M` — schedule a storm for tomorrow; the forecast pins to tonight's receipt
- `K` — from a morning, skip straight to the next one (no shift, no costs)

Dev builds also expose a fast-forward balancing harness on the console:
`await __pharmasim.harness(seed, days)` (defaults `1, 56`) runs a *scratch* seeded game
off-screen — every store through the §19 resolver under a simple keep-stocked/hire/expand
policy — and returns a report with the §26 arc-event days (`.summary` is printable). It never
touches the running sim or the save, and the module stays out of packaged builds.

The `window.__pharmasim` console handle exposes `sim`, `bus`, `renderer`, `storage`, and the
loop hooks for read-only debugging; the perf audit method and numbers live in
[`docs/perf-notes.md`](docs/perf-notes.md).

## Packaging (macOS)

The app bundles with Tauri. One-time setup: the Rust toolchain
([rustup](https://rustup.rs)) and Xcode command-line tools (`xcode-select --install`).

1. In `src-tauri/tauri.conf.json`, set `bundle.active` to `true` and give `bundle.icon` the
   generated icon set (`src-tauri/icons/`).
2. `npm run tauri build` — type-checks, builds the frontend, compiles the Rust shell, and
   writes `src-tauri/target/release/bundle/macos/PharmaSim.app` plus a `.dmg` beside it in
   `bundle/dmg/`.
3. Smoke-test the bundle fresh: launch, start a store, quit, relaunch — the save should
   come back. Saves live in `~/Library/Application Support/com.danny.pharmasim/saves/`;
   export/import use native file dialogs.

### Sharing

The app is unsigned (no Apple developer account), so Gatekeeper quarantines a downloaded
copy. Recipients open it the once with **right-click the app → Open → Open** — after that it
launches normally. If macOS still refuses ("damaged"), clear the quarantine flag:
`xattr -dr com.apple.quarantine /Applications/PharmaSim.app`.

## Credits and licenses

- Fonts: [Fraunces](https://github.com/undercasetype/Fraunces),
  [Public Sans](https://github.com/uswds/public-sans), and
  [IBM Plex Mono](https://github.com/IBM/plex) — all under the SIL Open Font License,
  bundled locally via `@fontsource` (nothing loads from the network at runtime).
- No third-party assets: all 3D geometry is procedural, every sound is synthesized at
  runtime, drug names are real generics only, and every business and district name is
  fictional.
- Runtime dependencies: [three.js](https://threejs.org) (MIT) and the
  [Tauri 2](https://tauri.app) API packages (MIT/Apache-2.0).

## Docs

- [`SPEC.md`](SPEC.md) — the game bible: vision, architecture, systems, tuning constants
- [`docs/milestones/`](docs/milestones/) — 17 one-session implementation briefs, run in order
- [`docs/balance-notes.md`](docs/balance-notes.md) — milestone 16's tuning log and findings
- [`docs/perf-notes.md`](docs/perf-notes.md) — the §30 performance audit
- [`docs/known-issues.md`](docs/known-issues.md) — deferred papercuts

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
- [x] 10 Modernization + legacy
- [x] 11 Events + atmosphere
- [x] 12 City map + living demand
- [x] 13 Competitors + market share
- [x] 14 Multi-branch
- [x] 15 Distribution + logistics
- [x] 16 AI endgame tech + balancing
- [x] 17 Audio + polish + packaging
