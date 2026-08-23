// Meter (SPEC §28 kit): a blister-pack strip of pips — the pills still in
// the pack are what you've got. Used for staff stats (§9, 1–5).

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
