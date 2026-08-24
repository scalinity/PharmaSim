// Transfer slip (SPEC §20, §28): the shortage counter-move, drafted where
// the shortage is felt — the Orders sheet's side column and the reports
// rollup both pin this slip. Each line speaks the situation whole
// ("Riverside is out of Amoxicillin 500 — Downtown holds 300") with a unit
// field and one button; the move compiles onto the first van that can take
// it (sim/dc.ts planTransfer — the same check the command runs).

import { DRUG_DEFS } from "../../data/drugs";
import { OTC_DEFS } from "../../data/otc";
import {
  pendingDeliveryUnits,
  pendingPickupUnits,
  planTransfer,
  TRUCK_COST,
} from "../../sim/dc";
import { onHand, sales7d } from "../../sim/inventory";
import { canFillDrug } from "../../sim/licenses";
import type { Sim } from "../../sim/sim";
import { storeLabel, storeName, type DcState, type StoreState } from "../../sim/state";
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
  /** Null when the answer is already drafted (incoming > 0). */
  source: StoreState | null;
  holds: number;
  /** What the source could still give — held minus units pending drafts
   *  already promise off its shelves (the same net the command clamps to). */
  available: number;
  /** Units already riding a drafted transfer to the receiving branch. */
  incoming: number;
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
   *  the others", a shortage reads as the §20 example sentence. The source
   *  is the sibling with the most *available* units (held net of pending
   *  drafts), and a shortage already answered by a drafted transfer shows
   *  as riding, not as the same move re-offered. */
  function shortageLines(target: StoreState, dc: DcState): ShortageLine[] {
    const state = sim.snapshot;
    const out: ShortageLine[] = [];
    const consider = (skuId: string, name: string): void => {
      if (onHand(target, skuId) > 0) return;
      let source: StoreState | null = null;
      let holds = 0;
      let available = 0;
      let moved = 0;
      for (const store of state.stores) {
        moved += sales7d(store, skuId);
        if (store.id === target.id) continue;
        const held = onHand(store, skuId);
        const free = held - pendingPickupUnits(dc, store.id, skuId);
        if (free > available) {
          available = free;
          holds = held;
          source = store;
        }
      }
      if (moved === 0) return;
      const incoming = pendingDeliveryUnits(dc, target.id, skuId);
      if (incoming === 0 && (source === null || available < 1)) return;
      out.push({ skuId, name, source, holds, available, incoming, moved });
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

  /** What the last repaint drew, as a cheap string — the host panels call
   *  refresh on every sale and spawn, and rebuilding six input rows per
   *  frame for an unchanged set is DOM churn the §30 budget won't carry. */
  let paintedSig = "";

  function refresh(): void {
    const state = sim.snapshot;
    const target = targetStore();
    root.hidden =
      state.dc === null ||
      state.stores.length < 2 ||
      (options.target !== undefined && target === null);
    if (root.hidden) {
      paintedSig = "";
      return;
    }
    // A slip mid-edit holds still — rebuilding under the pointer would eat
    // the typed units. paintedSig stays put: it describes the DOM as
    // drawn, and the blur-time refresh must compare against that.
    if (root.contains(document.activeElement)) return;

    const dc = state.dc;
    const shortages =
      target !== null && dc !== null && dc.trucks.length > 0
        ? shortageLines(target, dc).sort((a, b) => b.moved - a.moved)
        : [];
    const sig = [
      target?.id ?? "",
      dc?.trucks.length ?? 0,
      state.stores.map((s) => `${s.id}=${storeLabel(state, s)}`).join("|"),
      shortages
        .map(
          (l) =>
            `${l.skuId}:${l.source?.id ?? ""}:${l.holds}:${l.available}:${l.incoming}`,
        )
        .join("|"),
    ].join("§");
    if (sig === paintedSig) return;
    paintedSig = sig;

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
          // A chip switch is structural: let go of any focused qty field
          // first, or the mid-edit guard would swallow this repaint and
          // the slip would keep drawing the old branch (the dispatch
          // board's dropFocus rule).
          const active = document.activeElement;
          if (active instanceof HTMLElement) active.blur();
          pickedTarget = store.id;
          refresh();
        });
        chips.append(chip);
      }
    }

    lines.replaceChildren();
    note.textContent = "";
    if (target === null || dc === null) return;

    if (dc.trucks.length === 0) {
      note.textContent = `No vans in the garage yet — the depot sells them at ${money(TRUCK_COST)}.`;
      return;
    }

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
      // A shortage a drafted transfer already answers reads as riding, not
      // as the same move offered again — the double-click double-draft trap.
      if (line.incoming > 0 || line.source === null) {
        lines.append(
          h("div", { cls: "tslip__row" }, [
            h("p", { cls: "tslip__text" }, [
              h("span", { cls: "tslip__sku", text: line.name }),
              h("span", {
                text: ` — ×${line.incoming} already riding a van to ${storeLabel(state, target)}, lands at dawn.`,
              }),
            ]),
          ]),
        );
        continue;
      }
      const source = line.source;
      const field = h("input", {
        cls: "qty__field tslip__qty",
        attrs: {
          type: "text",
          inputmode: "numeric",
          "aria-label": `${line.name} units to move`,
        },
      });
      field.value = String(Math.max(1, Math.floor(line.available / 2)));
      const status = h("span", { cls: "tslip__status" });
      const move = h("button", {
        cls: "pill pill--primary pill--small tslip__go",
        text: "Load the van",
        attrs: { type: "button" },
      });
      move.addEventListener("pointerdown", (e) => e.preventDefault());
      move.addEventListener("click", () => {
        const units = Math.min(line.available, Number(field.value.replace(/\D+/g, "")) || 0);
        if (units < 1) return;
        const plan = planTransfer(sim.snapshot, source.id, target.id, line.skuId, units);
        if (!plan.ok) {
          status.textContent = plan.reason;
          return;
        }
        sim.dispatch({
          type: "transfer.create",
          fromStoreId: source.id,
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
              text:
                ` — ${storeName(state, source)} holds ${line.holds}.` +
                (line.available < line.holds
                  ? ` ×${line.holds - line.available} of that is already promised to a van.`
                  : ""),
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
