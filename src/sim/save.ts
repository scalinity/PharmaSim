// Versioned saves (SPEC §23, §24). This file is part of sim/, so it only ever
// makes and reads *plain objects* — no filesystem, no DOM, no platform/.
// `platform/storage.ts` does every byte of I/O.
//
// ===========================================================================
//  MIGRATION CONTRACT — READ THIS BEFORE YOU ADD A FIELD TO GameState
// ===========================================================================
//  A save on disk outlives the code that wrote it. So: every piece of
//  GameState that survives a day boundary must round-trip through
//  serialize() → hydrate(), and any milestone that extends GameState must, in
//  the same session:
//
//    1. add the field to SaveFile (below),
//    2. extend serialize() and hydrate() — the explicit object literals in
//       here are deliberate: a missing field is a compile error, not a
//       silently lost pharmacy,
//    3. bump SAVE_VERSION and push a step onto MIGRATIONS that fills the new
//       field with the value an *older* save should get.
//
//  Skip step 3 and every playtest save ever written stops loading. There is
//  no cloud, no second slot, and no backup: this chain is the only thing
//  standing between a schema change and someone's day-40 store.
//
//  Version 1 (milestone 06) carries the whole solo era:
//    · day, clockIgm, phase                                          (M01)
//    · store.grid, store.furniture, store.nextFurnitureId            (M02)
//    · repStars, era, licenses                                       (M03/04)
//    · cash, loans{bank,family}, the ledger-shaped dayStats          (M05)
//    · store.stock, shelfSlots, otcPricing, priceIndex, inbound,
//      salesToday, salesLog, fillRate7d, gross7d, reorderUnlocked,
//      reorderRules                                                  (M05)
//    · settings{volume,sfx,ambience,reducedMotion}                   (M06)
//
//  Version 2 (milestone 07) adds the staffed era:
//    · store.staff (roster, §9/§24) · hiring (weekly candidate pool + its
//      per-save seed)                                                 (M07)
//
//  Version 3 (milestone 08) adds progression:
//    · stats (§24 lifetime counters: license/expansion purchase days) (M08)
//    licenses, grid.expansions and placed cabinets already round-tripped in
//    v1/v2 shapes — the step only has to seed `stats` from what's owned.
//
//  Version 4 (milestone 09) adds the cold chain:
//    · dayStats.vaccinations (§14 receipt counter)                    (M09)
//    Fridge stock is ordinary store.stock lines and the fridge, station and
//    generator are ordinary store.furniture — all already round-tripping —
//    so the step only has to seed the new counter.
//
//  §24's fuller schema (worldSeed, stores[], competitors, patientPools, dc,
//  aitech, legacy, stats) is not here because those systems do not exist yet.
//  They arrive field-by-field with the milestones that own them —
//  08 licenses/expansion, 09 cold chain, 10 legacy, 12 city, 13 competitors,
//  14 branches, 15 logistics, 16 AI tech — each with its own migrate step.
//  Season is derived from `day` (§5), never stored.
// ===========================================================================

import type { HiringPool, StaffMember } from "./staff";
import {
  defaultSettings,
  type DayPhase,
  type DayStats,
  type GameSettings,
  type GameState,
  type StoreState,
} from "./state";

export const SAVE_VERSION = 4;

export interface SaveFile {
  version: number;
  day: number;
  clockIgm: number;
  phase: DayPhase;
  cash: number;
  loans: { bank: number; family: number };
  repStars: number;
  licenses: string[];
  era: 1 | 2 | 3 | 4;
  stats: Record<string, number>;
  store: StoreState;
  hiring: HiringPool;
  dayStats: DayStats;
  settings: GameSettings;
}

/** A save file as it comes off disk: parsed JSON, nothing checked yet. */
type RawSave = Record<string, unknown>;

/**
 * Stepwise migrations. `MIGRATIONS[n - 1]` upgrades a version-`n` file to
 * version `n + 1`; the chain runs until the file reaches SAVE_VERSION.
 */
const MIGRATIONS: readonly ((file: RawSave) => RawSave)[] = [
  // 1 → 2 (milestone 07): the solo era had no staff. The roster starts empty
  // and the hiring pool unrefreshed — the first morning after loading draws
  // the week's candidates. A file whose store isn't even an object passes
  // through untouched so validate() can refuse it with its own sentence.
  (file) => {
    const store = file.store;
    if (typeof store === "object" && store !== null && !Array.isArray(store)) {
      (store as RawSave).staff = [];
    }
    file.hiring = {
      seed: Math.floor(Math.random() * 0x7fffffff),
      refreshedOnDay: 0,
      candidates: [],
    } satisfies HiringPool;
    return file;
  },
  // 2 → 3 (milestone 08): progression saves nothing new beyond `stats` — a
  // pre-08 store owned its licenses without a record of when, so each one is
  // backdated to day 1 (L1 genuinely was). Grid size and any cabinet already
  // live in store.grid / store.furniture untouched.
  (file) => {
    const stats: Record<string, number> = {};
    if (Array.isArray(file.licenses)) {
      for (const id of file.licenses) {
        if (typeof id === "string") stats[`license.${id}`] = 1;
      }
    }
    file.stats = stats;
    return file;
  },
  // 3 → 4 (milestone 09): a pre-cold-chain day gave no shots, so the new
  // receipt counter seeds at zero. A file whose dayStats isn't an object
  // passes through untouched so validate() can refuse it with its own
  // sentence.
  (file) => {
    const stats = file.dayStats;
    if (typeof stats === "object" && stats !== null && !Array.isArray(stats)) {
      (stats as RawSave).vaccinations = 0;
    }
    return file;
  },
];

// --- Deep copies: a save must never alias live state, and a hydrated state
//     must never alias the file it came from. ---

function copyMap<T>(source: Record<string, T>, copy: (value: T) => T): Record<string, T> {
  const out: Record<string, T> = {};
  for (const key of Object.keys(source)) {
    // A parsed file can carry "__proto__" as an own key; assigning it here
    // would swap the copy's prototype instead of storing a value.
    if (key === "__proto__") continue;
    out[key] = copy(source[key]!);
  }
  return out;
}

function copyStore(store: StoreState): StoreState {
  return {
    grid: { ...store.grid },
    furniture: store.furniture.map((item) => ({ ...item })),
    nextFurnitureId: store.nextFurnitureId,
    stock: copyMap(store.stock, (line) => ({ ...line })),
    shelfSlots: copyMap(store.shelfSlots, (slots) => [...slots]),
    otcPricing: { ...store.otcPricing },
    priceIndex: store.priceIndex,
    inbound: store.inbound.map((line) => ({ ...line })),
    salesToday: { ...store.salesToday },
    salesLog: store.salesLog.map((day) => ({ ...day })),
    fillRate7d: [...store.fillRate7d],
    gross7d: [...store.gross7d],
    reorderUnlocked: store.reorderUnlocked,
    reorderRules: copyMap(store.reorderRules, (rule) => ({ ...rule })),
    staff: store.staff.map(copyStaffMember),
  };
}

function copyStaffMember(member: StaffMember): StaffMember {
  const copy: StaffMember = { ...member };
  if (member.assignment) copy.assignment = { ...member.assignment };
  return copy;
}

function copyHiring(hiring: HiringPool): HiringPool {
  return {
    seed: hiring.seed,
    refreshedOnDay: hiring.refreshedOnDay,
    candidates: hiring.candidates.map((candidate) => ({ ...candidate })),
  };
}

function copyDayStats(stats: DayStats): DayStats {
  return {
    cashOpen: stats.cashOpen,
    ledger: copyMap(stats.ledger, (tally) => ({ ...tally })),
    visitors: stats.visitors,
    otcSales: stats.otcSales,
    otcUnits: stats.otcUnits,
    fills: stats.fills,
    vaccinations: stats.vaccinations,
    walkouts: stats.walkouts,
    errors: stats.errors,
    refusals: stats.refusals,
    stockOuts: { ...stats.stockOuts },
    balks: { ...stats.balks },
    familyLoan: stats.familyLoan,
    repDelta: stats.repDelta,
    repReasons: copyMap(stats.repReasons, (reason) => ({ ...reason })),
  };
}

/**
 * Snapshot the run as a plain, detached SaveFile.
 *
 * Session-only state is deliberately left out: `speed`, `buildMode` and
 * `workingStationId` are controls the player is holding right now, not
 * progress, so a save always comes back at 1× with the sheets put away.
 * Saves are only ever taken at a day boundary (§23), where no customer or
 * script is in flight — that is why neither needs serializing.
 */
export function serialize(state: GameState): SaveFile {
  return {
    version: SAVE_VERSION,
    day: state.day,
    clockIgm: state.clockIgm,
    phase: state.phase,
    cash: state.cash,
    loans: { ...state.loans },
    repStars: state.repStars,
    licenses: [...state.licenses],
    era: state.era,
    stats: { ...state.stats },
    store: copyStore(state.store),
    hiring: copyHiring(state.hiring),
    dayStats: copyDayStats(state.dayStats),
    settings: { ...state.settings },
  };
}

/** Build a fresh GameState from a (migrated) save file. */
export function hydrate(file: SaveFile): GameState {
  return {
    day: file.day,
    clockIgm: file.clockIgm,
    phase: file.phase,
    cash: file.cash,
    loans: { ...file.loans },
    repStars: file.repStars,
    speed: 1,
    buildMode: false,
    licenses: [...file.licenses],
    era: file.era,
    stats: { ...file.stats },
    store: copyStore(file.store),
    hiring: copyHiring(file.hiring),
    workingStationId: null,
    dayStats: copyDayStats(file.dayStats),
    settings: { ...defaultSettings(), ...file.settings },
  };
}

// --- Validation: hand-edited and half-written files must be *refused*, with
//     a sentence the player can act on, rather than crashing the game. ---

function reject(missing: string): never {
  throw new Error(`That file isn't a PharmaSim save — it has no ${missing}.`);
}

function requireObject(value: unknown, name: string): RawSave {
  if (typeof value !== "object" || value === null || Array.isArray(value)) reject(name);
  return value as RawSave;
}

function requireArray(value: unknown, name: string): void {
  if (!Array.isArray(value)) reject(name);
}

const PHASES: readonly string[] = ["morning", "shift", "close"];

function validate(file: RawSave): SaveFile {
  for (const key of ["day", "clockIgm", "cash", "repStars", "era"]) {
    if (typeof file[key] !== "number") reject(key);
  }
  if (typeof file.phase !== "string" || !PHASES.includes(file.phase)) reject("day phase");
  requireArray(file.licenses, "licenses");
  requireObject(file.loans, "loan balances");
  requireObject(file.settings, "settings");
  const lifetime = requireObject(file.stats, "stats");
  // stats is the one free-form Record a hand editor is likely to touch;
  // a non-number value would render as "Issued · day yesterday".
  for (const value of Object.values(lifetime)) {
    if (typeof value !== "number") reject("readable stats");
  }

  const store = requireObject(file.store, "store");
  requireObject(store.grid, "store grid");
  for (const key of ["stock", "shelfSlots", "otcPricing", "salesToday", "reorderRules"]) {
    requireObject(store[key], `store ${key}`);
  }
  for (const key of ["furniture", "inbound", "salesLog", "fillRate7d", "gross7d", "staff"]) {
    requireArray(store[key], `store ${key}`);
  }

  const hiring = requireObject(file.hiring, "hiring pool");
  requireArray(hiring.candidates, "hiring candidates");

  const stats = requireObject(file.dayStats, "day totals");
  for (const key of ["ledger", "stockOuts", "balks", "repReasons"]) {
    requireObject(stats[key], `day ${key}`);
  }

  return file as unknown as SaveFile;
}

/**
 * Take anything that claims to be a save and return a SaveFile at the current
 * version, or throw with a message worth showing the player. Boot and import
 * both go through here — nothing reaches `hydrate` unmigrated.
 */
export function migrate(raw: unknown): SaveFile {
  const file = requireObject(raw, "save data");
  const version = file.version;
  if (typeof version !== "number" || !Number.isInteger(version) || version < 1) {
    throw new Error(
      `That file says save version ${String(version)}. PharmaSim saves start at version 1.`,
    );
  }
  if (version > SAVE_VERSION) {
    throw new Error(
      `That save is from a newer build (version ${version}). This one reads up to version ${SAVE_VERSION}.`,
    );
  }

  let current = file;
  for (let from = version; from < SAVE_VERSION; from++) {
    const step = MIGRATIONS[from - 1];
    if (!step) throw new Error(`No migration from save version ${from} — this save can't be read.`);
    current = step(current);
    current.version = from + 1;
  }
  return validate(current);
}
