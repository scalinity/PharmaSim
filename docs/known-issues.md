# Known issues and deferred papercuts

Logged during milestone 17's polish sweep. Nothing here breaks a run; each entry is a
judgment call that went the other way, kept where a later pass can find it.

- **Panels don't take keyboard focus when opened.** Pressing `O`/`T`/`R`/… opens the
  sheet, but focus stays where it was, so reaching the sheet's controls takes a few Tab
  presses past the top bar. Keyboard-only play works everywhere (the §28 floor); a focus
  jump into the sheet on open would make it nicer. Deferred to keep the milestone's
  no-new-mechanism restraint.
- **The Effects slider has no audible preview.** Master and Room tone are judged live
  against the running ambience; Effects is only heard when the next cue fires naturally.
  A confirmation ding on release was considered and dropped — polish is subtraction.
- **Customer cell-claim strand: root cause never pinned.** A despawned customer's third
  cell claim was once observed surviving near the doorway. Despawn now sweeps the whole
  occupied buffer (`sim/customers.ts`), so the invariant holds — but the write path that
  stranded it was never identified. If customer movement is ever reworked, keep the
  sweep until the writer is found.
- **L5 / distribution-center arc timing** is a structural pacing gap, not a papercut —
  documented in `docs/balance-notes.md`; needs a rules-level pass someday.
