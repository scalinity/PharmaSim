// Settings screen (SPEC §28: a full paper sheet over the scrim). Three
// sections, each a labelled group on the sheet: what moves, what it sounds
// like, and where the save lives. Reduced motion is live; the volume sliders
// are laid out and inert until audio arrives in milestone 17.

import type { Sim } from "../../sim/sim";
import { PillButton } from "../components/PillButton";
import { h } from "../dom";

export interface SettingsProps {
  onExport(): void;
  onImport(): void;
  onDone(): void;
}

export interface SettingsHandle {
  root: HTMLElement;
  /** Re-read the sheet's controls from state before it is shown. */
  sync(): void;
  focus(): void;
}

function section(label: string, children: HTMLElement[]): HTMLElement {
  return h("section", { cls: "sheet__section" }, [
    h("h3", { cls: "sheet__label", text: label }),
    ...children,
  ]);
}

/** Inert volume slider: shown so the shape of the audio settings is honest. */
function volumeRow(label: string, value: number): HTMLElement {
  const slider = h("input", { cls: "slider" });
  slider.type = "range";
  slider.min = "0";
  slider.max = "100";
  slider.value = String(Math.round(value * 100));
  slider.disabled = true;
  slider.tabIndex = -1;
  return h("div", { cls: "row row--slider" }, [
    h("span", { cls: "row__name", text: label }),
    slider,
  ]);
}

export function createSettingsScreen(sim: Sim, props: SettingsProps): SettingsHandle {
  const settings = sim.snapshot.settings;

  const knob = h("span", { cls: "switch__knob", attrs: { "aria-hidden": "true" } });
  const toggle = h("button", {
    cls: "switch",
    attrs: { type: "button", role: "switch", "aria-checked": "false" },
  });
  toggle.append(knob);
  toggle.addEventListener("click", () => {
    sim.dispatch({ type: "settings.set", reducedMotion: !sim.snapshot.settings.reducedMotion });
    sync();
  });
  toggle.addEventListener("pointerdown", (event) => event.preventDefault());

  const motionRow = h("div", { cls: "row" }, [
    h("span", { cls: "row__name", text: "Reduce motion" }),
    toggle,
  ]);

  const exportButton = PillButton("Export save", props.onExport, { variant: "secondary" });
  const importButton = PillButton("Import save", props.onImport, { variant: "secondary" });
  const done = PillButton("Done", props.onDone);

  const root = h("div", { cls: "screen screen--sheet" }, [
    h("div", { cls: "sheet" }, [
      h("div", { cls: "sheet__inner" }, [
        h("p", { cls: "sheet__eyebrow", text: "Settings" }),
        h("h2", { cls: "sheet__title", text: "How the store behaves" }),

        section("Motion", [
          motionRow,
          h("p", {
            cls: "row__help",
            text: "Skips the receipt print and the way panels settle. Takes effect right away.",
          }),
        ]),

        section("Sound", [
          volumeRow("Master", settings.volume),
          volumeRow("Effects", settings.sfx),
          volumeRow("Room tone", settings.ambience),
          h("p", { cls: "row__help", text: "Audio arrives in a later milestone." }),
        ]),

        section("Your save", [
          h("div", { cls: "row row--actions" }, [exportButton, importButton]),
          h("p", {
            cls: "row__help",
            text: "Export writes one JSON file: the store, the shelves, the till. Import reads one back and plays it.",
          }),
        ]),

        h("div", { cls: "sheet__foot" }, [done]),
      ]),
    ]),
  ]);

  function sync(): void {
    const on = sim.snapshot.settings.reducedMotion;
    toggle.classList.toggle("switch--on", on);
    toggle.setAttribute("aria-checked", String(on));
  }
  sync();

  return { root, sync, focus: () => toggle.focus() };
}
