// Transfer slip (SPEC §20, §28): the shortage counter-move, drafted where
// the shortage is felt — the Orders sheet's side column and the reports
// rollup both pin this slip. Each line speaks the situation whole
// ("Riverside is out of Amoxicillin 500 — Downtown holds 300") with a unit
// field and one button; the move compiles onto the first van that can take
// it (sim/dc.ts planTransfer — the same check the command runs).

import { DRUG_DEFS } from "../../data/drugs";
import { OTC_DEFS } from "../../data/otc";
import { planTransfer, TRUCK_COST } from "../../sim/dc";
import { onHand, sales7d } from "../../sim/inventory";
import { canFillDrug } from "../../sim/licenses";
import type { Sim } from "../../sim/sim";
import { storeLabel, storeName, type StoreState } from "../../sim/state";
import { h } from "../dom";
import { money } from "../format";

/** Shortage lines shown before the slip gets noisy. */
const MAX_LINES = 6;

export interface TransferDraftOptions {
  /** Fix the receiving branch (Orders' scoped store); omit for the
   *  reports slip, which carries its own receiving-branch chips. */
  target?: () => string | null;
}

export interface TransferDraftHandle {
  root: HTMLElement;
  refresh(): void;
}

interface ShortageLine {
  skuId: string;
  name: string;
  source: StoreState;
  holds: number;
  /** Trailing 7-day units across the network — the urgency sort key. */
  moved: number;
}

export function TransferDraft(sim: Sim, options: TransferDraftOptions = {}): TransferDraftHandle {
  let pickedTarget: string | null = null;
  const chips = h("div", { cls: "tslip__chips", attrs: { role: "group", "aria-label": "Receiving branch" } });
  const lines = h("div", { cls: "tslip__lines" });
  const note = h("p", { cls: "tslip__note" });
  const root = h("div", { cls: "tslip" }, [
    h("p", { cls: "tslip__eyebrow", text: "Between branches" }),
    chips,
    lines,
    note,
  ]);
  root.hidden = true;

  function targetStore(): StoreState | null {
    const state = sim.snapshot;
    if (options.target) {
      const id = options.target();
      return id === null ? null : (state.stores.find((s) => s.id === id) ?? null);
    }
    if (pickedTarget === null || !state.stores.some((s) => s.id === pickedTarget)) {
      pickedTarget = state.activeStoreId;
    }
    return state.stores.find((s) => s.id === pickedTarget) ?? null;
  }

  /** What the receiving branch is out of that a sibling could cover,
   *  network best-sellers first — a fresh branch reads as "stock me from
   *  the others", a shortage reads as the §20 example sentence. */
  function shortageLines(target: StoreState): ShortageLine[] {
    const state = sim.snapshot;
    const out: ShortageLine[] = [];
    const consider = (skuId: string, name: string): void => {
      if (onHand(target, skuId) > 0) return;
      let source: StoreState | null = null;
      let holds = 0;
      let moved = 0;
      for (const store of state.stores) {
        moved += sales7d(store, skuId);
        if (store.id === target.id) continue;
        const held = onHand(store, skuId);
        if (held > holds) {
          holds = held;
          source = store;
        }
      }
      if (source === null || moved === 0) return;
      out.push({ skuId, name, source, holds, moved });
    };
    for (const def of DRUG_DEFS) {
      // The vans carry no cold chain, and a SKU the branch couldn't sell
      // (license, cabinet) was never its shortage.
      if (def.refrigerated === true || !canFillDrug(state, target, def)) continue;
      consider(def.id, def.name);
    }
    for (const def of OTC_DEFS) consider(def.id, def.name);
    return out;
  }

  function refresh(): void {
    const state = sim.snapshot;
    const target = targetStore();
    root.hidden =
      state.dc === null ||
      state.stores.length < 2 ||
      (options.target !== undefined && target === null);
    if (root.hidden) return;
    // A slip mid-edit holds still — rebuilding under the pointer would eat
    // the typed units.
    if (root.contains(document.activeElement)) return;
    chips.hidden = options.target !== undefined;
    if (!chips.hidden) {
      chips.replaceChildren();
      for (const store of state.stores) {
        const on = store.id === target?.id;
        const chip = h("button", {
          cls: `bscope__chip${on ? " bscope__chip--on" : ""}`,
          text: storeLabel(state, store),
          attrs: { type: "button", "aria-pressed": String(on) },
        });
        chip.addEventListener("pointerdown", (e) => e.preventDefault());
        chip.addEventListener("click", () => {
          pickedTarget = store.id;
          refresh();
        });
        chips.append(chip);
      }
    }

    lines.replaceChildren();
    note.textContent = "";
    if (target === null) return;

    if (state.dc !== null && state.dc.trucks.length === 0) {
      note.textContent = `No vans in the garage yet — the depot sells them at ${money(TRUCK_COST)}.`;
      return;
    }

    const shortages = shortageLines(target).sort((a, b) => b.moved - a.moved);
    if (shortages.length === 0) {
      lines.append(
        h("p", {
          cls: "tslip__none",
          text: `Nothing is out at ${storeLabel(state, target)} that another branch could cover.`,
        }),
      );
      return;
    }
    for (const line of shortages.slice(0, MAX_LINES)) {
      const field = h("input", {
        cls: "qty__field tslip__qty",
        attrs: {
          type: "text",
          inputmode: "numeric",
          "aria-label": `${line.name} units to move`,
        },
      });
      field.value = String(Math.max(1, Math.floor(line.holds / 2)));
      const status = h("span", { cls: "tslip__status" });
      const move = h("button", {
        cls: "pill pill--primary pill--small tslip__go",
        text: "Load the van",
        attrs: { type: "button" },
      });
      move.addEventListener("pointerdown", (e) => e.preventDefault());
      move.addEventListener("click", () => {
        const units = Math.min(line.holds, Number(field.value.replace(/\D+/g, "")) || 0);
        if (units < 1) return;
        const plan = planTransfer(sim.snapshot, line.source.id, target.id, line.skuId, units);
        if (!plan.ok) {
          status.textContent = plan.reason;
          return;
        }
        sim.dispatch({
          type: "transfer.create",
          fromStoreId: line.source.id,
          toStoreId: target.id,
          skuId: line.skuId,
          units,
        });
      });
      lines.append(
        h("div", { cls: "tslip__row" }, [
          h("p", { cls: "tslip__text" }, [
            h("span", { text: `${storeLabel(state, target)} is out of ` }),
            h("span", { cls: "tslip__sku", text: line.name }),
            h("span", {
              text: ` — ${storeName(state, line.source)} holds ${line.holds}.`,
            }),
          ]),
          h("div", { cls: "tslip__act" }, [field, move]),
          status,
        ]),
      );
    }
    if (shortages.length > MAX_LINES) {
      note.textContent = `+${shortages.length - MAX_LINES} more shortages — the busiest move first.`;
    }
  }

  refresh();
  return { root, refresh };
}
