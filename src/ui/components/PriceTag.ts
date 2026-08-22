// PriceTag — the shelf-label clip a front-store SKU is priced with (§28). The
// label *is* the control: the price prints large in mono, the slider under it
// doubles as the label's edge, and two ticks mark where shoppers start walking
// past (1.15× bargain hunters, 1.35× everyone, §10).

import { BALK_ALL, BALK_BARGAIN, PRICE_MAX, PRICE_MIN, PRICE_STEP } from "../../sim/inventory";
import { h } from "../dom";
import { money, multiplierLabel } from "../format";

export interface PriceTagOpts {
  /** Sticker price at ×1.0 — the tag is priced relative to this. */
  msrp: number;
  multiplier: number;
  /** SKU name, for the slider's accessible label. */
  name: string;
  onChange: (multiplier: number) => void;
}

export interface PriceTagHandle {
  root: HTMLElement;
  /** Re-print after the sim changes the price under us (auto-draft, reload). */
  set: (multiplier: number) => void;
}

/** Where a balk threshold sits along the 0.8–1.5 track, as a percentage. */
function tickPct(multiplier: number): number {
  return ((multiplier - PRICE_MIN) / (PRICE_MAX - PRICE_MIN)) * 100;
}

export function PriceTag(opts: PriceTagOpts): PriceTagHandle {
  const price = h("span", { cls: "ptag__price" });
  const mult = h("span", { cls: "ptag__mult" });
  const note = h("span", { cls: "ptag__note" });

  const slider = h("input", {
    cls: "ptag__slider",
    attrs: {
      type: "range",
      min: String(PRICE_MIN),
      max: String(PRICE_MAX),
      step: String(PRICE_STEP),
      "aria-label": `${opts.name} price`,
    },
  });

  const track = h("div", { cls: "ptag__track" });
  for (const at of [BALK_BARGAIN, BALK_ALL]) {
    const tick = h("i", { cls: "ptag__tick", attrs: { "aria-hidden": "true" } });
    tick.style.left = `${tickPct(at)}%`;
    track.append(tick);
  }
  track.append(slider);

  const root = h("div", { cls: "ptag" }, [
    h("span", { cls: "ptag__clip", attrs: { "aria-hidden": "true" } }),
    h("div", { cls: "ptag__read" }, [price, mult]),
    track,
    note,
  ]);

  function set(value: number): void {
    const m = Math.min(PRICE_MAX, Math.max(PRICE_MIN, value));
    slider.value = String(m);
    price.textContent = money(Math.round(opts.msrp * m * 100) / 100);
    mult.textContent = multiplierLabel(m);
    // The warning shows only on a tag that is actually losing sales.
    const tone = m > BALK_ALL + 0.001 ? "stop" : m > BALK_BARGAIN + 0.001 ? "warn" : "";
    root.dataset.tone = tone;
    note.textContent =
      tone === "stop" ? "everyone walks past" : tone === "warn" ? "bargain shoppers pass" : "";
  }

  slider.addEventListener("input", () => {
    const m = Number(slider.value);
    set(m);
    opts.onChange(m);
  });

  set(opts.multiplier);
  return { root, set };
}
