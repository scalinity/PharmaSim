# Milestone 06 — Saves + app shell

One-session brief. **Read first**: `SPEC.md` §23 (persistence), §24 (SaveFile schema), §5 (when
days autosave), §28 (screens are full paper sheets; title screen typography). The title,
settings, and pause screens are showcase UI: **read and follow the frontend-design skill first**
and give the title screen a proper frontend-design pass (it is the first thing colleagues see).

## State you inherit

Milestones 01–05: the full solo-era game — customers, prescriptions, inventory, economy, receipt
— all in-memory only.

## Goal

Progress becomes durable and the game gets its shell: a storage abstraction that works in both
plain-browser dev and the Tauri app, versioned saves with a migration chain, autosave at day
boundaries, and title/settings/pause screens with export/import.

## Non-goals

No cloud anything, no multiple slots (§23: single profile), no settings beyond what exists
(volume sliders ship disabled/stubbed until 17's audio; reduced-motion toggle is real now).

## Tasks

1. `platform/storage.ts` (§23): the `Storage` interface with `TauriFsStorage` (app-data
   `saves/profile.json`, export via save dialog, import via open dialog — lazy-import
   `@tauri-apps/api` so the browser bundle never loads it) and `LocalStorageStorage`
   (key `pharmasim.save.v1`, export = blob download, import = file input). Select by detecting
   the Tauri global at startup.
2. `sim/save.ts` (§24): `serialize(GameState) → SaveFile` (version 1) and
   `hydrate(SaveFile) → GameState`; `migrate(old)` chain scaffold (identity for v1) that later
   milestones must extend whenever they touch state — note this contract loudly in the file
   header comment.
3. Save timing (§5/§23): autosave after the end-of-day receipt and on quit. **Mid-shift quits
   save the morning snapshot of the current day** (an in-progress shift is discarded by design —
   deterministic and simple); implement by snapshotting state at each morning and persisting
   that on `beforeunload`/pause-quit.
4. Title screen (frontend-design pass): paper sheet over a slowly orbiting view of the store;
   Fraunces wordmark "PharmaSim", era-tinted; **Continue** (shows day/cash/stars summary chip,
   hidden when no save), **New game** (confirm-overwrite modal when a save exists), **Settings**.
5. Settings screen: reduced-motion toggle (live), volume sliders (visible, disabled, "audio
   arrives in a later milestone" microcopy), export save / import save buttons with §28 copy
   voice and toasts; import validates version + migrates.
6. Pause menu (`Esc` during play): resume, settings, save & quit to title.
7. Wire lifecycle: boot → title (load save if present) → play; quit paths persist correctly in
   both storage backends. Verify Tauri config compiles conceptually but **do not run
   `tauri dev`/`tauri build` this session** — browser localStorage is the verification target;
   the Tauri path is code-reviewed and exercised in 17.

## Acceptance criteria

- [ ] Play to day 3, refresh the browser → title shows Continue with the right summary →
      Continue restores the morning of day 3 exactly (cash, rep, layout, stock, prices, loans).
- [ ] Quitting mid-shift and continuing restores that day's *morning* (documented behavior).
- [ ] New game over an existing save requires explicit confirmation.
- [ ] Export downloads a JSON; wiping localStorage and importing it restores the run; a
      tampered/`version: 0` file is rejected with a clear toast, not a crash.
- [ ] Reduced-motion toggle kills the receipt print animation immediately.
- [ ] `Esc` pauses; save & quit returns to title; zero console errors; 60 fps.

## Boundaries (standing)

Dev server only (`npm run dev`); never run build/compile commands (including `tauri dev`). No
React, no `useEffect`. `sim/` imports nothing from render/ui/platform (`sim/save.ts` produces
plain objects; `platform/` does the I/O). TypeScript strict. Implement exactly this brief. Leave
the repo runnable and clean.

## Handoff to 07

Durable single-profile saves + shell. 07 adds staff and turns the solo grind into management;
every later milestone that extends `GameState` must add a `migrate` step.
