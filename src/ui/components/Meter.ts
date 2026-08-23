// Meter (SPEC §28 kit): a blister-pack strip of pips — the pills still in
// the pack are what you've got. Used for staff stats (§9, 1–5) and, as a
// wrapped card, the fridge's cold-unit capacity (§14).

import { h } from "../dom";

export function Meter(label: string, value: number, max = 5): HTMLElement {
  const pips = h("span", { cls: "meter__pips", attrs: { "aria-hidden": "true" } });
  for (let i = 0; i < max; i++) {
    pips.append(h("i", { cls: i < value ? "meter__pip meter__pip--in" : "meter__pip" }));
  }
  return h(
    "span",
    { cls: "meter", attrs: { "aria-label": `${label} ${value} of ${max}` } },
    [h("span", { cls: "meter__label", text: label }), pips],
  );
}

/** §14 fridge capacity as a blister card: one pip per cold unit, ten to a
 *  row — raised pips are units spoken for, pressed ones are free space. The
 *  caller writes the numbers beside it; the pips stay decoration. */
export function fridgePips(used: number, capacity: number): HTMLElement {
  const pips = h("span", {
    cls: "meter__pips meter__pips--fridge",
    attrs: { "aria-hidden": "true" },
  });
  for (let i = 0; i < capacity; i++) {
    pips.append(h("i", { cls: i < used ? "meter__pip meter__pip--in" : "meter__pip" }));
  }
  return pips;
}
