// GameState root type + factory (SPEC §5, §6, §10, §11, §24, §26).

import { DAY_START_IGM } from "../core/clock";
import type { Rot } from "../core/grid";
import type { HiringPool, StaffMember } from "./staff";

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
  /** The roster (§9, §24). Wages post per member at close (§10). */
  staff: StaffMember[];
}

/** One achieved §22 legacy moment (§24): the id keys data/flavor.ts. */
export interface LegacyEntry {
  id: string;
  day: number;
}

/** One §16 regional shortage: an Rx category squeezed for a run of days
 *  (wholesale ×1.5, order fills capped — §26). Active on [startDay, endDay]. */
export interface ShortageEvent {
  category: string;
  startDay: number;
  /** Last squeezed day, inclusive. */
  endDay: number;
}

/** One §16 storm day and its outage window within the 08:00–20:00 shift. */
export interface StormEvent {
  day: number;
  outageStartIgm: number;
  outageEndIgm: number;
}

/** Today's outage, recorded the moment the power drops (§14, §16): what the
 *  cold chain lost — or that the generator held — for the receipt to read. */
export interface OutageRecord {
  day: number;
  hadGenerator: boolean;
  spoiledUnits: number;
  /** Ledger loss at wholesale value, 0 with a generator (§14). */
  spoiledValue: number;
  /** The power-restored edge has been announced. */
  ended: boolean;
}

/** §16 world-event state: the seeded schedule and what is active today.
 *  sim/events-world.ts owns the planning; seasons themselves derive from
 *  `day` (§5) and are never stored. */
export interface WorldEventsState {
  /** Per-save seed; every event roll derives from it, so a reloaded
   *  morning plans the same year. */
  seed: number;
  /** Absolute season index shortages are planned through (−1 = none yet). */
  plannedSeason: number;
  /** Absolute year index storms are planned through (−1 = none yet). */
  plannedYear: number;
  shortages: ShortageEvent[];
  storms: StormEvent[];
  outage: OutageRecord | null;
}

export function freshWorldEvents(): WorldEventsState {
  return {
    seed: Math.floor(Math.random() * 0x7fffffff),
    plannedSeason: -1,
    plannedYear: -1,
    shortages: [],
    storms: [],
    outage: null,
  };
}

/** One district's observed §17 script traffic: category id (or the OTC
 *  visits key, sim/city.ts) → [asked, served]. Only what actually walked
 *  through the door is recorded — the reports read knowledge, never the
 *  generator (§17 "learn your neighborhood"). */
export type DistrictTally = Record<string, [asked: number, served: number]>;

/** §17 city memory (M12): the store's routed-share history and what it has
 *  seen from each district. sim/city.ts owns every write. */
export interface CityState {
  /** Routed share of the whole city's demand, one entry per played day,
   *  most recent first (≤28 — the trend windows). */
  shareLog: number[];
  /** Today's observed traffic, keyed by district id. */
  today: Record<string, DistrictTally>;
  /** Prior days, most recent first (≤27 — with today, the 28-day window). */
  log: Record<string, DistrictTally>[];
}

export function freshCityState(): CityState {
  return { shareLog: [], today: {}, log: [] };
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
  /** Flu shots given at the vaccine station (§14). */
  vaccinations: number;
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

/** Player settings (§24). Persisted with the save; the volume levels are
 *  stored and shown but inert until audio arrives in milestone 17. */
export interface GameSettings {
  volume: number;
  sfx: number;
  ambience: number;
  reducedMotion: boolean;
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
  /** A renovation bought today (§13): the store is closed under scaffolding;
   *  the new era stands next morning. Null when no crew is in. */
  pendingEra: 2 | 3 | 4 | null;
  /** Achieved §22 moments, in the order they were lived. Each fires once. */
  legacy: LegacyEntry[];
  /** §16 world events: the seeded schedule and today's active effects. */
  events: WorldEventsState;
  /** §17 city memory: routed-share history + observed district demand (M12). */
  city: CityState;
  /** Lifetime counters and milestone days (§24) — `license.L3` → day bought,
   *  `era.2` → day the renovation was signed. */
  stats: Record<string, number>;
  store: StoreState;
  /** This week's job applications, redrawn Monday mornings (§9). */
  hiring: HiringPool;
  /** Register the player is personally working, or null (§8: workHere). */
  workingStationId: string | null;
  dayStats: DayStats;
  settings: GameSettings;
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

export function defaultSettings(): GameSettings {
  return { volume: 0.8, sfx: 0.8, ambience: 0.6, reducedMotion: false };
}

export function emptyDayStats(cashOpen: number): DayStats {
  return {
    cashOpen,
    ledger: {},
    visitors: 0,
    otcSales: 0,
    otcUnits: 0,
    fills: 0,
    vaccinations: 0,
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
    pendingEra: null,
    legacy: [],
    events: freshWorldEvents(),
    city: freshCityState(),
    stats: { "license.L1": 1 },
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
      staff: [],
    },
    hiring: {
      seed: Math.floor(Math.random() * 0x7fffffff),
      refreshedOnDay: 0,
      candidates: [],
    },
    workingStationId: null,
    dayStats: emptyDayStats(cash),
    settings: defaultSettings(),
  };
}
