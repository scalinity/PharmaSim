// Inventory (SPEC §11, §17, §24): stock per SKU as backroom units plus units
// out front (OTC shelf labels, Rx bins), player-set OTC prices with the §10
// balk thresholds, restock moves the player makes by clicking a shelf,
// next-morning deliveries, stock-out recording, and the trailing sales and
// fill-rate history the city model reads later (§17). Pure sim — no DOM.

import { DRUG_DEFS } from "../data/drugs";
import { OTC_DEFS, otcDef } from "../data/otc";
import { isRefrigerated } from "./coldchain";
import { round2 } from "./economy";
import type { SimEvent } from "./events";
import { activeStore, type GameState, type OrderLine, type StockLine, type StoreState } from "./state";

/** §6 otc_shelf: 4 SKU labels × 24 units. */
export const SHELF_SLOTS = 4;
export const SHELF_SLOT_UNITS = 24;

/** §10 OTC pricing: slider range and the two balk thresholds. */
export const PRICE_MIN = 0.8;
export const PRICE_MAX = 1.5;
export const PRICE_STEP = 0.05;
export const BALK_BARGAIN = 1.15;
export const BALK_ALL = 1.35;

/** §11/§17 trailing windows. Exported so save validation bounds exactly
 *  what pushHistory keeps (the same pattern as DISTRICT_SHARE_LOG_DAYS). */
export const HISTORY_DAYS = 7;

type Emit = (event: SimEvent) => void;

const OTC_IDS: ReadonlySet<string> = new Set(OTC_DEFS.map((def) => def.id));

export function isOtc(skuId: string): boolean {
  return OTC_IDS.has(skuId);
}

/** Tier-3 SKUs live in the controlled cabinet, not the Rx shelf (§25). */
const CONTROLLED_IDS: ReadonlySet<string> = new Set(
  DRUG_DEFS.filter((def) => def.tier === 3).map((def) => def.id),
);

export function isControlled(skuId: string): boolean {
  return CONTROLLED_IDS.has(skuId);
}

/** Which bin fixture holds this Rx SKU's stock out front (§14, §25): the
 *  cabinet for Tier 3, the medical fridge for cold-chain SKUs, else the shelf. */
export function binFixtureFor(
  skuId: string,
): "rx_shelf" | "cabinet_controlled" | "fridge_medical" {
  if (isControlled(skuId)) return "cabinet_controlled";
  if (isRefrigerated(skuId)) return "fridge_medical";
  return "rx_shelf";
}

/** The fixtures whose bins pool stock by SKU rather than by shelf label. */
const BIN_FIXTURE_DEFS: ReadonlySet<string> = new Set([
  "rx_shelf",
  "cabinet_controlled",
  "fridge_medical",
]);

const EMPTY: StockLine = { backroom: 0, shelved: 0 };

export function stockOf(store: StoreState, skuId: string): Readonly<StockLine> {
  return store.stock[skuId] ?? EMPTY;
}

/** Keys that would walk the prototype chain instead of storing stock — a
 *  hand-edited save's inbound line must never reach them (§23). */
const UNSAFE_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

/** Mutable line, created on first use. */
function line(store: StoreState, skuId: string): StockLine {
  // A save-controlled key like "__proto__" would make the ??= read return
  // Object.prototype (truthy, so never assigned over) and turn the caller's
  // `.backroom += n` into prototype pollution — every for-in over stock
  // would then yield "backroom" as a SKU id. Hand such keys a detached line
  // so the write lands nowhere.
  if (UNSAFE_KEYS.has(skuId)) return { backroom: 0, shelved: 0 };
  return (store.stock[skuId] ??= { backroom: 0, shelved: 0 });
}

export function onHand(store: StoreState, skuId: string): number {
  const s = stockOf(store, skuId);
  return s.backroom + s.shelved;
}

export function shelvedUnits(store: StoreState, skuId: string): number {
  return stockOf(store, skuId).shelved;
}

/** Consume one unit from the shelf/bin. False when it is out of stock. */
export function takeShelved(store: StoreState, skuId: string): boolean {
  const s = store.stock[skuId];
  if (!s || s.shelved <= 0) return false;
  s.shelved--;
  return true;
}

/** Put a unit back (basket abandoned, script cancelled). */
export function returnShelved(store: StoreState, skuId: string): void {
  line(store, skuId).shelved++;
}

/** §20 truck drop: units straight into the backroom, no van queue. */
export function addBackroom(store: StoreState, skuId: string, units: number): void {
  if (units <= 0) return;
  line(store, skuId).backroom += units;
}

/** §20 transfer pickup: take up to `units` from wherever the store holds
 *  them — boxed stock first, the shelf/bins only for the remainder — and
 *  return how many actually left. */
export function takeUnits(store: StoreState, skuId: string, units: number): number {
  const s = store.stock[skuId];
  if (!s || units <= 0) return 0;
  const fromBack = Math.min(units, s.backroom);
  s.backroom -= fromBack;
  const fromShelf = Math.min(units - fromBack, s.shelved);
  s.shelved -= fromShelf;
  return fromBack + fromShelf;
}

// --- OTC pricing (§10) ---

export function priceMultiplier(store: StoreState, skuId: string): number {
  return store.otcPricing[skuId] ?? 1;
}

/** What a shopper pays: MSRP × the player's multiplier. */
export function otcPrice(store: StoreState, skuId: string): number {
  return round2(otcDef(skuId).msrp * priceMultiplier(store, skuId));
}

export function clampMultiplier(multiplier: number): number {
  const stepped = Math.round(multiplier / PRICE_STEP) * PRICE_STEP;
  return Math.min(PRICE_MAX, Math.max(PRICE_MIN, round2(stepped)));
}

/** True when this archetype puts the item back over its price (§10). */
export function balksAt(multiplier: number, archetypeIsBargain: boolean): boolean {
  if (multiplier > BALK_ALL) return true;
  return archetypeIsBargain && multiplier > BALK_BARGAIN;
}

/** §17 priceScore input: the average multiplier across shelved SKUs. */
export function refreshPriceIndex(store: StoreState): void {
  let sum = 0;
  let count = 0;
  for (const slots of Object.values(store.shelfSlots)) {
    for (const skuId of slots) {
      sum += priceMultiplier(store, skuId);
      count++;
    }
  }
  store.priceIndex = count === 0 ? 1 : round2(sum / count);
}

// --- Shelf labels + restocking (§11) ---

/** The shelf a SKU is labelled on, or null. */
function shelfOf(store: StoreState, skuId: string): string | null {
  // for-in, not Object.entries — restockableUnits asks every frame (§30).
  for (const shelfId in store.shelfSlots) {
    if (store.shelfSlots[shelfId]!.includes(skuId)) return shelfId;
  }
  return null;
}

/** Units on the shelf's labels, and how many its 4 slots can still hold. */
export function shelfUnits(store: StoreState, shelfId: string): number {
  let units = 0;
  for (const skuId of store.shelfSlots[shelfId] ?? []) units += shelvedUnits(store, skuId);
  return units;
}

function moveOut(store: StoreState, skuId: string, cap: number): number {
  const s = line(store, skuId);
  const take = Math.min(cap - s.shelved, s.backroom);
  if (take <= 0) return 0;
  s.backroom -= take;
  s.shelved += take;
  return take;
}

/** OTC SKUs sitting in the backroom with no shelf label yet, catalog order. */
function unlabelled(store: StoreState): string[] {
  return OTC_DEFS.filter(
    (def) => stockOf(store, def.id).backroom > 0 && shelfOf(store, def.id) === null,
  ).map((def) => def.id);
}

/** Units this shelf/bin could take from the backroom right now (§11 prompt).
 *  Active-store surfaces only — the overlay chips and floor clicks. */
export function restockableUnits(state: GameState, furnitureId: string): number {
  const store = activeStore(state);
  const item = store.furniture.find((f) => f.id === furnitureId);
  if (!item) return 0;
  if (item.defId === "otc_shelf") {
    const slots = store.shelfSlots[furnitureId];
    let units = 0;
    if (slots) {
      for (const skuId of slots) {
        units += Math.min(SHELF_SLOT_UNITS - shelvedUnits(store, skuId), stockOf(store, skuId).backroom);
      }
    }
    // Inlined unlabelled() scan: restock() keeps the list-building helper
    // (it mutates slots as it labels), but this path runs every frame for
    // the overlay chips and must not allocate (§30).
    let free = SHELF_SLOTS - (slots ? slots.length : 0);
    if (free > 0) {
      for (const def of OTC_DEFS) {
        const backroom = stockOf(store, def.id).backroom;
        if (backroom <= 0 || shelfOf(store, def.id) !== null) continue;
        units += Math.min(SHELF_SLOT_UNITS, backroom);
        if (--free <= 0) break;
      }
    }
    return units;
  }
  if (BIN_FIXTURE_DEFS.has(item.defId)) {
    // for-in, not Object.entries: the overlay layer asks every frame (§30).
    let units = 0;
    for (const skuId in store.stock) {
      if (isOtc(skuId) || binFixtureFor(skuId) !== item.defId) continue;
      units += store.stock[skuId]!.backroom;
    }
    return units;
  }
  return 0;
}

/** True when a label on this shelf (or a bin behind it) has run dry.
 *  Rx bins count as dry only while the backroom could actually refill them —
 *  a drug that is simply out of stock is an ordering problem, not a trip. */
export function hasEmptySlot(state: GameState, furnitureId: string): boolean {
  const store = activeStore(state);
  const item = store.furniture.find((f) => f.id === furnitureId);
  if (item?.defId === "otc_shelf") {
    const slots = store.shelfSlots[furnitureId];
    if (!slots) return false;
    return slots.some((skuId) => shelvedUnits(store, skuId) === 0);
  }
  if (item && BIN_FIXTURE_DEFS.has(item.defId)) {
    // for-in, not Object.entries: the overlay layer asks every frame (§30).
    for (const skuId in store.stock) {
      if (isOtc(skuId) || binFixtureFor(skuId) !== item.defId) continue;
      const line = store.stock[skuId]!;
      if (line.shelved === 0 && line.backroom > 0) return true;
    }
  }
  return false;
}

/**
 * The player clicked a shelf: top its labels up from the backroom, then hand
 * any free slot to a SKU that arrived with nowhere to go. Rx bins take the
 * whole backroom (instant in the solo era, §11). Returns units moved.
 */
export function restock(state: GameState, furnitureId: string): number {
  const store = activeStore(state);
  const item = store.furniture.find((f) => f.id === furnitureId);
  if (!item) return 0;
  let moved = 0;

  if (item.defId === "otc_shelf") {
    const slots = (store.shelfSlots[furnitureId] ??= []);
    for (const skuId of slots) moved += moveOut(store, skuId, SHELF_SLOT_UNITS);
    for (const skuId of unlabelled(store)) {
      if (slots.length >= SHELF_SLOTS) break;
      slots.push(skuId);
      moved += moveOut(store, skuId, SHELF_SLOT_UNITS);
    }
    // Drop labels that are empty and unbacked, so new SKUs can take the slot.
    for (let i = slots.length - 1; i >= 0; i--) {
      const skuId = slots[i]!;
      if (onHand(store, skuId) === 0) slots.splice(i, 1);
    }
    refreshPriceIndex(store);
    return moved;
  }

  if (BIN_FIXTURE_DEFS.has(item.defId)) {
    for (const [skuId, s] of Object.entries(store.stock)) {
      if (isOtc(skuId) || binFixtureFor(skuId) !== item.defId || s.backroom <= 0) continue;
      moved += s.backroom;
      s.shelved += s.backroom;
      s.backroom = 0;
    }
  }
  return moved;
}

/** An OTC shelf was sold: box its units back into the backroom. */
export function clearShelf(store: StoreState, furnitureId: string): void {
  for (const skuId of store.shelfSlots[furnitureId] ?? []) {
    const s = line(store, skuId);
    s.backroom += s.shelved;
    s.shelved = 0;
  }
  delete store.shelfSlots[furnitureId];
  refreshPriceIndex(store);
}

/** The controlled cabinet was sold: its Tier-3 stock goes back in the box —
 *  and back off the market, since nothing can hold it out front (§25). */
export function clearControlled(store: StoreState): void {
  for (const [skuId, s] of Object.entries(store.stock)) {
    if (!isControlled(skuId) || s.shelved <= 0) continue;
    s.backroom += s.shelved;
    s.shelved = 0;
  }
}

/** The last fridge was sold: cold stock goes back in the box and off the
 *  market — nothing else can keep it (§14). Nothing spoils outside an outage. */
export function clearRefrigerated(store: StoreState): void {
  for (const [skuId, s] of Object.entries(store.stock)) {
    if (!isRefrigerated(skuId) || s.shelved <= 0) continue;
    s.backroom += s.shelved;
    s.shelved = 0;
  }
}

// --- Orders and deliveries (§11) ---

/** Queue an order for tomorrow morning, merging lines per SKU. */
export function queueDelivery(store: StoreState, lines: readonly OrderLine[]): void {
  for (const l of lines) {
    const existing = store.inbound.find((i) => i.skuId === l.skuId);
    if (existing) existing.units += l.units;
    else store.inbound.push({ skuId: l.skuId, units: l.units });
  }
}

/** Morning: yesterday's order lands in the backroom (§5, §11). */
export function receiveDeliveries(store: StoreState): { units: number; skus: number } {
  let units = 0;
  const skus = store.inbound.length;
  for (const l of store.inbound) {
    line(store, l.skuId).backroom += l.units;
    units += l.units;
  }
  store.inbound.length = 0;
  return { units, skus };
}

/** Reorder rules → a draft cart the player still has to send (§11). Takes
 *  the store: rules are per branch, and Orders scopes per branch (§19). */
export function draftOrder(store: StoreState): Record<string, number> {
  const draft: Record<string, number> = {};
  if (!store.reorderUnlocked) return draft;
  for (const [skuId, rule] of Object.entries(store.reorderRules)) {
    const held = onHand(store, skuId);
    if (held > rule.min) continue;
    const units = rule.target - held;
    if (units > 0) draft[skuId] = units;
  }
  return draft;
}

// --- Stock-outs, sales history, fill rate (§11, §17) ---

/** A sale lost to an empty label or bin on the visited floor. The first
 *  one teaches this store its reorder rules. */
export function recordStockOut(state: GameState, skuId: string, emit: Emit): void {
  const stats = state.dayStats;
  stats.stockOuts[skuId] = (stats.stockOuts[skuId] ?? 0) + 1;
  emit({ type: "stock.out", skuId });
  const store = activeStore(state);
  if (!store.reorderUnlocked) {
    store.reorderUnlocked = true;
    emit({ type: "reorder.unlocked", storeId: store.id });
  }
}

/** An item put back over its price (§10) — no rep hit, just a lost sale. */
export function recordBalk(state: GameState, skuId: string): void {
  const stats = state.dayStats;
  stats.balks[skuId] = (stats.balks[skuId] ?? 0) + 1;
}

export function recordSale(store: StoreState, skuId: string, units: number): void {
  store.salesToday[skuId] = (store.salesToday[skuId] ?? 0) + units;
}

/** Units sold over the trailing 7 days, today included (§11 order UI). */
export function sales7d(store: StoreState, skuId: string): number {
  let units = store.salesToday[skuId] ?? 0;
  for (const day of store.salesLog) units += day[skuId] ?? 0;
  return units;
}

/** One day onto a store's trailing books: sales log, §17 fill rate, gross.
 *  The visited close and the §19 branch resolver both come through here, so
 *  the windows can never drift apart. */
export function pushHistory(store: StoreState, rate: number, gross: number): void {
  store.salesLog.unshift(store.salesToday);
  store.salesLog.length = Math.min(store.salesLog.length, HISTORY_DAYS - 1);
  store.salesToday = {};

  store.fillRate7d.unshift(round2(rate));
  store.fillRate7d.length = Math.min(store.fillRate7d.length, HISTORY_DAYS);

  store.gross7d.unshift(round2(gross));
  store.gross7d.length = Math.min(store.gross7d.length, HISTORY_DAYS);
}

/**
 * Roll the visited day's history at close: sales log, the §17 fill rate
 * (served vs. demand we could not meet), and gross revenue for the bank's
 * credit line.
 */
export function rollHistory(state: GameState, gross: number): void {
  const stats = state.dayStats;
  let missed = stats.refusals;
  for (const count of Object.values(stats.stockOuts)) missed += count;
  const served = stats.fills + stats.otcUnits + stats.vaccinations;
  const rate = served + missed === 0 ? 1 : served / (served + missed);
  pushHistory(activeStore(state), rate, gross);
}
