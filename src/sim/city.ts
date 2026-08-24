// The city and its living demand (SPEC §17, §26): per-district, per-category
// Rx generation off the §24 district table plus OTC visit intent, facility
// bonuses (the nursing home's chronic refills ride Mondays as one weekly
// batch), routing by attractiveness against the rest of the city, and the
// store's observed-demand memory — the "learn your neighborhood" knowledge
// the reports panel and district cards read. Pure sim — no DOM, no three.js.

import { DISTRICTS, districtById, type District, type RxCategory } from "../data/districts";
import { DRUG_DEFS, type DrugDef } from "../data/drugs";
import { hasFridge } from "./coldchain";
import { STORE_DISTRICT_ID } from "./economy";
import { anyShortageActive, rxDemandMult } from "./events-world";
import { canFillDrug } from "./licenses";
import type { CityState, CompetitorState, GameState } from "./state";

// --- §17 generation ---

/** Total §25 demand weight per category — the pool a category's daily
 *  scripts spread across, licensed or not. */
const CATEGORY_WEIGHT = {} as Record<RxCategory, number>;
for (const def of DRUG_DEFS) {
  CATEGORY_WEIGHT[def.category] = (CATEGORY_WEIGHT[def.category] ?? 0) + def.demandWeight;
}

const RX_CATEGORIES = Object.keys(CATEGORY_WEIGHT) as RxCategory[];

/** §17: the nursing home's chronic refills route as one weekly batch — the
 *  week's worth lands on Monday (day 1 is a Monday, §5) instead of
 *  trickling in daily like every other facility's bonus. */
function nursingBatchDay(day: number): boolean {
  return (day - 1) % 7 === 0;
}

/** One district's §17 daily script generation for one category:
 *  pop × prevalence, plus flat facility bonuses — the nursing home's
 *  arriving ×7 on batch day and not at all otherwise. */
function categoryScripts(district: District, category: RxCategory, day: number): number {
  let perDay = (district.population / 1000) * (district.prevalence[category] ?? 0);
  for (const facility of district.facilities) {
    const bonus = facility.bonus[category] ?? 0;
    if (bonus === 0) continue;
    if (facility.kind === "nursingHome") {
      if (nursingBatchDay(day)) perDay += bonus * 7;
    } else {
      perDay += bonus;
    }
  }
  return perDay;
}

// --- §17 routing: five pharmacies per district (M13) ---

const W_PROXIMITY = 0.35;
const W_REP = 0.3;
const W_PRICE = 0.15;
const W_AVAILABILITY = 0.2;

/** The player store's id wherever a pharmacy id is expected (§18 pool
 *  assignments, §17 share lists) — rivals use their data/competitors.ts ids. */
export const PLAYER_PHARMACY_ID = "player";

/** §18/§26: what a shortage does to every rival's availability. */
const SHORTAGE_RELIABILITY_HIT = 0.15;

/** §17 proximity: 1.0 in the pharmacy's own district, 0.5 next door, 0.2
 *  across town (adjacency from data/districts.ts). */
function proximity(districtId: string, homeDistrictId: string): number {
  if (districtId === homeDistrictId) return 1;
  return districtById(homeDistrictId).adjacent.includes(districtId) ? 0.5 : 0.2;
}

/** §17 priceScore = clamp(2 − priceIndex, 0..1): list pricing already
 *  scores full marks; only marking up past MSRP costs share. */
function priceScore(priceIndex: number): number {
  return Math.min(1, Math.max(0, 2 - priceIndex));
}

/** §17 availability: the trailing 7-day fill rate. A store with no record
 *  yet gets the benefit of the doubt. */
export function storeAvailability(state: GameState): number {
  const rates = state.store.fillRate7d;
  if (rates.length === 0) return 1;
  let sum = 0;
  for (const rate of rates) sum += rate;
  return sum / rates.length;
}

/** §18: a rival's availability is its stockReliability, wearing the −0.15
 *  while any regional shortage squeezes the market (§26). */
export function rivalAvailability(state: GameState, rival: CompetitorState): number {
  const hit = anyShortageActive(state) ? SHORTAGE_RELIABILITY_HIT : 0;
  return Math.max(0, rival.stockReliability - hit);
}

/** The §17 attractiveness score, one formula for every pharmacy in town —
 *  the player's stats and the rivals' §18 stat blocks feed the same math. */
function attractiveness(
  districtId: string,
  homeDistrictId: string,
  repStars: number,
  priceIndex: number,
  availability: number,
): number {
  return (
    W_PROXIMITY * proximity(districtId, homeDistrictId) +
    W_REP * (repStars / 5) +
    W_PRICE * priceScore(priceIndex) +
    W_AVAILABILITY * availability
  );
}

export interface PharmacyShare {
  /** PLAYER_PHARMACY_ID or a §18 rival id. */
  pharmacyId: string;
  attractiveness: number;
  /** A² / ΣA² — the district's shares sum to 1 across the five. */
  share: number;
}

export interface DistrictShares {
  player: PharmacyShare;
  /** The §18 rivals, in state order. */
  rivals: PharmacyShare[];
}

/**
 * §17 share in one district's eyes: every pharmacy's attractiveness, squared
 * against the field (squaring sharpens competition). The player's entry is
 * its own field — the routing engine reads it, and no consumer has to lean
 * on a position in a list. Reads live stats, so a rep move, a price cut or
 * a shortage's reliability hit shifts tomorrow's routing — this is also
 * what the district cards' share bars and the §18 pool transfers score
 * against.
 */
export function districtShares(state: GameState, districtId: string): DistrictShares {
  const player: PharmacyShare = {
    pharmacyId: PLAYER_PHARMACY_ID,
    attractiveness: attractiveness(
      districtId,
      STORE_DISTRICT_ID,
      state.repStars,
      state.store.priceIndex,
      storeAvailability(state),
    ),
    share: 0,
  };
  const rivals: PharmacyShare[] = state.competitors.map((rival) => ({
    pharmacyId: rival.id,
    attractiveness: attractiveness(
      districtId,
      rival.homeDistrictId,
      rival.repStars,
      rival.priceIndex,
      rivalAvailability(state, rival),
    ),
    share: 0,
  }));
  let total = player.attractiveness * player.attractiveness;
  for (const entry of rivals) total += entry.attractiveness * entry.attractiveness;
  if (total > 0) {
    player.share = (player.attractiveness * player.attractiveness) / total;
    for (const entry of rivals) {
      entry.share = (entry.attractiveness * entry.attractiveness) / total;
    }
  }
  return { player, rivals };
}

/**
 * §17 routes *market share*; these convert a share of demand into feet
 * through the door. A five-pharmacy market hands a fresh Old Town store
 * ≈21% of the city — honest share, but far more demand than the §26
 * 20-visitor baseline, because not every routed unit of demand is a
 * same-day visit: refills spread across the month, mail order, the
 * hospital's own counter. Each stream keeps its own capture because the
 * two convert differently (§26 mix): a prescription travels — about one
 * routed script in three reaches the counter — while convenience OTC is
 * bought wherever the buyer already stands, roughly one visit in eight.
 * Tuned so the §26 baseline survives the M13 engine swap: a fresh Old Town
 * store at 2.5★ (A = 0.85 at home / 0.675 next door / 0.57 across town,
 * shares ≈.28 / .19–.24 / .15–.19 against the four §18 rivals) routes
 * ≈13 OTC + ≈7 Rx visitors a day — 20/day on the §7 mix, no cliff.
 */
const CAPTURE_OTC = 0.125;
const CAPTURE_RX = 0.3;

// --- The day plan (consumed by sim/customers.ts) ---

export interface RxDemandSlice {
  districtId: string;
  category: RxCategory;
  /** Expected scripts routed to the store today (fractional). */
  count: number;
}

export interface OtcDemandSlice {
  districtId: string;
  count: number;
}

export interface CityDayPlan {
  otc: OtcDemandSlice[];
  rx: RxDemandSlice[];
  otcTotal: number;
  rxTotal: number;
}

/** §17 generation noise, per district × category — small, so one category's
 *  swing reads in the reports without whipsawing the whole day (§7's own
 *  dayNoise still moves the schedule as a whole). */
function genNoise(): number {
  return 0.9 + Math.random() * 0.2;
}

/**
 * Route today's city demand to the store (§17): every district generates Rx
 * scripts per category (pop × prevalence × seasonMult × noise, plus facility
 * bonuses) and OTC visit intent; the store takes its squared-attractiveness
 * share of each against the four §18 rivals, converted to visits by the
 * per-stream capture. Only categories the store could actually fill are
 * routed — unlicensed demand goes elsewhere, which is what makes a new
 * license grow the day (§12 × §17, milestone 08).
 *
 * Also writes today's shares onto the logs (noise-free, so the trend arrow
 * moves on rep, price and availability — not on a lucky Tuesday): the
 * city-wide routed share, and the per-district share the receipt's market
 * note compares against yesterday's (M13). One entry per *played* day: a
 * skipped or renovation morning never plans, so it records nothing.
 */
export function planCityDay(state: GameState): CityDayPlan {
  // The slice of each category's demand weight this store could fill today.
  const fillableWeight = {} as Record<RxCategory, number>;
  for (const def of DRUG_DEFS) {
    if (!canFillDrug(state, def)) continue;
    fillableWeight[def.category] = (fillableWeight[def.category] ?? 0) + def.demandWeight;
  }

  const otc: OtcDemandSlice[] = [];
  const rx: RxDemandSlice[] = [];
  let otcTotal = 0;
  let rxTotal = 0;
  // Share-log accounting: what the store captures of the *whole* city's
  // demand, licensed or not — a new license honestly raises the share.
  let captured = 0;
  let cityDemand = 0;
  const sharesToday: Record<string, number> = {};

  for (const district of DISTRICTS) {
    const playerShare = districtShares(state, district.id).player.share;
    sharesToday[district.id] = playerShare;

    const intent = (district.population / 1000) * district.otcIntent;
    const otcCount = intent * playerShare * CAPTURE_OTC * genNoise();
    if (otcCount > 0) {
      otc.push({ districtId: district.id, count: otcCount });
      otcTotal += otcCount;
    }
    captured += intent * playerShare;
    cityDemand += intent;

    for (const category of RX_CATEGORIES) {
      const generated = categoryScripts(district, category, state.day) * rxDemandMult(state, category);
      if (generated <= 0) continue;
      cityDemand += generated;
      const weight = fillableWeight[category] ?? 0;
      if (weight <= 0) continue;
      const routed = generated * (weight / CATEGORY_WEIGHT[category]) * playerShare;
      captured += routed;
      const count = routed * CAPTURE_RX * genNoise();
      rx.push({ districtId: district.id, category, count });
      rxTotal += count;
    }
  }

  state.city.shareLog.unshift(cityDemand > 0 ? captured / cityDemand : 0);
  state.city.shareLog.length = Math.min(state.city.shareLog.length, SHARE_LOG_DAYS);
  state.city.districtShareLog.unshift(sharesToday);
  state.city.districtShareLog.length = Math.min(
    state.city.districtShareLog.length,
    DISTRICT_SHARE_LOG_DAYS,
  );

  return { otc, rx, otcTotal, rxTotal };
}

// --- Drug draw within a routed category (§17 × §25) ---

/**
 * Weighted draw of one drug inside a routed category: each fillable SKU
 * pulls with its §25 demand weight. Draw tables are memoized on license
 * coverage (licenses owned + a cabinet or fridge on the floor) — the only
 * inputs that move a within-category weight; season and district scale
 * whole categories and cancel here. A mid-shift coverage change (cabinet
 * sold, license bought) still lands on the very next spawn. Null when the
 * category has nothing fillable left — the caller degrades gracefully.
 */
let drawKey = "";
const categoryDraws = new Map<string, { drugs: DrugDef[]; total: number }>();

export function drawScriptDrugIn(state: GameState, category: RxCategory): DrugDef | null {
  const cabinet = state.store.furniture.some((f) => f.defId === "cabinet_controlled");
  const key =
    state.licenses.join(",") + (cabinet ? "|cabinet" : "") + (hasFridge(state) ? "|fridge" : "");
  if (key !== drawKey) {
    drawKey = key;
    categoryDraws.clear();
  }
  let draw = categoryDraws.get(category);
  if (!draw) {
    const drugs = DRUG_DEFS.filter((def) => def.category === category && canFillDrug(state, def));
    draw = { drugs, total: drugs.reduce((sum, def) => sum + def.demandWeight, 0) };
    categoryDraws.set(category, draw);
  }
  if (draw.drugs.length === 0) return null;
  let u = Math.random() * draw.total;
  for (const def of draw.drugs) {
    u -= def.demandWeight;
    if (u <= 0) return def;
  }
  return draw.drugs[0]!;
}

// --- Observed-demand memory (§17 "learn your neighborhood") ---

/** OTC visits ride the observed tallies under this key, beside the §24 Rx
 *  categories — a visit is "asked", a completed checkout is "served". */
export const OTC_TALLY_KEY = "otc";

/** The only keys a tally may file under. The narrowing is load-bearing:
 *  tallyFor `??=`-writes into save-hydrated objects, the read-then-assign
 *  shape sim/inventory.ts guards against prototype-chain keys — here the
 *  type keeps every caller on code-owned ids instead (M13's competitor
 *  routing must not widen this back to `string`). */
export type ObservedKey = RxCategory | typeof OTC_TALLY_KEY;

/** Trailing days kept beside today — with it, the §17 28-day window. */
const CITY_LOG_DAYS = 27;
const SHARE_LOG_DAYS = 28;
/** Today beside the last played day — the receipt's market note (M13).
 *  Exported so save validation bounds exactly what this writer keeps. */
export const DISTRICT_SHARE_LOG_DAYS = 2;

function tallyFor(city: CityState, districtId: string, key: ObservedKey): [number, number] {
  const district = (city.today[districtId] ??= {});
  return (district[key] ??= [0, 0]);
}

/** Demand walked through the door: an Rx patient's category, or an OTC
 *  shopper's visit. Recorded at spawn — a walk-out or refusal was still
 *  demand the player saw. */
export function recordSeen(state: GameState, districtId: string, key: ObservedKey): void {
  tallyFor(state.city, districtId, key)[0] += 1;
}

/** Demand actually served: a script handed over at pickup, or an OTC
 *  checkout rung up. */
export function recordServed(state: GameState, districtId: string, key: ObservedKey): void {
  tallyFor(state.city, districtId, key)[1] += 1;
}

/** Close of day: today's tallies join the log (§17 28-day window). */
export function rollCityDay(state: GameState): void {
  state.city.log.unshift(state.city.today);
  state.city.log.length = Math.min(state.city.log.length, CITY_LOG_DAYS);
  state.city.today = {};
}

// --- Read-only selectors (reports panel, district cards) ---

export interface ObservedLine {
  /** An Rx category id, or OTC_TALLY_KEY. */
  key: string;
  asked: number;
  served: number;
  /** Same-length window immediately before this one (trend arrows); NaN
   *  never appears — an unknown prior window reads as priorKnown: false. */
  priorAsked: number;
}

export interface ObservedWindow {
  lines: ObservedLine[];
  /** A *full* prior window is on the books — comparing this window's sums
   *  against a partial prior would inflate every trend (a 7-day asked over
   *  a 1-day prior reads ×7 on nothing). */
  priorKnown: boolean;
}

/** The §17 report windows: the week, or the whole 28-day book. The log
 *  holds 27 days beside today, so only the weekly view can ever satisfy
 *  priorKnown — the type keeps callers on the two real windows. */
export type ObservedWindowDays = 7 | 28;

/**
 * One district's observed tallies summed over the trailing `days` window
 * (today included), with the preceding same-length window for trend
 * comparison. Only keys the store has actually seen appear — knowledge,
 * never the generator (§17).
 */
export function observedWindow(
  state: GameState,
  districtId: string,
  days: ObservedWindowDays,
): ObservedWindow {
  const lines = new Map<string, ObservedLine>();
  const add = (tally: Record<string, [number, number]> | undefined, prior: boolean): void => {
    if (!tally) return;
    for (const key of Object.keys(tally)) {
      let line = lines.get(key);
      if (!line) {
        line = { key, asked: 0, served: 0, priorAsked: 0 };
        lines.set(key, line);
      }
      const [asked, served] = tally[key]!;
      if (prior) {
        line.priorAsked += asked;
      } else {
        line.asked += asked;
        line.served += served;
      }
    }
  };

  add(state.city.today[districtId], false);
  const log = state.city.log;
  const span = Math.min(log.length, days * 2 - 1);
  for (let i = 0; i < span; i++) {
    add(log[i]![districtId], i >= days - 1);
  }
  const sorted = [...lines.values()].sort((a, b) => b.asked - a.asked);
  return { lines: sorted, priorKnown: log.length >= days * 2 - 1 };
}

export interface ShareTrend {
  /** Mean routed share over the last up-to-7 played days, or null before
   *  the first played day. */
  current: number | null;
  /** Mean over the full 7 played days before those, or null until that
   *  whole week is on the books — a one-day "last week" would let a single
   *  day's drift wear a trend arrow. */
  prior: number | null;
}

/** The store's routed share of the whole city's demand: this week against
 *  the week before — the district card's trend arrow (§17). */
export function shareTrend(state: GameState): ShareTrend {
  const log = state.city.shareLog;
  const mean = (from: number, to: number): number | null => {
    const end = Math.min(to, log.length);
    if (end <= from) return null;
    let sum = 0;
    for (let i = from; i < end; i++) sum += log[i]!;
    return sum / (end - from);
  };
  return { current: mean(0, 7), prior: log.length >= 14 ? mean(7, 14) : null };
}
