// SimEvent union — everything the sim announces to render/ and ui/.

import type { Archetype } from "./customers";
import type { StaffMember } from "./staff";
import type { DayPhase, GameSettings, GameSpeed, OrderLine, PlacedFurniture } from "./state";
import type { RxStage } from "./workflow";

export type SimEvent =
  | { type: "day.phaseChanged"; phase: DayPhase; day: number }
  | { type: "clock.minute"; igm: number }
  | { type: "speed.changed"; speed: GameSpeed }
  | { type: "build.changed"; active: boolean }
  | { type: "furniture.placed"; item: PlacedFurniture }
  | { type: "furniture.moved"; item: PlacedFurniture }
  | { type: "furniture.sold"; id: string; refund: number }
  | { type: "cash.changed"; cash: number }
  | { type: "customer.spawned"; id: number; archetype: Archetype }
  | { type: "customer.walkout"; id: number; archetype: Archetype }
  | { type: "sale.completed"; customerId: number; items: number; total: number }
  | { type: "rep.changed"; stars: number; delta: number }
  | { type: "station.changed"; stationId: string | null }
  // --- Prescription workflow (§8, milestone 04) ---
  | { type: "rx.stageChanged"; scriptId: number; stage: RxStage }
  | { type: "rx.dropoff"; scriptId: number; drugId: string }
  | { type: "rx.refused"; drugId: string; customerId: number }
  /** Player took a script at the bench: the RxCard + bin picking begin. */
  | {
      type: "rx.fillStarted";
      scriptId: number;
      drugId: string;
      patientName: string;
      quantity: number;
      /** Drug ids, row-major over the fixture's bin face: 12 on the Rx
       *  shelf's 4×3, 9 on the controlled cabinet's 3×3, 4 on the medical
       *  fridge's 2×2 (§8, §25). */
      bins: string[];
      /** Bin fixture the picking frames (Rx shelf, controlled cabinet for a
       *  Tier-3 script, fridge for cold chain), or null when none is placed. */
      shelfId: string | null;
    }
  | { type: "rx.binPicked"; scriptId: number }
  /** Fill left the bench (completed or aborted); the RxCard slides out. */
  | { type: "rx.fillEnded"; scriptId: number }
  | { type: "rx.caught"; scriptId: number }
  | { type: "rx.ready"; scriptId: number }
  | { type: "rx.pickedUp"; scriptId: number; total: number; counseled: boolean }
  | { type: "rx.errorDispensed"; scriptId: number; refund: number }
  | { type: "rx.cancelled"; scriptId: number }
  // --- Inventory + economy (§10, §11, milestone 05) ---
  /** A sale or fill lost to an empty shelf label or bin. */
  | { type: "stock.out"; skuId: string }
  /** `by` names the Stock Hawk who made the trip; absent for player clicks. */
  | { type: "stock.restocked"; furnitureId: string; units: number; by?: string }
  /** First stock-out: per-SKU reorder rules become available (§11). */
  | { type: "reorder.unlocked" }
  | { type: "order.submitted"; lines: OrderLine[]; units: number; total: number }
  | { type: "order.delivered"; units: number; skus: number }
  | { type: "otc.priceChanged"; skuId: string; multiplier: number }
  | { type: "loan.changed"; bank: number; family: number }
  // --- Licenses + expansion (§6, §12, milestone 08; legacy moments for 10, §22) ---
  | { type: "license.bought"; id: string; name: string; cost: number; day: number }
  | { type: "expansion.bought"; level: number; cols: number; rows: number; cost: number; day: number }
  // --- Vaccination service (§14, milestone 09) ---
  | { type: "vaccine.given"; customerId: number; total: number }
  /** A walk-in reached the station and there was no dose to give (§14). */
  | { type: "vaccine.noDose"; customerId: number }
  // --- Staff (§9, milestone 07) ---
  | { type: "staff.hired"; member: StaffMember }
  | { type: "staff.fired"; id: string; name: string }
  | { type: "staff.assigned"; id: string; stationId: string | null }
  /** Monday morning: a fresh set of applications on the counter (§9). */
  | { type: "staff.poolRefreshed"; day: number }
  // --- App shell (§23, milestone 06) ---
  | { type: "settings.changed"; settings: GameSettings }
  | { type: "dev.stress"; mult: number };
