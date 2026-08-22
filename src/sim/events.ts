// SimEvent union — everything the sim announces to render/ and ui/.

import type { Archetype } from "./customers";
import type { DayPhase, GameSpeed, OrderLine, PlacedFurniture } from "./state";
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
      /** 12 drug ids, row-major over the shelf's 4×3 bin face. */
      bins: string[];
      /** Rx shelf the picking frames, or null when none is placed. */
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
  | { type: "stock.restocked"; furnitureId: string; units: number }
  /** First stock-out: per-SKU reorder rules become available (§11). */
  | { type: "reorder.unlocked" }
  | { type: "order.submitted"; lines: OrderLine[]; units: number; total: number }
  | { type: "order.delivered"; units: number; skus: number }
  | { type: "otc.priceChanged"; skuId: string; multiplier: number }
  | { type: "loan.changed"; bank: number; family: number }
  | { type: "dev.stress"; mult: number };
