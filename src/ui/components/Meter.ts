// Meter (SPEC §28 kit): a blister-pack strip of pips — the pills still in
// the pack are what you've got. Used for staff stats (§9, 1–5) and, as a
// wrapped card, the fridge's cold-unit capacity (§14).

import { h } from "../dom";

/** The kit's one pip strip: `value` raised pips out of `max`, decoration
 *  only (aria-hidden) — the caller carries the numbers in real text. */
function pipStrip(value: number, max: number, cls: string): HTMLElement {
  const pips = h("span", { cls, attrs: { "aria-hidden": "true" } });
  for (let i = 0; i < max; i++) {
    pips.append(h("i", { cls: i < value ? "meter__pip meter__pip--in" : "meter__pip" }));
  }
  return pips;
}

export function Meter(label: string, value: number, max = 5): HTMLElement {
  return h(
    "span",
    { cls: "meter", attrs: { "aria-label": `${label} ${value} of ${max}` } },
    [h("span", { cls: "meter__label", text: label }), pipStrip(value, max, "meter__pips")],
  );
}

/** §14 fridge capacity as a blister card: one pip per cold unit, wrapped in
 *  rows — raised pips are units spoken for, pressed ones are free space. */
export function fridgePips(used: number, capacity: number): HTMLElement {
  return pipStrip(used, capacity, "meter__pips meter__pips--fridge");
}
