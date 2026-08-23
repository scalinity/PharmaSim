// Era paint chips (§13, §28 kit): the swatch strip the Renovate sheet and
// the morning reveal share. Colors come from data/eras.ts, so the chips are
// always the exact materials the renovation applies in 3D.

import { eraSwatches } from "../../data/eras";
import { h } from "../dom";

/** A strip of an era's paint chips. An unrevealed tier (still behind the
 *  counter on the Renovate sheet) leaves its chips face-down: no inline
 *  color is set, so the stylesheet's blank treatment applies unopposed. */
export function ChipStrip(era: number, revealed = true): HTMLElement {
  const strip = h("div", { cls: "chips", attrs: { "aria-hidden": "true" } });
  for (const hex of eraSwatches(era)) {
    const chip = h("span", { cls: "chips__chip" });
    if (revealed) chip.style.background = hex;
    strip.append(chip);
  }
  return strip;
}
