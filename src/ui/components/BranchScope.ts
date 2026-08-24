// Branch scope chips (SPEC §19, §20, §28): the small row of store chips a
// dock sheet uses to say which branch its rows belong to — Team assigns per
// branch, Orders buys per branch. Hidden while the network is one store;
// opening a sheet always lands on the store the player is standing in.
// Orders also asks for the depot chip (M15): the §20 central-purchasing
// scope joins the row once the DC stands, under the same catalog.

import { DC_SCOPE_ID } from "../../sim/dc";
import type { Sim } from "../../sim/sim";
import { storeLabel } from "../../sim/state";
import { h } from "../dom";

export interface BranchScopeOptions {
  /** Append the §20 depot chip while the DC exists (DC_SCOPE_ID). */
  depotChip?: boolean;
}

export interface BranchScopeHandle {
  root: HTMLElement;
  /** The scoped store id — or DC_SCOPE_ID with the depot chip on. Always
   *  something real (falls back to the active store). */
  current(): string;
  /** Re-derive chips from state (a branch was bought, rep moved). */
  refresh(): void;
  /** Back to the active store — called when the sheet opens. */
  reset(): void;
}

export function BranchScope(
  sim: Sim,
  onChange: () => void,
  options: BranchScopeOptions = {},
): BranchScopeHandle {
  let scoped: string = sim.snapshot.activeStoreId;
  const root = h("div", { cls: "bscope", attrs: { role: "group", "aria-label": "Branch" } });

  function depotShown(): boolean {
    return options.depotChip === true && sim.snapshot.dc !== null;
  }

  function current(): string {
    if (scoped === DC_SCOPE_ID) {
      if (depotShown()) return scoped;
      scoped = sim.snapshot.activeStoreId;
    }
    if (!sim.snapshot.stores.some((s) => s.id === scoped)) {
      scoped = sim.snapshot.activeStoreId;
    }
    return scoped;
  }

  function chip(id: string, label: string, marked: boolean, cls = ""): void {
    const on = id === current();
    const button = h(
      "button",
      {
        cls: `bscope__chip${on ? " bscope__chip--on" : ""}${cls}`,
        attrs: { type: "button", "aria-pressed": String(on) },
      },
      [
        ...(marked
          ? [h("span", { cls: "bscope__cross", attrs: { "aria-hidden": "true" }, text: "✚" })]
          : []),
        label,
      ],
    );
    button.addEventListener("pointerdown", (e) => e.preventDefault());
    button.addEventListener("click", () => {
      if (scoped === id) return;
      scoped = id;
      refresh();
      onChange();
    });
    root.append(button);
  }

  function refresh(): void {
    const state = sim.snapshot;
    root.hidden = state.stores.length < 2 && !depotShown();
    if (root.hidden) return;
    root.replaceChildren();
    for (const store of state.stores) {
      chip(store.id, storeLabel(state, store), store.id === state.activeStoreId);
    }
    if (depotShown()) chip(DC_SCOPE_ID, "Depot", false, " bscope__chip--depot");
  }

  refresh();
  return {
    root,
    current,
    refresh,
    reset: () => {
      scoped = sim.snapshot.activeStoreId;
      refresh();
    },
  };
}
