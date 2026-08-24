// Off-screen branch resolution (SPEC §19, §26): at close, every store the
// player didn't stand in today resolves statistically — §17 routed demand
// against the §26 staff throughputs and the manager factor, consuming real
// stock, posting real money, filing what it saw into the same observed
// memory a visited day writes, and drifting its own §19 local reputation by
// how well it served. Deliberately coarse where the visited floor is fine-
// grained: no queues, no walk-outs, no vaccinations, no counsel — hiring a
// good manager and stocking well *is* the branch's gameplay (§19).
// Pure sim — no DOM, no three.js.

import type { RxCategory } from "../data/districts";
import { DRUG_DEFS, type DrugDef } from "../data/drugs";
import { OTC_DEFS } from "../data/otc";
import { assistCoversDrug, verifyAssistOnline } from "./aitech";
import {
  OTC_TALLY_KEY,
  recordSeen,
  recordServed,
  routedBranchDay,
  type BranchDemand,
} from "./city";
import { COPAY, post, round2 } from "./economy";
import type { SimEvent } from "./events";
import { onHand, otcPrice, pushHistory, recordSale } from "./inventory";
import { canFillDrug } from "./licenses";
import { fillErrorRate, taskDuration, verifyCatchRate } from "./staff";
import type { GameState, StoreState } from "./state";

type Emit = (event: SimEvent) => void;

// --- §26 off-screen throughputs (per day, before the speed curve) ---

const FILLS_PER_TECH = 35;
const VERIFIES_PER_PHARMACIST = 50;
const CHECKOUTS_PER_CASHIER = 60;

/** §26 managerFactor: the day runs at 60% without one. */
const NO_MANAGER_FACTOR = 0.6;
const MANAGER_BASE = 0.9;
const MANAGER_PER_STAT = 0.02;

/** §19 local-rep band: full service earns +0.05/day, half service (or
 *  worse) bleeds −0.05; three-quarters served is the break-even. */
const REP_BAND = 0.05;
const REP_BREAK_EVEN = 0.75;
const REP_SLOPE = 0.2;

/** Off-screen shoppers buy one or two units a visit — the coarse stand-in
 *  for the §7 basket, kept under the visited floor's 1–4 so a manager's day
 *  never out-sells a played one on the same feet. */
const SECOND_ITEM_CHANCE = 0.5;

/** Fractional expected counts become whole customers. */
function roundStochastic(count: number): number {
  const floor = Math.floor(count);
  return floor + (Math.random() < count - floor ? 1 : 0);
}

function shuffle<T>(items: T[]): T[] {
  for (let i = items.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [items[i], items[j]] = [items[j]!, items[i]!];
  }
  return items;
}

/** Take one unit from wherever the store holds it — the manager's crew
 *  works backroom and shelf as one pool while nobody is watching the floor
 *  (the §11 restock trip is assumed, not simulated). Only ever called after
 *  a draw proved onHand > 0, so there is no failure to report. */
function takeUnit(store: StoreState, skuId: string): void {
  const line = store.stock[skuId];
  if (!line) return;
  if (line.shelved > 0) line.shelved--;
  else if (line.backroom > 0) line.backroom--;
}

/** Weighted §25 draw among a category's fillable SKUs, in-stock only. The
 *  caller memoizes the fillable list per category for the whole resolution
 *  (licenses and equipment can't move mid-close); stock filters at draw
 *  time, since every serve moves it. */
function drawStockedDrug(store: StoreState, drugs: readonly DrugDef[]): DrugDef | null {
  let total = 0;
  for (const def of drugs) {
    if (onHand(store, def.id) <= 0) continue;
    total += def.demandWeight;
  }
  if (total <= 0) return null;
  let u = Math.random() * total;
  for (const def of drugs) {
    if (onHand(store, def.id) <= 0) continue;
    u -= def.demandWeight;
    if (u <= 0) return def;
  }
  return null;
}

/** Weighted §25 draw among the branch's in-stock OTC SKUs. */
function drawStockedOtc(store: StoreState): string | null {
  let total = 0;
  for (const def of OTC_DEFS) {
    if (onHand(store, def.id) <= 0) continue;
    total += def.demandWeight;
  }
  if (total <= 0) return null;
  let u = Math.random() * total;
  for (const def of OTC_DEFS) {
    if (onHand(store, def.id) <= 0) continue;
    u -= def.demandWeight;
    if (u <= 0) return def.id;
  }
  return null;
}

interface CrewProfile {
  fills: number;
  verifies: number;
  checkouts: number;
  managerFactor: number;
  hadManager: boolean;
  hadPharmacist: boolean;
  /** Mean tech mis-pick chance and mean pharmacist catch rate (§26). */
  errorRate: number;
  catchRate: number;
}

/** §26 throughputs from the branch's roster: base rate over the speed
 *  curve's duration multiplier (a fast hand does more of the same task),
 *  and the best manager's factor over the whole day. */
function crewProfile(store: StoreState): CrewProfile {
  let fills = 0;
  let verifies = 0;
  let checkouts = 0;
  let managerFactor = NO_MANAGER_FACTOR;
  let hadManager = false;
  let errorSum = 0;
  let techs = 0;
  let catchSum = 0;
  let pharmacists = 0;
  for (const member of store.staff) {
    const duration = taskDuration(member, 1);
    switch (member.role) {
      case "tech":
        fills += FILLS_PER_TECH / duration;
        errorSum += fillErrorRate(member);
        techs++;
        break;
      case "pharmacist":
        verifies += VERIFIES_PER_PHARMACIST / duration;
        catchSum += verifyCatchRate(member);
        pharmacists++;
        break;
      case "cashier":
        checkouts += CHECKOUTS_PER_CASHIER / duration;
        break;
      case "manager": {
        const statTotal = member.speed + member.accuracy + member.warmth;
        managerFactor = Math.max(
          hadManager ? managerFactor : 0,
          MANAGER_BASE + MANAGER_PER_STAT * statTotal,
        );
        hadManager = true;
        break;
      }
    }
  }
  return {
    fills,
    verifies,
    checkouts,
    managerFactor,
    hadManager,
    hadPharmacist: pharmacists > 0,
    errorRate: techs === 0 ? 0 : errorSum / techs,
    catchRate: pharmacists === 0 ? 0 : catchSum / pharmacists,
  };
}

/**
 * Resolve one unvisited branch's day (§19/§26). Run at close, before the
 * phase change goes out, so the autosave captures the resolved books:
 *
 *   capacity = min(fills, verifies, checkouts) × managerFactor
 *   served   = min(demand, capacity)
 *
 * Scripts need all three stations' hands, so the Rx stream serves against
 * that full minimum; OTC needs only the register, so whatever checkout
 * budget the scripts didn't use serves the front store — which is exactly
 * what "no pharmacist → OTC only" degrades to (verifies 0 zeroes the Rx
 * stream and nothing else). Served demand consumes real stock (empty
 * shelves are stock-outs on the branch's own fill rate), earns real ledger
 * money as one "Branch sales" line, and the §26 accuracy tables roll real
 * dispensing errors — refunded on the spot, itemized on the branch's
 * receipt page.
 *
 * `demand` is routed by the caller before *any* branch resolves (null for a
 * scaffolding day): each resolution moves repStars and fillRate7d, which
 * districtShares reads live — scored one at a time, the same network would
 * close differently depending on purchase order.
 */
export function resolveBranchDay(
  state: GameState,
  store: StoreState,
  demand: BranchDemand | null,
  emit: Emit,
): void {
  // §13: a branch under scaffolding is closed — nothing to resolve.
  if (store.pendingEra !== null || demand === null) {
    store.daySummary = {
      day: state.day,
      demand: 0,
      served: 0,
      capacity: 0,
      rxFills: 0,
      otcUnits: 0,
      revenue: 0,
      incidents: 0,
      stockOuts: 0,
      repDelta: 0,
      hadManager: store.staff.some((m) => m.role === "manager"),
      hadPharmacist: store.staff.some((m) => m.role === "pharmacist"),
      otcOnly: false,
      underRenovation: true,
    };
    emit({ type: "branch.daySummary", storeId: store.id, day: state.day });
    return;
  }

  const crew = crewProfile(store);

  // §21: with the verification assistant on (owned + a desk standing),
  // Tier-1/2 scripts don't spend the pharmacist's verifies — only the
  // Tier-3/refrigerated stream still queues for them. Without it, every
  // script needs all three stations, exactly as before.
  const assist = verifyAssistOnline(state, store);

  // The §19 aggregate the receipt page quotes: the main Rx stream's ceiling.
  const capacity =
    (assist
      ? Math.min(crew.fills, crew.checkouts)
      : Math.min(crew.fills, crew.verifies, crew.checkouts)) * crew.managerFactor;
  const rxBudget = Math.floor(capacity);
  /** Scripts the pharmacist must still sign (everything, without an
   *  assistant; Tier-3/refrigerated with one). */
  const rxVerifiedBudget = assist
    ? Math.floor(Math.min(crew.fills, crew.verifies, crew.checkouts) * crew.managerFactor)
    : rxBudget;
  const checkoutBudget = Math.floor(crew.checkouts * crew.managerFactor);

  // Whole customers out of the routed expectations, shuffled so no district
  // systematically eats the capacity shortfall.
  const scripts: { districtId: string; category: RxCategory }[] = [];
  for (const slice of demand.rx) {
    const n = roundStochastic(slice.count);
    for (let i = 0; i < n; i++) {
      scripts.push({ districtId: slice.districtId, category: slice.category });
    }
  }
  shuffle(scripts);
  const visits: string[] = [];
  for (const slice of demand.otc) {
    const n = roundStochastic(slice.count);
    for (let i = 0; i < n; i++) visits.push(slice.districtId);
  }
  shuffle(visits);

  let rxServed = 0;
  let otcVisitsServed = 0;
  let otcUnits = 0;
  let stockOuts = 0;
  /** Demand the crew never got to — the line outlasted the day's budgets. */
  let capacityMissed = 0;
  let incidents = 0;
  let gross = 0;
  let refunds = 0;

  // §26 accuracy: a mis-pick that slips past verification reaches a bag.
  const incidentRate = crew.errorRate * (1 - crew.catchRate);

  // §25 draw tables, one canFillDrug × DRUG_DEFS walk per category for the
  // whole resolution instead of two per script — city.ts's categoryDraws is
  // the same shape for the visited floor.
  const fillable = new Map<RxCategory, DrugDef[]>();
  const fillableIn = (category: RxCategory): DrugDef[] => {
    let drugs = fillable.get(category);
    if (!drugs) {
      drugs = DRUG_DEFS.filter((def) => def.category === category && canFillDrug(state, store, def));
      fillable.set(category, drugs);
    }
    return drugs;
  };

  let rxVerifiedServed = 0;
  for (const script of scripts) {
    recordSeen(state, script.districtId, script.category);
    if (rxServed >= rxBudget) {
      capacityMissed++; // the line outlasted the crew
      continue;
    }
    const drug = drawStockedDrug(store, fillableIn(script.category));
    if (drug === null) {
      stockOuts++;
      continue;
    }
    // §21: the assistant signs Tier-1/2 itself; a script it won't touch
    // still needs the pharmacist's verify budget.
    const assisted = assist && assistCoversDrug(drug);
    if (!assisted && rxVerifiedServed >= rxVerifiedBudget) {
      capacityMissed++; // the pharmacist's pile outlasted the day
      continue;
    }
    takeUnit(store, drug.id);
    recordSale(store, drug.id, 1);
    rxServed++;
    if (!assisted) rxVerifiedServed++;
    gross += drug.reimbursement + COPAY;
    // §26: AI assist catch 100 — an assisted script never reaches a bag wrong.
    if (!assisted && Math.random() < incidentRate) {
      incidents++;
      refunds += drug.reimbursement + COPAY;
    }
    recordServed(state, script.districtId, script.category);
  }

  const otcBudget = Math.max(0, checkoutBudget - rxServed);
  for (const districtId of visits) {
    recordSeen(state, districtId, OTC_TALLY_KEY);
    if (otcVisitsServed >= otcBudget) {
      capacityMissed++;
      continue;
    }
    const first = drawStockedOtc(store);
    if (first === null) {
      stockOuts++;
      continue;
    }
    takeUnit(store, first);
    recordSale(store, first, 1);
    gross += otcPrice(store, first);
    otcUnits++;
    if (Math.random() < SECOND_ITEM_CHANCE) {
      const second = drawStockedOtc(store);
      if (second !== null) {
        takeUnit(store, second);
        recordSale(store, second, 1);
        gross += otcPrice(store, second);
        otcUnits++;
      }
    }
    otcVisitsServed++;
    recordServed(state, districtId, OTC_TALLY_KEY);
  }

  const revenue = round2(gross - refunds);
  if (revenue !== 0) post(state, "branch.sales", revenue, emit);

  // §11 is per store (§19): a branch's first stock-out teaches its reorder
  // rules even with nobody standing in it — recordStockOut only ever
  // unlocks the visited floor, so a never-visited branch would otherwise
  // hide the Orders panel's min/target columns forever.
  if (stockOuts > 0 && !store.reorderUnlocked) {
    store.reorderUnlocked = true;
    emit({ type: "reorder.unlocked", storeId: store.id });
  }

  // §19 local rep: drifts by served ratio inside the ±0.05/day band.
  const demandTotal = scripts.length + visits.length;
  const servedTotal = rxServed + otcVisitsServed;
  let repDelta = 0;
  if (demandTotal > 0) {
    const ratio = servedTotal / demandTotal;
    repDelta = Math.min(REP_BAND, Math.max(-REP_BAND, REP_SLOPE * (ratio - REP_BREAK_EVEN)));
    const next = Math.min(5, Math.max(0, store.repStars + repDelta));
    repDelta = round2(next - store.repStars);
    if (repDelta !== 0) {
      store.repStars = next;
      emit({ type: "rep.changed", storeId: store.id, stars: next, delta: repDelta });
    }
  }

  // §17/§19: the day joins the branch's own trailing books — stock-outs
  // AND the customers the crew never got to count against its fill rate
  // (rollHistory counts refusals the same way on the visited floor, and
  // served counts units exactly as it does), gross feeds the bank's
  // network line. A staffed-by-nobody day is missed demand, not a clean
  // sheet: without capacityMissed it would bank a perfect 1.0.
  const served = rxServed + otcUnits;
  const missed = stockOuts + capacityMissed;
  const rate = served + missed === 0 ? 1 : served / (served + missed);
  // Banked net of refunds: rollHistory's gross is the ledger's revenue
  // group, which the visited day's refunds already reduced — the bank's
  // credit line must read one number across the network.
  pushHistory(store, rate, revenue);

  store.daySummary = {
    day: state.day,
    demand: demandTotal,
    served: servedTotal,
    capacity: round2(capacity),
    rxFills: rxServed,
    otcUnits,
    revenue,
    incidents,
    stockOuts,
    repDelta,
    hadManager: crew.hadManager,
    hadPharmacist: crew.hadPharmacist,
    // The Rx stream was zeroed while the register still ran — true with no
    // pharmacist to verify OR no tech to fill (§19), not the pharmacist
    // alone: the receipt names the missing hands off hadPharmacist. With a
    // §21 assistant the pharmacist drops out of the main stream's minimum —
    // a tech-and-cashier crew honestly serves Tier-1/2.
    otcOnly: rxBudget === 0 && checkoutBudget > 0,
    underRenovation: false,
  };
  emit({ type: "branch.daySummary", storeId: store.id, day: state.day });
}

/**
 * Every store but the visited one resolves (§19). Returns how many did, so
 * the close can roll a city day that only branches played (a renovation
 * morning plans nothing on the active floor, but the branches still saw
 * their neighborhoods).
 */
export function resolveUnvisitedBranches(state: GameState, emit: Emit): number {
  // Snapshot first, resolve second: every branch's routed demand is scored
  // against the same pre-close books, so the array order can't change what
  // the same network serves on the same day.
  const days: { store: StoreState; demand: BranchDemand | null }[] = [];
  for (const store of state.stores) {
    if (store.id === state.activeStoreId) {
      // The visited day speaks for itself on the itemized receipt.
      store.daySummary = null;
      continue;
    }
    days.push({
      store,
      demand: store.pendingEra !== null ? null : routedBranchDay(state, store),
    });
  }
  let resolved = 0;
  for (const { store, demand } of days) {
    resolveBranchDay(state, store, demand, emit);
    // A scaffolding day observed nothing — it must not count toward rolling
    // a city day, or an all-renovation close would burn a slot in the §17
    // 28-day observed window on an empty entry.
    if (demand !== null) resolved++;
  }
  return resolved;
}
