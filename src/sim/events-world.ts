// World events (SPEC §16, §26): the day-boundary scheduler that gives the
// calendar teeth — seasons reshape demand, regional shortages squeeze one Rx
// category at a time, storm days threaten the cold chain with a power outage
// — plus the active-effect readers that demand generation, ordering and the
// render layer's lighting consume. Every roll comes off the save's own seed,
// so a reloaded morning plans the same year. Pure sim — no DOM, no three.js.

import { DAY_END_IGM, DAYS_PER_SEASON, seasonForDay, type Season } from "../core/clock";
import { DRUG_DEFS } from "../data/drugs";
import { isRefrigerated } from "./coldchain";
import { categoryLabel, listWholesale, post, round2 } from "./economy";
import type { SimEvent } from "./events";
import type { GameState, StormEvent } from "./state";

type Emit = (event: SimEvent) => void;

const DAYS_PER_YEAR = DAYS_PER_SEASON * 4; // §5: 56-day year

// --- §26 season multipliers ---

const RX_SEASON_MULT: Record<Season, Readonly<Record<string, number>>> = {
  Spring: { respiratory: 1.3 },
  Summer: {},
  Fall: { antibiotics: 1.4, pediatric: 1.4 },
  Winter: { respiratory: 1.8, antibiotics: 1.8 },
};

// Summer's "more OTC first-aid" flavor (§16) carries no §26 number, so it
// stays out of the table — the summer lull is the visitor multiplier alone.
const OTC_SEASON_MULT: Record<Season, Readonly<Record<string, number>>> = {
  Spring: { allergy: 2.5 },
  Summer: {},
  Fall: {},
  Winter: { coldflu: 3 },
};

const VISITOR_SEASON_MULT: Record<Season, number> = {
  Spring: 1,
  Summer: 0.9,
  Fall: 1,
  Winter: 1.2,
};

const STORM_VISITOR_MULT = 0.6; // §26: visitors ×0.6 on a storm day
const FLU_VACCINE_MULT = 4; // §26: flu-season walk-ins ×4

/** Season's pull on one Rx category's script generation (§16, §26). */
export function rxDemandMult(state: GameState, category: string): number {
  return RX_SEASON_MULT[seasonForDay(state.day)][category] ?? 1;
}

/** Season's pull on one OTC category's shelf picks (§16, §26). */
export function otcDemandMult(state: GameState, category: string): number {
  return OTC_SEASON_MULT[seasonForDay(state.day)][category] ?? 1;
}

/** What today does to the whole visitor schedule: the season's lull or
 *  crowd, and a storm day's thin floor — both, on a winter storm. */
export function visitorMult(state: GameState): number {
  let mult = VISITOR_SEASON_MULT[seasonForDay(state.day)];
  if (stormToday(state)) mult *= STORM_VISITOR_MULT;
  return mult;
}

/** §14/§26: vaccine walk-ins quadruple through flu season. */
export function vaccineWalkinMult(state: GameState): number {
  return seasonForDay(state.day) === "Winter" ? FLU_VACCINE_MULT : 1;
}

/** §18/§26: is any regional shortage squeezing the city today? The rivals
 *  buy from the same squeezed wholesalers, so any active shortage puts the
 *  −0.15 on every rival's availability — sim/city.ts reads this for their
 *  §17 routing while the player's own availability drops the honest way,
 *  through capped orders and a falling fill rate. */
export function anyShortageActive(state: GameState): boolean {
  return state.events.shortages.some(
    (s) => state.day >= s.startDay && state.day <= s.endDay,
  );
}

// --- Storm-day readers ---

export function stormToday(state: GameState): boolean {
  return state.events.storms.some((s) => s.day === state.day);
}

/** The §16 forecast: known the evening before, printed on that receipt. */
export function stormTomorrow(state: GameState): boolean {
  return state.events.storms.some((s) => s.day === state.day + 1);
}

/** True while the power is down right now (§16): today's outage has begun
 *  and its restored edge hasn't been announced yet. */
export function outageActive(state: GameState): boolean {
  const record = state.events.outage;
  return record !== null && record.day === state.day && !record.ended;
}

// --- Planning (seeded, deterministic per save) ---

/** mulberry32 — the standard tiny PRNG; one stream per (seed, purpose). */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rx categories a shortage can squeeze: every scripted category in the
 *  §25 catalog. The vaccine dose is §14 service stock, not script demand,
 *  so its category sits this out. */
const SHORTAGE_CATEGORIES: readonly string[] = [
  ...new Set(DRUG_DEFS.filter((def) => def.category !== "vaccines").map((def) => def.category)),
];

const SHORTAGE_MIN_DAYS = 4; // §26: 4–8 days
const SHORTAGE_SPAN_DAYS = 5;
const OUTAGE_MIN_IGM = 120; // §26: outage 2–5 igh
const OUTAGE_SPAN_IGM = 181;
const OUTAGE_EARLIEST_IGM = 540; // windows sit inside the shift: 09:00 on

/** One §26 outage window off whichever randomness the caller owes — the
 *  seeded year plan and the dev console must roll identical shapes. */
function rollOutageWindow(rand: () => number): { outageStartIgm: number; outageEndIgm: number } {
  const duration = OUTAGE_MIN_IGM + Math.floor(rand() * OUTAGE_SPAN_IGM);
  const outageStartIgm =
    OUTAGE_EARLIEST_IGM + Math.floor(rand() * (DAY_END_IGM - duration - OUTAGE_EARLIEST_IGM + 1));
  return { outageStartIgm, outageEndIgm: outageStartIgm + duration };
}

/** §16: 1–2 shortages this season, 4–8 days each, one category apiece.
 *  Each squeeze is clamped inside its window — two split the fortnight and
 *  genuinely never stack, and none spills into the next season's plans. A
 *  save migrated mid-season keeps a squeeze it is inside of, never a
 *  finished one. */
function planSeasonShortages(state: GameState, seasonIdx: number): void {
  const rng = mulberry32(state.events.seed ^ (Math.imul(seasonIdx + 1, 0x9e3779b1) | 1));
  const count = rng() < 0.5 ? 1 : 2;
  const first = seasonIdx * DAYS_PER_SEASON + 1;
  const half = DAYS_PER_SEASON / 2;
  let lastPick = -1;
  for (let i = 0; i < count; i++) {
    const windowStart = count === 2 && i === 1 ? first + half : first;
    const windowLen = count === 2 ? half : DAYS_PER_SEASON;
    // Split seasons cap a squeeze at their 7-day half; an 8-day roll would
    // otherwise share a day with its sibling or outlive the season.
    const duration = Math.min(SHORTAGE_MIN_DAYS + Math.floor(rng() * SHORTAGE_SPAN_DAYS), windowLen);
    const startDay = windowStart + Math.floor(rng() * Math.max(1, windowLen - duration + 1));
    let pick = Math.floor(rng() * SHORTAGE_CATEGORIES.length);
    if (pick === lastPick) pick = (pick + 1) % SHORTAGE_CATEGORIES.length;
    lastPick = pick;
    if (startDay + duration - 1 < state.day) continue;
    state.events.shortages.push({
      category: SHORTAGE_CATEGORIES[pick]!,
      startDay,
      endDay: startDay + duration - 1,
    });
  }
}

/** §16: 1–2 storms this year, each with a 2–5 igh outage window. Never the
 *  year's first day — the forecast prints on the previous evening's receipt
 *  — and a save migrated mid-year skips storms it was never warned about. */
function planYearStorms(state: GameState, yearIdx: number): void {
  const rng = mulberry32(state.events.seed ^ (Math.imul(yearIdx + 1, 0x85ebca6b) | 1));
  const count = rng() < 0.5 ? 1 : 2;
  const first = yearIdx * DAYS_PER_YEAR + 1;
  const days = new Set<number>();
  // Bounded sampling: 55 candidate days dwarf a count of 2, so a few draws
  // always land distinct — the cap only exists so no state, however corrupt
  // (a day large enough that every draw collapses onto one float), can turn
  // planning into a hang. Normal runs consume the same draws either way.
  for (let tries = 0; days.size < count && tries < count * 8; tries++) {
    days.add(first + 1 + Math.floor(rng() * (DAYS_PER_YEAR - 1)));
  }
  for (const day of [...days].sort((a, b) => a - b)) {
    const window = rollOutageWindow(rng);
    if (day <= state.day) continue;
    state.events.storms.push({ day, ...window });
  }
}

/** Plan whatever the calendar has reached: the current season's shortages
 *  and the current year's storms, once each. Safe to call anywhere — Sim's
 *  constructor covers fresh runs and just-migrated saves, mornings cover
 *  every season and year turn after that. */
export function ensurePlanned(state: GameState): void {
  const ev = state.events;
  const seasonIdx = Math.floor((state.day - 1) / DAYS_PER_SEASON);
  const yearIdx = Math.floor((state.day - 1) / DAYS_PER_YEAR);
  if (yearIdx > ev.plannedYear) {
    planYearStorms(state, yearIdx);
    ev.plannedYear = yearIdx;
  }
  if (seasonIdx > ev.plannedSeason) {
    planSeasonShortages(state, seasonIdx);
    ev.plannedSeason = seasonIdx;
  }
}

/**
 * The morning turnover (§16), run by the day.advance command before its
 * phase change goes out (so the autosave captures the planned morning):
 * prune yesterday's weather, announce shortage edges, plan any season or
 * year the calendar just entered, and announce a season turn.
 */
export function advanceWorld(state: GameState, emit: Emit): void {
  const ev = state.events;
  const yesterday = state.day - 1;
  ev.storms = ev.storms.filter((s) => s.day >= state.day);
  if (ev.outage !== null && ev.outage.day < state.day) ev.outage = null;
  for (const s of ev.shortages) {
    if (s.endDay === yesterday) {
      emit({ type: "shortage.ended", category: s.category, day: state.day });
    }
  }
  // A spent shortage keeps its entry one extra day: the ticker's "eases"
  // headline reads it on endDay + 1, then the next morning drops it.
  ev.shortages = ev.shortages.filter((s) => state.day <= s.endDay + 1);
  ensurePlanned(state);
  if (state.day > 1 && seasonForDay(state.day) !== seasonForDay(yesterday)) {
    emit({ type: "season.changed", season: seasonForDay(state.day), day: state.day });
  }
  for (const s of ev.shortages) {
    if (s.startDay === state.day) {
      emit({ type: "shortage.started", category: s.category, day: state.day, endDay: s.endDay });
    }
  }
}

// --- The outage itself (§14, §16) ---

/** §14: the moment power drops, an unprotected cold chain is lost — every
 *  refrigerated unit, binned or boxed, at wholesale value on the ledger.
 *  Tomorrow's van is still on the road, so inbound stock survives.
 *
 *  The post is deliberately a real cash movement on top of the stock
 *  already paid for at order time: the §10 ledger is single-channel cash
 *  (every receipt line moves the till, and `cashOpen + net = cash` must
 *  hold), and the doubled sting is exactly the §14 insurance bite the
 *  generator exists to buy off. Valued at list wholesale — "wholesale
 *  value" per §14 — not today's discounted or shortage-inflated price. */
function beginOutage(state: GameState, emit: Emit): void {
  const generator = state.store.furniture.some((f) => f.defId === "generator_backup");
  let units = 0;
  let value = 0;
  if (!generator) {
    for (const skuId of Object.keys(state.store.stock)) {
      if (!isRefrigerated(skuId)) continue;
      const line = state.store.stock[skuId]!;
      const held = line.backroom + line.shelved;
      if (held <= 0) continue;
      units += held;
      value += listWholesale(skuId) * held;
      line.backroom = 0;
      line.shelved = 0;
    }
    value = round2(value);
  }
  state.events.outage = {
    day: state.day,
    hadGenerator: generator,
    spoiledUnits: units,
    spoiledValue: value,
    ended: false,
  };
  if (units > 0) {
    post(state, "spoilage", -value, emit);
    emit({ type: "coldchain.spoiled", units, value });
  }
  emit({ type: "outage.changed", on: true, generator });
}

/** Per-tick outage edges on a storm day: the drop (spoilage or the
 *  generator's hum) when the clock crosses the window's start, the restored
 *  announcement when it crosses the end. Both edges are driven purely off
 *  persisted state, so there is nothing mid-flight for a save to lose. */
export function tickWorld(state: GameState, emit: Emit): void {
  // Indexed scan, no closure: this runs on the 10 Hz sim path (§30), and
  // the schedule holds at most a couple of upcoming storms.
  const storms = state.events.storms;
  let storm: StormEvent | null = null;
  for (let i = 0; i < storms.length; i++) {
    if (storms[i]!.day === state.day) {
      storm = storms[i]!;
      break;
    }
  }
  if (!storm) return;
  const record = state.events.outage;
  const active = state.clockIgm >= storm.outageStartIgm && state.clockIgm < storm.outageEndIgm;
  if (active && (record === null || record.day !== state.day)) {
    beginOutage(state, emit);
  } else if (
    !active &&
    record !== null &&
    record.day === state.day &&
    !record.ended &&
    state.clockIgm >= storm.outageEndIgm
  ) {
    record.ended = true;
    emit({ type: "outage.changed", on: false, generator: record.hadGenerator });
  }
}

/** The day is closing (§5 — or §13's early renovation close, mid-outage):
 *  a still-running outage ends with the shift so the lights come back. */
export function endOutageAtClose(state: GameState, emit: Emit): void {
  const record = state.events.outage;
  if (record !== null && record.day === state.day && !record.ended) {
    record.ended = true;
    emit({ type: "outage.changed", on: false, generator: record.hadGenerator });
  }
}

// --- Dev event console (milestone 11 task 7; keys in the README) ---

function categoryShortToday(state: GameState, category: string): boolean {
  return state.events.shortages.some(
    (s) => s.category === category && state.day >= s.startDay && state.day <= s.endDay,
  );
}

/** Dev: start a 4–8 day shortage today in a category not already squeezed.
 *  Returns the toast line. */
export function forceShortage(state: GameState, emit: Emit): string {
  const open = SHORTAGE_CATEGORIES.filter((c) => !categoryShortToday(state, c));
  if (open.length === 0) return "Every category is already short";
  const category = open[Math.floor(Math.random() * open.length)]!;
  const duration = SHORTAGE_MIN_DAYS + Math.floor(Math.random() * SHORTAGE_SPAN_DAYS);
  const endDay = state.day + duration - 1;
  state.events.shortages.push({ category, startDay: state.day, endDay });
  emit({ type: "shortage.started", category, day: state.day, endDay });
  // The same words the ticker and the Orders panel use (§28 copy voice).
  return `${categoryLabel(category)} shortage forced — ${duration} days`;
}

/** Dev: put a storm on tomorrow's calendar, so tonight's receipt carries
 *  the forecast and tomorrow's shift loses power. Returns the toast line. */
export function forceStorm(state: GameState): string {
  if (stormTomorrow(state)) return "A storm is already due tomorrow";
  state.events.storms.push({ day: state.day + 1, ...rollOutageWindow(Math.random) });
  state.events.storms.sort((a, b) => a.day - b.day);
  return "Storm scheduled for tomorrow — the forecast prints tonight";
}
