// AI endgame tech (SPEC §21, §24, §26): the two Gen 4 modules. The
// verification assistant is a per-store purchase that auto-verifies Tier-1/2
// scripts at the §26 100% catch (the workflow's assist lane and the §19
// branch resolver both read the gates here); demand forecasting is an
// account-wide purchase whose 7-day per-SKU table reads the *true* §17
// generator — districtShares × capture, the same math that routes real
// customers — under a deterministic ±10% noise, so trusting it is genuinely
// correct play and a reload shows the same forecast. Pure sim — no DOM.

import { DISTRICTS } from "../data/districts";
import { DRUG_DEFS, type DrugDef } from "../data/drugs";
import { OTC_DEFS } from "../data/otc";
import {
  CAPTURE_OTC,
  CAPTURE_RX,
  CATEGORY_WEIGHT,
  categoryScripts,
  districtShares,
} from "./city";
import { vaccinationUnlocked, VACCINE_DOSE_ID, VACCINE_WALKINS_MAX, VACCINE_WALKINS_MIN } from "./coldchain";
import { dcStockOf } from "./dc";
import {
  otcDemandMultOn,
  rxDemandMultOn,
  seasonVisitorMultOn,
  vaccineWalkinMultOn,
} from "./events-world";
import { onHand } from "./inventory";
import { canFillDrug } from "./licenses";
import type { GameState, StoreState } from "./state";

// --- §21/§26 numbers ---

export const VERIFY_ASSIST_COST = 30_000;
export const FORECAST_COST = 45_000;
/** §26: the forecast unlocks past 28 days of sales history. */
export const FORECAST_HISTORY_DAYS = 28;
export const FORECAST_DAYS = 7;
/** §26: ±10% noise on the true generator. */
export const FORECAST_NOISE = 0.1;

/** §26 repMult (0.4 + 0.24 × stars) — the door-scaling every §7 schedule
 *  carries, so the forecast predicts feet at *this* store's door. */
const REP_MULT_BASE = 0.4;
const REP_MULT_PER_STAR = 0.24;

/** Expected §7 basket per OTC visit — the same coarse stand-in the §19
 *  branch resolver serves with (one item plus a 50% second). */
const OTC_ITEMS_PER_VISIT = 1.5;

// --- The verification assistant (§21) ---

/** What the assistant will sign off (§21): Tier-1/2 only — Tier-3 and the
 *  cold chain still see the pharmacist. */
export function assistCoversDrug(def: DrugDef): boolean {
  return def.tier !== 3 && def.refrigerated !== true;
}

export function hasVerifyAssist(state: GameState, storeId: string): boolean {
  return state.aitech.verifyAssist.includes(storeId);
}

/** §21: the module works through the verify desk's cameras — sold desk,
 *  dark assistant. Ownership survives; the reason reads on the module card. */
export function verifyAssistOnline(state: GameState, store: StoreState): boolean {
  return hasVerifyAssist(state, store.id) && storeHasDesk(store);
}

function storeHasDesk(store: StoreState): boolean {
  return store.furniture.some((f) => f.defId === "verify_desk");
}

/** Why an owned assistant isn't verifying right now, or null while it is —
 *  the same voice as the §12 equipment locks. */
export function verifyAssistOfflineReason(state: GameState, store: StoreState): string | null {
  if (!hasVerifyAssist(state, store.id)) return null;
  return storeHasDesk(store) ? null : "Needs a verify desk";
}

/** Why this store can't buy the assistant right now, or null when it can.
 *  Owned stores never ask — the caller branches on ownership first. */
export function verifyAssistLock(state: GameState, store: StoreState): string | null {
  if (store.era < 4) return "Needs the Gen 4 renovation";
  if (!storeHasDesk(store)) return "Needs a verify desk";
  if (state.cash < VERIFY_ASSIST_COST) {
    return `Short $${Math.ceil(VERIFY_ASSIST_COST - state.cash).toLocaleString("en-US")}`;
  }
  return null;
}

// --- Demand forecasting (§21) ---

/** Days of sales history on the books: the §17 observed log plus today.
 *  Only played days roll onto the log, so skipped mornings don't count. */
export function forecastHistoryDays(state: GameState): number {
  return Math.min(FORECAST_HISTORY_DAYS, state.city.log.length + 1);
}

/** Why the forecast can't be bought right now, or null when it can. */
export function forecastLock(state: GameState): string | null {
  if (!state.stores.some((s) => s.era === 4)) return "Needs a Gen 4 store";
  const days = forecastHistoryDays(state);
  if (days < FORECAST_HISTORY_DAYS) {
    return `Needs ${FORECAST_HISTORY_DAYS} days of sales history — the books hold ${days}`;
  }
  if (state.cash < FORECAST_COST) {
    return `Short $${Math.ceil(FORECAST_COST - state.cash).toLocaleString("en-US")}`;
  }
  return null;
}

/** One SKU's 7-day outlook (§21): expected units at the door per day, the
 *  ±10% noise already applied — the honest prediction, not the raw truth. */
export interface SkuForecast {
  skuId: string;
  /** FORECAST_DAYS entries, day `state.day` first. Fractional. */
  perDay: number[];
  /** Sum of perDay. The UI derives the confidence band as ±10% of this. */
  total: number;
}

/** mulberry32 — the standard tiny PRNG (events-world's seed pattern). */
function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function skuHash(skuId: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < skuId.length; i++) {
    hash = Math.imul(hash ^ skuId.charCodeAt(i), 0x01000193);
  }
  return hash | 0;
}

/** The §26 ±10%, drawn off the save's own event seed per SKU × absolute
 *  day — a reload shows the same table, and tomorrow redraws only the day
 *  that actually changed. */
function forecastNoise(state: GameState, skuId: string, day: number): number {
  const rng = mulberry32(state.events.seed ^ Math.imul(day, 0x9e3779b1) ^ skuHash(skuId));
  return 1 - FORECAST_NOISE + rng() * 2 * FORECAST_NOISE;
}

/** Sentinel line id while a store's OTC visits accumulate — never a SKU. */
const OTC_VISITS_KEY = " otcVisits";

/**
 * One store's 7-day per-SKU forecast (§21): the §17 generator per future
 * day — seasons, Monday nursing-home batches, the calendar's visitor lull —
 * routed by today's live shares and capture, scaled by the §26 repMult,
 * split to SKUs by §25 demand weight, then noised ±10%. Storm days are
 * deliberately *not* dimmed: the weather forecast only prints the evening
 * before (§16), and the AI must not leak the schedule.
 */
export function forecastStore(state: GameState, store: StoreState): Map<string, SkuForecast> {
  const out = new Map<string, SkuForecast>();
  const line = (skuId: string): SkuForecast => {
    let entry = out.get(skuId);
    if (!entry) {
      entry = { skuId, perDay: new Array<number>(FORECAST_DAYS).fill(0), total: 0 };
      out.set(skuId, entry);
    }
    return entry;
  };

  // Today's live routing shares — rep, price and availability as they stand.
  const shares = DISTRICTS.map((district) => {
    const { stores } = districtShares(state, district.id);
    return stores.find((entry) => entry.pharmacyId === store.id)?.share ?? 0;
  });
  const repMult = REP_MULT_BASE + REP_MULT_PER_STAR * store.repStars;
  const fillable = DRUG_DEFS.filter((def) => canFillDrug(state, store, def));
  const vaccines = vaccinationUnlocked(state, store);

  for (let t = 0; t < FORECAST_DAYS; t++) {
    const day = state.day + t;
    const doorMult = repMult * seasonVisitorMultOn(day);

    // Rx: routed scripts per category, split to SKUs by §25 demand weight.
    for (let d = 0; d < DISTRICTS.length; d++) {
      const share = shares[d]!;
      if (share <= 0) continue;
      const district = DISTRICTS[d]!;
      for (const def of fillable) {
        const generated =
          categoryScripts(district, def.category, day) * rxDemandMultOn(day, def.category);
        if (generated <= 0) continue;
        line(def.id).perDay[t]! +=
          generated *
          share *
          CAPTURE_RX *
          doorMult *
          (def.demandWeight / CATEGORY_WEIGHT[def.category]);
      }
      // OTC visits from this district; SKU split happens once below.
      const intent = (district.population / 1000) * district.otcIntent;
      line(OTC_VISITS_KEY).perDay[t]! += intent * share * CAPTURE_OTC * doorMult;
    }

    // §14 vaccine doses: the walk-in stream consumes them, 3–6 a day ×4 in
    // flu season — only where the service actually runs.
    if (vaccines) {
      line(VACCINE_DOSE_ID).perDay[t]! +=
        ((VACCINE_WALKINS_MIN + VACCINE_WALKINS_MAX) / 2) * vaccineWalkinMultOn(day);
    }
  }

  // OTC: the day's visits spread over the catalog by §25 weight under the
  // day's season pull (spring's ×2.5 on allergy, winter's ×3 on cold & flu).
  const visits = out.get(OTC_VISITS_KEY);
  if (visits) {
    out.delete(OTC_VISITS_KEY);
    for (let t = 0; t < FORECAST_DAYS; t++) {
      const day = state.day + t;
      let denom = 0;
      for (const def of OTC_DEFS) denom += def.demandWeight * otcDemandMultOn(day, def.category);
      if (denom <= 0) continue;
      const units = visits.perDay[t]! * OTC_ITEMS_PER_VISIT;
      for (const def of OTC_DEFS) {
        const weight = def.demandWeight * otcDemandMultOn(day, def.category);
        if (weight <= 0) continue;
        line(def.id).perDay[t]! += (units * weight) / denom;
      }
    }
  }

  // The §26 noise, then the totals the table and the draft read.
  for (const entry of out.values()) {
    for (let t = 0; t < FORECAST_DAYS; t++) {
      entry.perDay[t]! *= forecastNoise(state, entry.skuId, state.day + t);
      entry.total += entry.perDay[t]!;
    }
  }
  return out;
}

/** The whole network's outlook — every store's own shares and door summed
 *  per SKU. The §20 depot scope orders against this. */
export function forecastNetwork(state: GameState): Map<string, SkuForecast> {
  const out = new Map<string, SkuForecast>();
  for (const store of state.stores) {
    for (const entry of forecastStore(state, store).values()) {
      let sum = out.get(entry.skuId);
      if (!sum) {
        sum = { skuId: entry.skuId, perDay: new Array<number>(FORECAST_DAYS).fill(0), total: 0 };
        out.set(entry.skuId, sum);
      }
      for (let t = 0; t < FORECAST_DAYS; t++) sum.perDay[t]! += entry.perDay[t]!;
      sum.total += entry.total;
    }
  }
  return out;
}


function inboundUnits(store: StoreState, skuId: string): number {
  let units = 0;
  for (const l of store.inbound) {
    if (l.skuId === skuId) units += l.units;
  }
  return units;
}

/** Units the scope already has spoken for against the next week: on hand
 *  plus tomorrow's van — and, network-wide, the depot's shelves and its
 *  own inbound order. */
export function forecastCovered(state: GameState, store: StoreState | null, skuId: string): number {
  if (store !== null) return onHand(store, skuId) + inboundUnits(store, skuId);
  let units = 0;
  for (const s of state.stores) units += onHand(s, skuId) + inboundUnits(s, skuId);
  if (state.dc !== null) {
    units += dcStockOf(state.dc, skuId);
    for (const l of state.dc.inbound) {
      if (l.skuId === skuId) units += l.units;
    }
  }
  return units;
}

/**
 * §21 "Order to forecast": a cart sized to predicted demand minus what the
 * scope already holds or expects (`store` null = the depot's network scope).
 * Whole units, never negative; the Orders panel drafts it through the same
 * setCart path as the reorder rules, so the §14 cold clamp, §12 locks and
 * §16 fill caps all still apply before anything is signed.
 */
export function forecastOrderDraft(
  state: GameState,
  store: StoreState | null,
): Record<string, number> {
  const forecast = store !== null ? forecastStore(state, store) : forecastNetwork(state);
  const draft: Record<string, number> = {};
  for (const entry of forecast.values()) {
    const want = Math.ceil(entry.total - 1e-9) - forecastCovered(state, store, entry.skuId);
    if (want > 0) draft[entry.skuId] = want;
  }
  return draft;
}
