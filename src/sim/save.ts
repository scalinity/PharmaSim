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
//  Version 5 (milestone 10) adds modernization + legacy:
//    · legacy (§22/§24 achieved moments — the album and the once-only
//      firing both live on this list) · pendingEra (§13: a renovation
//      bought at the close phase must still stand next morning)       (M10)
//    `era` itself has round-tripped since v1, and the robotic dispenser is
//    ordinary store.furniture — the step seeds the empty album and no crew.
//
//  Version 6 (milestone 11) adds the world's weather:
//    · events (§16/§24: the per-save event seed, planning watermarks,
//      scheduled shortages and storms, and today's outage record)      (M11)
//    Season itself is still derived from `day` (§5), never stored — only
//    the scheduled events and their seed persist.
//
//  Version 7 (milestone 12) adds the city:
//    · city (§17: the routed-share history and the per-district
//      observed-demand memory the reports and district cards read)     (M12)
//    District data itself is content (data/districts.ts), never state —
//    only what the store has *seen* persists, and a pre-city save has seen
//    nothing: the step seeds an empty memory that fills from play.
//
//  §24's fuller schema (worldSeed, stores[], competitors, patientPools, dc,
//  aitech, stats) is not here because those systems do not exist yet.
//  They arrive field-by-field with the milestones that own them —
//  13 competitors, 14 branches, 15 logistics, 16 AI tech — each with its
//  own migrate step.
// ===========================================================================

import { DAY_END_IGM, DAY_START_IGM } from "../core/clock";
import { isLegacyMoment } from "../data/flavor";
import type { HiringPool, StaffMember } from "./staff";
import {
  defaultSettings,
  freshCityState,
  freshWorldEvents,
  type CityState,
  type DayPhase,
  type DayStats,
  type DistrictTally,
  type GameSettings,
  type GameState,
  type LegacyEntry,
  type StoreState,
  type WorldEventsState,
} from "./state";

export const SAVE_VERSION = 7;

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
  pendingEra: 2 | 3 | 4 | null;
  legacy: LegacyEntry[];
  events: WorldEventsState;
  city: CityState;
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
  // 4 → 5 (milestone 10): a pre-renovation store stands in whatever era it
  // already recorded (Gen 1, in practice) with no crew in and nothing lived
  // yet worth an album page — moments start firing from here on.
  (file) => {
    file.legacy = [];
    file.pendingEra = null;
    return file;
  },
  // 5 → 6 (milestone 11): the world gets weather. A pre-events save has no
  // schedule; a fresh seed plans from the season the store wakes up in, and
  // events the save "slept through" are simply never planned.
  (file) => {
    file.events = freshWorldEvents();
    return file;
  },
  // 6 → 7 (milestone 12): the city map + living demand. A pre-city save
  // routed everything from the hard-wired Old Town profile and *observed*
  // nothing, so the neighborhood memory starts empty and fills in from the
  // next played day — knowledge builds by playing, never retroactively (§17).
  (file) => {
    file.city = freshCityState();
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

function copyEvents(events: WorldEventsState): WorldEventsState {
  return {
    seed: events.seed,
    plannedSeason: events.plannedSeason,
    plannedYear: events.plannedYear,
    shortages: events.shortages.map((s) => ({ ...s })),
    storms: events.storms.map((s) => ({ ...s })),
    outage: events.outage === null ? null : { ...events.outage },
  };
}

function copyTallies(day: Record<string, DistrictTally>): Record<string, DistrictTally> {
  return copyMap(day, (tally) => copyMap(tally, (line) => [line[0], line[1]] as [number, number]));
}

function copyCity(city: CityState): CityState {
  return {
    shareLog: [...city.shareLog],
    today: copyTallies(city.today),
    log: city.log.map(copyTallies),
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
    pendingEra: state.pendingEra,
    legacy: state.legacy.map((moment) => ({ ...moment })),
    events: copyEvents(state.events),
    city: copyCity(state.city),
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
    pendingEra: file.pendingEra,
    legacy: file.legacy.map((moment) => ({ ...moment })),
    events: copyEvents(file.events),
    city: copyCity(file.city),
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
  // Finiteness matters as much as the type: JSON.parse happily yields
  // Infinity from "1e999", and NaN survives every typeof check.
  for (const key of ["day", "clockIgm", "cash", "repStars", "era"]) {
    if (typeof file[key] !== "number" || !Number.isFinite(file[key] as number)) reject(key);
  }
  // `day` drives seasonForDay, which indexes the §16 multiplier tables, and
  // the event planner's season/year math — a zero, negative or fractional
  // day would throw at the first Open store instead of being refused here.
  if (!Number.isInteger(file.day) || (file.day as number) < 1) reject("readable day number");
  if (typeof file.phase !== "string" || !PHASES.includes(file.phase)) reject("day phase");
  requireArray(file.licenses, "licenses");
  requireObject(file.loans, "loan balances");
  requireObject(file.settings, "settings");
  // era indexes the render layer's palette table and §13's tier table, and
  // both throw on a miss — a hand-edited generation outside 1–4 would crash
  // the boot before the title screen could offer a way out.
  if (![1, 2, 3, 4].includes(file.era as number)) reject("store generation");
  // §13 only ever renovates one tier up: any other pending value would
  // reskin nothing, or downgrade the store at the next morning.
  if (file.pendingEra !== null && file.pendingEra !== (file.era as number) + 1) {
    reject("renovation state");
  }
  requireArray(file.legacy, "legacy moments");
  for (const moment of file.legacy as unknown[]) {
    if (
      typeof moment !== "object" ||
      moment === null ||
      typeof (moment as RawSave).id !== "string" ||
      typeof (moment as RawSave).day !== "number" ||
      // The album and the receipt both look the id up in data/flavor.ts,
      // and that lookup throws — an unknown id must not get past here.
      !isLegacyMoment((moment as RawSave).id as string)
    ) {
      reject("readable legacy moments");
    }
  }
  // §16 world events: the schedule drives daily pricing, fill caps and the
  // outage clock, so a hand-edited NaN or inverted window must be refused
  // here — hydrated, it would make a shortage that never ends or an outage
  // that never fires, silently and forever.
  const events = requireObject(file.events, "world events");
  for (const key of ["seed", "plannedSeason", "plannedYear"]) {
    if (typeof events[key] !== "number" || !Number.isFinite(events[key] as number)) {
      reject(`event ${key}`);
    }
  }
  requireArray(events.shortages, "shortages");
  // A schedule larger than the planner could ever write is a corrupt file —
  // and the Orders panel walks these arrays per row, so refuse, don't crawl.
  if ((events.shortages as unknown[]).length > 16) reject("a sane shortage schedule");
  for (const entry of events.shortages as unknown[]) {
    const s = entry as RawSave;
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof s.category !== "string" ||
      !Number.isInteger(s.startDay) ||
      !Number.isInteger(s.endDay) ||
      (s.endDay as number) < (s.startDay as number)
    ) {
      reject("readable shortages");
    }
  }
  requireArray(events.storms, "storms");
  if ((events.storms as unknown[]).length > 16) reject("a sane storm schedule");
  for (const entry of events.storms as unknown[]) {
    const s = entry as RawSave;
    if (
      typeof entry !== "object" ||
      entry === null ||
      !Number.isInteger(s.day) ||
      // NaN slides through range comparisons (every one is false), so the
      // finiteness check is what actually guards the window bounds below.
      !Number.isFinite(s.outageStartIgm) ||
      !Number.isFinite(s.outageEndIgm) ||
      // The window must sit inside the 08:00–20:00 shift the outage clock
      // reads against — outside it, the power would drop at open or the
      // restored edge would never fire until the close's failsafe.
      (s.outageStartIgm as number) < DAY_START_IGM ||
      (s.outageEndIgm as number) > DAY_END_IGM ||
      (s.outageEndIgm as number) <= (s.outageStartIgm as number)
    ) {
      reject("readable storms");
    }
  }
  if (events.outage !== null) {
    const outage = requireObject(events.outage, "outage record");
    for (const key of ["day", "spoiledUnits", "spoiledValue"]) {
      if (typeof outage[key] !== "number" || !Number.isFinite(outage[key] as number)) {
        reject(`outage ${key}`);
      }
    }
    if (typeof outage.hadGenerator !== "boolean" || typeof outage.ended !== "boolean") {
      reject("outage flags");
    }
  }

  // §17 city memory (M12): the share log and observed windows are loop
  // bounds for the reports panel and the trend math, and NaN slides through
  // every range comparison — finiteness first, then bounds.
  const city = requireObject(file.city, "city memory");
  requireArray(city.shareLog, "share history");
  if ((city.shareLog as unknown[]).length > 28) reject("a sane share history");
  for (const value of city.shareLog as unknown[]) {
    if (typeof value !== "number" || !Number.isFinite(value)) reject("readable share history");
  }
  requireArray(city.log, "observed demand");
  if ((city.log as unknown[]).length > 27) reject("a sane observed-demand window");
  for (const day of [city.today, ...(city.log as unknown[])]) {
    const record = requireObject(day, "observed demand");
    for (const tally of Object.values(record)) {
      const lines = requireObject(tally, "district tallies");
      for (const line of Object.values(lines)) {
        if (
          !Array.isArray(line) ||
          line.length !== 2 ||
          typeof line[0] !== "number" ||
          !Number.isFinite(line[0]) ||
          typeof line[1] !== "number" ||
          !Number.isFinite(line[1])
        ) {
          reject("readable district tallies");
        }
      }
    }
  }

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
  // Both feed §17 routing (M12): a NaN here would flow through the share
  // math into the validated share history — the *next* save would then be
  // refused for a corruption written two boots earlier. Refuse it at the
  // door instead, while the message can still name the real culprit.
  if (typeof store.priceIndex !== "number" || !Number.isFinite(store.priceIndex)) {
    reject("a readable price index");
  }
  for (const value of store.fillRate7d as unknown[]) {
    if (typeof value !== "number" || !Number.isFinite(value)) reject("a readable fill rate");
  }

  const hiring = requireObject(file.hiring, "hiring pool");
  requireArray(hiring.candidates, "hiring candidates");

  const stats = requireObject(file.dayStats, "day totals");
  for (const key of ["ledger", "stockOuts", "balks", "repReasons"]) {
    requireObject(stats[key], `day ${key}`);
  }
  // The scalar counters too: a hand-edited or truncated field would
  // otherwise hydrate as undefined, go NaN on its first increment, and be
  // dropped from every later save by JSON.stringify — silent, permanent
  // loss of the counter with no error anywhere.
  for (const key of [
    "cashOpen",
    "visitors",
    "otcSales",
    "otcUnits",
    "fills",
    "vaccinations",
    "walkouts",
    "errors",
    "refusals",
    "familyLoan",
    "repDelta",
  ]) {
    if (typeof stats[key] !== "number") reject(`day ${key}`);
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
