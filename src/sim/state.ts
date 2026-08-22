// GameState root type + factory (SPEC §5, §6, §10, §11, §24, §26).

import { DAY_START_IGM } from "../core/clock";
import type { Rot } from "../core/grid";

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

/** Per-SKU stock (§11): backroom units plus units out front — shelved on an
 *  OTC shelf, or in the Rx shelf's bins. */
export interface StockLine {
  backroom: number;
  shelved: number;
}

/** One line of a wholesale order (§11) or of tomorrow's delivery. */
export interface OrderLine {
  skuId: string;
  units: number;
}

/** Optional per-SKU reorder rule (§11); unlocked by the first stock-out. */
export interface ReorderRule {
  min: number;
  target: number;
}

export interface StoreState {
  grid: { cols: number; rows: number; expansions: number };
  furniture: PlacedFurniture[];
  nextFurnitureId: number;
  /** Stock per SKU id — Rx drugs and OTC alike (§24). */
  stock: Record<string, StockLine>;
  /** OTC SKU ids labelling each OTC shelf's 4 slots, keyed by furniture id.
   *  A SKU lives on at most one shelf, so `stock[sku].shelved` is unambiguous. */
  shelfSlots: Record<string, string[]>;
  /** Player price multiplier per OTC SKU, 0.8–1.5 of MSRP (§10). */
  otcPricing: Record<string, number>;
  /** Average shelved multiplier — §17 priceScore; recorded, unused until M12. */
  priceIndex: number;
  /** Ordered goods landing in the backroom next morning (§11). */
  inbound: OrderLine[];
  /** Units sold per SKU today. */
  salesToday: Record<string, number>;
  /** The six completed days before today, most recent first (§11 7-day sales). */
  salesLog: Record<string, number>[];
  /** Trailing fill rate, most recent first — §17 availability. */
  fillRate7d: number[];
  /** Trailing daily gross revenue, most recent first (bank credit line, §10). */
  gross7d: number[];
  /** Reorder rules stay hidden until the first stock-out (§11 teach-by-need). */
  reorderUnlocked: boolean;
  reorderRules: Record<string, ReorderRule>;
}

/** One §15 reputation reason tallied for the receipt. */
export interface RepReason {
  count: number;
  delta: number;
}

/** One grouped ledger reason for the day (§10): every cash movement lands here. */
export interface LedgerTally {
  count: number;
  /** Signed dollars: credits positive, costs negative. */
  amount: number;
}

/** End-of-day receipt counters (§10 ledger, §26 rep deltas; reset each morning). */
export interface DayStats {
  /** Cash at this morning's open — the receipt reconciles against it. */
  cashOpen: number;
  /** Every cash movement of the day, keyed by ledger reason (§10). */
  ledger: Record<string, LedgerTally>;
  visitors: number;
  /** OTC checkout transactions (register sales + Rx-pickup baskets). */
  otcSales: number;
  /** OTC units sold (feeds the §17 fill rate). */
  otcUnits: number;
  /** Scripts handed over at pickup (errors included — counted separately too). */
  fills: number;
  walkouts: number;
  /** Dispensed errors discovered at pickup (§8). */
  errors: number;
  /** Scripts turned away at drop-off for missing stock (§15). */
  refusals: number;
  /** Sales lost to an empty shelf label or bin, per SKU (§11). */
  stockOuts: Record<string, number>;
  /** Items a shopper put back over price, per SKU (§10 balk rules). */
  balks: Record<string, number>;
  /** Family loan drawn at close today, or 0 (§10 soft floor). */
  familyLoan: number;
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
  /** Outstanding loan balances (§10): bank credit line and Aunt Rosa. */
  loans: { bank: number; family: number };
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

/**
 * §26 starter stock — exactly $1,500 at wholesale, the way a founder actually
 * opens: eight OTC top sellers with 20 of each label's 24 slot units out front
 * ($869.00 at 55% of MSRP), and the Tier-1 spread deeper on the daily chronic
 * meds, thin on the $12 inhaler ($631.00). Everything starts out front; the
 * backroom fills up from the first wholesale order.
 */
const STARTER_SHELVES: readonly (readonly string[])[] = [
  ["acetaminophen", "ibuprofen", "dextromethorphan", "bandages"],
  ["loratadine", "cetirizine", "famotidine", "multivitamin"],
];
const STARTER_OTC_UNITS = 20;
const STARTER_RX: readonly (readonly [string, number])[] = [
  ["lisinopril10", 20],
  ["amlodipine5", 20],
  ["metformin500", 20],
  ["levothyroxine50", 20],
  ["omeprazole20", 20],
  ["metoprolol50", 18],
  ["atorvastatin20", 18],
  ["amoxicillin500", 17],
  ["hctz25", 12],
  ["prednisone10", 12],
  ["losartan50", 12],
  ["glipizide5", 12],
  ["montelukast10", 12],
  ["cephalexin500", 10],
  ["azithromycin250", 8],
  ["albuterolHFA", 3],
];

export function emptyDayStats(cashOpen: number): DayStats {
  return {
    cashOpen,
    ledger: {},
    visitors: 0,
    otcSales: 0,
    otcUnits: 0,
    fills: 0,
    walkouts: 0,
    errors: 0,
    refusals: 0,
    stockOuts: {},
    balks: {},
    familyLoan: 0,
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

  const stock: Record<string, StockLine> = {};
  const shelfSlots: Record<string, string[]> = {};
  let shelfIndex = 0;
  for (const item of furniture) {
    if (item.defId !== "otc_shelf") continue;
    const skus = [...(STARTER_SHELVES[shelfIndex++] ?? [])];
    shelfSlots[item.id] = skus;
    for (const skuId of skus) stock[skuId] = { backroom: 0, shelved: STARTER_OTC_UNITS };
  }
  for (const [skuId, units] of STARTER_RX) stock[skuId] = { backroom: 0, shelved: units };

  const cash = 12_000;
  return {
    day: 1,
    clockIgm: DAY_START_IGM,
    phase: "morning",
    cash,
    loans: { bank: 0, family: 0 },
    repStars: 2.5,
    speed: 1,
    buildMode: false,
    licenses: ["L1"],
    era: 1,
    store: {
      grid: { cols: 10, rows: 7, expansions: 0 },
      furniture,
      nextFurnitureId: STARTING_LAYOUT.length + 1,
      stock,
      shelfSlots,
      otcPricing: {},
      priceIndex: 1,
      inbound: [],
      salesToday: {},
      salesLog: [],
      fillRate7d: [],
      gross7d: [],
      reorderUnlocked: false,
      reorderRules: {},
    },
    workingStationId: null,
    dayStats: emptyDayStats(cash),
  };
}
