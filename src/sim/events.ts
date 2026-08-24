// SimEvent union — everything the sim announces to render/ and ui/.

import type { Season } from "../core/clock";
import type { DriftMove } from "../data/competitors";
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
  /** A store's §19 local reputation moved — `storeId` names whose. */
  | { type: "rep.changed"; storeId: string; stars: number; delta: number }
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
  | { type: "order.submitted"; storeId: string; lines: OrderLine[]; units: number; total: number }
  /** One van per store with goods due (§19) — `storeId` names the door. */
  | { type: "order.delivered"; storeId: string; units: number; skus: number }
  | { type: "otc.priceChanged"; skuId: string; multiplier: number }
  | { type: "loan.changed"; bank: number; family: number }
  // --- Licenses + expansion (§6, §12, milestone 08; legacy moments for 10, §22) ---
  | { type: "license.bought"; id: string; name: string; cost: number; day: number }
  | { type: "expansion.bought"; level: number; cols: number; rows: number; cost: number; day: number }
  // --- Era modernization + legacy (§13, §22, milestone 10) ---
  /** Renovation bought: scaffolding up, no more arrivals today (§13). */
  | { type: "era.renovationStarted"; era: 2 | 3 | 4; name: string; cost: number; day: number }
  /** Next morning: the new era stands — render reskins, the HUD paper tints. */
  | { type: "era.changed"; era: 1 | 2 | 3 | 4 }
  /** A §22 moment, fired the once it happens; the note pins to today's receipt. */
  | { type: "legacy.moment"; id: string; day: number }
  // --- Vaccination service (§14, milestone 09) ---
  | { type: "vaccine.given"; customerId: number; total: number }
  /** A walk-in reached the station and there was no dose to give (§14). */
  | { type: "vaccine.noDose"; customerId: number }
  // --- Staff (§9, milestone 07; per-branch rosters M14) ---
  | { type: "staff.hired"; storeId: string; member: StaffMember }
  | { type: "staff.fired"; storeId: string; id: string; name: string }
  | { type: "staff.assigned"; storeId: string; id: string; stationId: string | null }
  /** Monday morning: a fresh set of applications on the counter (§9). */
  | { type: "staff.poolRefreshed"; day: number }
  // --- World events + atmosphere (§16, milestone 11) ---
  /** A new season took the calendar this morning (§5, §16). */
  | { type: "season.changed"; season: Season; day: number }
  /** A regional shortage squeezed one Rx category (§16): ×1.5 wholesale,
   *  fills capped 60% through endDay. The ticker names the category. */
  | { type: "shortage.started"; category: string; day: number; endDay: number }
  | { type: "shortage.ended"; category: string; day: number }
  /** The power dropped (on) or came back (off) during a storm's outage
   *  window; `generator` says whether a backup stood for the cold chain. */
  | { type: "outage.changed"; on: boolean; generator: boolean }
  /** No generator when the power dropped: the fridge's stock is gone,
   *  posted to the ledger at wholesale value (§14). */
  | { type: "coldchain.spoiled"; units: number; value: number }
  /** Storm-day weather bed — a hook for milestone 17's audio, silent now. */
  | { type: "ambience.rain"; on: boolean }
  // --- Competitors + market (§18, milestone 13) ---
  /** §18 drift: the weakest rival improved an attribute a notch this
   *  morning. A trigger only — every consumer derives its copy from
   *  state.market, so a reload reads the same news. */
  | { type: "competitor.drift"; id: string; move: DriftMove; day: number }
  /** A chronic pool's refills changed hands (§18): out on two bad
   *  experiences, in on the Monday evaluation. A trigger only — the
   *  names and reason live on state.market.transfers. */
  | { type: "market.transfer"; direction: "in" | "out"; poolId: string; day: number }
  // --- Multi-branch (§19, milestone 14) ---
  /** A lot became a branch: the deed is signed, the §24 store exists. */
  | { type: "branch.bought"; storeId: string; districtId: string; cost: number; day: number }
  /** The morning's store changed (§19): the 3D sim rebuilds onto it. */
  | { type: "branch.activeChanged"; storeId: string }
  /** An unvisited branch's day resolved (§19/§24). A trigger only — the
   *  numbers live on that store's daySummary. */
  | { type: "branch.daySummary"; storeId: string; day: number }
  /** A dev console command took effect; the message is toast-ready. */
  | { type: "dev.eventForced"; message: string }
  // --- App shell (§23, milestone 06) ---
  | { type: "settings.changed"; settings: GameSettings }
  | { type: "dev.stress"; mult: number };
