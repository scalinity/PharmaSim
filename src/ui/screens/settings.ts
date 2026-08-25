// Settings screen (SPEC §28: a full paper sheet over the scrim). Three
// sections, each a labelled group on the sheet: what moves, what it sounds
// like, and where the save lives. The volume sliders drive the §29 gains
// live and persist with the save (§24).

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

type VolumeKey = "volume" | "sfx" | "ambience";

export function createSettingsScreen(sim: Sim, props: SettingsProps): SettingsHandle {
  const settings = sim.snapshot.settings;
  const sliders = new Map<VolumeKey, HTMLInputElement>();

  /** Live volume slider: each input moves its §29 gain right away. */
  function volumeRow(label: string, key: VolumeKey): HTMLElement {
    const slider = h("input", { cls: "slider" });
    slider.type = "range";
    slider.min = "0";
    slider.max = "100";
    slider.value = String(Math.round(settings[key] * 100));
    slider.setAttribute("aria-label", `${label} volume`);
    slider.addEventListener("input", () => {
      sim.dispatch({ type: "settings.set", [key]: Number(slider.value) / 100 });
    });
    sliders.set(key, slider);
    return h("label", { cls: "row row--slider" }, [
      h("span", { cls: "row__name", text: label }),
      slider,
    ]);
  }

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
          volumeRow("Master", "volume"),
          volumeRow("Effects", "sfx"),
          volumeRow("Room tone", "ambience"),
          h("p", {
            cls: "row__help",
            text:
              "Effects are the door, the register and the counting tray; room tone is the crowd. " +
              "Sound mutes while the window is in the background.",
          }),
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
    const current = sim.snapshot.settings;
    toggle.classList.toggle("switch--on", current.reducedMotion);
    toggle.setAttribute("aria-checked", String(current.reducedMotion));
    for (const [key, slider] of sliders) {
      slider.value = String(Math.round(current[key] * 100));
    }
  }
  sync();

  return { root, sync, focus: () => toggle.focus() };
}
