// Competitors + the chronic-patient market (SPEC §18, §22, §24, §26): the
// 28-day drift that makes the weakest rival fight back, the per-district
// chronic patient pools with their recognizable named patients, the
// two-bad-experiences transfer out, the Monday evaluation that pulls pools
// back in, and the transfer log the reports and ticker read. The §17 share
// math itself lives in sim/city.ts — this file owns the *dynamics*.
// Pure sim — no DOM, no three.js.

import { competitorDef, type DriftMove } from "../data/competitors";
import { DISTRICTS, type RxCategory } from "../data/districts";
import { DRUG_DEFS, type DrugDef } from "../data/drugs";
import { FIRST_NAMES, LAST_NAMES } from "../data/names";
import {
  districtShares,
  PLAYER_PHARMACY_ID,
  rivalAvailability,
  storeAvailability,
  type PharmacyShare,
} from "./city";
import type { SimEvent } from "./events";
import { recordMoment } from "./legacy";
import { canFillDrug } from "./licenses";
import type { GameState, PatientPool, PoolStrike, TransferRecord } from "./state";

type Emit = (event: SimEvent) => void;

// --- Tuning (§18, §26) ---

/** §26: drift every 28 days; §18 transfers move on 2 bad experiences. */
const DRIFT_PERIOD_DAYS = 28;
const STRIKES_TO_TRANSFER = 2;
/** The Monday pull bar: the player must beat the holder's availability +
 *  rep score by this much — "sustained high availability + rep" (§18), not
 *  a fresh store's benefit-of-the-doubt fill rate. */
const PULL_MARGIN = 0.15;
/** Pools pulled in per Monday, biggest score gap first — a regular a week
 *  finds their way back, not a stampede the morning a threshold is crossed. */
const PULLS_PER_WEEK = 3;
/** Transfer log retention: this week + last (reports + the net-in check). */
const TRANSFER_KEEP_DAYS = 14;
/** Hard bound on the persisted log — exported so save validation refuses
 *  exactly what the writer can no longer produce; raising it here raises
 *  both sides together. */
export const TRANSFER_CAP = 64;

/** §18 drift notches and their caps — a rival improves, never past sanity. */
const DRIFT_PRICE_STEP = 0.05;
const DRIFT_PRICE_FLOOR = 0.7;
const DRIFT_REP_STEP = 0.25;
const DRIFT_REP_CAP = 4.75;
const DRIFT_RELIABILITY_STEP = 0.05;
const DRIFT_RELIABILITY_CAP = 0.95;

/** §18 "monthly refill" categories a pool exists for — the daily meds that
 *  repeat forever, not acute scripts. A district gets one pool per chronic
 *  category it actually has prevalence in (§17 table). */
export const CHRONIC_CATEGORIES: readonly RxCategory[] = [
  "cardiovascular",
  "diabetes",
  "thyroid",
  "anticoagulant",
  "mentalHealth",
];

// --- Pool identity (deterministic: same save, same name, same drug) ---

export function poolKeyOf(districtId: string, category: RxCategory): string {
  return `${districtId}:${category}`;
}

/** fnv-1a — a stable tiny string hash for the deterministic picks below. */
function hashString(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** The pool's recognizable patient (§18 "same name, same drug") — a stable
 *  draw from the data/names.ts pools, keyed on the pool id alone. */
export function poolPatientName(poolId: string): string {
  const h = hashString(poolId);
  const first = FIRST_NAMES[h % FIRST_NAMES.length]!;
  const last = LAST_NAMES[Math.floor(h / FIRST_NAMES.length) % LAST_NAMES.length]!;
  return `${first} ${last}`;
}

/** Memo for poolDrug — the pick is pure in (poolId, §25 catalog), and the
 *  spawn path asks on every Rx arrival (same shape as city.ts's draw memo). */
const POOL_DRUG_PICKS = new Map<string, DrugDef | null>();

/** The pool's standing refill: a stable pick from the lowest tier of its
 *  category's non-refrigerated drugs — the daily generic a chronic patient
 *  actually rides on, and fillable as soon as the category itself is.
 *  Null when the category has no such drug (no chronic category is bare
 *  today, but a catalog edit must degrade to an ordinary visit, not a
 *  crash on the spawn path). */
export function poolDrug(poolId: string, category: RxCategory): DrugDef | null {
  let pick = POOL_DRUG_PICKS.get(poolId);
  if (pick === undefined) {
    const drugs = DRUG_DEFS.filter(
      (def) => def.category === category && def.refrigerated !== true,
    );
    if (drugs.length === 0) {
      pick = null;
    } else {
      const lowestTier = drugs.reduce((min, def) => Math.min(min, def.tier), 3);
      const band = drugs.filter((def) => def.tier === lowestTier);
      pick = band[hashString(poolId) % band.length]!;
    }
    POOL_DRUG_PICKS.set(poolId, pick);
  }
  return pick;
}

// --- Pool creation (launch-day assignment) ---

/**
 * Assign the chronic pools by launch-day scores (§18): each district's
 * chronic categories become pools held by whichever pharmacy is most
 * attractive in that district right now — for a fresh run that is the
 * rivals, mostly each district's nearest; a migrated 4★ store starts with
 * the pools it has honestly already earned. A pool that already exists is
 * play's record and is never reassigned; the gate is per key, so a pool
 * added by later content (a new district, a new chronic category) still
 * reaches existing saves instead of silently never existing there.
 */
export function ensurePatientPools(state: GameState): void {
  for (const district of DISTRICTS) {
    let best: PharmacyShare | null = null;
    for (const category of CHRONIC_CATEGORIES) {
      if ((district.prevalence[category] ?? 0) <= 0) continue;
      const key = poolKeyOf(district.id, category);
      if (state.patientPools[key]) continue;
      if (best === null) {
        const shares = districtShares(state, district.id);
        best = shares.player;
        for (const entry of shares.rivals) {
          if (entry.attractiveness > best.attractiveness) best = entry;
        }
      }
      state.patientPools[key] = {
        districtId: district.id,
        category,
        pharmacyId: best.pharmacyId,
        strikes: [],
        lastVisitDay: 0,
        retry: false,
      };
    }
  }
}

// --- Pool visits (wired into sim/customers.ts spawning) ---

/** Day 1 is a Monday (§5); weeks turn with it. */
function weekOf(day: number): number {
  return Math.floor((day - 1) / 7);
}

export interface PoolVisit {
  poolId: string;
  patientName: string;
  drug: DrugDef;
}

/**
 * Is this routed Rx slice the week's visit from a player-held pool? One
 * visit per week per pool, plus a next-day retry after a bad experience —
 * a chronic refill can't wait for next Monday. Null when the pool belongs
 * to a rival, already visited, or its standing drug isn't fillable right
 * now (an L3-only mental-health coverage, say) — the spawn then proceeds
 * as an ordinary patient.
 */
export function duePoolVisit(
  state: GameState,
  districtId: string,
  category: RxCategory,
): PoolVisit | null {
  const poolId = poolKeyOf(districtId, category);
  const pool = state.patientPools[poolId];
  if (!pool || pool.pharmacyId !== PLAYER_PHARMACY_ID) return null;
  const due =
    pool.lastVisitDay === 0 ||
    weekOf(pool.lastVisitDay) < weekOf(state.day) ||
    (pool.retry && pool.lastVisitDay < state.day);
  if (!due) return null;
  const drug = poolDrug(poolId, category);
  if (drug === null || !canFillDrug(state, drug)) return null;
  return { poolId, patientName: poolPatientName(poolId), drug };
}

/** The patient walked in: this week's visit is spent (a bad experience
 *  re-arms the retry). */
export function beginPoolVisit(state: GameState, poolId: string): void {
  const pool = state.patientPools[poolId];
  if (!pool) return;
  pool.lastVisitDay = state.day;
  pool.retry = false;
}

/** A clean pickup settles the account: strikes are forgiven through
 *  service, so a transfer always means two bad experiences *in a row*. */
export function recordPoolServed(state: GameState, poolId: string): void {
  const pool = state.patientPools[poolId];
  if (!pool || pool.pharmacyId !== PLAYER_PHARMACY_ID) return;
  pool.strikes.length = 0;
  pool.retry = false;
}

/** §28 copy for a transfer-out reason, from the two strikes that caused it. */
const STRIKE_WORDS: Record<PoolStrike, [one: string, two: string]> = {
  walkout: ["a walk-out", "two walk-outs"],
  stockout: ["a stock-out", "two stock-outs"],
  error: ["a dispensing error", "two dispensing errors"],
};

function reasonFromStrikes(strikes: readonly PoolStrike[]): string {
  const [a, b] = [strikes[0]!, strikes[1]!];
  if (a === b) return STRIKE_WORDS[a][1];
  return `${STRIKE_WORDS[a][0]} and ${STRIKE_WORDS[b][0]}`;
}

function pushTransfer(state: GameState, record: TransferRecord): void {
  state.market.transfers.push(record);
  if (state.market.transfers.length > TRANSFER_CAP) state.market.transfers.shift();
}

/**
 * A §18 bad experience for a player-held pool's patient: walk-out,
 * stock-out refusal, or a dispensed error. The second in a row moves the
 * pool's refills to the best-scoring rival in its district, on the record
 * with the reason ("Marta R. — two stock-outs → QuickScripts").
 */
export function recordPoolStrike(
  state: GameState,
  poolId: string,
  kind: PoolStrike,
  emit: Emit,
): void {
  const pool = state.patientPools[poolId];
  if (!pool || pool.pharmacyId !== PLAYER_PHARMACY_ID) return;
  pool.strikes.push(kind);
  pool.retry = true;
  if (pool.strikes.length < STRIKES_TO_TRANSFER) return;

  // §18: the best-scoring rival in the pool's district takes the refills.
  const { rivals } = districtShares(state, pool.districtId);
  let best: (typeof rivals)[number] | null = null;
  for (const entry of rivals) {
    if (best === null || entry.attractiveness > best.attractiveness) best = entry;
  }
  if (best === null) {
    // Nowhere to go. Validation refuses a rival-less save today, but the
    // strike book must still settle — an ever-growing array would be the
    // one state the game can write and its own validator then refuses.
    pool.strikes.length = 0;
    return;
  }
  const reason = reasonFromStrikes(pool.strikes);
  pool.pharmacyId = best.pharmacyId;
  pool.strikes.length = 0;
  pool.retry = false;
  pushTransfer(state, {
    day: state.day,
    poolId,
    direction: "out",
    rivalId: best.pharmacyId,
    reason,
  });
  emit({
    type: "market.transfer",
    direction: "out",
    poolId,
    patientName: poolPatientName(poolId),
    rivalName: competitorDef(best.pharmacyId).name,
    reason,
    day: state.day,
  });
}

// --- The market's morning (called from beginMorning, §5) ---

/** §18 "sustained high availability + rep" — the score both sides of the
 *  Monday evaluation are measured on (each term 0..1-ish, summed). */
function pullScorePlayer(state: GameState): number {
  return storeAvailability(state) + state.repStars / 5;
}

/**
 * Monday: pools held by rivals the player now decisively outscores on
 * sustained availability + rep come back, biggest gap first, at most
 * PULLS_PER_WEEK — then the completed week is checked for the first net
 * transfer-in moment (§22).
 */
function evaluatePools(state: GameState, emit: Emit): void {
  const playerScore = pullScorePlayer(state);
  const candidates: { poolId: string; pool: PatientPool; gap: number }[] = [];
  for (const poolId of Object.keys(state.patientPools)) {
    const pool = state.patientPools[poolId]!;
    if (pool.pharmacyId === PLAYER_PHARMACY_ID) continue;
    const holder = state.competitors.find((c) => c.id === pool.pharmacyId);
    if (!holder) continue;
    // A pool the store couldn't serve is not a pool the store has won.
    const drug = poolDrug(poolId, pool.category);
    if (drug === null || !canFillDrug(state, drug)) continue;
    const holderScore = rivalAvailability(state, holder) + holder.repStars / 5;
    const gap = playerScore - (holderScore + PULL_MARGIN);
    if (gap > 0) candidates.push({ poolId, pool, gap });
  }
  candidates.sort((a, b) => b.gap - a.gap);
  for (const { poolId, pool } of candidates.slice(0, PULLS_PER_WEEK)) {
    const fromId = pool.pharmacyId;
    pool.pharmacyId = PLAYER_PHARMACY_ID;
    pool.strikes.length = 0;
    pool.retry = false;
    pool.lastVisitDay = 0; // the new regular shows up this very week
    const reason = "steady fills and a better name";
    pushTransfer(state, { day: state.day, poolId, direction: "in", rivalId: fromId, reason });
    emit({
      type: "market.transfer",
      direction: "in",
      poolId,
      patientName: poolPatientName(poolId),
      rivalName: competitorDef(fromId).name,
      reason,
      day: state.day,
    });
  }

  // §22: the first completed week that nets transfers *in* is a moment.
  // The window reaches back over the played week and includes this
  // morning's pulls, so the note pins to tonight's receipt.
  let net = 0;
  for (const record of state.market.transfers) {
    if (state.day - record.day >= 7) continue;
    net += record.direction === "in" ? 1 : -1;
  }
  if (net > 0) recordMoment(state, "first_transfer_in", emit);
}

/** §18/§26 drift: every 28 days the rival with the lowest total share
 *  improves its weakest attribute a notch, and the ticker names the move. */
function driftWeakestRival(state: GameState, emit: Emit): void {
  if (state.competitors.length === 0) return;
  // Population-weighted total share: which rival the city is leaving behind.
  const totals = new Map<string, number>();
  for (const district of DISTRICTS) {
    for (const entry of districtShares(state, district.id).rivals) {
      totals.set(
        entry.pharmacyId,
        (totals.get(entry.pharmacyId) ?? 0) + entry.share * district.population,
      );
    }
  }
  let weakest = state.competitors[0]!;
  for (const rival of state.competitors) {
    if ((totals.get(rival.id) ?? 0) < (totals.get(weakest.id) ?? 0)) weakest = rival;
  }

  // The weakest attribute on the §17 scoreboard's own 0..1 terms, skipping
  // any notch already at its cap — a rival never drifts past sanity.
  const options: { move: DriftMove; score: number; open: boolean }[] = [
    {
      move: "price",
      score: Math.min(1, Math.max(0, 2 - weakest.priceIndex)),
      open: weakest.priceIndex - DRIFT_PRICE_STEP >= DRIFT_PRICE_FLOOR,
    },
    { move: "rep", score: weakest.repStars / 5, open: weakest.repStars < DRIFT_REP_CAP },
    {
      move: "reliability",
      score: weakest.stockReliability,
      open: weakest.stockReliability < DRIFT_RELIABILITY_CAP,
    },
  ];
  let pick: (typeof options)[number] | null = null;
  for (const option of options) {
    if (!option.open) continue;
    if (pick === null || option.score < pick.score) pick = option;
  }
  if (pick === null) return; // fully drifted on every axis

  if (pick.move === "price") weakest.priceIndex -= DRIFT_PRICE_STEP;
  else if (pick.move === "rep") weakest.repStars = Math.min(5, weakest.repStars + DRIFT_REP_STEP);
  else weakest.stockReliability = Math.min(1, weakest.stockReliability + DRIFT_RELIABILITY_STEP);

  state.market.lastDrift = { day: state.day, competitorId: weakest.id, move: pick.move };
  emit({ type: "competitor.drift", id: weakest.id, name: weakest.name, move: pick.move, day: state.day });
}

/**
 * The market's morning turnover (§18), run by beginMorning before its phase
 * change goes out (advanceWorld pattern — the autosave captures it): Monday
 * pool evaluation, then the 28-day drift, then the transfer log sheds
 * anything older than two weeks. Both clocks run on *calendar* days — the
 * market doesn't pause because the player skipped mornings with the dev K
 * key; each skipped day still passes through beginMorning exactly once, so
 * nothing is missed or double-fired.
 */
export function advanceMarket(state: GameState, emit: Emit): void {
  if ((state.day - 1) % 7 === 0) evaluatePools(state, emit);
  // Pulls are judged on the completed week's stats; the rival improves after.
  if (state.day > 1 && (state.day - 1) % DRIFT_PERIOD_DAYS === 0) driftWeakestRival(state, emit);
  state.market.transfers = state.market.transfers.filter(
    (record) => state.day - record.day < TRANSFER_KEEP_DAYS,
  );
}

// --- Read-only selectors (reports panel, ticker) ---

/** This week's transfers, oldest first (§18 "transfers in/out this week"). */
export function transfersThisWeek(state: GameState): TransferRecord[] {
  const weekStart = state.day - ((state.day - 1) % 7);
  return state.market.transfers.filter((record) => record.day >= weekStart);
}
