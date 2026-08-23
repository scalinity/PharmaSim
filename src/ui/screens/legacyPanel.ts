// Legacy panel (SPEC §22, §28): the family album. Achieved moments mount
// chronologically on a warm album page — each one a polaroid (flat-color
// ground, a big set mark, Fraunces caption, the date in mono) with its §22
// note pinned beside it, the same note that printed on that day's receipt.
// The album page stays Gen-1 warm whatever the store becomes: old paper.

import type { EventBus } from "../../core/bus";
import { seasonForDay } from "../../core/clock";
import { legacyMomentDef } from "../../data/flavor";
import type { SimEvent } from "../../sim/events";
import type { Sim } from "../../sim/sim";
import { h } from "../dom";

export interface LegacyPanelHandle {
  root: HTMLElement;
  setVisible(on: boolean): void;
}

export function createLegacyPanel(sim: Sim, bus: EventBus<SimEvent>): LegacyPanelHandle {
  let visible = false;
  /** Count rendered last time — the page rebuilds only when the story grows.
   *  Length alone is a sufficient key because state.legacy is append-only
   *  within a session (recordMoment only ever pushes) and loading a save
   *  reboots the page; a future path that removes or swaps moments
   *  in-session would need a real key here. */
  let renderedCount = -1;

  const page = h("div", { cls: "album__page" });

  const cover = h("div", { cls: "album__cover" }, [
    h("div", { cls: "album__head" }, [
      h("h2", { cls: "album__title", text: "Legacy" }),
      h("p", { cls: "album__eyebrow", text: "the family album" }),
    ]),
    page,
  ]);

  const root = h("section", { cls: "album", attrs: { "aria-label": "Legacy" } }, [cover]);
  root.hidden = true;

  function buildEntry(id: string, day: number): HTMLElement {
    const def = legacyMomentDef(id);
    const mark = h("span", { cls: "album__mark", text: def.photo.mark });
    mark.style.color = def.photo.ink;
    const photo = h("div", { cls: "album__photo", attrs: { "aria-hidden": "true" } }, [mark]);
    photo.style.background = def.photo.ground;

    const polaroid = h("div", { cls: "album__polaroid" }, [
      photo,
      h("p", { cls: "album__caption", text: def.title }),
      h("p", { cls: "album__date", text: `day ${day} · ${seasonForDay(day).toLowerCase()}` }),
    ]);

    const note = h("div", { cls: "album__note" }, [
      h("span", { cls: "album__pin", attrs: { "aria-hidden": "true" } }),
      h("p", { cls: "album__notetext", text: def.text }),
    ]);

    return h("div", { cls: "album__entry" }, [polaroid, note]);
  }

  function refresh(): void {
    const legacy = sim.snapshot.legacy;
    if (legacy.length === renderedCount) return;
    renderedCount = legacy.length;
    if (legacy.length === 0) {
      page.replaceChildren(
        h("div", { cls: "album__empty" }, [
          h("div", { cls: "album__polaroid album__polaroid--blank" }, [
            h("div", { cls: "album__photo album__photo--blank" }),
            h("p", { cls: "album__caption", text: "— " }),
          ]),
          h("p", {
            cls: "album__emptyline",
            text: "Nothing pinned yet. First profits, first hires, new generations — the story collects here.",
          }),
        ]),
      );
      return;
    }
    const entries = [...legacy].sort((a, b) => a.day - b.day);
    page.replaceChildren(...entries.map((moment) => buildEntry(moment.id, moment.day)));
  }

  bus.on("legacy.moment", () => {
    if (visible) refresh();
  });

  return {
    root,
    setVisible(on) {
      visible = on;
      root.hidden = !on;
      if (on) refresh();
    },
  };
}
