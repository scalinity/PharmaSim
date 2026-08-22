// RxCard (SPEC §28): a sheet torn off the prescriber's pad, clipped in while
// the player fills. The drug line is the hero — same mono face as the shelf's
// bin labels, so matching card → bin is one visual act. States: picking
// ("pick the matching bin"), filling (counting pips), missing shelf.

import { h } from "../dom";

export interface RxCardHandle {
  show(patientName: string, drugName: string, quantity: number, hasShelf: boolean): void;
  /** Bin picked; the 6 igm count-out is running. */
  setFilling(): void;
  hide(): void;
}

export function createRxCard(root: HTMLElement): RxCardHandle {
  const patientEl = h("span", { cls: "rxcard__value" });
  const qtyEl = h("span", { cls: "rxcard__value" });
  const drugEl = h("div", { cls: "rxcard__drug" });
  const stateText = h("span", { cls: "rxcard__statetext" });
  const statePips = h("span", { cls: "rxcard__pips", attrs: { "aria-hidden": "true" } }, [
    h("i"),
    h("i"),
    h("i"),
  ]);
  const stateEl = h("div", { cls: "rxcard__state" }, [stateText, statePips]);

  const card = h("aside", { cls: "rxcard", attrs: { "aria-label": "Prescription" } }, [
    h("div", { cls: "rxcard__binding", attrs: { "aria-hidden": "true" } }),
    h("div", { cls: "rxcard__head" }, [
      h("span", { cls: "rxcard__mark", attrs: { "aria-hidden": "true" }, text: "℞" }),
      h("div", { cls: "rxcard__clinic" }, [
        h("span", { text: "Old Town Pharmacy" }),
        h("span", { cls: "rxcard__clinicsub", text: "prescription" }),
      ]),
    ]),
    h("div", { cls: "rxcard__row" }, [
      h("span", { cls: "rxcard__label", text: "Patient" }),
      patientEl,
    ]),
    drugEl,
    h("div", { cls: "rxcard__row" }, [h("span", { cls: "rxcard__label", text: "Qty" }), qtyEl]),
    stateEl,
  ]);
  card.hidden = true;
  root.append(card);

  let quantity = 0;

  return {
    show(patientName, drugName, qty, hasShelf) {
      quantity = qty;
      patientEl.textContent = patientName;
      drugEl.textContent = drugName;
      qtyEl.textContent = String(qty);
      if (hasShelf) {
        stateText.textContent = "Pick the matching bin";
        stateEl.classList.remove("rxcard__state--stuck");
      } else {
        stateText.textContent = "No Rx shelf — place one to fill";
        stateEl.classList.add("rxcard__state--stuck");
      }
      card.classList.remove("rxcard--filling");
      card.hidden = false;
      // Restart the slide-in when a new script follows immediately.
      card.classList.remove("rxcard--in");
      void card.offsetWidth;
      card.classList.add("rxcard--in");
    },
    setFilling() {
      stateText.textContent = `Counting out ${quantity}`;
      card.classList.add("rxcard--filling");
    },
    hide() {
      card.hidden = true;
    },
  };
}
