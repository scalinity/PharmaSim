// Branch scope chips (SPEC §19, §28): the small row of store chips a dock
// sheet uses to say which branch its rows belong to — Team assigns per
// branch, Orders buys per branch. Hidden while the network is one store;
// opening a sheet always lands on the store the player is standing in.

import type { Sim } from "../../sim/sim";
import { storeLabel } from "../../sim/state";
import { h } from "../dom";

export interface BranchScopeHandle {
  root: HTMLElement;
  /** The scoped store id — always a real store (falls back to active). */
  current(): string;
  /** Re-derive chips from state (a branch was bought, rep moved). */
  refresh(): void;
  /** Back to the active store — called when the sheet opens. */
  reset(): void;
}

export function BranchScope(sim: Sim, onChange: () => void): BranchScopeHandle {
  let scoped: string = sim.snapshot.activeStoreId;
  const root = h("div", { cls: "bscope", attrs: { role: "group", "aria-label": "Branch" } });

  function current(): string {
    if (!sim.snapshot.stores.some((s) => s.id === scoped)) {
      scoped = sim.snapshot.activeStoreId;
    }
    return scoped;
  }

  function refresh(): void {
    const state = sim.snapshot;
    root.hidden = state.stores.length < 2;
    if (root.hidden) return;
    root.replaceChildren();
    for (const store of state.stores) {
      const here = store.id === state.activeStoreId;
      const on = store.id === current();
      const chip = h(
        "button",
        {
          cls: `bscope__chip${on ? " bscope__chip--on" : ""}`,
          attrs: { type: "button", "aria-pressed": String(on) },
        },
        [
          ...(here ? [h("span", { cls: "bscope__cross", attrs: { "aria-hidden": "true" }, text: "✚" })] : []),
          storeLabel(state, store),
        ],
      );
      chip.addEventListener("pointerdown", (e) => e.preventDefault());
      chip.addEventListener("click", () => {
        if (scoped === store.id) return;
        scoped = store.id;
        refresh();
        onChange();
      });
      root.append(chip);
    }
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
