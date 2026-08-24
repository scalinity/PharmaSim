// Dispatch board (SPEC §20, §26, §28): the depot's clipboard. Each van is a
// freight manifest — a route rail of numbered stops down the left margin,
// picking-list rows in Plex Mono hanging off each stop, and the load meter
// as blister pips (one pip per ten units, pressed = spent). The garage
// sells the vans; the Orders sheet's Depot scope fills the shelves. Every
// edit dispatches the van's whole manifest (truck.setRoute) and surfaces
// the same §26 reasons the command checks, so the paper never promises a
// run the morning would drop.

import type { EventBus } from "../../core/bus";
import { DRUG_DEFS } from "../../data/drugs";
import { OTC_DEFS } from "../../data/otc";
import {
  allocatedUnits,
  dcHeldUnits,
  dcStockOf,
  MAX_TRUCKS,
  plannedPeakLoad,
  TRUCK_CAPACITY,
  TRUCK_COST,
  TRUCK_MAX_STOPS,
  truckLabel,
  validateTruckConfig,
} from "../../sim/dc";
import type { SimEvent } from "../../sim/events";
import type { Sim } from "../../sim/sim";
import {
  storeById,
  storeLabel,
  storeName,
  type Truck,
  type TruckStop,
  type TruckTransfer,
} from "../../sim/state";
import { Panel } from "../components/Panel";
import { PillButton } from "../components/PillButton";
import { h } from "../dom";
import { money } from "../format";

/** Picking lists step by a case of ten. */
const STEP_UNITS = 10;
/** One blister pip per ten units — 40 pips reads at a glance, 400 don't. */
const UNITS_PER_PIP = 10;

const SKU_NAMES = new Map<string, string>();
for (const def of DRUG_DEFS) SKU_NAMES.set(def.id, def.name);
for (const def of OTC_DEFS) SKU_NAMES.set(def.id, def.name);

function nameOf(skuId: string): string {
  return SKU_NAMES.get(skuId) ?? skuId;
}

export interface DepotPanelHandle {
  root: HTMLElement;
  setVisible(on: boolean): void;
}

export function createDepotPanel(sim: Sim, bus: EventBus<SimEvent>): DepotPanelHandle {
  let visible = false;
  let pending = false;

  const heldChip = h("span", { cls: "depot__held" });
  const stockList = h("div", { cls: "depot__stock" });
  const vansHost = h("div", { cls: "depot__vans" });

  const bays = h("span", { cls: "depot__bays" });
  const buyVan = PillButton(`Buy a van — ${money(TRUCK_COST)}`, () => {
    sim.dispatch({ type: "truck.buy" });
  });
  const garage = h("div", { cls: "depot__garage" }, [
    buyVan,
    bays,
    h("p", {
      cls: "depot__garagenote",
      text: `Each van runs one morning route — up to ${TRUCK_MAX_STOPS} stops, ${TRUCK_CAPACITY} units on the springs.`,
    }),
  ]);

  const sheet = Panel({ cls: "depot" }, [
    h("div", { cls: "depot__top" }, [
      h("div", {}, [
        h("p", { cls: "depot__eyebrow", text: "Hudson Valley Drug · distribution" }),
        h("h2", { cls: "panel__title", text: "Depot" }),
      ]),
      heldChip,
    ]),
    h("p", { cls: "depot__stockhead", text: "On the depot shelves" }),
    stockList,
    h("p", { cls: "depot__stockhead", text: "The morning manifests" }),
    vansHost,
    garage,
  ]);
  const root = h("div", { cls: "depotwrap" }, [sheet]);
  root.hidden = true;

  /** Replace one van's whole manifest; the command re-checks and refuses
   *  silently, so the caller pre-validates where feedback matters. */
  function dispatchManifest(truck: Truck, route: TruckStop[], transfers: TruckTransfer[]): void {
    sim.dispatch({ type: "truck.setRoute", truckId: truck.id, route, transfers });
  }

  /** A focused qty field pauses the full rebuild (typing must survive it),
   *  so every structural action lets go of the keyboard first — the
   *  rebuild that follows its dispatch then lands immediately. */
  function dropFocus(): void {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
  }

  function copyRoute(truck: Truck): TruckStop[] {
    return truck.route.map((stop) => ({
      storeId: stop.storeId,
      lines: stop.lines.map((line) => ({ ...line })),
    }));
  }

  function copyTransfers(truck: Truck): TruckTransfer[] {
    return truck.transfers.map((t) => ({ ...t }));
  }

  // --- The stock strip: what central purchasing has landed ---

  function refreshStock(): void {
    const dc = sim.snapshot.dc;
    stockList.replaceChildren();
    if (!dc) return;
    const skus = Object.keys(dc.stock)
      .filter((skuId) => dc.stock[skuId]! > 0)
      .sort((a, b) => dc.stock[b]! - dc.stock[a]!);
    if (skus.length === 0) {
      stockList.append(
        h("p", {
          cls: "depot__stocknone",
          text: "Nothing on the shelves — the Orders sheet has a Depot scope now, 12% off list.",
        }),
      );
      return;
    }
    for (const skuId of skus) {
      const held = dc.stock[skuId]!;
      const free = Math.max(0, held - allocatedUnits(dc, skuId));
      stockList.append(
        h("span", { cls: "depot__sku" }, [
          h("span", { cls: "depot__skuname", text: nameOf(skuId) }),
          h("span", {
            cls: "depot__skuunits",
            text: free === held ? `×${held}` : `×${held} · ${free} free`,
          }),
        ]),
      );
    }
  }

  // --- One van's manifest card ---

  interface LoadMeter {
    pips: HTMLElement;
    num: HTMLElement;
    set(peak: number): void;
  }

  /** The blister-pip load strip, one pip per ten units, re-lightable in
   *  place so a qty keystroke moves it without a full rebuild. */
  function loadMeter(): LoadMeter {
    const pips = h("span", { cls: "meter__pips meter__pips--load", attrs: { "aria-hidden": "true" } });
    const total = TRUCK_CAPACITY / UNITS_PER_PIP;
    for (let i = 0; i < total; i++) pips.append(h("i", { cls: "meter__pip" }));
    const num = h("span", { cls: "van__load" });
    return {
      pips,
      num,
      set(peak) {
        const lit = Math.min(total, Math.ceil(peak / UNITS_PER_PIP));
        pips.childNodes.forEach((pip, i) => {
          (pip as HTMLElement).classList.toggle("meter__pip--in", i < lit);
        });
        num.textContent = `${peak} / ${TRUCK_CAPACITY}`;
        num.classList.toggle("van__load--full", peak >= TRUCK_CAPACITY);
      },
    };
  }

  function lineRow(
    truck: Truck,
    stopIndex: number,
    lineIndex: number,
    onLoadChanged: () => void,
  ): HTMLElement {
    const state = sim.snapshot;
    const dc = state.dc!;
    const line = truck.route[stopIndex]!.lines[lineIndex]!;
    const field = h("input", {
      cls: "qty__field van__qty",
      attrs: { type: "text", inputmode: "numeric", "aria-label": `${nameOf(line.skuId)} units` },
    });
    field.value = String(line.units);
    const status = h("span", { cls: "van__status" });

    const commit = (units: number): void => {
      const route = copyRoute(truck);
      if (units <= 0) route[stopIndex]!.lines.splice(lineIndex, 1);
      else route[stopIndex]!.lines[lineIndex]!.units = units;
      const reason = validateTruckConfig(state, route, truck.transfers);
      if (reason !== null) {
        status.textContent = reason;
        field.classList.add("van__qty--over");
        return;
      }
      status.textContent = "";
      field.classList.remove("van__qty--over");
      dispatchManifest(truck, route, copyTransfers(truck));
      // The full rebuild waits for blur while a field is held; the meter
      // and the stock strip must not (§20 draft-time feedback).
      onLoadChanged();
    };

    const nudge = (delta: number): void => {
      const current = Number(field.value.replace(/\D+/g, "")) || 0;
      dropFocus();
      commit(Math.max(0, current + delta));
    };
    const less = h("button", {
      cls: "qty__btn",
      text: "−",
      attrs: { type: "button", "aria-label": `Fewer ${nameOf(line.skuId)}` },
    });
    const more = h("button", {
      cls: "qty__btn",
      text: "+",
      attrs: { type: "button", "aria-label": `More ${nameOf(line.skuId)}` },
    });
    less.addEventListener("click", () => nudge(-STEP_UNITS));
    more.addEventListener("click", () => nudge(STEP_UNITS));
    for (const button of [less, more]) {
      button.addEventListener("pointerdown", (e) => e.preventDefault());
    }
    field.addEventListener("input", () => {
      const units = Number(field.value.replace(/\D+/g, "")) || 0;
      if (units > 0) commit(units);
    });
    field.addEventListener("blur", () => invalidate());

    // Standing routes may out-claim the shelves (§20: they run again
    // tomorrow) — say so instead of pretending the van will carry it.
    const asked = allocatedUnits(dc, line.skuId);
    const held = dcStockOf(dc, line.skuId);
    const short =
      held < asked
        ? h("span", {
            cls: "van__short",
            text: `depot holds ${held} of ${asked} asked fleet-wide`,
          })
        : null;

    return h("div", { cls: "van__line" }, [
      h("span", { cls: "van__linename", text: nameOf(line.skuId) }),
      h("div", { cls: "qty van__lineqty" }, [less, field, more]),
      ...(short ? [short] : []),
      status,
    ]);
  }

  function addLineRow(truck: Truck, stopIndex: number): HTMLElement | null {
    const state = sim.snapshot;
    const dc = state.dc!;
    const stop = truck.route[stopIndex]!;
    const lined = new Set(stop.lines.map((line) => line.skuId));
    const options = Object.keys(dc.stock)
      .filter((skuId) => dc.stock[skuId]! > 0 && !lined.has(skuId))
      .sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
    if (options.length === 0) {
      // Bare shelves must say so — a stop with nothing to allocate would
      // otherwise read as finished drafting instead of waiting on stock.
      if (dcHeldUnits(dc) === 0 && stop.lines.length === 0) {
        return h("p", {
          cls: "van__noline",
          text: "Nothing on the shelves to pick from — the Orders sheet's Depot scope buys stock.",
        });
      }
      return null;
    }

    const select = h("select", {
      cls: "van__select",
      attrs: { "aria-label": `Add depot stock for ${labelOfStop(stop)}` },
    });
    select.append(h("option", { text: "Add from the shelves…", attrs: { value: "" } }));
    for (const skuId of options) {
      select.append(
        h("option", { text: `${nameOf(skuId)} · ${dc.stock[skuId]} held`, attrs: { value: skuId } }),
      );
    }
    select.addEventListener("change", () => {
      const skuId = select.value;
      if (skuId === "") return;
      // Adding a line is atomic — let go of the keyboard so the mid-edit
      // guard lets the rebuilt manifest show the new row at once.
      dropFocus();
      const route = copyRoute(truck);
      route[stopIndex]!.lines.push({ skuId, units: STEP_UNITS });
      if (validateTruckConfig(state, route, truck.transfers) !== null) {
        select.value = "";
        return;
      }
      dispatchManifest(truck, route, copyTransfers(truck));
    });
    return h("div", { cls: "van__addline" }, [select]);
  }

  function labelOfStop(stop: TruckStop): string {
    const store = storeById(sim.snapshot, stop.storeId);
    return store ? storeName(sim.snapshot, store) : stop.storeId;
  }

  function stopBlock(truck: Truck, stopIndex: number, onLoadChanged: () => void): HTMLElement {
    const state = sim.snapshot;
    const stop = truck.route[stopIndex]!;
    const remove = h("button", {
      cls: "van__remove",
      text: "✕",
      attrs: { type: "button", "aria-label": `Remove the ${labelOfStop(stop)} stop` },
    });
    remove.addEventListener("pointerdown", (e) => e.preventDefault());
    remove.addEventListener("click", () => {
      dropFocus();
      const route = copyRoute(truck);
      route.splice(stopIndex, 1);
      // A transfer loses its stop, it comes off the manifest with it.
      const transfers = copyTransfers(truck).filter(
        (t) => t.fromStoreId !== stop.storeId && t.toStoreId !== stop.storeId,
      );
      dispatchManifest(truck, route, transfers);
    });

    const rows: HTMLElement[] = [
      h("div", { cls: "van__stophead" }, [
        h("span", { cls: "van__stopname", text: labelOfStop(stop) }),
        remove,
      ]),
    ];
    for (let i = 0; i < stop.lines.length; i++) {
      rows.push(lineRow(truck, stopIndex, i, onLoadChanged));
    }

    // Transfers riding this stop (§20): the pickup carries the remove — the
    // drop half goes with it.
    for (let i = 0; i < truck.transfers.length; i++) {
      const t = truck.transfers[i]!;
      if (t.fromStoreId === stop.storeId) {
        const drop = storeById(state, t.toStoreId);
        const cancel = h("button", {
          cls: "van__remove",
          text: "✕",
          attrs: { type: "button", "aria-label": `Cancel the ${nameOf(t.skuId)} transfer` },
        });
        cancel.addEventListener("pointerdown", (e) => e.preventDefault());
        const index = i;
        cancel.addEventListener("click", () => {
          dropFocus();
          const transfers = copyTransfers(truck);
          transfers.splice(index, 1);
          dispatchManifest(truck, copyRoute(truck), transfers);
        });
        rows.push(
          h("div", { cls: "van__transfer" }, [
            h("span", {
              text: `picks up ×${t.units} ${nameOf(t.skuId)} for ${drop ? storeLabel(state, drop) : t.toStoreId}`,
            }),
            cancel,
          ]),
        );
      } else if (t.toStoreId === stop.storeId) {
        const from = storeById(state, t.fromStoreId);
        rows.push(
          h("div", { cls: "van__transfer van__transfer--drop" }, [
            h("span", {
              text: `drops ×${t.units} ${nameOf(t.skuId)} from ${from ? storeLabel(state, from) : t.fromStoreId}`,
            }),
          ]),
        );
      }
    }

    const addLine = addLineRow(truck, stopIndex);
    if (addLine) rows.push(addLine);

    return h("div", { cls: "van__stop" }, [
      h("span", { cls: "van__dot", attrs: { "aria-hidden": "true" }, text: String(stopIndex + 1) }),
      h("div", { cls: "van__stopbody" }, rows),
    ]);
  }

  function truckCard(truck: Truck): HTMLElement {
    const state = sim.snapshot;
    const meter = loadMeter();
    // A qty keystroke re-lights this card's meter and the stock strip in
    // place — the full rebuild waits politely for the field's blur.
    const onLoadChanged = (): void => {
      meter.set(plannedPeakLoad(truck.route, truck.transfers));
      refreshStock();
    };
    meter.set(plannedPeakLoad(truck.route, truck.transfers));

    const stops: HTMLElement[] = [];
    for (let i = 0; i < truck.route.length; i++) stops.push(stopBlock(truck, i, onLoadChanged));

    const addStop = h("div", { cls: "van__addstop" });
    if (truck.route.length < TRUCK_MAX_STOPS) {
      const onRoute = new Set(truck.route.map((stop) => stop.storeId));
      for (const store of state.stores) {
        if (onRoute.has(store.id)) continue;
        const chip = h("button", {
          cls: "van__stopchip",
          text: `+ ${storeLabel(state, store)}`,
          attrs: { type: "button" },
        });
        chip.addEventListener("pointerdown", (e) => e.preventDefault());
        chip.addEventListener("click", () => {
          dropFocus();
          const route = copyRoute(truck);
          route.push({ storeId: store.id, lines: [] });
          dispatchManifest(truck, route, copyTransfers(truck));
        });
        addStop.append(chip);
      }
    } else {
      addStop.append(
        h("span", { cls: "van__full", text: `${TRUCK_MAX_STOPS} stops — the route is full` }),
      );
    }

    const runNote =
      truck.lastRunDay === state.day
        ? "Ran this morning"
        : truck.route.length > 0
          ? "Runs at dawn — goods leave the depot shelves"
          : "Parked in the garage";

    return h("div", { cls: "van" }, [
      h("div", { cls: "van__head" }, [
        h("span", { cls: "van__glyph", attrs: { "aria-hidden": "true" } }, [
          h("i", { cls: "van__glyphbox" }),
          h("i", { cls: "van__glyphcab" }),
        ]),
        h("span", { cls: "van__name", text: truckLabel(truck.id) }),
        meter.pips,
        meter.num,
      ]),
      h("div", { cls: "van__route" }, [
        ...(stops.length > 0
          ? stops
          : [h("p", { cls: "van__empty", text: "No stops drafted — add a branch below." })]),
        addStop,
      ]),
      h("p", { cls: "van__run", text: runNote }),
    ]);
  }

  function refresh(): void {
    const state = sim.snapshot;
    const dc = state.dc;
    if (!dc) return;
    // A manifest mid-edit holds still — rebuilding under a focused field
    // would eat the typed units; the blur re-invalidates.
    if (root.contains(document.activeElement) && document.activeElement !== document.body) {
      return;
    }
    heldChip.textContent = `${dcHeldUnits(dc)} units on the shelves`;
    refreshStock();
    vansHost.replaceChildren();
    if (dc.trucks.length === 0) {
      vansHost.append(
        h("p", {
          cls: "depot__novans",
          text: "The garage is empty. A van turns depot stock into morning deliveries.",
        }),
      );
    }
    for (const truck of dc.trucks) vansHost.append(truckCard(truck));
    bays.textContent = `${dc.trucks.length} of ${MAX_TRUCKS} bays`;
    buyVan.disabled = dc.trucks.length >= MAX_TRUCKS || state.cash < TRUCK_COST;
    buyVan.textContent =
      state.cash < TRUCK_COST && dc.trucks.length < MAX_TRUCKS
        ? "Not enough cash for a van"
        : `Buy a van — ${money(TRUCK_COST)}`;
  }

  /** Coalesce event churn into one repaint per frame. */
  function invalidate(): void {
    if (!visible || pending) return;
    pending = true;
    requestAnimationFrame(() => {
      pending = false;
      if (visible) refresh();
    });
  }

  bus.on("dc.bought", invalidate);
  bus.on("dc.delivered", invalidate);
  bus.on("dc.orderSubmitted", invalidate);
  bus.on("truck.bought", invalidate);
  bus.on("truck.routeChanged", invalidate);
  bus.on("transfer.drafted", invalidate);
  bus.on("branch.bought", invalidate);
  bus.on("cash.changed", invalidate);
  bus.on("day.phaseChanged", invalidate);

  return {
    root,
    setVisible(on) {
      visible = on;
      root.hidden = !on;
      if (on) refresh();
    },
  };
}
