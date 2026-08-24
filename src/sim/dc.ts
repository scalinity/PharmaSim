// Distribution + logistics (SPEC §20, §26): the depot's stock pool, the
// garage's trucks, route drafting rules — ≤3 stops, 400 units on the
// springs — and the morning run that carries picking lists and transfers
// out to the branches. Pricing lives in economy.ts (dcUnitCost); this
// module owns structure, validation and execution. Pure sim — no DOM.

import { DRUG_DEFS } from "../data/drugs";
import { OTC_DEFS } from "../data/otc";
import type { SimEvent } from "./events";
import { addBackroom, takeUnits } from "./inventory";
import { recordMoment } from "./legacy";
import {
  storeById,
  type DcState,
  type GameState,
  type TruckStop,
  type TruckTransfer,
} from "./state";

// --- §26 numbers ---

export const DC_COST = 60_000;
export const TRUCK_COST = 8_000;
export const TRUCK_CAPACITY = 400;
export const TRUCK_MAX_STOPS = 3;
/** The garage's bays — the writer-side cap save validation bounds against.
 *  Eight vans × three stops covers every door the game can open (§19's
 *  eight-store ceiling) with room to spare. */
export const MAX_TRUCKS = 8;

/** The BranchScope chip id the Orders panel uses for depot-scoped orders
 *  (§11/§20) — deliberately not a store id shape. */
export const DC_SCOPE_ID = "dc";

/** "t3" → "Van 3" — the garage names its vans by bay. */
export function truckLabel(truckId: string): string {
  const match = /^t(\d+)$/.exec(truckId);
  return match ? `Van ${match[1]}` : truckId;
}

// --- What may ride a van (§20 × §14) ---

/** Every catalog SKU that can sit on a depot shelf or a van: the vans carry
 *  no cold chain, so refrigerated SKUs stay on the store-direct path where
 *  §14's fridge capacity is enforced at order time. */
const TRUCK_SKUS: ReadonlySet<string> = new Set([
  ...DRUG_DEFS.filter((def) => def.refrigerated !== true).map((def) => def.id),
  ...OTC_DEFS.map((def) => def.id),
]);

export function isTruckSku(skuId: string): boolean {
  return TRUCK_SKUS.has(skuId);
}

// --- Depot stock bookkeeping ---

export function dcStockOf(dc: DcState, skuId: string): number {
  return dc.stock[skuId] ?? 0;
}

/** Total units on the depot shelves. */
export function dcHeldUnits(dc: DcState): number {
  let units = 0;
  for (const skuId in dc.stock) units += dc.stock[skuId]!;
  return units;
}

/** Units of one SKU the standing picking lists already claim, every van
 *  counted. Standing routes may legally out-claim today's stock (they run
 *  again tomorrow); the drafting UI uses this to say so honestly. */
export function allocatedUnits(dc: DcState, skuId: string): number {
  let units = 0;
  for (const truck of dc.trucks) {
    for (const stop of truck.route) {
      for (const line of stop.lines) {
        if (line.skuId === skuId) units += line.units;
      }
    }
  }
  return units;
}

/** Depot stock no picking list has spoken for yet (floor 0 — a standing
 *  over-allocation shows as nothing left to allocate, never a negative). */
export function unallocatedUnits(dc: DcState, skuId: string): number {
  return Math.max(0, dcStockOf(dc, skuId) - allocatedUnits(dc, skuId));
}

/** Units pending transfers already promise *off* one store's shelves for
 *  one SKU, every van counted. The transfer clamp reads net of this, so
 *  two enthusiastic drafts can never out-promise the morning's stock. */
export function pendingPickupUnits(dc: DcState, storeId: string, skuId: string): number {
  let units = 0;
  for (const truck of dc.trucks) {
    for (const t of truck.transfers) {
      if (t.fromStoreId === storeId && t.skuId === skuId) units += t.units;
    }
  }
  return units;
}

/** Units pending transfers already promise *to* one store for one SKU —
 *  the shortage slip says "already riding a van" instead of re-offering
 *  the same move. */
export function pendingDeliveryUnits(dc: DcState, storeId: string, skuId: string): number {
  let units = 0;
  for (const truck of dc.trucks) {
    for (const t of truck.transfers) {
      if (t.toStoreId === storeId && t.skuId === skuId) units += t.units;
    }
  }
  return units;
}

// --- Route arithmetic (draft-time and save validation share it) ---

/** The most the van ever carries on this plan: the depot load, plus each
 *  transfer riding between its pickup and its drop. Pickups board before
 *  drops come off at the same stop, so the peak reads after boarding. */
export function plannedPeakLoad(
  route: readonly TruckStop[],
  transfers: readonly TruckTransfer[],
): number {
  let cargo = 0;
  for (const stop of route) {
    for (const line of stop.lines) cargo += line.units;
  }
  let peak = cargo;
  for (const stop of route) {
    for (const t of transfers) {
      if (t.fromStoreId === stop.storeId) cargo += t.units;
    }
    peak = Math.max(peak, cargo);
    for (const line of stop.lines) cargo -= line.units;
    for (const t of transfers) {
      if (t.toStoreId === stop.storeId) cargo -= t.units;
    }
  }
  return peak;
}

/**
 * Would this manifest be legal on a van (§20/§26)? Null when it is; a §28
 * sentence when it isn't. The truck.setRoute command refuses on the same
 * check the drafting UI surfaces, so the paper never promises a run the
 * morning would drop.
 */
export function validateTruckConfig(
  state: GameState,
  route: readonly TruckStop[],
  transfers: readonly TruckTransfer[],
): string | null {
  if (route.length > TRUCK_MAX_STOPS) return `A route holds ${TRUCK_MAX_STOPS} stops at most`;
  const seen = new Set<string>();
  for (const stop of route) {
    if (storeById(state, stop.storeId) === null) return "A stop names a store that isn't yours";
    if (seen.has(stop.storeId)) return "A route calls at each store once";
    seen.add(stop.storeId);
    const lineSkus = new Set<string>();
    for (const line of stop.lines) {
      if (!isTruckSku(line.skuId)) return "Only dry catalog stock rides the van";
      if (lineSkus.has(line.skuId)) return "One picking line per SKU per stop";
      lineSkus.add(line.skuId);
      if (!Number.isInteger(line.units) || line.units < 1) return "Picking lines move whole units";
    }
  }
  for (const t of transfers) {
    if (t.fromStoreId === t.toStoreId) return "A transfer needs two different stores";
    const fromIdx = route.findIndex((stop) => stop.storeId === t.fromStoreId);
    const toIdx = route.findIndex((stop) => stop.storeId === t.toStoreId);
    if (fromIdx === -1 || toIdx === -1) return "A transfer's stores must both be stops";
    if (fromIdx >= toIdx) return "A transfer picks up before it drops";
    if (!isTruckSku(t.skuId)) return "Only dry catalog stock rides the van";
    if (!Number.isInteger(t.units) || t.units < 1) return "Transfers move whole units";
  }
  if (plannedPeakLoad(route, transfers) > TRUCK_CAPACITY) {
    return `Over the springs — ${TRUCK_CAPACITY} units is the van's limit`;
  }
  return null;
}

// --- §20 transfer compile: pickup at source, drop at target ---

export type TransferPlan =
  | { ok: true; truckId: string; route: TruckStop[]; transfers: TruckTransfer[] }
  | { ok: false; reason: string };

/** Deep copies of a manifest's two halves — the one shape every writer
 *  shares (the setRoute command, the drafting UI, planTransfer, the save
 *  file's copyTruck): a persisted route must never alias a payload or a
 *  live draft, and a new TruckStop field has one place to be remembered. */
export function copyRoute(route: readonly TruckStop[]): TruckStop[] {
  return route.map((stop) => ({
    storeId: stop.storeId,
    lines: stop.lines.map((line) => ({ ...line })),
    ...(stop.forTransfer === true ? { forTransfer: true as const } : {}),
  }));
}

export function copyTransfers(transfers: readonly TruckTransfer[]): TruckTransfer[] {
  return transfers.map((t) => ({ ...t }));
}

/**
 * Compile a branch→branch move onto the first van that can take it (§20):
 * reuse stops the route already makes, add the missing ones — the pickup
 * always ahead of the drop — and check the springs. Drafting stays manual
 * elsewhere; this is bookkeeping, not routing intelligence.
 */
export function planTransfer(
  state: GameState,
  fromStoreId: string,
  toStoreId: string,
  skuId: string,
  units: number,
): TransferPlan {
  const dc = state.dc;
  if (!dc) return { ok: false, reason: "No depot yet" };
  if (dc.trucks.length === 0) {
    return { ok: false, reason: "No vans in the garage — the depot sells them" };
  }
  for (const truck of dc.trucks) {
    const route = copyRoute(truck.route);
    const transfers = copyTransfers(truck.transfers);
    let fromIdx = route.findIndex((stop) => stop.storeId === fromStoreId);
    let toIdx = route.findIndex((stop) => stop.storeId === toStoreId);
    if (fromIdx !== -1 && toIdx !== -1 && fromIdx >= toIdx) continue; // wrong way round
    // Stops the compile itself creates are flagged as the transfer's own
    // (§20): the morning prune takes exactly these, never a player's.
    if (fromIdx === -1 && toIdx !== -1) {
      route.splice(toIdx, 0, { storeId: fromStoreId, lines: [], forTransfer: true });
      fromIdx = toIdx;
      toIdx += 1;
    } else {
      if (fromIdx === -1) {
        route.push({ storeId: fromStoreId, lines: [], forTransfer: true });
        fromIdx = route.length - 1;
      }
      if (toIdx === -1) {
        route.push({ storeId: toStoreId, lines: [], forTransfer: true });
        toIdx = route.length - 1;
      }
    }
    transfers.push({ fromStoreId, toStoreId, skuId, units });
    if (validateTruckConfig(state, route, transfers) !== null) continue;
    return { ok: true, truckId: truck.id, route, transfers };
  }
  return {
    ok: false,
    reason: `Every van is full — ${TRUCK_MAX_STOPS} stops and ${TRUCK_CAPACITY} units is the limit`,
  };
}

// --- Mornings at the depot (§20; called from beginMorning) ---

/** Dawn: yesterday's −12% order lands on the depot shelves. */
export function receiveDcDeliveries(dc: DcState): { units: number; skus: number } {
  let units = 0;
  const skus = dc.inbound.length;
  for (const line of dc.inbound) {
    dc.stock[line.skuId] = (dc.stock[line.skuId] ?? 0) + line.units;
    units += line.units;
  }
  dc.inbound.length = 0;
  return { units, skus };
}

export interface TruckArrival {
  truckId: string;
  storeId: string;
  /** Units that came off the van here — picking list plus transfer drops. */
  delivered: number;
  /** Units a transfer loaded here. */
  pickedUp: number;
}

/**
 * Run every van's morning route (§20): picking lists load from DC stock
 * (clamped to what the shelves actually hold — a standing route that
 * out-claims the depot shorts the later stops, honestly), transfers pick up
 * at their source and drop at their target, leftovers ride home to the
 * depot so no unit ever vanishes. Routes persist; executed transfers come
 * off the manifest, and a stop left with no duty falls off with them.
 * Arrivals are morning-guaranteed — the caller runs this before the phase
 * change goes out, so the autosave and the day's demand both see the goods.
 */
export function runTruckRoutes(
  state: GameState,
  emit: (event: SimEvent) => void,
): TruckArrival[] {
  const dc = state.dc;
  const arrivals: TruckArrival[] = [];
  if (!dc) return arrivals;
  let transferDelivered = false;

  for (const truck of dc.trucks) {
    if (truck.route.length === 0) continue;

    // Load the picking lists' union from the shelves, first stop first.
    const cargo: Record<string, number> = {};
    for (const stop of truck.route) {
      for (const line of stop.lines) {
        const held = dc.stock[line.skuId] ?? 0;
        const take = Math.min(line.units, held);
        if (take <= 0) continue;
        if (take === held) delete dc.stock[line.skuId];
        else dc.stock[line.skuId] = held - take;
        cargo[line.skuId] = (cargo[line.skuId] ?? 0) + take;
      }
    }

    // Drive the stops in order. Transfer cargo rides its own ledger so a
    // shorted picking list can never eat a pickup meant for the next stop.
    const aboard = new Map<TruckTransfer, number>();
    for (const stop of truck.route) {
      const store = storeById(state, stop.storeId);
      if (!store) continue;
      let delivered = 0;
      let pickedUp = 0;
      for (const t of truck.transfers) {
        if (t.fromStoreId !== stop.storeId) continue;
        const take = takeUnits(store, t.skuId, t.units);
        aboard.set(t, take);
        pickedUp += take;
      }
      for (const line of stop.lines) {
        const give = Math.min(line.units, cargo[line.skuId] ?? 0);
        if (give <= 0) continue;
        cargo[line.skuId]! -= give;
        addBackroom(store, line.skuId, give);
        delivered += give;
      }
      for (const t of truck.transfers) {
        if (t.toStoreId !== stop.storeId) continue;
        const give = aboard.get(t) ?? 0;
        if (give <= 0) continue;
        aboard.set(t, 0);
        addBackroom(store, t.skuId, give);
        delivered += give;
        transferDelivered = true;
      }
      arrivals.push({ truckId: truck.id, storeId: store.id, delivered, pickedUp });
    }

    // Home to the depot: whatever is still on the van goes back on the
    // shelves (a skipped store, a stranded pickup — nothing is lost).
    for (const skuId in cargo) {
      const left = cargo[skuId]!;
      if (left > 0) dc.stock[skuId] = (dc.stock[skuId] ?? 0) + left;
    }
    for (const [t, left] of aboard) {
      if (left > 0) dc.stock[t.skuId] = (dc.stock[t.skuId] ?? 0) + left;
    }

    truck.lastRunDay = state.day;
    // Transfers are one-shot corrections, not standing orders — the run
    // takes them off the manifest, and the stops the compile created for
    // them (forTransfer, whether or not their transfer still exists — a
    // cancelled draft's waypoint is litter too) go with them. A stop the
    // player drafted keeps its place even before it carries a picking
    // line: the manifest is the player's standing draft, and the morning
    // must not eat it.
    truck.transfers = [];
    truck.route = truck.route.filter(
      (stop) => stop.lines.length > 0 || stop.forTransfer !== true,
    );
  }

  // §22: the first stock moved between your own stores is a moment.
  if (transferDelivered) recordMoment(state, "first_transfer", emit);
  return arrivals;
}
