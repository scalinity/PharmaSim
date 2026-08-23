// Command union + handlers. All mutations of GameState go through here.
// Furniture commands re-validate via placement.ts; the UI validates first
// and surfaces reasons, so failed commands are silent no-ops.

import { DAY_START_IGM } from "../core/clock";
import type { Rot } from "../core/grid";
import { EXPANSIONS, furnitureDef } from "../data/furniture";
import {
  bankStatus,
  catalog,
  orderTotal,
  post,
  round2,
} from "./economy";
import type { SimEvent } from "./events";
import {
  clampMultiplier,
  clearControlled,
  clearShelf,
  isOtc,
  queueDelivery,
  receiveDeliveries,
  refreshPriceIndex,
  restock,
} from "./inventory";
import { canBuyLicense, licenseDef, ownsLicense } from "./licenses";
import { validatePlacement } from "./placement";
import { refreshHiringPool, ROLE_STATIONS, type StaffMember } from "./staff";
import { emptyDayStats, type GameState, type GameSpeed, type OrderLine } from "./state";

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
  // --- Inventory + economy (§10, §11) ---
  /** Buy wholesale: cash out now, goods land in the backroom next morning. */
  | { type: "order.submit"; lines: OrderLine[] }
  | { type: "otc.setPrice"; skuId: string; multiplier: number }
  /** Move backroom stock onto a shelf's labels or into the Rx bins. */
  | { type: "stock.restock"; furnitureId: string }
  | { type: "reorder.setRule"; skuId: string; min: number; target: number }
  | { type: "loan.draw"; amount: number }
  | { type: "loan.repay"; amount: number }
  // --- Licenses + expansion (§6, §12) ---
  /** Buy a §12 license, anytime its star/cash/prerequisite gates are met. */
  | { type: "license.buy"; id: string }
  /** Buy the next §6 floor expansion. Morning only — the grid can't change
   *  under live paths. */
  | { type: "expansion.buy" }
  // --- Staff (§9) ---
  | { type: "staff.hire"; candidateId: string }
  | { type: "staff.fire"; staffId: string }
  | { type: "staff.assign"; staffId: string; stationId: string | null }
  // --- App shell (§23, §24) ---
  /** Reduced motion is the only live setting; volumes wait for milestone 17. */
  | { type: "settings.set"; reducedMotion: boolean }
  /** Dev-only spawn stress cycle ×1/×3/×9/×27 (milestone 03); handled by Sim, not here. */
  | { type: "dev.stressToggle" };

/** Stations the player can work at (§8; the desk joins in the staffed era). */
const WORKABLE = new Set(["counter_register", "counter_service", "fill_bench", "verify_desk"]);

function leaveStation(state: GameState, emit: (event: SimEvent) => void): void {
  if (state.workingStationId === null) return;
  state.workingStationId = null;
  emit({ type: "station.changed", stationId: null });
}

/** Drop lines that are empty, unknown, or behind a licence gate (§12). */
function acceptableLines(state: GameState, lines: readonly OrderLine[]): OrderLine[] {
  const orderable = new Map(catalog(state).map((entry) => [entry.skuId, entry]));
  const out: OrderLine[] = [];
  for (const l of lines) {
    const entry = orderable.get(l.skuId);
    const units = Math.floor(l.units);
    if (!entry || entry.lock !== null || units <= 0) continue;
    out.push({ skuId: l.skuId, units });
  }
  return out;
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
      state.day += 1;
      state.clockIgm = DAY_START_IGM;
      state.phase = "morning";
      state.dayStats = emptyDayStats(state.cash);
      // Morning: yesterday's wholesale order is on the loading step (§5).
      const delivery = receiveDeliveries(state.store);
      // Mondays put a fresh stack of applications on the counter (§9).
      const refreshed = refreshHiringPool(state);
      emit({ type: "day.phaseChanged", phase: state.phase, day: state.day });
      emit({ type: "clock.minute", igm: state.clockIgm });
      if (delivery.units > 0) emit({ type: "order.delivered", ...delivery });
      if (refreshed) emit({ type: "staff.poolRefreshed", day: state.day });
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
      const { defId, cellX, cellY, rot } = command;
      if (!validatePlacement(state, defId, cellX, cellY, rot).ok) return;
      const def = furnitureDef(defId);
      const item = { id: `f${state.store.nextFurnitureId++}`, defId, cellX, cellY, rot };
      state.store.furniture.push(item);
      if (defId === "otc_shelf") state.store.shelfSlots[item.id] = []; // labels come with stock
      post(state, "fixtures", -def.cost, emit);
      emit({ type: "furniture.placed", item: { ...item } });
      return;
    }
    case "furniture.move": {
      const item = state.store.furniture.find((f) => f.id === command.id);
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
      const index = state.store.furniture.findIndex((f) => f.id === command.id);
      if (index === -1) return;
      const item = state.store.furniture[index]!;
      const refund = Math.round(furnitureDef(item.defId).cost / 2);
      state.store.furniture.splice(index, 1);
      // Stock on a sold shelf goes back in a box, not in the bin. A sold
      // cabinet boxes its Tier-3 stock the same way (§25).
      if (item.defId === "otc_shelf") clearShelf(state.store, item.id);
      if (item.defId === "cabinet_controlled") clearControlled(state.store);
      if (state.workingStationId === item.id) leaveStation(state, emit);
      // Anyone stationed at a sold fixture is off duty until reassigned.
      for (const member of state.store.staff) {
        if (member.assignment?.stationId === item.id) {
          delete member.assignment;
          emit({ type: "staff.assigned", id: member.id, stationId: null });
        }
      }
      post(state, "fixtures", refund, emit);
      emit({ type: "furniture.sold", id: item.id, refund });
      return;
    }
    case "station.workHere": {
      if (state.phase !== "shift" || state.buildMode) return;
      const item = state.store.furniture.find((f) => f.id === command.stationId);
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
      const lines = acceptableLines(state, command.lines);
      if (lines.length === 0) return;
      const total = orderTotal(state, lines);
      if (total > state.cash) return;
      queueDelivery(state.store, lines);
      post(state, "order", -total, emit);
      const units = lines.reduce((sum, l) => sum + l.units, 0);
      emit({ type: "order.submitted", lines, units, total });
      return;
    }
    case "otc.setPrice": {
      if (!isOtc(command.skuId)) return;
      const multiplier = clampMultiplier(command.multiplier);
      if (state.store.otcPricing[command.skuId] === multiplier) return;
      state.store.otcPricing[command.skuId] = multiplier;
      refreshPriceIndex(state.store);
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
      if (!state.store.reorderUnlocked) return;
      const min = Math.max(0, Math.floor(command.min));
      const target = Math.max(min, Math.floor(command.target));
      if (min === 0 && target === 0) delete state.store.reorderRules[command.skuId];
      else state.store.reorderRules[command.skuId] = { min, target };
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
      // A §22 legacy moment — milestone 10 hangs the flavor on this event.
      emit({ type: "license.bought", id: def.id, name: def.name, cost: def.cost, day: state.day });
      return;
    }
    case "expansion.buy": {
      if (state.phase !== "morning") return;
      const level = state.store.grid.expansions;
      const next = EXPANSIONS[level];
      if (!next || state.cash < next.cost) return;
      state.store.grid.cols = next.cols;
      state.store.grid.rows = next.rows;
      state.store.grid.expansions = level + 1;
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
    case "staff.hire": {
      if (state.phase === "close") return;
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
      // Straight to the first open station their role can hold (§9).
      const defs = ROLE_STATIONS[member.role];
      const taken = new Set(
        state.store.staff.map((m) => m.assignment?.stationId).filter(Boolean),
      );
      const station = state.store.furniture.find(
        (f) => defs.includes(f.defId) && !taken.has(f.id),
      );
      if (station) member.assignment = { stationId: station.id };
      state.store.staff.push(member);
      // Events carry copies, never live roster state (furniture.placed style).
      const hired: StaffMember = { ...member };
      if (member.assignment) hired.assignment = { ...member.assignment };
      emit({ type: "staff.hired", member: hired });
      return;
    }
    case "staff.fire": {
      if (state.phase === "close") return;
      const index = state.store.staff.findIndex((m) => m.id === command.staffId);
      if (index === -1) return;
      const member = state.store.staff[index]!;
      state.store.staff.splice(index, 1);
      // Fired mid-shift, paid for the day on the spot — no severance (§9,
      // cozy not cruel), and wages stop from tomorrow's receipt.
      if (state.phase === "shift") post(state, "wages", -member.dailyWage, emit);
      emit({ type: "staff.fired", id: member.id, name: member.name });
      return;
    }
    case "staff.assign": {
      const member = state.store.staff.find((m) => m.id === command.staffId);
      if (!member) return;
      if (command.stationId === null) {
        if (!member.assignment) return;
        delete member.assignment;
        emit({ type: "staff.assigned", id: member.id, stationId: null });
        return;
      }
      const station = state.store.furniture.find((f) => f.id === command.stationId);
      if (!station || !ROLE_STATIONS[member.role].includes(station.defId)) return;
      const held = state.store.staff.some(
        (m) => m.id !== member.id && m.assignment?.stationId === station.id,
      );
      if (held) return;
      member.assignment = { stationId: station.id };
      emit({ type: "staff.assigned", id: member.id, stationId: station.id });
      return;
    }
    case "settings.set": {
      if (state.settings.reducedMotion === command.reducedMotion) return;
      state.settings.reducedMotion = command.reducedMotion;
      emit({ type: "settings.changed", settings: { ...state.settings } });
      return;
    }
    case "fill.pickBin":
    case "dev.stressToggle":
      return; // handled by Sim (workflow/customer systems live outside GameState)
  }
}
