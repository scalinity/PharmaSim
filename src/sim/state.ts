// GameState root type + factory (SPEC §5, §6, §11, §24, §26).

import { DAY_START_IGM } from "../core/clock";
import type { Rot } from "../core/grid";
import { TIER1_DRUGS } from "../data/drugs";

export type DayPhase = "morning" | "shift" | "close";
export type GameSpeed = 0 | 1 | 2;

export interface PlacedFurniture {
  id: string;
  defId: string;
  /** Min (north-west) cell of the rotated footprint. */
  cellX: number;
  cellY: number;
  rot: Rot;
}

/** One stocked slot on an OTC shelf (§11 thin slice: 4 SKUs × 24 units). */
export interface ShelfSlot {
  skuId: string;
  units: number;
}

export const SHELF_SLOT_UNITS = 24;

export interface StoreState {
  grid: { cols: number; rows: number; expansions: number };
  furniture: PlacedFurniture[];
  nextFurnitureId: number;
  /** OTC shelf stock keyed by placed-furniture id (backroom arrives in 05). */
  shelfStock: Record<string, ShelfSlot[]>;
  /** Rx bin units per drug id (§11); decrements per fill, refilled via 05 orders. */
  rxStock: Record<string, number>;
}

/** One §15 reputation reason tallied for the receipt. */
export interface RepReason {
  count: number;
  delta: number;
}

/** End-of-day receipt counters (§26 rep deltas, §28 lines; reset each morning). */
export interface DayStats {
  visitors: number;
  /** OTC checkout transactions (register sales + Rx-pickup baskets). */
  otcSales: number;
  otcRevenue: number;
  /** Scripts handed over at pickup (errors included — counted separately too). */
  fills: number;
  copayRevenue: number;
  rxReimbursement: number;
  /** Copay + reimbursement reversals from dispensed errors (positive $). */
  refunds: number;
  walkouts: number;
  /** Dispensed errors discovered at pickup (§8). */
  errors: number;
  /** Scripts turned away at drop-off for missing stock (§15). */
  refusals: number;
  repDelta: number;
  /** Receipt "reputation delta with reasons" tallies, keyed by reason copy. */
  repReasons: Record<string, RepReason>;
}

export interface GameState {
  day: number;
  /** In-game minute of day; 480 = 08:00. Frozen outside the shift phase. */
  clockIgm: number;
  phase: DayPhase;
  cash: number;
  repStars: number;
  speed: GameSpeed;
  /** Build mode freezes sim ticks without touching speed (SPEC §5). */
  buildMode: boolean;
  licenses: string[];
  era: 1 | 2 | 3 | 4;
  store: StoreState;
  /** Register the player is personally working, or null (§8: workHere). */
  workingStationId: string | null;
  dayStats: DayStats;
}

/** Starting layout (SPEC §6): pre-placed and movable, not charged to cash. */
const STARTING_LAYOUT: [defId: string, cellX: number, cellY: number, rot: Rot][] = [
  ["rx_shelf", 2, 0, 0],
  ["fill_bench", 6, 0, 0],
  ["counter_service", 4, 2, 0],
  ["otc_shelf", 1, 4, 0],
  ["otc_shelf", 4, 4, 0],
  ["counter_register", 7, 4, 0],
  ["chair_waiting", 0, 2, 1],
  ["chair_waiting", 0, 3, 1],
  ["chair_waiting", 9, 2, 3],
  ["chair_waiting", 9, 3, 3],
];

/** §26 starter stock, OTC half: top sellers spread across the §25 categories,
 *  four SKUs per starting shelf at full slot depth. */
const STARTER_SHELF_SKUS: readonly (readonly string[])[] = [
  ["acetaminophen", "ibuprofen", "dextromethorphan", "bandages"],
  ["loratadine", "cetirizine", "famotidine", "multivitamin"],
];

/** §26 starter stock, Rx half: the Tier-1 spread, deeper on high-demand SKUs.
 *  Together with the OTC shelves this lands near the $1,500 starter budget. */
const STARTER_RX_UNITS: Record<1 | 2 | 3, number> = { 1: 2, 2: 4, 3: 10 };

export function starterRxStock(): Record<string, number> {
  const stock: Record<string, number> = {};
  for (const def of TIER1_DRUGS) stock[def.id] = STARTER_RX_UNITS[def.demandWeight];
  return stock;
}

export function emptyDayStats(): DayStats {
  return {
    visitors: 0,
    otcSales: 0,
    otcRevenue: 0,
    fills: 0,
    copayRevenue: 0,
    rxReimbursement: 0,
    refunds: 0,
    walkouts: 0,
    errors: 0,
    refusals: 0,
    repDelta: 0,
    repReasons: {},
  };
}

export function createGameState(): GameState {
  const furniture = STARTING_LAYOUT.map(([defId, cellX, cellY, rot], i) => ({
    id: `f${i + 1}`,
    defId,
    cellX,
    cellY,
    rot,
  }));

  const shelfStock: Record<string, ShelfSlot[]> = {};
  let shelfIndex = 0;
  for (const item of furniture) {
    if (item.defId !== "otc_shelf") continue;
    const skus = STARTER_SHELF_SKUS[shelfIndex++] ?? [];
    shelfStock[item.id] = skus.map((skuId) => ({ skuId, units: SHELF_SLOT_UNITS }));
  }

  return {
    day: 1,
    clockIgm: DAY_START_IGM,
    phase: "morning",
    cash: 12_000,
    repStars: 2.5,
    speed: 1,
    buildMode: false,
    licenses: ["L1"],
    era: 1,
    store: {
      grid: { cols: 10, rows: 7, expansions: 0 },
      furniture,
      nextFurnitureId: STARTING_LAYOUT.length + 1,
      shelfStock,
      rxStock: starterRxStock(),
    },
    workingStationId: null,
    dayStats: emptyDayStats(),
  };
}
