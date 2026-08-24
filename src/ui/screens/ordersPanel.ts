// Orders panel (SPEC §10, §11, §28): the wholesaler's order form, ruled in
// columns and filled in on the counter. The left leaf lists what can be bought
// — cost, your price, margin, what's on hand, what moved this week — and the
// right leaf is the carbon duplicate you total up and sign, with the bank's
// card clipped underneath. All money is Plex Mono (§28).

import type { EventBus } from "../../core/bus";
import { furnitureDef } from "../../data/furniture";
import { otcDef } from "../../data/otc";
import {
  coldClampUnits,
  fridgeCapacity,
  refrigeratedHeld,
  refrigeratedInbound,
} from "../../sim/coldchain";
import { DC_SCOPE_ID, dcStockOf } from "../../sim/dc";
import {
  bankStatus,
  catalog,
  categoryLabel,
  COPAY,
  DC_DISCOUNT,
  dcOrderTotal,
  dcSkuLock,
  dcUnitCost,
  listWholesale,
  orderTotal,
  round2,
  shortageActive,
  shortageFillCap,
  skuLock,
  supplierDiscount,
  unitCost,
  unitMargin,
  type CatalogEntry,
} from "../../sim/economy";
import type { SimEvent } from "../../sim/events";
import { draftOrder, otcPrice, priceMultiplier, sales7d, stockOf } from "../../sim/inventory";
import type { Sim } from "../../sim/sim";
import { activeStore, storeById, storeName, type StoreState } from "../../sim/state";
import { BranchScope } from "../components/BranchScope";
import { fridgePips } from "../components/Meter";
import { TransferDraft } from "../components/TransferDraft";
import { Panel } from "../components/Panel";
import { PillButton } from "../components/PillButton";
import { PriceTag, type PriceTagHandle } from "../components/PriceTag";
import { h } from "../dom";
import { money } from "../format";

/** A case of six out front, a shelf of five behind the counter. */
const STEP_OTC = 6;
const STEP_RX = 5;
const DRAW_STEP = 500;
const STUB_LINES = 7;
/** Under two dollars a unit, the shelf space is barely paying for itself. */
const THIN_MARGIN = 2;

interface Section {
  title: string;
  note: string;
  keep: (entry: CatalogEntry) => boolean;
  /** Marks the cold-chain section so the fridge meter can ride under it. */
  cold?: boolean;
}

const SECTIONS: readonly Section[] = [
  {
    title: "Tier 1 \u00b7 community formulary",
    note: `The insurer's price is fixed; every fill also takes the ${money(COPAY)} copay at the register.`,
    keep: (e) => e.kind === "rx" && e.tier === 1 && !e.refrigerated,
  },
  {
    title: "Front store \u00b7 you set the price",
    note: "Wholesale is 55% of MSRP. The ticks on each tag are where shoppers start walking past.",
    keep: (e) => e.kind === "otc",
  },
  {
    title: "Tier 2 \u00b7 expanded formulary",
    note: "Listed so you can see what the licence would buy you.",
    keep: (e) => e.kind === "rx" && e.tier === 2 && !e.refrigerated,
  },
  {
    title: "Refrigerated \u00b7 cold chain",
    note: "Lives in the medical fridge \u2014 40 cold units each. The vaccine dose is what the station gives out.",
    keep: (e) => e.kind === "rx" && e.refrigerated,
    cold: true,
  },
  {
    title: "Tier 3 \u00b7 controlled substances",
    note: "Needs the licence and a locked cabinet in this store.",
    keep: (e) => e.kind === "rx" && e.tier === 3 && !e.refrigerated,
  },
];

const COLUMNS: readonly string[] = ["item", "cost", "your price", "margin", "on hand", "7-day"];

export interface OrdersPanelHandle {
  root: HTMLElement;
  setVisible(on: boolean): void;
}

interface Row {
  entry: CatalogEntry;
  root: HTMLElement;
  meta: HTMLElement;
  cost: HTMLElement;
  /** List price, shown struck only while a supplier tier is shaving it. */
  costList: HTMLElement;
  margin: HTMLElement;
  onHand: HTMLElement;
  sales: HTMLElement;
  field: HTMLInputElement;
  tag: PriceTagHandle | null;
  /** The OTC row's list-price cell, shown in place of the tag while the
   *  depot scope is up (§20: pricing is per store, the depot has none). */
  fixedOtc: HTMLElement | null;
  min: HTMLInputElement | null;
  target: HTMLInputElement | null;
}

/** Digits only, and never more than a warehouse would send. */
function readNumber(field: HTMLInputElement, max: number): number {
  const digits = field.value.replace(/\D+/g, "");
  const value = Math.min(max, digits === "" ? 0 : Number(digits));
  const text = value === 0 ? "" : String(value);
  if (field.value !== text) field.value = text;
  return value;
}

export function createOrdersPanel(sim: Sim, bus: EventBus<SimEvent>): OrdersPanelHandle {
  const cart = new Map<string, number>();
  const rows = new Map<string, Row>();
  let visible = false;
  let pending = false;
  let draftedDay = 0;

  // §19: the form is written up for one branch at a time — the scope names
  // it, the cart empties when it changes (a cart belongs to one door).
  // §20 (M15): the depot joins the row once the DC stands — same catalog,
  // central terms.
  const scope = BranchScope(
    sim,
    () => {
      clearCart();
      refreshAll();
      // The scoped store's own §11 reorder rules draft its cart, morning-only,
      // same as the auto-draft on the day turn. The depot has no rules.
      if (!scopeIsDc() && sim.snapshot.phase === "morning") setCart(draftOrder(scopedStore()));
    },
    { depotChip: true },
  );

  /** §20: the form is made out to the depot, not a branch. */
  function scopeIsDc(): boolean {
    return scope.current() === DC_SCOPE_ID;
  }

  /** The branch this order form is made out to. Meaningless while the
   *  depot scope is up — every consumer branches on scopeIsDc() first. */
  function scopedStore(): StoreState {
    return storeById(sim.snapshot, scope.current()) ?? activeStore(sim.snapshot);
  }

  // --- Left leaf: the order form ---

  const head = h("div", { cls: "oform__head", attrs: { "aria-hidden": "true" } });
  // Two columns re-speak under the depot scope (§20): the price is the
  // list, the stock on hand is the depot's.
  const headCols = new Map<string, HTMLElement>();
  for (const label of COLUMNS) {
    const col = h("span", { cls: "oform__col", text: label });
    headCols.set(label, col);
    head.append(col);
  }
  const headMin = h("span", { cls: "oform__col oform__col--rule", text: "min" });
  const headTarget = h("span", { cls: "oform__col oform__col--rule", text: "to" });
  head.append(headMin, headTarget, h("span", { cls: "oform__col", text: "units" }));

  const list = h("div", { cls: "oform__list" });

  function stepper(row: Row): HTMLElement {
    const step = row.entry.kind === "otc" ? STEP_OTC : STEP_RX;
    const nudge = (delta: number): void => {
      const next = Math.max(0, readNumber(row.field, 9999) + delta);
      row.field.value = next === 0 ? "" : String(next);
      commit(row);
    };
    const less = h("button", {
      cls: "qty__btn",
      text: "\u2212",
      attrs: { type: "button", "aria-label": `Fewer ${row.entry.name}` },
    });
    const more = h("button", {
      cls: "qty__btn",
      text: "+",
      attrs: { type: "button", "aria-label": `More ${row.entry.name}` },
    });
    less.addEventListener("click", () => nudge(-step));
    more.addEventListener("click", () => nudge(step));
    for (const button of [less, more]) {
      button.addEventListener("pointerdown", (e) => e.preventDefault());
    }
    row.field.addEventListener("input", () => commit(row));
    return h("div", { cls: "qty" }, [less, row.field, more]);
  }

  /** Cold units the rest of the cart claims, excluding this row (§14). */
  function coldClaimedElsewhere(skuId: string): number {
    let claimed = 0;
    for (const [id, u] of cart) {
      if (id !== skuId && rows.get(id)?.entry.refrigerated) claimed += u;
    }
    return claimed;
  }

  function commit(row: Row): void {
    let units = readNumber(row.field, 9999);
    if (!scopeIsDc() && row.entry.refrigerated && units > 0) {
      // The fridge is the ceiling (§14): the same clamp the order command
      // applies, so the stub never promises units the command would trim.
      const capped = coldClampUnits(scopedStore(), units, coldClaimedElsewhere(row.entry.skuId));
      if (capped !== units) {
        units = capped;
        row.field.value = units === 0 ? "" : String(units);
      }
    }
    if (units > 0) cart.set(row.entry.skuId, units);
    else cart.delete(row.entry.skuId);
    row.root.classList.toggle("orow--ordered", units > 0);
    refreshFridgeMeter();
    refreshStub();
  }

  function ruleField(row: Row, kind: "min" | "target"): HTMLInputElement {
    const field = h("input", {
      cls: "orow__rule",
      attrs: {
        type: "text",
        inputmode: "numeric",
        "aria-label": `${row.entry.name} reorder ${kind === "min" ? "minimum" : "target"}`,
      },
    });
    field.addEventListener("input", () => {
      readNumber(field, 999);
      const min = Number(row.min?.value || 0);
      const target = Number(row.target?.value || 0);
      sim.dispatch({
        type: "reorder.setRule",
        skuId: row.entry.skuId,
        min,
        target,
        storeId: scopedStore().id,
      });
    });
    return field;
  }

  function buildRow(entry: CatalogEntry): Row {
    const meta = h("span", { cls: "orow__meta" });
    const cost = h("span", { cls: "orow__costnum" });
    const list = h("span", { cls: "orow__costlist" });
    const margin = h("span", { cls: "orow__margin" });
    const onHand = h("span", { cls: "orow__hand" });
    const sales = h("span", { cls: "orow__sales" });
    const field = h("input", {
      cls: "qty__field",
      attrs: { type: "text", inputmode: "numeric", "aria-label": `${entry.name} units to order` },
    });

    const row: Row = {
      entry,
      root: h("div", { cls: "orow" }),
      meta,
      cost,
      costList: list,
      margin,
      onHand,
      sales,
      field,
      tag: null,
      fixedOtc: null,
      min: null,
      target: null,
    };

    let priceCell: HTMLElement;
    if (entry.kind === "otc") {
      row.tag = PriceTag({
        msrp: otcDef(entry.skuId).msrp,
        multiplier: priceMultiplier(scopedStore(), entry.skuId),
        name: entry.name,
        onChange: (multiplier) => {
          sim.dispatch({
            type: "otc.setPrice",
            skuId: entry.skuId,
            multiplier,
            storeId: scopedStore().id,
          });
          refreshRow(row);
        },
      });
      // The depot scope swaps the tag for the plain list price (§20) —
      // display: contents keeps the wrapper out of the grid's columns.
      row.fixedOtc = h("span", { cls: "orow__fixed" }, [
        h("span", { cls: "orow__fixednum", text: money(entry.listPrice) }),
        h("span", { cls: "orow__fixedcap", text: "MSRP, list" }),
      ]);
      row.fixedOtc.hidden = true;
      priceCell = h("span", { cls: "orow__pricecell" }, [row.tag.root, row.fixedOtc]);
    } else {
      priceCell = h("span", { cls: "orow__fixed" }, [
        h("span", { cls: "orow__fixednum", text: money(entry.listPrice) }),
        h("span", { cls: "orow__fixedcap", text: "insurer, fixed" }),
      ]);
    }

    row.min = ruleField(row, "min");
    row.target = ruleField(row, "target");

    row.root.append(
      h("span", { cls: "orow__item" }, [
        h("span", { cls: "orow__name", text: entry.name }),
        meta,
      ]),
      h("span", { cls: "orow__cost" }, [cost, list]),
      priceCell,
      margin,
      onHand,
      sales,
      row.min,
      row.target,
      stepper(row),
    );
    return row;
  }

  // The §14 fridge meter rides under the cold-chain section's note and
  // tracks held stock, tomorrow's van and the cart being written right now.
  const fridgeMeterHost = h("div", { cls: "oform__fridge" });
  // refreshAll runs once per frame under sale churn while the panel is open;
  // rebuilding 40+ pips only when the numbers actually moved keeps the meter
  // out of the per-frame allocation budget (§30).
  let meterSpoken = -1;
  let meterCapacity = -1;

  function refreshFridgeMeter(): void {
    if (scopeIsDc()) {
      // §20: no cold room at the depot, no cold chain on the vans — the
      // section stays visible so the locks read beside their reason.
      if (meterCapacity !== -2) {
        meterCapacity = -2;
        meterSpoken = -1;
        fridgeMeterHost.replaceChildren(
          h("p", {
            cls: "oform__coldnote",
            text: "The vans carry no cold chain — refrigerated stock orders direct to each store's own fridge.",
          }),
        );
      }
      return;
    }
    const store = scopedStore();
    const capacity = fridgeCapacity(store);
    let cartCold = 0;
    for (const [skuId, units] of cart) {
      if (rows.get(skuId)?.entry.refrigerated) cartCold += units;
    }
    const spoken = refrigeratedHeld(store) + refrigeratedInbound(store) + cartCold;
    if (spoken === meterSpoken && capacity === meterCapacity) return;
    meterSpoken = spoken;
    meterCapacity = capacity;

    fridgeMeterHost.replaceChildren();
    if (capacity === 0) {
      // Cold stock boxed by the last fridge's sale is stranded, not gone —
      // say so rather than hide it behind the buy-a-fridge note.
      const stranded = refrigeratedHeld(store);
      fridgeMeterHost.append(
        h("p", {
          cls: "oform__coldnote",
          text:
            stranded > 0
              ? `No medical fridge on the floor — ${stranded} cold ${stranded === 1 ? "unit is" : "units are"} boxed in the backroom until one returns.`
              : `No medical fridge on the floor — the Build palette sells one for ${money(furnitureDef("fridge_medical").cost)}.`,
        }),
      );
      return;
    }
    // Selling a fridge can leave more cold stock than the survivors hold
    // (§14: nothing spoils, ordering stays blocked) — read it out honestly
    // instead of clamping the number alongside the pips.
    const over = spoken - capacity;
    fridgeMeterHost.append(
      fridgePips(Math.min(spoken, capacity), capacity),
      h("span", {
        cls: "oform__coldnum",
        text:
          over > 0
            ? `${spoken} of ${capacity} cold units — ${over} over capacity, nothing to order`
            : `${spoken} of ${capacity} cold units spoken for · ${capacity - spoken} to order`,
      }),
    );
  }

  for (const section of SECTIONS) {
    // The SKU list is the same for every store; locks re-derive per scope
    // in refreshRow, so the rows themselves are built once.
    const entries = catalog(sim.snapshot, activeStore(sim.snapshot)).filter(section.keep);
    if (entries.length === 0) continue;
    const head = h("div", { cls: "oform__section" }, [
      h("h3", { cls: "oform__sectitle", text: section.title }),
      h("p", { cls: "oform__secnote", text: section.note }),
    ]);
    if (section.cold) head.append(fridgeMeterHost);
    list.append(head);
    entries.forEach((entry, index) => {
      const row = buildRow(entry);
      if (index % 2 === 1) row.root.classList.add("orow--stripe");
      rows.set(entry.skuId, row);
      list.append(row.root);
    });
  }

  const tierChip = h("span", { cls: "oform__tier" });
  const formEyebrow = h("p", { cls: "oform__eyebrow", text: "Hudson Valley Drug \u00b7 wholesale order" });
  // \u00a719 non-goal, said where players would look for it: no transfers yet.
  const transferNote = h("p", {
    cls: "oform__transfernote",
    text: "Each branch orders on its own \u2014 moving stock between stores arrives with the distribution center.",
  });
  transferNote.hidden = true;
  const form = Panel({ cls: "oform" }, [
    h("div", { cls: "oform__top" }, [
      h("div", {}, [formEyebrow, h("h2", { cls: "panel__title", text: "Orders" })]),
      tierChip,
    ]),
    scope.root,
    transferNote,
    head,
    list,
  ]);

  // --- Right leaf: the carbon duplicate + the bank's card ---

  const stubLines = h("div", { cls: "stub__lines" });
  const stubHint = h("p", {
    cls: "stub__hint",
    text: "Cash leaves the till now. The van unloads into the backroom before you open tomorrow.",
  });
  const stubUnits = h("span", { cls: "stub__num" });
  const stubTotal = h("span", { cls: "stub__num stub__num--total" });
  const stubAfter = h("span", { cls: "stub__num" });
  const placeButton = PillButton("Place order", () => {
    const lines = [...cart].map(([skuId, units]) => ({ skuId, units }));
    if (lines.length === 0) return;
    if (scopeIsDc()) sim.dispatch({ type: "dc.order", lines });
    else sim.dispatch({ type: "order.submit", lines, storeId: scopedStore().id });
  });
  const clearButton = PillButton("Clear", () => clearCart(), {
    variant: "secondary",
    cls: "pill--small",
  });

  const stub = h("div", { cls: "stub" }, [
    h("span", { cls: "stub__mark", attrs: { "aria-hidden": "true" }, text: "duplicate" }),
    h("p", { cls: "stub__eyebrow", text: "Order stub" }),
    stubLines,
    h("div", { cls: "stub__foot" }, [
      h("div", { cls: "stub__row" }, [h("span", { text: "Units" }), stubUnits]),
      h("div", { cls: "stub__row stub__row--total" }, [h("span", { text: "Due today" }), stubTotal]),
      h("div", { cls: "stub__row stub__row--after" }, [
        h("span", { text: "Till after" }),
        stubAfter,
      ]),
      h("div", { cls: "stub__actions" }, [placeButton, clearButton]),
      stubHint,
    ]),
  ]);

  const bankLock = h("p", { cls: "bank__lock" });
  const bankLimit = h("span", { cls: "bank__num" });
  const bankOwed = h("span", { cls: "bank__num" });
  const bankOpen = h("span", { cls: "bank__num" });
  const drawButton = PillButton(`Draw $${DRAW_STEP}`, () => {
    sim.dispatch({ type: "loan.draw", amount: DRAW_STEP });
  }, { cls: "pill--small" });
  const repayButton = PillButton(`Repay $${DRAW_STEP}`, () => {
    sim.dispatch({ type: "loan.repay", amount: DRAW_STEP });
  }, { variant: "secondary", cls: "pill--small" });
  const bankBody = h("div", { cls: "bank__body" }, [
    h("div", { cls: "bank__row" }, [h("span", { text: "Credit line" }), bankLimit]),
    h("div", { cls: "bank__row" }, [h("span", { text: "Drawn" }), bankOwed]),
    h("div", { cls: "bank__row" }, [h("span", { text: "Available" }), bankOpen]),
    h("div", { cls: "bank__actions" }, [drawButton, repayButton]),
    h("p", { cls: "bank__fine", text: "0.4% a day, 2% minimum payment at close." }),
  ]);
  const familyNote = h("p", { cls: "bank__family" });
  const bank = h("div", { cls: "bank" }, [
    h("p", { cls: "bank__eyebrow", text: "Cortland Savings" }),
    bankLock,
    bankBody,
    familyNote,
  ]);

  // §20: the shortage slip rides the side column, made out to the same
  // branch as the form (hidden under the depot scope — the depot doesn't
  // run out, it distributes).
  const transferSlip = TransferDraft(sim, {
    target: () => (scopeIsDc() ? null : scopedStore().id),
  });

  const root = h("div", { cls: "orders" }, [
    h("div", { cls: "orders__leaf" }, [form]),
    h("div", { cls: "orders__side" }, [stub, bank, transferSlip.root]),
  ]);
  root.hidden = true;

  // --- Updates ---

  function refreshRow(row: Row): void {
    const state = sim.snapshot;
    const store = scopedStore();
    // Locks move mid-session — a bought license or a placed cabinet opens
    // rows this panel built while they were still gated (§12) — and follow
    // the scoped branch's own walls (§19), or the depot's terms (§20:
    // account licenses apply, per-store equipment doesn't, and the cold
    // chain can't ride the vans).
    const isDc = scopeIsDc();
    row.entry.lock = isDc
      ? dcSkuLock(state, row.entry.skuId)
      : skuLock(state, store, row.entry.skuId);
    const sell =
      !isDc && row.entry.kind === "otc" ? otcPrice(store, row.entry.skuId) : row.entry.listPrice;
    const marginValue = isDc
      ? round2(sell - dcUnitCost(state, row.entry.skuId))
      : unitMargin(state, store, row.entry, sell);

    const list = listWholesale(row.entry.skuId);
    const cost = isDc
      ? dcUnitCost(state, row.entry.skuId)
      : unitCost(state, store, row.entry.skuId);
    row.cost.textContent = money(cost);
    row.costList.textContent = cost < list ? money(list) : "";
    row.margin.textContent = money(marginValue);
    row.margin.classList.toggle("orow__margin--thin", marginValue > 0 && marginValue < THIN_MARGIN);
    row.margin.classList.toggle("orow__margin--under", marginValue <= 0);
    if (isDc) {
      // The depot's shelves are one pool (\u00a724) \u2014 no front/back split \u2014 and
      // central buying reads the whole network's week, not one till's.
      const held = state.dc ? dcStockOf(state.dc, row.entry.skuId) : 0;
      row.onHand.textContent = held === 0 ? "\u2014" : String(held);
      row.onHand.classList.toggle("orow__hand--out", held === 0);
      let moved = 0;
      for (const s of state.stores) moved += sales7d(s, row.entry.skuId);
      row.sales.textContent = moved === 0 ? "\u2014" : String(moved);
    } else {
      const stock = stockOf(store, row.entry.skuId);
      row.onHand.textContent = `${stock.shelved} / ${stock.backroom}`;
      row.onHand.classList.toggle("orow__hand--out", stock.shelved + stock.backroom === 0);
      const moved = sales7d(store, row.entry.skuId);
      row.sales.textContent = moved === 0 ? "\u2014" : String(moved);
    }
    if (row.tag && row.fixedOtc) {
      // \u00a720: the depot has no shelf price \u2014 the tag yields to the list.
      row.tag.root.hidden = isDc;
      row.fixedOtc.hidden = !isDc;
    }

    const locked = row.entry.lock !== null;
    // A SKU that just locked (cabinet sold mid-cart) leaves the cart too —
    // otherwise the stub totals units the order command would silently drop.
    if (locked && cart.delete(row.entry.skuId)) {
      row.field.value = "";
      row.root.classList.remove("orow--ordered");
    }
    // §16 shortage: the squeezed (possibly negative) margin reads rose, and
    // the meta names the squeeze — the same words the ticker uses.
    const short = shortageActive(state, row.entry.skuId);
    row.margin.classList.toggle("orow__margin--shortage", short);
    row.meta.classList.toggle("orow__meta--shortage", short && !locked);
    row.root.classList.toggle("orow--locked", locked);
    row.meta.textContent =
      row.entry.lock ??
      (short
        ? `${categoryLabel(row.entry.category)} · shortage — orders fill 60%`
        : categoryLabel(row.entry.category));
    row.field.disabled = locked;
    if (row.tag) row.tag.set(priceMultiplier(store, row.entry.skuId));

    const rule = store.reorderRules[row.entry.skuId];
    if (row.min && row.min !== document.activeElement) {
      row.min.value = rule ? String(rule.min) : "";
    }
    if (row.target && row.target !== document.activeElement) {
      row.target.value = rule ? String(rule.target) : "";
    }
  }

  function refreshStub(): void {
    const state = sim.snapshot;
    const store = scopedStore();
    const isDc = scopeIsDc();
    // \u00a716: the duplicate shows what the wholesaler will *fill*, not what
    // was asked \u2014 the same 60% cap the order command applies, so the stub
    // never totals units (or charges dollars) the van won't carry. Under
    // the depot scope the cap bites once for the whole network (\u00a720).
    const lines = [...cart].map(([skuId, units]) => ({
      skuId,
      asked: units,
      units: shortageFillCap(state, skuId, units),
    }));
    const total = isDc ? dcOrderTotal(state, lines) : orderTotal(state, store, lines);
    const units = lines.reduce((sum, l) => sum + l.units, 0);

    stubLines.replaceChildren();
    if (lines.length === 0) {
      stubLines.append(
        h("p", {
          cls: "stub__empty",
          text: "Nothing written up yet. Set units on any row \u2014 start with what sold this week.",
        }),
      );
    }
    for (const line of lines.slice(0, STUB_LINES)) {
      const entry = rows.get(line.skuId)?.entry;
      const capped = line.units < line.asked;
      stubLines.append(
        h("div", { cls: "stub__line" }, [
          h("span", { cls: "stub__lname", text: entry?.name ?? line.skuId }),
          h("span", {
            cls: `stub__lqty${capped ? " stub__lqty--capped" : ""}`,
            text: capped ? `\u00d7${line.units} of ${line.asked}` : `\u00d7${line.units}`,
          }),
          h("span", {
            cls: "stub__lcost",
            text: money(
              (isDc ? dcUnitCost(state, line.skuId) : unitCost(state, store, line.skuId)) *
                line.units,
            ),
          }),
        ]),
      );
    }
    if (lines.length > STUB_LINES) {
      stubLines.append(
        h("p", { cls: "stub__more", text: `+${lines.length - STUB_LINES} more lines` }),
      );
    }

    stubHint.textContent = isDc
      ? "Cash leaves the till now. The order lands on the depot shelves at dawn — the vans take it from there."
      : "Cash leaves the till now. The van unloads into the backroom before you open tomorrow.";
    stubUnits.textContent = String(units);
    stubTotal.textContent = money(total);
    stubAfter.textContent = money(state.cash - total);
    const short = total > state.cash;
    stubAfter.classList.toggle("stub__num--short", short);
    placeButton.disabled = lines.length === 0 || units === 0 || short;
    placeButton.textContent = short ? "Not enough cash" : "Place order";
    clearButton.hidden = lines.length === 0;
  }

  function refreshBank(): void {
    const state = sim.snapshot;
    const status = bankStatus(state);
    bankLock.textContent = status.lock ?? "";
    bankLock.hidden = status.lock === null;
    bankBody.hidden = status.lock !== null;
    bankLimit.textContent = money(status.limit);
    bankOwed.textContent = money(status.balance);
    bankOpen.textContent = money(status.available);
    drawButton.disabled = status.available < DRAW_STEP;
    repayButton.disabled = status.balance <= 0 || state.cash <= 0;
    familyNote.hidden = state.loans.family <= 0;
    familyNote.textContent = `Aunt Rosa is owed ${money(state.loans.family)} \u2014 15% of each day's profit goes back to her.`;

    // The tier is the scoped store's own earned contract (\u00a711/\u00a719) \u2014 or
    // the depot's flat \u221212%, which *replaces* the tier (\u00a720, never stacks).
    if (scopeIsDc()) {
      tierChip.textContent = `Central purchasing \u00b7 ${(DC_DISCOUNT * 100).toFixed(0)}% off list, replaces the supplier tier`;
    } else {
      const discount = supplierDiscount(scopedStore().repStars);
      tierChip.textContent =
        discount > 0
          ? `Supplier tier \u00b7 ${(discount * 100).toFixed(0)}% off list`
          : "No supplier tier yet \u00b7 2.0\u2605 earns 4% off";
    }
  }

  function refreshAll(): void {
    const state = sim.snapshot;
    const store = scopedStore();
    const isDc = scopeIsDc();
    scope.refresh();
    formEyebrow.textContent = isDc
      ? "Hudson Valley Drug \u00b7 depot order \u00b7 central purchasing"
      : state.stores.length > 1
        ? `Hudson Valley Drug \u00b7 order for ${storeName(state, store)}`
        : "Hudson Valley Drug \u00b7 wholesale order";
    // The old "transfers arrive with the DC" note retires the day they do.
    transferNote.hidden = state.stores.length < 2 || state.dc !== null;
    const priceHead = headCols.get("your price");
    if (priceHead) priceHead.textContent = isDc ? "list price" : "your price";
    const handHead = headCols.get("on hand");
    if (handHead) handHead.textContent = isDc ? "at depot" : "on hand";
    for (const row of rows.values()) refreshRow(row);
    refreshFridgeMeter();
    refreshStub();
    refreshBank();
    transferSlip.refresh();
    const rules = !isDc && store.reorderUnlocked;
    headMin.hidden = !rules;
    headTarget.hidden = !rules;
    form.classList.toggle("oform--rules", rules);
  }

  /** Coalesce the sale-by-sale churn into one repaint per frame. */
  function invalidate(): void {
    if (!visible || pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (visible) refreshAll();
    });
  }

  function clearCart(): void {
    cart.clear();
    for (const row of rows.values()) {
      row.field.value = "";
      row.root.classList.remove("orow--ordered");
    }
    refreshFridgeMeter();
    refreshStub();
  }

  function setCart(draft: Record<string, number>): void {
    clearCart();
    for (const [skuId, units] of Object.entries(draft)) {
      const row = rows.get(skuId);
      if (!row || row.entry.lock !== null) continue;
      // The draft obeys the same §14 cold clamp typed input does — the stub
      // must never total units (or block on cash) the command would trim.
      const capped = row.entry.refrigerated
        ? coldClampUnits(scopedStore(), units, coldClaimedElsewhere(skuId))
        : units;
      if (capped <= 0) continue;
      row.field.value = String(capped);
      cart.set(skuId, capped);
      row.root.classList.add("orow--ordered");
    }
    refreshFridgeMeter();
    refreshStub();
  }

  bus.on("cash.changed", invalidate);
  bus.on("rep.changed", invalidate);
  bus.on("stock.restocked", invalidate);
  bus.on("stock.out", invalidate);
  bus.on("sale.completed", invalidate);
  bus.on("rx.pickedUp", invalidate);
  bus.on("loan.changed", invalidate);
  bus.on("reorder.unlocked", invalidate);
  // §16: a shortage edge moves every squeezed row's cost, margin and cap.
  bus.on("shortage.started", invalidate);
  bus.on("shortage.ended", invalidate);
  bus.on("order.submitted", () => {
    clearCart();
    invalidate();
  });
  bus.on("order.delivered", invalidate);
  // §20 (M15): the depot chip joins the scope row, its stock column moves
  // with dawn deliveries and van loads, and a signed depot order clears
  // the duplicate like a store order does.
  bus.on("dc.bought", invalidate);
  bus.on("dc.orderSubmitted", () => {
    clearCart();
    invalidate();
  });
  bus.on("dc.delivered", invalidate);
  bus.on("truck.routeChanged", invalidate);
  bus.on("transfer.drafted", invalidate);
  bus.on("day.phaseChanged", (e) => {
    // Morning: reorder rules write tomorrow's order up for you (§11) — it
    // still needs a signature. The morning draft is the active store's; a
    // scope switch re-drafts for its branch.
    if (e.phase !== "morning" || draftedDay === e.day) return;
    draftedDay = e.day;
    scope.reset();
    const store = scopedStore();
    const draft = draftOrder(store);
    if (Object.keys(draft).length === 0) return;
    // Locks may have moved while the panel was closed (a fridge or cabinet
    // placed mid-shift never reached refreshRow) — re-derive them so the
    // draft doesn't skip freshly unlocked rows on stale reasons.
    for (const row of rows.values()) {
      row.entry.lock = skuLock(sim.snapshot, store, row.entry.skuId);
    }
    setCart(draft);
  });
  // A new branch joins the scope row; a morning switch re-anchors it.
  bus.on("branch.bought", invalidate);
  bus.on("branch.activeChanged", () => {
    scope.reset();
    clearCart();
    invalidate();
  });

  return {
    root,
    setVisible(on) {
      visible = on;
      root.hidden = !on;
      if (on) refreshAll();
    },
  };
}
