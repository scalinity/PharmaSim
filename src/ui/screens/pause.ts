// Pause menu (SPEC §23, §28): Esc during play. A small paper sheet over the
// scrim with the day's headline in Plex Mono, and — mid-shift — the one line
// of small print that matters: quitting keeps this morning, not this shift.

import { seasonForDay } from "../../core/clock";
import type { Sim } from "../../sim/sim";
import { PillButton } from "../components/PillButton";
import { h } from "../dom";
import { money } from "../format";

export interface PauseProps {
  onResume(): void;
  onSettings(): void;
  onQuit(): void;
}

export interface PauseHandle {
  root: HTMLElement;
  /** Re-read the headline and the mid-shift warning before showing. */
  sync(): void;
  focus(): void;
}

export function createPauseScreen(sim: Sim, props: PauseProps): PauseHandle {
  const stamp = h("p", { cls: "sheet__stat" });
  const warning = h("p", {
    cls: "row__help row__help--warn",
    text: "Quitting keeps this morning. Today's shift starts over from 08:00.",
  });
  const resume = PillButton("Resume", props.onResume);

  const root = h("div", { cls: "screen screen--sheet" }, [
    h("div", { cls: "sheet sheet--narrow" }, [
      h("div", { cls: "sheet__inner" }, [
        h("h2", { cls: "sheet__title sheet__title--lone", text: "Paused" }),
        stamp,
        h("div", { cls: "sheet__stack" }, [
          resume,
          PillButton("Settings", props.onSettings, { variant: "secondary" }),
          PillButton("Save and quit to title", props.onQuit, { variant: "secondary" }),
        ]),
        warning,
      ]),
    ]),
  ]);

  function sync(): void {
    const state = sim.snapshot;
    stamp.textContent = `day ${state.day} · ${seasonForDay(state.day).toLowerCase()} · ${money(state.cash)}`;
    warning.hidden = state.phase !== "shift";
  }
  sync();

  return { root, sync, focus: () => resume.focus() };
}
