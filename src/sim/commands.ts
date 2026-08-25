// Command union + handlers. All mutations of GameState go through here.
// Furniture commands re-validate via placement.ts; the UI validates first
// and surfaces reasons, so failed commands are silent no-ops.

import { DAY_START_IGM } from "../core/clock";
import type { Rot } from "../core/grid";
import { DISTRICTS } from "../data/districts";
import { EXPANSIONS, furnitureDef } from "../data/furniture";
import {
  FORECAST_COST,
  forecastLock,
  hasVerifyAssist,
  VERIFY_ASSIST_COST,
  verifyAssistLock,
} from "./aitech";
import { coldClampUnits, hasFridge } from "./coldchain";
import { advanceMarket } from "./competitors";
import {
  copyRoute,
  copyTransfers,
  DC_COST,
  isTruckSku,
  MAX_TRUCKS,
  pendingPickupUnits,
  planTransfer,
  receiveDcDeliveries,
  runTruckRoutes,
  TRUCK_COST,
  validateTruckConfig,
} from "./dc";
import {
  bankStatus,
  branchPrice,
  catalog,
  dcOrderTotal,
  dcSkuLock,
  orderTotal,
  post,
  round2,
  shortageFillCap,
} from "./economy";
import type { SimEvent } from "./events";
import { advanceWorld, forceShortage, forceStorm } from "./events-world";
import {
  clampMultiplier,
  clearControlled,
  clearRefrigerated,
  clearShelf,
  isOtc,
  onHand,
  queueDelivery,
  receiveDeliveries,
  refreshPriceIndex,
  restock,
} from "./inventory";
import { recordMoment } from "./legacy";
import { canBuyLicense, licenseDef, ownsLicense } from "./licenses";
import { doorwayBlocked, validatePlacement } from "./placement";
import { beginRenovation, completeRenovation } from "./renovation";
import { refreshHiringPool, ROLE_STATIONS, type StaffMember } from "./staff";
import {
  activeStore,
  emptyDayStats,
  freshDc,
  freshStore,
  isFoundingStore,
  storeById,
  type GameSettings,
  type GameSpeed,
  type GameState,
  type OrderLine,
  type PlacedFurniture,
  type StoreState,
  type Truck,
  type TruckStop,
  type TruckTransfer,
} from "./state";

export type Command =
  | { type: "store.open" }
  | { type: "day.advance" }
  | { type: "speed.set"; speed: GameSpeed }
  | { type: "build.enter" }
  | { type: "build.exit" }
  | { type: "furniture.place"; defId: string; cellX: number; cellY: number; rot: Rot }
  | { type: "furniture.move"; id: string; cellX: number; cellY: number; rot: Rot }
  | { type: "furniture.sell"; id: string }
  | { type: "station.workHere"; stationId: string }
  | { type: "station.leave" }
  /** Player picked a bin during the fill interaction; handled by Sim (workflow). */
  | { type: "fill.pickBin"; drugId: string }
  // --- Inventory + economy (§10, §11; `storeId` names the branch, §19 —
  //     required, so a dispatch that forgets it is a compile error rather
  //     than a silent write to whichever store happens to be active) ---
  /** Buy wholesale: cash out now, goods land in that store's backroom next
   *  morning (§19: deliveries arrive wherever ordered). */
  | { type: "order.submit"; lines: OrderLine[]; storeId: string }
  | { type: "otc.setPrice"; skuId: string; multiplier: number; storeId: string }
  /** Move backroom stock onto a shelf's labels or into the Rx bins. */
  | { type: "stock.restock"; furnitureId: string }
  | { type: "reorder.setRule"; skuId: string; min: number; target: number; storeId: string }
  | { type: "loan.draw"; amount: number }
  | { type: "loan.repay"; amount: number }
  // --- Licenses + expansion (§6, §12) ---
  /** Buy a §12 license, anytime its star/cash/prerequisite gates are met. */
  | { type: "license.buy"; id: string }
  /** Buy the next §6 floor expansion. Morning only — the grid can't change
   *  under live paths. */
  | { type: "expansion.buy" }
  /** Buy the next §13 era renovation: closes the store for the rest of
   *  today; the new generation stands at tomorrow's open. */
  | { type: "era.renovate" }
  // --- Staff (§9; the pool is shared, rosters are per branch — §19) ---
  | { type: "staff.hire"; candidateId: string; storeId: string }
  | { type: "staff.fire"; staffId: string; storeId: string }
  | { type: "staff.assign"; staffId: string; stationId: string | null; storeId: string }
  // --- Multi-branch (§19) ---
  /** Buy a district's empty lot: site 300× rent + $15k fit-out (§26). */
  | { type: "branch.buy"; districtId: string }
  /** Morning only: choose the store the day's 3D sim loads into. */
  | { type: "branch.setActive"; storeId: string }
  // --- Distribution + logistics (§20; the DC is named by the command
  //     itself, transfers name both stores — no active-store defaults) ---
  /** Buy the freight depot: L6 + $60k puts the gray building on the map. */
  | { type: "dc.buy" }
  /** Buy a van for the garage — $8,000, capacity 400 (§26). */
  | { type: "truck.buy" }
  /** Central purchasing (§11/§20): the catalog at −12%, into DC stock. */
  | { type: "dc.order"; lines: OrderLine[] }
  /** Replace a van's whole manifest — stops, picking lists, transfers. */
  | { type: "truck.setRoute"; truckId: string; route: TruckStop[]; transfers: TruckTransfer[] }
  /** Draft a §20 branch→branch move; it compiles onto the first van that
   *  can take it (pickup at source, drop at target, within capacity). */
  | { type: "transfer.create"; fromStoreId: string; toStoreId: string; skuId: string; units: number }
  // --- AI endgame tech (§21; per-store and account-wide, like the deeds) ---
  /** Buy the verification assistant for one Gen 4 store with a verify desk. */
  | { type: "aitech.buyVerifyAssist"; storeId: string }
  /** Buy account-wide demand forecasting (any Gen 4 store + 28 days history). */
  | { type: "aitech.buyForecast" }
  // --- App shell (§23, §24) ---
  /** Patch any subset of the §24 settings; volumes clamp to 0–1. */
  | {
      type: "settings.set";
      volume?: number;
      sfx?: number;
      ambience?: number;
      reducedMotion?: boolean;
    }
  /** Dev-only spawn stress cycle ×1/×3/×9/×27 (milestone 03); handled by Sim, not here. */
  | { type: "dev.stressToggle" }
  // --- Dev event console (§16, milestone 11; keys in the README) ---
  /** Dev: start a regional shortage today in a random open category. */
  | { type: "dev.forceShortage" }
  /** Dev: put a storm on tomorrow's calendar (forecast prints tonight). */
  | { type: "dev.forceStorm" }
  /** Dev: skip a morning straight to the next one — no shift, no costs. */
  | { type: "dev.skipDay" };

/** Stations the player can work at (§8; the desk joins in the staffed era,
 *  the vaccine station with the cold chain — §9: any role's task). */
const WORKABLE = new Set([
  "counter_register",
  "counter_service",
  "fill_bench",
  "verify_desk",
  "vaccine_station",
]);

/** Every district has one §19 branch lot (data/districts.ts DISTRICT_MAPS).
 *  The set guards branch.buy from an invented district id — districtById
 *  throws, and a command must refuse, never crash. */
const DISTRICT_LOT_IDS: ReadonlySet<string> = new Set(DISTRICTS.map((d) => d.id));

function leaveStation(state: GameState, emit: (event: SimEvent) => void): void {
  if (state.workingStationId === null) return;
  state.workingStationId = null;
  emit({ type: "station.changed", stationId: null });
}

/** Resolve a command's branch scope (§19). Null refuses an id no store
 *  answers to. storeId is required on scoped commands — the active-floor
 *  call sites say activeStoreId out loud, so "this one really means the
 *  floor I'm standing on" is visible at the dispatch. */
function scopedStore(state: GameState, storeId: string): StoreState | null {
  return storeById(state, storeId);
}

/** Drop lines that are empty, unknown, or behind a licence gate (§12), cap
 *  a shorted category's fills to 60% (§16 — the same cap the Orders stub
 *  shows), and cap refrigerated lines to the fridge space still free (§14:
 *  40 a fridge, enforced at order time against held stock plus inbound).
 *  All against the ordering store's own walls (§19). */
function acceptableLines(
  state: GameState,
  store: StoreState,
  lines: readonly OrderLine[],
): OrderLine[] {
  const orderable = new Map(catalog(state, store).map((entry) => [entry.skuId, entry]));
  let coldClaimed = 0;
  const out: OrderLine[] = [];
  for (const l of lines) {
    const entry = orderable.get(l.skuId);
    let units = Math.floor(l.units);
    if (!entry || entry.lock !== null || units <= 0) continue;
    units = shortageFillCap(state, l.skuId, units);
    if (units <= 0) continue;
    if (entry.refrigerated) {
      units = coldClampUnits(store, units, coldClaimed);
      if (units <= 0) continue;
      coldClaimed += units;
    }
    out.push({ skuId: l.skuId, units });
  }
  return out;
}

/** §20 depot order lines: drop empties, unknowns, cold-chain SKUs and
 *  license-locked rows, and cap a shorted category's fills to 60% (§16) —
 *  once for the whole network, which is exactly the point of central
 *  purchasing during a squeeze. */
function acceptableDcLines(state: GameState, lines: readonly OrderLine[]): OrderLine[] {
  const out: OrderLine[] = [];
  const seen = new Set<string>();
  for (const l of lines) {
    let units = Math.floor(l.units);
    if (units <= 0 || seen.has(l.skuId)) continue;
    if (!isTruckSku(l.skuId) || dcSkuLock(state, l.skuId) !== null) continue;
    units = shortageFillCap(state, l.skuId, units);
    if (units <= 0) continue;
    seen.add(l.skuId);
    out.push({ skuId: l.skuId, units });
  }
  return out;
}

/** Morning turnover, shared by day.advance and the dev day skip: the new
 *  day begins, every store's van unloads (§19: deliveries arrive wherever
 *  ordered), the crews finish (§13), the world plans and announces its
 *  weather (§16) — all before the phase change goes out, so the autosave
 *  listening on it captures the completed morning. */
function beginMorning(state: GameState, emit: (event: SimEvent) => void): void {
  state.day += 1;
  state.clockIgm = DAY_START_IGM;
  state.phase = "morning";
  state.dayStats = emptyDayStats(state.cash);
  // Morning: yesterday's wholesale orders are on the loading steps (§5).
  const deliveries = state.stores.map((store) => ({
    storeId: store.id,
    ...receiveDeliveries(store),
  }));
  // §20: dawn at the depot — the −12% order lands on its shelves, then the
  // vans run their standing routes. Both before the phase change goes out,
  // so the autosave and the day's demand see goods where the trucks left
  // them (arrivals are morning-guaranteed; the map animation is flavor).
  const dcDelivery = state.dc ? receiveDcDeliveries(state.dc) : null;
  const truckArrivals = runTruckRoutes(state, emit);
  // Mondays put a fresh stack of applications on the counter (§9).
  const refreshed = refreshHiringPool(state);
  completeRenovation(state, emit);
  advanceWorld(state, emit);
  // §18: the market keeps its own calendar — Monday pool evaluation and the
  // 28-day drift — ahead of the phase change for the same autosave reason.
  advanceMarket(state, emit);
  emit({ type: "day.phaseChanged", phase: state.phase, day: state.day });
  emit({ type: "clock.minute", igm: state.clockIgm });
  for (const delivery of deliveries) {
    if (delivery.units > 0) emit({ type: "order.delivered", ...delivery });
  }
  if (dcDelivery !== null && dcDelivery.units > 0) {
    emit({ type: "dc.delivered", ...dcDelivery });
  }
  for (const arrival of truckArrivals) {
    emit({ type: "truck.arrived", ...arrival, day: state.day });
  }
  if (refreshed) emit({ type: "staff.poolRefreshed", day: state.day });
}

export function handleCommand(
  state: GameState,
  command: Command,
  emit: (event: SimEvent) => void,
): void {
  switch (command.type) {
    case "store.open": {
      if (state.phase !== "morning") return;
      state.phase = "shift";
      emit({ type: "day.phaseChanged", phase: state.phase, day: state.day });
      return;
    }
    case "day.advance": {
      if (state.phase !== "close") return;
      beginMorning(state, emit);
      return;
    }
    case "speed.set": {
      if (state.speed === command.speed) return;
      state.speed = command.speed;
      emit({ type: "speed.changed", speed: state.speed });
      return;
    }
    case "build.enter": {
      if (state.buildMode || state.phase === "close") return;
      state.buildMode = true;
      leaveStation(state, emit); // stepping away to renovate
      emit({ type: "build.changed", active: true });
      return;
    }
    case "build.exit": {
      if (!state.buildMode) return;
      state.buildMode = false;
      emit({ type: "build.changed", active: false });
      return;
    }
    case "furniture.place": {
      const store = activeStore(state);
      const { defId, cellX, cellY, rot } = command;
      if (!validatePlacement(state, defId, cellX, cellY, rot).ok) return;
      const def = furnitureDef(defId);
      const item = { id: `f${store.nextFurnitureId++}`, defId, cellX, cellY, rot };
      store.furniture.push(item);
      if (defId === "otc_shelf") store.shelfSlots[item.id] = []; // labels come with stock
      post(state, "fixtures", -def.cost, emit);
      emit({ type: "furniture.placed", item: { ...item } });
      return;
    }
    case "furniture.move": {
      const item = activeStore(state).furniture.find((f) => f.id === command.id);
      if (!item) return;
      const { cellX, cellY, rot } = command;
      if (!validatePlacement(state, item.defId, cellX, cellY, rot, item.id).ok) return;
      item.cellX = cellX;
      item.cellY = cellY;
      item.rot = rot;
      emit({ type: "furniture.moved", item: { ...item } });
      return;
    }
    case "furniture.sell": {
      const store = activeStore(state);
      const index = store.furniture.findIndex((f) => f.id === command.id);
      if (index === -1) return;
      const item = store.furniture[index]!;
      const refund = Math.round(furnitureDef(item.defId).cost / 2);
      store.furniture.splice(index, 1);
      // Stock on a sold shelf goes back in a box, not in the bin. Controlled
      // and cold stock are boxed only when the *last* cabinet or fridge goes —
      // units pool across the surviving fixtures (§14, §25).
      if (item.defId === "otc_shelf") clearShelf(store, item.id);
      if (
        item.defId === "cabinet_controlled" &&
        !store.furniture.some((f) => f.defId === "cabinet_controlled")
      ) {
        clearControlled(store);
      }
      if (item.defId === "fridge_medical" && !hasFridge(store)) {
        clearRefrigerated(store);
      }
      if (state.workingStationId === item.id) leaveStation(state, emit);
      // Anyone stationed at a sold fixture is off duty until reassigned.
      for (const member of store.staff) {
        if (member.assignment?.stationId === item.id) {
          delete member.assignment;
          emit({ type: "staff.assigned", storeId: store.id, id: member.id, stationId: null });
        }
      }
      post(state, "fixtures", refund, emit);
      emit({ type: "furniture.sold", id: item.id, refund });
      return;
    }
    case "station.workHere": {
      if (state.phase !== "shift" || state.buildMode) return;
      const item = activeStore(state).furniture.find((f) => f.id === command.stationId);
      if (!item || !WORKABLE.has(item.defId)) return;
      if (state.workingStationId === item.id) return;
      state.workingStationId = item.id;
      emit({ type: "station.changed", stationId: item.id });
      return;
    }
    case "station.leave": {
      leaveStation(state, emit);
      return;
    }
    case "order.submit": {
      if (state.phase === "close") return;
      const store = scopedStore(state, command.storeId);
      if (!store) return;
      const lines = acceptableLines(state, store, command.lines);
      if (lines.length === 0) return;
      const total = orderTotal(state, store, lines);
      if (total > state.cash) return;
      queueDelivery(store, lines);
      post(state, "order", -total, emit);
      const units = lines.reduce((sum, l) => sum + l.units, 0);
      emit({ type: "order.submitted", storeId: store.id, lines, units, total });
      return;
    }
    case "otc.setPrice": {
      if (!isOtc(command.skuId)) return;
      const store = scopedStore(state, command.storeId);
      if (!store) return;
      const multiplier = clampMultiplier(command.multiplier);
      if (store.otcPricing[command.skuId] === multiplier) return;
      store.otcPricing[command.skuId] = multiplier;
      refreshPriceIndex(store);
      emit({ type: "otc.priceChanged", skuId: command.skuId, multiplier });
      return;
    }
    case "stock.restock": {
      if (state.phase === "close" || state.buildMode) return;
      const units = restock(state, command.furnitureId);
      if (units <= 0) return;
      emit({ type: "stock.restocked", furnitureId: command.furnitureId, units });
      return;
    }
    case "reorder.setRule": {
      const store = scopedStore(state, command.storeId);
      if (!store || !store.reorderUnlocked) return;
      const min = Math.max(0, Math.floor(command.min));
      const target = Math.max(min, Math.floor(command.target));
      if (min === 0 && target === 0) delete store.reorderRules[command.skuId];
      else store.reorderRules[command.skuId] = { min, target };
      return;
    }
    case "loan.draw": {
      const bank = bankStatus(state);
      if (bank.lock !== null) return;
      const amount = round2(Math.min(command.amount, bank.available));
      if (amount <= 0) return;
      state.loans.bank = round2(state.loans.bank + amount);
      post(state, "bank.draw", amount, emit);
      emit({ type: "loan.changed", bank: state.loans.bank, family: state.loans.family });
      return;
    }
    case "loan.repay": {
      const amount = round2(Math.min(command.amount, state.loans.bank, state.cash));
      if (amount <= 0) return;
      state.loans.bank = round2(state.loans.bank - amount);
      post(state, "bank.payment", -amount, emit);
      emit({ type: "loan.changed", bank: state.loans.bank, family: state.loans.family });
      return;
    }
    case "license.buy": {
      if (state.phase === "close" || ownsLicense(state, command.id)) return;
      const def = licenseDef(command.id);
      if (!canBuyLicense(state, def)) return;
      state.licenses.push(def.id);
      state.stats[`license.${def.id}`] = state.day;
      post(state, "license", -def.cost, emit);
      // Every license is a §22 moment: the note pins to tonight's receipt.
      recordMoment(state, `license.${def.id}`, emit);
      emit({ type: "license.bought", id: def.id, name: def.name, cost: def.cost, day: state.day });
      return;
    }
    case "expansion.buy": {
      if (state.phase !== "morning") return;
      const store = activeStore(state);
      const level = store.grid.expansions;
      const next = EXPANSIONS[level];
      if (!next || state.cash < next.cost) return;
      // A hand-edited save can carry an expansions count that lags its
      // cols/rows; growing is the only direction this command ever moves.
      if (next.cols < store.grid.cols || next.rows < store.grid.rows) return;
      // The door rides the south wall's center, so it moves when cols does —
      // furniture legal on the old floor must not end up in the new gap.
      if (doorwayBlocked(state, next.cols, next.rows)) return;
      store.grid.cols = next.cols;
      store.grid.rows = next.rows;
      store.grid.expansions = level + 1;
      state.stats[`expansion.E${level + 1}`] = state.day;
      post(state, "expansion", -next.cost, emit);
      emit({
        type: "expansion.bought",
        level: level + 1,
        cols: next.cols,
        rows: next.rows,
        cost: next.cost,
        day: state.day,
      });
      return;
    }
    case "era.renovate": {
      beginRenovation(state, emit);
      return;
    }
    case "staff.hire": {
      if (state.phase === "close") return;
      const store = scopedStore(state, command.storeId);
      if (!store) return;
      const index = state.hiring.candidates.findIndex((c) => c.id === command.candidateId);
      if (index === -1) return;
      const candidate = state.hiring.candidates[index]!;
      state.hiring.candidates.splice(index, 1);
      const member: StaffMember = {
        id: candidate.id,
        name: candidate.name,
        role: candidate.role,
        speed: candidate.speed,
        accuracy: candidate.accuracy,
        warmth: candidate.warmth,
        trait: candidate.trait,
        dailyWage: candidate.wageAsked,
        hiredOnDay: state.day,
      };
      // Straight to the first open station their role can hold, in the
      // role's own priority order (§9) — a pharmacist takes an open verify
      // desk before a vaccine station (§14: scripts before shots).
      const taken = new Set(store.staff.map((m) => m.assignment?.stationId).filter(Boolean));
      let station: PlacedFurniture | undefined;
      for (const defId of ROLE_STATIONS[member.role]) {
        station = store.furniture.find((f) => f.defId === defId && !taken.has(f.id));
        if (station) break;
      }
      if (station) member.assignment = { stationId: station.id };
      store.staff.push(member);
      // The first name that isn't yours on any roster is a §22 moment.
      recordMoment(state, "first_hire", emit);
      // Events carry copies, never live roster state (furniture.placed style).
      const hired: StaffMember = { ...member };
      if (member.assignment) hired.assignment = { ...member.assignment };
      emit({ type: "staff.hired", storeId: store.id, member: hired });
      return;
    }
    case "staff.fire": {
      if (state.phase === "close") return;
      const store = scopedStore(state, command.storeId);
      if (!store) return;
      const index = store.staff.findIndex((m) => m.id === command.staffId);
      if (index === -1) return;
      const member = store.staff[index]!;
      store.staff.splice(index, 1);
      // Fired mid-shift, paid for the day on the spot — no severance (§9,
      // cozy not cruel), and wages stop from tomorrow's receipt.
      if (state.phase === "shift") post(state, "wages", -member.dailyWage, emit);
      emit({ type: "staff.fired", storeId: store.id, id: member.id, name: member.name });
      return;
    }
    case "staff.assign": {
      const store = scopedStore(state, command.storeId);
      if (!store) return;
      const member = store.staff.find((m) => m.id === command.staffId);
      if (!member) return;
      if (command.stationId === null) {
        if (!member.assignment) return;
        delete member.assignment;
        emit({ type: "staff.assigned", storeId: store.id, id: member.id, stationId: null });
        return;
      }
      const station = store.furniture.find((f) => f.id === command.stationId);
      if (!station || !ROLE_STATIONS[member.role].includes(station.defId)) return;
      const held = store.staff.some(
        (m) => m.id !== member.id && m.assignment?.stationId === station.id,
      );
      if (held) return;
      member.assignment = { stationId: station.id };
      emit({ type: "staff.assigned", storeId: store.id, id: member.id, stationId: station.id });
      return;
    }
    case "branch.buy": {
      // §19: L5 opens the lots. Buying is fine any time the register is
      // open — the new branch has no staff or stock, so it simply exists
      // until the player gives it a morning.
      if (state.phase === "close" || !ownsLicense(state, "L5")) return;
      const districtId = command.districtId;
      if (!DISTRICT_LOT_IDS.has(districtId)) return;
      // One branch per district lot; the founding store stands on its own
      // site, so its district's lot is still for sale.
      const lotTaken = state.stores.some(
        (s) => !isFoundingStore(state, s) && s.districtId === districtId,
      );
      if (lotTaken) return;
      const price = branchPrice(districtId);
      if (state.cash < price.total) return;
      // Count past the highest suffix actually present, not the array
      // length: validate() accepts any unique ids, so an imported
      // ["s1","s3"] file is legal — length + 1 would mint a second "s3",
      // alias every lookup onto the first, and the next autosave would be
      // refused for duplicate ids at the following boot.
      let suffix = 0;
      for (const s of state.stores) {
        const match = /^s(\d+)$/.exec(s.id);
        if (match) suffix = Math.max(suffix, Number(match[1]));
      }
      const store = freshStore(`s${suffix + 1}`, districtId);
      state.stores.push(store);
      state.stats[`branch.${districtId}`] = state.day;
      post(state, "branch.purchase", -price.total, emit);
      // §22: the second door is a moment — the note pins to tonight's receipt.
      recordMoment(state, "first_branch", emit);
      emit({
        type: "branch.bought",
        storeId: store.id,
        districtId,
        cost: price.total,
        day: state.day,
      });
      return;
    }
    case "branch.setActive": {
      // Morning only (§19): the swap is a full scene rebuild, and the
      // morning is the one phase with nobody on the floor.
      if (state.phase !== "morning") return;
      if (command.storeId === state.activeStoreId) return;
      if (storeById(state, command.storeId) === null) return;
      // A held build ghost belongs to the old floor; put it down first.
      if (state.buildMode) {
        state.buildMode = false;
        emit({ type: "build.changed", active: false });
      }
      state.activeStoreId = command.storeId;
      emit({ type: "branch.activeChanged", storeId: command.storeId });
      return;
    }
    case "dc.buy": {
      if (state.phase === "close" || state.dc !== null) return;
      if (!ownsLicense(state, "L6") || state.cash < DC_COST) return;
      state.dc = freshDc();
      state.stats["dc.built"] = state.day;
      post(state, "dc.purchase", -DC_COST, emit);
      // §22: a whole building with no counter in it is a moment.
      recordMoment(state, "dc_open", emit);
      emit({ type: "dc.bought", cost: DC_COST, day: state.day });
      return;
    }
    case "truck.buy": {
      if (state.phase === "close" || state.dc === null) return;
      if (state.dc.trucks.length >= MAX_TRUCKS || state.cash < TRUCK_COST) return;
      // Count past the highest suffix present, not the array length — the
      // same rule branch.buy follows (validate() accepts any unique ids).
      let suffix = 0;
      for (const t of state.dc.trucks) {
        const match = /^t(\d+)$/.exec(t.id);
        if (match) suffix = Math.max(suffix, Number(match[1]));
      }
      const truck: Truck = { id: `t${suffix + 1}`, lastRunDay: 0, route: [], transfers: [] };
      state.dc.trucks.push(truck);
      post(state, "truck.purchase", -TRUCK_COST, emit);
      emit({ type: "truck.bought", truckId: truck.id, cost: TRUCK_COST });
      return;
    }
    case "dc.order": {
      if (state.phase === "close" || state.dc === null) return;
      const lines = acceptableDcLines(state, command.lines);
      if (lines.length === 0) return;
      const total = dcOrderTotal(state, lines);
      if (total > state.cash) return;
      // Merge into the depot's inbound per SKU, the queueDelivery way.
      for (const l of lines) {
        const existing = state.dc.inbound.find((i) => i.skuId === l.skuId);
        if (existing) existing.units += l.units;
        else state.dc.inbound.push({ skuId: l.skuId, units: l.units });
      }
      post(state, "order", -total, emit);
      const units = lines.reduce((sum, l) => sum + l.units, 0);
      emit({ type: "dc.orderSubmitted", units, total });
      return;
    }
    case "truck.setRoute": {
      // No close-phase guard on purpose, unlike its purchase siblings: a
      // manifest edit moves no cash and touches nothing until the next
      // morning — the same standing-draft rule as reorder.setRule.
      if (state.dc === null) return;
      const truck = state.dc.trucks.find((t) => t.id === command.truckId);
      if (!truck) return;
      // The drafting UI surfaces the same check's sentence; a refused
      // manifest is a silent no-op like every other command.
      if (validateTruckConfig(state, command.route, command.transfers) !== null) return;
      // Deep copies — a persisted manifest must never alias the payload.
      truck.route = copyRoute(command.route);
      truck.transfers = copyTransfers(command.transfers);
      emit({ type: "truck.routeChanged", truckId: truck.id });
      return;
    }
    case "transfer.create": {
      if (state.phase === "close" || state.dc === null) return;
      const source = storeById(state, command.fromStoreId);
      if (!source || storeById(state, command.toStoreId) === null) return;
      if (!isTruckSku(command.skuId)) return;
      // Move what the source can actually give, net of what earlier drafts
      // already promised off the same shelves — stacked clicks must not
      // drain the source twice at dawn. The morning pickup clamps again
      // against that morning's real stock.
      const pending = pendingPickupUnits(state.dc, command.fromStoreId, command.skuId);
      const units = Math.min(
        Math.floor(command.units),
        onHand(source, command.skuId) - pending,
      );
      if (units < 1) return;
      const plan = planTransfer(state, command.fromStoreId, command.toStoreId, command.skuId, units);
      if (!plan.ok) return;
      const truck = state.dc.trucks.find((t) => t.id === plan.truckId);
      if (!truck) return;
      truck.route = plan.route;
      truck.transfers = plan.transfers;
      emit({
        type: "transfer.drafted",
        truckId: truck.id,
        fromStoreId: command.fromStoreId,
        toStoreId: command.toStoreId,
        skuId: command.skuId,
        units,
      });
      emit({ type: "truck.routeChanged", truckId: truck.id });
      return;
    }
    case "aitech.buyVerifyAssist": {
      if (state.phase === "close") return;
      const store = scopedStore(state, command.storeId);
      if (!store || hasVerifyAssist(state, store.id)) return;
      // The same gates the module card reads (§21): Gen 4, a verify desk,
      // and the fee — a refused purchase is a silent no-op like every other.
      if (verifyAssistLock(state, store) !== null) return;
      state.aitech.verifyAssist.push(store.id);
      state.stats[`aitech.verify.${store.id}`] = state.day;
      post(state, "aitech.purchase", -VERIFY_ASSIST_COST, emit);
      // §22: the first AI module on the account is the moment.
      recordMoment(state, "ai_modules", emit);
      emit({
        type: "aitech.verifyAssistBought",
        storeId: store.id,
        cost: VERIFY_ASSIST_COST,
        day: state.day,
      });
      return;
    }
    case "aitech.buyForecast": {
      if (state.phase === "close" || state.aitech.forecast) return;
      if (forecastLock(state) !== null) return;
      state.aitech.forecast = true;
      state.stats["aitech.forecast"] = state.day;
      post(state, "aitech.purchase", -FORECAST_COST, emit);
      recordMoment(state, "ai_modules", emit);
      emit({ type: "aitech.forecastBought", cost: FORECAST_COST, day: state.day });
      return;
    }
    case "settings.set": {
      const s = state.settings;
      const clamp = (value: number | undefined, current: number): number =>
        value === undefined || !Number.isFinite(value)
          ? current
          : Math.min(1, Math.max(0, value));
      const next: GameSettings = {
        volume: clamp(command.volume, s.volume),
        sfx: clamp(command.sfx, s.sfx),
        ambience: clamp(command.ambience, s.ambience),
        reducedMotion: command.reducedMotion ?? s.reducedMotion,
      };
      if (
        next.volume === s.volume &&
        next.sfx === s.sfx &&
        next.ambience === s.ambience &&
        next.reducedMotion === s.reducedMotion
      ) {
        return;
      }
      Object.assign(s, next); // in place — captured references stay live
      emit({ type: "settings.changed", settings: { ...next } });
      return;
    }
    case "dev.forceShortage": {
      if (state.phase === "close") return;
      emit({ type: "dev.eventForced", message: forceShortage(state, emit) });
      return;
    }
    case "dev.forceStorm": {
      // Close is too late: tonight's receipt has already printed without
      // the forecast, and "forecast on yesterday's receipt" is the contract.
      if (state.phase === "close") return;
      emit({ type: "dev.eventForced", message: forceStorm(state) });
      return;
    }
    case "dev.skipDay": {
      // Morning only: skipping a live shift would strand its customers.
      if (state.phase !== "morning") return;
      beginMorning(state, emit);
      emit({ type: "dev.eventForced", message: `Skipped to day ${state.day}` });
      return;
    }
    case "fill.pickBin":
    case "dev.stressToggle":
      return; // handled by Sim (workflow/customer systems live outside GameState)
  }
}
