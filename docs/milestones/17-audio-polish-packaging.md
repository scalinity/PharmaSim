# Milestone 17 — Audio + polish + packaging

One-session brief. **Read first**: `SPEC.md` §29 (audio — every cue is synthesized), §30
(performance budgets — this session audits them), §28 (floor: focus, contrast, hit targets;
settings screen finishes), §3 (the build-command rule this session partially lifts — see task 6).
Polish touches many small UI moments: keep the frontend-design skill's restraint principle in
hand — remove an accessory, don't add one.

## State you inherit

Milestones 01–16: the complete, balanced game. Volume sliders have sat disabled in settings
since 06. No sound exists. The app has never been packaged.

## Goal

Ship it: a synthesized soundscape that makes the pharmacy feel inhabited, a performance and
polish audit that clears the §30 budgets and §28 floor everywhere, and — with the user's
explicit go-ahead — a Tauri app bundle colleagues can install.

## Non-goals

No audio files or downloaded samples (§29 — synthesis only, zero IP risk), no new features, no
balance changes (16 closed that; regressions only), no web deployment (§32).

## Tasks

1. `platform/audio.ts` (§29): WebAudio graph — master/SFX/ambience gains; synthesized cues:
   door chime (two-tone sine), register ding (triangle + decay), paper rustle (filtered noise,
   panels/receipt), pill rattle (granular ticks, fills), stamp thunk (low sine + noise —
   receipt verdict, sync with the print animation), soft amber alert, truck hum; ambience:
   room tone + murmur (brown noise + slow LFO) scaled to NPC count, rain layer during storms
   (11's hook). Subscribe to bus events; no sim knowledge of audio.
2. Settings finish (06's stubs go live): master/SFX/ambience sliders with §28 microcopy;
   mute-on-blur; persisted in `SaveFile.settings`.
3. Performance audit (§30): measure draw calls (store, largest floor, city with trucks), sim
   tick time at 40 NPCs, allocation churn (DevTools heap timeline during a rush); fix
   violations (instancing gaps, unbatched era rebuilds, per-frame garbage); record results in
   `docs/perf-notes.md`.
4. Polish sweep (§28 floor): keyboard focus rings everywhere, hit targets ≥32 px, contrast
   ≥4.5:1 (spot-check amber-on-paper), reduced-motion honored by every animation added since
   06, toast/ticker overflow behavior, window-resize sanity at 1280×800, empty states
   (no-staff, no-stock, no-save-import) use §28 voice. Fix papercuts found while playing —
   log anything deferred in `docs/known-issues.md`.
5. README completion: final feature list, controls reference, dev-tools section (debug keys,
   fast-forward harness), credits/licenses note (OFL fonts, no third-party assets).
6. **Packaging — requires the user's explicit go-ahead in this session before running any
   build command.** With approval: generate the app icon set (procedural: pine cross on a
   paper rounded square — render via a small canvas script to PNG sizes Tauri needs), verify
   `src-tauri` config (product name, identifier, window), then `npm run tauri build` for the
   macOS .app/.dmg. Smoke-test the bundle: fresh launch, saves land in app-data (§23's Tauri
   path gets its first real exercise — fix what browser dev never hit), export/import dialogs,
   quit-persistence. Document the Gatekeeper right-click-open dance for recipients in the
   README's "Sharing" section.
7. If the user declines the build this session, complete everything else and leave packaging
   instructions ready in the README.

## Acceptance criteria

- [ ] A played day *sounds* like a pharmacy — cues fire on the right events at sane volumes,
      ambience swells with the crowd, rain arrives with storms; sliders and mute-on-blur work
      and persist.
- [ ] §30 budgets verified and documented in `docs/perf-notes.md` (draw calls, tick time, no
      hot-path allocation churn).
- [ ] Keyboard-only play is possible for all management surfaces; reduced-motion is total;
      contrast passes; 1280×800 holds together.
- [ ] README is complete and accurate for a stranger cloning the repo.
- [ ] (With approval) the .dmg installs and runs on macOS with working Tauri-native saves and
      dialogs; sharing instructions are in the README. Without approval: packaging steps are
      documented and everything else ships.
- [ ] Zero console errors; 60 fps everywhere.

## Boundaries (standing)

Dev server only until task 6's explicit user approval; no other build commands. No React, no
`useEffect`. `sim/` imports nothing from render/ui/platform. TypeScript strict. Implement
exactly this brief. Leave the repo runnable, clean, and — this time — finished.

## Handoff

None. Take the receipt, stamp it PROFIT, and pin the family note: four generations later, the
store is yours.
