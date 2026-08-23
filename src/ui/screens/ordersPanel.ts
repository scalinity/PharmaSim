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
import {
  bankStatus,
  catalog,
  categoryLabel,
  COPAY,
  listWholesale,
  orderTotal,
  skuLock,
  supplierDiscount,
  unitCost,
  unitMargin,
  type CatalogEntry,
} from "../../sim/economy";
import type { SimEvent } from "../../sim/events";
import { draftOrder, otcPrice, priceMultiplier, sales7d, stockOf } from "../../sim/inventory";
import type { Sim } from "../../sim/sim";
import { fridgePips } from "../components/Meter";
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

  // --- Left leaf: the order form ---

  const head = h("div", { cls: "oform__head", attrs: { "aria-hidden": "true" } });
  for (const label of COLUMNS) head.append(h("span", { cls: "oform__col", text: label }));
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
    if (row.entry.refrigerated && units > 0) {
      // The fridge is the ceiling (§14): the same clamp the order command
      // applies, so the stub never promises units the command would trim.
      const capped = coldClampUnits(sim.snapshot, units, coldClaimedElsewhere(row.entry.skuId));
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
      sim.dispatch({ type: "reorder.setRule", skuId: row.entry.skuId, min, target });
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
      min: null,
      target: null,
    };

    let priceCell: HTMLElement;
    if (entry.kind === "otc") {
      row.tag = PriceTag({
        msrp: otcDef(entry.skuId).msrp,
        multiplier: priceMultiplier(sim.snapshot.store, entry.skuId),
        name: entry.name,
        onChange: (multiplier) => {
          sim.dispatch({ type: "otc.setPrice", skuId: entry.skuId, multiplier });
          refreshRow(row);
        },
      });
      priceCell = row.tag.root;
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
    const state = sim.snapshot;
    const capacity = fridgeCapacity(state);
    let cartCold = 0;
    for (const [skuId, units] of cart) {
      if (rows.get(skuId)?.entry.refrigerated) cartCold += units;
    }
    const spoken = refrigeratedHeld(state.store) + refrigeratedInbound(state.store) + cartCold;
    if (spoken === meterSpoken && capacity === meterCapacity) return;
    meterSpoken = spoken;
    meterCapacity = capacity;

    fridgeMeterHost.replaceChildren();
    if (capacity === 0) {
      fridgeMeterHost.append(
        h("p", {
          cls: "oform__coldnote",
          text: `No medical fridge on the floor — the Build palette sells one for ${money(furnitureDef("fridge_medical").cost)}.`,
        }),
      );
      return;
    }
    const free = Math.max(0, capacity - spoken);
    fridgeMeterHost.append(
      fridgePips(Math.min(spoken, capacity), capacity),
      h("span", {
        cls: "oform__coldnum",
        text: `${spoken} of ${capacity} cold units spoken for · ${free} to order`,
      }),
    );
  }

  for (const section of SECTIONS) {
    const entries = catalog(sim.snapshot).filter(section.keep);
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
  const form = Panel({ cls: "oform" }, [
    h("div", { cls: "oform__top" }, [
      h("div", {}, [
        h("p", { cls: "oform__eyebrow", text: "Hudson Valley Drug \u00b7 wholesale order" }),
        h("h2", { cls: "panel__title", text: "Orders" }),
      ]),
      tierChip,
    ]),
    head,
    list,
  ]);

  // --- Right leaf: the carbon duplicate + the bank's card ---

  const stubLines = h("div", { cls: "stub__lines" });
  const stubUnits = h("span", { cls: "stub__num" });
  const stubTotal = h("span", { cls: "stub__num stub__num--total" });
  const stubAfter = h("span", { cls: "stub__num" });
  const placeButton = PillButton("Place order", () => {
    const lines = [...cart].map(([skuId, units]) => ({ skuId, units }));
    if (lines.length > 0) sim.dispatch({ type: "order.submit", lines });
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
      h("p", {
        cls: "stub__hint",
        text: "Cash leaves the till now. The van unloads into the backroom before you open tomorrow.",
      }),
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

  const root = h("div", { cls: "orders" }, [
    h("div", { cls: "orders__leaf" }, [form]),
    h("div", { cls: "orders__side" }, [stub, bank]),
  ]);
  root.hidden = true;

  // --- Updates ---

  function refreshRow(row: Row): void {
    const state = sim.snapshot;
    // Locks move mid-session — a bought license or a placed cabinet opens
    // rows this panel built while they were still gated (§12).
    row.entry.lock = skuLock(state, row.entry.skuId);
    const stock = stockOf(state.store, row.entry.skuId);
    const sell =
      row.entry.kind === "otc" ? otcPrice(state.store, row.entry.skuId) : row.entry.listPrice;
    const marginValue = unitMargin(state, row.entry, sell);

    const list = listWholesale(row.entry.skuId);
    const cost = unitCost(state, row.entry.skuId);
    row.cost.textContent = money(cost);
    row.costList.textContent = cost < list ? money(list) : "";
    row.margin.textContent = money(marginValue);
    row.margin.classList.toggle("orow__margin--thin", marginValue > 0 && marginValue < THIN_MARGIN);
    row.margin.classList.toggle("orow__margin--under", marginValue <= 0);
    row.onHand.textContent = `${stock.shelved} / ${stock.backroom}`;
    row.onHand.classList.toggle("orow__hand--out", stock.shelved + stock.backroom === 0);
    const moved = sales7d(state.store, row.entry.skuId);
    row.sales.textContent = moved === 0 ? "\u2014" : String(moved);

    const locked = row.entry.lock !== null;
    // A SKU that just locked (cabinet sold mid-cart) leaves the cart too —
    // otherwise the stub totals units the order command would silently drop.
    if (locked && cart.delete(row.entry.skuId)) {
      row.field.value = "";
      row.root.classList.remove("orow--ordered");
    }
    row.root.classList.toggle("orow--locked", locked);
    row.meta.textContent = row.entry.lock ?? categoryLabel(row.entry.category);
    row.field.disabled = locked;
    if (row.tag) row.tag.set(priceMultiplier(state.store, row.entry.skuId));

    const rule = state.store.reorderRules[row.entry.skuId];
    if (row.min && row.min !== document.activeElement) {
      row.min.value = rule ? String(rule.min) : "";
    }
    if (row.target && row.target !== document.activeElement) {
      row.target.value = rule ? String(rule.target) : "";
    }
  }

  function refreshStub(): void {
    const state = sim.snapshot;
    const lines = [...cart].map(([skuId, units]) => ({ skuId, units }));
    const total = orderTotal(state, lines);
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
      stubLines.append(
        h("div", { cls: "stub__line" }, [
          h("span", { cls: "stub__lname", text: entry?.name ?? line.skuId }),
          h("span", { cls: "stub__lqty", text: `\u00d7${line.units}` }),
          h("span", {
            cls: "stub__lcost",
            text: money(unitCost(state, line.skuId) * line.units),
          }),
        ]),
      );
    }
    if (lines.length > STUB_LINES) {
      stubLines.append(
        h("p", { cls: "stub__more", text: `+${lines.length - STUB_LINES} more lines` }),
      );
    }

    stubUnits.textContent = String(units);
    stubTotal.textContent = money(total);
    stubAfter.textContent = money(state.cash - total);
    const short = total > state.cash;
    stubAfter.classList.toggle("stub__num--short", short);
    placeButton.disabled = lines.length === 0 || short;
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

    const discount = supplierDiscount(state.repStars);
    tierChip.textContent =
      discount > 0
        ? `Supplier tier \u00b7 ${(discount * 100).toFixed(0)}% off list`
        : "No supplier tier yet \u00b7 2.0\u2605 earns 4% off";
  }

  function refreshAll(): void {
    for (const row of rows.values()) refreshRow(row);
    refreshFridgeMeter();
    refreshStub();
    refreshBank();
    headMin.hidden = !sim.snapshot.store.reorderUnlocked;
    headTarget.hidden = !sim.snapshot.store.reorderUnlocked;
    form.classList.toggle("oform--rules", sim.snapshot.store.reorderUnlocked);
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
        ? coldClampUnits(sim.snapshot, units, coldClaimedElsewhere(skuId))
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
  bus.on("order.submitted", () => {
    clearCart();
    invalidate();
  });
  bus.on("order.delivered", invalidate);
  bus.on("day.phaseChanged", (e) => {
    // Morning: reorder rules write tomorrow's order up for you (§11) — it still
    // needs a signature.
    if (e.phase !== "morning" || draftedDay === e.day) return;
    draftedDay = e.day;
    const draft = draftOrder(sim.snapshot);
    if (Object.keys(draft).length === 0) return;
    // Locks may have moved while the panel was closed (a fridge or cabinet
    // placed mid-shift never reached refreshRow) — re-derive them so the
    // draft doesn't skip freshly unlocked rows on stale reasons.
    for (const row of rows.values()) {
      row.entry.lock = skuLock(sim.snapshot, row.entry.skuId);
    }
    setCart(draft);
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
